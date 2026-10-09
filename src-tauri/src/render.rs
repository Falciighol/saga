//! Offline renders of processed samples, for dragging into a DAW, exporting and saving variations.
//! Renders go to the saved sounds folder (~/Music/Saga unless changed in Settings) so DAW projects
//! that reference them by path keep working.

use crate::audio::load_stereo;
use crate::dsp::{process_offline, shape, write_wav, ProcessParams};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Folders inside the saved sounds folder.
pub const RENDERS_DIR: &str = "Renders";
pub const VARIATIONS_DIR: &str = "Variations";
/// Takes saved from the Record panel; kept in the library like variations.
pub const RECORDINGS_DIR: &str = "Recordings";

/// Renders made ahead of time while browsing live in the app's cache folder ("scratch") until
/// they're dragged out. No project can refer to them, so Saga deletes them on its own: after a
/// week, or oldest first once they take more than this much space.
pub const SCRATCH_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
pub const SCRATCH_MAX_BYTES: u64 = 500 * 1024 * 1024;

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

/// Moves a scratch render into `dir` as `name` (or `name 2`…): a rename on the same drive, a copy
/// across drives.
pub fn keep(scratch: &Path, dir: &Path, name: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let dest = free_path(dir, name);
    if std::fs::rename(scratch, &dest).is_err() {
        std::fs::copy(scratch, &dest).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(scratch);
    }
    Ok(dest)
}

pub struct RenderFile {
    pub path: PathBuf,
    pub bytes: u64,
    pub modified: SystemTime,
}

/// The renders and Lab clips directly in `dir`. Subfolders and other files are left alone, in case
/// someone keeps their own things there.
pub fn render_files(dir: &Path) -> Vec<RenderFile> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| {
            let p = e.path();
            p.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("wav") || x.eq_ignore_ascii_case("mid"))
        })
        .filter_map(|e| {
            let m = e.metadata().ok().filter(|m| m.is_file())?;
            Some(RenderFile { path: e.path(), bytes: m.len(), modified: m.modified().unwrap_or(SystemTime::UNIX_EPOCH) })
        })
        .collect()
}

/// Deletes scratch renders older than `max_age`, then the oldest until the rest fit in `max_bytes`.
/// `except` (the render just made) always stays. Returns what was deleted.
pub fn prune_scratch(dir: &Path, max_age: Duration, max_bytes: u64, except: Option<&Path>) -> Vec<PathBuf> {
    let now = SystemTime::now();
    let mut files: Vec<RenderFile> = render_files(dir).into_iter().filter(|f| Some(f.path.as_path()) != except).collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.modified));
    let mut total = except.and_then(|p| std::fs::metadata(p).ok()).map_or(0, |m| m.len());
    let mut deleted = Vec::new();
    for f in files {
        let old = now.duration_since(f.modified).unwrap_or_default() > max_age;
        total += f.bytes;
        if (old || total > max_bytes) && std::fs::remove_file(&f.path).is_ok() {
            total -= f.bytes;
            deleted.push(f.path);
        }
    }
    deleted
}

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct FileCount {
    pub files: u64,
    pub bytes: u64,
}

impl FileCount {
    fn add(&mut self, bytes: u64) {
        self.files += 1;
        self.bytes += bytes;
    }
}

/// How much space renders take, for Settings.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RendersUsage {
    /// The Renders folder of the saved sounds folder.
    pub path: String,
    pub all: FileCount,
    pub older_than_week: FileCount,
    pub older_than_month: FileCount,
    /// Renders made ahead of time, which Saga clears on its own.
    pub scratch: FileCount,
}

const DAY: Duration = Duration::from_secs(24 * 60 * 60);

pub fn usage(dir: &Path, scratch: &Path) -> RendersUsage {
    let now = SystemTime::now();
    let mut u = RendersUsage {
        path: dir.to_string_lossy().to_string(),
        all: FileCount::default(),
        older_than_week: FileCount::default(),
        older_than_month: FileCount::default(),
        scratch: FileCount::default(),
    };
    for f in render_files(dir) {
        let age = now.duration_since(f.modified).unwrap_or_default();
        u.all.add(f.bytes);
        if age > 7 * DAY {
            u.older_than_week.add(f.bytes);
        }
        if age > 30 * DAY {
            u.older_than_month.add(f.bytes);
        }
    }
    for f in render_files(scratch) {
        u.scratch.add(f.bytes);
    }
    u
}

/// Renders in `dir` last changed more than `days` ago (all of them for `None`).
pub fn older_than(dir: &Path, days: Option<u32>) -> Vec<RenderFile> {
    let now = SystemTime::now();
    let min_age = days.map_or(Duration::ZERO, |d| d * DAY);
    render_files(dir).into_iter().filter(|f| days.is_none() || now.duration_since(f.modified).unwrap_or_default() > min_age).collect()
}

