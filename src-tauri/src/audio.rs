//! Preview playback. Decodes a file, resamples it to the output device, then plays it through
//! the same shaping, repitching and time-stretching used for renders, with short fades so
//! switching samples or changing settings never clicks.

use crate::decode::decode;
use crate::dsp::{hermite, make_stretcher, resample_rates, shape, ProcessParams, Shaped};
use crate::sequence::{due, follow, start_grid, Grid, LoopBeats, Sequence, TransportEvent};
use crate::synth::{Batch, NoteEvent, Preset, Scheduled, Synth};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{bounded, select, unbounded, Receiver, Sender};
use parking_lot::Mutex;
use serde::Serialize;
use signalsmith_stretch::Stretch;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

/// Longest preview we keep in memory.
const MAX_PREVIEW_SECONDS: f64 = 15.0 * 60.0;
const CACHE_BYTES: usize = 384 * 1024 * 1024;
/// The output stream is opened on first play and released after this long in silence,
/// so an idle Saga never holds the audio device (or burns CPU) next to your DAW.
const RELEASE_OUTPUT_AFTER: Duration = Duration::from_secs(90);
/// Largest block handed to the stretcher at once.
const MAX_BLOCK: usize = 4096;
/// How far ahead progression notes are scheduled, and how often the engine thread tops them up.
/// The margin covers the coarse timers on Windows; edits and tempo changes reschedule at once.
const LOOKAHEAD: f64 = 0.15;
const SEQUENCE_TICK: Duration = Duration::from_millis(20);

/// Decoded audio: stereo, interleaved, at the output device's rate.
pub struct PcmBuffer {
    data: Vec<f32>,
    rate: u32,
}

enum Render {
    Direct,
    Repitch,
    Stretch { st: Box<Stretch>, read: usize, frac: f64, semitones: f64, formants: bool },
}

impl Render {
    fn kind(&self) -> u8 {
        match self {
            Render::Direct => 0,
            Render::Repitch => 1,
            Render::Stretch { .. } => 2,
        }
    }
}

fn render_kind(p: &ProcessParams) -> u8 {
    if p.needs_stretch() {
        2
    } else if p.needs_repitch() {
        1
    } else {
        0
    }
}

struct Voice {
    id: i64,
    src: Arc<Shaped>,
    params: ProcessParams,
    render: Render,
    /// Frame of the shaped buffer currently being heard.
    pos: f64,
    looping: bool,
    level: f32,
    target: f32,
    releasing: bool,
    last_beat: i64,
    /// New for every voice, so the progression player can tell a loop started over.
    serial: u64,
}

struct Scratch {
    input: Vec<f32>,
    output: Vec<f32>,
    clicks: Vec<(usize, bool)>,
}

enum VoiceState {
    Alive,
    Finished,
}

impl Voice {
    fn new(id: i64, src: Arc<Shaped>, params: ProcessParams, start: f64, looping: bool) -> Voice {
        let render = match render_kind(&params) {
            2 => {
                let rate = params.rate();
                let mut st = Box::new(make_stretcher(src.rate, &params));
                // Prime exactly like an offline render: pre-roll the analysis window, then
                // discard the output latency, so the first frame heard is `start`.
                let lat_in = st.input_latency();
                let mut pre = vec![0f32; lat_in * 2];
                let read = src.read(start as usize, lat_in, looping, &mut pre);
                st.seek(&pre, rate);
                let lat_out = st.output_latency();
                let need = (lat_out as f64 * rate).round() as usize;
                let mut input = vec![0f32; need * 2];
                let read = src.read(read, need, looping, &mut input);
                let mut discard = vec![0f32; lat_out * 2];
                st.process(&input, &mut discard);
                let read = if looping && src.frames > 0 { read % src.frames } else { read };
                Render::Stretch { st, read, frac: 0.0, semitones: params.semitones, formants: params.formants }
            }
            1 => Render::Repitch,
            _ => Render::Direct,
        };
        static SERIAL: AtomicU64 = AtomicU64::new(1);
        let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
        Voice { id, src, params, render, pos: start, looping, level: 0.0, target: 1.0, releasing: false, last_beat: i64::MIN, serial }
    }

    /// Seconds of the original per beat, when it's a loop with a tempo.
    fn beat(&self) -> Option<f64> {
        self.params.beat.filter(|b| *b > 0.01)
    }

    fn silent(&self) -> bool {
        self.level <= 0.0 && self.target <= 0.0
    }

    fn speed(&self) -> f64 {
        match self.render {
            Render::Direct => 1.0,
            _ => self.params.rate(),
        }
    }

