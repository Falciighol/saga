//! Offline renders of processed samples, for dragging into a DAW, exporting and saving variations.
//! Renders go to ~/Music/Saga so DAW projects that reference them by path keep working.

use crate::audio::load_stereo;
use crate::dsp::{process_offline, shape, write_wav, ProcessParams};
use std::path::{Path, PathBuf};

pub const RENDERS_DIR: &str = "Saga/Renders";
pub const VARIATIONS_DIR: &str = "Saga/Variations";

/// Renders `src` with `params` into `dest` (24-bit WAV at the file's own sample rate).
pub fn render_to(src: &Path, params: &ProcessParams, dest: &Path) -> Result<f64, String> {
    let (data, rate, channels) = load_stereo(src, None)?;
    let shaped = shape(&data, rate, params);
    let out = process_offline(&shaped, params)?;
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    write_wav(dest, &out, rate, channels == 1)?;
    Ok(out.len() as f64 / 2.0 / rate as f64)
}

/// A file name that keeps the original's name and says what changed,
/// e.g. `Bass_Loop_124_Am (128 BPM, Am, reversed).wav`.
pub fn render_name(stem: &str, label: &str) -> String {
    file_name(stem, label, "wav")
}

/// `stem (label).ext`, with the characters file systems reject replaced.
pub fn file_name(stem: &str, label: &str, ext: &str) -> String {
    let clean = |s: &str| -> String {
        s.chars()
            .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '-' } else { c })
            .collect::<String>()
            .trim()
            .to_string()
    };
    let label = clean(label);
    if label.is_empty() { format!("{}.{ext}", clean(stem)) } else { format!("{} ({label}).{ext}", clean(stem)) }
}

/// `name` split before its extension: `("x (rev)", ".wav")`.
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// `name`, then `name 2`, `name 3`… in `dir`.
fn candidates<'a>(dir: &'a Path, name: &'a str) -> impl Iterator<Item = PathBuf> + 'a {
    let (stem, ext) = split_ext(name);
    std::iter::once(dir.join(name)).chain((2..).map(move |i| dir.join(format!("{stem} {i}{ext}"))))
}

/// `name`, or `name 2`, `name 3`… whichever doesn't exist yet in `dir`.
pub fn free_path(dir: &Path, name: &str) -> PathBuf {
    candidates(dir, name).find(|p| !p.exists()).expect("some suffix is free")
}

/// Writes `bytes` to `name` in `dir`, or to `name 2`, `name 3`… when that's taken by something
/// else. A file that already holds exactly these bytes is reused, so dragging the same clip out
/// twice doesn't pile up copies, and a changed clip never overwrites one a DAW project may use.
pub fn write_once(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for p in candidates(dir, name) {
        if !p.exists() {
            std::fs::write(&p, bytes).map_err(|e| e.to_string())?;
            return Ok(p);
        }
        if std::fs::read(&p).map_err(|e| e.to_string())? == bytes {
            return Ok(p);
        }
    }
    unreachable!("candidates never run out")
}

/// Identity of a render: the source file version and the parameters that affect the audio.
pub fn render_key(src: &Path, params: &ProcessParams) -> String {
    let mtime = std::fs::metadata(src)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let p = ProcessParams { beat: None, ..params.clone() };
    format!("{}|{mtime}|{}", src.display(), serde_json::to_string(&p).unwrap_or_default())
}

/// Per-channel waveform peaks for a range of a file, for the editor's zoomable view.
pub struct Detail {
    pub samples: Vec<f32>,
    pub channels: usize,
    pub rate: u32,
    pub peak: f32,
}

pub fn load_detail(src: &Path) -> Result<Detail, String> {
    let mut samples = Vec::new();
    let mut channels = 1;
    let (info, _) = crate::decode::decode(src, Some(15.0 * 60.0), |info, s| {
        channels = info.channels.max(1);
        if channels <= 2 {
            samples.extend_from_slice(s);
        } else {
            for f in s.chunks_exact(channels) {
                samples.push(f[0]);
                samples.push(f[1]);
            }
        }
    })?;
    let channels = channels.min(2);
    let peak = samples.iter().fold(0f32, |a, &s| a.max(s.abs()));
    Ok(Detail { samples, channels, rate: info.sample_rate, peak })
}

impl Detail {
    pub fn duration(&self) -> f64 {
        self.samples.len() as f64 / self.channels as f64 / self.rate as f64
    }

