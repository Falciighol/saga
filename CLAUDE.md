# Saga

A desktop sample browser for music producers. Tauri 2: a Rust backend (`src-tauri/src`: indexing,
analysis, SQLite, the audio engine) and a React 19 + TypeScript frontend (`src`: Vite, Tailwind 4,
Zustand 5). It ships on macOS (universal) and Windows. The code layout is listed in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#layout). The rules in `.claude/rules/` load when you touch
the files they cover. [wiring.md](.claude/rules/wiring.md) maps how the parts connect.

## Commands

| What | Command |
| --- | --- |
| Typecheck the frontend | `npm run typecheck` |
| Frontend only, mock backend, http://localhost:1420 | `npm run dev` (browser-pane launch config `saga-ui`) |
| The whole app | `npm run tauri:dev` |
| Rust tests | `cd src-tauri && cargo test --lib` |
| Accuracy reports on a real library (read-only, slow) | see "Tests" in docs/DEVELOPMENT.md (`#[ignore]`d, need `SAGA_SCAN_DIR`) |
| Set the version everywhere | `npm run set-version -- x.y.z` (never edit versions by hand) |

There is no frontend test runner, linter or formatter yet. Don't add one, or reformat whole files,
unless asked.

## Before you call a change done

1. `npm run typecheck` passes.
2. Touched Rust: `cargo test --lib` passes. If you added or changed a command, also update
   `ipc_tests` in `src-tauri/src/lib.rs`.
3. Touched UI: check it in the browser pane on the `saga-ui` dev server (mock backend), in dark
   and light themes, and in the mini player if the component shows there.
4. Docs match: README (features, shortcuts, search syntax), the Settings shortcut list, and the
   docs/DEVELOPMENT.md layout if you added a module or store.
5. A change users will notice has an entry under `## Unreleased` in CHANGELOG.md (add the heading
   under `# Changelog` if it isn't there). The format is in the file's header comment. Skip
   refactors, docs, tooling and fixes nobody could have run into. The app shows these notes after
   an update, so write them for producers.

## Product rules (these are promises to users, not style)

- **Files stay put.** Saga never moves, copies over or edits a user's sample files. Renaming only
  happens when the user asks for it in the Rename dialog, with a preview and Undo. Never add
  automatic or background renaming.
- **Nothing is deleted for good.** User-visible files (kept renders) go to the OS Trash, and only
  when the user asks. Only Saga's own scratch cache (`app_cache_dir/renders`) is pruned
  automatically. Never delete anything under the saved sounds folder on your own.
- **Private.** The only network request is the update check (Settings can turn it off). No
  telemetry, analytics, remote fonts or CDNs. Fonts are bundled through `@fontsource`.
- **Stays out of the DAW's way.** Analysis runs at low priority. The audio device is opened on
  first play and released after `RELEASE_OUTPUT_AFTER` of silence. Don't hold it or add work to
  the audio callback.
- **What you hear is what you drag.** Preview, editor, export and render all take their parameters
  from `computeProcessing` (src/lib/processing.ts) and run the same DSP (src-tauri/src/dsp.rs).
  Don't fork that path.
- **Values set by hand win.** Tempo and key set by the user (`user_*` columns, source "user")
  outrank name, metadata and audio detection, and survive rescans.

## Working conventions

- **Match the code around you.** Comments are full sentences that explain *why*, in plain English.
  `///` and `//!` doc comments go on Rust items, `/** */` on TS exports. Lines run up to about 140
  characters.
- **Contracts that span both sides** (commands, types, mirrored logic, events) are listed in
  wiring.md. When you change one side, change the other in the same commit.
- **Platform differences** go through `src/lib/platform.ts` (`hasMod`, `modKey`, `isMac`,
  `isWindows`, `revealLabel`). Never test `metaKey` or `ctrlKey` directly for shortcuts. Folder
  paths in the DB (`dir`) use `/` on every OS, while stored file paths use the OS separator.
- **Line endings are LF** (`.gitattributes`). `.bat`/`.cmd`/`.ps1` are the exception.
- **Commits** use Conventional Commits with a scope: `feat(lab): …`, `fix(render): …`,
  `chore(scripts): …`, `ci: …`. Make one topic per commit, and don't bundle unrelated features.
- **Ask before** changing the updater `pubkey`/endpoints, bumping `analysis::VERSION` (it
  re-analyzes every user's whole library), adding a dependency, renaming a persisted key
  (localStorage `saga-*`, DB settings), or changing anything in the product rules above.
- Before building something new, look in `src/components/ui.tsx`, `src/lib/actions.tsx`, `src/lib/format.ts`
  and `src/lib/theory.ts`. Reuse what's there instead of re-implementing it.

## Environment notes (Windows dev machine)

- `cargo test --lib` works on Windows because of `src-tauri/build.rs` (an embedded Common-Controls
  manifest) and `url: w.url()` in `ipc_tests`. Reverting either breaks the tests in confusing
  ways. The comments in those files explain why.
- In the Bash tool, write multi-line scripts to the scratchpad and run them from there. Inline
  heredocs lose backslashes.