    /// Adds `n` frames into `out`; collects metronome clicks when asked.
    fn render(&mut self, out: &mut [f32], n: usize, sc: &mut Scratch, steps: (f32, f32), collect_clicks: bool) -> VoiceState {
        if self.silent() {
            return VoiceState::Alive;
        }
        let frames = self.src.frames;
        if frames == 0 {
            return VoiceState::Finished;
        }
        let rate = self.speed();
        let start = self.pos;
        let looping = self.looping;
        let target = self.target;
        let mut level = self.level;
        let mut state = VoiceState::Alive;
        let ramp = |level: &mut f32| {
            if *level < target {
                *level = (*level + steps.0).min(target);
            } else if *level > target {
                *level = (*level - steps.1).max(target);
            }
        };

        match &mut self.render {
            Render::Direct | Render::Repitch => {
                let direct = rate == 1.0 && matches!(self.render, Render::Direct);
                let data = &self.src.data;
                let mut pos = self.pos;
                for i in 0..n {
                    if pos >= frames as f64 {
                        if looping {
                            pos -= frames as f64;
                        } else {
                            state = VoiceState::Finished;
                            break;
                        }
                    }
                    ramp(&mut level);
                    let (l, r) = if direct {
                        let k = pos as usize;
                        (data[k * 2], data[k * 2 + 1])
                    } else {
                        (hermite(data, frames, pos, 0, looping), hermite(data, frames, pos, 1, looping))
                    };
                    out[i * 2] += l * level;
                    out[i * 2 + 1] += r * level;
                    pos += rate;
                }
                self.pos = pos;
            }
            Render::Stretch { st, read, frac, semitones, formants } => {
                if (*semitones - self.params.semitones).abs() > 1e-6 {
                    st.set_transpose_factor_semitones(self.params.semitones as f32, None);
                    *semitones = self.params.semitones;
                }
                if *formants != self.params.formants {
                    st.set_formant_factor(1.0, self.params.formants);
                    *formants = self.params.formants;
                }
                let mut done = 0;
                while done < n {
                    let chunk = (n - done).min(MAX_BLOCK);
                    let want = *frac + chunk as f64 * rate;
                    let k = want.floor() as usize;
                    *frac = want - k as f64;
                    if sc.input.len() < k * 2 {
                        sc.input.resize(k * 2, 0.0);
                    }
                    *read = self.src.read(*read, k, looping, &mut sc.input[..k * 2]);
                    if looping {
                        *read %= frames;
                    }
                    st.process(&sc.input[..k * 2], &mut sc.output[..chunk * 2]);
                    for i in 0..chunk {
                        ramp(&mut level);
                        out[(done + i) * 2] += sc.output[i * 2] * level;
                        out[(done + i) * 2 + 1] += sc.output[i * 2 + 1] * level;
                    }
                    done += chunk;
                }
                self.pos += n as f64 * rate;
                if self.pos >= frames as f64 {
                    if looping {
                        self.pos %= frames as f64;
                    } else {
                        state = VoiceState::Finished;
                    }
                }
            }
        }
        self.level = level;

        if collect_clicks {
            if let Some(beat) = self.beat() {
                let beat_frames = beat * self.src.rate as f64;
                for i in 0..n {
                    let mut vp = start + i as f64 * rate;
                    if looping {
                        vp %= frames as f64;
                    } else if vp >= frames as f64 {
                        break;
                    }
                    let b = (vp / beat_frames).floor() as i64;
                    if b != self.last_beat {
                        self.last_beat = b;
                        if sc.clicks.len() < sc.clicks.capacity() {
                            sc.clicks.push((i, b.rem_euclid(4) == 0));
                        }
                    }
                }
            }
        }
        state
    }
}

struct Mixer {
    voices: Vec<Voice>,
    gain: f32,
    target_gain: f32,
    fade_in: f32,
    fade_out: f32,
    rate: u32,
    click_on: bool,
    click_env: f32,
    click_phase: f32,
    click_freq: f32,
    /// Lab notes and chords.
    synth: Synth,
    /// Frames rendered since the stream opened; progression notes are scheduled against it.
    clock: u64,
    /// Beats of the progression while one is playing.
    transport: Option<Grid>,
    last_transport_click: i64,
    scratch: Scratch,
}

enum MixEvent {
    Ended(i64),
    StreamError(String),
}

impl Mixer {
    fn new(rate: u32, gain: f32) -> Mixer {
        Mixer {
            voices: Vec::new(),
            gain,
            target_gain: gain,
            fade_in: 1.0 / (0.002 * rate as f32),
            fade_out: 1.0 / (0.008 * rate as f32),
            rate,
            click_on: false,
            click_env: 0.0,
            click_phase: 0.0,
            click_freq: 1000.0,
            synth: Synth::default(),
            clock: 0,
            transport: None,
            last_transport_click: i64::MIN,
            scratch: Scratch { input: vec![0.0; MAX_BLOCK * 2 * 5], output: vec![0.0; MAX_BLOCK * 2], clicks: Vec::with_capacity(64) },
        }
    }

    fn current(&mut self) -> Option<&mut Voice> {
        self.voices.iter_mut().find(|v| !v.releasing)
    }

    fn release_all(&mut self) {
        for v in &mut self.voices {
            v.releasing = true;
            v.target = 0.0;
        }
    }

    /// The beats of the loop that's playing, if it has a tempo.
    fn loop_beats(&self) -> Option<LoopBeats> {
        let v = self.voices.iter().find(|v| !v.releasing && v.target > 0.0)?;
        let beat_src = v.beat()? * v.src.rate as f64;
        let speed = v.speed();
        Some(LoopBeats {
            serial: v.serial,
            beat: v.pos / beat_src,
            beat_frames: beat_src / speed,
            to_wrap: if v.looping { (v.src.frames as f64 - v.pos).max(0.0) / speed } else { f64::INFINITY },
        })
    }

    fn add_notes(&mut self, batch: Batch) {
        self.synth.add(batch, self.clock);
    }

