//! Tauri commands. All are async so database work never blocks the UI thread.

use crate::audio::{output_devices, Cmd};
use crate::dsp::ProcessParams;
use crate::indexer::skip_name;
use crate::model::*;
use crate::record::{self, EmitLevel};
use crate::render::{self, file_name, free_path, render_key, render_name, render_to, write_once};
use crate::sequence::{SeqNote, Sequence};
use crate::sounds::{Aspect, SoundIndex};
use crate::synth::{NoteEvent, Preset};
use crate::{analysis, features, map, rename, AppState};
use base64::Engine as _;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

type CmdResult<T> = Result<T, String>;

fn err<E: ToString>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn list_sources(state: State<'_, AppState>) -> CmdResult<Vec<SourceInfo>> {
    state.db.sources().map_err(err)
}

/// The path as a library folder is stored, when it can become one.
fn addable(existing: &[SourceInfo], path: &str) -> Option<String> {
    let p = path.trim_end_matches(['/', '\\']).to_string();
    // Adding a folder that's already inside a library folder would index files twice.
    if existing.iter().any(|s| Path::new(&p).starts_with(&s.path) && s.path != p) {
        return None;
    }
    // Files dropped on the window aren't library folders.
    Path::new(&p).is_dir().then_some(p)
}

/// `exclude`: subfolders to leave out, by the path they belong to (relative to it, `/`-separated).
#[tauri::command]
pub async fn add_sources(state: State<'_, AppState>, paths: Vec<String>, exclude: Option<HashMap<String, Vec<String>>>) -> CmdResult<Vec<i64>> {
    let existing = state.db.sources().map_err(err)?;
    let mut ids = Vec::new();
    for raw in paths {
        let Some(p) = addable(&existing, &raw) else { continue };
        let skip = exclude.as_ref().and_then(|m| m.get(&raw).or_else(|| m.get(&p))).map(Vec::as_slice).unwrap_or_default();
        ids.push(state.indexer.add_source(&p, skip)?);
    }
    Ok(ids)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subfolder {
    name: String,
    has_children: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderCandidate {
    path: String,
    name: String,
    subfolders: Vec<Subfolder>,
}

/// The folders directly inside `dir` that a scan would read, by name.
fn subfolders(dir: &Path, with_children: bool) -> Vec<Subfolder> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<Subfolder> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let path = e.path();
            (path.is_dir() && !skip_name(&name, true)).then(|| Subfolder { has_children: with_children && !subfolders(&path, false).is_empty(), name })
        })
        .collect();
    out.sort_by_key(|s| s.name.to_lowercase());
    out
}

/// What adding these paths would add: the ones that are folders and not in the library yet,
/// each with its subfolders, so some can be left out before anything is indexed.
#[tauri::command]
pub async fn folder_candidates(state: State<'_, AppState>, paths: Vec<String>) -> CmdResult<Vec<FolderCandidate>> {
    let existing = state.db.sources().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<FolderCandidate> = Vec::new();
        for p in paths.iter().filter_map(|raw| addable(&existing, raw)) {
            if out.iter().any(|c| c.path == p) || existing.iter().any(|s| s.path == p) {
                continue;
            }
            let dir = Path::new(&p);
            let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.clone());
            out.push(FolderCandidate { subfolders: subfolders(dir, true), name, path: p });
        }
        out
    })
    .await
    .map_err(err)
}

#[tauri::command]
pub async fn list_subfolders(path: String) -> CmdResult<Vec<Subfolder>> {
    tauri::async_runtime::spawn_blocking(move || subfolders(Path::new(&path), true)).await.map_err(err)
}

/// Leaves a subfolder of a library folder out of the library, or lets it back in.
#[tauri::command]
pub async fn set_dir_excluded(state: State<'_, AppState>, source_id: i64, dir: String, excluded: bool) -> CmdResult<()> {
    if excluded {
        state.indexer.exclude_dir(source_id, &dir)
    } else {
        state.indexer.include_dir(source_id, &dir)
    }
}

#[tauri::command]
pub async fn remove_source(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    state.indexer.remove_source(id)
}

#[tauri::command]
pub async fn rescan_source(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    state.indexer.rescan(id);
    Ok(())
}

#[tauri::command]
pub async fn list_dirs(state: State<'_, AppState>, source_id: i64, dir: String) -> CmdResult<Vec<DirNode>> {
    state.db.dirs(source_id, &dir).map_err(err)
}

#[tauri::command]
pub async fn query_samples(state: State<'_, AppState>, request: QueryRequest) -> CmdResult<QueryResult> {
    state.db.query(&request).map_err(err)
}

#[tauri::command]
pub async fn get_facets(state: State<'_, AppState>, filters: Filters) -> CmdResult<Facets> {
    state.db.facets(&filters).map_err(err)
}

#[tauri::command]
pub async fn get_sample(state: State<'_, AppState>, id: i64) -> CmdResult<Option<SampleRow>> {
    state.db.sample(id).map_err(err)
}

