---
paths:
  - "src/**"
  - "src-tauri/src/**"
  - "src-tauri/capabilities/**"
---

# How Saga's parts connect

When you change something in the left column, check everything it points to. Keyboard shortcuts
have their own map in [keyboard-shortcuts.md](keyboard-shortcuts.md).

## 1. Frontend → backend calls (IPC)

```
component / store
  → api.* in src/lib/api.ts                  (the only place invoke() is called)
  → #[tauri::command] in src-tauri/src/commands.rs
  → registered in with_commands() in src-tauri/src/lib.rs (generate_handler!)
  ↳ exercised by ipc_tests::frontend_calls_round_trip in lib.rs (the exact JSON the UI sends)
  ↳ faked by src/dev/mockBackend.ts for `npm run dev` in a browser
```

- Today there are 68 commands, and `api.ts` and `generate_handler!` match one to one. Keep it
  that way. Steps for adding a command are in [ipc-contract.md](ipc-contract.md).
- Argument names: Tauri turns camelCase JS keys into snake_case Rust parameters
  (`sourceId` → `source_id`). Struct payloads use `#[serde(rename_all = "camelCase")]`.
- Plugin calls go through their JS packages: dialog, opener (`revealItemInDir`, `openUrl`), drag
  (`startDrag` in `lib/actions.tsx`), process (restart), updater. Each needs a permission in
  `src-tauri/capabilities/default.json`, and the mock handles `plugin:*|*` commands separately.

## 2. Backend → frontend events

| Event | Emitted by | Payload | Handled in | Effect |
| --- | --- | --- | --- | --- |
| `index-progress` | `indexer.rs` via the `Emit` callback | `IndexProgress` | `App.tsx` → `useLibrary.setProgress` | sidebar "Listening to your samples" |
| `library-changed` | `indexer.rs` | none | `App.tsx` | `useLibrary.refresh()` + `useBrowse.refresh()` + `useSimilar.refreshIfWaiting()` |
| `playback` | `audio.rs` engine → `lib.rs` | `PlaybackEvent` | `usePlayer.handleEvent` | position anchor, ended, errors |
| `record-level` | `commands.rs` (`start_recording`) | `RecordLevel` | `useSimilar.onLevel` | Find by recording meter |
| `lab-transport` | `audio.rs`/`sequence.rs` → `lib.rs` | `TransportEvent` | `onTransport` in `store/lab.ts` | progression playhead |

The listeners are set up once in `App.tsx` (`events.*` from `api.ts`) and removed on unmount. A
new event needs an `events.onX` wrapper in `api.ts`, a payload type that mirrors the Rust one, and
a subscription in `App.tsx`.

## 3. Frontend-only signals

- DOM event `saga:open-filters`: dispatched by `useHotkeys` (⌘⇧F), listened to by
  `FilterBar.tsx`. FilterBar is only mounted in the full window's list view without the editor,
  so the hotkey switches there first and dispatches on the next tick.
- Global hotkey gate: `useHotkeys` does nothing (except interface zoom) while `useMenu` has a menu
  open or any `[role="dialog"]` exists. `SettingsDialog`, `Popover`, `Prompt`, `FilterPanel`,
  `Rename`, `AddFolders` and `ExcludeFolders` all set that role. Any new modal, popover or panel
  that takes keys **must** set `role="dialog"` (or `alertdialog`).
- `MenuHost` catches Escape in the capture phase and stops it from propagating, so Esc closes a
  menu and nothing else.

## 4. The processing pipeline (preview = render)

```
useProject (bpm, key, sync, matchKey, scaleLock, mode, formants)   persisted "saga-project"
useEdits   (per-sample Edit, this session only)
SampleRow  (bpm, keyPc/keyMode, kind)
   └─► computeProcessing()  src/lib/processing.ts  ─► ProcessParams (mirrors dsp.rs)
          ├─ usePlayer.play → api.play(id, start, looping, params)
          ├─ startParamsSync(): project/edit changes → api.setParams (25 ms debounce), click → api.setClick
          ├─ renders.ts useRender / fileFor → api.renderSample(keep=false scratch | true on drag)
          ├─ actions.tsx dragSample(s) → fileFor(..., keep=true) → startDrag
          └─ Editor export / Save variation → api.exportSample / api.saveVariation
Rust: audio.rs (live voices) and render.rs (offline), both on dsp.rs
```

Changing `ProcessParams` means changing processing.ts, dsp.rs, the `ipc_tests` bodies and the
mock, all together.

## 5. Store → side-effect links

