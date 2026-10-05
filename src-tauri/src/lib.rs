mod analysis;
mod audio;
mod chunks;
mod commands;
mod db;
mod decode;
mod detect;
mod dsp;
mod features;
mod fonts;
mod indexer;
mod keys;
mod map;
mod meta;
mod midi;
mod model;
mod query;
mod record;
mod render;
mod rename;
mod sequence;
mod sounds;
mod synth;

use audio::Engine;
use db::Db;
use indexer::{Emit, Indexer};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};

/// Sound maps by kind (one-shots, loops or both) and aspect.
type Layouts = HashMap<(Option<u8>, sounds::Aspect), Arc<map::Layout>>;

pub struct AppState {
    pub db: Arc<Db>,
    pub indexer: Arc<Indexer>,
    pub engine: Engine,
    /// Image shown under the cursor while dragging a sample out of the app.
    pub drag_icon: PathBuf,
    /// Where the default saved sounds folder lives (~/Music).
    pub music_dir: PathBuf,
    /// Renders made ahead of time, until they're dragged out (see `render::SCRATCH_MAX_AGE`).
    pub scratch_renders: PathBuf,
    /// Last file decoded for the editor's detailed waveform.
    pub detail: Mutex<Option<(i64, Arc<render::Detail>)>>,
    /// Features of every described sample, rebuilt when the library changes.
    pub sounds: Mutex<Option<Arc<sounds::SoundIndex>>>,
    pub layouts: Mutex<Layouts>,
    pub layout_serial: AtomicU64,
    pub recorder: record::Recorder,
    /// Features of the last recording, so it can be compared again by another aspect.
    pub last_recording: Mutex<Option<Vec<f32>>>,
    /// The full window's position and size while the mini player is showing.
    pub full_window: Mutex<Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>>,
    /// The interface zoom from Settings; window sizes grow with it.
    pub ui_scale: Mutex<f64>,
}

/// The setting that holds a chosen saved sounds folder; absent for the default.
pub const SAVED_SOUNDS_SETTING: &str = "saved_sounds_dir";

impl AppState {
    /// Where renders, Lab clips and saved variations go: the folder chosen in Settings, or ~/Music/Saga.
    pub fn saved_root(&self) -> PathBuf {
        match self.db.get_setting(SAVED_SOUNDS_SETTING) {
            Some(p) if !p.is_empty() => PathBuf::from(p),
            _ => self.default_saved_root(),
        }
    }

    pub fn default_saved_root(&self) -> PathBuf {
        self.music_dir.join("Saga")
    }

    pub fn new(db: Arc<Db>, indexer: Arc<Indexer>, engine: Engine, drag_icon: PathBuf, music_dir: PathBuf, scratch_renders: PathBuf) -> AppState {
        AppState {
            db,
            indexer,
            engine,
            drag_icon,
            music_dir,
            scratch_renders,
            detail: Default::default(),
            sounds: Default::default(),
            layouts: Default::default(),
            layout_serial: AtomicU64::new(0),
            recorder: Default::default(),
            last_recording: Default::default(),
            full_window: Default::default(),
            ui_scale: Mutex::new(1.0),
        }
    }
}

/// A small waveform glyph for drag previews, generated so no binary asset is needed.
fn write_drag_icon(path: &Path) -> Result<(), String> {
    const S: u32 = 64;
    let mut rgba = vec![0u8; (S * S * 4) as usize];
    let bars = [10, 18, 30, 44, 26, 38, 52, 34, 22, 40, 28, 16, 8];
    let bar_w = 2u32;
    let gap = 2u32;
    let total = bars.len() as u32 * (bar_w + gap) - gap;
    let x0 = (S - total) / 2;
    for y in 0..S {
        for x in 0..S {
            let i = ((y * S + x) * 4) as usize;
            // Rounded square background.
            let (dx, dy) = ((x as f32 - 31.5).abs() - 24.0, (y as f32 - 31.5).abs() - 24.0);
            let dist = dx.max(0.0).hypot(dy.max(0.0)) + dx.max(dy).min(0.0) - 6.0;
            if dist <= 0.0 {
                rgba[i..i + 4].copy_from_slice(&[27, 29, 33, 235]);
            }
        }
    }
    for (b, &h) in bars.iter().enumerate() {
        let bx = x0 + b as u32 * (bar_w + gap);
        let top = 32 - h / 2 * 38 / 52;
        let bottom = 32 + h / 2 * 38 / 52;
        for y in top..=bottom {
            for x in bx..bx + bar_w {
                let i = ((y * S + x) * 4) as usize;
                rgba[i..i + 4].copy_from_slice(&[236, 234, 230, 255]);
            }
        }
    }
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), S, S);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut w = enc.write_header().map_err(|e| e.to_string())?;
    w.write_image_data(&rgba).map_err(|e| e.to_string())
}

