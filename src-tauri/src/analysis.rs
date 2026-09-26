//! Per-file analysis: duration, format details, waveform peaks, loudness, and a description
//! of the sound for detection and similarity, all from one decode.

use crate::decode::decode;
use crate::features::{Collector, Sound};
use ebur128::{EbuR128, Mode as EbuMode};
use std::path::Path;

pub const PEAK_BUCKETS: usize = 512;
/// Bumped when analysis learns something new, so already-indexed files get analyzed again.
/// 2: sound descriptors, and tempo and key from the audio.
pub const VERSION: i64 = 2;
/// Files longer than this are summarized from their first 20 minutes only.
const MAX_ANALYZE_SECONDS: f64 = 20.0 * 60.0;

#[derive(Debug, Clone)]
pub struct AudioInfo {
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub bit_depth: Option<u16>,
    /// Waveform envelope: per-bucket peak relative to the file's loudest sample, 0–255.
    pub peaks: Vec<u8>,
    pub peak_db: Option<f64>,
    /// Integrated loudness in LUFS (needs at least 400 ms of audio).
    pub loudness: Option<f64>,
    /// None for silent files.
    pub sound: Option<Sound>,
}

pub fn analyze(path: &Path) -> Result<AudioInfo, String> {
    let mut blocks: Vec<f32> = Vec::new();
    let mut block_size = 0usize;
    let mut cur_max = 0f32;
    let mut cur_count = 0usize;
    let mut overall = 0f32;
    let mut ebu: Option<EbuR128> = None;
    let mut ebu_failed = false;
    let mut collector: Option<Collector> = None;

    let (info, frames) = decode(path, Some(MAX_ANALYZE_SECONDS), |info, samples| {
        let ch = info.channels.max(1);
        collector.get_or_insert_with(|| Collector::new(info.sample_rate)).push(samples, ch);
        if block_size == 0 {
            // Aim for ~2k blocks so the final buckets are exact maxima, not samples of samples.
            block_size = info.frames_hint.map(|n| (n as usize / 2048).clamp(16, 4096)).unwrap_or(256);
        }
        if ebu.is_none() && !ebu_failed {
            match EbuR128::new(ch as u32, info.sample_rate, EbuMode::I) {
                Ok(e) => ebu = Some(e),
                Err(_) => ebu_failed = true,
            }
        }
        if let Some(e) = ebu.as_mut() {
            if e.add_frames_f32(samples).is_err() {
                ebu = None;
                ebu_failed = true;
            }
        }
        for frame in samples.chunks_exact(ch) {
            let m = frame.iter().fold(0f32, |a, &s| a.max(s.abs()));
            if m > cur_max {
                cur_max = m;
            }
            cur_count += 1;
            if cur_count == block_size {
                overall = overall.max(cur_max);
                blocks.push(cur_max);
                cur_max = 0.0;
                cur_count = 0;
            }
        }
    })?;

    if cur_count > 0 {
        overall = overall.max(cur_max);
        blocks.push(cur_max);
    }

    let loudness = ebu
        .as_ref()
        .and_then(|e| e.loudness_global().ok())
        .filter(|l| l.is_finite() && *l > -70.0);

    Ok(AudioInfo {
        // A truncated analysis still reports the real length when the container knows it.
        duration: info.frames_hint.unwrap_or(0).max(frames) as f64 / info.sample_rate as f64,
        sample_rate: info.sample_rate,
        channels: info.channels as u16,
        bit_depth: info.bit_depth.map(|b| b as u16),
        peaks: bucketize(&blocks, PEAK_BUCKETS, overall),
        peak_db: (overall > 0.0).then(|| 20.0 * (overall as f64).log10()),
        loudness,
        sound: collector.and_then(Collector::finish),
    })
}

