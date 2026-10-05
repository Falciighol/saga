//! Keeps the index in sync with the library folders: scanning, parallel analysis,
//! batched writes and file watching.

use crate::analysis;
use crate::chunks::read_chunk_meta;
use crate::db::{fts_text, AnalysisOutcome, Db, PendingFile, ScannedFile};
use crate::decode::is_audio_path;
use crate::detect;
use crate::meta;
use crate::model::{IndexProgress, SourceInfo};
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
    /// Drops whatever is indexed under a source's excluded folders.
    Prune(i64),
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
    /// Held while Saga renames files itself; scans wait for it (see `hold_rescans`).
    renaming: Mutex<()>,
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

/// Hidden files and folders, archive leftovers and app bundles are never part of a library.
pub fn skip_name(name: &str, is_dir: bool) -> bool {
    name.starts_with('.') || name == "__MACOSX" || (is_dir && name.ends_with(".app"))
}

/// The setting that holds folder names left out of every library folder, as a JSON list.
pub const EXCLUDED_NAMES_SETTING: &str = "excluded_folder_names";

/// True when a folder's name matches one of the names left out everywhere: case doesn't matter,
/// and `*` stands for any run of characters ("Vocal*" matches "Vocals" and "Vocal Stems").
pub fn name_excluded(name: &str, names: &[String]) -> bool {
    let name = name.to_lowercase();
    names.iter().any(|p| glob(&p.to_lowercase(), &name))
}

fn glob(pattern: &str, s: &str) -> bool {
    let mut parts = pattern.split('*');
    let first = parts.next().unwrap_or_default();
    let Some(mut rest) = s.strip_prefix(first) else { return false };
    let parts: Vec<&str> = parts.collect();
    let Some((last, middle)) = parts.split_last() else { return rest.is_empty() };
    for part in middle {
        match rest.find(part) {
            Some(i) => rest = &rest[i + part.len()..],
            None => return false,
        }
    }
    rest.len() >= last.len() && rest.ends_with(last)
}

/// True when any folder along `rel` (relative, `/`-separated, all folders) is left out by name.
fn dirs_excluded(rel: &str, names: &[String]) -> bool {
    !names.is_empty() && rel.split('/').any(|seg| !seg.is_empty() && name_excluded(seg, names))
}

/// Cleans up names typed in Settings: trimmed, no paths, no repeats (ignoring case).
pub fn clean_names(names: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for n in names {
        let n = n.trim();
        if n.is_empty() || n.contains(['/', '\\']) || n.chars().all(|c| c == '*') || out.iter().any(|o| o.eq_ignore_ascii_case(n)) {
            continue;
        }
        out.push(n.to_string());
    }
    out
}

fn skip_entry(e: &walkdir::DirEntry, root: &Path, excluded: &[String], names: &[String]) -> bool {
    if e.depth() == 0 {
        return false;
    }
    let is_dir = e.file_type().is_dir();
    let name = e.file_name().to_string_lossy();
    skip_name(&name, is_dir)
        || (is_dir && name_excluded(&name, names))
        || (is_dir && !excluded.is_empty() && rel_path(root, e.path()).is_some_and(|rel| is_excluded(&rel, excluded)))
}

/// `path` relative to `root`, `/`-separated; None when it isn't inside it.
fn rel_path(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root).ok().map(|p| p.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("/"))
}

/// True for an excluded folder and for anything inside one.
fn is_excluded(rel: &str, excluded: &[String]) -> bool {
    excluded.iter().any(|e| rel.strip_prefix(e.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with('/')))
}

/// A folder relative to its source, as stored: `/`-separated, without leading or trailing slashes.
fn clean_dir(dir: &str) -> Result<String, String> {
    let segs: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    if segs.is_empty() || segs.iter().any(|s| *s == "." || *s == "..") {
        return Err("Choose a folder inside a library folder".into());
    }
    Ok(segs.join("/"))
}

/// When the file was created, or last changed where the drive doesn't keep a created time.
/// Matches what `file_dates` reports for the rename dialog.
fn created_secs(m: &std::fs::Metadata) -> i64 {
    m.created().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or_else(|| mtime_secs(m))
}