/// Registers every command the frontend calls.
pub fn with_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .invoke_handler(tauri::generate_handler![
            commands::list_sources,
            commands::add_sources,
            commands::remove_source,
            commands::rescan_source,
            commands::list_dirs,
            commands::folder_candidates,
            commands::list_subfolders,
            commands::set_dir_excluded,
            commands::query_samples,
            commands::get_facets,
            commands::get_sample,
            commands::get_samples,
            commands::query_ids,
            commands::library_stats,
            commands::index_progress,
            commands::set_favorite,
            commands::set_user_tags,
            commands::set_sample_values,
            commands::excluded_names,
            commands::set_excluded_names,
            commands::file_dates,
            commands::rename_samples,
            commands::list_collections,
            commands::create_collection,
            commands::update_collection,
            commands::delete_collection,
            commands::add_to_collection,
            commands::remove_from_collection,
            commands::sample_collections,
            commands::ids_for_paths,
            commands::play,
            commands::pause,
            commands::resume,
            commands::stop,
            commands::seek,
            commands::set_loop,
            commands::set_volume,
            commands::list_output_devices,
            commands::list_installed_fonts,
            commands::set_output_device,
            commands::drag_icon,
            commands::saved_sounds_dir,
            commands::pick_saved_sounds_dir,
            commands::reset_saved_sounds_dir,
            commands::suggested_folders,
            commands::set_params,
            commands::set_click,
            commands::play_notes,
            commands::stop_notes,
            commands::play_sequence,
            commands::stop_sequence,
            commands::save_midi,
            commands::render_sample,
            commands::renders_usage,
            commands::clear_renders,
            commands::export_sample,
            commands::save_variation,
            commands::waveform_detail,
            commands::pitch_profile,
            commands::find_similar,
            commands::similar_to_file,
            commands::start_recording,
            commands::stop_recording,
            commands::cancel_recording,
            commands::similar_to_recording,
            commands::sound_map,
            commands::map_matches,
            commands::set_window_mode,
            commands::set_ui_scale,
        ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    with_commands(tauri::Builder::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db = Arc::new(Db::open(&data_dir.join("library.db")).map_err(|e| e.to_string())?);

            let handle = app.handle().clone();
            let emit: Emit = Arc::new(move |name, payload| {
                let _ = handle.emit(name, payload);
            });
            let indexer = Indexer::start(db.clone(), emit);

            let handle = app.handle().clone();
            let transport = app.handle().clone();
            let engine = Engine::start(
                db.get_setting("output_device"),
                0.8,
                Arc::new(move |ev| {
                    let _ = handle.emit("playback", ev);
                }),
                Arc::new(move |ev| {
                    let _ = transport.emit("lab-transport", ev);
                }),
            );

            let cache_dir = app.path().app_cache_dir()?;
            std::fs::create_dir_all(&cache_dir)?;
            let drag_icon = cache_dir.join("drag-icon.png");
            if let Err(e) = write_drag_icon(&drag_icon) {
                eprintln!("saga: could not write drag icon: {e}");
            }

            let music_dir = app.path().audio_dir().or_else(|_| app.path().home_dir().map(|h| h.join("Music")))?;
            let scratch = cache_dir.join("renders");
            let (db2, scratch2) = (db.clone(), scratch.clone());
            std::thread::spawn(move || {
                let gone = render::prune_scratch(&scratch2, render::SCRATCH_MAX_AGE, render::SCRATCH_MAX_BYTES, None);
                let _ = db2.forget_renders(&gone.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>());
            });
            app.manage(AppState::new(db, indexer.clone(), engine, drag_icon, music_dir, scratch));
            indexer.resume_all();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Saga");
}

/// Exercises the commands through Tauri's IPC layer with the exact JSON the frontend sends,
/// so argument names and shapes can't silently drift apart. No window or audio device is used.
#[cfg(test)]
mod ipc_tests {
    use super::*;
    use serde_json::{json, Value};
    use std::time::{Duration, Instant};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
    use tauri::{WebviewWindow, WebviewWindowBuilder};

    fn call(w: &WebviewWindow<MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
        get_ipc_response(
            w,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                // The page's own origin, as the real frontend sends. A hardcoded `tauri://localhost`
                // counts as remote on Windows (there it's `http://tauri.localhost`), and remote
                // origins are rejected by the ACL, which the mock context leaves empty.
                url: w.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|b| b.deserialize::<Value>().unwrap())
    }

    fn write_wav(path: &Path, seconds: f32) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let spec = hound::WavSpec { channels: 1, sample_rate: 44100, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for i in 0..(44100.0 * seconds) as usize {
            w.write_sample(((i as f32 / 44100.0 * 110.0 * std::f32::consts::TAU).sin() * 9000.0) as i16).unwrap();
        }
        w.finalize().unwrap();
    }

    /// The filters object exactly as `backendFilters()` in src/store/browse.ts builds it.
    fn ui_filters(extra: Value) -> Value {
        let mut f = json!({
            "text": "", "kind": null, "categories": [], "bpmMin": null, "bpmMax": null, "halfDouble": false,
            "key": null, "durMin": null, "durMax": null, "formats": [], "channels": null, "sampleRates": [],
            "tags": [], "excludeTags": [], "createdFrom": null, "createdTo": null
        });
        for (k, v) in extra.as_object().unwrap() {
            f[k] = v.clone();
        }
        f
    }

    #[test]
    fn frontend_calls_round_trip() {
        let lib = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        write_wav(&lib.path().join("Nightdrive/Loops/Nightdrive_Bass_Loop_124_Am.wav"), 7.742);
        write_wav(&lib.path().join("Nightdrive/Loops/Nightdrive_Lead_Loop_124_Bbm.wav"), 7.742);
        write_wav(&lib.path().join("Drums/One Shots/Kick_Dusty_03.wav"), 0.4);

        let app = with_commands(mock_builder()).build(mock_context(noop_assets())).unwrap();
        let db = Arc::new(Db::open(&data.path().join("t.db")).unwrap());
        let indexer = Indexer::start(db.clone(), Arc::new(|_, _| {}));
        let engine = Engine::start(None, 0.8, Arc::new(|_| {}), Arc::new(|_| {}));
        app.manage(AppState::new(db, indexer.clone(), engine, data.path().join("icon.png"), data.path().join("Music"), data.path().join("cache/renders")));
        let w = WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();

        let lib_path = lib.path().to_string_lossy().to_string();
        let ids = call(&w, "add_sources", json!({ "paths": [format!("{lib_path}/")] })).unwrap();
        let source_id = ids[0].as_i64().unwrap();
        // Adding a file (not a folder) is ignored rather than failing.
        assert_eq!(call(&w, "add_sources", json!({ "paths": [format!("{lib_path}/Drums/One Shots/Kick_Dusty_03.wav")] })), Ok(json!([])));

        let settle = || {
            let start = Instant::now();
            std::thread::sleep(Duration::from_millis(150));
            while !indexer.is_idle() {
                assert!(start.elapsed() < Duration::from_secs(20));
                std::thread::sleep(Duration::from_millis(50));
            }
            std::thread::sleep(Duration::from_millis(400));
        };
        settle();

        // Leaving subfolders out: in the list shown before folders are added, and later from the folder tree.
        let extra = tempfile::tempdir().unwrap();
        write_wav(&extra.path().join("Keep/Snare_Crack.wav"), 0.3);
        write_wav(&extra.path().join("Keep/Deep/Hat_Closed.wav"), 0.2);
        write_wav(&extra.path().join("Skip/Full_Mix_120.wav"), 0.5);
        std::fs::create_dir_all(extra.path().join(".hidden")).unwrap();
        let extra_path = extra.path().to_string_lossy().to_string();
        // Files and folders already in the library aren't offered.
        let offered = call(&w, "folder_candidates", json!({ "paths": [extra_path, lib_path, format!("{lib_path}/Drums"), format!("{extra_path}/Keep/Snare_Crack.wav")] })).unwrap();
        assert_eq!(offered.as_array().unwrap().len(), 1, "{offered}");
        assert_eq!(offered[0]["path"], extra_path);
        assert_eq!(offered[0]["name"], extra.path().file_name().unwrap().to_string_lossy().to_string());
        assert_eq!(offered[0]["subfolders"], json!([{ "name": "Keep", "hasChildren": true }, { "name": "Skip", "hasChildren": false }]));
        assert_eq!(call(&w, "list_subfolders", json!({ "path": format!("{extra_path}/Keep") })).unwrap(), json!([{ "name": "Deep", "hasChildren": false }]));
        let extra_id = call(&w, "add_sources", json!({ "paths": [extra_path], "exclude": { extra_path.clone(): ["Skip"] } })).unwrap()[0].as_i64().unwrap();
        settle();
        let extra_source = |w: &WebviewWindow<MockRuntime>| {
            let sources = call(w, "list_sources", json!({})).unwrap();
            sources.as_array().unwrap().iter().find(|s| s["id"] == extra_id).unwrap().clone()
        };
        assert_eq!((extra_source(&w)["count"].clone(), extra_source(&w)["excluded"].clone()), (json!(2), json!(["Skip"])));
        call(&w, "set_dir_excluded", json!({ "sourceId": extra_id, "dir": "Keep/Deep", "excluded": true })).unwrap();
        assert_eq!((extra_source(&w)["count"].clone(), extra_source(&w)["excluded"].clone()), (json!(1), json!(["Keep/Deep", "Skip"])));
        call(&w, "set_dir_excluded", json!({ "sourceId": extra_id, "dir": "Skip", "excluded": false })).unwrap();
        settle();
        assert_eq!((extra_source(&w)["count"].clone(), extra_source(&w)["excluded"].clone()), (json!(2), json!(["Keep/Deep"])));
        call(&w, "remove_source", json!({ "id": extra_id })).unwrap();

        let request = |filters: Value| {
            json!({ "request": { "filters": filters, "sort": "relevance", "desc": false, "offset": 0, "limit": 100, "seed": 1 } })
        };
        let all = call(&w, "query_samples", request(ui_filters(json!({})))).unwrap();
        assert_eq!(all["total"], 3);

        let am = json!({ "pc": 9, "mode": 1, "compatible": true, "includeUnpitched": false, "rootInScale": true });
        let res = call(&w, "query_samples", request(ui_filters(json!({ "kind": "loop", "bpmMin": 120, "bpmMax": 128, "key": am })))).unwrap();
        assert_eq!(res["total"], 1, "{res}");
        let bass = &res["rows"][0];
        assert_eq!(bass["name"], "Nightdrive_Bass_Loop_124_Am");
        assert_eq!(bass["bpm"], 124.0);
        assert_eq!(bass["camelot"], "8A");
        assert_eq!(bass["kind"], "loop");
        assert_eq!(bass["pack"], "Nightdrive");
        assert!(bass["peaks"].as_str().unwrap().len() > 600);
        let bass_id = bass["id"].as_i64().unwrap();

        // View filters are added on top by the browse store.
        let folder = call(&w, "query_samples", request(ui_filters(json!({ "sourceId": source_id, "dir": "Drums" })))).unwrap();
        assert_eq!(folder["rows"][0]["name"], "Kick_Dusty_03");
        let searched = call(&w, "query_samples", request(ui_filters(json!({ "text": "nightdrive -lead" })))).unwrap();
        assert_eq!(searched["total"], 1);

        let facets = call(&w, "get_facets", json!({ "filters": ui_filters(json!({ "kind": "loop" })) })).unwrap();
        assert_eq!(facets["loops"], 2);
        assert_eq!(facets["oneshots"], 1);

        let dirs = call(&w, "list_dirs", json!({ "sourceId": source_id, "dir": "" })).unwrap();
        assert_eq!(dirs.as_array().unwrap().len(), 2);
        assert_eq!(dirs[1]["hasChildren"], true);

        call(&w, "set_favorite", json!({ "ids": [bass_id], "favorite": true })).unwrap();
        assert_eq!(call(&w, "library_stats", json!({})).unwrap()["favorites"], 1);

        let cid = call(&w, "create_collection", json!({ "name": "Nightdrive EP", "color": "#D9A441" })).unwrap();
        call(&w, "add_to_collection", json!({ "collectionId": cid, "ids": [bass_id] })).unwrap();
        assert_eq!(call(&w, "list_collections", json!({})).unwrap()[0]["count"], 1);
        assert_eq!(call(&w, "sample_collections", json!({ "id": bass_id })).unwrap(), json!([cid]));
        call(&w, "update_collection", json!({ "id": cid, "name": "EP", "color": null })).unwrap();

        let tagged = call(&w, "set_user_tags", json!({ "id": bass_id, "tags": ["Keeper"] })).unwrap();
        assert_eq!(tagged["userTags"], json!(["keeper"]));

        let path = bass["path"].as_str().unwrap();
        assert_eq!(call(&w, "ids_for_paths", json!({ "paths": [path] })).unwrap(), json!([bass_id]));
        assert!(call(&w, "get_sample", json!({ "id": bass_id })).unwrap()["favorite"].as_bool().unwrap());

        // Selecting all keeps the list's order (by name, Z to A here), so numbering follows it.
        let named = call(&w, "query_samples", json!({ "request": { "filters": ui_filters(json!({})), "sort": "name", "desc": true, "offset": 0, "limit": 10, "seed": 1 } })).unwrap();
        let shown: Vec<Value> = named["rows"].as_array().unwrap().iter().map(|r| r["id"].clone()).collect();
        assert_eq!(call(&w, "query_ids", json!({ "filters": ui_filters(json!({})), "sort": "name", "desc": true, "seed": 1 })).unwrap(), json!(shown));
        assert_eq!(call(&w, "query_ids", json!({ "filters": ui_filters(json!({})) })).unwrap().as_array().unwrap().len(), 3);

        // Every row knows when its file was created and when Saga found it, and the list can be
        // filtered and sorted by the created date.
        let created = bass["created"].as_i64().unwrap();
        assert!(created > 1_600_000_000 && bass["added"].as_i64().unwrap() >= created - 60, "{bass}");
        let between = |from: i64, to: i64| call(&w, "query_samples", request(ui_filters(json!({ "createdFrom": from, "createdTo": to })))).unwrap()["total"].clone();
        assert_eq!(between(created - 86_400, created + 86_400), 3);
        assert_eq!(between(created + 86_400, created + 2 * 86_400), 0);
        let newest = call(&w, "query_samples", json!({ "request": { "filters": ui_filters(json!({})), "sort": "created", "desc": true, "offset": 0, "limit": 10, "seed": 1 } })).unwrap();
        assert_eq!(newest["total"], 3);
        for sort in ["added", "created"] {
            let rows = call(&w, "query_samples", json!({ "request": { "filters": ui_filters(json!({})), "sort": sort, "desc": true, "offset": 0, "limit": 10, "seed": 1 } })).unwrap();
            let times: Vec<i64> = rows["rows"].as_array().unwrap().iter().map(|r| r[sort].as_i64().unwrap()).collect();
            assert!(times.windows(2).all(|p| p[0] >= p[1]), "{sort}: {times:?}");
        }

        // Two samples trade names and back while the folder watcher runs. Both keep their ids, so
        // the favorite, tag and collection stay with the bass.
        let lead = call(&w, "query_samples", request(ui_filters(json!({ "text": "lead" })))).unwrap()["rows"][0].clone();
        let (bass_name, lead_name) = (bass["name"].clone(), lead["name"].clone());
        let swap = |for_bass: &Value, for_lead: &Value| {
            let out = call(&w, "rename_samples", json!({ "renames": [{ "id": bass_id, "name": for_bass }, { "id": lead["id"], "name": for_lead }] })).unwrap();
            assert!(out.as_array().unwrap().iter().all(|o| o["error"].is_null()), "{out}");
            settle();
            out
        };
        let out = swap(&lead_name, &bass_name);
        assert_eq!((out[0]["from"].clone(), out[0]["to"].clone()), (bass_name.clone(), lead_name.clone()));
        let renamed = call(&w, "get_sample", json!({ "id": bass_id })).unwrap();
        assert_eq!((renamed["name"].clone(), renamed["favorite"].clone(), renamed["userTags"].clone()), (lead_name.clone(), json!(true), json!(["keeper"])));
        assert_eq!(call(&w, "query_samples", request(ui_filters(json!({})))).unwrap()["total"], 3);
        swap(&bass_name, &lead_name);
        assert_eq!(call(&w, "get_sample", json!({ "id": bass_id })).unwrap()["name"], bass_name);

        // Phase 3: detection, Find similar and the sound map.
        assert_eq!(bass["bpmSource"], "name");
        assert_eq!(bass["keySource"], "name");
        let lead_id = call(&w, "query_samples", request(ui_filters(json!({ "text": "lead" })))).unwrap()["rows"][0]["id"].as_i64().unwrap();
        let similar = call(&w, "find_similar", json!({ "id": bass_id, "aspect": "overall", "sourceId": null, "limit": 10 })).unwrap();
        assert_eq!(similar["target"]["id"], bass_id);
        assert_eq!(similar["described"], 3);
        // Only loops are compared with a loop, and the identical-sounding one scores highest.
        assert_eq!(similar["items"].as_array().unwrap().len(), 1, "{similar}");
        assert_eq!(similar["items"][0]["row"]["id"], lead_id);
        assert!(similar["items"][0]["score"].as_f64().unwrap() > 0.9);
        for aspect in ["timbre", "pitch", "envelope"] {
            assert!(call(&w, "find_similar", json!({ "id": bass_id, "aspect": aspect, "sourceId": source_id, "limit": null })).is_ok());
        }
        // The Lab reads a sample's notes from its stored description: all three are a 110 Hz sine.
        let profile = call(&w, "pitch_profile", json!({ "id": bass_id })).unwrap();
        let chroma: Vec<f64> = profile["chroma"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        assert_eq!(chroma.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0, 9, "{profile}");
        assert!((profile["hz"].as_f64().unwrap() - 110.0).abs() < 1.5, "{profile}");
        assert!(profile["clarity"].as_f64().unwrap() > 0.5 && profile["tonality"].is_number());
        assert_eq!(call(&w, "pitch_profile", json!({ "id": 999_999 })), Ok(Value::Null));
        // A Lab scale filter that also takes keyless samples by their notes, sorted by fit, as
        // the Lab's "Show samples that fit" sends it (the kick's root note, A, is in the scale).
        let by_notes =json!({ "pc": 9, "mode": 1, "compatible": false, "includeUnpitched": false, "rootInScale": true, "scale": [0, 2, 3, 5, 7, 8, 10], "byNotes": true });
        let fits = call(&w, "query_samples", json!({ "request": { "filters": ui_filters(json!({ "key": by_notes })), "sort": "fit", "desc": false, "offset": 0, "limit": 10, "seed": 1 } })).unwrap();
        let names: Vec<&str> = fits["rows"].as_array().unwrap().iter().map(|r| r["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["Kick_Dusty_03", "Nightdrive_Bass_Loop_124_Am"], "{fits}");

        let kick_path = format!("{lib_path}/Drums/One Shots/Kick_Dusty_03.wav");
        let by_file = call(&w, "similar_to_file", json!({ "path": kick_path, "aspect": "overall", "sourceId": null, "limit": 5 })).unwrap();
        assert_eq!(by_file["items"][0]["row"]["name"], "Kick_Dusty_03");
        assert!(call(&w, "cancel_recording", json!({})).is_ok());
        assert!(call(&w, "similar_to_recording", json!({ "aspect": "overall", "sourceId": null, "limit": 5 })).is_err());

        let map = call(&w, "sound_map", json!({ "kind": null, "aspect": "timbre" })).unwrap();
        assert_eq!(map["count"], 3);
        assert_eq!(base64::Engine::decode(&base64::engine::general_purpose::STANDARD, map["points"].as_str().unwrap()).unwrap().len(), 36);
        let key = map["key"].as_str().unwrap();
        let matches = call(&w, "map_matches", json!({ "key": key, "filters": ui_filters(json!({ "text": "nightdrive" })) })).unwrap();
        assert_eq!(matches["matched"], 2);
        assert!(matches["bits"].is_string());
        let everything = call(&w, "map_matches", json!({ "key": key, "filters": ui_filters(json!({})) })).unwrap();
        assert_eq!(everything["bits"], Value::Null);
        assert_eq!(call(&w, "sound_map", json!({ "kind": "oneshot", "aspect": "overall" })).unwrap()["count"], 1);
        assert!(call(&w, "set_window_mode", json!({ "mini": true, "onTop": true })).is_ok());
        assert!(call(&w, "set_window_mode", json!({ "mini": false, "onTop": false })).is_ok());
        assert!(call(&w, "set_ui_scale", json!({ "scale": 1.25 })).is_ok());
        assert!(call(&w, "set_window_mode", json!({ "mini": true, "onTop": false })).is_ok());
        assert!(call(&w, "set_window_mode", json!({ "mini": false, "onTop": false })).is_ok());
        assert!(call(&w, "list_installed_fonts", json!({})).unwrap().as_array().is_some_and(|f| f.iter().all(|f| f["family"].is_string() && f["mono"].is_boolean())));

        // Phase 2: processing, rendering and the editor's waveform.
        let params = json!({
            "rate": 1.25, "semitones": 2, "mode": "stretch", "formants": false, "reverse": true,
            "regionStart": 0.0, "regionEnd": 3.871, "fadeIn": 0, "fadeOut": 0.01, "gainDb": -1.5,
            "normalize": false, "crossfade": 0.01, "beat": 0.4839
        });
        let label = "155 BPM, Bm, reversed";
        let name = "Nightdrive_Bass_Loop_124_Am (155 BPM, Bm, reversed).wav";
        // Made ahead of time, it waits in scratch.
        let early = call(&w, "render_sample", json!({ "id": bass_id, "params": params, "label": label, "keep": false })).unwrap();
        let early = early.as_str().unwrap().to_string();
        assert!(Path::new(&early).starts_with(data.path().join("cache/renders")) && early.ends_with(name), "{early}");
        let r = hound::WavReader::open(&early).unwrap();
        assert!((r.duration() as f64 / 44_100.0 - 3.871 / 1.25).abs() < 0.01);
        drop(r);
        // Same request, same file; the click setting doesn't matter.
        let mut no_click = params.clone();
        no_click["beat"] = Value::Null;
        let again = call(&w, "render_sample", json!({ "id": bass_id, "params": no_click, "label": label, "keep": false }));
        assert_eq!(again, Ok(json!(early)));
        // Dragging it out moves it into Music/Saga/Renders, and from then on that's the file.
        let rendered = call(&w, "render_sample", json!({ "id": bass_id, "params": params, "label": label, "keep": true })).unwrap();
        let rendered = rendered.as_str().unwrap().to_string();
        assert_eq!(Path::new(&rendered), data.path().join("Music/Saga/Renders").join(name));
        assert!(Path::new(&rendered).exists() && !Path::new(&early).exists());
        for keep in [true, false] {
            assert_eq!(call(&w, "render_sample", json!({ "id": bass_id, "params": no_click, "label": label, "keep": keep })), Ok(json!(rendered)));
        }
        // A new render dragged straight away skips scratch.
        let mut louder = params.clone();
        louder["gainDb"] = json!(0);
        let direct = call(&w, "render_sample", json!({ "id": bass_id, "params": louder, "label": "louder", "keep": true })).unwrap();
        assert!(Path::new(direct.as_str().unwrap()).starts_with(data.path().join("Music/Saga/Renders")), "{direct}");
        let usage = call(&w, "renders_usage", json!({})).unwrap();
        assert_eq!((usage["all"]["files"].clone(), usage["olderThanMonth"]["files"].clone(), usage["scratch"]["files"].clone()), (json!(2), json!(0), json!(0)));
        // Nothing is a month old, so clearing those leaves everything in place.
        let cleared = call(&w, "clear_renders", json!({ "olderThanDays": 30 })).unwrap();
        assert_eq!((cleared["cleared"]["files"].clone(), cleared["failed"].clone(), cleared["usage"]["all"]["files"].clone()), (json!(0), json!(0), json!(2)));
        assert!(Path::new(&rendered).exists());

        // Export picks its destination in a native dialog the mock runtime can't show, so the IPC
        // call is checked up to the dialog and the writing half is called directly.
        let body = json!({ "id": 999_999, "params": params, "fileName": "Bass.wav" });
        assert_eq!(call(&w, "export_sample", body), Err(json!("Sample not found")));
        let state = w.state::<AppState>();
        let export_params: dsp::ProcessParams = serde_json::from_value(params.clone()).unwrap();
        let export = |dest: PathBuf| tauri::async_runtime::block_on(commands::export_to(&state, bass_id, export_params.clone(), dest));
        assert_eq!(export(data.path().join("exported.wav")), Ok(data.path().join("exported.wav")));
        // A name without .wav gets it, but never by replacing a file the dialog didn't ask about.
        assert_eq!(export(data.path().join("exported")), Err("There's already a file named “exported.wav” there. Pick another name.".into()));
        assert_eq!(export(data.path().join("other.aif")), Ok(data.path().join("other.wav")));

        let variation = call(&w, "save_variation", json!({ "id": bass_id, "params": params, "label": label })).unwrap();
        assert!(Path::new(variation.as_str().unwrap()).parent().unwrap().ends_with("Saga/Variations"));
        let sources = call(&w, "list_sources", json!({})).unwrap();
        assert!(sources.as_array().unwrap().iter().any(|s| s["name"] == "Variations"));

        let detail = call(&w, "waveform_detail", json!({ "id": bass_id, "start": 0.0, "end": 2.0, "buckets": 300 })).unwrap();
        assert_eq!(detail["channels"].as_array().unwrap().len(), 1);
        assert!((detail["duration"].as_f64().unwrap() - 7.742).abs() < 0.01);

        // Transport commands accept the frontend's arguments without touching an audio device.
        assert_eq!(call(&w, "play", json!({ "id": 999_999, "start": null, "looping": true, "params": params })), Err(json!("Sample not found")));
        assert!(call(&w, "set_params", json!({ "params": params })).is_ok());
        assert!(call(&w, "set_click", json!({ "on": true })).is_ok());
        // An empty list checks the argument names without opening an audio device.
        assert!(call(&w, "play_notes", json!({ "notes": [], "preset": "keys" })).is_ok());
        assert!(call(&w, "stop_notes", json!({})).is_ok());
        assert!(call(&w, "stop_sequence", json!({})).is_ok());
        // A Lab progression as a MIDI clip in Music/Saga/Renders; dragging it twice reuses the file.
        let midi_body = || {
            json!({
                "notes": [{ "note": 57, "start": 0, "length": 3.9, "velocity": 0.7 }, { "note": 60, "start": 4, "length": 3.9 }],
                "beats": 8, "bpm": 124, "name": "Night drive", "label": "124 BPM, A min"
            })
        };
        let midi = midi_body();
        let path = call(&w, "save_midi", midi.clone()).unwrap();
        let path = path.as_str().unwrap();
        assert!(path.ends_with("Night drive (124 BPM, A min).mid"), "{path}");
        assert_eq!(&std::fs::read(path).unwrap()[..4], b"MThd");
        assert_eq!(call(&w, "save_midi", midi).unwrap(), json!(path));
        assert!(call(&w, "index_progress", json!({})).unwrap()["refreshing"].is_boolean());
        for (cmd, body) in [
            ("seek", json!({ "position": 1.5 })),
            ("set_loop", json!({ "looping": false })),
            ("set_volume", json!({ "volume": 0.5 })),
            ("pause", json!({})),
            ("resume", json!({})),
            ("stop", json!({})),
            ("index_progress", json!({})),
            ("drag_icon", json!({})),
            ("saved_sounds_dir", json!({})),
            ("rescan_source", json!({ "id": source_id })),
        ] {
            assert!(call(&w, cmd, body).is_ok(), "{cmd}");
        }

        call(&w, "delete_collection", json!({ "id": cid })).unwrap();
        call(&w, "remove_source", json!({ "id": source_id })).unwrap();
        // Only the saved variation is left, indexed with the tempo and key from its name.
        let left = call(&w, "query_samples", request(ui_filters(json!({})))).unwrap();
        assert_eq!(left["total"], 1);
        assert_eq!(left["rows"][0]["name"], "Nightdrive_Bass_Loop_124_Am (155 BPM, Bm, reversed)");
        assert_eq!(left["rows"][0]["bpm"], 155.0);
        assert_eq!(left["rows"][0]["key"], "Bm");

        // The saved sounds folder can be moved; new clips follow it, and the default comes back with null.
        assert_eq!(call(&w, "saved_sounds_dir", json!({})).unwrap()["isDefault"], true);
        let moved = data.path().join("moved");
        // The folder comes from a native picker the mock runtime can't show, so the move is called directly.
        let set = serde_json::to_value(commands::move_saved_root(&w.state::<AppState>(), Some(&moved)).unwrap()).unwrap();
        assert_eq!(set["isDefault"], false);
        assert_eq!(set["path"], json!(moved.to_string_lossy()));
        let mut elsewhere = midi_body();
        elsewhere["name"] = json!("Elsewhere");
        let clip = call(&w, "save_midi", elsewhere).unwrap();
        assert!(Path::new(clip.as_str().unwrap()).starts_with(moved.join("Renders")), "{clip}");
        assert_eq!(call(&w, "reset_saved_sounds_dir", json!({})).unwrap()["isDefault"], true);
    }
}
