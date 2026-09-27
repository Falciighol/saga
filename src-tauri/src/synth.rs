//! Note voices for the Lab: a few small instruments that play scales, chords and progressions
//! through the preview mixer, so they use the chosen output device and sit in time with the click.
//! Notes are built on the engine thread (the pluck allocates its string there) and only
//! rendered in the audio callback.

use serde::Deserialize;
use std::f32::consts::TAU;
use std::sync::atomic::{AtomicU32, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Preset {
    /// Electric piano: two-operator FM with a bell-like attack that mellows as it decays.
    Keys,
    /// Soft pad: detuned triangles spread left and right, with a sine an octave below.
    Pad,
    /// Plucked string (Karplus–Strong).
    Pluck,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteEvent {
    /// MIDI note number, 60 = middle C.
    pub note: f32,
    /// Seconds from now until the note starts.
    #[serde(default)]
    pub at: f64,
    /// Seconds the note is held before it's released.
    pub length: f64,
    /// 0–1.
    #[serde(default = "full")]
    pub velocity: f32,
}

pub fn full() -> f32 {
    1.0
}

/// A progression note at an exact frame of the mixer's clock.
#[derive(Debug, Clone, Copy)]
pub struct Scheduled {
    pub note: f32,
    pub frame: u64,
    /// Frames held before release.
    pub hold: usize,
    pub velocity: f32,
}

/// Most notes sounding at once; the oldest are dropped past this.
const MAX_NOTES: usize = 64;
/// Headroom so a four-note chord at full velocity stays well clear of clipping.
const LEVEL: f32 = 0.2;

struct Note {
    preset: Preset,
    freq: f32,
    vel: f32,
    /// Frames until the note starts.
    wait: usize,
    /// Start on the mixer's clock, turned into `wait` when the note joins the mix.
    at: Option<u64>,
    /// Played by the progression player, which stops and reschedules only its own notes.
    seq: bool,
    /// Frames held after the start.
    hold: usize,
    age: usize,
    env: f32,
    released: bool,
    phases: [f32; 3],
    /// Pluck: the string, its read position and the fractional-delay allpass state.
    string: Vec<f32>,
    pos: usize,
    prev: f32,
    ap_coef: f32,
    ap_x: f32,
    ap_y: f32,
    damp: f32,
}

impl Note {
    fn new(midi: f32, hold: usize, velocity: f32, preset: Preset, rate: u32, seed: u32) -> Note {
        let r = rate as f32;
        let freq = 440.0 * 2f32.powf((midi - 69.0) / 12.0);
        let mut note = Note {
            preset,
            freq,
            vel: velocity.clamp(0.0, 1.0),
            wait: 0,
            at: None,
            seq: false,
            hold: hold.max(rate as usize / 100),
            age: 0,
            env: 0.0,
            released: false,
            phases: [0.0; 3],
            string: Vec::new(),
            pos: 0,
            prev: 0.0,
            ap_coef: 0.0,
            ap_x: 0.0,
            ap_y: 0.0,
            damp: 1.0,
        };
        if preset == Preset::Pluck {
            // The loop delays by the string length, half a sample in the averaging filter and
            // `d` in the allpass; keep `d` in 0.1–1.1, where the allpass is accurate.
            let period = r / freq;
            let len = ((period - 0.6).floor() as usize).max(2);
            let d = period - 0.5 - len as f32;
            note.ap_coef = (1.0 - d) / (1.0 + d);
            // A softened noise burst: brighter strings sound harsh through laptop speakers.
            let mut s = seed | 1;
            let mut last = 0.0;
            note.string = (0..len)
                .map(|_| {
                    s ^= s << 13;
                    s ^= s >> 17;
                    s ^= s << 5;
                    let white = (s as f32 / u32::MAX as f32) * 2.0 - 1.0;
                    last = last * 0.45 + white * 0.55;
                    last
                })
                .collect();
            let mean = note.string.iter().sum::<f32>() / len as f32;
            note.string.iter_mut().for_each(|v| *v -= mean);
            // Low strings ring for about three seconds, high ones for under one.
            let t60 = (3.0 * (220.0 / freq).sqrt()).clamp(0.7, 4.0);
            note.damp = (0.001f32.ln() / (t60 * r)).exp();
        }
        note
    }

    /// Released and 60 dB down.
    fn finished(&self) -> bool {
        self.released && self.env < 1e-3
    }

    /// Adds `n` frames into `out` (stereo, interleaved).
    fn render(&mut self, out: &mut [f32], n: usize, rate: f32) {
        let mut f = 0;
        if self.wait > 0 {
            let skip = self.wait.min(n);
            self.wait -= skip;
            f = skip;
        }
        let inv = 1.0 / rate;
        // Per-sample coefficients for the envelopes.
        let coef = |seconds: f32| (-inv / seconds).exp();
        let (attack, decay, sustain, release) = match self.preset {
            Preset::Keys => (0.002, coef(1.4), 0.0, coef(0.12)),
            Preset::Pad => (0.28, coef(1.0), 0.7, coef(0.3)),
            Preset::Pluck => (0.001, 1.0, 1.0, coef(0.06)),
        };
        while f < n {
            if !self.released && self.age >= self.hold {
                self.released = true;
            }
            let t = self.age as f32 * inv;
            // Envelope: linear attack, then exponential towards the sustain level, then release.
            if self.released {
                self.env *= release;
            } else if t < attack {
                self.env = t / attack;
            } else {
                self.env = sustain + (self.env - sustain) * decay;
            }
            let (l, r) = self.sample(t, rate);
            let g = self.env * self.vel * LEVEL;
            out[f * 2] += l * g;
            out[f * 2 + 1] += r * g;
            self.age += 1;
            f += 1;
            if self.finished() {
                break;
            }
        }
    }

    fn sample(&mut self, t: f32, rate: f32) -> (f32, f32) {
        let step = self.freq / rate;
        match self.preset {
            Preset::Keys => {
                let index = 1.6 * (-t / 0.3).exp() + 0.12;
                let s = (self.phases[0] * TAU + index * (self.phases[1] * TAU).sin()).sin();
                self.phases[0] = (self.phases[0] + step).fract();
                self.phases[1] = (self.phases[1] + step).fract();
                (s, s)
            }
            Preset::Pad => {
                let tri = |p: f32| 4.0 * (p - (p + 0.5).floor()).abs() - 1.0;
                let detune = 2f32.powf(6.0 / 1200.0);
                let a = tri(self.phases[0]);
                let b = tri(self.phases[1]);
                let sub = (self.phases[2] * TAU).sin() * 0.35;
                self.phases[0] = (self.phases[0] + step * detune).fract();
                self.phases[1] = (self.phases[1] + step / detune).fract();
                self.phases[2] = (self.phases[2] + step * 0.5).fract();
                (0.5 * (a * 0.75 + b * 0.25) + sub, 0.5 * (a * 0.25 + b * 0.75) + sub)
            }
            Preset::Pluck => {
                let x = self.string[self.pos];
                let avg = 0.5 * (x + self.prev);
                self.prev = x;
                let ap = self.ap_coef * avg + self.ap_x - self.ap_coef * self.ap_y;
                self.ap_x = avg;
                self.ap_y = ap;
                self.string[self.pos] = ap * self.damp;
                self.pos = (self.pos + 1) % self.string.len();
                let s = x * 1.2;
                (s, s)
            }
        }
    }
}

/// Notes ready to mix. Built before taking the mixer's lock, since the pluck allocates its string
/// and the audio callback outputs silence while the lock is held.
pub struct Batch(Vec<Note>);

static SEED: AtomicU32 = AtomicU32::new(0x9E37_79B9);

fn seed() -> u32 {
    SEED.fetch_add(0x6D2B_79F5, Ordering::Relaxed)
}

impl Batch {
    /// Notes timed from when they join the mix.
    pub fn new(events: &[NoteEvent], preset: Preset, rate: u32) -> Batch {
        Batch(
            events
                .iter()
                .map(|e| {
                    let mut n = Note::new(e.note, (e.length.max(0.0) * rate as f64) as usize, e.velocity, preset, rate, seed());
                    n.wait = (e.at.max(0.0) * rate as f64) as usize;
                    n
                })
                .collect(),
        )
    }

    /// Progression notes at exact frames of the mixer's clock.
    pub fn scheduled(notes: &[Scheduled], preset: Preset, rate: u32) -> Batch {
        Batch(
            notes
                .iter()
                .map(|s| {
                    let mut n = Note::new(s.note, s.hold, s.velocity, preset, rate, seed());
                    n.at = Some(s.frame);
                    n.seq = true;
                    n
                })
                .collect(),
        )
    }
}

pub struct Synth {
    notes: Vec<Note>,
}

impl Default for Synth {
    fn default() -> Synth {
        // Room for a full set plus a chord, so adding notes on the audio lock doesn't allocate.
        Synth { notes: Vec::with_capacity(MAX_NOTES + 16) }
    }
}

impl Synth {
    /// Adds notes; `clock` is the mixer frame the next render starts at.
    pub fn add(&mut self, batch: Batch, clock: u64) {
        self.notes.extend(batch.0.into_iter().map(|mut n| {
            if let Some(at) = n.at.take() {
                n.wait = at.saturating_sub(clock) as usize;
            }
            n
        }));
        if self.notes.len() > MAX_NOTES {
            let extra = self.notes.len() - MAX_NOTES;
            self.notes.drain(..extra);
        }
    }

    /// Lets everything ring out quickly, and drops notes that haven't started.
    pub fn release_all(&mut self) {
        self.notes.retain(|n| n.wait == 0);
        for n in &mut self.notes {
            n.released = true;
        }
    }

    /// Drops progression notes that haven't started, so they can be scheduled again.
    pub fn drop_pending_seq(&mut self) {
        self.notes.retain(|n| !(n.seq && n.wait > 0));
    }

    /// Stops the progression: its sounding notes ring out quickly and pending ones are dropped.
    pub fn release_seq(&mut self) {
        self.drop_pending_seq();
        for n in self.notes.iter_mut().filter(|n| n.seq) {
            n.released = true;
        }
    }

    pub fn clear(&mut self) {
        self.notes.clear();
    }

    pub fn active(&self) -> bool {
        !self.notes.is_empty()
    }

    /// Adds `n` frames into `out` (stereo, interleaved).
    pub fn render(&mut self, out: &mut [f32], n: usize, rate: u32) {
        for note in &mut self.notes {
            note.render(out, n, rate as f32);
        }
        self.notes.retain(|n| !n.finished());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;

    fn run(events: &[NoteEvent], preset: Preset, seconds: f32) -> Vec<f32> {
        let mut s = Synth::default();
        s.add(Batch::new(events, preset, RATE), 0);
        let frames = (seconds * RATE as f32) as usize;
        let mut out = vec![0.0; frames * 2];
        for chunk in out.chunks_mut(512 * 2) {
            let n = chunk.len() / 2;
            s.render(chunk, n, RATE);
        }
        // Both channels, so the pad's left and right detuning average out.
        out.chunks(2).map(|f| 0.5 * (f[0] + f[1])).collect()
    }

    fn note(note: f32, at: f64, length: f64) -> NoteEvent {
        NoteEvent { note, at, length, velocity: 1.0 }
    }

    /// Frequency from the autocorrelation peak, refined with a parabola.
    fn pitch(x: &[f32], expect: f32) -> f32 {
        let corr = |lag: usize| x.iter().zip(&x[lag..]).map(|(a, b)| a * b).sum::<f32>();
        let lo = (RATE as f32 / (expect * 1.1)) as usize;
        let hi = (RATE as f32 / (expect / 1.1)) as usize;
        let best = (lo..=hi).max_by(|a, b| corr(*a).total_cmp(&corr(*b))).unwrap();
        let (a, b, c) = (corr(best - 1), corr(best), corr(best + 1));
        let lag = best as f32 + 0.5 * (a - c) / (a - 2.0 * b + c);
        RATE as f32 / lag
    }

    fn cents(a: f32, b: f32) -> f32 {
        1200.0 * (a / b).log2()
    }

    #[test]
    fn every_preset_plays_in_tune() {
        for preset in [Preset::Keys, Preset::Pad, Preset::Pluck] {
            for midi in [45.0, 69.0, 84.0] {
                let x = run(&[note(midi, 0.0, 1.0)], preset, 0.5);
                let expect = 440.0 * 2f32.powf((midi - 69.0) / 12.0);
                let got = pitch(&x[4800..], expect);
                assert!(cents(got, expect).abs() < 5.0, "{preset:?} {midi}: {got} Hz, want {expect}");
            }
        }
    }

    #[test]
    fn notes_wait_for_their_start_and_stop_after_release() {
        let x = run(&[note(60.0, 0.1, 0.2)], Preset::Keys, 1.0);
        let start = (0.1 * RATE as f32) as usize;
        assert!(x[..start].iter().all(|v| *v == 0.0));
        assert!(x[start..start + 2400].iter().any(|v| v.abs() > 0.05));

        let mut s = Synth::default();
        s.add(Batch::new(&[note(60.0, 0.0, 0.2)], Preset::Pad, RATE), 0);
        let mut out = vec![0.0; 512 * 2];
        for _ in 0..(RATE as usize * 3 / 512) {
            s.render(&mut out, 512, RATE);
        }
        assert!(!s.active(), "released pad should have ended");
    }

    #[test]
    fn a_chord_stays_below_full_scale() {
        let chord: Vec<_> = [57.0, 60.0, 64.0, 67.0].iter().map(|m| note(*m, 0.0, 1.0)).collect();
        for preset in [Preset::Keys, Preset::Pad, Preset::Pluck] {
            let peak = run(&chord, preset, 1.0).iter().fold(0f32, |m, v| m.max(v.abs()));
            assert!(peak > 0.1 && peak < 0.9, "{preset:?} peak {peak}");
        }
    }

    #[test]
    fn release_all_drops_pending_notes() {
        let mut s = Synth::default();
        s.add(Batch::new(&[note(60.0, 0.0, 5.0), note(64.0, 2.0, 1.0)], Preset::Keys, RATE), 0);
        s.release_all();
        assert_eq!(s.notes.len(), 1);
        assert!(s.notes[0].released);
    }

    #[test]
    fn scheduled_notes_start_on_their_frame_of_the_clock() {
        let at = |frame| Scheduled { note: 60.0, frame, hold: 4_800, velocity: 1.0 };
        // Added when the clock is at 10,000: one note is due in 2,000 frames, one is already late.
        let mut s = Synth::default();
        s.add(Batch::scheduled(&[at(12_000), at(9_000)], Preset::Keys, RATE), 10_000);
        assert_eq!((s.notes[0].wait, s.notes[1].wait), (2_000, 0));

        let mut s = Synth::default();
        s.add(Batch::scheduled(&[at(12_000)], Preset::Keys, RATE), 10_000);
        let mut out = vec![0.0; 4_096 * 2];
        s.render(&mut out, 4_096, RATE);
        let first = out.chunks(2).position(|f| f[0] != 0.0).unwrap();
        assert_eq!(first, 2_001, "silent until its frame, then the attack ramps up from zero");
    }

    #[test]
    fn progression_notes_are_stopped_apart_from_others() {
        let mut s = Synth::default();
        s.add(Batch::new(&[note(48.0, 0.0, 5.0), note(50.0, 1.0, 1.0)], Preset::Keys, RATE), 0);
        let seq = |frame| Scheduled { note: 60.0, frame, hold: 48_000, velocity: 1.0 };
        s.add(Batch::scheduled(&[seq(0), seq(24_000)], Preset::Keys, RATE), 0);
        s.drop_pending_seq();
        assert_eq!(s.notes.len(), 3, "only the progression's pending note goes");
        s.release_seq();
        let released: Vec<bool> = s.notes.iter().map(|n| n.released).collect();
        assert_eq!(released, vec![false, false, true]);
    }

    #[test]
    fn reads_note_events_from_the_frontend() {
        let e: Vec<NoteEvent> = serde_json::from_str(r#"[{"note":60,"at":0.1,"length":0.5,"velocity":0.8},{"note":64,"length":1}]"#).unwrap();
        assert_eq!(e[1].velocity, 1.0);
        assert_eq!(e[1].at, 0.0);
        let p: Preset = serde_json::from_str(r#""pluck""#).unwrap();
        assert_eq!(p, Preset::Pluck);
    }
}