    /// Metronome clicks from the progression's beats, when no playing loop is giving them.
    fn transport_clicks(&mut self, n: usize) {
        let Some(g) = self.transport else { return };
        let ticking = self.voices.iter().any(|v| !v.releasing && !v.silent() && v.beat().is_some());
        if !self.click_on || ticking {
            return;
        }
        let clock = self.clock as f64;
        let mut b = g.beat_at(clock).ceil().max(0.0);
        while g.frame_at(b) < clock + n as f64 {
            let beat = b as i64;
            if beat != self.last_transport_click && self.scratch.clicks.len() < self.scratch.clicks.capacity() {
                self.last_transport_click = beat;
                let at = ((g.frame_at(b) - clock).floor() as usize).min(n - 1);
                self.scratch.clicks.push((at, beat.rem_euclid(4) == 0));
            }
            b += 1.0;
        }
    }

    /// Fills `out` (stereo, `n` frames) with the mix.
    fn render(&mut self, out: &mut [f32], n: usize, events: &Sender<MixEvent>) {
        out[..n * 2].fill(0.0);
        self.scratch.clicks.clear();
        let steps = (self.fade_in, self.fade_out);
        let mut i = 0;
        while i < self.voices.len() {
            let collect = self.click_on && !self.voices[i].releasing;
            let state = self.voices[i].render(out, n, &mut self.scratch, steps, collect);
            let v = &self.voices[i];
            let gone = match state {
                VoiceState::Finished => {
                    if !v.releasing {
                        let _ = events.try_send(MixEvent::Ended(v.id));
                    }
                    true
                }
                VoiceState::Alive => v.releasing && v.silent(),
            };
            if gone {
                self.voices.swap_remove(i);
            } else {
                i += 1;
            }
        }

        self.transport_clicks(n);

        // Metronome: a short sine blip, higher on the downbeat.
        let decay = (-1.0 / (0.025 * self.rate as f32)).exp();
        let mut next_click = 0;
        for f in 0..n {
            while next_click < self.scratch.clicks.len() && self.scratch.clicks[next_click].0 == f {
                self.click_env = 0.32;
                self.click_phase = 0.0;
                self.click_freq = if self.scratch.clicks[next_click].1 { 1760.0 } else { 1175.0 };
                next_click += 1;
            }
            if self.click_env > 1e-4 {
                let s = (self.click_phase * std::f32::consts::TAU).sin() * self.click_env;
                self.click_phase = (self.click_phase + self.click_freq / self.rate as f32).fract();
                self.click_env *= decay;
                out[f * 2] += s;
                out[f * 2 + 1] += s;
            }
        }

        self.synth.render(out, n, self.rate);

        for f in 0..n {
            self.gain += (self.target_gain - self.gain) * 0.001;
            out[f * 2] = (out[f * 2] * self.gain).clamp(-1.0, 1.0);
            out[f * 2 + 1] = (out[f * 2 + 1] * self.gain).clamp(-1.0, 1.0);
        }
        self.clock += n as u64;
    }
}

pub enum Cmd {
    /// `start`: seconds in the original file, or `None` for the start of the playback timeline.
    Play { id: i64, path: PathBuf, start: Option<f64>, looping: bool, params: ProcessParams },
    Pause,
    Resume,
    Stop,
    Seek(f64),
    SetLoop(bool),
    SetParams(ProcessParams),
    SetClick(bool),
    /// Lab notes, mixed over whatever sample is playing.
    PlayNotes { notes: Vec<NoteEvent>, preset: Preset },
    /// Lets Lab notes ring out quickly and cancels any that haven't started.
    StopNotes,
    /// Starts the Lab's progression looping, or updates the one that's playing in place.
    PlaySequence(Sequence),
    StopSequence,
    SetVolume(f32),
    SetDevice(Option<String>),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackEvent {
    pub id: Option<i64>,
    /// "playing", "paused", "stopped", "ended" or "error".
    pub state: &'static str,
    /// Seconds along the playback timeline (the region, reversed if reversing), from its start.
    pub timeline: f64,
    /// Length of the playback timeline in seconds of the original.
    pub length: f64,
    /// Seconds of the original per second of output.
    pub rate: f64,
    pub reverse: bool,
    /// Region in seconds of the original file.
    pub region_start: f64,
    pub region_end: f64,
    pub looping: bool,
    pub message: Option<String>,
}

impl PlaybackEvent {
    fn bare(id: Option<i64>, state: &'static str, message: Option<String>) -> PlaybackEvent {
        PlaybackEvent { id, state, timeline: 0.0, length: 0.0, rate: 1.0, reverse: false, region_start: 0.0, region_end: 0.0, looping: false, message }
    }
}

pub type EmitPlayback = Arc<dyn Fn(PlaybackEvent) + Send + Sync>;
pub type EmitTransport = Arc<dyn Fn(TransportEvent) + Send + Sync>;

pub struct Engine {
    tx: Sender<Cmd>,
}

impl Engine {
    pub fn start(device: Option<String>, volume: f32, emit: EmitPlayback, emit_transport: EmitTransport) -> Engine {
        let (tx, rx) = unbounded::<Cmd>();
        std::thread::Builder::new()
            .name("saga-audio".into())
            .spawn(move || EngineThread::new(device, volume, emit, emit_transport).run(rx))
            .expect("spawn audio thread");
        Engine { tx }
    }