/// Ids of every sample the filters match, for selecting them all. Given the list's sort, they come
/// in the order the list shows them, so actions on all of them (numbering, dragging) keep it.
#[tauri::command]
pub async fn query_ids(state: State<'_, AppState>, filters: Filters, sort: Option<String>, desc: Option<bool>, seed: Option<i64>) -> CmdResult<Vec<i64>> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || db.matching_ids(&filters, sort.as_deref().map(|s| (s, desc.unwrap_or(false), seed.unwrap_or(0)))))
        .await
        .map_err(err)?
        .map_err(err)
}

/// Rows for these ids, in the same order (ones no longer in the library are left out).
#[tauri::command]
pub async fn get_samples(state: State<'_, AppState>, ids: Vec<i64>) -> CmdResult<Vec<SampleRow>> {
    state.db.samples_by_ids(&ids).map_err(err)
}

#[tauri::command]
pub async fn library_stats(state: State<'_, AppState>) -> CmdResult<LibraryStats> {
    state.db.stats().map_err(err)
}

#[tauri::command]
pub async fn index_progress(state: State<'_, AppState>) -> CmdResult<IndexProgress> {
    Ok(state.indexer.progress())
}

#[tauri::command]
pub async fn set_favorite(state: State<'_, AppState>, ids: Vec<i64>, favorite: bool) -> CmdResult<()> {
    state.db.set_favorite(&ids, favorite).map_err(err)
}

#[tauri::command]
pub async fn set_user_tags(state: State<'_, AppState>, id: i64, tags: Vec<String>) -> CmdResult<Option<SampleRow>> {
    state.db.set_user_tags(id, &tags).map_err(err)?;
    state.db.sample(id).map_err(err)
}

/// Sets the tempo and/or key of these samples by hand (or puts back what Saga found), and
/// returns them as they are now.
#[tauri::command]
pub async fn set_sample_values(state: State<'_, AppState>, ids: Vec<i64>, tempo: Option<TempoChange>, key: Option<KeyChange>) -> CmdResult<Vec<SampleRow>> {
    if let Some(TempoChange::Bpm { bpm }) = tempo {
        if !(bpm.is_finite() && (20.0..=999.0).contains(&bpm)) {
            return Err("Enter a tempo between 20 and 999 BPM".into());
        }
    }
    if let Some(KeyChange::Key { pc, mode }) = key {
        if pc > 11 || mode > 2 {
            return Err("That isn't a key".into());
        }
    }
    let tempo = match tempo {
        // Two decimals is as fine as tempos get written.
        Some(TempoChange::Bpm { bpm }) => Some(TempoChange::Bpm { bpm: (bpm * 100.0).round() / 100.0 }),
        t => t,
    };
    if state.db.set_user_values(&ids, tempo.as_ref(), key.as_ref()).map_err(err)? {
        state.indexer.queue_pending();
    }
    state.db.samples_by_ids(&ids).map_err(err)
}

/// Folder names left out of every library folder.
#[tauri::command]
pub async fn excluded_names(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    Ok(state.indexer.excluded_names())
}

#[tauri::command]
pub async fn set_excluded_names(state: State<'_, AppState>, names: Vec<String>) -> CmdResult<Vec<String>> {
    state.indexer.set_excluded_names(&names)
}

fn secs(t: std::io::Result<std::time::SystemTime>) -> Option<i64> {
    t.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64)
}

/// When these samples' files were created and last changed, for naming them by date.
#[tauri::command]
pub async fn file_dates(state: State<'_, AppState>, ids: Vec<i64>) -> CmdResult<Vec<FileDates>> {
    let rows = state.db.samples_by_ids(&ids).map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || {
        rows.iter()
            .map(|r| {
                let md = std::fs::metadata(&r.path).ok();
                let modified = md.as_ref().and_then(|m| secs(m.modified()));
                FileDates { id: r.id, created: md.as_ref().and_then(|m| secs(m.created())).or(modified), modified }
            })
            .collect()
    })
    .await
    .map_err(err)
}

/// Renames sample files where they are. Each sample keeps its favorite, tags, collections and
/// edits. Only ever run when asked, from the rename dialog.
#[tauri::command]
pub async fn rename_samples(state: State<'_, AppState>, renames: Vec<RenameRequest>) -> CmdResult<Vec<RenameOutcome>> {
    let ids: Vec<i64> = renames.iter().map(|r| r.id).collect();
    let rows: HashMap<i64, SampleRow> = state.db.samples_by_ids(&ids).map_err(err)?.into_iter().map(|r| (r.id, r)).collect();
    let (db, indexer) = (state.db.clone(), state.indexer.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let _hold = indexer.hold_rescans();
        rename::rename_samples(&db, &rows, &renames)
    })
    .await
    .map_err(err)
}

#[tauri::command]
pub async fn list_collections(state: State<'_, AppState>) -> CmdResult<Vec<Collection>> {
    state.db.collections().map_err(err)
}

#[tauri::command]
pub async fn create_collection(state: State<'_, AppState>, name: String, color: String) -> CmdResult<i64> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A collection needs a name".into());
    }
    state.db.create_collection(name, &color).map_err(err)
}

#[tauri::command]
pub async fn update_collection(state: State<'_, AppState>, id: i64, name: Option<String>, color: Option<String>) -> CmdResult<()> {
    state.db.update_collection(id, name.as_deref().map(str::trim).filter(|n| !n.is_empty()), color.as_deref()).map_err(err)
}

