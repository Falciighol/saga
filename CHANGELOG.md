<!--
What's new in each version of Saga. The app bundles this file and shows it after an update and in
Settings › Updates, and scripts/release-notes.mjs copies a version's section into its GitHub release.

Write for producers, not developers: say what changed for them, not which file changed.

- Add changes under "## Unreleased" as they land. `npm run set-version` turns that heading into the
  version and today's date.
- Under a version: one sentence on the headline change, then any of these sections, in this order:
  "### Good to know" (something that needs the user's attention: a re-listen, a changed shortcut),
  "### New", "### Improved", "### Fixed". Leave out the ones with nothing in them.
- An entry is "- **Name**: what it does." The name is optional, and fixes usually don't need one.
- Keys go in backticks, separated by spaces: `G`, `Mod ⇧ F`, `Alt click`. "Mod" shows as ⌘ or Ctrl
  and "Alt" as ⌥ or Alt, so one line is right on both systems.
-->

# Changelog

## 1.0.4

Apple Loops play and get analyzed, the sample you're playing is analyzed first, and the list shows the columns you choose.

### Good to know
- Samples Saga couldn't read before, like most Apple Loops, get listened to once more. Only those files, not your whole library.

### New
- **Choose your columns**: right-click the list's header to show, hide and reorder columns, including when a file was created. Sort by it, or filter by date in the filters.
- **What's new**: after an update, a small note says what changed. Open it any time from Settings › Updates.
- **Remove from a collection**: in an open collection, `⌫` takes the selected samples out of it, with Undo.
- **Fold folders away**: close a folder in the sidebar to hide what's inside. `Alt click` on a folder's arrow closes every folder inside it too.
- **Save rename patterns**: keep a rename pattern under a name of your own, next to the built-in presets.
- **Choose where an export goes**: exporting from the editor asks where to save the file.

### Improved
- **Apple Loops**: AAC loops in `.caf` files, which most Apple Loops are, now play, show waveforms and get a tempo and key.
- **The playing sample goes first**: while Saga is still listening to your library, the sample you're playing is analyzed next, so its tempo and key show up right away.
- **Numbers sort the way you'd count**: `Kick 2` comes before `Kick 10`, in sample names and folders.
- **Menus work from the keyboard**: arrow keys, Enter and Esc move through menus and submenus, and focus goes back where it was when a menu closes.
- **Filters from anywhere**: `Mod ⇧ F` opens the filters from the Lab, the editor or the mini player too.
- **Every shortcut in Settings**: the list in Settings is grouped like the README and now includes all of them.

### Fixed
- Dropping samples on a collection works on macOS, and dropping a sample you've changed adds the original to the collection.
- Clicking a lit token button in Rename takes that token back out of the name instead of adding it twice. A new Clear button empties the name.
- Saga's window no longer runs scripts that could arrive through file names or tags.

## 1.0.3 — 2026-10-04

You can now drag the sidebar to the width you want, and menus no longer run off the edge of the window.

### New
- **Resizable sidebar**: drag the sidebar's right edge to make it wider or narrower. You can also focus the edge and nudge it with `← →` (hold `⇧` for bigger steps), or double-click it to go back to the default width. Saga remembers your width.
- **Full names on hover**: when a name is cut off with "…", hover over it to see the full text.

### Improved
- **Menus fit the window**: menus and submenus stay inside the window, however small. If a submenu has no room beside its menu, it opens in its place, with a back button at the top.
- **Long menu labels**: they're trimmed with "…" instead of stretching the menu.

## 1.0.2 — 2026-10-04

Select several samples at once, fix a wrong key or tempo yourself, and rename files with their key and tempo.

### Good to know
- Renaming changes the file on disk. DAW projects that already use a renamed file will look for it under its old name, so use Undo if you rename by mistake.
- Setting a key or tempo yourself never changes the audio file.

### New
- **Select several samples**: `Mod click`, `⇧ click` or `Mod A` picks many samples. A bar appears so you can set their key or tempo, rename them, favorite them, add them to a collection, or drag them all into your DAW at once, each as you hear it.
- **Set key and tempo yourself**: when Saga gets one wrong, click the key or tempo in the preview, right-click a sample, or use the selection bar. Your values win over detection and survive rescans. "Use what Saga found" puts the detected value back.
- **Rename files**: Rename… (`Mod R`) writes a sample's key, tempo, date or category into its file name. Build a name from tokens or pick a preset, and choose how keys are written (`F#m`, `F# minor`, Camelot `11A`). A preview shows every new name and any clash before anything changes, and Ableton's `.asd` file is renamed along with each sample.
- **Undo renames**: the "Renamed 12 files" message has an Undo button that puts the old names back.
- **Use as its key**: in the Lab's key finder, one click saves the key you settled on to the sample.
- **Leave out folders**: pick which folders inside a library folder Saga skips, when adding folders or from Settings. You can also leave out a kind of folder everywhere by name, like `Vocals` or `Stem*`.
- **Tempos with two decimals**: a Settings option shows every tempo as `124.00`. Off by default.

### Improved
- **Clearer Settings**: Settings is grouped into appearance, playback, library folders, renders and saved sounds.
- **Renders take less space**: previews prepared ahead of time wait in a temporary cache, and a render is saved to your Renders folder only when you drag it out. Settings shows how much space renders use and can move old ones to the Trash.
- **Choose where saved sounds go**: pick the folder for renders, Lab clips and saved variations. Files you've already saved stay where they are, so your DAW projects keep working.
- **More exact tempos**: tempos show up to two decimals (`123.45`) instead of rounding to one.

## 1.0.1 — 2026-10-02

Leave subfolders out of your library, and drag the project key's scale into your DAW as MIDI.

### New
- **Exclude subfolders**: when you add a folder, untick the subfolders you don't want. Later, right-click any folder in the sidebar and choose Exclude from library. Bring one back from Settings › Library folders.
- **Drag the scale as MIDI**: the project key popup has a Drag scale as MIDI tile. Drop it into your DAW for a clip that runs up the key's scale. Include related keys adds a bar for each related key.
- **Support Saga**: Settings has Gumroad and PayPal donation links. Saga stays free, and donations are optional.

### Improved
- **Sound map**: drag across the map to hear each sound you pass. `⇧` drag or the lasso selects a group for a collection.
- **Similar sounds**: the panel shows the details of the sound under the pointer.

## 1.0.0 — 2026-09-28

The first release of Saga.