    pub fn send(&self, cmd: Cmd) {
        let _ = self.tx.send(cmd);
    }
}

pub fn output_devices() -> Vec<String> {
    let host = cpal::default_host();
    host.output_devices().map(|ds| ds.filter_map(|d| d.name().ok()).collect()).unwrap_or_default()
}

struct Output {
    _stream: cpal::Stream,
    rate: u32,
}

struct Cached {
    path: PathBuf,
    mtime: Option<SystemTime>,
    buf: Arc<PcmBuffer>,
}

/// What's playing, so settings can change without starting over.
struct Current {
    id: i64,
    raw: Arc<PcmBuffer>,
    params: ProcessParams,
    looping: bool,
}

/// The Lab's progression while it plays.
struct Progression {
    seq: Sequence,
    /// Beats scheduled so far.
    until: f64,
    /// Serial of the loop whose beats it follows, 0 for none.
    following: u64,
    /// Last whole beat reported to the frontend.
    reported: i64,
}

struct EngineThread {
    device: Option<String>,
    output: Option<Output>,
    mixer: Arc<Mutex<Mixer>>,
    events_tx: Sender<MixEvent>,
    events_rx: Receiver<MixEvent>,
    emit: EmitPlayback,
    emit_transport: EmitTransport,
    cache: VecDeque<Cached>,
    volume: f32,
    click: bool,
    last_sound: Instant,
    current: Option<Current>,
    progression: Option<Progression>,
}

fn build_stream<T>(device: &cpal::Device, config: &cpal::StreamConfig, mixer: Arc<Mutex<Mixer>>, events: Sender<MixEvent>) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample + cpal::FromSample<f32>,
{
    let channels = config.channels as usize;
    let err_events = events.clone();
    let mut buf: Vec<f32> = vec![0.0; 8192 * 2];
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
                let n = data.len() / channels;
                let Some(mut m) = mixer.try_lock() else {
                    data.iter_mut().for_each(|s| *s = T::from_sample(0.0f32));
                    return;
                };
                if buf.len() < n * 2 {
                    buf.resize(n * 2, 0.0);
                }
                m.render(&mut buf, n, &events);
                for (f, frame) in data.chunks_mut(channels).enumerate() {
                    let (l, r) = (buf[f * 2], buf[f * 2 + 1]);
                    match frame.len() {
                        1 => frame[0] = T::from_sample((l + r) * 0.5),
                        _ => {
                            frame[0] = T::from_sample(l);
                            frame[1] = T::from_sample(r);
                            for s in frame.iter_mut().skip(2) {
                                *s = T::from_sample(0.0f32);
                            }
                        }
                    }
                }
            },
            move |err| {
                let _ = err_events.try_send(MixEvent::StreamError(err.to_string()));
            },
            None,
        )
        .map_err(|e| e.to_string())
}

/// Converts interleaved audio with any channel count to stereo at `out_rate`.
fn to_stereo(samples: &[f32], channels: usize, in_rate: u32, out_rate: u32) -> Result<PcmBuffer, String> {
    let channels = channels.max(1);
    let frames = samples.len() / channels;
    let mut left = Vec::with_capacity(frames);
    let mut right = Vec::with_capacity(frames);
    for f in samples.chunks_exact(channels) {
        left.push(f[0]);
        right.push(if channels > 1 { f[1] } else { f[0] });
    }
    let (left, right) = if in_rate == out_rate || frames == 0 { (left, right) } else { resample_rates(&left, &right, in_rate, out_rate)? };
    Ok(PcmBuffer { data: crate::dsp::join(&left, &right), rate: out_rate })
}

/// Decodes a file to stereo at `out_rate` (or its own rate when `None`).
/// Returns the samples, their rate and the file's own channel count.
pub fn load_stereo(path: &Path, out_rate: Option<u32>) -> Result<(Vec<f32>, u32, usize), String> {
    let mut samples: Vec<f32> = Vec::new();
    let (info, _) = decode(path, Some(MAX_PREVIEW_SECONDS), |_, s| samples.extend_from_slice(s))?;
    let rate = out_rate.unwrap_or(info.sample_rate);
    let buf = to_stereo(&samples, info.channels, info.sample_rate, rate)?;
    Ok((buf.data, rate, info.channels))
}

impl EngineThread {
    fn new(device: Option<String>, volume: f32, emit: EmitPlayback, emit_transport: EmitTransport) -> EngineThread {
        let (events_tx, events_rx) = bounded(64);
        EngineThread {
            device,
            output: None,
            mixer: Arc::new(Mutex::new(Mixer::new(48_000, volume))),
            events_tx,
            events_rx,
            emit,
            emit_transport,
            cache: VecDeque::new(),
            volume,
            click: false,
            last_sound: Instant::now(),
            current: None,
            progression: None,
        }
    }

