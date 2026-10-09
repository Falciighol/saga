//! Records takes: from an audio input, from one app, or from everything the computer plays except
//! Saga. A take can wait for the first sound and end on silence. It's written to disk as it records,
//! so a crash keeps it, then trimmed, stored with the unsaved takes and analyzed straight away.
//! The input device (or the app tap) is open only while a take is armed or recording.

use crate::db::Db;
use crate::indexer::{Emit, Indexer};
use crate::render::free_path;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{bounded, unbounded, Receiver, RecvTimeoutError, Sender, TryRecvError};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The longest take. The preview engine plays files up to 15 minutes (`MAX_PREVIEW_SECONDS`).
pub const MAX_SECONDS: f32 = 15.0 * 60.0;
/// Kept before the first sound, so its attack is never cut off.
const PRE_ROLL_KEEP: f32 = 0.02;
/// Held while armed: more than the time it takes to notice the first sound.
const PRE_ROLL: f32 = 0.5;
/// How finely the start of a sound and the silence after it are judged.
const BLOCK: f32 = 0.005;
/// One bar of the live waveform.
const BAR: f32 = 0.025;
/// A sound this far above the noise floor starts a take: 12 dB.
const OVER_FLOOR: f32 = 4.0;
/// The sound starting a take is never quieter than -60 dBFS, so the dither or hiss of a silent
/// source can't start one, and never has to be louder than -12 dBFS.
const MIN_THRESHOLD: f32 = 0.001;
const MAX_THRESHOLD: f32 = 0.25;
/// A take's end is trimmed to where the sound last rose this far above the noise floor (6 dB), or
/// above -66 dBFS, so reverb tails quieter than the start threshold survive.
const TAIL_OVER_FLOOR: f32 = 2.0;
const MIN_TAIL: f32 = 0.0005;
/// Kept after the sound's end, faded out, so the take never ends with a click.
const TAIL_KEEP: f32 = 0.03;
const FADE_OUT: f32 = 0.01;
const FADE_IN: f32 = 0.002;
/// The noise floor is a low percentile of the last two seconds' block peaks.
const FLOOR_WINDOW: f32 = 2.0;
/// How long an armed app source may stay completely silent before Saga says some apps block recording.
const NOTHING_YET_AFTER: f32 = 6.0;
/// Buffers passed from the audio callback to the writer, recycled so the callback never allocates.
/// 64 callbacks is about half a second of slack for the writer.
const BUFFERS: usize = 64;
const BUFFER_SAMPLES: usize = 1 << 15;
/// How often the live waveform and meter are sent to the window.
const STATUS_EVERY: Duration = Duration::from_millis(33);
/// The raw file's header is brought up to date this often, so a crash loses at most this much.
const FLUSH_EVERY: Duration = Duration::from_secs(1);

/// Inside the takes folder: takes while they record, before they're trimmed. The leading dot keeps
/// library scans out of it.
pub const INCOMING_DIR: &str = ".incoming";
/// File format for new takes: "24" (24-bit WAV, the default) or "float" (32-bit float WAV).
pub const TAKE_FORMAT_SETTING: &str = "take_format";
/// What happens to takes that are never saved: "keep" (the default), "week" or "quit".
pub const TAKES_RETENTION_SETTING: &str = "takes_retention";
/// The global shortcut that arms, records and stops, as Tauri spells it ("CommandOrControl+Shift+R").
pub const RECORD_SHORTCUT_SETTING: &str = "record_shortcut";

/// What to record. Mirrored by `RecordSource` in src/lib/types.ts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SourceSpec {
    /// An input device; `channels` picks one channel or a pair (0-based). Empty means the first one or two.
    Input { device: String, channels: Vec<u16> },
    /// One app's sound, with whatever it starts.
    App { pid: u32, name: String },
    /// Everything the computer plays, except Saga.
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeOptions {
    /// Wait for the first sound; otherwise the take starts at once.
    pub start_on_sound: bool,
    /// Seconds of silence that end a take; `None` never ends one.
    pub stop_after: Option<f32>,
    /// Arm again after each take, so every sound becomes its own take.
    pub keep_going: bool,
    /// The level that starts a take, in dBFS; `None` follows the noise floor.
    pub threshold_db: Option<f32>,
    /// Minutes to add to UTC for the local time in take names (minus JavaScript's `getTimezoneOffset`).
    pub utc_offset: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureState {
    Idle,
    Armed,
    Recording,
}

/// The live state for the Record panel, about 30 times a second while armed or recording.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeStatus {
    pub state: CaptureState,
    /// The source's name, as the panel shows it.
    pub source: String,
    /// Seconds recorded in this take so far.
    pub seconds: f32,
    /// Peak of the newest audio, 0–1.
    pub level: f32,
    /// Waveform bars (peaks, 0–1) since the last status, one per 25 ms.
    pub bars: Vec<f32>,
    /// The level that starts a take, 0–1.
    pub threshold: f32,
    /// The source's noise floor, 0–1.
    pub floor: f32,
    /// Seconds of silence at the end of the take so far.
    pub silent_for: f32,
    /// Something in this take reached full scale.
    pub clipped: bool,
    /// Takes made since arming.
    pub takes: u32,
    /// An app source has been completely silent since it was armed.
    pub nothing_yet: bool,
}

/// Something worth telling the user about a take: a device that went away, silence, a limit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub message: String,
    /// The privacy setting that would let Saga record, when that's what's in the way: "microphone" or "systemAudio".
    pub settings: Option<&'static str>,
}

