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

- Today there are 83 commands, and `api.ts` and `generate_handler!` match one to one. Keep it
  that way. Steps for adding a command are in [ipc-contract.md](ipc-contract.md).
- Argument names: Tauri turns camelCase JS keys into snake_case Rust parameters
  (`sourceId` → `source_id`). Struct payloads use `#[serde(rename_all = "camelCase")]`.
- Plugin calls go through their JS packages: dialog, opener (`revealItemInDir`, `openUrl`), drag
  (`startDrag` in `lib/actions.tsx`), process (restart), updater. Each needs a permission in
  `src-tauri/capabilities/default.json`, and the mock handles `plugin:*|*` commands separately.
- Dialogs that choose where Saga **writes** run in Rust, inside the command (`export_sample`,
  `pick_saved_sounds_dir`), so a destination path never comes over IPC. The webview may only
  open folder pickers for reading (`dialog:allow-open`). Don't add `dialog:allow-save` or pass
  a write path from the UI.

## 2. Backend → frontend events

| Event | Emitted by | Payload | Handled in | Effect |
| --- | --- | --- | --- | --- |
| `index-progress` | `indexer.rs` via the `Emit` callback | `IndexProgress` | `App.tsx` → `useLibrary.setProgress` | sidebar "Listening to your samples" |
| `library-changed` | `indexer.rs` | none | `App.tsx` | `useLibrary.refresh()` + `useBrowse.refresh()` + `useSimilar.refreshIfWaiting()` |
| `playback` | `audio.rs` engine → `lib.rs` | `PlaybackEvent` | `usePlayer.handleEvent`, then `playNextAfter` (lib/actions) on `ended` | position anchor, ended, errors, Play next |
| `record-level` | `commands.rs` (`start_recording`) | `RecordLevel` | `useSimilar.onLevel` | Find by recording meter |
| `lab-transport` | `audio.rs`/`sequence.rs` → `lib.rs` | `TransportEvent` | `onTransport` in `store/lab.ts` | progression playhead |
| `take-status` | `capture.rs` (the `saga-capture` thread, ~30/s while a source is open, and once on closing) | `TakeStatus` | `useRecord.onStatus` | the Record panel's live waveform, timer and state |
| `take-landed` | `capture.rs` `store` (after trimming and indexing a take) | `TakeLanded` | `useRecord.onLanded` | the take joins the tray |
| `take-notice` | `capture.rs` | `TakeNotice` | `useRecord.onNotice` | a toast, with Open settings for a missing permission |
| `record-shortcut` | `lib.rs` global shortcut handler | none | `stepRecording(true)` (store/record) | the shortcut from anywhere steps arm → record → stop |
| `quit-requested` | `lib.rs` (`CloseRequested` / `ExitRequested` with unsaved takes set to go on quit) | count | `askAboutTakes` in `App.tsx` → `api.quitApp` | asks before unsaved takes go to the Trash |

The listeners are set up once in `App.tsx` (`events.*` from `api.ts`) and removed on unmount. A
new event needs an `events.onX` wrapper in `api.ts`, a payload type that mirrors the Rust one, and
a subscription in `App.tsx`.

## 3. Frontend-only signals

- DOM event `saga:open-filters`: dispatched by `useHotkeys` (⌘⇧F), listened to by
  `FilterBar.tsx`. FilterBar is only mounted in the full window's list view without the editor,
  so the hotkey switches there first and dispatches on the next tick.
- DOM event `saga:open-project-key` (`OPEN_PROJECT_KEY`): dispatched by `askProjectKey()` (lib/actions) when a Match
  switch is turned on with no project key (PreviewPanel, Editor). `KeyControl` opens its popover on it through
  `Popover`'s `openOn` prop. Only one KeyControl is mounted at a time (title bar or mini player).
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
| `prefs.playNext` (via `setPlayNext`) | `shouldLoop` returns false for everything, and a repeating sample is told to stop looping. `toggleLoop` turning looping on turns it off |
| `findSimilar(row)` (actions) | leaves the mini player, `setView("map")`, `useSimilar.find(row)` |
| `openInLab(row, …)` (actions) | selects the row, leaves the mini player, sets the Lab tool, `setView("lab")` |
| `applyValues` (key/tempo by hand) | `api.setSampleValues` → `useBrowse.replaceRows` + `refresh()` (facets count keys) |
| `startBrowsing()` (App mount) | opens the "all samples" view, which runs the first query |
| `startUpdateChecks()` (App mount) | updater schedule (launch + every 12 h, off in dev) |
| `useRecord.save(id)` / `dragSample(take)` | `api.saveTake` → the row moves to Recordings (`takes.rs`), `useBrowse.replaceRows` + `refresh()`, `useLibrary.refresh()` (Recordings may be a new folder). Dragging an unsaved take saves it first, quietly |
| `useRecord.remove(ids)` | hides the takes, Undo toast; after 10 s `api.trashTakes` (OS Trash) |
| `prefs.record*` (take options) | `useRecord.optionsChanged()` → `api.setTakeOptions` (25 ms debounce) when a source is open |
| `startWhatsNew()` (App mount) | compares the running version with `prefs.lastSeenVersion`; after an update (or, with no value yet, when the library has folders) shows the What's new card. `show()` / `later()` write `lastSeenVersion` |

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
| `rename.ts` `nameProblem` | `rename.rs` `valid_name` | allowed file names |
| `keys.ts` names, Camelot, compatibility | `keys.rs` | key spelling and Camelot codes |
| `browse.ts` `backendFilters()` | `lib.rs` `ipc_tests::ui_filters` | the filters JSON shape |
| `progressions.ts` | `sequence.rs`, `midi.rs` | a progression as played and as a MIDI clip |
| `changelog.ts` `parseChangelog`, `isKeys` | `scripts/changelog.mjs` `section`, `isKeys` | CHANGELOG.md headings and key spelling (Node, not Rust) |
| `types.ts` `RecordSource`, `TakeOptions`, `TakeStatus`, `RecordSources`… | `capture.rs`, `takes.rs`, `commands.rs` `RecordSettings` | the Record panel's sources, options, live status and settings |

