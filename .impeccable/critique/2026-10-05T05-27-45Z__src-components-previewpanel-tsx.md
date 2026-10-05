---
target: src/components/PreviewPanel.tsx
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Volumes/OREO/Code/Personal/Projects/saga/src/components/PreviewPanel.tsx"
target_fingerprint: "sha256:ac5f0e87d2453097e41be9f4917f0ad5ae1c2003941c07ee0c89e1db36285d34"
target_path: /Volumes/OREO/Code/Personal/Projects/saga/src/components/PreviewPanel.tsx
timestamp: 2026-10-05T05-27-45Z
slug: src-components-previewpanel-tsx
closed: true
---
Method: dual-agent (A: design review sub-agent · B: detector + browser sub-agent)

# Critique: Preview panel (src/components/PreviewPanel.tsx)

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Playhead, clock, "Rendering…", "in sync" and ≈ report state well. A disconnected drive never shows in the panel; a render error's cause is only in a hover tooltip; the clock vanishes below a 980px panel. |
| 2 | Match with the real world | 3 | Producer words throughout. "Loop loops (L)", a bare "×1.379" and "original" read oddly. |
| 3 | User control and freedom | 3 | Revert edits and session-only edits are good. Pitch resets only by double-click; Revert has no Undo. |
| 4 | Consistency and standards | 2 | In half time the ruler says 1 bar while the meta line says 2 bars. Loop label differs from the mini player. Match switch looks live but ignores clicks without a project key. |
| 5 | Error prevention | 2 | "Half time (87)" (session playback) sits in the same menu as "The sample's tempo › Half (87)", which rewrites the stored tempo. An offline sample's drag tile shows a grab cursor but won't drag. |
| 6 | Recognition rather than recall | 3 | Section labels and shortcut hints help; Play next, Reverse and Metronome are icon-only. |
| 7 | Flexibility and efficiency | 3 | Strong single-key shortcuts. No key for the tempo menu, Collect, Reveal, Metronome or Revert. |
| 8 | Aesthetic and minimalist design | 3 | Calm, one accent, mono tabular numbers. Header crowded; piles up at narrow widths. |
| 9 | Error recovery | 2 | "Couldn't render" with no visible cause and no retry. Offline only surfaces as a toast after pressing Play. |
| 10 | Help and documentation | 3 | Empty state teaches the keys; source tooltips are honest. |
| **Total** | | **27/40** | **Acceptable** |

## Design Specificity Verdict

LLM assessment: authored for Saga in its readouts (≈125.8 → 120 ×0.954, ≈F#m → Am, "Up to E (+2 st), in A Dorian", Stretch/Repitch wording, a drag tile that names the render) and in a waveform drawn as heard. Generic in composition: five same-weight bordered buttons beside tag chips, and the headline promise ("what you hear is what you drag") lives in the quietest element.

Deterministic scan: CLI 0 findings (regex on .tsx). In-page: 11 at 1024×768 dark, 9 in the panel. text-overflow ×3 (name, .wav, folder path; true, gone at 1440px). undersized-ui-text ×5 (10.5px ruler labels ×4 at line 175, drag-tile status line at line 350; true by rule). nested-cards ×1 on the drag tile (false positive). Outside the panel: sidebar progress bar animates width (Sidebar.tsx:179); em-dash advisory is list placeholders (false positive); light-theme search placeholder exactly 4.50:1.

## Overall Impression

The thinking is excellent; the layout is average. The panel was laid out for one window size and breaks at Saga's own 1000px minimum and at larger interface sizes, and the drag-out step is styled like "Collect". Biggest opportunity: rebuild around hear it, fit it, drag it, and let everything else yield when space runs short.

## What's Working

1. Honest readouts at the point of decision (lines 399–402, 584–586).
2. A drag tile that says what you'll get, with pre-rendering (lines 320–354).
3. The waveform only animates while playing (lines 96–163).

## Priority Issues

1. [P1] Breaks at Saga's own minimum window and at large interface sizes. Fixed 264px height (480); single-line rows that never wrap; tags shrink-0 (262) push the name to 0px; metronome clipped at 1000px; at 200% the list shows 0 rows. Fix: name on its own line, tags capped with +N, header wraps to two tiers, transport collapses in steps, height clamp(160px, 35%, 264px). Command: /impeccable adapt
2. [P1] Enter and Space never press the focused control: useHotkeys.ts:118 and :149 preventDefault on window keydown; waveform and drag tile tabIndex -1 (189, 333); slider lacks aria-valuenow. Fix: skip Enter/Space on buttons/switches/menuitems/links; focusable waveform with arrow seek. Command: /impeccable harden
3. [P1] Two tempos under one label: "87 → 120" (399) vs list's 174; ruler bars from processed tempo (71) vs meta from file tempo (468); "Half time" (session) beside "The sample's tempo › Half" (persistent, actions.tsx:148). Fix: "174 ½× → 120", one bar source, menu groups "Play it at…" / "Change this sample's tempo…". Command: /impeccable clarify
4. [P2] Drag tile is the quietest control and hides failures: styled like Collect (343), 10.5px status; offline still shows grab cursor (331); render error cause only in title (335), no retry. Fix: accent-soft fill, ≥11px status line carrying states, dim waveform offline. Command: /impeccable harden then /impeccable bolder
5. [P2] Controls that look live but aren't: Match switch without a project key (589–594); pitch reset double-click only and includes Match's shift (430); "Loop loops (L)" (555) vs "Loop (L)". Command: /impeccable clarify

## Persona Red Flags

Alex: no key for tempo menu/Collect/Reveal/Metronome/Revert; 87 vs 174; clock hides when narrower; Revert edits squeezes the name to "S…".
Sam: Enter/Space hijacked; waveform and drag tile unreachable by Tab; 200% clips name and controls; Match announced enabled but inert; 18×18 tag remove; off switch track ~1.3:1; no live announcements.
Producer next to Ableton: ruler vs meta bars disagree; "Rendering…" is a 10.5px pulse; at minimum width metronome clipped and clock hidden; LUFS buried in an 11.5px line.

## Minor Observations

Line 509 indentation; reversed bar-1 label clipped at right edge (175); tags first 5 only, blur discards input (281), no Undo on remove; Collect shows no loading and swallows errors (526); "One-shot" in the Tempo slot (371); waveform aria-label is mouse-only (190); hover shows seconds while ruler shows bars; hardcoded text-[14px]/[10.5px]/[11.5px]; volume has no readout or reset; empty state takes 264px on short windows. Not checked: native drag, real audio, render error, disconnected drive; panel not in mini player.

## Questions to Consider

- Why isn't the waveform itself the drag handle?
- Should the file's tempo and the playback tempo be two labelled lines?
- Do favorite, tags, Collect, Reveal and Find similar belong on the audition surface?
- Should the panel's height follow the window like a DAW detail view?