impl Problem {
    pub fn msg(message: impl Into<String>) -> Problem {
        Problem { message: message.into(), settings: None }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeNotice {
    pub message: String,
    /// "info" or "error".
    pub tone: &'static str,
    pub settings: Option<&'static str>,
}

/// A take was stored and is being analyzed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeLanded {
    pub id: i64,
    pub recovered: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    pub name: String,
    pub channels: u16,
    pub sample_rate: u32,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSource {
    pub pid: u32,
    pub name: String,
    /// The app's icon as a PNG data URL.
    pub icon: Option<String>,
    /// Making sound right now.
    pub playing: bool,
}

/// Everything that can be recorded on this computer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordSources {
    pub inputs: Vec<InputDevice>,
    pub apps: Vec<AppSource>,
    /// One app can be recorded on its own.
    pub apps_supported: bool,
    /// Everything you hear can be recorded.
    pub system_supported: bool,
    /// Everything you hear includes Saga's own sounds here (Windows before version 2004).
    pub system_includes_saga: bool,
    /// Why apps or everything you hear can't be recorded on this computer, when they can't.
    pub unsupported: Option<String>,
}

/// What a session needs from the rest of the app.
#[derive(Clone)]
pub struct Ctx {
    pub db: Arc<Db>,
    pub indexer: Arc<Indexer>,
    pub takes_dir: PathBuf,
    pub takes_source: i64,
    pub emit: Emit,
    /// Shows or hides the recording dot on the Dock or taskbar icon.
    pub on_recording: Arc<dyn Fn(bool) + Send + Sync>,
}

impl Ctx {
    fn status(&self, s: &TakeStatus) {
        (self.emit)("take-status", serde_json::to_value(s).unwrap_or_default());
    }

    fn notice(&self, message: impl Into<String>, tone: &'static str, settings: Option<&'static str>) {
        let n = TakeNotice { message: message.into(), tone, settings };
        (self.emit)("take-notice", serde_json::to_value(n).unwrap_or_default());
    }
}

// ---- the path from the audio callback to the writer ----

/// Set by the audio side when the device or app goes away.
#[derive(Default)]
pub struct Lost {
    flag: AtomicBool,
    why: Mutex<Option<String>>,
}

impl Lost {
    pub fn set(&self, why: impl Into<String>) {
        *self.why.lock() = Some(why.into());
        self.flag.store(true, Ordering::Release);
    }

