//! SQLite storage: the sample index, full-text search, favorites, tags and collections.

use crate::analysis::{self, AudioInfo};
use crate::features;
use crate::keys::{self, Key};
use crate::meta::{self, Kind, Resolved};
use crate::model::*;
use crate::query::{self, Omit};
use base64::Engine as _;
use parking_lot::Mutex;
use rusqlite::functions::FunctionFlags;
use rusqlite::types::ValueRef;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub type DbResult<T> = rusqlite::Result<T>;

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// One writer and one reader connection; WAL lets reads proceed while indexing writes.
pub struct Db {
    write: Mutex<Connection>,
    read: Mutex<Connection>,
    /// Bumped whenever the set of described samples may have changed.
    changes: AtomicU64,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    online INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS samples (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    dir TEXT NOT NULL,
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    duration REAL,
    sample_rate INTEGER,
    channels INTEGER,
    bit_depth INTEGER,
    bpm REAL,
    bpm_source INTEGER NOT NULL DEFAULT 0,
    key_pc INTEGER,
    key_mode INTEGER,
    key_source INTEGER NOT NULL DEFAULT 0,
    kind INTEGER NOT NULL DEFAULT 0,
    category TEXT,
    auto_tags TEXT NOT NULL DEFAULT ',',
    user_tags TEXT NOT NULL DEFAULT ',',
    peak_db REAL,
    loudness REAL,
    peaks BLOB,
    status INTEGER NOT NULL DEFAULT 0,
    favorite INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL,
    play_count INTEGER NOT NULL DEFAULT 0,
    last_played INTEGER
);
CREATE INDEX IF NOT EXISTS samples_source_dir ON samples(source_id, dir);
CREATE INDEX IF NOT EXISTS samples_status ON samples(status);
CREATE INDEX IF NOT EXISTS samples_favorite ON samples(favorite) WHERE favorite = 1;
CREATE INDEX IF NOT EXISTS samples_added ON samples(added_at);
CREATE INDEX IF NOT EXISTS samples_played ON samples(last_played) WHERE last_played IS NOT NULL;
CREATE INDEX IF NOT EXISTS samples_bpm ON samples(bpm);
CREATE VIRTUAL TABLE IF NOT EXISTS samples_fts USING fts5(
    text,
    tokenize = 'unicode61 remove_diacritics 2',
    prefix = '2 3'
);
CREATE TRIGGER IF NOT EXISTS samples_fts_delete AFTER DELETE ON samples BEGIN
    DELETE FROM samples_fts WHERE rowid = old.id;
END;
CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS collection_items (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    sample_id INTEGER NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (collection_id, sample_id)
);
CREATE INDEX IF NOT EXISTS collection_items_sample ON collection_items(sample_id);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS renders (
    key TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS excluded_dirs (
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    dir TEXT NOT NULL,
    PRIMARY KEY (source_id, dir)
);
"#;

/// Columns added after the first release, with their definitions.
const ADDED_COLUMNS: &[(&str, &str)] = &[("features", "BLOB"), ("analysis_version", "INTEGER NOT NULL DEFAULT 0")];

const ROW_COLS: &str = "s.id, s.source_id, s.path, s.name, s.ext, s.dir, src.name, s.duration, s.sample_rate, \
    s.channels, s.bit_depth, s.bpm, s.bpm_source, s.key_pc, s.key_mode, s.kind, s.category, s.auto_tags, \
    s.user_tags, s.peak_db, s.loudness, s.peaks, s.status, s.favorite, src.online, s.play_count, s.key_source";

/// Matches the file at path `?2` and every file in the folder `?3`, which is that same path relative
/// to its source ('' for the source itself). Folders are compared through `dir`, which is
/// `/`-separated on every platform; stored paths use the platform's separator.
const UNDER: &str = "(path = ?2 OR ?3 = '' OR dir = ?3 OR substr(dir, 1, length(?3) + 1) = ?3 || '/')";

fn value_source(v: i64) -> Option<&'static str> {
    match v {
        1 => Some("name"),
        2 => Some("metadata"),
        3 => Some("audio"),
        _ => None,
    }
}

fn split_tags(s: &str) -> Vec<String> {
    s.split(',').filter(|t| !t.is_empty()).map(String::from).collect()
}

fn join_tags<S: AsRef<str>>(tags: &[S]) -> String {
    if tags.is_empty() {
        ",".into()
    } else {
        format!(",{},", tags.iter().map(|t| t.as_ref()).collect::<Vec<_>>().join(","))
    }
}

fn row_to_sample(r: &Row) -> rusqlite::Result<SampleRow> {
    let dir: String = r.get(5)?;
    let source_name: String = r.get(6)?;
    let key_pc: Option<i64> = r.get(13)?;
    let key_mode: Option<i64> = r.get(14)?;
    let key = Key::from_db(key_pc, key_mode);
    let auto_tags: String = r.get(17)?;
    let user_tags = split_tags(&r.get::<_, String>(18)?);
    let mut tags = split_tags(&auto_tags);
    for t in &user_tags {
        if !tags.contains(t) {
            tags.push(t.clone());
        }
    }
    let peaks: Option<Vec<u8>> = r.get(21)?;
    Ok(SampleRow {
        id: r.get(0)?,
        source_id: r.get(1)?,
        path: r.get(2)?,
        name: r.get(3)?,
        ext: r.get(4)?,
        pack: dir.split('/').find(|s| !s.is_empty()).map(String::from).unwrap_or(source_name),
        dir,
        duration: r.get(7)?,
        sample_rate: r.get(8)?,
        channels: r.get(9)?,
        bit_depth: r.get(10)?,
        bpm: r.get(11)?,
        bpm_source: value_source(r.get(12)?),
        key: key.map(|k| k.name().to_string()),
        key_source: key.and(value_source(r.get(26)?)),
        camelot: key.and_then(|k| k.camelot()).map(|(n, l)| format!("{n}{l}")),
        key_pc,
        key_mode,
        kind: if r.get::<_, i64>(15)? == 1 { "loop" } else { "oneshot" },
        category: r.get(16)?,
        tags,
        user_tags,
        peak_db: r.get(19)?,
        loudness: r.get(20)?,
        peaks: peaks.map(|p| base64::engine::general_purpose::STANDARD.encode(p)),
        status: r.get(22)?,
        favorite: r.get::<_, i64>(23)? == 1,
        online: r.get::<_, i64>(24)? == 1,
        play_count: r.get(25)?,
    })
}

/// Words indexed for full-text search.
pub fn fts_text(source_name: &str, dir: &str, name: &str, ext: &str, r: &Resolved) -> String {
    let mut words = meta::search_words(name);
    for seg in dir.split('/') {
        words.extend(meta::search_words(seg));
    }
    words.extend(meta::search_words(source_name));
    if let Some(c) = r.category {
        words.push(c.to_lowercase());
    }
    words.extend(r.tags.iter().map(|t| t.to_string()));
    words.push(if r.kind == Kind::Loop { "loop".into() } else { "oneshot one shot".into() });
    if let Some(k) = r.key {
        words.push(k.name().to_lowercase());
        if let Some((n, l)) = k.camelot() {
            words.push(format!("{n}{}", l.to_ascii_lowercase()));
        }
    }
    words.push(ext.to_string());
    words.join(" ")
}

/// Indexed text is the derived words plus any user tags, so both stay searchable across re-analysis.
fn with_user_tags(base: &str, user_tags: &str) -> String {
    let tags = split_tags(user_tags);
    if tags.is_empty() { base.to_string() } else { format!("{base} |user| {}", tags.join(" ")) }
}

pub struct ScannedFile {
    pub path: String,
    pub dir: String,
    pub name: String,
    pub ext: String,
    pub size: i64,
    pub mtime: i64,
    pub existing: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct PendingFile {
    pub id: i64,
    pub path: String,
    pub dir: String,
    pub name: String,
    pub ext: String,
    pub source_name: String,
    /// Analyzed before, by an older version.
    pub refresh: bool,
}

/// What the similarity index needs from one described sample.
pub struct FeatureRow {
    pub id: i64,
    pub kind: i64,
    pub source_id: i64,
    pub category: Option<String>,
    pub features: Vec<f32>,
}

pub struct AnalysisOutcome {
    pub id: i64,
    pub result: Result<(AudioInfo, Resolved, String), String>,
}

fn configure(conn: &Connection) -> DbResult<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    // scale_fit(features, mask): how well a sample's stored pitch profile fits a set of notes
    // (a 12-bit mask, bit 0 = C), 0–1, or NULL when it has no profile. Read straight from the
    // feature blob, so filtering and sorting by it needs no extra columns or re-analysis.
    conn.create_scalar_function("scale_fit", 2, FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| {
        let mask = ctx.get::<i64>(1)? as u16;
        Ok(match ctx.get_raw(0) {
            ValueRef::Blob(b) => features::chroma_from_blob(b).and_then(|c| keys::scale_fit(&c, mask)).map(f64::from),
            _ => None,
        })
    })?;
    Ok(())
}

impl Db {
    pub fn open(path: &Path) -> DbResult<Db> {
        let write = Connection::open(path)?;
        configure(&write)?;
        write.execute_batch(SCHEMA)?;
        let existing: Vec<String> =
            write.prepare("SELECT name FROM pragma_table_info('samples')")?.query_map([], |r| r.get(0))?.collect::<DbResult<_>>()?;
        for (col, def) in ADDED_COLUMNS {
            if !existing.iter().any(|c| c == col) {
                write.execute_batch(&format!("ALTER TABLE samples ADD COLUMN {col} {def}"))?;
            }
        }
        let read = Connection::open(path)?;
        configure(&read)?;
        Ok(Db { write: Mutex::new(write), read: Mutex::new(read), changes: AtomicU64::new(1) })
    }

