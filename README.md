# Saga

A fast, smart sample browser for music producers. Point it at your sample folders and it indexes
them in place (nothing is moved or copied), reads tempo, key, loop/one-shot and category, draws
waveforms, and lets you search, filter, audition and drag samples into any DAW.

It also bends samples to your project: set a tempo and key once, and loops are time-stretched and
pitch-shifted to fit while you audition. Reverse them, pick a loop region, shape them in the
editor, then drag the processed result straight into your DAW.

Built with Tauri 2 (Rust) and React.

## Run it

```bash
npm install
npm run tauri:dev
```

Release build (creates `src-tauri/target/release/bundle/…`):

```bash
npm run tauri:build
```

Working on the UI without the Rust side: `npm run dev` and open http://localhost:1420 in a browser.
A mock backend with fake samples (`src/dev/mockBackend.ts`) kicks in automatically outside Tauri.

## What Phase 1 does

- **Library**: add folders or whole drives (button, or drop them on the window). Folders are watched,
  so new packs appear on their own. Unplugged drives keep their favorites and tags and come back
  when reconnected.
- **Smart metadata**, in order of trust: tempo and key written in the file name
  (`Loop_124_Am`, `128bpm`, `F# minor`), embedded loop data (ACID chunks in WAV, Apple Loops
  `basc` in AIFF, CAF `info`), then the audio itself for length, loudness and waveform. Bare numbers
  only count as a tempo when the file's length is a whole number of bars at that tempo.
- **Search**: instant full-text search over names, folders, categories and tags, plus field syntax
  (below).
- **Filters**: one-shot or loop, category, tempo range (with half/double time), key with Camelot
  compatibility, length, channels, format, sample rate, tags. Histograms show how your library is
  distributed before you pick a range.
- **Audition**: select to play, looping loops, click the waveform to seek. Playback runs in Rust
  (CPAL) with click-free fades; choose the output device in Settings.
- **Organize**: favorites, collections (right-click a sample, or drop samples on a collection),
  your own tags.
- **Drag to DAW**: drag any row or the preview's "Drag to DAW" tile into your DAW or Finder.
- Graphite dark and light themes, six accent colors (violet by default), and a choice of
  interface and numbers fonts: bundled ones (so they work offline), the system font, or any font
  installed on the computer (listed from the OS font folders, per-user ones included, on macOS,
  Windows and Linux).

Background analysis runs at low priority on half the CPU cores, and the audio device is only held
while previewing, so Saga stays out of your DAW's way.

## What Phase 2 adds

- **Project tempo and key** in the title bar: type a BPM, nudge it with `↑ ↓` (⇧ for 10), or tap
  it. Pick the key from the key wheel.
- **Sync**: loops play at the project tempo. Stretch keeps the pitch (Signalsmith Stretch);
  Repitch speeds up like tape. Saga picks half or double time when that is closer, or you choose
  ½×, 1× or 2× yourself.
- **Key matching**: shifts tonal samples to the project key by the smallest interval (relative
  minors count as the same key), with manual semitones and cents on top. Formant preservation
  is there for vocals.
- **Reverse**, **loop regions** (snapped to bars or beats, with a crossfade at the loop point),
  **fades**, **gain** and **normalize**.
- **Editor** (`E`, or Edit in the preview): a full-width, zoomable waveform with
  a bar ruler, a draggable loop region, and cards for tempo, pitch, region, shape and output.
  Drag across the waveform to make a region, ⌘-scroll to zoom, scroll sideways to pan.
- **Metronome click** over the preview, locked to the project tempo.
- **Drag or export what you hear**: dragging a processed sample renders it first, and the render
  is cached, so dragging it again is instant. Preview and render share the same code, so the file
  matches what you heard. From the editor you can also Export… to any folder, or Save variation
  to add it to your library.

Your original files are never changed. Renders are kept in `~/Music/Saga/Renders`, so DAW
projects that point to them keep working. Saved variations go to `~/Music/Saga/Variations`, which
Saga indexes like any other folder, with the new tempo and key in the file name
(`Arp Loop (124 BPM, Bm, reversed).wav`).

## What Phase 3 adds

- **Tempo and key from the audio** for files whose names and tags don't say. Detected values
  are marked with ≈ (`≈123.8`, `≈Am`) so you know to check them; half and double time are in
  the tempo menu. Loops cut to whole bars get their exact tempo from their length once the audio
  confirms the beat. Pitched one-shots (808s, bass, synth and vocal hits) get their root note.
  Drums and FX never get a key.
- **Find similar** (`G`, the Find similar button, or right-click): the closest-sounding samples
  across your whole library, compared overall or by timbre, pitch or envelope, optionally in one
  folder only. Drop any audio file on the Similar sounds panel to search by it, or use **Find by
  recording** to hum, beatbox or play something into the microphone.