    fn is_set(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }
}

/// The audio callback's end of the path: interleaved samples go out in recycled buffers.
pub struct Sink {
    free: Receiver<Vec<f32>>,
    full: Sender<Vec<f32>>,
    dropped: Arc<AtomicU64>,
}

impl Sink {
    /// Fills a recycled buffer and hands it to the writer. Allocates nothing unless one callback
    /// brings more than a buffer holds. When the writer falls behind, the audio is dropped and counted.
    pub fn send(&self, fill: impl FnOnce(&mut Vec<f32>)) {
        let Ok(mut buf) = self.free.try_recv() else {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        };
        buf.clear();
        fill(&mut buf);
        if let Err(e) = self.full.try_send(buf) {
            drop(e);
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
impl Sink {
    pub fn for_test(free: Receiver<Vec<f32>>, full: Sender<Vec<f32>>) -> Sink {
        Sink { free, full, dropped: Arc::new(AtomicU64::new(0)) }
    }
}

struct Pipe {
    sink: Option<Sink>,
    full: Receiver<Vec<f32>>,
    free: Sender<Vec<f32>>,
}

fn pipe() -> Pipe {
    let (free_tx, free_rx) = bounded(BUFFERS);
    let (full_tx, full_rx) = bounded(BUFFERS);
    for _ in 0..BUFFERS {
        let _ = free_tx.send(Vec::with_capacity(BUFFER_SAMPLES));
    }
    Pipe { sink: Some(Sink { free: free_rx, full: full_tx, dropped: Arc::new(AtomicU64::new(0)) }), full: full_rx, free: free_tx }
}

/// An open source. Dropping it closes the device or tap.
pub struct Opened {
    pub rate: u32,
    pub channels: u16,
    /// Short name for take names and messages: "Scarlett 2i2 In 3", "Chrome", "Desktop audio".
    pub name: String,
    /// The stream or capture thread, held so the source stays open until this is dropped.
    pub _open: Box<dyn std::any::Any>,
}

// ---- sources ----

/// Inputs, apps and whether everything you hear can be recorded here.
pub fn sources() -> RecordSources {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| d.name().ok());
    let mut inputs: Vec<InputDevice> = host
        .input_devices()
        .map(|devices| {
            devices
                .filter_map(|d| {
                    let name = d.name().ok()?;
                    let config = d.default_input_config().ok()?;
                    Some(InputDevice { is_default: default.as_deref() == Some(name.as_str()), name, channels: config.channels(), sample_rate: config.sample_rate().0 })
                })
                .collect()
        })
        .unwrap_or_default();
    inputs.sort_by_key(|d| !d.is_default);
    let (apps, apps_supported, system_supported, system_includes_saga, unsupported) = platform_sources();
    RecordSources { inputs, apps, apps_supported, system_supported, system_includes_saga, unsupported }
}

#[cfg(windows)]
fn platform_sources() -> (Vec<AppSource>, bool, bool, bool, Option<String>) {
    let loopback = crate::capture_win::process_loopback_supported();
    let apps = if loopback { crate::capture_win::apps().unwrap_or_default() } else { Vec::new() };
    let why = (!loopback).then(|| "Recording one app needs Windows 10 version 2004 or later.".to_string());
    (apps, loopback, true, !loopback, why)
}

#[cfg(target_os = "macos")]
fn platform_sources() -> (Vec<AppSource>, bool, bool, bool, Option<String>) {
    if crate::capture_mac::taps_supported() {
        (crate::capture_mac::apps(), true, true, false, None)
    } else {
        (Vec::new(), false, false, false, Some("Recording apps and everything you hear needs macOS 14.2 or later.".into()))
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn platform_sources() -> (Vec<AppSource>, bool, bool, bool, Option<String>) {
    (Vec::new(), false, false, false, Some("Saga can only record inputs on this system.".into()))
}

/// Explains a device that wouldn't open in words a producer can act on.
pub fn device_problem(name: &str, err: &str) -> Problem {
    let lower = err.to_lowercase();
    if lower.contains("0x80070005") || lower.contains("access is denied") || lower.contains("permission") {
        Problem { message: format!("Saga needs permission to record from {name}."), settings: Some("microphone") }
    } else if lower.contains("0x8889000a") || lower.contains("in use") || lower.contains("exclusive") {
        Problem::msg(format!(
            "Couldn't open {name}: another app is using it exclusively (probably your DAW's ASIO driver). Try recording your DAW's output with Everything you hear."
        ))
    } else if lower.contains("not available") || lower.contains("no longer") {
        Problem::msg(format!("{name} isn't connected."))
    } else {
        Problem::msg(format!("Couldn't open {name}: {err}"))
    }
}

/// "Microphone (Scarlett 2i2 USB)" → "Scarlett 2i2 USB": Windows wraps device names in their kind.
fn device_short_name(name: &str) -> String {
    match (name.find('('), name.rfind(')')) {
        (Some(a), Some(b)) if b > a + 1 && b == name.len() - 1 => name[a + 1..b].trim().to_string(),
        _ => name.trim().to_string(),
    }
}

/// "In 3" or "In 3+4" for the picked channels of a device with more than two.
fn channel_label(picks: &[usize], device_channels: usize) -> String {
    if device_channels <= 2 {
        return String::new();
    }
    let n: Vec<String> = picks.iter().map(|c| (c + 1).to_string()).collect();
    format!("In {}", n.join("+"))
}

fn build_input<T>(device: &cpal::Device, config: &cpal::StreamConfig, picks: Vec<usize>, sink: Sink, lost: Arc<Lost>) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let channels = config.channels.max(1) as usize;
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                sink.send(|out| {
                    for frame in data.chunks_exact(channels) {
                        for &p in &picks {
                            out.push(<f32 as cpal::FromSample<T>>::from_sample_(frame[p]));
                        }
                    }
                })
            },
            move |e| {
                if matches!(e, cpal::StreamError::DeviceNotAvailable) {
                    lost.set("disconnected");
                }
            },
            None,
        )
        .map_err(|e| e.to_string())
}

fn open_cpal(device: &cpal::Device, label: &str, config: cpal::SupportedStreamConfig, picks: Vec<usize>, sink: Sink, lost: Arc<Lost>) -> Result<(cpal::Stream, u32), Problem> {
    let format = config.sample_format();
    let config: cpal::StreamConfig = config.into();
    let stream = match format {
        cpal::SampleFormat::F32 => build_input::<f32>(device, &config, picks, sink, lost),
        cpal::SampleFormat::I16 => build_input::<i16>(device, &config, picks, sink, lost),
        cpal::SampleFormat::U16 => build_input::<u16>(device, &config, picks, sink, lost),
        cpal::SampleFormat::I32 => build_input::<i32>(device, &config, picks, sink, lost),
        other => Err(format!("it sends audio as {other:?}, which Saga can't record")),
    }
    .map_err(|e| device_problem(label, &e))?;
    stream.play().map_err(|e| device_problem(label, &e.to_string()))?;
    Ok((stream, config.sample_rate.0))
}

fn open_input(device: &str, channels: &[u16], sink: Sink, lost: Arc<Lost>) -> Result<Opened, Problem> {
    let host = cpal::default_host();
    let found = host.input_devices().ok().and_then(|mut all| all.find(|d| d.name().ok().as_deref() == Some(device)));
    let dev = match found {
        Some(d) => d,
        None if device.is_empty() => host.default_input_device().ok_or_else(|| Problem::msg("No audio input found."))?,
        None => return Err(Problem::msg(format!("{device} isn't connected."))),
    };
    let label = if device.is_empty() { dev.name().unwrap_or_else(|_| "the input".into()) } else { device.to_string() };
    let config = dev.default_input_config().map_err(|e| device_problem(&label, &e.to_string()))?;
    let n = config.channels().max(1) as usize;
    let mut picks: Vec<usize> = channels.iter().map(|&c| c as usize).filter(|&c| c < n).take(2).collect();
    if picks.is_empty() {
        picks = (0..n.min(2)).collect();
    }
    let suffix = channel_label(&picks, n);
    let short = device_short_name(&label);
    let name = if suffix.is_empty() { short } else { format!("{short} {suffix}") };
    let count = picks.len() as u16;
    let (stream, rate) = open_cpal(&dev, &label, config, picks, sink, lost)?;
    Ok(Opened { rate, channels: count, name, _open: Box::new(stream) })
}

/// Everything the default output plays, through cpal's loopback (Windows only). Saga's own sounds
/// are part of it; process loopback, which can leave them out, is preferred where it exists.
#[cfg(windows)]
fn open_output_loopback(sink: Sink, lost: Arc<Lost>) -> Result<Opened, Problem> {
    let host = cpal::default_host();
    let dev = host.default_output_device().ok_or_else(|| Problem::msg("No audio output found."))?;
    let config = dev.default_output_config().map_err(|e| device_problem("your audio output", &e.to_string()))?;
    let n = config.channels().max(1) as usize;
    let picks: Vec<usize> = (0..n.min(2)).collect();
    let count = picks.len() as u16;
    let (stream, rate) = open_cpal(&dev, "your audio output", config, picks, sink, lost)?;
    Ok(Opened { rate, channels: count, name: "Desktop audio".into(), _open: Box::new(stream) })
}

fn open_source(spec: &SourceSpec, sink: Sink, lost: Arc<Lost>) -> Result<Opened, Problem> {
    match spec {
        SourceSpec::Input { device, channels } => open_input(device, channels, sink, lost),
        #[cfg(windows)]
        SourceSpec::App { pid, name } => crate::capture_win::open(Some(*pid), name, sink, lost),
        #[cfg(windows)]
        SourceSpec::System => {
            if crate::capture_win::process_loopback_supported() {
                crate::capture_win::open(None, "Desktop audio", sink, lost)
            } else {
                open_output_loopback(sink, lost)
            }
        }
        #[cfg(target_os = "macos")]
        SourceSpec::App { pid, name } => crate::capture_mac::open(Some(*pid), name, sink, lost),
        #[cfg(target_os = "macos")]
        SourceSpec::System => crate::capture_mac::open(None, "Desktop audio", sink, lost),
        #[cfg(not(any(windows, target_os = "macos")))]
        _ => {
            drop((sink, lost));
            Err(Problem::msg("Saga can only record inputs on this system."))
        }
    }
}

// ---- sessions ----

enum Ctl {
    Options(TakeOptions),
    /// Start the take now, without waiting for a sound.
    RecordNow,
    /// Keep the take being recorded (if any) and close the source.
    Stop,
}

struct Session {
    spec: SourceSpec,
    ctl: Sender<Ctl>,
    done: Receiver<()>,
}

impl Session {
    fn alive(&self) -> bool {
        matches!(self.done.try_recv(), Err(TryRecvError::Empty))
    }
}

/// The one armed or recording source, if any.
#[derive(Default)]
pub struct Capture {
    session: Mutex<Option<Session>>,
}

impl Capture {
    /// Opens `spec` and arms it (or starts recording at once, without start on sound). Arming the
    /// source that's already open just updates its options; arming another keeps the take being
    /// recorded and closes the old source first.
    pub fn arm(&self, spec: SourceSpec, options: TakeOptions, ctx: Ctx) -> Result<(), Problem> {
        let mut session = self.session.lock();
        if let Some(s) = session.as_ref().filter(|s| s.alive()) {
            if s.spec == spec {
                let _ = s.ctl.send(Ctl::Options(options));
                return Ok(());
            }
        }
        if let Some(old) = session.take() {
            let _ = old.ctl.send(Ctl::Stop);
            let _ = old.done.recv_timeout(Duration::from_secs(5));
        }
        let (ctl_tx, ctl_rx) = unbounded();
        let (done_tx, done_rx) = bounded(1);
        let (ready_tx, ready_rx) = bounded(1);
        let spec2 = spec.clone();
        std::thread::Builder::new()
            // Not lowered like the analysis threads: it has to keep up with the device.
            .name("saga-capture".into())
            .spawn(move || {
                run(spec2, options, ctx, ctl_rx, ready_tx);
                let _ = done_tx.send(());
            })
            .map_err(|e| Problem::msg(e.to_string()))?;
        match ready_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => {
                *session = Some(Session { spec, ctl: ctl_tx, done: done_rx });
                Ok(())
            }
            Ok(Err(p)) => Err(p),
            Err(_) => Err(Problem::msg("The audio device didn't respond.")),
        }
    }

