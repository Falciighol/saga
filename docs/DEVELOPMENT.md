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
outside Tauri. The screenshots in the README are taken from it.

On macOS, `npm run tauri` puts `scripts/macos/actool` first on the PATH. Tauri's bundler runs
`actool` with stdin closed, which breaks compiling the Icon Composer icon
(`src-tauri/icons/Source/Saga.icon`); the wrapper gives it an empty stdin. Bundling that icon
needs Xcode 26.

## Tests

```bash
cd src-tauri && cargo test
```

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
  render.rs    offline renders, file naming, zoomable waveform detail for the editor
  fonts.rs     installed font discovery for the font settings
  commands.rs  Tauri commands
src
  store/       Zustand stores: browse (queries, paging, selection), library, player, prefs,
               project (tempo/key/scale), edits (per-sample), editor, ui (list/map/lab, mini
               player), similar, soundmap, lab, updates
  components/lab/  the Lab: scale list, pitch circle, keyboard, chords, progressions, key finder,
               tempo & tuning, side panels
  components/  UI
  lib/         API bindings, processing (tempo/key math, one source of truth for preview and
               render), theory (scales, spelling, chords, key finding, scale fit, scale steps),
               progressions (presets, voicing, rhythms, suggestions), renders, theme palette,
               fonts, waveform drawing, formatting
  dev/         the mock backend for working on the UI in a browser
```

## Releasing

Installed copies look for a new version shortly after launch and every 12 hours (Settings ›
Updates, where it can be turned off or run by hand). A new version downloads in the background
and installs only when the user clicks Restart. The app reads
`https://github.com/Falciighol/saga/releases/latest/download/latest.json` and only accepts
bundles signed with the key whose public half is in `src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`). Dev builds never check on their own.

To ship a version:

```bash
npm run set-version -- 0.2.0
git commit -am "Saga 0.2.0" && git tag v0.2.0 && git push --follow-tags
npm run release:mac
```

1. `npm run set-version` writes the version to `package.json`, `tauri.conf.json`, `Cargo.toml`
   and `Cargo.lock`.
2. The pushed tag starts `.github/workflows/release.yml` (it can also be run from the Actions
   tab). It opens a **draft** release and builds Windows (NSIS) into it, with a signed update
   bundle and `latest.json`.
3. `npm run release:mac` builds the Mac version on your Mac: one universal app for Apple Silicon
   and Intel, signed with your Developer ID and notarized by Apple (notarizing in CI would use up
   the macOS runner minutes). It checks that Gatekeeper accepts the app, uploads the .dmg and the
   signed update bundle to the same draft, and adds the Mac entries to `latest.json`. You can run
   it while CI is still building: it waits for the workflow to finish before touching
   `latest.json`, and either side keeps the other's entries.
4. Check the draft has the .dmg, the Windows setup .exe and a `latest.json` listing
   `darwin-aarch64`, `darwin-x86_64` and `windows-x86_64`, then publish it. That's the moment
   installed copies see the update.

`release:mac` insists on a clean working tree and a pushed commit, so the build always matches
what's tagged.

### One-time setup

On GitHub, one repository secret (Settings › Secrets and variables › Actions):

| Secret | What |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/saga_updater.key`, the updater's private key. Keep a backup: losing it means installed copies can't update |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password, if it has one |

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
