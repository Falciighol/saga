---
paths:
  - "src/hooks/**"
  - "src/components/**"
  - "src/lib/actions.tsx"
  - "src/lib/platform.ts"
  - "src/store/ui.ts"
  - "src/store/lab.ts"
  - "README.md"
---

# Keyboard shortcuts: where they live and what they're tied to

## The global handler

All app-wide keys are handled by **one** `window` keydown listener: `useHotkeys` in
`src/hooks/useHotkeys.ts`, mounted once from `App.tsx`. The order of checks matters:

1. `Mod + = / + / - / _ / 0` change the interface size. This works everywhere, even with dialogs
   open.
2. **Gate:** return if a context menu is open (`useMenu`) or any `[role="dialog"]` is in the DOM.
   Return if the key is an arrow on a range input.
3. Then `Mod+K`/`Mod+F`, `Mod+Shift+F`, `Mod+A`, `Mod+,`.
4. **Lab block** (view is `lab`, not mini, no editor, not typing, no modifier): the keys depend on
   the Lab tool, and `progressionKey()` handles the Progressions tool.
5. `↑ ↓` (not while the editor is open), `Enter`, `Escape` (a priority chain, see below).
6. Then **return if typing or any modifier is held**. Everything after this is a bare letter key.

`Mod` = ⌘ on macOS, Ctrl on Windows. Always use `hasMod(e)` from `src/lib/platform.ts`, and
`modKey` when showing it.

## Full map

| Key | When | Calls | Shown in |
| --- | --- | --- | --- |
| `Mod +` / `Mod −` / `Mod 0` | always | `prefs.set({ uiScale })` via `stepScale` | README, Settings list, Settings › Interface size hint |
| `Mod K`, `Mod F` | not with Shift | focus and select the search input (`search` ref from TitleBar/MiniPlayer) | README (both), Settings list (`⌘K`), `Kbd` in TitleBar and MiniPlayer |
| `/` | not typing | focus search | README, Settings list |
| `Mod ⇧ F` | | leave mini / map / Lab / editor for the list, then dispatch `saga:open-filters` (FilterBar) | README, Settings list |
| `Mod A` | list view, not mini, no editor, not typing | `browse.pickAll()` | README, Settings list |
| `Mod ,` | | `openSettings()` (App state) | README, Settings list |
| `↑ ↓` (⇧ = 10) | no editor; in the search box too | `browse.move(±1/±10)`. On the map: `similar.move` | README, Settings list (both, plus the map row), SampleCard hint |
| `Enter` | in search or not typing, a row selected | `player.play(row)` from the start | README, Settings list |
| `Space` | not typing | `player.toggle(row)` | README, Settings list, `sampleMenu` hint |
| `←` | row selected | `player.seek(row, 0)` | README, Settings list |
| `F` | row selected | `browse.toggleFavorite(row)` | README, Settings list, `sampleMenu` hint |
| `L` | row selected | flips `prefs.loopLoops` or `loopShots` by kind, then `player.setLooping` | README, Settings list, "Loop (L)" labels in PreviewPanel, MiniPlayer, Editor |
| `E` | row selected, not mini | `useEditor.open(id)` / `close()` | README, Settings list, PreviewPanel title |
| `M` | not mini, no editor | `ui.toggleView()` (list ⇄ map) | README, Settings list |
| `H` | not mini | `ui.toggleLab()` | README, Settings list, ProjectControls "(H)" title |
| `G` | row selected, not mini | `findSimilar(row)` (lib/actions) | README, Settings list, PreviewPanel title, `sampleMenu` hint |
| `R` | row selected | `useEdits.update(id, { reverse })` | README, Settings list, "Reverse (R)" labels |
| `[` `]` | row selected | `stepPitch(row, ±1)` (project.ts; follows the scale when scale lock is on) | README, Settings list, key popover text |
| `S` | | `project.set({ sync: !sync })` | README, Settings list, ProjectControls title |
| `K` | a project key is set | `project.set({ matchKey: !matchKey })` | README, Settings list, PreviewPanel title |
| `T` | | `useTapTempo` → `project.set({ bpm })` | README, Settings list, ProjectControls and TempoTools titles |

### Escape, first match wins
cancel recording (`similar.recording`) → clear picks (more than one picked, not typing, not on
the map) → close the editor (not typing) → clear search text (in search with text) → blur the
focused input → clear the map lasso selection → stop playback. In the Lab, Esc (when not typing)
calls `stopNotes()`, `stopProgression()` and `player.stop()` instead.