#[tauri::command]
pub async fn delete_collection(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    state.db.delete_collection(id).map_err(err)
}

#[tauri::command]
pub async fn add_to_collection(state: State<'_, AppState>, collection_id: i64, ids: Vec<i64>) -> CmdResult<()> {
    state.db.add_to_collection(collection_id, &ids).map_err(err)
}

#[tauri::command]
pub async fn remove_from_collection(state: State<'_, AppState>, collection_id: i64, ids: Vec<i64>) -> CmdResult<()> {
    state.db.remove_from_collection(collection_id, &ids).map_err(err)
}

#[tauri::command]
pub async fn sample_collections(state: State<'_, AppState>, id: i64) -> CmdResult<Vec<i64>> {
    state.db.sample_collections(id).map_err(err)
}

#[tauri::command]
pub async fn ids_for_paths(state: State<'_, AppState>, paths: Vec<String>) -> CmdResult<Vec<i64>> {
    state.db.ids_for_paths(&paths).map_err(err)
}

fn source_path(state: &AppState, id: i64) -> CmdResult<PathBuf> {
    let (path, online) = state.db.sample_path(id).map_err(err)?.ok_or("Sample not found")?;
    if !online {
        return Err("This sample's drive isn't connected".into());
    }
    Ok(PathBuf::from(path))
}

/// `start`: seconds in the original file; omit to start at the beginning of the (possibly reversed) region.
#[tauri::command]
pub async fn play(state: State<'_, AppState>, id: i64, start: Option<f64>, looping: bool, params: Option<ProcessParams>) -> CmdResult<()> {
    let path = source_path(&state, id)?;
    state.engine.send(Cmd::Play { id, path, start, looping, params: params.unwrap_or_default() });
    let _ = state.db.mark_played(id);
    // A sample still waiting for analysis gets its waveform, tempo and key now, not after the queue.
    state.indexer.prioritize(id);
    Ok(())
}

#[tauri::command]
pub async fn set_params(state: State<'_, AppState>, params: ProcessParams) -> CmdResult<()> {
    state.engine.send(Cmd::SetParams(params));
    Ok(())
}

#[tauri::command]
pub async fn set_click(state: State<'_, AppState>, on: bool) -> CmdResult<()> {
    state.engine.send(Cmd::SetClick(on));
    Ok(())
}

/// Plays Lab notes (scales, chords) over the preview, on the chosen output device.
#[tauri::command]
pub async fn play_notes(state: State<'_, AppState>, notes: Vec<NoteEvent>, preset: Preset) -> CmdResult<()> {
    state.engine.send(Cmd::PlayNotes { notes, preset });
    Ok(())
}

#[tauri::command]
pub async fn stop_notes(state: State<'_, AppState>) -> CmdResult<()> {
    state.engine.send(Cmd::StopNotes);
    Ok(())
}

/// Loops a Lab progression, or updates the one playing without losing its place. It follows the
/// tempo of a playing loop, otherwise `sequence.bpm`; "lab-transport" events say where it is.
#[tauri::command]
pub async fn play_sequence(state: State<'_, AppState>, sequence: Sequence) -> CmdResult<()> {
    state.engine.send(Cmd::PlaySequence(sequence));
    Ok(())
}

#[tauri::command]
pub async fn stop_sequence(state: State<'_, AppState>) -> CmdResult<()> {
    state.engine.send(Cmd::StopSequence);
    Ok(())
}

/// Writes a progression as a MIDI clip into the saved sounds folder's Renders for dragging into a DAW, and
/// returns its path. The same clip dragged again reuses its file.
#[tauri::command]
pub async fn save_midi(state: State<'_, AppState>, notes: Vec<SeqNote>, beats: f64, bpm: f64, name: String, label: String) -> CmdResult<String> {
    let bytes = crate::midi::write_midi(&notes, beats, bpm, &name);
    let dir = state.saved_root().join(render::RENDERS_DIR);
    let path = write_once(&dir, &file_name(&name, &label, "mid"), &bytes)?;
    Ok(path.to_string_lossy().to_string())
}

fn stem_of(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Sample".into())
}

fn path_strings(paths: &[PathBuf]) -> Vec<String> {
    paths.iter().map(|p| p.to_string_lossy().to_string()).collect()
}

