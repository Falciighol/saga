//! Keeps the index in sync with the library folders: scanning, parallel analysis,
//! batched writes and file watching.

use crate::analysis;
use crate::chunks::read_chunk_meta;
use crate::db::{fts_text, AnalysisOutcome, Db, PendingFile, ScannedFile};
use crate::decode::is_audio_path;
use crate::detect;
use crate::meta;
use crate::model::IndexProgress;
use crossbeam_channel::{unbounded, RecvTimeoutError, Sender};
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};
use walkdir::WalkDir;

/// Sends an event to the UI; a no-op in tests.
pub type Emit = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

enum ScanJob {
    Source(i64),
    Paths(i64, Vec<PathBuf>),
}

#[derive(Default)]
struct Counters {
    scanning: AtomicUsize,
    found: AtomicU64,
    done: AtomicU64,
    total: AtomicU64,
    /// Queued files that were analyzed before, by an older version.
    refresh_left: AtomicU64,
    library_dirty: AtomicBool,
    progress_dirty: AtomicBool,
}

pub struct Indexer {
    db: Arc<Db>,
    scan_tx: Sender<ScanJob>,
    /// Scan jobs sent but not finished (including queueing their files for analysis).
    jobs: Arc<AtomicUsize>,
    analyze_tx: Sender<PendingFile>,
    /// Queued ids, and whether each is a refresh of an older analysis.
    queued: Mutex<HashMap<i64, bool>>,
    counters: Counters,
    watchers: Mutex<HashMap<i64, Debouncer<RecommendedWatcher>>>,
}

/// Background work should never compete with the DAW for CPU: on macOS, run it at
/// "utility" quality of service so the scheduler favors efficiency cores and real-time threads.
fn lower_thread_priority() {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: i32) -> i32;
        }
        const QOS_CLASS_UTILITY: u32 = 0x11;
        // SAFETY: only changes the scheduling class of the calling thread.
        unsafe {
            pthread_set_qos_class_self_np(QOS_CLASS_UTILITY, 0);
        }
    }
}

const WRITE_BATCH: usize = 64;
const SCAN_BATCH: usize = 500;

fn skip_entry(e: &walkdir::DirEntry) -> bool {
    if e.depth() == 0 {
        return false;
    }
    let name = e.file_name().to_string_lossy();
    name.starts_with('.') || name == "__MACOSX" || (e.file_type().is_dir() && name.ends_with(".app"))
}

fn mtime_secs(m: &std::fs::Metadata) -> i64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn rel_dir(root: &Path, file: &Path) -> String {
    file.parent()
        .and_then(|p| p.strip_prefix(root).ok())
        .map(|p| p.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("/"))
        .unwrap_or_default()
}

fn send_job(tx: &Sender<ScanJob>, jobs: &AtomicUsize, job: ScanJob) {
    jobs.fetch_add(1, Ordering::Relaxed);
    if tx.send(job).is_err() {
        jobs.fetch_sub(1, Ordering::Relaxed);
    }
}

fn analyze_one(job: &PendingFile) -> AnalysisOutcome {
    let path = Path::new(&job.path);
    let dirs: Vec<&str> = job.dir.split('/').filter(|s| !s.is_empty()).collect();
    let name = meta::parse_name(&job.name, &dirs);
    let result = analysis::analyze(path).map(|info| {
        let chunk = read_chunk_meta(path);
        let mut resolved = meta::resolve(&name, &chunk, Some(info.duration));
        if let Some(sound) = &info.sound {
            detect::apply(&mut resolved, &name, sound, info.duration);
        }
        let text = fts_text(&job.source_name, &job.dir, &job.name, &job.ext, &resolved);
        (info, resolved, text)
    });
    AnalysisOutcome { id: job.id, result }
}

