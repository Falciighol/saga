---
target: src/components/FilterBar.tsx
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Volumes/OREO/Code/Personal/Projects/saga/src/components/FilterBar.tsx"
target_fingerprint: "sha256:ba3484f7e29a18e8f805be2cad1652fa4a9bc288acbe91279cdd37026630470b"
target_path: /Volumes/OREO/Code/Personal/Projects/saga/src/components/FilterBar.tsx
timestamp: 2026-10-06T09-31-01Z
slug: src-components-filterbar-tsx
closed: true
---
Method: dual-agent (A: design review sub-agent · B: detector + browser sub-agent)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Overflowing pills hidden with no cue; count blanks while a query runs (FilterBar.tsx:136) |
| 2 | Match System / Real World | 3 | Producer words throughout; "Not tape" terse but readable |
| 3 | User Control and Freedom | 2 | Reset wipes filters + type + categories with no Undo; focus drops to body after Esc / pill removal |
| 4 | Consistency and Standards | 2 | "Reset" vs panel "Clear" with different scopes; identical sort-direction icon both ways; menuitemcheckbox for single-choice sort |
| 5 | Error Prevention | 2 | Fit-to-key guard is good; Reset is broad, one click, irreversible |
| 6 | Recognition Rather Than Recall | 2 | Filter button never shows Cmd+Shift+F; overflowed pills must be remembered; pill opens whole panel not its section |
| 7 | Flexibility and Efficiency | 2 | Cmd+Shift+F opens panel without focusing it (44 tabs away); no keys for Sort/Shuffle |
| 8 | Aesthetic and Minimalist Design | 3 | Calm, tokenized, both themes calibrated; ~580px dead middle while the pill row is starved |
| 9 | Error Recovery | 3 | Empty list offers "Clear search and filters"; nothing says which filter emptied it |
| 10 | Help and Documentation | 2 | Panel's "As a search" footer is clipped off-screen at 1280x800 |
| **Total** | | **23/40** | **Acceptable** |

## Design Specificity Verdict

LLM: Structure is a category-interchangeable SaaS table toolbar; Saga lives only in values (x1/2x2 tempo, A min + compatible, Camelot / Fit to the key sorts, mono numerals). The bar ignores the lead promise ("it plays in your key"): no one-tap "fits my project" filter despite project tempo/key sitting 40px above.

Deterministic scan: impeccable detect clean on FilterBar.tsx and FilterPanel.tsx ([]). In-page detector, 3 runs (dark/empty, dark/6 pills, light/5 pills): zero findings in the filter bar. Off-target: sidebar progress width transition, 21 cramped-padding on list tag chips (likely false positive), What's new card heavy shadow, light search placeholder contrast, page em-dash count. Measurements caught what the detector cannot: overflow hiding the bar's own controls, clipped focus ring, light pill label ~4.50:1.

## Priority Issues

[P1] Overflow hides the filter entry point. "+ Filter" and Reset live inside the hidden-scrollbar pill row (FilterBar.tsx:110-134). 1280px, 6 pills: row 653 vs 884-935 content; Filters button and Reset off-screen, last pill cut mid-word. At 428px main width row is 33px. Fix: pin Filter + Reset outside the scroller; wrap pills or collapse "+N more"; @container steps for the right cluster; move ViewToggle out. Commands: layout, adapt.

[P1] Keyboard focus breaks around panel and pills. Row is exactly 28px with overflow, so focus ring top/bottom clipped on every pill, x, Filters, Reset. Cmd+Shift+F leaves focus on body; Esc and pill removal drop focus to body. Fix: py-1 -my-1 on row; focus first panel control on open; restore to Filter button on close; focus next pill after removal; aria-haspopup/aria-controls. Command: harden.

[P2] Filter panel runs off a normal window. At 1280x800 panel spans y147-900, overflow hidden; Done/Clear/match count/"As a search" unreachable; fixed w-[832px] overflows at 200%; modal-ish so no auditioning while tuning. Fix: cap height, scroll body, sticky footer; open-from-pill scrolls to its section; consider non-modal drawer. Command: adapt.

[P2] Reset vs Clear: two verbs, two scopes, no Undo. clearAll (browse.ts:300-302) clears filters + kind + categories but not search tokens; panel Clear only clears panel filters. Fix: one scoped label ("Clear filters"), info toast with Undo, decide on search tokens. Command: clarify.

[P2] Sort-direction icon never changes. ArrowDownUp rotate-180 (FilterBar.tsx:141) is rotationally symmetric. Fix: ArrowUp/ArrowDown, click-to-flip, menuitemradio. Command: polish.

## Persona Red Flags

Alex: Cmd+Shift+F opens an unreachable panel; shortcut not shown; no Sort/Shuffle keys; no Reset undo; no arrow-key pill navigation.
Sam: clipped focus ring; focus lost to body; no aria-live on count; tag pill x reads "Remove tag filter" without tag name, excluded reads "Remove not filter" (:33, :88-90); Filter button scrolls out of a 33px row at 200%.
Producer next to Ableton: no "fits my project" filter; panel covers the list; typed bpm:/key: don't become pills (two sources of truth); Done off-screen in default window.

## Minor Observations

- Count blanks during queries; keep last value dimmed.
- "0 results" has no emphasis or hint.
- Excluded-tag pills only differ by "Not"; panel uses strike-through.
- Shuffle: active without aria-pressed; reshuffles; duplicates "Shuffled" in Sort menu.
- Pill label text3 on raised, light: 4.495:1; hover raised2: 4.27 dark / 4.14 light.
- Filter dashed border and pill fill vs bar 1.42-1.54:1.
- ViewToggle (app navigation) unseparated from list-ordering controls.
- Sort menu 10-12 flat items, no grouping.
- "Filter" to "Filters" swap plus count badge is redundant.

## Questions to Consider

1. Why isn't "my project's key and tempo" one tap on this bar?
2. Should search tokens and pills be one system?
3. Does ViewToggle belong here?
4. Could the panel be a non-modal drawer?
