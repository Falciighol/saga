//! Renaming sample files where they are. Only ever run when the user asks, from the Rename dialog,
//! and every rename can be undone by renaming back.
//!
//! A batch moves in two passes: each file first steps aside to a temporary name next to itself,
//! then takes its new name. That lets files trade names, as when a folder is numbered again ("Hats 2"
//! becomes "Hats 1" while "Hats 1" becomes "Hats 3"). Nothing is ever written over: a file whose new
//! name is still taken after the first pass goes back to its old name and reports why.

use crate::db::Db;
use crate::model::{RenameOutcome, RenameRequest, SampleRow};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Added to a file's path while it waits for its new name. It isn't an audio extension, so the
/// indexer never takes the file for a new sample.
const TEMP_SUFFIX: &str = ".saga-renaming";

/// A new file name (without its extension) as typed, or why it can't be one on macOS or Windows.
/// Mirrors `nameProblem` in src/lib/rename.ts.
pub fn valid_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("The new name is empty".into());
    }
    if n.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control()) {
        return Err("Names can't contain / \\ : * ? \" < > |".into());
    }
    if n.starts_with('.') || n.ends_with('.') {
        return Err("Names can't start or end with a dot".into());
    }
    if n.len() > 200 {
        return Err("That name is too long".into());
    }
    let upper = n.to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&upper.as_str())
        || ((upper.starts_with("COM") || upper.starts_with("LPT")) && upper.len() == 4 && upper.as_bytes()[3].is_ascii_digit());
    if reserved {
        return Err("Windows keeps that name for itself".into());
    }
    Ok(n.to_string())
}

/// Renames the files of these samples and points the library at the new names, keeping each
/// sample's id and so its favorite, tags, collections and edits. One outcome per request, in order.
pub fn rename_samples(db: &Db, rows: &HashMap<i64, SampleRow>, requests: &[RenameRequest]) -> Vec<RenameOutcome> {
    let mut moves: Vec<Move> = requests.iter().map(|r| plan(r.id, rows.get(&r.id), &r.name)).collect();
    fail_taken_names(&mut moves);
    step_aside(&mut moves);
    take_new_names(&mut moves);

    let done: Vec<(i64, String, String)> =
        moves.iter().filter(|m| matches!(m.stage, Stage::Done)).map(|m| (m.id, m.to.to_string_lossy().to_string(), m.to_name.clone())).collect();
    if let Err(e) = db.rename_samples(&done) {
        // The library still has the old names, so the files go back to them.
        let why = format!("Couldn't rename it: {e}");
        for m in moves.iter_mut().filter(|m| matches!(m.stage, Stage::Done)) {
            std::mem::swap(&mut m.from, &mut m.to);
            m.stage = Stage::Waiting;
        }
        step_aside(&mut moves);
        take_new_names(&mut moves);
        for m in moves.iter_mut().filter(|m| matches!(m.stage, Stage::Done)) {
            m.stage = Stage::Failed(why.clone());
        }
    }
    moves.into_iter().map(Move::outcome).collect()
}

enum Stage {
    /// Still under its old name, about to move.
    Waiting,
    /// Under its temporary name.
    Aside,
    Done,
    Unchanged,
    Failed(String),
}

struct Move {
    id: i64,
    from_name: String,
    to_name: String,
    from: PathBuf,
    to: PathBuf,
    temp: PathBuf,
    /// Whether Ableton's analysis file is moving along with the sample.
    asd: bool,
    stage: Stage,
}

impl Move {
    fn outcome(self) -> RenameOutcome {
        let error = match self.stage {
            Stage::Failed(e) => Some(e),
            _ => None,
        };
        RenameOutcome { id: self.id, from: self.from_name, to: self.to_name, error }
    }
}