impl Indexer {
    pub fn start(db: Arc<Db>, emit: Emit) -> Arc<Indexer> {
        let (scan_tx, scan_rx) = unbounded::<ScanJob>();
        let (analyze_tx, analyze_rx) = unbounded::<PendingFile>();
        let (result_tx, result_rx) = unbounded::<AnalysisOutcome>();
        let indexer = Arc::new(Indexer {
            db,
            scan_tx,
            jobs: Arc::new(AtomicUsize::new(0)),
            analyze_tx,
            queued: Mutex::new(HashMap::new()),
            counters: Counters::default(),
            watchers: Mutex::new(HashMap::new()),
        });

        let me = indexer.clone();
        std::thread::Builder::new()
            .name("saga-scan".into())
            .spawn(move || {
                lower_thread_priority();
                for job in scan_rx {
                    let source = match job {
                        ScanJob::Source(id) => {
                            me.scan_source(id);
                            id
                        }
                        ScanJob::Paths(id, paths) => {
                            me.scan_paths(id, paths);
                            id
                        }
                    };
                    me.enqueue_pending(Some(source));
                    me.jobs.fetch_sub(1, Ordering::Relaxed);
                }
            })
            .expect("spawn scan thread");

        // Half the cores at most: indexing a big library shouldn't make the DAW stutter.
        let workers = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(2).clamp(1, 6);
        for i in 0..workers {
            let rx = analyze_rx.clone();
            let tx = result_tx.clone();
            std::thread::Builder::new()
                .name(format!("saga-analyze-{i}"))
                .spawn(move || {
                    lower_thread_priority();
                    for job in rx {
                        if tx.send(analyze_one(&job)).is_err() {
                            break;
                        }
                    }
                })
                .expect("spawn analysis worker");
        }

        let me = indexer.clone();
        std::thread::Builder::new()
            .name("saga-write".into())
            .spawn(move || {
                let mut batch: Vec<AnalysisOutcome> = Vec::new();
                loop {
                    match result_rx.recv_timeout(Duration::from_millis(300)) {
                        Ok(o) => {
                            batch.push(o);
                            if batch.len() < WRITE_BATCH {
                                continue;
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                    if batch.is_empty() {
                        continue;
                    }
                    if let Err(e) = me.db.apply_analysis(&batch) {
                        eprintln!("saga: failed to store analysis: {e}");
                    }
                    let mut q = me.queued.lock();
                    for o in &batch {
                        if q.remove(&o.id) == Some(true) {
                            me.counters.refresh_left.fetch_sub(1, Ordering::Relaxed);
                        }
                    }
                    drop(q);
                    me.counters.done.fetch_add(batch.len() as u64, Ordering::Relaxed);
                    me.counters.library_dirty.store(true, Ordering::Relaxed);
                    me.counters.progress_dirty.store(true, Ordering::Relaxed);
                    batch.clear();
                }
            })
            .expect("spawn writer thread");

        let me = indexer.clone();
        std::thread::Builder::new()
            .name("saga-ticker".into())
            .spawn(move || {
                let mut tick: u64 = 0;
                loop {
                    std::thread::sleep(Duration::from_millis(250));
                    tick += 1;
                    me.reset_if_idle();
                    if me.counters.progress_dirty.swap(false, Ordering::Relaxed) {
                        emit("index-progress", serde_json::to_value(me.progress()).unwrap_or_default());
                    }
                    if tick.is_multiple_of(4) && me.counters.library_dirty.swap(false, Ordering::Relaxed) {
                        emit("library-changed", serde_json::Value::Null);
                    }
                    if tick.is_multiple_of(80) {
                        me.check_sources();
                    }
                }
            })
            .expect("spawn ticker thread");

        indexer
    }

    pub fn progress(&self) -> IndexProgress {
        let c = &self.counters;
        let (done, total) = (c.done.load(Ordering::Relaxed), c.total.load(Ordering::Relaxed));
        let refresh_left = c.refresh_left.load(Ordering::Relaxed);
        IndexProgress {
            scanning: c.scanning.load(Ordering::Relaxed) > 0,
            found: c.found.load(Ordering::Relaxed),
            done,
            total,
            watching: self.watchers.lock().len(),
            refreshing: refresh_left > 0 && refresh_left >= total.saturating_sub(done),
        }
    }

    /// True once nothing is waiting to be scanned or analyzed.
    pub fn is_idle(&self) -> bool {
        self.jobs.load(Ordering::Relaxed) == 0 && self.counters.scanning.load(Ordering::Relaxed) == 0 && self.queued.lock().is_empty()
    }

    fn send(&self, job: ScanJob) {
        send_job(&self.scan_tx, &self.jobs, job);
    }

    fn reset_if_idle(&self) {
        let c = &self.counters;
        if c.total.load(Ordering::Relaxed) > 0 && self.is_idle() {
            c.total.store(0, Ordering::Relaxed);
            c.done.store(0, Ordering::Relaxed);
            c.found.store(0, Ordering::Relaxed);
            c.progress_dirty.store(true, Ordering::Relaxed);
        }
    }

    pub fn add_source(&self, path: &str) -> Result<i64, String> {
        let p = Path::new(path);
        if !p.is_dir() {
            return Err(format!("{path} is not a folder"));
        }
        let id = self.db.add_source(path).map_err(|e| e.to_string())?;
        self.send(ScanJob::Source(id));
        Ok(id)
    }

    pub fn remove_source(&self, id: i64) -> Result<(), String> {
        self.watchers.lock().remove(&id);
        self.db.remove_source(id).map_err(|e| e.to_string())?;
        self.counters.library_dirty.store(true, Ordering::Relaxed);
        self.counters.progress_dirty.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub fn rescan(&self, id: i64) {
        self.send(ScanJob::Source(id));
    }

    /// Catches up with changes made while the app was closed.
    pub fn resume_all(&self) {
        if let Ok(sources) = self.db.sources() {
            for s in sources {
                self.send(ScanJob::Source(s.id));
            }
        }
    }

    fn check_sources(&self) {
        let Ok(sources) = self.db.sources() else { return };
        for s in sources {
            let exists = Path::new(&s.path).is_dir();
            if s.online && !exists {
                // Drive unplugged: keep the samples, favorites and tags, just mark them unavailable.
                let _ = self.db.set_source_online(s.id, false);
                self.watchers.lock().remove(&s.id);
                self.counters.library_dirty.store(true, Ordering::Relaxed);
            } else if !s.online && exists {
                self.send(ScanJob::Source(s.id));
            }
        }
    }

    fn scan_source(&self, id: i64) {
        let Ok(Some(src)) = self.db.source(id) else { return };
        let root = PathBuf::from(&src.path);
        if !root.is_dir() {
            let _ = self.db.set_source_online(id, false);
            self.watchers.lock().remove(&id);
            self.counters.library_dirty.store(true, Ordering::Relaxed);
            return;
        }
        if !src.online {
            let _ = self.db.set_source_online(id, true);
        }
        self.scan_tree(id, &src.name, &root, &root);
        self.watch(id, &root);
    }

    fn scan_paths(&self, id: i64, mut paths: Vec<PathBuf>) {
        let Ok(Some(src)) = self.db.source(id) else { return };
        let root = PathBuf::from(&src.path);
        paths.sort();
        paths.dedup();
        // A changed folder covers everything inside it.
        let mut roots: Vec<PathBuf> = Vec::new();
        for p in paths {
            if !roots.iter().any(|r| p.starts_with(r)) {
                roots.push(p);
            }
        }
        for p in roots {
            if !p.starts_with(&root) {
                continue;
            }
            let hidden = p.strip_prefix(&root).map(|rel| rel.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.'))).unwrap_or(true);
            if hidden {
                continue;
            }
            if p.exists() {
                if p.is_dir() || is_audio_path(&p) {
                    self.scan_tree(id, &src.name, &root, &p);
                }
            } else if let Ok(n) = self.db.delete_under(id, &p.to_string_lossy()) {
                if n > 0 {
                    self.counters.library_dirty.store(true, Ordering::Relaxed);
                }
            }
        }
    }

    /// Syncs everything under `start` (a folder or a single file) with the index.
    fn scan_tree(&self, source_id: i64, source_name: &str, root: &Path, start: &Path) {
        let c = &self.counters;
        c.scanning.fetch_add(1, Ordering::Relaxed);
        c.progress_dirty.store(true, Ordering::Relaxed);
        let prefix = (start != root).then(|| start.to_string_lossy().to_string());
        let mut existing = self.db.files_under(source_id, prefix.as_deref()).unwrap_or_default();
        let mut batch: Vec<ScannedFile> = Vec::new();
        let flush = |batch: &mut Vec<ScannedFile>| {
            if batch.is_empty() {
                return;
            }
            if let Err(e) = self.db.upsert_files(source_id, source_name, batch) {
                eprintln!("saga: failed to index files: {e}");
            }
            batch.clear();
            c.library_dirty.store(true, Ordering::Relaxed);
            c.progress_dirty.store(true, Ordering::Relaxed);
        };

        for entry in WalkDir::new(start).follow_links(true).into_iter().filter_entry(|e| !skip_entry(e)) {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_file() || !is_audio_path(entry.path()) {
                continue;
            }
            let Ok(md) = entry.metadata() else { continue };
            let path = entry.path().to_string_lossy().to_string();
            let (size, mtime) = (md.len() as i64, mtime_secs(&md));
            let existing_id = match existing.remove(&path) {
                Some((_, s, m)) if s == size && m == mtime => continue,
                Some((id, _, _)) => Some(id),
                None => None,
            };
            let file = entry.path();
            batch.push(ScannedFile {
                dir: rel_dir(root, file),
                name: file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                ext: file.extension().map(|s| s.to_string_lossy().to_ascii_lowercase()).unwrap_or_default(),
                path,
                size,
                mtime,
                existing: existing_id,
            });
            c.found.fetch_add(1, Ordering::Relaxed);
            if batch.len() >= SCAN_BATCH {
                flush(&mut batch);
            }
        }
        flush(&mut batch);

        let gone: Vec<i64> = existing.values().map(|v| v.0).collect();
        if !gone.is_empty() {
            let _ = self.db.delete_ids(&gone);
            c.library_dirty.store(true, Ordering::Relaxed);
        }
        c.scanning.fetch_sub(1, Ordering::Relaxed);
        c.progress_dirty.store(true, Ordering::Relaxed);
    }

    fn enqueue_pending(&self, source_id: Option<i64>) {
        let Ok(pending) = self.db.pending(source_id) else { return };
        let mut q = self.queued.lock();
        for p in pending {
            if let std::collections::hash_map::Entry::Vacant(e) = q.entry(p.id) {
                e.insert(p.refresh);
                self.counters.total.fetch_add(1, Ordering::Relaxed);
                if p.refresh {
                    self.counters.refresh_left.fetch_add(1, Ordering::Relaxed);
                }
                let _ = self.analyze_tx.send(p);
            }
        }
        self.counters.progress_dirty.store(true, Ordering::Relaxed);
    }

    fn watch(&self, id: i64, root: &Path) {
        let mut watchers = self.watchers.lock();
        if watchers.contains_key(&id) {
            return;
        }
        let (tx, jobs) = (self.scan_tx.clone(), self.jobs.clone());
        let debouncer = new_debouncer(Duration::from_millis(800), move |res: DebounceEventResult| {
            if let Ok(events) = res {
                let paths: Vec<PathBuf> = events.into_iter().map(|e| e.path).collect();
                if !paths.is_empty() {
                    send_job(&tx, &jobs, ScanJob::Paths(id, paths));
                }
            }
        });
        match debouncer {
            Ok(mut d) => match d.watcher().watch(root, RecursiveMode::Recursive) {
                Ok(()) => {
                    watchers.insert(id, d);
                }
                Err(e) => eprintln!("saga: cannot watch {}: {e}", root.display()),
            },
            Err(e) => eprintln!("saga: cannot create watcher: {e}"),
        }
        self.counters.progress_dirty.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Filters, QueryRequest};
    use std::time::Instant;

    fn write_wav(path: &Path, seconds: f32) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let spec = hound::WavSpec { channels: 2, sample_rate: 44100, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for i in 0..(44100.0 * seconds) as usize {
            let v = ((i as f32 / 44100.0 * 220.0 * std::f32::consts::TAU).sin() * 12000.0) as i16;
            w.write_sample(v).unwrap();
            w.write_sample(v).unwrap();
        }
        w.finalize().unwrap();
    }

    fn wait_idle(ix: &Indexer) {
        let start = Instant::now();
        std::thread::sleep(Duration::from_millis(100));
        while !ix.is_idle() {
            assert!(start.elapsed() < Duration::from_secs(20), "indexing did not finish");
            std::thread::sleep(Duration::from_millis(50));
        }
        // The writer commits on a short timer after the queue drains.
        std::thread::sleep(Duration::from_millis(400));
    }

    fn all(db: &Db) -> Vec<crate::model::SampleRow> {
        db.query(&QueryRequest { filters: Filters::default(), sort: "name".into(), desc: false, offset: 0, limit: 100, seed: 0 }).unwrap().rows
    }

    #[test]
    fn indexes_analyzes_and_follows_changes() {
        let lib = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        write_wav(&lib.path().join("Pack/Loops/Bass_Loop_120_Am.wav"), 4.0);
        write_wav(&lib.path().join("Pack/One Shots/Kick_Punchy.wav"), 0.3);
        write_wav(&lib.path().join(".hidden/ignored.wav"), 0.3);
        std::fs::write(lib.path().join("Pack/readme.txt"), "not audio").unwrap();

        let db = Arc::new(Db::open(&data.path().join("t.db")).unwrap());
        let ix = Indexer::start(db.clone(), Arc::new(|_, _| {}));
        let src = ix.add_source(&lib.path().to_string_lossy()).unwrap();
        wait_idle(&ix);

        let rows = all(&db);
        assert_eq!(rows.len(), 2, "{rows:?}");
        let bass = rows.iter().find(|r| r.name.starts_with("Bass")).unwrap();
        assert_eq!(bass.status, 1);
        assert_eq!(bass.kind, "loop");
        assert_eq!(bass.bpm, Some(120.0));
        assert_eq!(bass.key.as_deref(), Some("Am"));
        assert_eq!(bass.pack, "Pack");
        assert!((bass.duration.unwrap() - 4.0).abs() < 0.01);
        assert!(bass.peaks.is_some());
        let kick = rows.iter().find(|r| r.name.starts_with("Kick")).unwrap();
        assert_eq!(kick.kind, "oneshot");
        assert_eq!(kick.category.as_deref(), Some("Kick"));
        assert!(kick.tags.contains(&"punchy".to_string()));

        // Favorites survive a rescan; deleted files disappear; new files appear.
        db.set_favorite(&[kick.id], true).unwrap();
        std::fs::remove_file(lib.path().join("Pack/Loops/Bass_Loop_120_Am.wav")).unwrap();
        write_wav(&lib.path().join("Pack/Loops/Pad_Drone_Em.wav"), 3.5);
        ix.rescan(src);
        wait_idle(&ix);
        let rows = all(&db);
        let names: Vec<_> = rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["Kick_Punchy", "Pad_Drone_Em"]);
        assert!(rows[0].favorite);
        assert_eq!(rows[1].category.as_deref(), Some("Pad"));
        assert_eq!(rows[1].kind, "loop");

        ix.remove_source(src).unwrap();
        assert!(all(&db).is_empty());
    }
}
