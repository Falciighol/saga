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

## The Lab

A third view next to the list and the map (`H`, or the scale button on the view toggle) for
working out the harmony of a track.

- **Scales**: 37 of them, from the seven modes through harmonic and melodic minor, pentatonic and
  blues, symmetric scales and world scales like Hirajoshi and Double harmonic. Each one shows on a
  12-note circle (root at the top, so every scale keeps its shape in any key) and on a keyboard,
  with its degrees, the notes that set it apart from plain major or minor, and the chords it
  contains, coloured tonic, subdominant or dominant. Modes also get a brightest-to-darkest ladder.
- **Hear it**: click keys, chords or the scale; they play through the output device chosen in
  Settings, over any sample that's playing. Pick the sound in the rail: Keys, Pad or Pluck.
- **Back to the library**: *Set as project key* makes it the project key (the title bar shows
  "A Dorian"; Match key and Camelot codes use the closest major or minor). *Show samples that fit*
  opens the list filtered to samples in keys that share the scale's notes, one-shots whose root
  is in it, and samples with no key at all whose notes fit it, best fit first. The side panel
  lists the best fits, the Camelot moves from here with how many samples you have in each key,
  and related scales one note away.
- **Progressions**: sketch 2, 4 or 8 bars, one chord a bar. Fill a bar from the scale's chords,
  borrowed chords (from the parallel major or minor, the Neapolitan, secondary dominants) or the
  suggestions for what comes next (home leads away, away leads to tension, tension resolves), or
  start from a preset such as Night drive, Andalusian cadence or Jazz turnaround. Shift-click a
  chord in Scales to drop it into the selected bar. Chords are kept relative to the key, so
  changing the key transposes them. Play it held, pulsed on every beat or arpeggiated.
- **In time**: a progression loops through the same mixer as the preview, at the project tempo
  and with the metronome if it's on. Play a loop with a tempo and the progression follows the
  loop's beats instead: it starts on the loop's next bar line and stays locked to it, so you can
  hear chords against the loop.
- **Out to the DAW**: drag the MIDI tile into your DAW for a clip of exactly what plays, bass
  included, at the project tempo. Clips go to Music › Saga › Renders; dragging the same clip twice
  reuses its file.
- **Saved ideas**: save a progression and it sits in the rail; edits to it save as you go.
  Right-click an idea to rename, duplicate or delete it.
- **Key finder**: the keys and scales that fit the selected sample, from the pitch profile Saga
  stored when it analysed the file (no re-analysis), or from notes you pick on a keyboard, with
  the note that feels like home if you know it. *Likely keys* ranks the 24 major and minor keys
  the way detection does; *Scales that fit* ranks the modes, pentatonics and colour scales.
  Play the sample and try the chosen scale's keys over it, then set it as the project key, open
  it in Scales or show the samples that fit. Right-click a sample › *Find its key* opens it here.
- **Tempo & tuning**: delay and LFO times for straight, dotted and triplet notes at the project
  tempo (click one to copy it), bar lengths, and the project key's notes in Hz, at A = 440 or
  432, from the sub octave up. *Tune a one-shot* measures the selected kick or 808 (it rings at
  49.1 Hz, G1 −26¢) and sets its pitch to the nearest note of the key, cents included.
  Right-click a one-shot › *Tune it to the key* opens it here.
- **Scale lock** (in the project key menu): `[ ]` and the pitch buttons step a sample through the
  project key's scale instead of by semitones. A one-shot's root walks the scale's notes; a loop
  moves to the next key that fits the scale (an A minor loop in A Dorian goes to B minor, then
  E minor).
- **Notes that fit**: the key filter can also keep samples with no key whose notes fit the scale
  (drums and noise don't), and the list can sort by how well each sample's notes fit the key.
  On loops from real packs whose names state a key, 65% fit their own key well enough to pass,
  against 3% for the key a tritone away and 2% of drums and effects.

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

Phase 2: `E` editor · `R` reverse · `[ ]` semitone down/up (a step through the key's scale with
scale lock) · `S` sync to project tempo · `K` match project key · `T` tap tempo

Lab: `H` open or close · `Esc` stop. In Scales, `↑ ↓` scale · `← →` root · `Space` play the
scale. In Progressions, `Space` play or stop · `← →` pick a bar · `↑ ↓` step its chord through the
scale · `⌫` clear it. In the key finder and Tempo & tuning, `↑ ↓` walk the list and `Space` plays
the selected sample

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
  commands.rs  Tauri commands
src
  store/       Zustand stores: browse (queries, paging, selection), library, player, prefs,
               project (tempo/key/scale), edits (per-sample), editor, ui (list/map/lab, mini
               player), similar, soundmap, lab
  components/lab/  the Lab: scale list, pitch circle, keyboard, chords, progressions, key finder,
               tempo & tuning, side panels
  components/  UI
  lib/         API bindings, processing (tempo/key math, one source of truth for preview and
               render), theory (scales, spelling, chords, key finding, scale fit, scale steps),
               progressions (presets, voicing, rhythms, suggestions), renders, theme palette,
               fonts, waveform drawing, formatting
```

## Tests

```bash
cd src-tauri && cargo test
```

Covers key and name parsing, keys that fit a scale, how well a pitch profile fits one, embedded
metadata, analysis, resampling and mixing, search and filters (scales and notes that fit
included, and the fit sort), indexing a real folder end to end, stretch and
repitch accuracy, regions, crossfades and reverse, the metronome, the Lab synth's tuning and
envelopes, progressions landing with the click and following a loop's beats, MIDI clips, renders,
tempo, key and pitch detection, similarity, the map layout, and every frontend command through
Tauri's IPC layer.

To check the name parser against your own library (names only, nothing is decoded):

```bash
cd src-tauri && SAGA_SCAN_DIR="/path/to/samples" cargo test --lib meta::report -- --ignored --nocapture
```

Detection accuracy, how well stored pitch profiles fit the keys in sample names (where the notes
that fit threshold comes from; set `SAGA_DUMP=profiles.json` to keep the profiles) and similarity
quality against your own tagged samples (decodes a few hundred files, read-only):

```bash
cd src-tauri && SAGA_SCAN_DIR="/path/to/samples" cargo test --release --lib detect::report -- --ignored --nocapture
cd src-tauri && SAGA_SCAN_DIR="/path/to/samples" cargo test --release --lib sounds::report -- --ignored --nocapture
```

## Next

Phase 4: Ableton Link, so the project tempo follows your DAW.