/// Renders the processed sample; identical requests reuse the earlier file. Renders made ahead of
/// time (`keep` false) go to scratch; dragging one out (`keep` true) moves it into the saved sounds
/// folder's Renders, where DAW projects can rely on it.
#[tauri::command]
pub async fn render_sample(state: State<'_, AppState>, id: i64, params: ProcessParams, label: String, keep: bool) -> CmdResult<String> {
    let src = source_path(&state, id)?;
    let key = render_key(&src, &params);
    let name = render_name(&stem_of(&src), &label);
    let renders = state.saved_root().join(render::RENDERS_DIR);
    if let Some(existing) = state.db.render_for(&key).map_err(err)? {
        let existing = PathBuf::from(existing);
        if existing.exists() {
            if !keep || !existing.starts_with(&state.scratch_renders) {
                return Ok(existing.to_string_lossy().to_string());
            }
            let kept = render::keep(&existing, &renders, &name)?.to_string_lossy().to_string();
            state.db.remember_render(&key, &kept).map_err(err)?;
            return Ok(kept);
        }
    }
    let scratch = state.scratch_renders.clone();
    let dest = free_path(if keep { &renders } else { &scratch }, &name);
    let (src2, dest2, p) = (src.clone(), dest.clone(), params.clone());
    let pruned = tauri::async_runtime::spawn_blocking(move || {
        render_to(&src2, &p, &dest2)?;
        Ok::<_, String>(if keep { Vec::new() } else { render::prune_scratch(&scratch, render::SCRATCH_MAX_AGE, render::SCRATCH_MAX_BYTES, Some(&dest2)) })
    })
    .await
    .map_err(err)??;
    state.db.forget_renders(&path_strings(&pruned)).map_err(err)?;
    let dest = dest.to_string_lossy().to_string();
    state.db.remember_render(&key, &dest).map_err(err)?;
    Ok(dest)
}

/// How much space renders take in the saved sounds folder (and in scratch).
#[tauri::command]
pub async fn renders_usage(state: State<'_, AppState>) -> CmdResult<render::RendersUsage> {
    let (dir, scratch) = (state.saved_root().join(render::RENDERS_DIR), state.scratch_renders.clone());
    tauri::async_runtime::spawn_blocking(move || render::usage(&dir, &scratch)).await.map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearedRenders {
    cleared: render::FileCount,
    /// Files the Trash wouldn't take (in use, say).
    failed: u64,
    usage: render::RendersUsage,
}

/// Moves renders last changed more than `older_than_days` ago (all of them for `None`) to the Trash,
/// and deletes every render made ahead of time.
#[tauri::command]
pub async fn clear_renders(state: State<'_, AppState>, older_than_days: Option<u32>) -> CmdResult<ClearedRenders> {
    let (dir, scratch) = (state.saved_root().join(render::RENDERS_DIR), state.scratch_renders.clone());
    let (gone, cleared, failed, trash_err, usage) = tauri::async_runtime::spawn_blocking(move || {
        let files = render::older_than(&dir, older_than_days);
        let trash_err = render::move_to_trash(&files.iter().map(|f| f.path.clone()).collect::<Vec<_>>()).err();
        let mut gone = render::prune_scratch(&scratch, std::time::Duration::ZERO, 0, None);
        let (mut cleared, mut failed) = (render::FileCount::default(), 0);
        // The Trash can take some files and refuse others, so look at what's actually left.
        for f in files {
            if f.path.exists() {
                failed += 1;
            } else {
                cleared.files += 1;
                cleared.bytes += f.bytes;
                gone.push(f.path);
            }
        }
        (gone, cleared, failed, trash_err, render::usage(&dir, &scratch))
    })
    .await
    .map_err(err)?;
    state.db.forget_renders(&path_strings(&gone)).map_err(err)?;
    match trash_err {
        Some(e) if cleared.files == 0 => Err(format!("Couldn't move renders to the Trash: {e}")),
        _ => Ok(ClearedRenders { cleared, failed, usage }),
    }
}

/// Asks where to export the processed sample with a save dialog, then writes it there. Returns the
/// file written, or `None` when the dialog is cancelled. The dialog runs here rather than in the
/// webview so the destination never comes over IPC: the page can't make Saga write anywhere the
/// user didn't pick.
#[tauri::command]
pub async fn export_sample<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AppState>,
    id: i64,
    params: ProcessParams,
    file_name: String,
) -> CmdResult<Option<String>> {
    // Fail before the dialog when the sample can't be read anyway.
    source_path(&state, id)?;
    let mut dialog = window.dialog().file().set_title("Export sample").set_file_name(file_name).add_filter("WAV audio", &["wav"]);
    #[cfg(desktop)]
    {
        dialog = dialog.set_parent(&window);
    }
    let Some(picked) = dialog.blocking_save_file() else { return Ok(None) };
    let dest = picked.into_path().map_err(err)?;
    export_to(&state, id, params, dest).await.map(|p| Some(p.to_string_lossy().to_string()))
}

/// Renders the processed sample to `dest`, a path the user picked in a save dialog.
pub(crate) async fn export_to(state: &AppState, id: i64, params: ProcessParams, dest: PathBuf) -> CmdResult<PathBuf> {
    let src = source_path(state, id)?;
    let is_wav = dest.extension().is_some_and(|e| e.eq_ignore_ascii_case("wav"));
    let dest = if is_wav { dest } else { dest.with_extension("wav") };
    // The dialog only asked about replacing the name the user typed, so never overwrite the
    // differently named file that changing the extension may land on.
    if !is_wav && dest.exists() {
        let name = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        return Err(format!("There's already a file named “{name}” there. Pick another name."));
    }
    let dest2 = dest.clone();
    tauri::async_runtime::spawn_blocking(move || render_to(&src, &params, &dest2)).await.map_err(err)??;
    Ok(dest)
}

