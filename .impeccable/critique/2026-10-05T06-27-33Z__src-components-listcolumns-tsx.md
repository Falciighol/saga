---
target: src/components/ListColumns.tsx
total_score: 20
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:/Volumes/OREO/Code/Personal/Projects/saga/src/components/ListColumns.tsx"
target_fingerprint: "sha256:24e9ca00718d991799644e1da84f850a19056cb05fabc5c0a01d7541e172189d"
target_path: /Volumes/OREO/Code/Personal/Projects/saga/src/components/ListColumns.tsx
timestamp: 2026-10-05T06-27-33Z
slug: src-components-listcolumns-tsx
---
# Critique: src/components/ListColumns.tsx

Method: dual-agent (A: design review · B: detector + browser)

## Design health score: 20/40 (Acceptable)
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | Sorted state is text3→text2 (1.47:1) plus an 11px arrow; BPM/key show "—" while pending |
| 2 | Match system / real world | 3 | Menu vs header labels disagree (Tempo/BPM, Times played/Plays, Sample rate/Rate) |
| 3 | User control and freedom | 2 | No Undo on hide, Esc doesn't cancel drag, no header path back to Best match |
| 4 | Consistency and standards | 2 | Header 12px out of line with rows; sans and mono cells mixed |
| 5 | Error prevention | 1 | Name can collapse to 0px |
| 6 | Recognition rather than recall | 2 | Drag/right-click only in a title tooltip; key dot unexplained |
| 7 | Flexibility and efficiency | 2 | No keyboard reorder, no presets, 2N clicks for N columns |
| 8 | Aesthetic and minimalist design | 3 | Calm at defaults, degrades with columns |
| 9 | Error recovery | 1 | "Can't read this file" only in the waveform cell |
| 10 | Help and documentation | 2 | README documents it; tooltip reaches only pointer users |

## Design specificity
Generic file-browser table header; product character lives only in cells (≈, source tooltips, key-match dot, units). Detector: 0 findings in ListColumns.tsx, listColumns.ts, SampleList.tsx. Overlay: 2 page-wide (layout-transition on the sidebar progress bar, off target; em-dash overuse, false positive from "—" placeholders).

## Priority issues
- [P0] Name column collapses to 0px (all columns 1440px, or default at 200% scale); static `narrow` hides checked columns silently; fixed 180px waveform. Fix: name min width, elastic waveform, priority-based column dropping via ResizeObserver, "+N hidden" badge, no horizontal scroll. → /impeccable adapt
- [P1] Header/row misalignment (12px, scrollbar gutter) and header doesn't follow horizontal scroll. Fix: scrollbar-gutter: stable or sticky header in the scroller. → /impeccable polish
- [P1] Pointer-only and AT-opaque: no keyboard reorder, 9 headers unfocusable, Menu has no arrow keys/roving focus/menuitemcheckbox, no aria-sort, header names are pointer instructions, rows read as unlabeled strings. → /impeccable harden
- [P2] Columns menu closes after each toggle, 15/18 flat items, label mismatch, "Hide tempo" under "BPM". Fix: keep open, group, bridging labels, presets. → /impeccable distill
- [P2] Key-match dot: 6px, color-only, light contrast 2.44:1 / 1.42:1, unexplained; absent in mini player. → /impeccable clarify

## Persona red flags
- Alex: no keyboard reorder, menu not arrow-navigable, no Esc to cancel drag.
- Sam: no aria-sort, unannounced checked state, unlabeled row values, dot has no text.
- Producer beside the DAW: no key-match in mini player; columns vanish silently ~960px; names useless at 125–150%.

## Minor observations
Tags no "+n"; Length precision mixed; BPM column of dashes in One-shots; mixed cell fonts; Loudness/Plays unsortable; no grab affordance; low-salience sorted label; only Length shows pending "…".

## Questions
- Presets tied to One-shots/Loops instead of 14 toggles (barsCount exists, no Bars column)?
- Why does the name give up space while the waveform is fixed?
- Could the Key column state the relationship ("fits", "relative", "+2 st")?