### In the Lab (`view === "lab"`)
| Tool | Keys | Calls |
| --- | --- | --- |
| Scales | `↑ ↓` scale, `← →` root, `Space` play | `lab.stepScale` + `playScale`, `lab.stepRoot` + `playChord`(tonic) |
| Progressions | `Space` play/stop, `← →` bar, `↑ ↓` chord, `⌫`/`Del` clear | `toggleProgression`, `selectBar` + `auditionChord`, `setChord` |
| Key finder, Tempo & tuning | fall through to the list keys (`↑ ↓`, `Space`, `T`) | |

These are listed in `TOOLS[].hint` in `components/lab/LabView.tsx`, in the README's Views table,
in the Settings list's "In the Lab" group and in the Progressions "Clear bar ⌫" menu hint.

### Keys handled locally (component `onKeyDown`, not global)
- ProjectControls BPM input: `Enter` blurs, `Esc` reverts, `↑ ↓` ±1 (⇧ ±10).
- Sidebar resize handle: `← →` ±10 px (⇧ ±40), clamped by `clampSidebar`.
- RangeSlider: arrows ±1% (⇧ ×5). KeyWheel segments: `Enter`/`Space`.
- InstalledFontPicker: `↑ ↓ Enter Esc`. SettingsDialog folder-name input: `Enter` adds,
  `Backspace` on an empty field removes the last name.
- Esc closes: Prompt, Confirm, Rename, AddFolders, ExcludeFolders, FilterPanel/FilterBar, Popover,
  Menu (capture phase), SettingsDialog (only when it's the only dialog open).
- PreviewPanel tag input, TempoTools and Editor number inputs: `Enter` commits/blurs, `Esc` cancels.

### Mouse plus modifier
`Mod`-click a row toggles it in the picked set, `⇧`-click picks a range (`⇧+Mod` adds a range),
double-click plays (SampleList). `Mod`/`⇧`-click a category combines categories (TypeBar).
`Alt`-click a tag excludes it (FilterPanel). `⇧`-drag on the map switches audition and lasso, and
`Alt`-drag or middle-drag pans. `Ctrl`/`⌘` + wheel zooms the Editor and map, which is how
trackpad pinch arrives. `⇧`-click a chord in Scales puts it in the progression's selected bar.

## Notes
- `Mod F` is a deliberate alias for search. It's mentioned in the README but left off the Settings
  list to keep it short.
- `Mod ⇧ F` first leaves the mini player, map, Lab or editor (FilterBar only exists in the list
  view), then dispatches `saga:open-filters` on the next tick.
- The Settings list (`SHORTCUTS` in `SettingsDialog.tsx`) is grouped exactly like the README tables
  (Browsing, Processing, Views, In the Lab). Each entry is `[alternatives[], description]`.

## Adding or changing a shortcut: checklist
1. Handle it in `useHotkeys.ts` at the right point in the order above. Check the guards (`row`,
   `ui.mini`, `editing`, `typing`, view) and whether the key clashes with the Lab block or the
   map. Bare letters must sit after the `typing || modifier` return.
2. Call a store action or a `lib/actions` function. Don't put logic in the handler, so the button,
   the menu item and the key all run the same function.
3. Update **every** place it's shown: the `SHORTCUTS` array in `SettingsDialog.tsx`, the README
   "Keyboard shortcuts" tables, the `(X)` suffix in the matching button `title`/`label`, the
   `hint` on the matching `MenuItem` in `lib/actions.tsx`, and the Lab `TOOLS[].hint` if it's a
   Lab key.
4. Check it on macOS and Windows: `hasMod`, and `modKey` in text. Never hardcode ⌘ or Ctrl.
5. If it opens a panel that takes keys, the panel needs `role="dialog"` so the global keys stop.

## Where this should go (a target, not a refactor to do unprompted)
The key, label and description are repeated in five places. The maintainable shape is a single
registry, for example `src/lib/shortcuts.ts` exporting `{ id, keys, label, scope, when }[]`. The
Settings list, the README table (generated or checked by a script), tooltips (`withKey(label, id)`)
and menu hints would all read from it, and `useHotkeys` would look up by `id`. If you're asked to
work on shortcuts, suggest this first. Otherwise follow the checklist above.
