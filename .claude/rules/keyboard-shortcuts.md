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
   Return if the key is an arrow on a range input, or Enter/Space on a button, switch or menu item
   the keyboard moved focus to (`keyboardFocusedControl`), so tabbing to a control and pressing it
   works. A control focused by a mouse click never counts, so Space after clicking still plays.
3. Then `Mod+K`/`Mod+F`, `Mod+Shift+F`, `Mod+A`, `Mod+R`/`Mod+Shift+R`, `Mod+,`. `Mod+R` is always swallowed, since
   the web view would otherwise reload.
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
| `Mod R` | not typing (search box is fine) | `renameTargets()` (lib/actions): picked samples or the selected one | README, Settings list, "Rename…" menu hints, SelectionBar Rename title |
| `Mod ⇧ R` | row selected, not typing (search box is fine) | `reveal(row.path)` (lib/actions) | README, Settings list, `revealLabel()` menu hint, PreviewPanel reveal button label |
| `Mod ,` | | `openSettings()` (App state) | README, Settings list |
| `↑ ↓` (⇧ = 10) | no editor; in the search box too | `browse.move(±1/±10)`. On the map: `similar.move` | README, Settings list (both, plus the map row), SampleCard hint |
| `Enter` | in search or not typing, a row selected | `player.play(row)` from the start | README, Settings list |
| `Space` | not typing | `player.toggle(row)` | README, Settings list, `sampleMenu` hint |
| `←` | row selected | `player.seek(row, 0)` | README, Settings list |
| `F` | row selected | `browse.toggleFavorite(row)` | README, Settings list, `sampleMenu` hint |
| `⌫` / `Del` | a collection is open, list view or mini, no editor | `removeFromCollection(view.id, targetIds())` (lib/actions, Undo toast) | README, Settings list, "Remove from this collection" menu hints |
| `L` | row selected | `toggleLoop(row)` (lib/actions): flips `prefs.loopLoops` or `loopShots` by kind, turns Play next off when turning looping on, then `player.setLooping` | README, Settings list, "Loop (L)" labels in PreviewPanel, MiniPlayer, Editor |
| `E` | row selected, not mini | `useEditor.open(id)` / `close()` | README, Settings list, PreviewPanel title |
| `M` | not mini, no editor | `ui.toggleView()` (list ⇄ map) | README, Settings list |
| `H` | not mini | `ui.toggleLab()` | README, Settings list, ProjectControls "(H)" title |
| `G` | row selected, not mini | `findSimilar(row)` (lib/actions) | README, Settings list, PreviewPanel title, `sampleMenu` hint |
| `⇧ R` | row selected | `useEdits.update(id, { reverse })` | README, Settings list, "Reverse (⇧R)" labels |
| `R` | | `stepRecording()` (store/record): opens the Record panel (or the mini player's strip), then arm → record now → stop. The global shortcut (Settings › Recording, `record-shortcut` event) calls `stepRecording(true)`, which opens and arms in one press | README Recording table, Settings list, Record button titles |
| `[` `]` | row selected | `stepPitch(row, ±1)` (project.ts; follows the scale when scale lock is on) | README, Settings list, key popover text |
| `S` | | `project.set({ sync: !sync })` | README, Settings list, ProjectControls title |
| `K` | a project key is set | `project.set({ matchKey: !matchKey })` | README, Settings list, PreviewPanel title |
| `T` | | `useTapTempo` → `project.set({ bpm })` | README, Settings list, ProjectControls and TempoTools titles |

### Escape, first match wins
cancel recording (`similar.recording`) → stop the Record panel's source when armed or recording, keeping the take
(not typing) → clear picks (more than one picked, not typing, not on
the map) → close the editor (not typing) → clear search text (in search with text) → blur the
focused input → clear the map lasso selection → stop playback → close the Record panel. In the Lab, Esc (when not typing)
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
- Preview and mini player waveforms (`useSeekOrDrag` in PreviewPanel), when focused: `← →` seek a beat (`⇧` a
  bar; a twentieth or a quarter of a one-shot), `Home` back to where playback starts. They stop propagation, so the
  global `←` waits until the waveform loses focus; `↑ ↓` still browse.
- Drag tile and mini player Drag button after a failed render: `Enter`/`Space` try again.
- The takes list (`TakeList` in record/Takes.tsx, a focusable listbox): `↑ ↓` move and preview, `Space` plays,
  `Enter` plays from the start, `⌫`/`Del` move to the Trash (Undo toast), `Mod S` saves to Recordings, `F2` renames.
  They stop propagation, so the global keys don't also run. The rename field: `Enter` keeps, `Esc` cancels.
- The Record stage's start-line handle (a slider): `↑ ↓` ±1 dB (⇧ ±6), `⌫`/`Del` back to following the noise floor.
- Settings › Recording shortcut picker: while listening, the next key press with `Mod`, `Alt` or `Ctrl` (or a function
  key) becomes the shortcut; `Esc` cancels.
- The Record panel is not a dialog: it doesn't set `role="dialog"`, so browsing keys keep working while a take is armed.
- List header (`ListHeader` in ListColumns), on a focused column title: `⌥/Alt ← →` move the column (`stepColumn`,
  announced in a live region), `⇧F10` or the menu key open its column menu. `Enter` sorts, or opens the menu for a
  title that can't sort. `Esc` during a header drag drops it where it started.
- Menus (`MenuList` in Menu.tsx): `↑ ↓ Home End` move between rows, `→` opens a submenu, `←` goes back, `Enter`/`Space`
  choose, `Tab` closes. A menu opened from the keyboard focuses its first row and gives focus back when it closes. One
  opened with the mouse takes the keyboard on the first `↑`/`↓` (handled in `MenuHost`).

### Mouse plus modifier
`Mod`-click a row toggles it in the picked set, `⇧`-click picks a range (`⇧+Mod` adds a range),
double-click plays (SampleList). `Mod`/`⇧`-click a category combines categories (TypeBar).
`Alt`-click a tag excludes it (FilterPanel). `Alt`-click a folder's arrow in the Sidebar
opens or closes it with every folder inside closed (`toggleFolder` → `useLibrary.collapseAll`; also shown in the
arrow's `title`, the README Browsing table and the Settings list). `⇧`-drag on the map switches audition and lasso, and
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