Each pair carries a `Mirrors …` comment. Add one to any new pair, and list it here.

## 7. Where state lives

| Store | Where | Notes |
| --- | --- | --- |
| `saga-prefs` | localStorage (`store/prefs.ts`) | `DEFAULT_PREFS`. New fields fall back to defaults through the shallow merge. `lastSeenVersion` (What's new) isn't in Settings' reset list |
| `CHANGELOG.md` | repo root, bundled with `?raw` (`lib/changelog.ts`) | What's new in the app and the GitHub release (`release-notes.mjs`); `set-version` dates it, `version.mjs --check` requires the version's notes |
| `saga-project` | localStorage (`store/project.ts`) | project tempo/key/sync |
| `saga-lab` | localStorage (`store/lab.ts`, `partialize` whitelist) | Lab tool, scale, sketch, ideas |
| per-sample edits | memory only (`useEdits`) | gone on restart, by design |
| `library.db` | `app_data_dir` (SQLite + FTS5, `db.rs`) | schema in `SCHEMA`, new `samples` columns in `ADDED_COLUMNS` |
| DB `settings` table | `output_device`, `saved_sounds_dir` (`SAVED_SOUNDS_SETTING`), `excluded_folder_names` (`EXCLUDED_NAMES_SETTING`, JSON), `take_format`, `takes_retention`, `record_shortcut` (`capture.rs` constants) | backend-owned settings |
| unsaved takes | `app_data_dir/Takes` (a hidden source, `sources.hidden = 1`, kept out of every browse query by `db::VISIBLE`), `Takes/.incoming` while recording | cleared only as Settings › Recording says, always to the Trash |
| saved takes | `<saved root>/Recordings`, a library folder like Variations | never auto-deleted |
| scratch renders | `app_cache_dir/renders` | pruned (`SCRATCH_MAX_AGE` 7 days, `SCRATCH_MAX_BYTES` 500 MB) |
| kept renders / variations | `<saved root>/Renders`, `<saved root>/Variations` (default `~/Music/Saga`) | never auto-deleted |
| take options, record source | `saga-prefs` (`recordSource`, `recordStartOnSound`, `recordStopAfter`, `recordKeepGoing`, `recordThresholdDb`) | UI preferences |

Rule of thumb: UI-only preferences go in `usePrefs`. Anything the backend needs before the UI
loads, or across windows, goes in the DB `settings` table, with a `pub const …_SETTING` name.

## 8. Lifetimes and threads (backend)

`lib.rs::run` builds `AppState`: `Db` (separate read and write connections behind `parking_lot`
mutexes), `Indexer` (watcher plus analysis threads that emit through `Emit`), `Engine` (CPAL
mixer thread, `crossbeam` command channel, emits `playback` / `lab-transport`), the recorder, a
cached `SoundIndex` and map `Layouts` (rebuilt when `Db::changes()` moves). Commands borrow
`State<'_, AppState>` and are all `async`. Blocking file or decode work goes in
`tauri::async_runtime::spawn_blocking`.

The Record panel's source runs on its own `saga-capture` thread (not lowered: it has to keep up with
the device), fed by the audio callback through recycled buffers (`capture::Sink`, no allocation).
Windows' process loopback runs on a `saga-loopback` thread; macOS taps call back on Core Audio's IO
thread. A stopped take is trimmed and stored before `Capture::stop` returns, so quitting keeps it;
with Keep going, storing happens on a `saga-take` thread beside the armed source.

`rename_samples` holds `Indexer::hold_rescans()` while it moves files (old name → temporary name →
new name, then one DB transaction). The scan thread waits on it, so the folder watcher never rescans
a file halfway and drops its row. Anything else that moves a user's files must do the same, and
`takes::save` does when it moves a take into Recordings.