/// Renders into the saved sounds folder's Variations, which is kept in the library so variations are searchable.
#[tauri::command]
pub async fn save_variation(state: State<'_, AppState>, id: i64, params: ProcessParams, label: String) -> CmdResult<String> {
    let src = source_path(&state, id)?;
    let dir = state.saved_root().join(render::VARIATIONS_DIR);
    std::fs::create_dir_all(&dir).map_err(err)?;
    let dest = free_path(&dir, &render_name(&stem_of(&src), &label));
    let dest2 = dest.clone();
    tauri::async_runtime::spawn_blocking(move || render_to(&src, &params, &dest2)).await.map_err(err)??;
    let dir_str = dir.to_string_lossy().to_string();
    let sources = state.db.sources().map_err(err)?;
    // A library folder that already holds this one (or is it) picks the new file up with a rescan.
    match sources.iter().find(|s| Path::new(&dir_str).starts_with(&s.path)) {
        Some(s) => state.indexer.rescan(s.id),
        None => {
            state.indexer.add_source(&dir_str, &[])?;
        }
    }
    Ok(dest.to_string_lossy().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformDetail {
    /// Base64 peaks per channel.
    channels: Vec<String>,
    duration: f64,
}

/// Peaks for part of a file, at the editor's zoom level.
#[tauri::command]
pub async fn waveform_detail(state: State<'_, AppState>, id: i64, start: f64, end: f64, buckets: usize) -> CmdResult<WaveformDetail> {
    let cached = state.detail.lock().as_ref().filter(|(cid, _)| *cid == id).map(|(_, d)| d.clone());
    let detail = match cached {
        Some(d) => d,
        None => {
            let src = source_path(&state, id)?;
            let d = Arc::new(tauri::async_runtime::spawn_blocking(move || render::load_detail(&src)).await.map_err(err)??);
            *state.detail.lock() = Some((id, d.clone()));
            d
        }
    };
    let peaks = detail.peaks(start, end, buckets);
    Ok(WaveformDetail {
        channels: peaks.iter().map(|p| base64::engine::general_purpose::STANDARD.encode(p)).collect(),
        duration: detail.duration(),
    })
}

#[tauri::command]
pub async fn pause(state: State<'_, AppState>) -> CmdResult<()> {
    state.engine.send(Cmd::Pause);
    Ok(())
}

#[tauri::command]
pub async fn resume(state: State<'_, AppState>) -> CmdResult<()> {
    state.engine.send(Cmd::Resume);
    Ok(())
}

#[tauri::command]
pub async fn stop(state: State<'_, AppState>) -> CmdResult<()> {
    state.engine.send(Cmd::Stop);
    Ok(())
}

#[tauri::command]
pub async fn seek(state: State<'_, AppState>, position: f64) -> CmdResult<()> {
    state.engine.send(Cmd::Seek(position));
    Ok(())
}

#[tauri::command]
pub async fn set_loop(state: State<'_, AppState>, looping: bool) -> CmdResult<()> {
    state.engine.send(Cmd::SetLoop(looping));
    Ok(())
}

#[tauri::command]
pub async fn set_volume(state: State<'_, AppState>, volume: f32) -> CmdResult<()> {
    state.engine.send(Cmd::SetVolume(volume));
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDevices {
    devices: Vec<String>,
    current: Option<String>,
}

#[tauri::command]
pub async fn list_output_devices(state: State<'_, AppState>) -> CmdResult<OutputDevices> {
    Ok(OutputDevices { devices: output_devices(), current: state.db.get_setting("output_device") })
}

#[tauri::command]
pub async fn set_output_device(state: State<'_, AppState>, name: Option<String>) -> CmdResult<()> {
    state.db.set_setting("output_device", name.as_deref()).map_err(err)?;
    state.engine.send(Cmd::SetDevice(name));
    Ok(())
}

#[tauri::command]
pub async fn list_installed_fonts() -> CmdResult<Vec<crate::fonts::InstalledFont>> {
    tauri::async_runtime::spawn_blocking(crate::fonts::installed_fonts).await.map_err(err)
}

#[tauri::command]
pub async fn drag_icon(state: State<'_, AppState>) -> CmdResult<String> {
    Ok(state.drag_icon.to_string_lossy().to_string())
}

/// Where renders, Lab clips and saved variations go.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSounds {
    path: String,
    /// True while it's the default (~/Music/Saga).
    is_default: bool,
}

fn saved_sounds(state: &AppState) -> SavedSounds {
    let root = state.saved_root();
    let _ = std::fs::create_dir_all(&root);
    SavedSounds { is_default: root == state.default_saved_root(), path: root.to_string_lossy().to_string() }
}

/// The saved sounds folder, made if it isn't there yet.
#[tauri::command]
pub async fn saved_sounds_dir(state: State<'_, AppState>) -> CmdResult<SavedSounds> {
    Ok(saved_sounds(&state))
}

/// Asks for a new saved sounds folder with a folder picker and moves there; `None` when the picker is
/// cancelled. Like export, the picker runs here so the folder Saga will write into never comes over IPC.
#[tauri::command]
pub async fn pick_saved_sounds_dir<R: Runtime>(window: WebviewWindow<R>, state: State<'_, AppState>) -> CmdResult<Option<SavedSounds>> {
    let mut dialog = window.dialog().file().set_title("Choose where Saga saves renders and variations").set_directory(state.saved_root());
    #[cfg(desktop)]
    {
        dialog = dialog.set_parent(&window);
    }
    let Some(picked) = dialog.blocking_pick_folder() else { return Ok(None) };
    let path = picked.into_path().map_err(err)?;
    move_saved_root(&state, Some(&path)).map(Some)
}

/// Saves new renders and variations in the default folder (~/Music/Saga) again.
#[tauri::command]
pub async fn reset_saved_sounds_dir(state: State<'_, AppState>) -> CmdResult<SavedSounds> {
    move_saved_root(&state, None)
}

/// Moves where new renders and variations are saved; `None` goes back to the default. Files already
/// saved stay where they are, since projects may refer to them by path.
pub(crate) fn move_saved_root(state: &AppState, path: Option<&Path>) -> CmdResult<SavedSounds> {
    let path = path.map(|p| p.to_string_lossy()).map(|p| p.trim_end_matches(['/', '\\']).to_string());
    let value = match path {
        Some(p) if !p.is_empty() && Path::new(&p) != state.default_saved_root() => {
            let probe = Path::new(&p).join(render::RENDERS_DIR);
            std::fs::create_dir_all(&probe).map_err(|_| "Saga can't save into that folder".to_string())?;
            Some(p)
        }
        _ => None,
    };
    state.db.set_setting(crate::SAVED_SOUNDS_SETTING, value.as_deref()).map_err(err)?;
    Ok(saved_sounds(state))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedFolder {
    path: String,
    label: String,
}

/// Common places sample libraries live that exist on this machine and aren't indexed yet.
#[tauri::command]
pub async fn suggested_folders<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>) -> CmdResult<Vec<SuggestedFolder>> {
    let home = app.path().home_dir().map_err(err)?;
    let candidates: Vec<(PathBuf, &str)> = vec![
        (home.join("Splice/sounds"), "Splice downloads"),
        (home.join("Music/Samples"), "Samples"),
        (home.join("Samples"), "Samples"),
        (home.join("Documents/Samples"), "Samples"),
        (home.join("Music/Ableton/User Library/Samples"), "Ableton User Library"),
        (home.join("Documents/Loopcloud"), "Loopcloud"),
        (home.join("Documents/Image-Line/FL Studio/Data/Patches/Packs"), "FL Studio packs"),
        (home.join("Music/Audio Music Apps/Samples"), "Logic samples"),
        (PathBuf::from("/Library/Audio/Apple Loops"), "Apple Loops"),
    ];
    let sources = state.db.sources().map_err(err)?;
    let mut out: Vec<SuggestedFolder> = Vec::new();
    for (path, label) in candidates {
        let p = path.to_string_lossy().to_string();
        if path.is_dir() && !sources.iter().any(|s| path.starts_with(&s.path)) && !out.iter().any(|o| o.path == p) {
            out.push(SuggestedFolder { path: p, label: label.into() });
        }
    }
    Ok(out)
}

// ---- Find similar and the sound map ----

/// While indexing, the library changes every moment; a slightly stale index is fine for this long.
const REUSE_INDEX_FOR: Duration = Duration::from_secs(3);
const DEFAULT_SIMILAR: usize = 40;

async fn sound_index(state: &AppState) -> CmdResult<Arc<SoundIndex>> {
    let version = state.db.changes();
    if let Some(ix) = state.sounds.lock().clone() {
        if ix.version == version || ix.built.elapsed() < REUSE_INDEX_FOR {
            return Ok(ix);
        }
    }
    let db = state.db.clone();
    let ix = tauri::async_runtime::spawn_blocking(move || db.feature_rows().map(|rows| SoundIndex::build(version, rows)))
        .await
        .map_err(err)?
        .map_err(err)?;
    let ix = Arc::new(ix);
    *state.sounds.lock() = Some(ix.clone());
    Ok(ix)
}

fn similar_items(state: &AppState, ix: &SoundIndex, hits: Vec<(usize, f32)>) -> CmdResult<Vec<SimilarItem>> {
    let scores: HashMap<i64, f32> = hits.iter().map(|(i, s)| (ix.ids[*i], *s)).collect();
    let ids: Vec<i64> = hits.iter().map(|(i, _)| ix.ids[*i]).collect();
    let rows = state.db.samples_by_ids(&ids).map_err(err)?;
    Ok(rows.into_iter().map(|row| SimilarItem { score: scores[&row.id], row }).collect())
}

/// The notes in a sample's stored description, for the Lab's key finder and tuning tools.
/// Null until the sample has been described.
#[tauri::command]
pub async fn pitch_profile(state: State<'_, AppState>, id: i64) -> CmdResult<Option<PitchProfile>> {
    state.db.pitch_profile(id).map_err(err)
}

/// Samples that sound like `id`, of the same kind (one-shot or loop).
#[tauri::command]
pub async fn find_similar(
    state: State<'_, AppState>,
    id: i64,
    aspect: Aspect,
    source_id: Option<i64>,
    limit: Option<usize>,
) -> CmdResult<SimilarResult> {
    let target = state.db.sample(id).map_err(err)?;
    let ix = sound_index(&state).await?;
    let (described, pending) = state.db.description_counts().map_err(err)?;
    let Some(i) = ix.position(id) else {
        let message = if target.as_ref().is_some_and(|t| !t.online) {
            "This sample's drive isn't connected"
        } else if pending > 0 {
            "Saga is still listening to this sample. Try again in a moment."
        } else {
            "This sample is silent or couldn't be read"
        };
        return Ok(SimilarResult { target, items: Vec::new(), described, pending, message: Some(message.into()) });
    };
    let kind = ix.kinds[i];
    let limit = limit.unwrap_or(DEFAULT_SIMILAR).clamp(1, 200);
    let hits = ix.nearest(ix.vector(i), aspect, limit, |j| j != i && ix.kinds[j] == kind && source_id.is_none_or(|s| ix.sources[j] == s));
    let items = similar_items(&state, &ix, hits)?;
    Ok(SimilarResult { target, items, described, pending, message: None })
}

async fn similar_to_features(state: &AppState, features: Vec<f32>, aspect: Aspect, source_id: Option<i64>, limit: Option<usize>) -> CmdResult<SimilarResult> {
    let ix = sound_index(state).await?;
    let (described, pending) = state.db.description_counts().map_err(err)?;
    let query = ix.standardize(&features);
    let limit = limit.unwrap_or(DEFAULT_SIMILAR).clamp(1, 200);
    let hits = ix.nearest(&query, aspect, limit, |j| source_id.is_none_or(|s| ix.sources[j] == s));
    let items = similar_items(state, &ix, hits)?;
    let message = items.is_empty().then(|| "No samples have been analyzed yet".to_string());
    Ok(SimilarResult { target: None, items, described, pending, message })
}

/// Samples that sound like any audio file, such as one dropped from Finder.
#[tauri::command]
pub async fn similar_to_file(
    state: State<'_, AppState>,
    path: String,
    aspect: Aspect,
    source_id: Option<i64>,
    limit: Option<usize>,
) -> CmdResult<SimilarResult> {
    let p = PathBuf::from(&path);
    let info = tauri::async_runtime::spawn_blocking(move || analysis::analyze(&p)).await.map_err(err)??;
    let sound = info.sound.ok_or("This file is silent")?;
    similar_to_features(&state, sound.features, aspect, source_id, limit).await
}

#[tauri::command]
pub async fn start_recording<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>) -> CmdResult<()> {
    let emit: EmitLevel = Arc::new(move |level| {
        let _ = app.emit("record-level", level);
    });
    state.recorder.start(emit)
}

/// Stops recording and finds the samples that sound most like it.
#[tauri::command]
pub async fn stop_recording(state: State<'_, AppState>, aspect: Aspect, source_id: Option<i64>, limit: Option<usize>) -> CmdResult<SimilarResult> {
    let recording = state.recorder.stop()?;
    let clip = record::trim(&recording)?.to_vec();
    let rate = recording.rate;
    let sound = tauri::async_runtime::spawn_blocking(move || features::describe(&clip, rate))
        .await
        .map_err(err)?
        .ok_or("Saga couldn't hear anything")?;
    *state.last_recording.lock() = Some(sound.features.clone());
    similar_to_features(&state, sound.features, aspect, source_id, limit).await
}

/// Compares the last recording again (by another aspect or source).
#[tauri::command]
pub async fn similar_to_recording(state: State<'_, AppState>, aspect: Aspect, source_id: Option<i64>, limit: Option<usize>) -> CmdResult<SimilarResult> {
    let features = state.last_recording.lock().clone().ok_or("Record a sound first")?;
    similar_to_features(&state, features, aspect, source_id, limit).await
}

#[tauri::command]
pub async fn cancel_recording(state: State<'_, AppState>) -> CmdResult<()> {
    state.recorder.cancel();
    Ok(())
}

fn kind_code(kind: Option<&str>) -> Option<u8> {
    match kind {
        Some("oneshot") => Some(0),
        Some("loop") => Some(1),
        _ => None,
    }
}

/// Arranges the library (or its one-shots or loops) so similar sounds sit together.
#[tauri::command]
pub async fn sound_map(state: State<'_, AppState>, kind: Option<String>, aspect: Aspect) -> CmdResult<MapLayout> {
    let ix = sound_index(&state).await?;
    let kind = kind_code(kind.as_deref());
    let cached = state.layouts.lock().get(&(kind, aspect)).cloned();
    let layout = match cached {
        Some(l) if l.version == ix.version => l,
        previous => {
            let serial = state.layout_serial.fetch_add(1, Ordering::Relaxed) + 1;
            let l = tauri::async_runtime::spawn_blocking(move || map::arrange(&ix, kind, aspect, previous.as_deref(), serial)).await.map_err(err)?;
            let l = Arc::new(l);
            state.layouts.lock().insert((kind, aspect), l.clone());
            l
        }
    };
    let (described, pending) = state.db.description_counts().map_err(err)?;
    Ok(MapLayout { key: layout.key(), count: layout.ids.len(), points: layout.encode(), labels: layout.labels.clone(), described, pending })
}

/// Which points of a map match the current search and filters.
#[tauri::command]
pub async fn map_matches(state: State<'_, AppState>, key: String, filters: Filters) -> CmdResult<MapMatches> {
    let layout = state.layouts.lock().values().find(|l| l.key() == key).cloned().ok_or("The sound map changed. Reload it.")?;
    let db = state.db.clone();
    let ids: HashSet<i64> = tauri::async_runtime::spawn_blocking(move || db.matching_ids(&filters, None)).await.map_err(err)?.map_err(err)?.into_iter().collect();
    let mut bits = vec![0u8; layout.ids.len().div_ceil(8)];
    let mut matched = 0;
    for (k, id) in layout.ids.iter().enumerate() {
        if ids.contains(id) {
            bits[k / 8] |= 1 << (k % 8);
            matched += 1;
        }
    }
    let all = matched == layout.ids.len();
    Ok(MapMatches { bits: (!all).then(|| base64::engine::general_purpose::STANDARD.encode(bits)), matched })
}

// ---- mini player ----

const MINI_WIDTH: f64 = 420.0;
/// Narrow enough to sit beside a DAW, wide enough for the tempo, key and sync controls on one line.
const MINI_MIN_WIDTH: f64 = 400.0;
const MINI_HEIGHT: f64 = 860.0;
const MINI_MIN_HEIGHT: f64 = 480.0;
/// Matches the window's minimum size in tauri.conf.json.
const FULL_MIN: (f64, f64) = (1000.0, 620.0);

/// A size in interface pixels, grown by the interface scale but kept within the screen
/// (less room for the menu bar and Dock).
fn scaled<R: Runtime>(window: &WebviewWindow<R>, zoom: f64, (w, h): (f64, f64)) -> LogicalSize<f64> {
    let room = window.scale_factor().ok().zip(window.current_monitor().ok().flatten()).map(|(scale, m)| {
        let s = m.size().to_logical::<f64>(scale);
        (s.width - 40.0, s.height - 80.0)
    });
    let (max_w, max_h) = room.unwrap_or((f64::MAX, f64::MAX));
    LogicalSize::new((w * zoom).min(max_w), (h * zoom).min(max_h))
}

/// Sets the window's minimum size, growing the window if it's now smaller than that.
fn fit_min_size<R: Runtime>(window: &WebviewWindow<R>, min: LogicalSize<f64>) -> tauri::Result<()> {
    window.set_min_size(Some(min))?;
    let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
    if size.width < min.width || size.height < min.height {
        window.set_size(LogicalSize::new(size.width.max(min.width), size.height.max(min.height)))?;
    }
    Ok(())
}

/// Shrinks the window into the mini player (optionally kept on top of other apps), or restores it.
#[tauri::command]
pub async fn set_window_mode<R: Runtime>(window: WebviewWindow<R>, state: State<'_, AppState>, mini: bool, on_top: bool) -> CmdResult<()> {
    let zoom = *state.ui_scale.lock();
    if mini {
        let mut saved = state.full_window.lock();
        if saved.is_none() {
            if window.is_fullscreen().unwrap_or(false) {
                window.set_fullscreen(false).map_err(err)?;
            }
            let _ = window.unmaximize();
            let pos = window.outer_position().map_err(err)?;
            let size = window.inner_size().map_err(err)?;
            *saved = Some((pos, size));
            let scale = window.scale_factor().map_err(err)?;
            let mini_size = scaled(&window, zoom, (MINI_WIDTH, MINI_HEIGHT));
            window.set_min_size(Some(scaled(&window, zoom, (MINI_MIN_WIDTH, MINI_MIN_HEIGHT)))).map_err(err)?;
            window.set_size(mini_size).map_err(err)?;
            // Keep the right edge where the full window's was, so it stays on the same screen.
            let x = pos.x + size.width as i32 - (mini_size.width * scale) as i32;
            window.set_position(tauri::PhysicalPosition::new(x.max(0), pos.y)).map_err(err)?;
        }
        window.set_always_on_top(on_top).map_err(err)?;
    } else {
        window.set_always_on_top(false).map_err(err)?;
        if let Some((pos, size)) = state.full_window.lock().take() {
            window.set_size(size).map_err(err)?;
            // The scale may have changed while the mini player was showing.
            fit_min_size(&window, scaled(&window, zoom, FULL_MIN)).map_err(err)?;
            window.set_position(pos).map_err(err)?;
        }
    }
    Ok(())
}

/// Zooms the whole interface, like a browser's zoom, and scales the window's minimum size to match.
#[tauri::command]
pub async fn set_ui_scale<R: Runtime>(window: WebviewWindow<R>, state: State<'_, AppState>, scale: f64) -> CmdResult<()> {
    let zoom = scale.clamp(0.5, 3.0);
    window.set_zoom(zoom).map_err(err)?;
    *state.ui_scale.lock() = zoom;
    let mini = state.full_window.lock().is_some();
    let min = if mini { (MINI_MIN_WIDTH, MINI_MIN_HEIGHT) } else { FULL_MIN };
    fit_min_size(&window, scaled(&window, zoom, min)).map_err(err)
}
