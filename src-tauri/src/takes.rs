//! The takes tray: unsaved takes wait in Saga's own folder until they're saved into the saved sounds
//! folder's Recordings (which joins the library), dragged out (which saves them too) or moved to the
//! Trash. Nothing here is ever deleted for good.

use crate::db::{now, Db};
use crate::indexer::{mtime_secs, rel_dir, Indexer};
use crate::model::SampleRow;
use crate::render::{self, RECORDINGS_DIR};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Where unsaved takes live, and the hidden library source that holds them.
#[derive(Clone)]
pub struct Takes {
    pub dir: PathBuf,
    pub source: i64,
}

/// What "Clear after a week" means.
pub const WEEK: i64 = 7 * 86_400;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeList {
    /// Samples from this source are unsaved takes.
    pub source_id: i64,
    /// Unsaved takes, newest first.
    pub rows: Vec<SampleRow>,
    /// Space they take on disk.
    pub bytes: u64,
}

pub fn list(db: &Db, takes: &Takes) -> Result<TakeList, String> {
    let rows = db.takes(takes.source).map_err(|e| e.to_string())?;
    let bytes = rows.iter().filter_map(|r| std::fs::metadata(&r.path).ok()).map(|m| m.len()).sum();
    Ok(TakeList { source_id: takes.source, rows, bytes })
}

/// Moves an unsaved take into the saved sounds folder's Recordings and into the library, keeping its
/// id (and so its tempo and key set by hand). A take that's already saved is returned as it is.
pub fn save(db: &Db, indexer: &Indexer, takes: &Takes, saved_root: &Path, id: i64) -> Result<SampleRow, String> {
    let row = db.sample(id).map_err(|e| e.to_string())?.ok_or("That take is gone")?;
    if row.source_id != takes.source {
        return Ok(row);
    }
    let dir = saved_root.join(RECORDINGS_DIR);
    let src = PathBuf::from(&row.path);
    let name = src.file_name().map(|n| n.to_string_lossy().to_string()).ok_or("That take has no file")?;
    let added_source = {
        let _hold = indexer.hold_rescans();
        let dest = render::keep(&src, &dir, &name).map_err(|e| format!("Couldn't save the take: {e}"))?;
        // The library folder that already holds Recordings (the saved sounds folder, say), or Recordings itself.
        let sources = db.sources().map_err(|e| e.to_string())?;
        let (source_id, root, added) = match sources.iter().find(|s| dir.starts_with(&s.path)) {
            Some(s) => (s.id, PathBuf::from(&s.path), false),
            None => (db.add_source(&dir.to_string_lossy()).map_err(|e| e.to_string())?, dir.clone(), true),
        };
        let md = std::fs::metadata(&dest).map_err(|e| e.to_string())?;
        // "Chrome 14.32.07 2" when Recordings already has a take by that name.
        let stem = dest.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| row.name.clone());
        db.move_sample(id, source_id, &dest.to_string_lossy(), &rel_dir(&root, &dest), &stem, md.len() as i64, mtime_secs(&md))
            .map_err(|e| e.to_string())?;
        added.then_some(dir.clone())
    };
    // Scanned and watched from now on; the moved take is already known, so the scan leaves it be.
    if let Some(dir) = added_source {
        indexer.add_source(&dir.to_string_lossy(), &[])?;
    }
    db.sample(id).map_err(|e| e.to_string())?.ok_or_else(|| "That take is gone".into())
}

/// Moves takes to the Trash: unsaved ones, and saved ones still in Recordings. Anything else in the
/// library is left alone. Returns how many went.
pub fn trash(db: &Db, takes: &Takes, saved_root: &Path, ids: &[i64]) -> Result<usize, String> {
    let recordings = saved_root.join(RECORDINGS_DIR);
    let rows: Vec<SampleRow> = db
        .samples_by_ids(ids)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|r| r.source_id == takes.source || Path::new(&r.path).starts_with(&recordings))
        .collect();
    if rows.is_empty() {
        return Ok(0);
    }
    let paths: Vec<PathBuf> = rows.iter().map(|r| PathBuf::from(&r.path)).collect();
    let result = render::move_to_trash(&paths);
    // The Trash can take some files and refuse others, so look at what's actually gone.
    let gone: Vec<i64> = rows.iter().filter(|r| !Path::new(&r.path).exists()).map(|r| r.id).collect();
    db.delete_ids(&gone).map_err(|e| e.to_string())?;
    match result {
        Err(e) if gone.is_empty() => Err(format!("Couldn't move the takes to the Trash: {e}")),
        _ => Ok(gone.len()),
    }
}

/// Moves unsaved takes older than `max_age` seconds (all of them for `None`) to the Trash.
pub fn clear_unsaved(db: &Db, takes: &Takes, saved_root: &Path, max_age: Option<i64>) -> Result<usize, String> {
    let cutoff = max_age.map(|a| now() - a);
    let ids: Vec<i64> = db
        .takes(takes.source)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|r| cutoff.is_none_or(|c| r.added < c))
        .map(|r| r.id)
        .collect();
    trash(db, takes, saved_root, &ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn write_wav(path: &Path) {
        let spec = hound::WavSpec { channels: 1, sample_rate: 44_100, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for i in 0..22_050 {
            w.write_sample(((i as f32 * 0.05).sin() * 9000.0) as i16).unwrap();
        }
        w.finalize().unwrap();
    }

    #[test]
    fn a_saved_take_moves_into_recordings_and_the_library() {
        let data = tempfile::tempdir().unwrap();
        let music = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&data.path().join("t.db")).unwrap());
        let indexer = Indexer::start(db.clone(), Arc::new(|_, _| {}));
        let dir = data.path().join("Takes");
        std::fs::create_dir_all(&dir).unwrap();
        let takes = Takes { source: db.takes_source(&dir.to_string_lossy()).unwrap(), dir: dir.clone() };
        let file = dir.join("Chrome 14.32.07.wav");
        write_wav(&file);
        let id = indexer.add_file_now(takes.source, "Takes", &dir, &file).unwrap();

        // Unsaved, it's a take but not part of the library.
        assert_eq!(list(&db, &takes).unwrap().rows.len(), 1);
        assert!(db.sources().unwrap().is_empty());
        assert_eq!(db.stats().unwrap().total, 0);

        let saved = save(&db, &indexer, &takes, music.path(), id).unwrap();
        assert_eq!(saved.id, id);
        assert_eq!(Path::new(&saved.path), music.path().join("Recordings/Chrome 14.32.07.wav"));
        assert!(!file.exists() && Path::new(&saved.path).exists());
        assert!(list(&db, &takes).unwrap().rows.is_empty());
        assert_eq!(db.sources().unwrap()[0].name, "Recordings");
        assert_eq!(db.stats().unwrap().total, 1);
        // Saving again changes nothing.
        assert_eq!(save(&db, &indexer, &takes, music.path(), id).unwrap().path, saved.path);

        // A take whose name Recordings already has gets a free one, and its row says so.
        let again = dir.join("Chrome 14.32.07.wav");
        write_wav(&again);
        let id2 = indexer.add_file_now(takes.source, "Takes", &dir, &again).unwrap();
        let second = save(&db, &indexer, &takes, music.path(), id2).unwrap();
        assert_eq!((second.name.as_str(), Path::new(&second.path)), ("Chrome 14.32.07 2", music.path().join("Recordings/Chrome 14.32.07 2.wav").as_path()));
    }
}
