//! The Lab's progression player: a looping pattern of notes on a beat grid kept in frames of the
//! mixer's clock. The engine thread schedules notes a little ahead of time from the grid, and the
//! mixer ticks the metronome from the same grid, so chords and click can't drift apart. While a
//! loop with a tempo is playing, the grid follows the loop's beats instead of the project tempo.

use crate::synth::{full, Preset};
use serde::{Deserialize, Serialize};

/// One note of a progression, in beats from the start of the pattern.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeqNote {
    /// MIDI note number, 60 = middle C.
    pub note: f32,
    pub start: f64,
    pub length: f64,
    /// 0–1.
    #[serde(default = "full")]
    pub velocity: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sequence {
    pub notes: Vec<SeqNote>,
    /// Length of the pattern in beats; it loops.
    pub beats: f64,
    /// Project tempo, used when no loop is playing.
    pub bpm: f64,
    pub preset: Preset,
}

/// Where the progression is, for the Lab's playhead. Sent on start, stop and every beat.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransportEvent {
    pub playing: bool,
    /// Beats since the start of the progression; negative while waiting for a loop's next bar.
    pub beat: f64,
    /// The tempo the progression is playing at (a playing loop's, or the project's).
    pub bpm: f64,
}

/// Beats as frames of the mixer's clock.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Grid {
    /// Clock frame of beat 0.
    pub origin: f64,
    pub beat_frames: f64,
}

impl Grid {
    pub fn beat_at(&self, frame: f64) -> f64 {
        (frame - self.origin) / self.beat_frames
    }

    pub fn frame_at(&self, beat: f64) -> f64 {
        self.origin + beat * self.beat_frames
    }

    /// The same grid moved by `shift` beats and running at `beat_frames`, pivoting on `now`.
    pub fn moved(&self, now: f64, shift: f64, beat_frames: f64) -> Grid {
        let beat = self.beat_at(now) + shift;
        Grid { origin: now - beat * beat_frames, beat_frames }
    }

    pub fn bpm(&self, rate: u32) -> f64 {
        60.0 * rate as f64 / self.beat_frames
    }
}

/// A playing loop's beats: where it is and how fast they go.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoopBeats {
    /// Changes whenever the loop starts over from a new position (new sample, seek, edits).
    pub serial: u64,
    /// Beats into the current pass through the loop.
    pub beat: f64,
    pub beat_frames: f64,
    /// Frames until the loop wraps back to its start; infinite for a one-pass sample.
    pub to_wrap: f64,
}

/// The grid for a progression that starts now: at `now + preroll`, or with a loop playing, on the
/// loop's next bar line (a pass through the loop always starts on one).
pub fn start_grid(now: f64, preroll: f64, beat_frames: f64, lp: Option<LoopBeats>) -> Grid {
    match lp {
        Some(l) => {
            let bar = 4.0 * (l.beat / 4.0 - 1e-6).ceil();
            let wait = ((bar - l.beat) * l.beat_frames).min(l.to_wrap).max(0.0);
            Grid { origin: now + wait, beat_frames: l.beat_frames }
        }
        None => Grid { origin: now + preroll, beat_frames },
    }
}

/// Shortest move, in beats, that puts `beat` in the same place as `target` within a `period`:
/// 1 lines up the beats, 4 lines up the bars too.
pub fn shift_to(beat: f64, target: f64, period: f64) -> f64 {
    let d = (target - beat).rem_euclid(period);
    if d >= period / 2.0 {
        d - period
    } else {
        d
    }
}

/// How the grid should change to keep following a playing loop, or the project tempo when none
/// is. `following` is the serial of the loop being followed; a new loop lines up bars as well as
/// beats. Returns the new grid, or `None` when it's already right.
pub fn follow(grid: Grid, now: f64, tempo_frames: f64, lp: Option<LoopBeats>, following: u64, tolerance: f64) -> Option<Grid> {
    let (shift, beat_frames) = match lp {
        Some(l) => {
            let period = if l.serial == following { 1.0 } else { 4.0 };
            (shift_to(grid.beat_at(now), l.beat, period), l.beat_frames)
        }
        None => (0.0, tempo_frames),
    };
    let off_beat = (shift * beat_frames).abs() > tolerance;
    let off_tempo = (grid.beat_frames - beat_frames).abs() > beat_frames * 1e-6;
    (off_beat || off_tempo).then(|| grid.moved(now, shift, beat_frames))
}