/// Reduces block maxima to exactly `n` buckets, normalized to `peak`.
pub fn bucketize(blocks: &[f32], n: usize, peak: f32) -> Vec<u8> {
    if blocks.is_empty() || peak <= 0.0 {
        return vec![0; n];
    }
    let len = blocks.len();
    (0..n)
        .map(|b| {
            let v = if len >= n {
                let start = b * len / n;
                let end = ((b + 1) * len / n).max(start + 1);
                blocks[start..end].iter().copied().fold(0f32, f32::max)
            } else {
                blocks[(b * len / n).min(len - 1)]
            };
            ((v / peak).clamp(0.0, 1.0) * 255.0).round() as u8
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_wav(path: &Path, rate: u32, channels: u16, seconds: f32, f: impl Fn(f32) -> f32) {
        let spec = hound::WavSpec { channels, sample_rate: rate, bits_per_sample: 24, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        let n = (rate as f32 * seconds) as usize;
        for i in 0..n {
            let v = f(i as f32 / rate as f32);
            for _ in 0..channels {
                w.write_sample((v * 8_388_000.0) as i32).unwrap();
            }
        }
        w.finalize().unwrap();
    }

    #[test]
    fn analyzes_a_decaying_hit() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("kick.wav");
        write_wav(&p, 44100, 1, 0.5, |t| (t * 60.0 * std::f32::consts::TAU).sin() * (-t * 10.0).exp() * 0.5);
        let info = analyze(&p).unwrap();
        assert!((info.duration - 0.5).abs() < 0.001);
        assert_eq!(info.sample_rate, 44100);
        assert_eq!(info.channels, 1);
        assert_eq!(info.bit_depth, Some(24));
        assert_eq!(info.peaks.len(), PEAK_BUCKETS);
        // Loud at the start, quiet at the end.
        assert!(info.peaks[2] > 200, "{:?}", &info.peaks[..8]);
        assert!(info.peaks[PEAK_BUCKETS - 1] < 30);
        let peak = info.peak_db.unwrap();
        assert!((-7.0..-5.0).contains(&peak), "{peak}");
        assert!(info.loudness.is_some());
    }

    #[test]
    fn short_files_still_get_full_peaks() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("tick.wav");
        write_wav(&p, 48000, 2, 0.02, |_| 0.3);
        let info = analyze(&p).unwrap();
        assert_eq!(info.channels, 2);
        assert_eq!(info.peaks.len(), PEAK_BUCKETS);
        assert!(info.peaks.iter().all(|&v| v == 255));
        assert_eq!(info.loudness, None);
    }

    #[test]
    fn bucketize_takes_maxima() {
        let blocks: Vec<f32> = (0..1024).map(|i| if i == 700 { 1.0 } else { 0.1 }).collect();
        let b = bucketize(&blocks, 512, 1.0);
        assert_eq!(b[350], 255);
        assert_eq!(b[0], 26);
    }
}

/// Decode check over a spread of real files:
/// `SAGA_SCAN_DIR=/path cargo test --release --lib analysis::report -- --ignored --nocapture`
#[cfg(test)]
mod report {
    use super::*;

    #[test]
    #[ignore]
    fn decode_report() {
        let Ok(root) = std::env::var("SAGA_SCAN_DIR") else { return };
        let files: Vec<_> = walkdir::WalkDir::new(root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file() && crate::decode::is_audio_path(e.path()))
            .map(|e| e.into_path())
            .collect();
        let pick: Vec<_> = files.iter().step_by((files.len() / 300).max(1)).collect();
        let start = std::time::Instant::now();
        let mut failures = Vec::new();
        let mut audio_seconds = 0.0;
        let mut by_ext = std::collections::BTreeMap::<String, usize>::new();
        for p in &pick {
            *by_ext.entry(p.extension().unwrap().to_string_lossy().to_lowercase()).or_default() += 1;
            match analyze(p) {
                Ok(info) => audio_seconds += info.duration,
                Err(e) => failures.push(format!("{} — {e}", p.display())),
            }
        }
        let took = start.elapsed();
        println!("analyzed {} files ({by_ext:?}) in {:.2?}: {:.1} ms/file, {:.0}x realtime", pick.len(), took, took.as_secs_f64() * 1000.0 / pick.len() as f64, audio_seconds / took.as_secs_f64());
        println!("failures: {}", failures.len());
        for f in failures.iter().take(20) {
            println!("  {f}");
        }
    }
}