    /// Changes whenever described samples may have been added, changed or removed.
    pub fn changes(&self) -> u64 {
        self.changes.load(Ordering::Relaxed)
    }

    fn changed(&self) {
        self.changes.fetch_add(1, Ordering::Relaxed);
    }

    // ---- settings ----

    pub fn get_setting(&self, key: &str) -> Option<String> {
        self.read.lock().query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0)).optional().ok().flatten()
    }

    pub fn set_setting(&self, key: &str, value: Option<&str>) -> DbResult<()> {
        let conn = self.write.lock();
        match value {
            Some(v) => conn.execute("INSERT INTO settings(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2", [key, v])?,
            None => conn.execute("DELETE FROM settings WHERE key = ?", [key])?,
        };
        Ok(())
    }

    // ---- renders ----

    pub fn render_for(&self, key: &str) -> DbResult<Option<String>> {
        self.read.lock().query_row("SELECT path FROM renders WHERE key = ?", [key], |r| r.get(0)).optional()
    }

    pub fn remember_render(&self, key: &str, path: &str) -> DbResult<()> {
        self.write.lock().execute(
            "INSERT INTO renders(key, path, created_at) VALUES(?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET path = ?2, created_at = ?3",
            params![key, path, now()],
        )?;
        Ok(())
    }

    // ---- sources ----

    pub fn add_source(&self, path: &str) -> DbResult<i64> {
        let name = Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string());
        let conn = self.write.lock();
        conn.execute("INSERT OR IGNORE INTO sources(path, name, added_at) VALUES(?, ?, ?)", params![path, name, now()])?;
        conn.query_row("SELECT id FROM sources WHERE path = ?", [path], |r| r.get(0))
    }

    pub fn remove_source(&self, id: i64) -> DbResult<()> {
        self.write.lock().execute("DELETE FROM sources WHERE id = ?", [id])?;
        self.changed();
        Ok(())
    }

    pub fn sources(&self) -> DbResult<Vec<SourceInfo>> {
        let conn = self.read.lock();
        let mut stmt = conn.prepare(
            "SELECT src.id, src.path, src.name, src.online, (SELECT COUNT(*) FROM samples s WHERE s.source_id = src.id) \
             FROM sources src ORDER BY src.name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SourceInfo { id: r.get(0)?, path: r.get(1)?, name: r.get(2)?, online: r.get::<_, i64>(3)? == 1, count: r.get(4)?, excluded: Vec::new() })
        })?;
        let mut sources: Vec<SourceInfo> = rows.collect::<DbResult<_>>()?;
        let mut stmt = conn.prepare("SELECT source_id, dir FROM excluded_dirs ORDER BY dir COLLATE NOCASE")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
            let (id, dir) = row?;
            if let Some(s) = sources.iter_mut().find(|s| s.id == id) {
                s.excluded.push(dir);
            }
        }
        Ok(sources)
    }

    /// Leaves a subfolder (relative to the source, `/`-separated) out of the library, or lets it back in.
    pub fn set_excluded(&self, source_id: i64, dir: &str, excluded: bool) -> DbResult<()> {
        let conn = self.write.lock();
        // A folder covers everything inside it, so entries beneath it are redundant either way.
        conn.execute(
            "DELETE FROM excluded_dirs WHERE source_id = ?1 AND (dir = ?2 OR substr(dir, 1, length(?2) + 1) = ?2 || '/')",
            params![source_id, dir],
        )?;
        if excluded {
            conn.execute("INSERT INTO excluded_dirs(source_id, dir) VALUES(?, ?)", params![source_id, dir])?;
        }
        Ok(())
    }

    pub fn source(&self, id: i64) -> DbResult<Option<SourceInfo>> {
        Ok(self.sources()?.into_iter().find(|s| s.id == id))
    }

    pub fn set_source_online(&self, id: i64, online: bool) -> DbResult<()> {
        self.write.lock().execute("UPDATE sources SET online = ? WHERE id = ?", params![online as i64, id])?;
        self.changed();
        Ok(())
    }

    // ---- scanning ----

    /// Files already indexed for a source, optionally limited to one path and everything under it:
    /// the path as stored, and the same path relative to the source (`/`-separated).
    pub fn files_under(&self, source_id: i64, under: Option<(&str, &str)>) -> DbResult<HashMap<String, (i64, i64, i64)>> {
        let conn = self.read.lock();
        let mut out = HashMap::new();
        let mut collect = |stmt: &mut rusqlite::Statement, p: &[&dyn rusqlite::ToSql]| -> DbResult<()> {
            let rows = stmt.query_map(p, |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?))))?;
            for row in rows {
                let (path, v) = row?;
                out.insert(path, v);
            }
            Ok(())
        };
        match under {
            Some((path, rel)) => {
                let mut stmt = conn.prepare(&format!("SELECT path, id, size, mtime FROM samples WHERE source_id = ?1 AND {UNDER}"))?;
                collect(&mut stmt, &[&source_id, &path, &rel])?;
            }
            None => {
                let mut stmt = conn.prepare("SELECT path, id, size, mtime FROM samples WHERE source_id = ?1")?;
                collect(&mut stmt, &[&source_id])?;
            }
        }
        Ok(out)
    }

    /// Inserts new files and refreshes changed ones from their names alone; analysis fills in the rest.
    pub fn upsert_files(&self, source_id: i64, source_name: &str, files: &[ScannedFile]) -> DbResult<()> {
        let mut conn = self.write.lock();
        let tx = conn.transaction()?;
        {
            let mut insert = tx.prepare(
                "INSERT INTO samples(source_id, path, dir, name, ext, size, mtime, bpm, bpm_source, key_pc, key_mode, key_source, \
                 kind, category, auto_tags, status, added_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
            )?;
            let mut update = tx.prepare(
                "UPDATE samples SET size = ?, mtime = ?, bpm = ?, bpm_source = ?, key_pc = ?, key_mode = ?, key_source = ?, \
                 kind = ?, category = ?, auto_tags = ?, status = 0 WHERE id = ?",
            )?;
            let mut fts_del = tx.prepare("DELETE FROM samples_fts WHERE rowid = ?")?;
            let mut fts_ins = tx.prepare("INSERT INTO samples_fts(rowid, text) VALUES(?, ?)")?;
            let mut user_tags = tx.prepare("SELECT user_tags FROM samples WHERE id = ?")?;
            let added = now();
            for f in files {
                let dirs: Vec<&str> = f.dir.split('/').filter(|s| !s.is_empty()).collect();
                let r = meta::resolve(&meta::parse_name(&f.name, &dirs), &Default::default(), None);
                let (kpc, kmode) = r.key.map(|k| (Some(k.pc as i64), Some(k.mode as i64))).unwrap_or((None, None));
                let tags = join_tags(&r.tags);
                let id = match f.existing {
                    Some(id) => {
                        update.execute(params![
                            f.size, f.mtime, r.bpm, r.bpm_source as i64, kpc, kmode, r.key_source as i64, r.kind as i64,
                            r.category, tags, id
                        ])?;
                        fts_del.execute([id])?;
                        id
                    }
                    None => {
                        insert.execute(params![
                            source_id, f.path, f.dir, f.name, f.ext, f.size, f.mtime, r.bpm, r.bpm_source as i64, kpc,
                            kmode, r.key_source as i64, r.kind as i64, r.category, tags, added
                        ])?;
                        tx.last_insert_rowid()
                    }
                };
                let ut: String = user_tags.query_row([id], |r| r.get(0))?;
                fts_ins.execute(params![id, with_user_tags(&fts_text(source_name, &f.dir, &f.name, &f.ext, &r), &ut)])?;
            }
        }
        tx.commit()?;
        self.changed();
        Ok(())
    }

    pub fn delete_ids(&self, ids: &[i64]) -> DbResult<()> {
        let mut conn = self.write.lock();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare("DELETE FROM samples WHERE id = ?")?;
            for id in ids {
                stmt.execute([id])?;
            }
        }
        tx.commit()?;
        self.changed();
        Ok(())
    }

    /// Removes a file, or a folder and everything in it, from the index. `rel` is `path` relative
    /// to the source (`/`-separated).
    pub fn delete_under(&self, source_id: i64, path: &str, rel: &str) -> DbResult<usize> {
        let n = self
            .write
            .lock()
            .execute(&format!("DELETE FROM samples WHERE source_id = ?1 AND {UNDER}"), params![source_id, path, rel])?;
        self.changed();
        Ok(n)
    }

    /// Removes a subfolder of a source (relative, `/`-separated) and everything in it from the index.
    pub fn delete_dir(&self, source_id: i64, dir: &str) -> DbResult<usize> {
        let n = self.write.lock().execute(
            "DELETE FROM samples WHERE source_id = ?1 AND (dir = ?2 OR substr(dir, 1, length(?2) + 1) = ?2 || '/')",
            params![source_id, dir],
        )?;
        self.changed();
        Ok(n)
    }

    /// False once a sample has left the index (its folder was removed or excluded).
    pub fn has_sample(&self, id: i64) -> bool {
        self.read.lock().query_row("SELECT 1 FROM samples WHERE id = ?", [id], |_| Ok(())).optional().ok().flatten().is_some()
    }

    /// New or changed files, then files analyzed by an older version, oldest first.
    pub fn pending(&self, source_id: Option<i64>) -> DbResult<Vec<PendingFile>> {
        let conn = self.read.lock();
        let mut stmt = conn.prepare(
            "SELECT s.id, s.path, s.dir, s.name, s.ext, src.name, s.status FROM samples s JOIN sources src ON src.id = s.source_id \
             WHERE (s.status = 0 OR (s.status = 1 AND s.analysis_version < ?2)) AND src.online = 1 \
             AND (?1 IS NULL OR s.source_id = ?1) ORDER BY s.status, s.id",
        )?;
        let rows = stmt.query_map(params![source_id, analysis::VERSION], |r| {
            Ok(PendingFile {
                id: r.get(0)?,
                path: r.get(1)?,
                dir: r.get(2)?,
                name: r.get(3)?,
                ext: r.get(4)?,
                source_name: r.get(5)?,
                refresh: r.get::<_, i64>(6)? == 1,
            })
        })?;
        rows.collect()
    }

    /// Samples with a sound description (on connected drives), and samples still waiting for one.
    pub fn description_counts(&self) -> DbResult<(i64, i64)> {
        self.read.lock().query_row(
            "SELECT COALESCE(SUM(s.status = 1 AND s.features IS NOT NULL), 0), \
             COALESCE(SUM(s.status = 0 OR (s.status = 1 AND s.analysis_version < ?1)), 0) \
             FROM samples s JOIN sources src ON src.id = s.source_id WHERE src.online = 1",
            [analysis::VERSION],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
    }

    pub fn feature_rows(&self) -> DbResult<Vec<FeatureRow>> {
        let conn = self.read.lock();
        let mut stmt = conn.prepare(
            "SELECT s.id, s.kind, s.source_id, s.category, s.features FROM samples s JOIN sources src ON src.id = s.source_id \
             WHERE s.status = 1 AND s.features IS NOT NULL AND src.online = 1 ORDER BY s.id",
        )?;
        let rows = stmt.query_map([], |r| {
            let blob: Vec<u8> = r.get(4)?;
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, blob))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, kind, source_id, category, blob) = row?;
            if let Some(features) = features::from_blob(&blob) {
                out.push(FeatureRow { id, kind, source_id, category, features });
            }
        }
        Ok(out)
    }

    pub fn apply_analysis(&self, outcomes: &[AnalysisOutcome]) -> DbResult<()> {
        let mut conn = self.write.lock();
        let tx = conn.transaction()?;
        {
            let mut ok = tx.prepare(
                "UPDATE samples SET duration = ?, sample_rate = ?, channels = ?, bit_depth = ?, bpm = ?, bpm_source = ?, \
                 key_pc = ?, key_mode = ?, key_source = ?, kind = ?, category = ?, auto_tags = ?, peak_db = ?, loudness = ?, \
                 peaks = ?, features = ?, analysis_version = ?, status = 1 WHERE id = ?",
            )?;
            let mut failed = tx.prepare("UPDATE samples SET status = 2, analysis_version = ? WHERE id = ?")?;
            let mut fts_del = tx.prepare("DELETE FROM samples_fts WHERE rowid = ?")?;
            let mut fts_ins = tx.prepare("INSERT INTO samples_fts(rowid, text) VALUES(?, ?)")?;
            let mut user_tags = tx.prepare("SELECT user_tags FROM samples WHERE id = ?")?;
            for o in outcomes {
                match &o.result {
                    Ok((info, r, text)) => {
                        let (kpc, kmode) = r.key.map(|k| (Some(k.pc as i64), Some(k.mode as i64))).unwrap_or((None, None));
                        let changed = ok.execute(params![
                            info.duration,
                            info.sample_rate,
                            info.channels,
                            info.bit_depth,
                            r.bpm,
                            r.bpm_source as i64,
                            kpc,
                            kmode,
                            r.key_source as i64,
                            r.kind as i64,
                            r.category,
                            join_tags(&r.tags),
                            info.peak_db,
                            info.loudness,
                            info.peaks,
                            info.sound.as_ref().map(|s| features::to_blob(&s.features)),
                            analysis::VERSION,
                            o.id
                        ])?;
                        if changed > 0 {
                            let ut: String = user_tags.query_row([o.id], |r| r.get(0))?;
                            fts_del.execute([o.id])?;
                            fts_ins.execute(params![o.id, with_user_tags(text, &ut)])?;
                        }
                    }
                    Err(_) => {
                        failed.execute([analysis::VERSION, o.id])?;
                    }
                }
            }
        }
        tx.commit()?;
        self.changed();
        Ok(())
    }

    // ---- browsing ----

    pub fn query(&self, req: &QueryRequest) -> DbResult<QueryResult> {
        let parsed = query::parse_search(&req.filters);
        let w = query::build_where(&parsed, Omit::Nothing, now());
        let order = query::order_by(&req.sort, req.desc, w.has_text, req.seed, query::fit_mask(&parsed.filters));
        let conn = self.read.lock();
        let total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM samples s {} WHERE {}", w.join, w.clause),
            params_from_iter(w.params.iter()),
            |r| r.get(0),
        )?;
        let limit = req.limit.clamp(1, 1000);
        let offset = req.offset.max(0);
        let sql = format!(
            "SELECT {ROW_COLS} FROM samples s JOIN sources src ON src.id = s.source_id {} WHERE {} ORDER BY {} LIMIT {} OFFSET {}",
            w.join, w.clause, order, limit, offset
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(w.params.iter()), row_to_sample)?.collect::<DbResult<Vec<_>>>()?;
        Ok(QueryResult { total, offset, rows })
    }

    pub fn sample(&self, id: i64) -> DbResult<Option<SampleRow>> {
        let conn = self.read.lock();
        conn.query_row(
            &format!("SELECT {ROW_COLS} FROM samples s JOIN sources src ON src.id = s.source_id WHERE s.id = ?"),
            [id],
            row_to_sample,
        )
        .optional()
    }

    /// The notes in a sample's stored description, or None until it has one.
    pub fn pitch_profile(&self, id: i64) -> DbResult<Option<PitchProfile>> {
        let blob: Option<Vec<u8>> = self.read.lock().query_row("SELECT features FROM samples WHERE id = ?", [id], |r| r.get(0)).optional()?.flatten();
        Ok(blob.and_then(|b| features::from_blob(&b)).and_then(|f| features::pitch_profile(&f)))
    }

    /// Rows for these ids, in the same order (missing ones are skipped).
    pub fn samples_by_ids(&self, ids: &[i64]) -> DbResult<Vec<SampleRow>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.read.lock();
        let sql = format!(
            "SELECT {ROW_COLS} FROM samples s JOIN sources src ON src.id = s.source_id WHERE s.id IN ({})",
            vec!["?"; ids.len()].join(", ")
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut rows: HashMap<i64, SampleRow> =
            stmt.query_map(params_from_iter(ids.iter()), row_to_sample)?.map(|r| r.map(|s| (s.id, s))).collect::<DbResult<_>>()?;
        Ok(ids.iter().filter_map(|id| rows.remove(id)).collect())
    }

    /// Ids of every sample the filters match.
    pub fn matching_ids(&self, filters: &Filters) -> DbResult<Vec<i64>> {
        let parsed = query::parse_search(filters);
        let w = query::build_where(&parsed, Omit::Nothing, now());
        let conn = self.read.lock();
        let mut stmt = conn.prepare(&format!("SELECT s.id FROM samples s {} WHERE {}", w.join, w.clause))?;
        let rows = stmt.query_map(params_from_iter(w.params.iter()), |r| r.get(0))?;
        rows.collect()
    }

    /// Path and whether its drive is currently connected.
    pub fn sample_path(&self, id: i64) -> DbResult<Option<(String, bool)>> {
        self.read
            .lock()
            .query_row(
                "SELECT s.path, src.online FROM samples s JOIN sources src ON src.id = s.source_id WHERE s.id = ?",
                [id],
                |r| Ok((r.get(0)?, r.get::<_, i64>(1)? == 1)),
            )
            .optional()
    }

    pub fn ids_for_paths(&self, paths: &[String]) -> DbResult<Vec<i64>> {
        let conn = self.read.lock();
        let mut stmt = conn.prepare("SELECT id FROM samples WHERE path = ?")?;
        let mut ids = Vec::new();
        for p in paths {
            if let Some(id) = stmt.query_row([p], |r| r.get(0)).optional()? {
                ids.push(id);
            }
        }
        Ok(ids)
    }

    pub fn facets(&self, filters: &Filters) -> DbResult<Facets> {
        let parsed = query::parse_search(filters);
        let t = now();
        let conn = self.read.lock();
        let mut facets = Facets::default();

        let all = query::build_where(&parsed, Omit::Nothing, t);
        facets.total = conn.query_row(
            &format!("SELECT COUNT(*) FROM samples s {} WHERE {}", all.join, all.clause),
            params_from_iter(all.params.iter()),
            |r| r.get(0),
        )?;

        let w = query::build_where(&parsed, Omit::Kind, t);
        let mut stmt = conn.prepare(&format!("SELECT s.kind, COUNT(*) FROM samples s {} WHERE {} GROUP BY s.kind", w.join, w.clause))?;
        for row in stmt.query_map(params_from_iter(w.params.iter()), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
            let (kind, n) = row?;
            if kind == 1 { facets.loops = n } else { facets.oneshots = n }
        }

        let w = query::build_where(&parsed, Omit::Categories, t);
        let mut stmt = conn.prepare(&format!(
            "SELECT s.category, COUNT(*) FROM samples s {} WHERE {} AND s.category IS NOT NULL GROUP BY s.category",
            w.join, w.clause
        ))?;
        let mut cats: HashMap<String, i64> = HashMap::new();
        for row in stmt.query_map(params_from_iter(w.params.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            let (c, n) = row?;
            cats.insert(c, n);
        }
        facets.categories = meta::CATEGORIES.iter().filter_map(|(c, _)| cats.get(*c).map(|n| (c.to_string(), *n))).collect();

        let w = query::build_where(&parsed, Omit::Bpm, t);
        facets.bpm_hist = vec![0; BPM_HIST_BINS];
        let mut stmt = conn.prepare(&format!("SELECT s.bpm FROM samples s {} WHERE {} AND s.bpm IS NOT NULL", w.join, w.clause))?;
        for bpm in stmt.query_map(params_from_iter(w.params.iter()), |r| r.get::<_, f64>(0))? {
            let bin = ((bpm? - BPM_HIST_MIN) / BPM_HIST_STEP).floor();
            if bin >= 0.0 && (bin as usize) < BPM_HIST_BINS {
                facets.bpm_hist[bin as usize] += 1;
            }
        }

        let w = query::build_where(&parsed, Omit::Duration, t);
        facets.dur_hist = vec![0; DUR_HIST_BINS];
        let (lo, hi) = (DUR_HIST_MIN.ln(), DUR_HIST_MAX.ln());
        let mut stmt = conn.prepare(&format!("SELECT s.duration FROM samples s {} WHERE {} AND s.duration > 0", w.join, w.clause))?;
        for d in stmt.query_map(params_from_iter(w.params.iter()), |r| r.get::<_, f64>(0))? {
            let x = (d?.ln() - lo) / (hi - lo) * DUR_HIST_BINS as f64;
            facets.dur_hist[(x.floor().max(0.0) as usize).min(DUR_HIST_BINS - 1)] += 1;
        }

        let w = query::build_where(&parsed, Omit::Key, t);
        facets.keys = vec![0; 24];
        let mut stmt = conn.prepare(&format!(
            "SELECT s.key_pc * 2 + s.key_mode, COUNT(*) FROM samples s {} WHERE {} AND s.key_mode IN (0, 1) GROUP BY 1",
            w.join, w.clause
        ))?;
        for row in stmt.query_map(params_from_iter(w.params.iter()), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
            let (code, n) = row?;
            if (0..24).contains(&code) {
                facets.keys[code as usize] = n;
            }
        }

        let mut tag_counts: HashMap<String, i64> = HashMap::new();
        let mut stmt =
            conn.prepare(&format!("SELECT s.auto_tags, s.user_tags FROM samples s {} WHERE {}", all.join, all.clause))?;
        for row in stmt.query_map(params_from_iter(all.params.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (a, u) = row?;
            for t in split_tags(&a).into_iter().chain(split_tags(&u)) {
                *tag_counts.entry(t).or_default() += 1;
            }
        }
        let mut tags: Vec<(String, i64)> = tag_counts.into_iter().collect();
        tags.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        tags.truncate(16);
        facets.tags = tags;

        Ok(facets)
    }

    pub fn stats(&self) -> DbResult<LibraryStats> {
        let conn = self.read.lock();
        conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(favorite), 0), COALESCE(SUM(kind = 1), 0), COALESCE(SUM(kind = 0), 0), \
             COALESCE(SUM(added_at >= ?1), 0), COALESCE(SUM(last_played IS NOT NULL), 0) FROM samples",
            [now() - query::RECENT_DAYS * 86_400],
            |r| {
                Ok(LibraryStats {
                    total: r.get(0)?,
                    favorites: r.get(1)?,
                    loops: r.get(2)?,
                    oneshots: r.get(3)?,
                    recently_added: r.get(4)?,
                    played: r.get(5)?,
                })
            },
        )
    }

    /// Immediate subfolders of `parent` within a source, with recursive sample counts.
    pub fn dirs(&self, source_id: i64, parent: &str) -> DbResult<Vec<DirNode>> {
        let parent = parent.trim_matches('/');
        let conn = self.read.lock();
        let mut stmt = conn.prepare(
            "SELECT dir, COUNT(*) FROM samples WHERE source_id = ?1 \
             AND (?2 = '' OR dir = ?2 OR substr(dir, 1, length(?2) + 1) = ?2 || '/') GROUP BY dir",
        )?;
        let mut children: BTreeMap<String, (i64, bool)> = BTreeMap::new();
        for row in stmt.query_map(params![source_id, parent], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            let (dir, n) = row?;
            if dir == parent {
                continue;
            }
            let rest = if parent.is_empty() { dir.as_str() } else { &dir[parent.len() + 1..] };
            let mut segs = rest.splitn(2, '/');
            let child = segs.next().unwrap_or_default().to_string();
            let deeper = segs.next().is_some();
            let e = children.entry(child).or_insert((0, false));
            e.0 += n;
            e.1 |= deeper;
        }
        let mut out: Vec<DirNode> = children
            .into_iter()
            .map(|(name, (count, has_children))| DirNode {
                dir: if parent.is_empty() { name.clone() } else { format!("{parent}/{name}") },
                name,
                count,
                has_children,
            })
            .collect();
        out.sort_by_key(|d| d.name.to_lowercase());
        Ok(out)
    }

    // ---- user data ----

    pub fn set_favorite(&self, ids: &[i64], favorite: bool) -> DbResult<()> {
        let mut conn = self.write.lock();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare("UPDATE samples SET favorite = ? WHERE id = ?")?;
            for id in ids {
                stmt.execute(params![favorite as i64, id])?;
            }
        }
        tx.commit()
    }

    pub fn set_user_tags(&self, id: i64, tags: &[String]) -> DbResult<()> {
        let tags = query::normalize_tags(tags);
        let conn = self.write.lock();
        conn.execute("UPDATE samples SET user_tags = ? WHERE id = ?", params![join_tags(&tags), id])?;
        let text: Option<String> = conn.query_row("SELECT text FROM samples_fts WHERE rowid = ?", [id], |r| r.get(0)).optional()?;
        if let Some(text) = text {
            let base = text.split(" |user| ").next().unwrap_or_default();
            conn.execute("DELETE FROM samples_fts WHERE rowid = ?", [id])?;
            conn.execute("INSERT INTO samples_fts(rowid, text) VALUES(?, ?)", params![id, with_user_tags(base, &join_tags(&tags))])?;
        }
        Ok(())
    }

    pub fn user_tags(&self, id: i64) -> DbResult<Vec<String>> {
        let s: Option<String> = self.read.lock().query_row("SELECT user_tags FROM samples WHERE id = ?", [id], |r| r.get(0)).optional()?;
        Ok(s.map(|s| split_tags(&s)).unwrap_or_default())
    }

    pub fn mark_played(&self, id: i64) -> DbResult<()> {
        self.write.lock().execute("UPDATE samples SET play_count = play_count + 1, last_played = ? WHERE id = ?", params![now(), id])?;
        Ok(())
    }

    pub fn collections(&self) -> DbResult<Vec<Collection>> {
        let conn = self.read.lock();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.name, c.color, (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) \
             FROM collections c ORDER BY c.name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| Ok(Collection { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, count: r.get(3)? }))?;
        rows.collect()
    }

    pub fn create_collection(&self, name: &str, color: &str) -> DbResult<i64> {
        let conn = self.write.lock();
        conn.execute("INSERT INTO collections(name, color, created_at) VALUES(?, ?, ?)", params![name, color, now()])?;
        Ok(conn.last_insert_rowid())
    }

    pub fn update_collection(&self, id: i64, name: Option<&str>, color: Option<&str>) -> DbResult<()> {
        let conn = self.write.lock();
        if let Some(n) = name {
            conn.execute("UPDATE collections SET name = ? WHERE id = ?", params![n, id])?;
        }
        if let Some(c) = color {
            conn.execute("UPDATE collections SET color = ? WHERE id = ?", params![c, id])?;
        }
        Ok(())
    }

    pub fn delete_collection(&self, id: i64) -> DbResult<()> {
        self.write.lock().execute("DELETE FROM collections WHERE id = ?", [id])?;
        Ok(())
    }

    pub fn add_to_collection(&self, collection_id: i64, ids: &[i64]) -> DbResult<()> {
        let mut conn = self.write.lock();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare("INSERT OR IGNORE INTO collection_items(collection_id, sample_id, added_at) VALUES(?, ?, ?)")?;
            let t = now();
            for id in ids {
                stmt.execute(params![collection_id, id, t])?;
            }
        }
        tx.commit()
    }

    pub fn remove_from_collection(&self, collection_id: i64, ids: &[i64]) -> DbResult<()> {
        let mut conn = self.write.lock();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare("DELETE FROM collection_items WHERE collection_id = ? AND sample_id = ?")?;
            for id in ids {
                stmt.execute(params![collection_id, id])?;
            }
        }
        tx.commit()
    }

    pub fn sample_collections(&self, id: i64) -> DbResult<Vec<i64>> {
        let conn = self.read.lock();
        let mut stmt = conn.prepare("SELECT collection_id FROM collection_items WHERE sample_id = ?")?;
        let rows = stmt.query_map([id], |r| r.get(0))?;
        rows.collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scanned(dir: &str, name: &str) -> ScannedFile {
        ScannedFile {
            path: format!("/lib/{dir}/{name}.wav"),
            dir: dir.into(),
            name: name.into(),
            ext: "wav".into(),
            size: 100,
            mtime: 1,
            existing: None,
        }
    }

    fn open() -> (tempfile::TempDir, Db, i64) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("t.db")).unwrap();
        let src = db.add_source("/lib").unwrap();
        db.upsert_files(
            src,
            "lib",
            &[
                scanned("Nightdrive/Loops", "Nightdrive_Bass_Loop_124_Am"),
                scanned("Nightdrive/Loops", "Nightdrive_Arp_Loop_128_Em"),
                scanned("Dusty Drums/One Shots", "DT2_Kick_Dusty_03"),
                scanned("Dusty Drums/One Shots", "DT2_Snare_Crack_11"),
                scanned("Lo-Fi Keys", "LoFi_Keys_Rhodes_Loop_120_Gm"),
            ],
        )
        .unwrap();
        (dir, db, src)
    }

    fn names(db: &Db, filters: Filters) -> Vec<String> {
        let res = db.query(&QueryRequest { filters, sort: "name".into(), desc: false, offset: 0, limit: 100, seed: 0 }).unwrap();
        assert_eq!(res.total as usize, res.rows.len());
        res.rows.into_iter().map(|r| r.name).collect()
    }

    #[test]
    fn text_search_matches_names_and_folders() {
        let (_d, db, _) = open();
        assert_eq!(names(&db, Filters { text: "dusty kick".into(), ..Default::default() }), vec!["DT2_Kick_Dusty_03"]);
        assert_eq!(names(&db, Filters { text: "nightdrive".into(), ..Default::default() }).len(), 2);
        assert_eq!(names(&db, Filters { text: "lofi".into(), ..Default::default() }), vec!["LoFi_Keys_Rhodes_Loop_120_Gm"]);
        assert_eq!(names(&db, Filters { text: "one shots -snare".into(), ..Default::default() }), vec!["DT2_Kick_Dusty_03"]);
    }

    #[test]
    fn filters_by_kind_tempo_and_key() {
        let (_d, db, _) = open();
        let loops = names(&db, Filters { kind: Some("loop".into()), ..Default::default() });
        assert_eq!(loops.len(), 3);
        let f = Filters { bpm_min: Some(122.0), bpm_max: Some(126.0), ..Default::default() };
        assert_eq!(names(&db, f), vec!["Nightdrive_Bass_Loop_124_Am"]);
        let am = KeyFilter { pc: 9, mode: 1, compatible: true, include_unpitched: false, root_in_scale: true, scale: None, by_notes: false };
        assert_eq!(
            names(&db, Filters { key: Some(am.clone()), ..Default::default() }),
            vec!["Nightdrive_Arp_Loop_128_Em", "Nightdrive_Bass_Loop_124_Am"]
        );
        let exact = KeyFilter { compatible: false, include_unpitched: true, ..am };
        assert_eq!(names(&db, Filters { key: Some(exact), ..Default::default() }).len(), 3);
        assert_eq!(names(&db, Filters { text: "key:Gm".into(), ..Default::default() }), vec!["LoFi_Keys_Rhodes_Loop_120_Gm"]);
        // A Phrygian has the notes of F major, so G minor fits and E minor doesn't.
        let phrygian = KeyFilter { scale: Some(vec![0, 1, 3, 5, 7, 8, 10]), ..am };
        assert_eq!(
            names(&db, Filters { key: Some(phrygian), ..Default::default() }),
            vec!["LoFi_Keys_Rhodes_Loop_120_Gm", "Nightdrive_Bass_Loop_124_Am"]
        );
    }

    /// Stores a description whose pitch profile is `chroma`, the way analysis would.
    fn describe_as(db: &Db, name: &str, chroma: [f32; 12]) -> i64 {
        let mut f = vec![f32::NAN; features::LEN];
        f[features::CHROMA].copy_from_slice(&chroma);
        let conn = db.write.lock();
        conn.execute("UPDATE samples SET features = ?, status = 1 WHERE name = ?", params![features::to_blob(&f), name]).unwrap();
        conn.query_row("SELECT id FROM samples WHERE name = ?", [name], |r| r.get(0)).unwrap()
    }

    #[test]
    fn keyless_samples_pass_when_their_notes_fit() {
        let (_d, db, _) = open();
        // A kick tuned to A (with its fifth ringing) and a snare that's all noise; neither has a key.
        let mut a = [0.01f32; 12];
        a[9] = 0.6;
        a[4] = 0.3;
        let kick = describe_as(&db, "DT2_Kick_Dusty_03", a);
        describe_as(&db, "DT2_Snare_Crack_11", [1.0 / 12.0; 12]);
        // An E minor arp with a little C♯ in it: it fits A minor, a little less well.
        let mut e = [0.01f32; 12];
        e[4] = 0.7;
        e[11] = 0.1;
        e[1] = 0.1;
        describe_as(&db, "Nightdrive_Arp_Loop_128_Em", e);

        let am = KeyFilter { pc: 9, mode: 1, compatible: false, include_unpitched: false, root_in_scale: true, scale: None, by_notes: false };
        assert_eq!(names(&db, Filters { key: Some(am.clone()), ..Default::default() }), vec!["Nightdrive_Bass_Loop_124_Am"]);
        let by_notes = KeyFilter { by_notes: true, ..am.clone() };
        assert_eq!(names(&db, Filters { key: Some(by_notes.clone()), ..Default::default() }), vec!["DT2_Kick_Dusty_03", "Nightdrive_Bass_Loop_124_Am"]);
        // D♭ major has neither A nor E, so the kick doesn't fit it.
        let d_flat = KeyFilter { pc: 1, mode: 0, ..by_notes.clone() };
        assert!(!names(&db, Filters { key: Some(d_flat), ..Default::default() }).contains(&"DT2_Kick_Dusty_03".to_string()));
        assert_eq!(db.facets(&Filters { key: Some(by_notes), ..Default::default() }).unwrap().total, 2);

        // Sorting by fit puts the best-fitting profiles first and undescribed samples last.
        let everything = KeyFilter { include_unpitched: true, compatible: true, ..am };
        let fit = db.query(&QueryRequest { filters: Filters { key: Some(everything), ..Default::default() }, sort: "fit".into(), desc: false, offset: 0, limit: 10, seed: 0 }).unwrap();
        let order: Vec<&str> = fit.rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(order[..3], ["DT2_Kick_Dusty_03", "Nightdrive_Arp_Loop_128_Em", "DT2_Snare_Crack_11"], "{order:?}");
        // Without a key there's nothing to fit, so the usual order applies.
        assert!(db.query(&QueryRequest { filters: Filters::default(), sort: "fit".into(), desc: false, offset: 0, limit: 10, seed: 0 }).is_ok());

        let p = db.pitch_profile(kick).unwrap().unwrap();
        assert_eq!(p.chroma, a);
        assert_eq!((p.hz, p.clarity, p.tonality), (None, 0.0, 0.0));
        assert!(db.pitch_profile(99_999).unwrap().is_none());
    }

    #[test]
    fn folders_favorites_and_collections() {
        let (_d, db, src) = open();
        let f = Filters { source_id: Some(src), dir: Some("Nightdrive".into()), ..Default::default() };
        assert_eq!(names(&db, f).len(), 2);
        let dirs = db.dirs(src, "").unwrap();
        assert_eq!(dirs.iter().map(|d| (d.name.as_str(), d.count, d.has_children)).collect::<Vec<_>>(), vec![
            ("Dusty Drums", 2, true),
            ("Lo-Fi Keys", 1, false),
            ("Nightdrive", 2, true)
        ]);

        let all = db.query(&QueryRequest { filters: Filters::default(), sort: "name".into(), desc: false, offset: 0, limit: 10, seed: 0 }).unwrap();
        let kick = all.rows.iter().find(|r| r.name.contains("Kick")).unwrap().id;
        db.set_favorite(&[kick], true).unwrap();
        assert_eq!(names(&db, Filters { favorites: true, ..Default::default() }), vec!["DT2_Kick_Dusty_03"]);

        let c = db.create_collection("Go-to kicks", "violet").unwrap();
        db.add_to_collection(c, &[kick]).unwrap();
        assert_eq!(db.collections().unwrap()[0].count, 1);
        assert_eq!(names(&db, Filters { collection_id: Some(c), ..Default::default() }), vec!["DT2_Kick_Dusty_03"]);

        db.set_user_tags(kick, &["Go To".into(), "punchy".into()]).unwrap();
        assert_eq!(db.user_tags(kick).unwrap(), vec!["go-to", "punchy"]);
        assert_eq!(names(&db, Filters { tags: vec!["punchy".into()], ..Default::default() }), vec!["DT2_Kick_Dusty_03"]);
        assert_eq!(names(&db, Filters { text: "punchy".into(), ..Default::default() }), vec!["DT2_Kick_Dusty_03"]);

        let facets = db.facets(&Filters::default()).unwrap();
        assert_eq!(facets.total, 5);
        assert_eq!(facets.loops, 3);
        assert!(facets.categories.iter().any(|(c, n)| c == "Kick" && *n == 1));
        assert_eq!(facets.bpm_hist.iter().sum::<i64>(), 3);

        db.delete_under(src, "/lib/Nightdrive", "Nightdrive").unwrap();
        assert_eq!(names(&db, Filters { text: "nightdrive".into(), ..Default::default() }).len(), 0);

        // Excluding a folder covers the ones inside it; "Dusty Drums 2" is a different folder.
        db.set_excluded(src, "Dusty Drums/One Shots", true).unwrap();
        db.set_excluded(src, "Dusty Drums 2", true).unwrap();
        db.set_excluded(src, "Dusty Drums", true).unwrap();
        assert_eq!(db.source(src).unwrap().unwrap().excluded, vec!["Dusty Drums", "Dusty Drums 2"]);
        assert_eq!(db.delete_dir(src, "Dusty Drums").unwrap(), 2);
        assert!(!db.has_sample(kick));
        assert_eq!(names(&db, Filters::default()), vec!["LoFi_Keys_Rhodes_Loop_120_Gm"]);
        db.set_excluded(src, "Dusty Drums", false).unwrap();
        assert_eq!(db.source(src).unwrap().unwrap().excluded, vec!["Dusty Drums 2"]);
    }

    #[test]
    fn paths_match_under_a_folder_with_either_separator() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("t.db")).unwrap();
        // Stored paths use the platform's separator; `dir` is `/`-separated everywhere.
        for (root, sep) in [("/lib", "/"), (r"C:\Samples", r"\")] {
            let src = db.add_source(root).unwrap();
            let at = |rel: &str| format!("{root}{sep}{}", rel.replace('/', sep));
            let file = |rel: &str| {
                let (d, name) = rel.rsplit_once('/').unwrap_or(("", rel));
                ScannedFile {
                    path: at(&format!("{rel}.wav")),
                    dir: d.into(),
                    name: name.into(),
                    ext: "wav".into(),
                    size: 100,
                    mtime: 1,
                    existing: None,
                }
            };
            let files = [file("Pack/Loops/a"), file("Pack/Loops/b"), file("Pack/c"), file("Pack 2/d"), file("e")];
            db.upsert_files(src, "lib", &files).unwrap();
            let under = |rel: &str| {
                let mut found: Vec<String> = db.files_under(src, Some((&at(rel), rel))).unwrap().into_keys().collect();
                found.sort();
                found
            };

            assert_eq!(db.files_under(src, None).unwrap().len(), 5);
            // "Pack 2" only shares a prefix with "Pack".
            assert_eq!(under("Pack"), vec![at("Pack/Loops/a.wav"), at("Pack/Loops/b.wav"), at("Pack/c.wav")], "{sep}");
            assert_eq!(under("Pack/Loops"), vec![at("Pack/Loops/a.wav"), at("Pack/Loops/b.wav")], "{sep}");
            assert_eq!(under("Pack/Loops/a.wav"), vec![at("Pack/Loops/a.wav")], "{sep}");
            assert_eq!(under("e.wav"), vec![at("e.wav")], "{sep}");
            assert!(under("Pac").is_empty(), "{sep}");

            assert_eq!(db.delete_under(src, &at("Pack/Loops/a.wav"), "Pack/Loops/a.wav").unwrap(), 1, "{sep}");
            assert_eq!(db.delete_under(src, &at("Pack"), "Pack").unwrap(), 2, "{sep}");
            assert_eq!(db.delete_under(src, &at("Pack"), "Pack").unwrap(), 0, "{sep}");
            let mut left: Vec<String> = db.files_under(src, None).unwrap().into_keys().collect();
            left.sort();
            assert_eq!(left, vec![at("Pack 2/d.wav"), at("e.wav")], "{sep}");
        }
    }
}