- **Sound map** (`M`, or the map button next to the sort menu): every sample laid out so similar
  sounds sit together, colored by category, brightness or loudness and arranged by timbre, pitch
  or envelope. Your search, filters and sidebar selection light up their matches. Click a sound
  to hear it and link its closest matches; drag a lasso to add a group to a collection; scroll to
  move, ⌘-scroll or pinch to zoom; click a legend entry to show one category.
- **Mini player** (the button left of Settings): a narrow window with search, the list and the
  preview that can stay on top next to your DAW.

The first launch after updating listens to every sample once (the sidebar says "Listening to your
samples"). That takes a few minutes for a big library; Find similar and the map fill in as it goes.

How well detection works, measured on ~1,000 loops from real packs whose names state tempo and
key: tempo is right for 70–80% of loops and at half or double time for another 8–10%; keys are
only shown when the fit is strong (about half of untagged melodic loops), and those are the tagged
key or its relative about 70% of the time and harmonically compatible about 80%. For one-shots,
about half of a sample's 10 closest matches share its category, against 11% by chance.

## Search syntax

| Type            | Means                                        |
| --------------- | -------------------------------------------- |
| `dusty kick`    | names/folders/tags containing both words     |
| `-dirty`        | exclude a word                               |
| `bpm:120-128`   | tempo range (`bpm:124`, `bpm:>140` also work) |
| `key:Am`        | exactly A minor (`key:8A` works too)         |
| `key:Am+`       | A minor and compatible keys                  |
| `is:loop`       | loops only (`is:oneshot`, `is:fav`, `is:mono`) |
| `cat:kick`      | category                                     |
| `tag:warm`      | tag (`-tag:808` to exclude)                  |
| `len:<2s`       | length (`len:1-4s`, `len:>500ms`)            |
| `ext:wav`       | file format                                  |

## Keyboard

`↑ ↓` browse (⇧ for 10) · `Space` play/pause · `Enter` play from start · `←` back to start ·
`F` favorite · `L` loop · `⌘K` search · `⌘⇧F` filters · `Esc` clear search / stop / close editor ·
`⌘,` settings

Phase 2: `E` editor · `R` reverse · `[ ]` semitone down/up · `S` sync to project tempo ·
`K` match project key · `T` tap tempo

Phase 3: `M` sound map or list · `G` find similar · on the map, `↑ ↓` walk the Similar sounds
list · `Esc` clears a lasso selection or cancels a recording

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
  decode.rs    Symphonia streaming decode (WAV, AIFF, FLAC, MP3, OGG, M4A, CAF)
  chunks.rs    ACID / smpl / Apple Loops / CAF metadata
  meta.rs      name parsing and the rules that combine name, metadata and duration
  keys.rs      keys, Camelot codes, compatibility
  db.rs        SQLite + FTS5 index, favorites, tags, collections
  query.rs     filters and search syntax → SQL
  audio.rs     preview engine (CPAL mixer, live stretch/repitch voices, metronome)
  dsp.rs       shared processing: region, reverse, fades, gain, stretch, repitch, WAV writing
  render.rs    offline renders, file naming, zoomable waveform detail for the editor
  commands.rs  Tauri commands
src
  store/       Zustand stores: browse (queries, paging, selection), library, player, prefs,
               project (tempo/key), edits (per-sample), editor, ui (list/map, mini player),
               similar, soundmap
  components/  UI
  lib/         API bindings, processing (tempo/key math, one source of truth for preview and
               render), renders, theme palette, fonts, waveform drawing, formatting
```

## Tests

```bash
cd src-tauri && cargo test
```

Covers key and name parsing, embedded metadata, analysis, resampling and mixing, search and
filters, indexing a real folder end to end, stretch and repitch accuracy, regions, crossfades and
reverse, the metronome, renders, tempo, key and pitch detection, similarity, the map layout, and
every frontend command through Tauri's IPC layer.

To check the name parser against your own library (names only, nothing is decoded):

```bash
cd src-tauri && SAGA_SCAN_DIR="/path/to/samples" cargo test --lib meta::report -- --ignored --nocapture
```

Detection accuracy and similarity quality against your own tagged samples (decodes a few hundred
files, read-only):

```bash
cd src-tauri && SAGA_SCAN_DIR="/path/to/samples" cargo test --release --lib detect::report -- --ignored --nocapture
cd src-tauri && SAGA_SCAN_DIR="/path/to/samples" cargo test --release --lib sounds::report -- --ignored --nocapture
```

## Next

Phase 4: Ableton Link, so the project tempo follows your DAW.