/// Moves files to the Trash (the Recycle Bin on Windows), so a project that turns out to need one
/// can get it back.
pub fn move_to_trash(paths: &[PathBuf]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let paths = paths.to_vec();
    // A fresh thread, so COM on Windows starts out uninitialized the way `trash` expects.
    std::thread::spawn(move || {
        #[allow(unused_mut)]
        let mut ctx = trash::TrashContext::default();
        // Asking Finder would need an extra permission and plays its sound for every batch.
        #[cfg(target_os = "macos")]
        trash::macos::TrashContextExtMacos::set_delete_method(&mut ctx, trash::macos::DeleteMethod::NsFileManager);
        ctx.delete_all(&paths).map_err(|e| e.to_string())
    })
    .join()
    .map_err(|_| "Couldn't reach the Trash".to_string())?
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

    /// A file of `bytes` bytes last changed `days` ago.
    fn aged(path: &Path, bytes: usize, days: u32) {
        std::fs::write(path, vec![0u8; bytes]).unwrap();
        let f = std::fs::File::options().write(true).open(path).unwrap();
        f.set_modified(SystemTime::now() - days * DAY).unwrap();
    }

    #[test]
    fn kept_renders_move_out_of_scratch_and_never_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let (scratch, renders) = (dir.path().join("scratch"), dir.path().join("Renders"));
        std::fs::create_dir_all(&scratch).unwrap();
        std::fs::create_dir_all(&renders).unwrap();
        std::fs::write(renders.join("x (rev).wav"), b"older").unwrap();
        std::fs::write(scratch.join("x (rev) 2.wav"), b"new").unwrap();
        let kept = keep(&scratch.join("x (rev) 2.wav"), &renders, "x (rev).wav").unwrap();
        assert_eq!(kept, renders.join("x (rev) 2.wav"));
        assert_eq!(std::fs::read(&kept).unwrap(), b"new");
        assert_eq!(std::fs::read(renders.join("x (rev).wav")).unwrap(), b"older");
        assert!(!scratch.join("x (rev) 2.wav").exists());
    }

    #[test]
    fn scratch_is_pruned_by_age_then_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        aged(&d.join("ancient.wav"), 10, 9);
        aged(&d.join("old.wav"), 40, 3);
        aged(&d.join("recent.wav"), 40, 1);
        aged(&d.join("new.wav"), 40, 0);
        aged(&d.join("notes.txt"), 999, 30);
        let mut gone = prune_scratch(d, SCRATCH_MAX_AGE, 100, None);
        gone.sort();
        assert_eq!(gone, vec![d.join("ancient.wav"), d.join("old.wav")]);
        assert!(d.join("notes.txt").exists());
        // The render just made stays, even on its own over the limit.
        assert_eq!(prune_scratch(d, SCRATCH_MAX_AGE, 10, Some(&d.join("recent.wav"))), vec![d.join("new.wav")]);
        assert!(d.join("recent.wav").exists());
    }

    #[test]
    fn usage_counts_renders_by_age() {
        let dir = tempfile::tempdir().unwrap();
        let (renders, scratch) = (dir.path().join("Renders"), dir.path().join("scratch"));
        std::fs::create_dir_all(renders.join("Mine")).unwrap();
        std::fs::create_dir_all(&scratch).unwrap();
        aged(&renders.join("a.wav"), 100, 40);
        aged(&renders.join("b.WAV"), 20, 10);
        aged(&renders.join("c.mid"), 3, 0);
        aged(&renders.join("Mine/d.wav"), 1000, 90);
        aged(&renders.join("e.aif"), 1000, 90);
        aged(&scratch.join("s.wav"), 7, 0);
        let u = usage(&renders, &scratch);
        assert_eq!(u.all, FileCount { files: 3, bytes: 123 });
        assert_eq!(u.older_than_week, FileCount { files: 2, bytes: 120 });
        assert_eq!(u.older_than_month, FileCount { files: 1, bytes: 100 });
        assert_eq!(u.scratch, FileCount { files: 1, bytes: 7 });
        let names = |days| {
            let mut n: Vec<String> = older_than(&renders, days).iter().map(|f| f.path.file_name().unwrap().to_string_lossy().to_string()).collect();
            n.sort();
            n
        };
        assert_eq!(names(Some(30)), ["a.wav"]);
        assert_eq!(names(Some(7)), ["a.wav", "b.WAV"]);
        assert_eq!(names(None), ["a.wav", "b.WAV", "c.mid"]);
    }

    /// Puts a small file in this machine's real Trash, so it only runs when asked for:
    /// `cargo test --lib trash -- --ignored`.
    #[test]
    #[ignore]
    fn renders_go_to_the_trash() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("Saga trash test (delete me).wav");
        std::fs::write(&f, b"saga").unwrap();
        move_to_trash(std::slice::from_ref(&f)).unwrap();
        assert!(!f.exists());
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