fn plan(id: i64, row: Option<&SampleRow>, name: &str) -> Move {
    let mut m = Move {
        id,
        from_name: String::new(),
        to_name: name.to_string(),
        from: PathBuf::new(),
        to: PathBuf::new(),
        temp: PathBuf::new(),
        asd: false,
        stage: Stage::Waiting,
    };
    let Some(row) = row else {
        m.stage = Stage::Failed("No longer in the library".into());
        return m;
    };
    m.from_name = row.name.clone();
    if !row.online {
        m.stage = Stage::Failed("This sample's drive isn't connected".into());
        return m;
    }
    let new = match valid_name(name) {
        Ok(n) => n,
        Err(e) => {
            m.stage = Stage::Failed(e);
            return m;
        }
    };
    m.to_name = new.clone();
    if new == row.name {
        m.stage = Stage::Unchanged;
        return m;
    }
    m.from = PathBuf::from(&row.path);
    if !m.from.is_file() {
        m.stage = Stage::Failed("The file isn't there any more".into());
        return m;
    }
    // Keep the extension exactly as it was ("WAV" stays "WAV").
    let file_name = match m.from.extension() {
        Some(ext) => format!("{new}.{}", ext.to_string_lossy()),
        None => new,
    };
    m.to = m.from.with_file_name(file_name);
    m
}

/// Paths compared the way macOS and Windows drives do by default, ignoring case. Comparing this way
/// on a drive that doesn't ignore case is still safe: the second pass never writes over a file.
fn key(p: &Path) -> String {
    p.to_string_lossy().to_lowercase()
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

fn sidecar(p: &Path) -> PathBuf {
    PathBuf::from(format!("{}.asd", p.to_string_lossy()))
}

/// Moves a file without ever replacing one (a plain rename replaces on both macOS and Windows).
fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if to.exists() {
        return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, format!("there's already a file called {}", file_name(to))));
    }
    std::fs::rename(from, to)
}