    /// `buckets` peaks per channel between `start` and `end` seconds, scaled to the file's peak (0–255).
    pub fn peaks(&self, start: f64, end: f64, buckets: usize) -> Vec<Vec<u8>> {
        let frames = self.samples.len() / self.channels;
        let buckets = buckets.clamp(1, 8192);
        let a = ((start.max(0.0) * self.rate as f64) as usize).min(frames);
        let b = ((end.max(start) * self.rate as f64) as usize).clamp(a, frames);
        let span = (b - a).max(1) as f64;
        let scale = if self.peak > 0.0 { 255.0 / self.peak } else { 0.0 };
        (0..self.channels)
            .map(|c| {
                (0..buckets)
                    .map(|k| {
                        let s = a + (k as f64 * span / buckets as f64) as usize;
                        let e = (a + ((k + 1) as f64 * span / buckets as f64) as usize).max(s + 1).min(frames);
                        let mut m = 0f32;
                        for f in s..e {
                            m = m.max(self.samples[f * self.channels + c].abs());
                        }
                        (m * scale).round().min(255.0) as u8
                    })
                    .collect()
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_wav(path: &Path, seconds: f32, channels: u16) {
        let spec = hound::WavSpec { channels, sample_rate: 44_100, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for i in 0..(44_100.0 * seconds) as usize {
            let v = ((i as f32 / 44_100.0 * 220.0 * std::f32::consts::TAU).sin() * 16_000.0) as i16;
            for _ in 0..channels {
                w.write_sample(v).unwrap();
            }
        }
        w.finalize().unwrap();
    }

    #[test]
    fn renders_at_the_source_rate_and_channel_count() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("Loop_120.wav");
        write_test_wav(&src, 2.0, 1);
        let dest = dir.path().join("out/render.wav");
        let p = ProcessParams { rate: 1.25, semitones: 3.0, reverse: true, fade_out: 0.05, ..Default::default() };
        let secs = render_to(&src, &p, &dest).unwrap();
        assert!((secs - 1.6).abs() < 0.01, "{secs}");
        let r = hound::WavReader::open(&dest).unwrap();
        let spec = r.spec();
        assert_eq!((spec.sample_rate, spec.channels, spec.bits_per_sample), (44_100, 1, 24));
        assert_eq!(r.duration() as usize, (88_200.0 / 1.25) as usize);
        assert!(!dest.with_extension("wav.part").exists());
    }

    #[test]
    fn names_describe_the_change_and_never_collide() {
        assert_eq!(render_name("Bass_Loop_124_Am", "128 BPM, Am"), "Bass_Loop_124_Am (128 BPM, Am).wav");
        assert_eq!(render_name("a/b", ""), "a-b.wav");
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("x (rev).wav"), b"").unwrap();
        assert_eq!(free_path(dir.path(), "x (rev).wav"), dir.path().join("x (rev) 2.wav"));
        assert_eq!(file_name("Night drive", "124 BPM, A min", "mid"), "Night drive (124 BPM, A min).mid");
    }

    #[test]
    fn identical_files_are_reused_and_changed_ones_kept() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_once(dir.path(), "p.mid", b"one").unwrap();
        assert_eq!(a, dir.path().join("p.mid"));
        assert_eq!(write_once(dir.path(), "p.mid", b"one").unwrap(), a);
        let b = write_once(dir.path(), "p.mid", b"two").unwrap();
        assert_eq!(b, dir.path().join("p 2.mid"));
        assert_eq!(std::fs::read(&a).unwrap(), b"one");
        assert_eq!(write_once(dir.path(), "p.mid", b"two").unwrap(), b);
    }

    #[test]
    fn render_keys_ignore_the_click() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.wav");
        write_test_wav(&src, 0.1, 2);
        let a = render_key(&src, &ProcessParams { beat: Some(0.5), ..Default::default() });
        let b = render_key(&src, &ProcessParams::default());
        assert_eq!(a, b);
        assert_ne!(b, render_key(&src, &ProcessParams { reverse: true, ..Default::default() }));
    }

    #[test]
    fn detail_peaks_cover_the_requested_range() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("s.wav");
        write_test_wav(&src, 1.0, 2);
        let d = load_detail(&src).unwrap();
        assert_eq!(d.channels, 2);
        assert!((d.duration() - 1.0).abs() < 0.001);
        let p = d.peaks(0.25, 0.75, 100);
        assert_eq!((p.len(), p[0].len()), (2, 100));
        assert!(p[0].iter().all(|&v| v > 200));
    }
}