    pub fn set_options(&self, options: TakeOptions) {
        if let Some(s) = self.session.lock().as_ref() {
            let _ = s.ctl.send(Ctl::Options(options));
        }
    }

    pub fn record_now(&self) {
        if let Some(s) = self.session.lock().as_ref() {
            let _ = s.ctl.send(Ctl::RecordNow);
        }
    }

    /// Keeps the take being recorded and closes the source. Returns once the take is stored (a
    /// long one takes a few seconds to trim) and the source is closed.
    pub fn stop(&self) {
        if let Some(s) = self.session.lock().take() {
            let _ = s.ctl.send(Ctl::Stop);
            let _ = s.done.recv_timeout(Duration::from_secs(30));
        }
    }

    pub fn is_open(&self) -> bool {
        self.session.lock().as_ref().is_some_and(Session::alive)
    }
}

/// A take being written as it records.
struct Raw {
    writer: hound::WavWriter<std::io::BufWriter<std::fs::File>>,
    path: PathBuf,
    frames: u64,
    flushed: Instant,
}

struct Worker {
    ctx: Ctx,
    options: TakeOptions,
    is_app: bool,
    name: String,
    rate: u32,
    ch: usize,
    state: CaptureState,
    pre_roll: VecDeque<f32>,
    pre_roll_cap: usize,
    recent: VecDeque<f32>,
    recent_cap: usize,
    floor: f32,
    floor_dirty: u32,
    heard: bool,
    armed_at: Instant,
    block_len: usize,
    block_pos: usize,
    block_peak: f32,
    bar_len: usize,
    bar_pos: usize,
    bar_peak: f32,
    bars: Vec<f32>,
    level: f32,
    raw: Option<Raw>,
    /// The threshold when the take started, for trimming it.
    take_threshold: f32,
    silent_frames: u64,
    clipped: bool,
    takes: u32,
    write_error: Option<String>,
}

impl Worker {
    fn threshold(&self) -> f32 {
        match self.options.threshold_db {
            Some(db) => 10f32.powf(db / 20.0).clamp(0.0001, 1.0),
            None => (self.floor * OVER_FLOOR).clamp(MIN_THRESHOLD, MAX_THRESHOLD),
        }
    }

    fn seconds(&self) -> f32 {
        self.raw.as_ref().map_or(0.0, |r| r.frames as f32 / self.rate as f32)
    }

    fn status(&mut self) -> TakeStatus {
        TakeStatus {
            state: self.state,
            source: self.name.clone(),
            seconds: self.seconds(),
            level: self.level,
            bars: std::mem::take(&mut self.bars),
            threshold: self.threshold(),
            floor: self.floor,
            silent_for: self.silent_frames as f32 / self.rate as f32,
            clipped: self.clipped,
            takes: self.takes,
            nothing_yet: self.is_app && !self.heard && self.state == CaptureState::Armed && self.armed_at.elapsed().as_secs_f32() > NOTHING_YET_AFTER,
        }
    }

    fn update_floor(&mut self) {
        if self.recent.len() < 8 {
            return;
        }
        let mut v: Vec<f32> = self.recent.iter().copied().collect();
        v.sort_by(f32::total_cmp);
        self.floor = v[v.len() / 5];
    }

