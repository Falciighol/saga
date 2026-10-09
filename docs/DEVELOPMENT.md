# Developing Saga

Saga is a [Tauri 2](https://tauri.app) app: a Rust backend (indexing, analysis, audio engine)
and a React + TypeScript frontend (Vite, Tailwind, Zustand).

## Run it

You need Node 20.19+ or 22.12+ and a stable Rust toolchain
([Tauri's prerequisites](https://tauri.app/start/prerequisites/) list the platform bits).

```bash
npm install
npm run tauri:dev
```

Release build (creates `src-tauri/target/release/bundle/…`):

```bash
npm run tauri:build
```

Working on the UI without the Rust side: `npm run dev` and open http://localhost:1420 in a
browser. A mock backend with fake samples (`src/dev/mockBackend.ts`) kicks in automatically
outside Tauri. The screenshots in the README are taken from it. Commands that return data need a
case there too.

`npm run typecheck` checks the frontend (`npm run build` runs it first as well). There's no
frontend test runner, linter or formatter yet.

On macOS, `npm run tauri` puts `scripts/macos/actool` first on the PATH. Tauri's bundler runs
`actool` with stdin closed, which breaks compiling the Icon Composer icon
(`src-tauri/icons/Source/Saga.icon`); the wrapper gives it an empty stdin. Bundling that icon
needs Xcode 26.

## Tests

```bash
cd src-tauri && cargo test --lib
```

This runs on macOS and Windows. On Windows it depends on `src-tauri/build.rs` embedding the
Common Controls manifest into the test binary, and on the IPC tests sending the page's own origin
(`w.url()`). The comments there explain why.

Covers key and name parsing, keys that fit a scale, how well a pitch profile fits one, embedded
metadata, analysis, resampling and mixing, search and filters, indexing a real folder end to
end, stretch and repitch accuracy, regions, crossfades and reverse, the metronome, the Lab
synth's tuning and envelopes, progressions landing with the click and following a loop's beats,
MIDI clips, renders, tempo, key and pitch detection, similarity, the map layout, and every
frontend command through Tauri's IPC layer (with the exact JSON the frontend sends).

To check the name parser against your own library (names only, nothing is decoded):

```bash
cd src-tauri && SAGA_SCAN_DIR="/path/to/samples" cargo test --lib meta::report -- --ignored --nocapture
```

Detection accuracy, how well stored pitch profiles fit the keys in sample names (where the
notes-that-fit threshold comes from; set `SAGA_DUMP=profiles.json` to keep the profiles) and
similarity quality against your own tagged samples (decodes a few hundred files, read-only):

```bash
cd src-tauri && SAGA_SCAN_DIR="/path/to/samples" cargo test --release --lib detect::report -- --ignored --nocapture
cd src-tauri && SAGA_SCAN_DIR="/path/to/samples" cargo test --release --lib sounds::report -- --ignored --nocapture
```

## Layout

```
src-tauri/src
  indexer.rs   scanning, file watching, parallel analysis, batched writes
  analysis.rs  decode → duration, peaks, loudness, sound description
  features.rs  one pass over the audio: timbre, pitch and envelope features, onsets, chroma, pitch
  detect.rs    tempo, key and root note from the audio
  sounds.rs    in-memory similarity index (standardized features, per-aspect distances)
  map.rs       sound map layout: t-SNE of landmark samples, everything else placed among them
  record.rs    microphone capture for Find by recording
  capture.rs   the Record panel's takes: sources, start on sound, stop on silence, writing as it
               records, trimming, crash recovery
  capture_win.rs  Windows: WASAPI process loopback (one app, or everything but Saga), app list
  capture_mac.rs  macOS: Core Audio process taps (one app, or everything but Saga), app list
  takes.rs     unsaved takes: saving into Recordings, the Trash, clearing old ones
  synth.rs     Lab note voices (keys, pad, pluck) mixed into the preview
  sequence.rs  Lab progression player: beat grid on the mixer clock, loop following, scheduling
  midi.rs      progressions as Standard MIDI Files for dragging into a DAW
  decode.rs    Symphonia streaming decode (WAV, AIFF, FLAC, MP3, OGG, M4A, CAF)
  chunks.rs    ACID / smpl / Apple Loops / CAF metadata
  meta.rs      name parsing and the rules that combine name, metadata and duration
  keys.rs      keys, Camelot codes, compatibility, keys that fit a scale, how well notes fit one
  db.rs        SQLite + FTS5 index, favorites, tags, collections, scale_fit() over stored profiles
  query.rs     filters and search syntax → SQL
  audio.rs     preview engine (CPAL mixer, live stretch/repitch voices, metronome, progressions)
  dsp.rs       shared processing: region, reverse, fades, gain, stretch, repitch, WAV writing
  render.rs    offline renders, file naming, scratch renders and clearing, zoomable waveform detail
  fonts.rs     installed font discovery for the font settings
  model.rs     types exchanged with the frontend (mirrored in src/lib/types.ts)
  rename.rs    renaming sample files on request, in two passes so files can trade names
  commands.rs  Tauri commands
  lib.rs       app state, startup, command registration, IPC tests
src
  store/       Zustand stores: browse (queries, paging, selection, picked samples), library,
               player, prefs, project (tempo/key/scale, and per-sample edits), editor, ui
               (list/map/lab, mini player), similar, soundmap, lab, updates, whatsNew (the card
               after an update and the What's new dialog), record (the Record panel, the live
               waveform, takes), toasts
  hooks/       useHotkeys (every app-wide keyboard shortcut), useTheme (theme, fonts, size)
  components/lab/  the Lab: scale list, pitch circle, keyboard, chords, progressions, key finder,
               tempo & tuning, side panels
  components/record/  the Record panel, its live stage, controls and takes, and the mini player strip
  components/settings/  Settings sections in files of their own (Recording)
  components/  UI; shared buttons, switches, chips and labels are in ui.tsx, menus in Menu.tsx; the
               list's columns (cells, header, the Columns menu) in ListColumns.tsx; the What's new
               card and dialog in WhatsNew.tsx
  lib/         API bindings (api.ts) and types, actions (what menus, buttons and keys share:
               dragging out, setting key/tempo, collections, Find similar), processing
               (tempo/key math, one source of truth for preview and render), theory (scales,
               spelling, chords, key finding, scale fit, scale steps), progressions (presets,
               voicing, rhythms, suggestions), keys and keyMidi (key names, Camelot, the key's
               MIDI clip), rename, renameTokens and renamePresets (the batch rename
               pattern, its tokens and presets), listColumns (the list's columns, their
               order and which show), renders, soundmap, theme palette,
               fonts, interface size (scale), platform (⌘ or Ctrl), autoTitle (tooltips for
               cut-off text), changelog (reads the bundled CHANGELOG.md for What's new),
               waveform drawing, formatting
  dev/         the mock backend for working on the UI in a browser (mockRecord.ts pretends to record)
```

[`CLAUDE.md`](../CLAUDE.md) and [`.claude/rules/`](../.claude/rules) hold the conventions,
including [a map of how these parts connect](../.claude/rules/wiring.md) (commands, events,
stores, persisted settings, code mirrored between Rust and TypeScript) and [where each keyboard
shortcut is handled and documented](../.claude/rules/keyboard-shortcuts.md).

## Releasing

Installed copies look for a new version shortly after launch and every 12 hours (Settings ›
Updates, where it can be turned off or run by hand). A new version downloads in the background
and installs only when the user clicks Restart. The app reads
`https://github.com/Falciighol/saga/releases/latest/download/latest.json` and only accepts
bundles signed with the key whose public half is in `src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`). Dev builds never check on their own.

What changed in each version is written once, in [`CHANGELOG.md`](../CHANGELOG.md), for producers
(the format is in the comment at its top). Add to its `## Unreleased` section as changes land. The
app bundles the file: after an update it shows a small "You're on Saga x.y.z" card, and Settings ›
Updates › What's new lists every version. The same notes go into the GitHub release.

To ship a version (in Claude Code, `/release` walks through these steps and the notes):

```bash
npm run set-version -- 0.2.0
git push origin main v0.2.0
npm run release:mac       # on the Mac
npm run release:windows   # on the Windows PC
```

1. `npm run set-version` turns CHANGELOG.md's `## Unreleased` into `## 0.2.0 — <today>` (it
   stops if there are no notes for the version), writes the version to `package.json`,
   `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`, commits them with the changelog
   (`chore: bump version to 0.2.0 …`) and tags `v0.2.0`. Pass `--no-git` to only edit the files.
   `node scripts/version.mjs --check` says whether the four agree and CHANGELOG.md has notes for
   the version. The workflow runs it and refuses a tag that fails.
2. The pushed tag starts `.github/workflows/release.yml` (it can also be run from the Actions
   tab). It is the only thing that creates the release: a **draft** whose notes come from
   `.github/RELEASE_TEMPLATE.md` (install steps), with "What's new" filled from the version's
   CHANGELOG.md notes by `scripts/release-notes.mjs`. Nothing is built in CI. Fix wording in
   CHANGELOG.md rather than only in the draft, so the app and GitHub say the same thing.
3. `npm run release:mac` builds the Mac version on your Mac: one universal app for Apple Silicon
   and Intel, signed with your Developer ID and notarized by Apple (notarizing in CI would use up
   the macOS runner minutes). It checks that Gatekeeper accepts the app, uploads the .dmg and the
   update bundle (`Saga_universal.app.tar.gz`, which the updater downloads) to the draft, and adds
   the Mac entries to `latest.json`. It never creates a release: if the workflow hasn't opened the
   draft yet, it stops and tells you to wait for it.
4. `npm run release:windows` builds the NSIS installer on the PC (not code-signed, so Windows
   shows an "unknown publisher" warning), uploads the `-setup.exe` to the draft (the `.sig` isn't
   uploaded; its text goes into `latest.json`), and adds the `windows-x86_64` entry to
   `latest.json`.
5. Check the draft has the .dmg, `Saga_universal.app.tar.gz`, the Windows setup .exe and a
   `latest.json` listing `darwin-aarch64`, `darwin-x86_64` and `windows-x86_64`, then publish it.
   That's the moment installed copies see the update.

Both scripts merge into the draft's existing `latest.json`, so the order doesn't matter and they
can run on different days: whichever goes second keeps the first one's entries. Neither creates a
release; if the workflow hasn't opened the draft yet, they stop and say so.

If `gh` fails partway (signed out, network, rate limit), the script still finishes the build, keeps
the files in `release-mac/` or `release-windows/` and ends by listing what's left to do by hand on
the draft: upload the files, and add its entries to `latest.json`.

Both scripts insist on a clean working tree and a pushed commit, so the builds always match
what's tagged.

### One-time setup

CI needs no secrets. The updater's private key (`~/.tauri/saga_updater.key`) lives only on the
machines that build; keep a backup, because losing it means installed copies can't update.

On the PC that makes Windows releases: Node, Rust, git, and the updater key copied from the Mac
to `%USERPROFILE%\.tauri\saga_updater.key` (or `TAURI_SIGNING_PRIVATE_KEY` set to its path or
contents). `gh` is optional there.

On the Mac that makes releases:

- The updater key at `~/.tauri/saga_updater.key`.
- A **Developer ID Application** certificate in the login keychain (developer.apple.com ›
  Certificates). If there's more than one, choose with `APPLE_SIGNING_IDENTITY`.
- Notarization credentials. Either save your Apple ID and an app-specific password (from
  account.apple.com) in the keychain once:

  ```bash
  security add-generic-password -s saga-notarize -a you@example.com -w
  ```

  or set `APPLE_API_KEY` and `APPLE_API_ISSUER` for an App Store Connect API key (with its .p8
  in `~/.appstoreconnect/private_keys`). The team ID is read from the certificate.
- Xcode 26 (for the Icon Composer icon), and `gh` signed in with an account that can write to
  the repository.

The repository must stay public, since the app downloads `latest.json` and the bundles without
credentials. Local `npm run tauri:build` doesn't need any of this; the updater bundles are only
made with `--config src-tauri/tauri.release.conf.json`. Signed Mac builds use the hardened
runtime; `src-tauri/Entitlements.plist` keeps the microphone working for Find by recording.

## Gumroad page

The Gumroad product page is a custom landing page. Edit `gumroad/landing.src.html`; its `{{name}}`
placeholders are filled with `gumroad/assets/<name>.webp` as data: URIs, since the page can't load
anything from elsewhere.

```bash
npm run gumroad:build     # writes gumroad/landing.html
npm run gumroad:preview   # runs Gumroad's sanitizer without publishing
npm run gumroad:publish   # publishes only if the sanitizer stripped nothing
```

These need the Gumroad CLI signed in (`gumroad auth login`). Gumroad caps the page at 500,000
characters, so the assets are 1280px copies of `docs/screenshots`. Re-encode them smaller if the
build says it's over. Elements marked `data-gumroad-field` are filled with the product's live name
and price, and `data-gumroad-action="buy"` opens checkout. Keep at least one, or the product can't
be bought. `gumroad products page clear qihzlk --yes` restores Gumroad's default page.
