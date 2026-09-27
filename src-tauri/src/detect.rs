//! Tempo and key from the audio, for samples whose names and embedded tags don't say.
//! Detected values are stored with their own source so the UI can mark them as estimates.

use crate::features::Sound;
use crate::keys::{Key, Mode};
use crate::meta::{Kind, NameMeta, Resolved, Source};

/// Loops of these categories never get a key from the audio.
const UNPITCHED_LOOPS: &[&str] = &["Kick", "Snare", "Clap", "Hat", "Perc", "Drums", "FX"];
/// One-shots of these categories never get a root note from the audio (kicks do: 808s are tuned).
const UNPITCHED_SHOTS: &[&str] = &["Snare", "Clap", "Hat", "Perc", "Drums", "FX"];

// Thresholds and priors below were tuned on ~900 loops from real sample packs whose names
// state their tempo and key (see `report`): tempo comes out right for 80% of them (another
// 8% at half or double time); keys that pass the fit threshold are the tagged key or its
// relative 67% of the time, and a harmonically compatible one 81% of the time.

/// Normalized autocorrelation at the beat period needed before a tempo is trusted.
const MIN_PULSE: f64 = 0.15;
/// A tempo that makes the file a whole number of bars wins unless the best free reading
/// is this much more convincing.
const BAR_FIT_RATIO: f64 = 0.3;
/// Correlation with the best key profile needed before a key is trusted.
const MIN_KEY_FIT: f32 = 0.75;
/// A root note needs a steady, clearly periodic pitch.
const MIN_PITCH_CLARITY: f32 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tempo {
    pub bpm: f64,
    /// Normalized onset autocorrelation at the beat period.
    pub pulse: f64,
}

/// Onset autocorrelation, normalized so lag 0 is 1.
struct Periodicity {
    r: Vec<f64>,
    frame_rate: f64,
}

impl Periodicity {
    fn new(onset: &[f32], frame_rate: f64) -> Option<Periodicity> {
        let n = onset.len();
        // Onsets against the local level, so slow swells don't read as a beat.
        let half = ((frame_rate * 0.15) as usize).max(1);
        let mut prefix = vec![0f64; n + 1];
        for (i, v) in onset.iter().enumerate() {
            prefix[i + 1] = prefix[i] + *v as f64;
        }
        let mut e: Vec<f64> = (0..n)
            .map(|i| {
                let (a, b) = (i.saturating_sub(half), (i + half + 1).min(n));
                (onset[i] as f64 - (prefix[b] - prefix[a]) / (b - a) as f64).max(0.0)
            })
            .collect();
        let mean = e.iter().sum::<f64>() / n.max(1) as f64;
        e.iter_mut().for_each(|v| *v -= mean);
        // Up to a 30 BPM beat, and never more than half the signal.
        let max_lag = (n / 2).min((frame_rate * 2.0) as usize);
        if max_lag < (frame_rate * 60.0 / 200.0) as usize + 2 {
            return None;
        }
        let mut r: Vec<f64> = (0..=max_lag).map(|l| e[..n - l].iter().zip(&e[l..]).map(|(a, b)| a * b).sum::<f64>() / (n - l) as f64).collect();
        let r0 = r[0];
        if r0 <= 1e-12 {
            return None;
        }
        r.iter_mut().for_each(|v| *v /= r0);
        Some(Periodicity { r, frame_rate })
    }

    fn at(&self, lag: f64) -> Option<f64> {
        if lag < 1.0 || lag >= (self.r.len() - 1) as f64 {
            return None;
        }
        let i = lag.floor() as usize;
        let f = lag - i as f64;
        Some(self.r[i] * (1.0 - f) + self.r[i + 1] * f)
    }

    /// How strongly the onsets repeat at this tempo (and at two beats, when that fits).
    fn score(&self, bpm: f64) -> Option<f64> {
        let lag = self.frame_rate * 60.0 / bpm;
        let one = self.at(lag)?;
        Some(match self.at(2.0 * lag) {
            Some(two) => (one + 0.5 * two) / 1.5,
            None => one,
        })
    }
}

