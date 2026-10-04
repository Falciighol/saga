# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Saga is a Tauri 2 desktop app (macOS universal, Windows) whose whole interface is a React web UI. It keeps one design
language on both operating systems; only shortcut modifiers, labels like "Show in Finder/Explorer" and window controls
differ, and those go through `src/lib/platform.ts`.

## Users

Primary: working music producers with large sample libraries, often tens of thousands of files spread across several
folders and drives that come and go. They use Saga in the middle of a session, next to a DAW (often in the mini player,
kept on top), to find, audition and drag sounds into a track without breaking flow. They are keyboard-heavy, judge a
browser by how fast it answers, and notice CPU or audio-device contention immediately.

When needs conflict, this user wins: newer producers are welcome, but defaults must never slow down someone who already
knows what they want. Real users compare Saga with MAKID (session tools) and Transnomino (batch renaming).

## Product Purpose

A fast, smart sample browser. Point it at sample folders and it indexes them where they are, works out tempo, key and
what each sound is, and lets the producer search, audition and drag samples into the DAW already stretched and pitched to
fit the track. Success is the producer finding the right sound in seconds and dropping it in without re-tuning or
re-timing it by hand.

## Positioning

All four of these lead; together they are what neighbours (Splice, ADSR Sample Manager, Sononym, XO, MAKID) can't
truthfully claim at once:

1. **It plays in your key.** A project tempo and key make loops sync and pitch while you audition, and the file you drag
   out is a render of exactly what you heard (preview, editor, export and render share one processing path).
2. **Local, private, files stay put.** Indexes in place, never moves or copies files, renames only when asked, no
   account, no telemetry; the update check is the only network request and can be turned off.
3. **It hears your samples.** Tempo, key and category from names, embedded loop data and the audio itself; Find similar,
   find by recording, and the sound map.
4. **The Lab.** Scales, progressions, key finder and tempo/tuning tools that feed straight back into browsing (project
   key, filter by scale, samples that fit).

## Operating Context

- Runs beside a DAW (Ableton Live is the reference; `.asd` files are renamed along with samples). Drag and drop into the
  DAW, Finder or Explorer is the main way sounds leave Saga.
- Long sessions, often in dim studios; Graphite dark is the default, with a light theme.
- Libraries live on internal and external drives; drives disconnect and reconnect, and favorites, tags and collections
  wait for them.
- First run listens to every sample once ("Listening to your samples"), which takes minutes on a big library; search
  works immediately while similarity and the map fill in.
- Mini player: a narrow always-on-top window with search, list and preview.

## Capabilities and Constraints

- Views: library list, sound map (`M`), the Lab (`H`); editor (`E`), Find similar (`G`), filters, collections,
  favorites, tags, multi-select with a selection bar, Rename dialog, Settings.
- Detection order of trust: file name, embedded loop data, audio. Audio-detected values are marked with ≈. Values the
  user sets by hand win over everything and survive rescans.
- **Files stay put.** Never move, copy over or edit a user's sample files. Renaming only through the Rename dialog, with
  a preview and Undo; never automatic or background renaming.
- **Nothing is deleted for good.** User-visible files go to the OS Trash, and only on request. Only Saga's own scratch
  cache is pruned automatically.
- **Private.** No telemetry, analytics, remote fonts or CDNs. Fonts are bundled.
- **Stays out of the DAW's way.** Analysis at low priority; the audio device is opened on first play and released after
  a stretch of silence.
- **What you hear is what you drag.** One processing path for preview, editor, export and render.
- Keyboard-first: nearly every action has a shortcut, listed in the README and in Settings.
- Interface size 75%–200%, six accent colours, bundled interface and numbers fonts or any installed font.
- Terminology in the UI: sample, loop, one-shot, project tempo, project key, Sync, Stretch, Repitch, Match key, scale
  lock, collection, render, saved sounds, the Lab, sound map, Find similar.
- Distribution: free to use (including for released music), not redistributable; source readable. Voluntary donations
  via Gumroad. Next on the roadmap: Ableton Link.

## Brand Commitments

- Name: Saga. App icon at `design/app-icon.png`.
- Voice (from the README and in-app copy): plain, direct, second person, short sentences, concrete examples
  (`Loop_124_Am`, `bpm:120-128`) instead of adjectives. States limits honestly, such as detection accuracy and that DAW
  projects will look for a renamed file under its old name. No hype.

## Evidence on Hand

- Screenshots: `docs/screenshots/` (hero dark and light, filters, editor, sound map, Lab scales, Lab progressions) and
  the copies in `gumroad/assets/`.
- That is the only usable proof. There are no testimonials, user quotes, download or usage numbers, press, or customer
  logos; do not invent any.
- The README states measured detection accuracy (tempo right for 70–80% of named loops; keys right or relative about
  70% of the time) as an honest caveat. Don't promote these figures into headline marketing proof without asking.

## Product Principles

1. **The session comes first.** Every interaction is judged by whether it keeps a producer in flow next to the DAW:
   instant answers, keyboard reach, low CPU, no held audio device.
2. **Trust is the feature.** The user's files, choices and privacy are never touched behind their back. Anything
   destructive is explicit, previewed and reversible.
3. **Show what Saga knows, and how sure it is.** Detected values are marked as detected; values the user sets are final.
4. **Hear it, then use it as heard.** Audition and output never diverge.
5. **Harmony feeds the browser.** Theory tools exist to find and fit sounds, not as a standalone toy.

## Accessibility & Inclusion

No formal standard has been set. Observed in the code and worth keeping: full keyboard operation, `prefers-reduced-motion`
handling, interface scaling to 200%, and a choice of fonts including Atkinson Hyperlegible Next.