    fn open_output(&mut self) {
        self.output = None;
        let host = cpal::default_host();
        let wanted = self.device.as_ref().and_then(|name| host.output_devices().ok()?.find(|d| d.name().map(|n| &n == name).unwrap_or(false)));
        let Some(device) = wanted.or_else(|| host.default_output_device()) else {
            self.emit_error(None, "No audio output device found");
            return;
        };
        let supported = match device.default_output_config() {
            Ok(c) => c,
            Err(e) => {
                self.emit_error(None, &format!("Audio output unavailable: {e}"));
                return;
            }
        };
        let format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        let rate = config.sample_rate.0;
        if self.cache.front().is_some_and(|c| c.buf.rate != rate) {
            self.cache.clear();
        }
        let mut mixer = Mixer::new(rate, self.volume);
        mixer.click_on = self.click;
        *self.mixer.lock() = mixer;
        let (m, ev) = (self.mixer.clone(), self.events_tx.clone());
        let stream = match format {
            cpal::SampleFormat::F32 => build_stream::<f32>(&device, &config, m, ev),
            cpal::SampleFormat::I16 => build_stream::<i16>(&device, &config, m, ev),
            cpal::SampleFormat::U16 => build_stream::<u16>(&device, &config, m, ev),
            cpal::SampleFormat::I32 => build_stream::<i32>(&device, &config, m, ev),
            other => Err(format!("unsupported sample format {other:?}")),
        };
        match stream.and_then(|s| s.play().map(|_| s).map_err(|e| e.to_string())) {
            Ok(s) => self.output = Some(Output { _stream: s, rate }),
            Err(e) => self.emit_error(None, &format!("Could not open audio output: {e}")),
        }
    }

    fn output_rate(&self) -> Option<u32> {
        self.output.as_ref().map(|o| o.rate)
    }

    fn emit_error(&self, id: Option<i64>, msg: &str) {
        (self.emit)(PlaybackEvent::bare(id, "error", Some(msg.into())));
    }

    fn emit_state(&self, state: &'static str) {
        let mut m = self.mixer.lock();
        let ev = match m.current() {
            Some(v) => {
                let sr = v.src.rate as f64;
                PlaybackEvent {
                    id: Some(v.id),
                    state,
                    timeline: v.pos / sr,
                    length: v.src.frames as f64 / sr,
                    rate: v.speed(),
                    reverse: v.src.reverse,
                    region_start: v.src.start as f64 / sr,
                    region_end: v.src.end as f64 / sr,
                    looping: v.looping,
                    message: None,
                }
            }
            None => PlaybackEvent::bare(None, state, None),
        };
        drop(m);
        (self.emit)(ev);
    }

    fn buffer_for(&mut self, path: &Path, rate: u32) -> Result<Arc<PcmBuffer>, String> {
        let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
        if let Some(i) = self.cache.iter().position(|c| c.path == path && c.mtime == mtime) {
            let c = self.cache.remove(i).expect("index from position");
            let buf = c.buf.clone();
            self.cache.push_front(c);
            return Ok(buf);
        }
        let (data, _, _) = load_stereo(path, Some(rate))?;
        let buf = Arc::new(PcmBuffer { data, rate });
        self.cache.push_front(Cached { path: path.to_path_buf(), mtime, buf: buf.clone() });
        let mut bytes = 0usize;
        let mut keep = 0usize;
        for c in &self.cache {
            bytes += c.buf.data.len() * 4;
            if bytes > CACHE_BYTES && keep > 0 {
                break;
            }
            keep += 1;
        }
        self.cache.truncate(keep);
        Ok(buf)
    }

    /// Replaces the current voice (crossfading from it) with one built from `current`,
    /// starting at original time `at` or at the start of the playback timeline.
    fn restart(&mut self, at: Option<f64>, paused: bool) {
        let Some(cur) = &self.current else { return };
        let shaped = Arc::new(shape(&cur.raw.data, cur.raw.rate, &cur.params));
        let start = match at {
            Some(t) => shaped.frame_for(t.clamp(shaped.start as f64 / shaped.rate as f64, shaped.end as f64 / shaped.rate as f64)),
            None => 0.0,
        };
        let mut voice = Voice::new(cur.id, shaped, cur.params.clone(), start, cur.looping);
        if paused {
            voice.target = 0.0;
        }
        let mut m = self.mixer.lock();
        m.release_all();
        m.voices.push(voice);
    }

    fn current_time(&mut self) -> Option<(f64, bool)> {
        let mut m = self.mixer.lock();
        m.current().map(|v| (v.src.original_time(v.pos), v.target == 0.0))
    }

    fn play(&mut self, id: i64, path: PathBuf, start: Option<f64>, looping: bool, params: ProcessParams) {
        if self.output.is_none() {
            self.open_output();
        }
        let Some(rate) = self.output_rate() else { return };
        match self.buffer_for(&path, rate) {
            Ok(raw) => {
                self.current = Some(Current { id, raw, params, looping });
                self.restart(start, false);
                self.emit_state("playing");
            }
            Err(e) => self.emit_error(Some(id), &format!("Can't play this file: {e}")),
        }
    }

    fn emit_state_if_active(&self) {
        let state = {
            let mut m = self.mixer.lock();
            m.current().map(|v| if v.target == 0.0 { "paused" } else { "playing" })
        };
        if let Some(s) = state {
            self.emit_state(s);
        }
    }

    fn set_params(&mut self, params: ProcessParams) {
        let Some(cur) = self.current.as_mut() else { return };
        let old = std::mem::replace(&mut cur.params, params.clone());
        let Some((t, paused)) = self.current_time() else { return };
        let same_kind = self.mixer.lock().current().map(|v| v.render.kind()) == Some(render_kind(&params));
        if old.same_shape(&params) && same_kind {
            // Tempo, pitch and click changes apply in place, no restart.
            if let Some(v) = self.mixer.lock().current() {
                v.params = params;
            }
        } else {
            self.restart(Some(t), paused);
        }
        self.emit_state_if_active();
    }

