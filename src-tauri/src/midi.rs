//! Standard MIDI files for the Lab: a progression becomes a one-track clip you can drag into a DAW.

use crate::sequence::SeqNote;

/// Ticks per beat.
pub const PPQ: u16 = 480;

/// A type-0 file: the track name, the tempo, 4/4, then the notes on channel 1. The track ends
/// exactly `beats` in, so the clip loops cleanly; notes are cut off there.
pub fn write_midi(notes: &[SeqNote], beats: f64, bpm: f64, name: &str) -> Vec<u8> {
    let tick = |b: f64| (b.max(0.0) * PPQ as f64).round() as u32;
    let end = tick(beats);
    // (tick, note-offs first so a repeated note isn't cut short, message)
    let mut events: Vec<(u32, u8, [u8; 3])> = Vec::with_capacity(notes.len() * 2);
    for n in notes {
        let on = tick(n.start);
        if on >= end {
            continue;
        }
        let off = tick(n.start + n.length).clamp(on + 1, end);
        let key = n.note.round().clamp(0.0, 127.0) as u8;
        let vel = (n.velocity * 127.0).round().clamp(1.0, 127.0) as u8;
        events.push((on, 1, [0x90, key, vel]));
        events.push((off, 0, [0x80, key, 0]));
    }
    events.sort_by_key(|e| (e.0, e.1));

    let mut track = Vec::new();
    let name = name.as_bytes();
    meta(&mut track, 0x03, &name[..name.len().min(127)]);
    let tempo = (60_000_000.0 / bpm.clamp(20.0, 400.0)).round() as u32;
    meta(&mut track, 0x51, &tempo.to_be_bytes()[1..]);
    meta(&mut track, 0x58, &[4, 2, 24, 8]);
    let mut last = 0;
    for (t, _, msg) in events {
        vlq(&mut track, t - last);
        track.extend_from_slice(&msg);
        last = t;
    }
    vlq(&mut track, end.saturating_sub(last));
    track.extend_from_slice(&[0xFF, 0x2F, 0x00]);

    let mut out = Vec::with_capacity(22 + track.len());
    out.extend_from_slice(b"MThd");
    out.extend_from_slice(&6u32.to_be_bytes());
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes());
    out.extend_from_slice(&PPQ.to_be_bytes());
    out.extend_from_slice(b"MTrk");
    out.extend_from_slice(&(track.len() as u32).to_be_bytes());
    out.extend_from_slice(&track);
    out
}

/// A meta event at delta time 0 (the lengths here are all under 128, so one byte).
fn meta(track: &mut Vec<u8>, kind: u8, data: &[u8]) {
    track.extend_from_slice(&[0x00, 0xFF, kind, data.len() as u8]);
    track.extend_from_slice(data);
}

/// MIDI's variable-length quantity: seven bits per byte, most significant first.
fn vlq(out: &mut Vec<u8>, mut v: u32) {
    let mut bytes = [0u8; 5];
    let mut i = 4;
    bytes[i] = (v & 0x7F) as u8;
    v >>= 7;
    while v > 0 {
        i -= 1;
        bytes[i] = (v & 0x7F) as u8 | 0x80;
        v >>= 7;
    }
    out.extend_from_slice(&bytes[i..]);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(note: f32, start: f64, length: f64) -> SeqNote {
        SeqNote { note, start, length, velocity: 0.8 }
    }

    fn read_vlq(data: &[u8], i: &mut usize) -> u32 {
        let mut v = 0;
        loop {
            let b = data[*i];
            *i += 1;
            v = (v << 7) | (b & 0x7F) as u32;
            if b & 0x80 == 0 {
                return v;
            }
        }
    }

    /// (absolute tick, status, data) for every event in the file's one track.
    fn parse(file: &[u8]) -> Vec<(u32, u8, Vec<u8>)> {
        assert_eq!(&file[..4], b"MThd");
        assert_eq!(&file[8..14], &[0, 0, 0, 1, 1, 224], "format 0, one track, 480 ticks a beat");
        assert_eq!(&file[14..18], b"MTrk");
        let len = u32::from_be_bytes(file[18..22].try_into().unwrap()) as usize;
        let track = &file[22..];
        assert_eq!(track.len(), len);
        let (mut i, mut t, mut out) = (0, 0, Vec::new());
        while i < track.len() {
            t += read_vlq(track, &mut i);
            let status = track[i];
            i += 1;
            if status == 0xFF {
                let kind = track[i];
                let n = track[i + 1] as usize;
                out.push((t, kind, track[i + 2..i + 2 + n].to_vec()));
                i += 2 + n;
            } else {
                out.push((t, status, track[i..i + 2].to_vec()));
                i += 2;
            }
        }
        out
    }

    #[test]
    fn variable_length_quantities() {
        for (v, want) in [(0, vec![0x00]), (127, vec![0x7F]), (128, vec![0x81, 0x00]), (0x3FFF, vec![0xFF, 0x7F]), (0x4000, vec![0x81, 0x80, 0x00])] {
            let mut out = Vec::new();
            vlq(&mut out, v);
            assert_eq!(out, want, "{v}");
            assert_eq!(read_vlq(&out, &mut 0), v);
        }
    }

    #[test]
    fn writes_a_clip_that_loops_on_the_bar() {
        // A two-bar sketch: a held chord, then a stab of the same note at the bar line.
        let notes = [note(60.0, 0.0, 4.0), note(64.0, 0.0, 3.9), note(60.0, 4.0, 0.5), note(67.0, 7.5, 2.0)];
        let ev = parse(&write_midi(&notes, 8.0, 124.0, "Night drive"));
        assert_eq!(ev[0], (0, 0x03, b"Night drive".to_vec()));
        // 60,000,000 / 124 µs per beat.
        assert_eq!(ev[1], (0, 0x51, vec![0x07, 0x62, 0x1F]));
        assert_eq!(ev[2], (0, 0x58, vec![4, 2, 24, 8]));
        let notes: Vec<_> = ev.iter().filter(|e| matches!(e.1 & 0xF0, 0x80 | 0x90)).cloned().collect();
        assert_eq!(
            notes,
            vec![
                (0, 0x90, vec![60, 102]),
                (0, 0x90, vec![64, 102]),
                (1872, 0x80, vec![64, 0]),
                // The held note ends before the same note starts again.
                (1920, 0x80, vec![60, 0]),
                (1920, 0x90, vec![60, 102]),
                (2160, 0x80, vec![60, 0]),
                (3600, 0x90, vec![67, 102]),
                // Cut off at the end of the clip.
                (3840, 0x80, vec![67, 0]),
            ]
        );
        assert_eq!(ev.last().unwrap(), &(3840, 0x2F, vec![]));
    }

    #[test]
    fn an_empty_clip_still_has_its_length() {
        let ev = parse(&write_midi(&[], 16.0, 90.0, ""));
        assert_eq!(ev.last().unwrap(), &(16 * 480, 0x2F, vec![]));
    }
}