/// Sample packs label loops between about 95 and 185 BPM, so a beat that reads as either
/// 80 or 160 is far more likely called 160.
fn prior(bpm: f64) -> f64 {
    const LOW: f64 = 95.0;
    const HIGH: f64 = 185.0;
    let octaves = if bpm < LOW { (LOW / bpm).log2() } else if bpm > HIGH { (bpm / HIGH).log2() } else { 0.0 };
    (-0.5 * (octaves / 0.25).powi(2)).exp()
}

pub fn tempo(s: &Sound, duration: f64) -> Option<Tempo> {
    let fr = s.frame_rate as f64;
    if duration < 1.5 || (s.onset.len() as f64) < fr * 1.5 {
        return None;
    }
    let p = Periodicity::new(&s.onset, fr)?;
    let mut best = (0.0, 0.0);
    let mut bpm = 60.0;
    while bpm <= 200.0 {
        if let Some(v) = p.score(bpm) {
            let v = v * prior(bpm);
            if v > best.1 {
                best = (bpm, v);
            }
        }
        bpm += 0.25;
    }
    // How rhythmic the sound is at all: the beat, or half or twice it.
    let pulse = [best.0, best.0 / 2.0, best.0 * 2.0].iter().filter_map(|b| p.at(fr * 60.0 / b)).fold(f64::MIN, f64::max);
    if best.1 <= 0.0 || pulse < MIN_PULSE {
        return None;
    }
    // Loops are usually cut to whole bars, so their length gives the exact tempo.
    let mut bar_fit: Option<(f64, f64)> = None;
    for (bars, weight) in [(1, 1.0), (2, 1.0), (4, 1.0), (8, 1.0), (16, 1.0), (32, 1.0), (3, 0.9), (6, 0.9), (12, 0.9), (24, 0.9), (5, 0.8)] {
        let b = 240.0 * bars as f64 / duration;
        if !(60.0..=200.0).contains(&b) {
            continue;
        }
        if let Some(v) = p.score(b) {
            let v = v * prior(b) * weight;
            if bar_fit.is_none_or(|(_, bv)| v > bv) {
                bar_fit = Some((b, v));
            }
        }
    }
    let bpm = match bar_fit {
        Some((b, v)) if v >= BAR_FIT_RATIO * best.1 => {
            let b = (b * 100.0).round() / 100.0;
            if (b - b.round()).abs() < 0.06 { b.round() } else { b }
        }
        _ => best.0.round(),
    };
    Some(Tempo { bpm, pulse })
}

/// Key profiles: the scale, with the tonic and fifth (and the minor third) weighted up.
/// On loops these beat the classical Krumhansl–Kessler and Temperley profiles.
const MAJOR: [f32; 12] = [2.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.5, 0.0, 1.0, 0.0, 1.0];
const MINOR: [f32; 12] = [2.0, 0.0, 1.0, 1.5, 0.0, 1.0, 0.0, 1.5, 1.0, 0.0, 1.0, 0.0];

fn pearson(a: &[f32; 12], b: impl Fn(usize) -> f32) -> f32 {
    let ma = a.iter().sum::<f32>() / 12.0;
    let mb = (0..12).map(&b).sum::<f32>() / 12.0;
    let (mut num, mut da, mut db) = (0f32, 0f32, 0f32);
    for (i, av) in a.iter().enumerate() {
        let (x, y) = (av - ma, b(i) - mb);
        num += x * y;
        da += x * x;
        db += y * y;
    }
    if da <= 0.0 || db <= 0.0 { 0.0 } else { num / (da * db).sqrt() }
}

/// The best-fitting major or minor key and how well it fits (Pearson r).
pub fn key(s: &Sound) -> Option<(Key, f32)> {
    let chroma = s.key_chroma();
    if chroma.iter().sum::<f32>() <= 0.0 {
        return None;
    }
    let mut best: Option<(Key, f32)> = None;
    for pc in 0..12 {
        for (mode, profile) in [(Mode::Major, &MAJOR), (Mode::Minor, &MINOR)] {
            let r = pearson(&chroma, |i| profile[(i + 12 - pc) % 12]);
            if best.is_none_or(|(_, b)| r > b) {
                best = Some((Key::new(pc as i32, mode), r));
            }
        }
    }
    best.filter(|(_, r)| *r >= MIN_KEY_FIT)
}