    /// Starts writing the take, beginning with the audio held while armed.
    fn start(&mut self) {
        let incoming = self.ctx.takes_dir.join(INCOMING_DIR);
        let opened = std::fs::create_dir_all(&incoming).map_err(|e| e.to_string()).and_then(|_| {
            let path = free_path(&incoming, &format!("{}.wav", take_name(&self.name, self.options.utc_offset)));
            let spec = hound::WavSpec { channels: self.ch as u16, sample_rate: self.rate, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
            hound::WavWriter::create(&path, spec).map(|w| (w, path)).map_err(|e| e.to_string())
        });
        let (writer, path) = match opened {
            Ok(x) => x,
            Err(e) => {
                self.ctx.notice(format!("Couldn't start recording: {e}"), "error", None);
                return;
            }
        };
        let mut raw = Raw { writer, path, frames: 0, flushed: Instant::now() };
        for &s in &self.pre_roll {
            if raw.writer.write_sample(s).is_err() {
                break;
            }
        }
        raw.frames = (self.pre_roll.len() / self.ch) as u64;
        self.pre_roll.clear();
        self.take_threshold = self.threshold();
        self.raw = Some(raw);
        self.state = CaptureState::Recording;
        self.silent_frames = 0;
        self.clipped = false;
        (self.ctx.on_recording)(true);
    }

    /// Ends the take being written, then trims and stores it. With `rearm` (keep going) the source
    /// stays armed and storing happens beside it; otherwise it's done before this returns, so a take
    /// stopped by quitting is complete.
    fn finish(&mut self, rearm: bool) {
        self.silent_frames = 0;
        let raw = self.raw.take();
        self.state = if rearm { CaptureState::Armed } else { CaptureState::Idle };
        if rearm {
            self.armed_at = Instant::now();
        }
        let Some(raw) = raw else { return };
        (self.ctx.on_recording)(false);
        // The window hears at once that the take ended; trimming and storing take a moment.
        let s = self.status();
        self.ctx.status(&s);
        let path = raw.path.clone();
        if let Err(e) = raw.writer.finalize() {
            // The raw file stays where it is and is recovered the next time Saga opens.
            self.ctx.notice(format!("Couldn't finish the take: {e}. Saga will try again the next time it opens."), "error", None);
            return;
        }
        self.takes += 1;
        let (ctx, name, threshold, floor, is_app) = (self.ctx.clone(), self.name.clone(), self.take_threshold, self.floor, self.is_app);
        let job = move || store(&ctx, &path, threshold, floor, false, &name, is_app);
        if rearm {
            let _ = std::thread::Builder::new().name("saga-take".into()).spawn(job);
        } else {
            job();
        }
    }

    fn end_block(&mut self, peak: f32) {
        self.level = peak;
        if peak > 1e-6 {
            self.heard = true;
        }
        match self.state {
            CaptureState::Armed => {
                if self.recent.len() == self.recent_cap {
                    self.recent.pop_front();
                }
                self.recent.push_back(peak);
                self.floor_dirty += 1;
                if self.floor_dirty >= 20 {
                    self.floor_dirty = 0;
                    self.update_floor();
                }
                if self.options.start_on_sound && peak > self.threshold() && self.recent.len() >= 8 {
                    self.start();
                }
            }
            CaptureState::Recording => {
                if peak >= self.take_threshold.min(self.threshold()) {
                    self.silent_frames = 0;
                } else {
                    self.silent_frames += self.block_len as u64;
                }
                let silent = self.options.stop_after.is_some_and(|s| self.silent_frames as f32 >= s * self.rate as f32);
                if silent {
                    self.finish(self.options.keep_going);
                } else if self.seconds() >= MAX_SECONDS {
                    self.ctx.notice("Takes stop at 15 minutes. This one is kept.", "info", None);
                    self.finish(false);
                }
            }
            CaptureState::Idle => {}
        }
    }

    fn process(&mut self, buf: &[f32]) {
        for frame in buf.chunks_exact(self.ch) {
            let mut peak = 0f32;
            for &s in frame {
                peak = peak.max(s.abs());
            }
            match self.state {
                CaptureState::Armed => {
                    if self.pre_roll.len() + self.ch > self.pre_roll_cap {
                        for _ in 0..self.ch {
                            self.pre_roll.pop_front();
                        }
                    }
                    self.pre_roll.extend(frame.iter().copied());
                }
                CaptureState::Recording => {
                    if peak >= 0.999 {
                        self.clipped = true;
                    }
                    if let Some(raw) = self.raw.as_mut() {
                        for &s in frame {
                            if let Err(e) = raw.writer.write_sample(s) {
                                self.write_error.get_or_insert(e.to_string());
                            }
                        }
                        raw.frames += 1;
                    }
                }
                CaptureState::Idle => {}
            }
            self.bar_peak = self.bar_peak.max(peak);
            self.bar_pos += 1;
            if self.bar_pos >= self.bar_len {
                self.bars.push(self.bar_peak.min(1.0));
                self.bar_pos = 0;
                self.bar_peak = 0.0;
            }
            self.block_peak = self.block_peak.max(peak);
            self.block_pos += 1;
            if self.block_pos >= self.block_len {
                let p = self.block_peak;
                self.block_pos = 0;
                self.block_peak = 0.0;
                self.end_block(p);
                if self.write_error.is_some() {
                    return;
                }
            }
        }
        if let Some(raw) = self.raw.as_mut() {
            if raw.flushed.elapsed() >= FLUSH_EVERY {
                raw.flushed = Instant::now();
                if let Err(e) = raw.writer.flush() {
                    self.write_error.get_or_insert(e.to_string());
                }
            }
        }
    }
}

fn run(spec: SourceSpec, options: TakeOptions, ctx: Ctx, ctl: Receiver<Ctl>, ready: Sender<Result<(), Problem>>) {
    let mut p = pipe();
    let lost = Arc::new(Lost::default());
    let Some(sink) = p.sink.take() else { return };
    let dropped = sink.dropped.clone();
    let opened = match open_source(&spec, sink, lost.clone()) {
        Ok(o) => o,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    let (rate, ch) = (opened.rate.max(1), opened.channels.max(1) as usize);
    let mut w = Worker {
        is_app: !matches!(spec, SourceSpec::Input { .. }),
        name: opened.name.clone(),
        ctx,
        options,
        rate,
        ch,
        state: CaptureState::Armed,
        pre_roll: VecDeque::with_capacity((PRE_ROLL * rate as f32) as usize * ch + ch),
        pre_roll_cap: (PRE_ROLL * rate as f32) as usize * ch,
        recent: VecDeque::new(),
        recent_cap: (FLOOR_WINDOW / BLOCK) as usize,
        floor: 0.0,
        floor_dirty: 0,
        heard: false,
        armed_at: Instant::now(),
        block_len: ((BLOCK * rate as f32) as usize).max(1),
        block_pos: 0,
        block_peak: 0.0,
        bar_len: ((BAR * rate as f32) as usize).max(1),
        bar_pos: 0,
        bar_peak: 0.0,
        bars: Vec::new(),
        level: 0.0,
        raw: None,
        take_threshold: MIN_THRESHOLD,
        silent_frames: 0,
        clipped: false,
        takes: 0,
        write_error: None,
    };
    if !options.start_on_sound {
        w.start();
    }
    let mut last_status = Instant::now();
    let mut stopping = false;
    loop {
        match p.full.recv_timeout(Duration::from_millis(15)) {
            Ok(buf) => {
                w.process(&buf);
                let _ = p.free.send(buf);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if let Some(e) = w.write_error.take() {
            let full = e.to_lowercase().contains("space") || e.to_lowercase().contains("full");
            let msg = if full { "Couldn't keep recording: the disk is full. The take so far is kept.".to_string() } else { format!("Couldn't keep recording: {e}. The take so far is kept.") };
            w.ctx.notice(msg, "error", None);
            w.finish(false);
            break;
        }
        loop {
            match ctl.try_recv() {
                Ok(Ctl::Options(o)) => {
                    let start_now = w.state == CaptureState::Armed && !o.start_on_sound && w.options.start_on_sound;
                    w.options = o;
                    if start_now {
                        w.start();
                    }
                }
                Ok(Ctl::RecordNow) => {
                    if w.state == CaptureState::Armed {
                        w.start();
                    }
                }
                Ok(Ctl::Stop) | Err(TryRecvError::Disconnected) => {
                    stopping = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        if stopping {
            // Whatever is still on its way from the callback belongs to the take.
            while let Ok(buf) = p.full.try_recv() {
                w.process(&buf);
            }
            w.finish(false);
            break;
        }
        if lost.is_set() {
            let secs = w.seconds();
            let why = lost.why.lock().clone().unwrap_or_default();
            let gone = if w.is_app && why != "disconnected" { format!("{} stopped", w.name) } else { format!("{} was disconnected", w.name) };
            let msg = if w.state == CaptureState::Recording { format!("{gone}. Kept the first {secs:.1} s.") } else { format!("{gone}.") };
            w.ctx.notice(msg, "error", None);
            w.finish(false);
            break;
        }
        if w.state == CaptureState::Idle {
            break;
        }
        if last_status.elapsed() >= STATUS_EVERY {
            last_status = Instant::now();
            let s = w.status();
            w.ctx.status(&s);
        }
    }
    let n = dropped.load(Ordering::Relaxed);
    if n > 0 {
        eprintln!("saga: capture dropped {n} buffers");
    }
    drop(opened);
    w.state = CaptureState::Idle;
    let s = w.status();
    w.ctx.status(&s);
}

// ---- storing takes ----

/// `Chrome 14.32.07`: the source and the local time, with dots because file names can't hold colons.
fn take_name(source: &str, utc_offset: i32) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let local = (now + utc_offset as i64 * 60).rem_euclid(86_400);
    format!("{source} {:02}.{:02}.{:02}", local / 3600, local / 60 % 60, local % 60)
}

/// Frames to keep from a recording: from just before its first sound to just after its last.
/// `None` when nothing in it reaches `threshold`.
pub fn trim_bounds(peaks: impl Iterator<Item = f32>, rate: u32, threshold: f32, floor: f32) -> Option<(u64, u64)> {
    let tail = (floor * TAIL_OVER_FLOOR).max(MIN_TAIL).min(threshold);
    let (mut first, mut last, mut n) = (None, 0u64, 0u64);
    for p in peaks {
        if first.is_none() && p > threshold {
            first = Some(n);
        }
        if p > tail {
            last = n;
        }
        n += 1;
    }
    let first = first?;
    let last = last.max(first);
    let start = first.saturating_sub((PRE_ROLL_KEEP * rate as f32) as u64);
    let end = (last + 1 + (TAIL_KEEP * rate as f32) as u64).min(n);
    Some((start, end))
}

/// The noise floor of a whole recording: a low percentile of its block peaks.
fn floor_of(peaks: &[f32]) -> f32 {
    if peaks.is_empty() {
        return 0.0;
    }
    let mut v = peaks.to_vec();
    v.sort_by(f32::total_cmp);
    v[v.len() / 5]
}

fn take_format(db: &Db) -> (u16, hound::SampleFormat) {
    match db.get_setting(TAKE_FORMAT_SETTING).as_deref() {
        Some("float") => (32, hound::SampleFormat::Float),
        _ => (24, hound::SampleFormat::Int),
    }
}

/// Trims a raw take, writes it to the takes folder in the chosen format, and indexes it. Returns
/// the new take's path, or `None` when only silence came through. The raw file is removed either way.
pub fn finish_raw(raw: &Path, dest_dir: &Path, name: &str, threshold: Option<f32>, floor: Option<f32>, bits: (u16, hound::SampleFormat)) -> Result<Option<PathBuf>, String> {
    let mut reader = hound::WavReader::open(raw).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let ch = spec.channels.max(1) as usize;
    let rate = spec.sample_rate;
    // Pass 1: the peak of every frame, to find where the sound starts and ends.
    let mut frame_peaks: Vec<f32> = Vec::with_capacity(reader.duration() as usize);
    {
        let mut peak = 0f32;
        for (i, s) in reader.samples::<f32>().enumerate() {
            let s = s.map_err(|e| e.to_string())?;
            peak = peak.max(s.abs());
            if i % ch == ch - 1 {
                frame_peaks.push(peak);
                peak = 0.0;
            }
        }
    }
    let floor = floor.unwrap_or_else(|| {
        let block = ((BLOCK * rate as f32) as usize).max(1);
        let blocks: Vec<f32> = frame_peaks.chunks(block).map(|c| c.iter().fold(0f32, |a, &b| a.max(b))).collect();
        floor_of(&blocks)
    });
    let threshold = threshold.unwrap_or((floor * OVER_FLOOR).clamp(MIN_THRESHOLD, MAX_THRESHOLD));
    let Some((start, end)) = trim_bounds(frame_peaks.iter().copied(), rate, threshold, floor) else {
        drop(reader);
        let _ = std::fs::remove_file(raw);
        return Ok(None);
    };
    drop(frame_peaks);
    // Pass 2: copy what's kept, with short fades where it was cut.
    reader.seek(start as u32).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let dest = free_path(dest_dir, &format!("{name}.wav"));
    let out_spec = hound::WavSpec { channels: spec.channels, sample_rate: rate, bits_per_sample: bits.0, sample_format: bits.1 };
    let mut writer = hound::WavWriter::create(&dest, out_spec).map_err(|e| e.to_string())?;
    let frames = end - start;
    let fade_in = if start > 0 { (FADE_IN * rate as f32) as u64 } else { 0 };
    let fade_out = if end < reader.duration() as u64 { (FADE_OUT * rate as f32) as u64 } else { 0 };
    let mut samples = reader.samples::<f32>();
    for f in 0..frames {
        let mut gain = 1.0f32;
        if f < fade_in {
            gain = f as f32 / fade_in as f32;
        }
        if fade_out > 0 && f + fade_out >= frames {
            gain = gain.min((frames - f) as f32 / fade_out as f32);
        }
        for _ in 0..ch {
            let s = samples.next().transpose().map_err(|e| e.to_string())?.unwrap_or(0.0) * gain;
            let written = if bits.1 == hound::SampleFormat::Float {
                writer.write_sample(s)
            } else {
                writer.write_sample((s.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32)
            };
            written.map_err(|e| e.to_string())?;
        }
    }
    writer.finalize().map_err(|e| e.to_string())?;
    drop(reader);
    let _ = std::fs::remove_file(raw);
    Ok(Some(dest))
}

/// Finishes a raw take and adds it to the takes, telling the window. Runs off the capture thread.
fn store(ctx: &Ctx, raw: &Path, threshold: f32, floor: f32, recovered: bool, source: &str, is_app: bool) {
    let name = raw.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Take".into());
    let name = if recovered { format!("{name} (recovered)") } else { name };
    let (threshold, floor) = if recovered { (None, None) } else { (Some(threshold), Some(floor)) };
    match finish_raw(raw, &ctx.takes_dir, &name, threshold, floor, take_format(&ctx.db)) {
        Ok(Some(path)) => match ctx.indexer.add_file_now(ctx.takes_source, "Takes", &ctx.takes_dir, &path) {
            Ok(id) => (ctx.emit)("take-landed", serde_json::to_value(TakeLanded { id, recovered }).unwrap_or_default()),
            Err(e) => ctx.notice(format!("Couldn't add the take: {e}"), "error", None),
        },
        Ok(None) if is_app => ctx.notice(format!("Only silence came through from {source}. Some apps block recording."), "error", system_audio_settings()),
        Ok(None) => ctx.notice(format!("Only silence came through from {source}. Check that Saga may use it."), "error", Some("microphone")),
        Err(e) => ctx.notice(format!("Couldn't finish the take: {e}"), "error", None),
    }
}

fn system_audio_settings() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        Some("systemAudio")
    } else {
        None
    }
}

/// Repairs the sizes in a WAV header left unfinished by a crash: everything after the data chunk's
/// header is taken as audio, down to the last whole frame.
pub fn repair_wav(path: &Path) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new().read(true).write(true).open(path)?;
    let len = f.metadata()?.len();
    let mut head = [0u8; 12];
    f.read_exact(&mut head)?;
    if &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" {
        return Err(std::io::Error::other("not a WAV file"));
    }
    let mut pos = 12u64;
    let mut block_align = 0u64;
    while pos + 8 <= len {
        f.seek(SeekFrom::Start(pos))?;
        let mut chunk = [0u8; 8];
        f.read_exact(&mut chunk)?;
        let size = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]) as u64;
        if &chunk[0..4] == b"fmt " {
            let mut fmt = [0u8; 16];
            f.read_exact(&mut fmt)?;
            block_align = u16::from_le_bytes([fmt[12], fmt[13]]) as u64;
        }
        if &chunk[0..4] == b"data" {
            let mut data = len - pos - 8;
            if block_align > 0 {
                data -= data % block_align;
            }
            f.seek(SeekFrom::Start(pos + 4))?;
            f.write_all(&(data as u32).to_le_bytes())?;
            f.seek(SeekFrom::Start(4))?;
            f.write_all(&((pos + 8 + data - 8) as u32).to_le_bytes())?;
            return f.set_len(pos + 8 + data);
        }
        pos += 8 + size + (size & 1);
    }
    Err(std::io::Error::other("no audio in the file"))
}

/// Takes left half-written by a crash or a forced quit: repaired, trimmed and added to the takes.
pub fn recover(ctx: &Ctx) {
    let incoming = ctx.takes_dir.join(INCOMING_DIR);
    let Ok(entries) = std::fs::read_dir(&incoming) else { return };
    for e in entries.flatten() {
        let path = e.path();
        if !path.extension().is_some_and(|x| x.eq_ignore_ascii_case("wav")) {
            continue;
        }
        if repair_wav(&path).is_err() {
            continue;
        }
        let source = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        store(ctx, &path, 0.0, 0.0, true, &source, true);
    }
}

/// Unsaved takes whose files are gone are forgotten, and files in the takes folder the library
/// doesn't know (stored just before a crash) are added.
pub fn reconcile(ctx: &Ctx) {
    let Ok(rows) = ctx.db.takes(ctx.takes_source) else { return };
    let gone: Vec<i64> = rows.iter().filter(|r| !Path::new(&r.path).exists()).map(|r| r.id).collect();
    if !gone.is_empty() {
        let _ = ctx.db.delete_ids(&gone);
    }
    let known: std::collections::HashSet<String> = rows.into_iter().map(|r| r.path).collect();
    let Ok(entries) = std::fs::read_dir(&ctx.takes_dir) else { return };
    for e in entries.flatten() {
        let path = e.path();
        if path.is_file() && crate::decode::is_audio_path(&path) && !known.contains(&path.to_string_lossy().to_string()) {
            let _ = ctx.indexer.add_file_now(ctx.takes_source, "Takes", &ctx.takes_dir, &path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(n: usize, amp: f32) -> Vec<f32> {
        (0..n).map(|i| (i as f32 * 0.05).sin() * amp).collect()
    }

    #[test]
    fn trims_to_the_sound_keeping_its_attack_and_tail() {
        let rate = 48_000;
        let mut peaks = vec![0.0005f32; 48_000];
        peaks.extend(tone(24_000, 0.5).iter().map(|s| s.abs().max(0.3)));
        // A quiet tail below the start threshold but above the floor.
        peaks.extend(vec![0.003f32; 4800]);
        peaks.extend(vec![0.0005f32; 48_000]);
        let (start, end) = trim_bounds(peaks.iter().copied(), rate, 0.002 * OVER_FLOOR, 0.0005).unwrap();
        assert_eq!(start, 48_000 - (PRE_ROLL_KEEP * rate as f32) as u64);
        // The tail is kept, then 30 ms more.
        assert_eq!(end, 48_000 + 24_000 + 4800 + (TAIL_KEEP * rate as f32) as u64);
        assert!(trim_bounds(vec![0.0005f32; 1000].into_iter(), rate, 0.008, 0.0005).is_none());
    }

    #[test]
    fn writes_trimmed_takes_in_the_chosen_format() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("raw.wav");
        let spec = hound::WavSpec { channels: 2, sample_rate: 44_100, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
        let mut w = hound::WavWriter::create(&raw, spec).unwrap();
        for i in 0..44_100 * 3 {
            let s = if (44_100..88_200).contains(&i) { (i as f32 * 0.06).sin() * 0.6 } else { 0.0 };
            w.write_sample(s).unwrap();
            w.write_sample(s).unwrap();
        }
        w.finalize().unwrap();
        let out = finish_raw(&raw, dir.path(), "Chrome 14.32.07", None, None, (24, hound::SampleFormat::Int)).unwrap().unwrap();
        assert_eq!(out.file_name().unwrap(), "Chrome 14.32.07.wav");
        assert!(!raw.exists());
        let r = hound::WavReader::open(&out).unwrap();
        assert_eq!((r.spec().bits_per_sample, r.spec().channels, r.spec().sample_rate), (24, 2, 44_100));
        let secs = r.duration() as f32 / 44_100.0;
        assert!((secs - 1.05).abs() < 0.03, "{secs}");
    }

    #[test]
    fn silence_makes_no_take() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("raw.wav");
        let spec = hound::WavSpec { channels: 1, sample_rate: 44_100, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
        let mut w = hound::WavWriter::create(&raw, spec).unwrap();
        for _ in 0..44_100 {
            w.write_sample(0.0f32).unwrap();
        }
        w.finalize().unwrap();
        assert_eq!(finish_raw(&raw, dir.path(), "Silent", None, None, (24, hound::SampleFormat::Int)), Ok(None));
        assert!(!raw.exists());
    }

    #[test]
    fn repairs_a_take_left_by_a_crash() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("crashed.wav");
        let spec = hound::WavSpec { channels: 2, sample_rate: 48_000, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
        let mut w = hound::WavWriter::create(&raw, spec).unwrap();
        for i in 0..48_000 {
            let s = (i as f32 * 0.05).sin() * 0.5;
            w.write_sample(s).unwrap();
            w.write_sample(s).unwrap();
        }
        w.flush().unwrap();
        // Written after the last flush, and half a frame torn off: as if the app died here.
        for i in 0..4800 {
            w.write_sample((i as f32 * 0.05).sin() * 0.5).unwrap();
        }
        std::mem::forget(w);
        let mut f = std::fs::OpenOptions::new().append(true).open(&raw).unwrap();
        f.write_all(&[0, 0]).unwrap();
        drop(f);
        repair_wav(&raw).unwrap();
        let r = hound::WavReader::open(&raw).unwrap();
        assert!(r.duration() >= 48_000, "{}", r.duration());
    }

    #[test]
    fn names_takes_after_the_source_and_local_time() {
        let n = take_name("Chrome", 0);
        assert!(n.starts_with("Chrome ") && n.len() == "Chrome 00.00.00".len(), "{n}");
        assert_eq!(device_short_name("Microphone (Scarlett 2i2 USB)"), "Scarlett 2i2 USB");
        assert_eq!(device_short_name("MacBook Pro Microphone"), "MacBook Pro Microphone");
        assert_eq!(channel_label(&[2, 3], 8), "In 3+4");
        assert_eq!(channel_label(&[0], 2), "");
    }

    /// Records two seconds of everything this machine plays (something has to be playing) through the
    /// whole path: arm, write, stop, trim, store. By hand: `cargo test --lib records_a_take -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn records_a_take() {
        let data = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&data.path().join("t.db")).unwrap());
        let indexer = Indexer::start(db.clone(), Arc::new(|_, _| {}));
        let takes_dir = data.path().join("Takes");
        std::fs::create_dir_all(&takes_dir).unwrap();
        let landed = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = landed.clone();
        let ctx = Ctx {
            takes_source: db.takes_source(&takes_dir.to_string_lossy()).unwrap(),
            db: db.clone(),
            indexer,
            takes_dir: takes_dir.clone(),
            emit: Arc::new(move |name, payload| {
                if name != "take-status" {
                    seen.lock().push(format!("{name} {payload}"));
                }
            }),
            on_recording: Arc::new(|_| {}),
        };
        let capture = Capture::default();
        let options = TakeOptions { start_on_sound: false, stop_after: None, keep_going: false, threshold_db: None, utc_offset: 0 };
        capture.arm(SourceSpec::System, options, ctx.clone()).unwrap();
        std::thread::sleep(Duration::from_secs(2));
        capture.stop();
        println!("{:?}", landed.lock());
        let rows = db.takes(ctx.takes_source).unwrap();
        assert_eq!(rows.len(), 1, "{:?}", landed.lock());
        let r = hound::WavReader::open(&rows[0].path).unwrap();
        println!("{} · {} Hz · {}-bit · {:.2} s", rows[0].name, r.spec().sample_rate, r.spec().bits_per_sample, r.duration() as f32 / r.spec().sample_rate as f32);
        assert!(!takes_dir.join(INCOMING_DIR).read_dir().is_ok_and(|mut d| d.next().is_some()));
    }

    #[test]
    fn explains_devices_that_wont_open() {
        assert_eq!(device_problem("Mic", "Access is denied. (0x80070005)").settings, Some("microphone"));
        assert!(device_problem("Scarlett", "Device in use (0x8889000A)").message.contains("exclusively"));
    }
}