/// Before anything moves: a new name can't go to two files, and can't be one that a file staying
/// put already has. A file that can't move keeps its name taken, so this repeats until it settles.
fn fail_taken_names(moves: &mut [Move]) {
    let mut claimed = HashSet::new();
    for m in moves.iter_mut().filter(|m| matches!(m.stage, Stage::Waiting)) {
        if !claimed.insert(key(&m.to)) {
            m.stage = Stage::Failed("Another file here is getting the same name".into());
        }
    }
    loop {
        let leaving: HashSet<String> = moves.iter().filter(|m| matches!(m.stage, Stage::Waiting)).map(|m| key(&m.from)).collect();
        let mut changed = false;
        for m in moves.iter_mut().filter(|m| matches!(m.stage, Stage::Waiting)) {
            if m.to.exists() && !leaving.contains(&key(&m.to)) {
                m.stage = Stage::Failed(format!("There's already a file called {}", file_name(&m.to)));
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
}

/// The first pass: every waiting file steps aside to a temporary name.
fn step_aside(moves: &mut [Move]) {
    for m in moves.iter_mut().filter(|m| matches!(m.stage, Stage::Waiting)) {
        let base = format!("{}{TEMP_SUFFIX}", m.from.to_string_lossy());
        let mut temp = PathBuf::from(&base);
        let mut n = 1;
        while temp.exists() || sidecar(&temp).exists() {
            temp = PathBuf::from(format!("{base}{n}"));
            n += 1;
        }
        if let Err(e) = move_file(&m.from, &temp) {
            m.stage = Stage::Failed(format!("Couldn't rename it: {e}"));
            continue;
        }
        // The analysis file comes along when it can; the sample doesn't depend on it.
        let asd = sidecar(&m.from);
        m.asd = asd.is_file() && move_file(&asd, &sidecar(&temp)).is_ok();
        m.temp = temp;
        m.stage = Stage::Aside;
    }
}

/// Puts a file that stepped aside back under its old name.
fn put_back(m: &mut Move, why: String) {
    let back = move_file(&m.temp, &m.from);
    if m.asd {
        let _ = move_file(&sidecar(&m.temp), &sidecar(&m.from));
    }
    m.stage = Stage::Failed(match back {
        Ok(()) => why,
        Err(e) => format!("{why}. It's been left as {}: {e}", file_name(&m.temp)),
    });
}

/// The second pass. A file whose new name is still taken (by a file that couldn't move) goes back
/// first, which can free or take other names, so that settles before anything takes a new name.
fn take_new_names(moves: &mut [Move]) {
    loop {
        let mut changed = false;
        for m in moves.iter_mut().filter(|m| matches!(m.stage, Stage::Aside)) {
            if m.to.exists() {
                let why = format!("There's already a file called {}", file_name(&m.to));
                put_back(m, why);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    for m in moves.iter_mut().filter(|m| matches!(m.stage, Stage::Aside)) {
        if let Err(e) = move_file(&m.temp, &m.to) {
            put_back(m, format!("Couldn't rename it: {e}"));
            continue;
        }
        if m.asd && move_file(&sidecar(&m.temp), &sidecar(&m.to)).is_err() {
            let _ = move_file(&sidecar(&m.temp), &sidecar(&m.from));
        }
        m.stage = Stage::Done;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::ScannedFile;

    #[test]
    fn names_that_cannot_be_file_names() {
        assert_eq!(valid_name("  Loop_124_Am "), Ok("Loop_124_Am".into()));
        assert_eq!(valid_name("Kick 124.5 BPM"), Ok("Kick 124.5 BPM".into()));
        for bad in ["", "   ", "a/b", "a\\b", "what?", "a:b", ".hidden", "trailing.", "con", "LPT1"] {
            assert!(valid_name(bad).is_err(), "{bad:?}");
        }
        assert!(valid_name("Console").is_ok() && valid_name("COM10").is_ok());
    }

    /// A library with these files in "Pack" (names with extensions), indexed except `.asd` files.
    struct Lib {
        _lib: tempfile::TempDir,
        _data: tempfile::TempDir,
        dir: PathBuf,
        db: Db,
    }

    impl Lib {
        fn new(files: &[&str]) -> Lib {
            let lib = tempfile::tempdir().unwrap();
            let data = tempfile::tempdir().unwrap();
            let dir = lib.path().join("Pack");
            std::fs::create_dir_all(&dir).unwrap();
            for f in files {
                std::fs::write(dir.join(f), f.as_bytes()).unwrap();
            }
            let db = Db::open(&data.path().join("t.db")).unwrap();
            let src = db.add_source(&lib.path().to_string_lossy()).unwrap();
            let scanned: Vec<ScannedFile> = files
                .iter()
                .filter(|f| !f.ends_with(".asd"))
                .map(|f| {
                    let (name, ext) = f.rsplit_once('.').unwrap();
                    ScannedFile {
                        path: dir.join(f).to_string_lossy().to_string(),
                        dir: "Pack".into(),
                        name: name.into(),
                        ext: ext.to_lowercase(),
                        size: 1,
                        mtime: 1,
                        created: None,
                        existing: None,
                    }
                })
                .collect();
            db.upsert_files(src, "lib", &scanned).unwrap();
            Lib { _lib: lib, _data: data, dir, db }
        }

        fn id(&self, file: &str) -> i64 {
            self.db.ids_for_paths(&[self.dir.join(file).to_string_lossy().to_string()]).unwrap()[0]
        }

        fn rename(&self, renames: &[(i64, &str)]) -> Vec<RenameOutcome> {
            let ids: Vec<i64> = renames.iter().map(|r| r.0).collect();
            let rows = self.db.samples_by_ids(&ids).unwrap().into_iter().map(|r| (r.id, r)).collect();
            let requests: Vec<RenameRequest> = renames.iter().map(|&(id, name)| RenameRequest { id, name: name.into() }).collect();
            rename_samples(&self.db, &rows, &requests)
        }

        /// The file names in the folder, sorted.
        fn files(&self) -> Vec<String> {
            let mut out: Vec<String> = std::fs::read_dir(&self.dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect();
            out.sort();
            out
        }

        /// What a file holds: each test file starts out holding its own first name.
        fn holds(&self, file: &str) -> String {
            std::fs::read_to_string(self.dir.join(file)).unwrap()
        }
    }

    #[test]
    fn renames_files_where_they_are() {
        let lib = Lib::new(&["Bass Loop.WAV", "Bass Loop.WAV.asd", "Taken_120_C.WAV", "Kick.wav"]);
        let (bass, kick) = (lib.id("Bass Loop.WAV"), lib.id("Kick.wav"));

        // The extension stays as it was, and Ableton's analysis file follows the sample.
        let out = lib.rename(&[(bass, "Bass Loop_120_C")]);
        assert_eq!((out[0].from.as_str(), out[0].to.as_str(), out[0].error.clone()), ("Bass Loop", "Bass Loop_120_C", None));
        assert_eq!(lib.files(), ["Bass Loop_120_C.WAV", "Bass Loop_120_C.WAV.asd", "Kick.wav", "Taken_120_C.WAV"]);
        let row = lib.db.sample(bass).unwrap().unwrap();
        assert_eq!((row.name.as_str(), row.path), ("Bass Loop_120_C", lib.dir.join("Bass Loop_120_C.WAV").to_string_lossy().to_string()));

        // Another file already has the name: nothing changes.
        assert!(lib.rename(&[(bass, "Taken_120_C")])[0].error.as_deref().unwrap().contains("already a file"));
        assert_eq!(lib.holds("Taken_120_C.WAV"), "Taken_120_C.WAV");
        assert!(lib.dir.join("Bass Loop_120_C.WAV").is_file());
        // A change of case alone works, even where the drive ignores case.
        assert_eq!(lib.rename(&[(kick, "KICK")])[0].error, None);
        assert!(lib.files().contains(&"KICK.wav".to_string()) && !lib.files().contains(&"Kick.wav".to_string()));
        // Unchanged names are left alone.
        let out = lib.rename(&[(kick, " KICK ")]);
        assert_eq!((out[0].to.as_str(), out[0].error.clone()), ("KICK", None));
    }

    #[test]
    fn files_trade_names() {
        let lib = Lib::new(&["Hats 1.wav", "Hats 2.wav", "Hats 2.wav.asd", "Snare.wav"]);
        let (one, two, snare) = (lib.id("Hats 1.wav"), lib.id("Hats 2.wav"), lib.id("Snare.wav"));
        lib.db.set_favorite(&[two], true).unwrap();

        // Numbered again: 2 → 1, 1 → 2, and Snare takes the 3 nobody had.
        let out = lib.rename(&[(two, "Hats 1"), (one, "Hats 2"), (snare, "Hats 3")]);
        assert!(out.iter().all(|o| o.error.is_none()), "{:?}", out.iter().map(|o| &o.error).collect::<Vec<_>>());
        assert_eq!(lib.files(), ["Hats 1.wav", "Hats 1.wav.asd", "Hats 2.wav", "Hats 3.wav"]);
        assert_eq!((lib.holds("Hats 1.wav"), lib.holds("Hats 2.wav"), lib.holds("Hats 3.wav")), ("Hats 2.wav".into(), "Hats 1.wav".into(), "Snare.wav".into()));
        // Each sample kept its id, so the favorite went with the file.
        let row = lib.db.sample(two).unwrap().unwrap();
        assert_eq!((row.name.as_str(), row.favorite), ("Hats 1", true));
        assert_eq!(lib.db.sample(one).unwrap().unwrap().name, "Hats 2");

        // Undo is the same trade back.
        let undo: Vec<(i64, String)> = out.iter().map(|o| (o.id, o.from.clone())).collect();
        let out = lib.rename(&undo.iter().map(|(id, n)| (*id, n.as_str())).collect::<Vec<_>>());
        assert!(out.iter().all(|o| o.error.is_none()));
        assert_eq!(lib.files(), ["Hats 1.wav", "Hats 2.wav", "Hats 2.wav.asd", "Snare.wav"]);
        assert_eq!(lib.holds("Hats 2.wav"), "Hats 2.wav");
    }

    #[test]
    fn a_file_that_cannot_move_keeps_its_name_taken() {
        let lib = Lib::new(&["A.wav", "B.wav", "C.wav", "Kept.wav"]);
        let (a, b, c) = (lib.id("A.wav"), lib.id("B.wav"), lib.id("C.wav"));

        // C can't become "Kept" (a file staying put has it), so C keeps its name, so B can't take
        // "C", so B keeps its name and A can't take "B". Everything stays as it was.
        let out = lib.rename(&[(a, "B"), (b, "C"), (c, "Kept")]);
        assert!(out.iter().all(|o| o.error.as_deref().is_some_and(|e| e.contains("already a file"))), "{:?}", out.iter().map(|o| &o.error).collect::<Vec<_>>());
        assert_eq!(lib.files(), ["A.wav", "B.wav", "C.wav", "Kept.wav"]);
        assert_eq!(lib.holds("A.wav"), "A.wav");

        // Two files can't take one name: the first one asking gets it.
        let out = lib.rename(&[(a, "Same"), (b, "same")]);
        assert_eq!(out[0].error, None);
        assert!(out[1].error.as_deref().unwrap().contains("same name"));
        assert_eq!(lib.files(), ["B.wav", "C.wav", "Kept.wav", "Same.wav"]);
        // Nothing is left under a temporary name.
        assert!(!lib.files().iter().any(|f| f.contains(TEMP_SUFFIX)));
    }
}