| Action | Also does |
| --- | --- |
| `useUi.setView(v)` | closes the editor (`useEditor.close`) |
| `useUi.toggleView` / `toggleLab` | `setView` between list and map, or list and lab |
| `useUi.setMini(true)` | closes the editor, then `api.setWindowMode(mini, prefs.miniOnTop)` |
| `useUi.setOnTop` | writes `prefs.miniOnTop`, then calls `setWindowMode` if mini |
| `prefs.uiScale` | `useThemeSync` → `api.setUiScale` (window zoom) → `measurePixelRatio` |
| `prefs.theme` / `accent` | `applyPalette` writes CSS variables on `:root`, `usePalette()` serves canvas drawing |
| `prefs.sansFont` / `monoFont` | `applyFonts` sets `--sans` / `--mono` |
| `prefs.volume` | `api.setVolume` (also sent once at startup in `App.tsx`) |
| `findSimilar(row)` (actions) | leaves the mini player, `setView("map")`, `useSimilar.find(row)` |
| `openInLab(row, …)` (actions) | selects the row, leaves the mini player, sets the Lab tool, `setView("lab")` |
| `applyValues` (key/tempo by hand) | `api.setSampleValues` → `useBrowse.replaceRows` + `refresh()` (facets count keys) |
| `startBrowsing()` (App mount) | opens the "all samples" view, which runs the first query |
| `startUpdateChecks()` (App mount) | updater schedule (launch + every 12 h, off in dev) |

Shared helpers that many components depend on: `targetIds` / `targetRows` (browse.ts) decide
whether an action applies to the picked set or the selected row. `editFor` / `useEdit`
(project.ts) return per-sample edits with a default.

## 6. Logic that exists on both sides (keep them identical)

| Frontend | Backend | What |
| --- | --- | --- |
| `src/lib/types.ts` | `src-tauri/src/model.rs` | every type exchanged, plus `BPM_HIST_*` / `DUR_HIST_*` constants |
| `api.ts` `NoteEvent`, `TransportEvent`, `Sequence` | `synth.rs`, `sequence.rs` | Lab audio payloads |
| `processing.ts` `ProcessParams` | `dsp.rs` `ProcessParams` | the processing contract |
| `theory.ts` `scaleFit`, `fittingKeys`, key profiles | `keys.rs` `scale_fit`, `fitting_keys`, `detect.rs` profiles | scale fit, key finding |
| `mockBackend.ts` `MIN_SCALE_FIT` | `keys.rs` `MIN_SCALE_FIT` | the threshold for notes that fit |
| `soundmap.ts` group order | `sounds.rs` `group_of`, `OTHER_GROUP` | map color groups |
| `rename.ts` `validName` | `commands.rs` `valid_name` | allowed file names |
| `keys.ts` names, Camelot, compatibility | `keys.rs` | key spelling and Camelot codes |
| `browse.ts` `backendFilters()` | `lib.rs` `ipc_tests::ui_filters` | the filters JSON shape |
| `progressions.ts` | `sequence.rs`, `midi.rs` | a progression as played and as a MIDI clip |

Each pair carries a `Mirrors …` comment. Add one to any new pair, and list it here.

## 7. Where state lives

| Store | Where | Notes |
| --- | --- | --- |
| `saga-prefs` | localStorage (`store/prefs.ts`) | `DEFAULT_PREFS`. New fields fall back to defaults through the shallow merge |
| `saga-project` | localStorage (`store/project.ts`) | project tempo/key/sync |
| `saga-lab` | localStorage (`store/lab.ts`, `partialize` whitelist) | Lab tool, scale, sketch, ideas |
| per-sample edits | memory only (`useEdits`) | gone on restart, by design |
| `library.db` | `app_data_dir` (SQLite + FTS5, `db.rs`) | schema in `SCHEMA`, new `samples` columns in `ADDED_COLUMNS` |
| DB `settings` table | `output_device`, `saved_sounds_dir` (`SAVED_SOUNDS_SETTING`), `excluded_folder_names` (`EXCLUDED_NAMES_SETTING`, JSON) | backend-owned settings |
| scratch renders | `app_cache_dir/renders` | pruned (`SCRATCH_MAX_AGE` 7 days, `SCRATCH_MAX_BYTES` 500 MB) |
| kept renders / variations | `<saved root>/Renders`, `<saved root>/Variations` (default `~/Music/Saga`) | never auto-deleted |

Rule of thumb: UI-only preferences go in `usePrefs`. Anything the backend needs before the UI
loads, or across windows, goes in the DB `settings` table, with a `pub const …_SETTING` name.

## 8. Lifetimes and threads (backend)

`lib.rs::run` builds `AppState`: `Db` (separate read and write connections behind `parking_lot`
mutexes), `Indexer` (watcher plus analysis threads that emit through `Emit`), `Engine` (CPAL
mixer thread, `crossbeam` command channel, emits `playback` / `lab-transport`), the recorder, a
cached `SoundIndex` and map `Layouts` (rebuilt when `Db::changes()` moves). Commands borrow
`State<'_, AppState>` and are all `async`. Blocking file or decode work goes in
`tauri::async_runtime::spawn_blocking`.