/// Pitch class of a clearly pitched sound.
pub fn note(s: &Sound) -> Option<u8> {
    let p = s.pitch.filter(|p| p.clarity >= MIN_PITCH_CLARITY)?;
    let midi = (69.0 + 12.0 * (p.hz / 440.0).log2()).round() as i32;
    Some(midi.rem_euclid(12) as u8)
}

/// Fills in tempo and key the name and tags didn't give.
pub fn apply(r: &mut Resolved, name: &NameMeta, s: &Sound, duration: f64) {
    if r.kind == Kind::Loop && r.bpm.is_none() {
        if let Some(t) = tempo(s, duration) {
            // A bare number in the name that the audio agrees with was the tempo after all.
            if let Some(&c) = name.bpm_candidates.iter().find(|c| (**c / t.bpm - 1.0).abs() < 0.03) {
                r.bpm = Some(c);
                r.bpm_source = Source::Name;
            } else {
                r.bpm = Some(t.bpm);
                r.bpm_source = Source::Audio;
            }
        }
    }
    if r.key.is_none() {
        let category = r.category.unwrap_or("");
        let found = match r.kind {
            Kind::Loop if !UNPITCHED_LOOPS.contains(&category) => key(s).map(|(k, _)| k),
            Kind::OneShot if !UNPITCHED_SHOTS.contains(&category) => note(s).map(|pc| Key::new(pc as i32, Mode::Note)),
            _ => None,
        };
        if let Some(k) = found {
            r.key = Some(k);
            r.key_source = Source::Audio;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::describe;
    use crate::features::tests::{noise_burst, tone, SR};
    use crate::meta::parse_name;

    /// A drum pattern: kick on every beat, hats on the off-beats, for `bars` bars.
    fn beat(bpm: f64, bars: usize) -> Vec<f32> {
        let beat = (SR as f64 * 60.0 / bpm) as usize;
        let len = beat * 4 * bars;
        let mut x = vec![0f32; len];
        let kick = tone(&[55.0], 0.25, 18.0);
        let hat = noise_burst(0.06, 60.0, 7);
        for b in 0..4 * bars {
            for (i, v) in kick.iter().enumerate() {
                if let Some(s) = x.get_mut(b * beat + i) {
                    *s += v;
                }
            }
            for (i, v) in hat.iter().enumerate() {
                if let Some(s) = x.get_mut(b * beat + beat / 2 + i) {
                    *s += v * 0.6;
                }
            }
        }
        x
    }

    fn tempo_of(x: &[f32]) -> Option<f64> {
        tempo(&describe(x, SR).unwrap(), x.len() as f64 / SR as f64).map(|t| t.bpm)
    }

    #[test]
    fn finds_the_tempo_of_bar_length_loops() {
        assert_eq!(tempo_of(&beat(124.0, 4)), Some(124.0));
        assert_eq!(tempo_of(&beat(90.0, 2)), Some(90.0));
        assert_eq!(tempo_of(&beat(140.0, 8)), Some(140.0));
    }

    #[test]
    fn estimates_the_tempo_of_loops_with_a_tail() {
        let mut x = beat(128.0, 4);
        x.extend(vec![0.0; SR as usize / 3]);
        let bpm = tempo_of(&x).unwrap();
        assert!((bpm - 128.0).abs() <= 1.0, "{bpm}");
    }

    #[test]
    fn a_drone_has_no_tempo() {
        let pad = tone(&[220.0, 277.2, 329.6], 6.0, 0.05);
        assert_eq!(tempo_of(&pad), None);
    }

    fn chord(notes: &[f32], seconds: f32) -> Vec<f32> {
        let freqs: Vec<f32> = notes.iter().map(|m| 440.0 * 2f32.powf((m - 69.0) / 12.0)).collect();
        tone(&freqs, seconds, 0.3)
    }

    #[test]
    fn finds_major_and_minor_keys() {
        // I–IV–V–I in C major.
        let mut x = chord(&[48.0, 60.0, 64.0, 67.0], 1.0);
        x.extend(chord(&[53.0, 60.0, 65.0, 69.0], 1.0));
        x.extend(chord(&[55.0, 62.0, 67.0, 71.0], 1.0));
        x.extend(chord(&[48.0, 60.0, 64.0, 67.0], 1.0));
        let (k, _) = key(&describe(&x, SR).unwrap()).unwrap();
        assert_eq!(k.name(), "C");

        // i–iv–V–i in A minor.
        let mut x = chord(&[45.0, 57.0, 60.0, 64.0], 1.0);
        x.extend(chord(&[50.0, 57.0, 62.0, 65.0], 1.0));
        x.extend(chord(&[52.0, 56.0, 59.0, 64.0], 1.0));
        x.extend(chord(&[45.0, 57.0, 60.0, 64.0], 1.5));
        let (k, _) = key(&describe(&x, SR).unwrap()).unwrap();
        assert_eq!(k.name(), "Am");
    }

    #[test]
    fn noise_has_no_key() {
        assert!(key(&describe(&noise_burst(3.0, 0.2, 3), SR).unwrap()).is_none());
    }

    #[test]
    fn fills_only_what_the_name_left_out() {
        let x = beat(124.0, 4);
        let s = describe(&x, SR).unwrap();
        let d = x.len() as f64 / SR as f64;

        let name = parse_name("Groove_Loop", &[]);
        let mut r = crate::meta::resolve(&name, &Default::default(), Some(d));
        apply(&mut r, &name, &s, d);
        assert_eq!((r.bpm, r.bpm_source), (Some(124.0), Source::Audio));

        // Tagged tempos are never replaced.
        let name = parse_name("Groove_Loop_120bpm", &[]);
        let mut r = crate::meta::resolve(&name, &Default::default(), Some(d));
        apply(&mut r, &name, &s, d);
        assert_eq!((r.bpm, r.bpm_source), (Some(120.0), Source::Name));

        // A number that didn't fit the length is confirmed by the audio.
        let mut padded = x.clone();
        padded.extend(vec![0.0; SR as usize / 2]);
        let s2 = describe(&padded, SR).unwrap();
        let d2 = padded.len() as f64 / SR as f64;
        let name = parse_name("Groove_Take_2_124", &[]);
        let mut r = crate::meta::resolve(&name, &Default::default(), Some(d2));
        assert_eq!((r.kind, r.bpm), (Kind::Loop, None));
        apply(&mut r, &name, &s2, d2);
        assert_eq!((r.bpm, r.bpm_source), (Some(124.0), Source::Name));

        // Drum categories don't get keys; pitched one-shots get a root note.
        let name = parse_name("Hat_Loop", &[]);
        let mut r = crate::meta::resolve(&name, &Default::default(), Some(d));
        apply(&mut r, &name, &s, d);
        assert!(r.key.is_none());

        let bass = tone(&[110.0], 1.2, 2.0);
        let name = parse_name("Bass_Shot_Reese", &[]);
        let mut r = crate::meta::resolve(&name, &Default::default(), Some(1.2));
        apply(&mut r, &name, &describe(&bass, SR).unwrap(), 1.2);
        assert_eq!(r.key.map(|k| (k.name(), k.mode)), Some(("A", Mode::Note)));
        assert_eq!(r.key_source, Source::Audio);
    }
}

/// Detection accuracy on a real library, using samples whose names already say their tempo
/// and key as the answer key (read-only):
/// `SAGA_SCAN_DIR=/path cargo test --release --lib detect::report -- --ignored --nocapture`
#[cfg(test)]
mod report {
    use super::*;
    use crate::chunks::ChunkMeta;
    use crate::meta::{parse_name, resolve};
    use std::collections::BTreeMap;

    #[test]
    #[ignore]
    fn detection_report() {
        let Ok(root) = std::env::var("SAGA_SCAN_DIR") else { return };
        let root = std::path::PathBuf::from(root);
        let per_kind: usize = std::env::var("SAGA_REPORT_FILES").ok().and_then(|v| v.parse().ok()).unwrap_or(300);
        let files: Vec<_> = walkdir::WalkDir::new(&root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file() && crate::decode::is_audio_path(e.path()))
            .map(|e| e.into_path())
            .collect();
        let named = |p: &std::path::Path| {
            let stem = p.file_stem().unwrap().to_string_lossy().to_string();
            let rel = p.parent().unwrap().strip_prefix(&root).unwrap().to_string_lossy().to_string();
            let dirs: Vec<String> = rel.split('/').filter(|s| !s.is_empty()).map(String::from).collect();
            let refs: Vec<&str> = dirs.iter().map(|s| s.as_str()).collect();
            parse_name(&stem, &refs)
        };
        let tempo_files: Vec<_> = files.iter().filter(|p| { let m = named(p); m.kind_hint == Some(Kind::Loop) && m.bpm_explicit.is_some() }).collect();
        let key_files: Vec<_> = files.iter().filter(|p| { let m = named(p); m.kind_hint == Some(Kind::Loop) && m.key.is_some_and(|k| k.mode != Mode::Note) }).collect();
        let note_files: Vec<_> = files.iter().filter(|p| { let m = named(p); m.kind_hint == Some(Kind::OneShot) && m.key.is_some() }).collect();
        println!("candidates: {} with tempo, {} loops with key, {} one-shots with a note", tempo_files.len(), key_files.len(), note_files.len());
        let spread = |v: &[&std::path::PathBuf]| -> Vec<std::path::PathBuf> { v.iter().step_by((v.len() / per_kind).max(1)).map(|p| (*p).clone()).collect() };

        let start = std::time::Instant::now();
        let mut analyzed = 0usize;
        let mut tempo: BTreeMap<&str, usize> = BTreeMap::new();
        let mut misses = Vec::new();
        for p in spread(&tempo_files) {
            let want = named(&p).bpm_explicit.unwrap();
            let Ok(info) = crate::analysis::analyze(&p) else { continue };
            analyzed += 1;
            let got = info.sound.as_ref().and_then(|s| super::tempo(s, info.duration));
            let verdict = match got {
                None => "none",
                Some(t) if (t.bpm / want - 1.0).abs() < 0.015 => "right",
                Some(t) if (t.bpm / want / 2.0 - 1.0).abs() < 0.015 || (t.bpm * 2.0 / want - 1.0).abs() < 0.015 => "half/double",
                Some(_) => "wrong",
            };
            *tempo.entry(verdict).or_default() += 1;
            if verdict == "wrong" && misses.len() < 12 {
                misses.push(format!("  {:>6.1} for {want:>6.1} (pulse {:.2}, {:.1} s)  {}", got.unwrap().bpm, got.unwrap().pulse, info.duration, p.file_name().unwrap().to_string_lossy()));
            }
        }
        println!("tempo: {tempo:?}");
        misses.iter().for_each(|m| println!("{m}"));

        let mut keys: BTreeMap<&str, usize> = BTreeMap::new();
        let mut fits: Vec<(f32, bool)> = Vec::new();
        for p in spread(&key_files) {
            let want = named(&p).key.unwrap();
            let Ok(info) = crate::analysis::analyze(&p) else { continue };
            analyzed += 1;
            let Some(s) = info.sound.as_ref() else { continue };
            // Evaluate without the threshold, then see where a threshold would land.
            let raw = {
                let mut best: Option<(Key, f32)> = None;
                for pc in 0..12 {
                    for (mode, profile) in [(Mode::Major, &MAJOR), (Mode::Minor, &MINOR)] {
                        let r = pearson(&s.key_chroma(), |i| profile[(i + 12 - pc) % 12]);
                        if best.is_none_or(|(_, b)| r > b) {
                            best = Some((Key::new(pc as i32, mode), r));
                        }
                    }
                }
                best
            };
            let Some((got, r)) = raw else {
                *keys.entry("none").or_default() += 1;
                continue;
            };
            let relative = |a: Key, b: Key| a.mode != b.mode && (if a.mode == Mode::Minor { a.pc as i32 + 3 } else { a.pc as i32 - 3 }).rem_euclid(12) == b.pc as i32;
            let verdict = if got == want {
                "right"
            } else if relative(got, want) {
                "relative"
            } else if got.mode == want.mode && ((got.pc as i32 - want.pc as i32).rem_euclid(12) == 7 || (got.pc as i32 - want.pc as i32).rem_euclid(12) == 5) {
                "fifth"
            } else if got.pc == want.pc {
                "parallel"
            } else {
                "wrong"
            };
            fits.push((r, verdict == "right" || verdict == "relative"));
            *keys.entry(verdict).or_default() += 1;
        }
        println!("keys (no threshold): {keys:?}");
        for t in [0.5, 0.6, 0.7, 0.75, 0.8] {
            let kept: Vec<_> = fits.iter().filter(|(r, _)| *r >= t).collect();
            let ok = kept.iter().filter(|(_, good)| *good).count();
            println!("  fit >= {t}: keeps {}/{}, right or relative {:.0}%", kept.len(), fits.len(), 100.0 * ok as f64 / kept.len().max(1) as f64);
        }

        let mut notes: BTreeMap<&str, usize> = BTreeMap::new();
        for p in spread(&note_files) {
            let m = named(&p);
            let want = m.key.unwrap();
            let r = resolve(&m, &ChunkMeta::default(), None);
            if r.category.is_some_and(|c| UNPITCHED_SHOTS.contains(&c)) {
                continue;
            }
            let Ok(info) = crate::analysis::analyze(&p) else { continue };
            analyzed += 1;
            let got = info.sound.as_ref().and_then(note);
            let verdict = match got {
                None => "none",
                Some(pc) if pc == want.pc => "right",
                Some(pc) if (pc as i32 - want.pc as i32).rem_euclid(12) == 7 || (pc as i32 - want.pc as i32).rem_euclid(12) == 5 => "fifth",
                Some(_) => "wrong",
            };
            *notes.entry(verdict).or_default() += 1;
        }
        println!("notes: {notes:?}");
        let took = start.elapsed();
        println!("analyzed {analyzed} files in {took:.2?} ({:.1} ms/file)", took.as_secs_f64() * 1000.0 / analyzed.max(1) as f64);
    }

    /// Where `keys::MIN_SCALE_FIT` comes from: how the stored pitch profile of loops whose names
    /// state a key fits that key's scale, against keys far from it, and how often drums and
    /// effects (no notes to speak of) would pass as fitting. Set `SAGA_DUMP` to also write every
    /// profile as JSON for a closer look (the Lab's key finder ranking was checked on that).
    /// `SAGA_SCAN_DIR=/path cargo test --release --lib detect::report::scale_fit_report -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn scale_fit_report() {
        use crate::keys::{pc_mask, scale_fit, MIN_SCALE_FIT};
        let Ok(root) = std::env::var("SAGA_SCAN_DIR") else { return };
        let root = std::path::PathBuf::from(root);
        let per_kind: usize = std::env::var("SAGA_REPORT_FILES").ok().and_then(|v| v.parse().ok()).unwrap_or(300);
        let files: Vec<_> = walkdir::WalkDir::new(&root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file() && crate::decode::is_audio_path(e.path()))
            .map(|e| e.into_path())
            .collect();
        let resolved = |p: &std::path::Path| {
            let stem = p.file_stem().unwrap().to_string_lossy().to_string();
            let rel = p.parent().unwrap().strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
            let dirs: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
            let m = parse_name(&stem, &dirs);
            let r = resolve(&m, &ChunkMeta::default(), None);
            (m, r)
        };
        let keyed: Vec<_> = files.iter().filter(|p| { let (m, _) = resolved(p); m.kind_hint == Some(Kind::Loop) && m.key.is_some_and(|k| k.mode != Mode::Note) }).collect();
        let unpitched: Vec<_> = files
            .iter()
            .filter(|p| {
                let (m, r) = resolved(p);
                m.key.is_none() && r.category.is_some_and(|c| UNPITCHED_SHOTS.contains(&c) || UNPITCHED_LOOPS.contains(&c))
            })
            .collect();
        println!("candidates: {} loops with a key, {} drums and effects", keyed.len(), unpitched.len());
        let spread = |v: &[&std::path::PathBuf]| -> Vec<std::path::PathBuf> { v.iter().step_by((v.len() / per_kind).max(1)).map(|p| (*p).clone()).collect() };

        let mask = |k: Key| pc_mask(&k.scale());
        let mut dump = Vec::new();
        let (mut own, mut far, mut near) = (Vec::new(), Vec::new(), Vec::new());
        for p in spread(&keyed) {
            let (m, r) = resolved(&p);
            let k = m.key.unwrap();
            let Ok(info) = crate::analysis::analyze(&p) else { continue };
            let Some(s) = info.sound.as_ref() else { continue };
            let Some(fit) = scale_fit(&s.chroma, mask(k)) else { continue };
            own.push(fit);
            // A tritone away shares two notes; a fifth away shares six.
            far.push(scale_fit(&s.chroma, mask(Key::new(k.pc as i32 + 6, k.mode))).unwrap());
            near.push(scale_fit(&s.chroma, mask(Key::new(k.pc as i32 + 7, k.mode))).unwrap());
            dump.push(serde_json::json!({ "name": p.file_name().unwrap().to_string_lossy(), "kind": "loop", "category": r.category, "pc": k.pc, "mode": k.mode as u8, "chroma": s.chroma, "tonality": s.tonality }));
        }
        let mut drums = Vec::new();
        for (i, p) in spread(&unpitched).into_iter().enumerate() {
            let (m, r) = resolved(&p);
            let Ok(info) = crate::analysis::analyze(&p) else { continue };
            let Some(s) = info.sound.as_ref() else { continue };
            // Against a different key each time, as a keyless sample would meet any filter.
            let Some(fit) = scale_fit(&s.chroma, mask(Key::new(i as i32 * 5, if i % 2 == 0 { Mode::Minor } else { Mode::Major }))) else { continue };
            drums.push(fit);
            dump.push(serde_json::json!({ "name": p.file_name().unwrap().to_string_lossy(), "kind": format!("{:?}", m.kind_hint), "category": r.category, "pc": null, "mode": null, "chroma": s.chroma, "tonality": s.tonality }));
        }
        let quantiles = |v: &mut Vec<f32>| -> String {
            v.sort_by(|a, b| a.total_cmp(b));
            [0.1, 0.25, 0.5, 0.75, 0.9].iter().map(|q| format!("{:.2}", v.get(((v.len() as f32 - 1.0) * q) as usize).copied().unwrap_or(f32::NAN))).collect::<Vec<_>>().join(" ")
        };
        println!("fit quantiles (10 25 50 75 90%):");
        println!("  own key      {}", quantiles(&mut own));
        println!("  a fifth away {}", quantiles(&mut near));
        println!("  tritone away {}", quantiles(&mut far));
        println!("  drums & fx   {}", quantiles(&mut drums));
        for t in [0.1, 0.15, 0.2, 0.25, 0.3, 0.4] {
            let pass = |v: &[f32]| 100.0 * v.iter().filter(|f| **f >= t).count() as f32 / v.len().max(1) as f32;
            let mark = if (t - MIN_SCALE_FIT).abs() < 1e-6 { " <- MIN_SCALE_FIT" } else { "" };
            println!("  fit >= {t}: own {:.0}%, fifth {:.0}%, tritone {:.0}%, drums {:.0}%{mark}", pass(&own), pass(&near), pass(&far), pass(&drums));
        }
        if let Ok(out) = std::env::var("SAGA_DUMP") {
            std::fs::write(out, serde_json::to_string(&dump).unwrap()).unwrap();
        }
    }
}