    fn play_sequence(&mut self, seq: Sequence) {
        if self.output.is_none() {
            self.open_output();
        }
        let Some(rate) = self.output_rate() else { return };
        let tempo_frames = 60.0 * rate as f64 / seq.bpm.clamp(20.0, 400.0);
        let mut m = self.mixer.lock();
        let now = m.clock as f64;
        match (self.progression.as_mut(), m.transport) {
            (Some(p), Some(grid)) => {
                // Same place in the pattern; notes not yet started are scheduled again from it.
                p.seq = seq;
                m.synth.drop_pending_seq();
                p.until = grid.beat_at(now);
            }
            _ => {
                let lp = m.loop_beats();
                m.transport = Some(start_grid(now, 0.02 * rate as f64, tempo_frames, lp));
                m.last_transport_click = i64::MIN;
                self.progression = Some(Progression { seq, until: 0.0, following: lp.map_or(0, |l| l.serial), reported: i64::MIN });
            }
        }
        drop(m);
        self.tick_sequence();
    }

    fn stop_sequence(&mut self) {
        if self.progression.take().is_none() {
            return;
        }
        {
            let mut m = self.mixer.lock();
            m.transport = None;
            m.synth.release_seq();
        }
        (self.emit_transport)(TransportEvent { playing: false, beat: 0.0, bpm: 0.0 });
    }

    /// Keeps the progression's grid on the loop or tempo it should follow, and schedules the
    /// notes due in the next moment.
    fn tick_sequence(&mut self) {
        if self.progression.is_none() {
            return;
        }
        let Some(rate) = self.output_rate() else {
            self.stop_sequence();
            return;
        };
        let Some(p) = self.progression.as_mut() else { return };
        let tempo_frames = 60.0 * rate as f64 / p.seq.bpm.clamp(20.0, 400.0);
        let (grid, now) = {
            let mut m = self.mixer.lock();
            let now = m.clock as f64;
            let Some(mut grid) = m.transport else { return };
            let lp = m.loop_beats();
            // 2 ms: well under what you'd hear, well over rounding.
            if let Some(g) = follow(grid, now, tempo_frames, lp, p.following, 0.002 * rate as f64) {
                grid = g;
                m.transport = Some(g);
                m.synth.drop_pending_seq();
                p.until = g.beat_at(now);
                // The playhead needs the new tempo now, not at the next beat.
                p.reported = i64::MIN;
            }
            p.following = lp.map_or(0, |l| l.serial);
            (grid, now)
        };
        let horizon = grid.beat_at(now + LOOKAHEAD * rate as f64);
        let notes: Vec<Scheduled> = due(&p.seq, p.until, horizon)
            .into_iter()
            .map(|(beat, n)| Scheduled {
                note: n.note,
                frame: grid.frame_at(beat).round().max(0.0) as u64,
                hold: (n.length * grid.beat_frames) as usize,
                velocity: n.velocity,
            })
            .collect();
        p.until = p.until.max(horizon);
        if !notes.is_empty() {
            let batch = Batch::scheduled(&notes, p.seq.preset, rate);
            self.mixer.lock().add_notes(batch);
        }
        let beat = grid.beat_at(now);
        if beat.floor() as i64 != p.reported {
            p.reported = beat.floor() as i64;
            (self.emit_transport)(TransportEvent { playing: true, beat, bpm: grid.bpm(rate) });
        }
    }

