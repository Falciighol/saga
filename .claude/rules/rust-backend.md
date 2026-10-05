---
paths:
  - "src-tauri/**"
---

# Backend conventions (Rust, Tauri 2)

## Modules
One concern per file in `src-tauri/src`, each opening with a `//!` comment that says what it
covers. The list is in docs/DEVELOPMENT.md "Layout". When you add a module, add it there too.
`commands.rs` only handles IPC: it validates arguments, calls into the domain modules
(`db`, `indexer`, `render`, `audio`, …) and converts errors. Put real logic in the domain module,
where its tests are.

## Commands
- Every command is `async` and returns `CmdResult<T>` (`Result<T, String>`), with errors mapped by
  `err`. Blocking work (file system walks, decoding, rendering, t-SNE) goes in
  `tauri::async_runtime::spawn_blocking`. A command must never block the runtime for long.
- No `unwrap`/`expect` on anything that comes from the user, the disk or the audio device. Use
  `?`, `let … else`, or `.ok()` with a sensible fallback.
- The steps for adding a command (registration, TS binding, IPC test, mock) are in
  `.claude/rules/ipc-contract.md`.

## Database (`db.rs`)
- There are two connections: `read` and `write`, each behind a `parking_lot::Mutex`. Reads take
  `self.read`, and writes take `self.write`. Hold a lock only for the statement or transaction,
  never across decoding or I/O.
- **Schema changes are additive.** A new table goes in `SCHEMA` as `CREATE TABLE IF NOT EXISTS`.
  A new `samples` column goes in `ADDED_COLUMNS` (applied by `Db::open` on existing databases).
  Never drop or rename a column or table that shipped, because users' `library.db` holds
  favorites, tags and collections that can't be rebuilt. If a change can't be additive, stop and
  propose a versioned migration (`PRAGMA user_version`) first.
- Call `self.changed()` after writes that change described samples. The sound index and map
  layouts rebuild from `Db::changes()`.
- Backend settings go in the `settings` table under a `pub const …_SETTING: &str` name. Don't
  scatter string literals. (`"output_device"` is still a literal. Turn it into a constant if you
  touch it.)
- Value sources are stored as integers (1 name, 2 metadata, 3 audio, 4 user) and mapped by
  `value_source`. Values set by hand (`user_*`) always win.
- Search and filter SQL is built in `query.rs`, with parameters always bound (never format user
  text into SQL). The `scale_fit(features, mask)` SQL function is registered in `configure`.

## Analysis and detection
- `analysis::VERSION` decides which files get re-analyzed. Bumping it re-decodes every user's
  whole library, so ask first and note the reason in its doc comment ("3: …").
- Thresholds that came from calibration (`MIN_SCALE_FIT`, `meta::MIN_BPM`/`MAX_BPM`, detection
  profiles) carry a comment on where they came from. Re-check them with the `#[ignore]`d `report`
  tests against a real library (`SAGA_SCAN_DIR`, `--release`), and quote the before and after
  numbers in the commit.
- Analysis threads run at lowered priority (`lower_thread_priority`). Keep any new background
  thread there too, and name it through `std::thread::Builder` (`saga-scan`, `saga-write`, `saga-audio`, …).

## Audio engine (`audio.rs`, `synth.rs`, `sequence.rs`, `dsp.rs`)
- The CPAL callback is real-time. No locks that other threads hold for long, no allocation, no
  I/O, no logging. Talk to the mixer through the `crossbeam` channels (`Cmd`) the way the
  existing code does.
- `dsp.rs` is shared by live playback and offline renders. A processing change goes there once,
  never as a preview-only or render-only copy. Keep the tests that compare stretch and repitch
  accuracy passing.
- The output stream is opened lazily and released after `RELEASE_OUTPUT_AFTER`. Don't open the
  device at startup.

## Files on disk
- Never write next to, or over, a user's sample except through the explicit rename command
  (which also moves Ableton's `.asd` file alongside).
- Renders: scratch renders go to `AppState.scratch_renders` and are pruned by
  `render::prune_scratch`. Kept ones go to `saved_root()/Renders` (`RENDERS_DIR`), variations to
  `VARIATIONS_DIR`. Deleting user-visible files means the OS Trash (`trash` crate; on macOS the
  `NsFileManager` method, so there's no Finder permission prompt), and only on request.
- Use `render::free_path` / `write_once` patterns for collision-free names. Never silently
  overwrite.

## Tests
- Unit tests sit at the bottom of each module in `#[cfg(test)] mod tests`, using `tempfile` and
  generated WAVs (`hound`), never the developer's own files. Long accuracy reports are
  `#[ignore]` and read `SAGA_SCAN_DIR`.
- Every IPC change is covered in `lib.rs::ipc_tests`.
- On Windows, `cargo test --lib` relies on `build.rs` embedding the Common-Controls manifest and on
  `ipc_tests::call` using `url: w.url()`. If tests crash at startup (0xc0000139) or IPC says
  "Plugin not found", check those two first.
- Dev builds compile dependencies at `opt-level = 3` and Saga at `2`
  (`Cargo.toml`), because analysis is far too slow unoptimized. Keep that.

## Dependencies
Ask before adding a crate. Prefer what's already in `Cargo.toml` (symphonia, rubato,
signalsmith-stretch, realfft, hound, walkdir, notify, crossbeam, parking_lot). Anything with
networking needs a very good reason (see the privacy rule in CLAUDE.md).