fn mtime_secs(m: &std::fs::Metadata) -> i64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn rel_dir(root: &Path, file: &Path) -> String {
    file.parent().and_then(|p| rel_path(root, p)).unwrap_or_default()
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
            renaming: Mutex::new(()),
        });

        let me = indexer.clone();
        std::thread::Builder::new()
            .name("saga-scan".into())
            .spawn(move || {
                lower_thread_priority();
                for job in scan_rx {
                    let held = me.renaming.lock();
                    let source = match job {
                        ScanJob::Source(id) => {
                            me.scan_source(id);
                            id
                        }
                        ScanJob::Paths(id, paths) => {
                            me.scan_paths(id, paths);
                            id
                        }
                        ScanJob::Prune(id) => {
                            me.prune(id);
                            id
                        }
                    };
                    drop(held);
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
            let db = indexer.db.clone();
            std::thread::Builder::new()
                .name(format!("saga-analyze-{i}"))
                .spawn(move || {
                    lower_thread_priority();
                    for job in rx {
                        // Queued, then removed or excluded: there's nothing left to describe.
                        let outcome = if db.has_sample(job.id) { analyze_one(&job) } else { AnalysisOutcome { id: job.id, result: Err("No longer in the library".into()) } };
                        if tx.send(outcome).is_err() {
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

    /// Adds a library folder, leaving out the `excluded` subfolders (relative to it).
    pub fn add_source(&self, path: &str, excluded: &[String]) -> Result<i64, String> {
        let p = Path::new(path);
        if !p.is_dir() {
            return Err(format!("{path} is not a folder"));
        }
        let id = self.db.add_source(path).map_err(|e| e.to_string())?;
        for dir in excluded {
            let Ok(dir) = clean_dir(dir) else { continue };
            self.db.set_excluded(id, &dir, true).map_err(|e| e.to_string())?;
            self.db.delete_dir(id, &dir).map_err(|e| e.to_string())?;
        }
        self.send(ScanJob::Source(id));
        Ok(id)
    }

    /// Leaves a subfolder out of the library: its samples go (with their favorites, tags and
    /// places in collections), and scans and the watcher pass over it from now on.
    pub fn exclude_dir(&self, source_id: i64, dir: &str) -> Result<(), String> {
        let dir = clean_dir(dir)?;
        let src = self.db.source(source_id).map_err(|e| e.to_string())?.ok_or("That folder is no longer in the library")?;
        if is_excluded(&dir, &src.excluded) {
            return Ok(());
        }
        self.db.set_excluded(source_id, &dir, true).map_err(|e| e.to_string())?;
        self.db.delete_dir(source_id, &dir).map_err(|e| e.to_string())?;
        // A scan that's already walking the folder may still add files from it; clear those once it's done.
        self.send(ScanJob::Prune(source_id));
        self.counters.library_dirty.store(true, Ordering::Relaxed);
        self.counters.progress_dirty.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Lets an excluded subfolder back in and indexes it.
    pub fn include_dir(&self, source_id: i64, dir: &str) -> Result<(), String> {
        let dir = clean_dir(dir)?;
        let src = self.db.source(source_id).map_err(|e| e.to_string())?.ok_or("That folder is no longer in the library")?;
        self.db.set_excluded(source_id, &dir, false).map_err(|e| e.to_string())?;
        // Segment by segment, so the paths match the ones a full scan stores on every platform.
        let start = dir.split('/').fold(PathBuf::from(&src.path), |p, seg| p.join(seg));
        self.send(ScanJob::Paths(source_id, vec![start]));
        Ok(())
    }

    /// Folder names left out of every library folder.
    pub fn excluded_names(&self) -> Vec<String> {
        self.db.get_setting(EXCLUDED_NAMES_SETTING).and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
    }

    /// Leaves folders with these names out of every library folder. Samples in folders that now
    /// match go; folders that no longer match are scanned again. Returns the names as stored.
    pub fn set_excluded_names(&self, names: &[String]) -> Result<Vec<String>, String> {
        let names = clean_names(names);
        let before = self.excluded_names();
        let value = serde_json::to_string(&names).map_err(|e| e.to_string())?;
        self.db.set_setting(EXCLUDED_NAMES_SETTING, (!names.is_empty()).then_some(value.as_str())).map_err(|e| e.to_string())?;
        let has = |list: &[String], n: &String| list.iter().any(|x| x.eq_ignore_ascii_case(n));
        let added = names.iter().any(|n| !has(&before, n));
        let removed = before.iter().any(|n| !has(&names, n));
        // A rescan also drops what it no longer walks into, so it covers newly matching folders too.
        for s in self.db.sources().map_err(|e| e.to_string())?.iter().filter(|s| s.online) {
            if removed {
                self.send(ScanJob::Source(s.id));
            } else if added {
                self.send(ScanJob::Prune(s.id));
            }
        }
        self.counters.library_dirty.store(true, Ordering::Relaxed);
        Ok(names)
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
        self.scan_tree(&src, &root, &root, "");
        self.watch(id, &root);
    }

    fn prune(&self, id: i64) {
        let Ok(Some(src)) = self.db.source(id) else { return };
        let mut gone: Vec<String> = src.excluded.clone();
        // Folders left out by name, wherever they are: the shallowest one covers the rest.
        let names = self.excluded_names();
        if !names.is_empty() {
            for dir in self.db.source_dirs(id).unwrap_or_default() {
                let segs: Vec<&str> = dir.split('/').collect();
                if let Some(i) = segs.iter().position(|seg| name_excluded(seg, &names)) {
                    gone.push(segs[..=i].join("/"));
                }
            }
        }
        gone.sort();
        gone.dedup();
        for dir in &gone {
            if self.db.delete_dir(id, dir).is_ok_and(|n| n > 0) {
                self.counters.library_dirty.store(true, Ordering::Relaxed);
            }
        }
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
        let names = self.excluded_names();
        for p in roots {
            let Some(rel) = rel_path(&root, &p) else { continue };
            // Only the folders along the path count for names; a file can be called anything.
            // (A deleted file is still an audio path, so its name doesn't keep its row from going.)
            let dirs = if p.is_file() || is_audio_path(&p) { rel.rsplit_once('/').map(|(d, _)| d).unwrap_or("") } else { rel.as_str() };
            if rel.split('/').any(|seg| seg.starts_with('.')) || is_excluded(&rel, &src.excluded) || dirs_excluded(dirs, &names) {
                continue;
            }
            if p.exists() {
                if p.is_dir() || is_audio_path(&p) {
                    self.scan_tree(&src, &root, &p, &rel);
                }
            } else if let Ok(n) = self.db.delete_under(id, &p.to_string_lossy(), &rel) {
                if n > 0 {
                    self.counters.library_dirty.store(true, Ordering::Relaxed);
                }
            }
        }
    }

    /// Syncs everything under `start` (a folder or a single file) with the index. `rel` is `start`
    /// relative to `root`, empty for the root itself.
    fn scan_tree(&self, src: &SourceInfo, root: &Path, start: &Path, rel: &str) {
        let (source_id, source_name) = (src.id, src.name.as_str());
        let c = &self.counters;
        c.scanning.fetch_add(1, Ordering::Relaxed);
        c.progress_dirty.store(true, Ordering::Relaxed);
        let start_path = start.to_string_lossy();
        let under = (!rel.is_empty()).then(|| (start_path.as_ref(), rel));
        let mut existing = self.db.files_under(source_id, under).unwrap_or_default();
        let mut batch: Vec<ScannedFile> = Vec::new();
        let mut undated: Vec<(i64, i64)> = Vec::new();
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

        let names = self.excluded_names();
        for entry in WalkDir::new(start).follow_links(true).into_iter().filter_entry(|e| !skip_entry(e, root, &src.excluded, &names)) {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_file() || !is_audio_path(entry.path()) {
                continue;
            }
            let Ok(md) = entry.metadata() else { continue };
            let path = entry.path().to_string_lossy().to_string();
            let (size, mtime) = (md.len() as i64, mtime_secs(&md));
            let existing_id = match existing.remove(&path) {
                Some((id, s, m, dated)) if s == size && m == mtime => {
                    // Unchanged, but indexed before Saga kept created times.
                    if !dated {
                        undated.push((id, created_secs(&md)));
                    }
                    continue;
                }
                Some((id, ..)) => Some(id),
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
                created: Some(created_secs(&md)),
                existing: existing_id,
            });
            c.found.fetch_add(1, Ordering::Relaxed);
            if batch.len() >= SCAN_BATCH {
                flush(&mut batch);
            }
        }
        flush(&mut batch);
        if !undated.is_empty() {
            match self.db.set_created(&undated) {
                Ok(()) => c.library_dirty.store(true, Ordering::Relaxed),
                Err(e) => eprintln!("saga: failed to store created times: {e}"),
            }
        }

        let gone: Vec<i64> = existing.values().map(|v| v.0).collect();
        if !gone.is_empty() {
            let _ = self.db.delete_ids(&gone);
            c.library_dirty.store(true, Ordering::Relaxed);
        }
        c.scanning.fetch_sub(1, Ordering::Relaxed);
        c.progress_dirty.store(true, Ordering::Relaxed);
    }

    /// Queues whatever is waiting for analysis, such as samples whose tempo or key went back to
    /// what Saga finds.
    pub fn queue_pending(&self) {
        self.enqueue_pending(None);
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

    /// Holds back scans while Saga renames files itself, so the folder watcher never looks at a
    /// file between its old name and its new one, when the library still has the old path and
    /// would drop the sample (and its favorite, tags and collections). Scans run once it's dropped.
    pub fn hold_rescans(&self) -> parking_lot::MutexGuard<'_, ()> {
        self.renaming.lock()
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
        let src = ix.add_source(&lib.path().to_string_lossy(), &[]).unwrap();
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

    #[test]
    fn created_times_are_kept_and_filled_in() {
        let lib = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        write_wav(&lib.path().join("Pack/Kick_Punchy.wav"), 0.3);
        let db = Arc::new(Db::open(&data.path().join("t.db")).unwrap());
        let ix = Indexer::start(db.clone(), Arc::new(|_, _| {}));
        let src = ix.add_source(&lib.path().to_string_lossy(), &[]).unwrap();
        wait_idle(&ix);
        let created = || all(&db)[0].created;
        let first = created().expect("indexing stores the created time");
        let md = std::fs::metadata(lib.path().join("Pack/Kick_Punchy.wav")).unwrap();
        assert_eq!(first, created_secs(&md));

        // A library indexed before Saga kept created times gets them on the next scan, without
        // the unchanged file being indexed (or analyzed) again.
        db.forget_created();
        assert_eq!(created(), None);
        ix.rescan(src);
        wait_idle(&ix);
        assert_eq!(created(), Some(first));
        assert_eq!(all(&db)[0].status, 1);
    }

    #[test]
    fn excluded_folders_stay_out() {
        let lib = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        write_wav(&lib.path().join("Pack/Loops/Bass_Loop_120_Am.wav"), 1.0);
        write_wav(&lib.path().join("Pack/One Shots/Kick_Punchy.wav"), 0.3);
        write_wav(&lib.path().join("Pack/One Shots/Old/Kick_Flat.wav"), 0.3);
        write_wav(&lib.path().join("Pack 2/Snare_Crack.wav"), 0.3);
        write_wav(&lib.path().join("Demos/Full_Mix_120.wav"), 1.0);

        let db = Arc::new(Db::open(&data.path().join("t.db")).unwrap());
        let ix = Indexer::start(db.clone(), Arc::new(|_, _| {}));
        // Left out from the start: the scan never reads the folder.
        let src = ix.add_source(&lib.path().to_string_lossy(), &["Demos".into()]).unwrap();
        wait_idle(&ix);
        let names = |db: &Db| all(db).into_iter().map(|r| r.name).collect::<Vec<_>>();
        assert_eq!(names(&db), vec!["Bass_Loop_120_Am", "Kick_Flat", "Kick_Punchy", "Snare_Crack"]);

        // Excluded later: its samples (and the folders inside it) go, and a rescan doesn't bring them
        // back. "Pack 2" only shares a prefix with "Pack", so it stays.
        ix.exclude_dir(src, "/Pack/One Shots/").unwrap();
        ix.exclude_dir(src, "Pack/One Shots/Old").unwrap();
        ix.rescan(src);
        wait_idle(&ix);
        assert_eq!(names(&db), vec!["Bass_Loop_120_Am", "Snare_Crack"]);
        assert_eq!(db.source(src).unwrap().unwrap().excluded, vec!["Demos", "Pack/One Shots"]);
        assert!(ix.exclude_dir(src, "").is_err());
        assert!(ix.exclude_dir(src, "../elsewhere").is_err());

        // Changes inside an excluded folder are passed over too.
        write_wav(&lib.path().join("Pack/One Shots/Kick_New.wav"), 0.3);
        ix.send(ScanJob::Paths(src, vec![lib.path().join("Pack/One Shots/Kick_New.wav"), lib.path().join("Pack/One Shots")]));
        wait_idle(&ix);
        assert_eq!(names(&db), vec!["Bass_Loop_120_Am", "Snare_Crack"]);

        // Included again: everything in it is indexed, nested folders too.
        ix.include_dir(src, "Pack/One Shots").unwrap();
        wait_idle(&ix);
        assert_eq!(names(&db), vec!["Bass_Loop_120_Am", "Kick_Flat", "Kick_New", "Kick_Punchy", "Snare_Crack"]);
        assert_eq!(db.source(src).unwrap().unwrap().excluded, vec!["Demos"]);
        assert!(all(&db).iter().all(|r| r.status == 1), "included samples are analyzed");
    }

    #[test]
    fn folder_names_match_ignoring_case_with_wildcards() {
        let names = clean_names(&["  Vocals ".into(), "vocals".into(), "Stem*".into(), "a/b".into(), "*".into(), "".into()]);
        assert_eq!(names, vec!["Vocals", "Stem*"]);
        assert!(name_excluded("VOCALS", &names));
        assert!(!name_excluded("Vocals 2", &names));
        assert!(name_excluded("Stems", &names) && name_excluded("stem", &names));
        assert!(!name_excluded("My Stems", &names));
        let mid = vec!["*vox*".to_string(), "Old*Takes".to_string()];
        assert!(name_excluded("Lead Vox Dry", &mid) && name_excluded("vox", &mid));
        assert!(name_excluded("Old Takes", &mid) && name_excluded("OldTakes", &mid) && !name_excluded("Old Takes 2", &mid));
        assert!(dirs_excluded("Pack/Vocals/Dry", &names) && !dirs_excluded("Pack/Drums", &names) && !dirs_excluded("", &names));
    }

    #[test]
    fn folders_left_out_by_name_everywhere() {
        let lib = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        write_wav(&lib.path().join("Pack A/Vocals/Vox_Hey.wav"), 0.3);
        write_wav(&lib.path().join("Pack A/Drums/Kick.wav"), 0.3);
        write_wav(&lib.path().join("Pack B/Loops/vocals/Dry/Vox_Ooh.wav"), 0.3);
        write_wav(&lib.path().join("Pack B/Loops/Bass.wav"), 0.3);
        // A file can be called anything: names only match folders.
        write_wav(&lib.path().join("Pack B/Vocals.wav"), 0.3);

        let db = Arc::new(Db::open(&data.path().join("t.db")).unwrap());
        let ix = Indexer::start(db.clone(), Arc::new(|_, _| {}));
        ix.set_excluded_names(&["Vocals".into()]).unwrap();
        ix.add_source(&lib.path().to_string_lossy(), &[]).unwrap();
        wait_idle(&ix);
        let names = |db: &Db| all(db).into_iter().map(|r| r.name).collect::<Vec<_>>();
        assert_eq!(names(&db), vec!["Bass", "Kick", "Vocals"]);

        // Changes inside a matching folder are passed over too.
        write_wav(&lib.path().join("Pack A/Vocals/Vox_New.wav"), 0.3);
        let src = db.sources().unwrap()[0].id;
        ix.send(ScanJob::Paths(src, vec![lib.path().join("Pack A/Vocals/Vox_New.wav")]));
        wait_idle(&ix);
        assert_eq!(names(&db), vec!["Bass", "Kick", "Vocals"]);

        // Taking the name away brings the folders back; adding another takes its folders out.
        assert_eq!(ix.set_excluded_names(&[]).unwrap(), Vec::<String>::new());
        wait_idle(&ix);
        assert_eq!(names(&db), vec!["Bass", "Kick", "Vocals", "Vox_Hey", "Vox_New", "Vox_Ooh"]);
        ix.set_excluded_names(&["dr*".into()]).unwrap();
        wait_idle(&ix);
        assert_eq!(names(&db), vec!["Bass", "Vocals", "Vox_Hey", "Vox_New"]);
        assert_eq!(ix.excluded_names(), vec!["dr*"]);
    }
}