    fn handle(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Play { id, path, start, looping, params } => self.play(id, path, start, looping, params),
            Cmd::Pause => {
                if let Some(v) = self.mixer.lock().current() {
                    v.target = 0.0;
                }
                self.emit_state("paused");
            }
            Cmd::Resume => {
                if let Some(v) = self.mixer.lock().current() {
                    v.target = 1.0;
                }
                self.emit_state("playing");
            }
            Cmd::Stop => {
                self.mixer.lock().release_all();
                self.emit_state("stopped");
            }
            Cmd::Seek(seconds) => {
                let Some((_, paused)) = self.current_time() else { return };
                self.restart(Some(seconds), paused);
                self.emit_state(if paused { "paused" } else { "playing" });
            }
            Cmd::SetLoop(looping) => {
                if let Some(c) = self.current.as_mut() {
                    c.looping = looping;
                }
                if let Some(v) = self.mixer.lock().current() {
                    v.looping = looping;
                }
                self.emit_state_if_active();
            }
            Cmd::SetParams(params) => self.set_params(params),
            Cmd::SetClick(on) => {
                self.click = on;
                self.mixer.lock().click_on = on;
            }
            Cmd::PlayNotes { notes, preset } => {
                if notes.is_empty() {
                    return;
                }
                if self.output.is_none() {
                    self.open_output();
                }
                let Some(rate) = self.output_rate() else { return };
                let batch = Batch::new(&notes, preset, rate);
                self.mixer.lock().add_notes(batch);
            }
            Cmd::StopNotes => self.mixer.lock().synth.release_all(),
            Cmd::PlaySequence(seq) => self.play_sequence(seq),
            Cmd::StopSequence => self.stop_sequence(),
            Cmd::SetVolume(v) => {
                self.volume = v.clamp(0.0, 1.5);
                self.mixer.lock().target_gain = self.volume;
            }
            Cmd::SetDevice(name) => {
                // The new device opens on the next play.
                self.device = name;
                self.stop_sequence();
                let mut m = self.mixer.lock();
                m.voices.clear();
                m.synth.clear();
                drop(m);
                self.output = None;
                self.emit_state("stopped");
            }
        }
    }

    fn run(mut self, rx: Receiver<Cmd>) {
        let events_rx = self.events_rx.clone();
        loop {
            let idle = if self.progression.is_some() { SEQUENCE_TICK } else { Duration::from_secs(5) };
            select! {
                recv(rx) -> cmd => {
                    let Ok(cmd) = cmd else { break };
                    // Holding an arrow key queues many plays, and dragging a control queues many
                    // parameter changes; only the newest of each matters.
                    let mut pending = vec![cmd];
                    while let Ok(next) = rx.try_recv() {
                        pending.push(next);
                    }
                    let last_play = pending.iter().rposition(|c| matches!(c, Cmd::Play { .. }));
                    let last_params = pending.iter().rposition(|c| matches!(c, Cmd::SetParams(_)));
                    for (i, c) in pending.into_iter().enumerate() {
                        match c {
                            Cmd::Play { .. } if Some(i) != last_play => continue,
                            Cmd::SetParams(_) if Some(i) != last_params => continue,
                            _ => self.handle(c),
                        }
                    }
                }
                recv(events_rx) -> ev => {
                    match ev {
                        Ok(MixEvent::Ended(id)) => (self.emit)(PlaybackEvent::bare(Some(id), "ended", None)),
                        Ok(MixEvent::StreamError(e)) => {
                            // Usually the device went away; the next play reopens whatever is available.
                            eprintln!("saga: audio stream error: {e}");
                            self.stop_sequence();
                            let mut m = self.mixer.lock();
                            m.voices.clear();
                            m.synth.clear();
                            drop(m);
                            self.output = None;
                            self.emit_state("stopped");
                        }
                        Err(_) => break,
                    }
                }
                default(idle) => {}
            }
            self.tick_sequence();
            if self.output.is_some() {
                let sounding = self.progression.is_some() || {
                    let m = self.mixer.lock();
                    !m.voices.is_empty() || m.synth.active()
                };
                if sounding {
                    self.last_sound = Instant::now();
                } else if self.last_sound.elapsed() > RELEASE_OUTPUT_AFTER {
                    self.output = None;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::Mode;

    fn tone(frames: usize) -> Arc<Shaped> {
        let data: Vec<f32> = (0..frames)
            .flat_map(|i| {
                let s = (i as f32 / 48_000.0 * 440.0 * std::f32::consts::TAU).sin() * 0.5;
                [s, s]
            })
            .collect();
        Arc::new(shape(&data, 48_000, &ProcessParams::default()))
    }

    fn run(m: &mut Mixer, blocks: usize, n: usize) -> (Vec<f32>, Vec<i64>) {
        let (tx, rx) = bounded(64);
        let mut out = vec![0f32; n * 2];
        let mut all = Vec::new();
        for _ in 0..blocks {
            m.render(&mut out, n, &tx);
            all.extend_from_slice(&out[..n * 2]);
        }
        let ended = rx.try_iter().filter_map(|e| if let MixEvent::Ended(id) = e { Some(id) } else { None }).collect();
        (all, ended)
    }

    #[test]
    fn stereo_conversion_and_resampling_keep_length() {
        let mono: Vec<f32> = (0..44_100).map(|i| (i as f32 / 44_100.0 * 440.0 * std::f32::consts::TAU).sin() * 0.5).collect();
        let buf = to_stereo(&mono, 1, 44_100, 48_000).unwrap();
        assert!((buf.data.len() as i64 / 2 - 48_000).abs() <= 1, "{}", buf.data.len() / 2);
        let mid = &buf.data[20_000..60_000];
        let rms = (mid.iter().map(|s| s * s).sum::<f32>() / mid.len() as f32).sqrt();
        assert!((rms - 0.354).abs() < 0.02, "{rms}");
        let same = to_stereo(&[0.1, 0.2, 0.3, 0.4], 2, 48_000, 48_000).unwrap();
        assert_eq!(same.data, vec![0.1, 0.2, 0.3, 0.4]);
    }

    #[test]
    fn direct_voice_fades_in_and_ends() {
        let mut m = Mixer::new(48_000, 1.0);
        m.voices.push(Voice::new(7, tone(4_800), ProcessParams::default(), 0.0, false));
        let (out, ended) = run(&mut m, 12, 512);
        assert!(out[2].abs() < 0.05, "fades in");
        assert_eq!(ended, vec![7]);
        assert!(m.voices.is_empty());
    }

    #[test]
    fn looping_voice_wraps() {
        let mut m = Mixer::new(48_000, 1.0);
        m.voices.push(Voice::new(8, tone(1_000), ProcessParams::default(), 0.0, true));
        let (_, ended) = run(&mut m, 5, 512);
        assert!(ended.is_empty());
        assert_eq!(m.voices[0].pos as usize, (5 * 512) % 1_000);
    }

    #[test]
    fn stretched_voice_plays_at_the_new_rate_without_silence() {
        let mut m = Mixer::new(48_000, 1.0);
        let p = ProcessParams { rate: 1.25, semitones: 2.0, ..Default::default() };
        m.voices.push(Voice::new(9, tone(48_000), p, 0.0, true));
        let (out, _) = run(&mut m, 40, 480);
        let early = &out[200..960];
        assert!(early.iter().any(|s| s.abs() > 0.1), "primed output starts immediately");
        assert!(out.iter().all(|s| s.abs() <= 1.0));
        // 19,200 frames heard at 1.25x = 24,000 source frames.
        assert!((m.voices[0].pos - 24_000.0).abs() < 1.0, "{}", m.voices[0].pos);
    }

    #[test]
    fn repitch_voice_advances_faster() {
        let mut m = Mixer::new(48_000, 1.0);
        let p = ProcessParams { rate: 2.0, mode: Mode::Repitch, ..Default::default() };
        m.voices.push(Voice::new(1, tone(48_000), p, 0.0, false));
        run(&mut m, 10, 480);
        assert!((m.voices[0].pos - 9_600.0).abs() < 1e-6);
    }

    #[test]
    fn click_lands_on_every_beat() {
        let mut m = Mixer::new(48_000, 1.0);
        m.click_on = true;
        let silent = Arc::new(shape(&vec![0.0; 96_000], 48_000, &ProcessParams::default()));
        let p = ProcessParams { beat: Some(0.1), ..Default::default() };
        m.voices.push(Voice::new(2, silent, p, 0.0, false));
        let (tx, _rx) = bounded(64);
        let mut out = vec![0f32; 960];
        let (mut clicks, mut downbeats, mut loud) = (0, 0, 0f32);
        for _ in 0..90 {
            m.render(&mut out, 480, &tx);
            clicks += m.scratch.clicks.len();
            downbeats += m.scratch.clicks.iter().filter(|c| c.1).count();
            loud = out.iter().fold(loud, |a, s| a.max(s.abs()));
        }
        // 0.9 s of 0.1 s beats: beats 0..=8, every fourth one accented.
        assert_eq!(clicks, 9);
        assert_eq!(downbeats, 3);
        assert!(loud > 0.2, "audible");
    }

    #[test]
    fn progression_notes_land_with_the_click() {
        use crate::sequence::{due, SeqNote};
        let mut m = Mixer::new(48_000, 1.0);
        m.click_on = true;
        // Half-second beats, so each click has died away before the next beat.
        let grid = Grid { origin: 0.0, beat_frames: 24_000.0 };
        m.transport = Some(grid);
        let seq = Sequence { notes: vec![SeqNote { note: 60.0, start: 1.0, length: 0.5, velocity: 1.0 }], beats: 4.0, bpm: 120.0, preset: Preset::Keys };
        let notes: Vec<Scheduled> = due(&seq, 0.0, 2.0)
            .into_iter()
            .map(|(b, n)| Scheduled { note: n.note, frame: grid.frame_at(b) as u64, hold: 12_000, velocity: n.velocity })
            .collect();
        m.add_notes(Batch::scheduled(&notes, seq.preset, 48_000));

        let (tx, _rx) = bounded(64);
        let mut out = vec![0f32; 512 * 2];
        let mut clicks = Vec::new();
        let mut heard = Vec::new();
        for _ in 0..(40_000 / 512) {
            let start = m.clock;
            m.render(&mut out, 512, &tx);
            clicks.extend(m.scratch.clicks.iter().map(|c| (start + c.0 as u64, c.1)));
            heard.extend(out.chunks(2).map(|f| f[0]));
        }
        assert_eq!(clicks, vec![(0, true), (24_000, false)]);
        // Both the click and the note start from zero on beat 1, so the first sound is the frame after.
        let first = heard[12_000..].iter().position(|v| *v != 0.0).unwrap() + 12_000;
        assert_eq!(first, 24_001);
        // More energy than the click alone on beat 0, so the note is there too.
        let energy = |x: &[f32]| x.iter().map(|v| v * v).sum::<f32>();
        let (with_note, click_only) = (energy(&heard[24_000..24_480]), energy(&heard[..480]));
        assert!(with_note > click_only * 1.2, "{with_note} vs {click_only}");
    }

    #[test]
    fn a_playing_loop_gives_the_beats_and_the_click() {
        let mut m = Mixer::new(48_000, 1.0);
        m.click_on = true;
        m.transport = Some(Grid { origin: 0.0, beat_frames: 24_000.0 });
        // Two seconds, stereo.
        let silent = Arc::new(shape(&vec![0.0; 192_000], 48_000, &ProcessParams::default()));
        // Beats of 0.1 s of the original, played at double speed.
        let p = ProcessParams { beat: Some(0.1), rate: 2.0, mode: Mode::Repitch, ..Default::default() };
        m.voices.push(Voice::new(3, silent, p, 0.0, true));
        let (tx, _rx) = bounded(64);
        let mut out = vec![0f32; 480 * 2];
        let mut clicks = 0;
        for _ in 0..50 {
            m.render(&mut out, 480, &tx);
            clicks += m.scratch.clicks.len();
        }
        // 24,000 frames: 48,000 of the loop at 4,800 per beat, and no clicks from the progression.
        assert_eq!(clicks, 10);
        let lp = m.loop_beats().unwrap();
        assert!((lp.beat - 10.0).abs() < 1e-9, "{}", lp.beat);
        assert_eq!(lp.beat_frames, 2_400.0);
        assert_eq!(lp.to_wrap, 24_000.0);
    }
}