/// Notes of the pattern that start in `[from, to)` beats (never before beat 0), looping every
/// `seq.beats`, as (beat, note) in order.
pub fn due(seq: &Sequence, from: f64, to: f64) -> Vec<(f64, &SeqNote)> {
    let from = from.max(0.0);
    if seq.beats <= 0.0 || to <= from {
        return Vec::new();
    }
    let mut out = Vec::new();
    let first = (from / seq.beats).floor() as i64;
    let last = (to / seq.beats).floor() as i64;
    for pass in first..=last {
        for n in &seq.notes {
            let b = pass as f64 * seq.beats + n.start.rem_euclid(seq.beats);
            if b >= from && b < to {
                out.push((b, n));
            }
        }
    }
    out.sort_by(|a, b| a.0.total_cmp(&b.0));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seq(beats: f64, starts: &[f64]) -> Sequence {
        Sequence {
            notes: starts.iter().map(|s| SeqNote { note: 60.0, start: *s, length: 0.5, velocity: 1.0 }).collect(),
            beats,
            bpm: 120.0,
            preset: Preset::Keys,
        }
    }

    #[test]
    fn reads_a_sequence_from_the_frontend() {
        let s: Sequence = serde_json::from_str(r#"{"notes":[{"note":57,"start":0,"length":3.9},{"note":60,"start":4,"length":0.5,"velocity":0.6}],"beats":8,"bpm":124,"preset":"pad"}"#).unwrap();
        assert_eq!((s.notes.len(), s.beats, s.bpm, s.preset), (2, 8.0, 124.0, Preset::Pad));
        assert_eq!(s.notes[0].velocity, 1.0);
        let ev = serde_json::to_value(TransportEvent { playing: true, beat: -1.5, bpm: 124.0 }).unwrap();
        assert_eq!(ev, serde_json::json!({ "playing": true, "beat": -1.5, "bpm": 124.0 }));
    }

    #[test]
    fn due_notes_loop_and_stay_in_order() {
        let s = seq(4.0, &[0.0, 2.0, 3.5]);
        let beats: Vec<f64> = due(&s, 3.0, 9.0).iter().map(|d| d.0).collect();
        assert_eq!(beats, vec![3.5, 4.0, 6.0, 7.5, 8.0]);
        // Half-open, so consecutive windows never play a note twice.
        assert_eq!(due(&s, 0.0, 2.0).len() + due(&s, 2.0, 4.0).len(), 3);
        assert!(due(&s, -3.0, 0.0).is_empty(), "nothing before the progression starts");
        assert!(due(&seq(0.0, &[0.0]), 0.0, 8.0).is_empty());
    }

    #[test]
    fn shifts_take_the_short_way_round() {
        assert!((shift_to(5.3, 0.0, 4.0) - (-1.3)).abs() < 1e-9, "back to the bar line");
        assert!((shift_to(6.9, 0.0, 4.0) - 1.1).abs() < 1e-9, "on to the next one");
        assert!((shift_to(2.98, 7.0, 1.0) - 0.02).abs() < 1e-9);
        assert_eq!(shift_to(3.0, 3.0, 1.0), 0.0);
    }

    #[test]
    fn starts_now_or_on_the_loops_next_bar() {
        assert_eq!(start_grid(1000.0, 960.0, 24_000.0, None), Grid { origin: 1960.0, beat_frames: 24_000.0 });
        let lp = |beat, to_wrap| Some(LoopBeats { serial: 1, beat, beat_frames: 20_000.0, to_wrap });
        // 2.5 beats into the loop: the next bar is 1.5 beats away.
        assert_eq!(start_grid(1000.0, 960.0, 24_000.0, lp(2.5, f64::INFINITY)).origin, 31_000.0);
        // A two-beat loop wraps (and starts a bar) before that.
        assert_eq!(start_grid(1000.0, 960.0, 24_000.0, lp(1.5, 10_000.0)).origin, 11_000.0);
        // Right on a bar line: start now.
        assert_eq!(start_grid(1000.0, 960.0, 24_000.0, lp(4.0, f64::INFINITY)).origin, 1000.0);
    }

    #[test]
    fn follows_the_project_tempo_keeping_its_place() {
        let g = Grid { origin: 0.0, beat_frames: 24_000.0 };
        assert_eq!(follow(g, 60_000.0, 24_000.0, None, 0, 96.0), None);
        let faster = follow(g, 60_000.0, 20_000.0, None, 0, 96.0).unwrap();
        assert!((faster.beat_at(60_000.0) - 2.5).abs() < 1e-9, "same beat at the change");
        assert!((faster.beat_at(80_000.0) - 3.5).abs() < 1e-9, "then at the new tempo");
    }

    #[test]
    fn locks_onto_a_playing_loop() {
        let g = Grid { origin: 0.0, beat_frames: 24_000.0 };
        let now = 5.3 * 24_000.0;
        // A new loop at a slower tempo, just starting: bars line up with it.
        let lp = LoopBeats { serial: 7, beat: 0.0, beat_frames: 25_000.0, to_wrap: 400_000.0 };
        let locked = follow(g, now, 24_000.0, Some(lp), 0, 96.0).unwrap();
        assert!((locked.beat_at(now) - 4.0).abs() < 1e-9);
        assert_eq!(locked.beat_frames, 25_000.0);
        // Once followed, only the beat phase is kept, so a loop shorter than a bar doesn't pull
        // the progression back to bar 1 each time it wraps.
        let lp = LoopBeats { serial: 7, beat: 0.0, ..lp };
        let later = locked.frame_at(6.0);
        assert_eq!(follow(locked, later, 24_000.0, Some(lp), 7, 96.0), None);
        // Drifted by 10 ms: pulled back.
        let drifted = Grid { origin: locked.origin + 480.0, ..locked };
        let fixed = follow(drifted, later, 24_000.0, Some(lp), 7, 96.0).unwrap();
        assert!((fixed.beat_at(later) - 6.0).abs() < 1e-9);
    }
}
