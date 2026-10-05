import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { AudioLines, Copy, FolderSearch, FolderPlus, Gauge, KeyRound, ListMinus, Music2, Pause, PenLine, Play, Plus, Star, X } from "lucide-react";
import { create } from "zustand";
import type { MenuItem } from "../components/Menu";
import { usePrompt } from "../components/Prompt";
import { SimilarIcon } from "../components/ViewToggle";
import { targetIds, targetRows, useBrowse } from "../store/browse";
import { useLab } from "../store/lab";
import { useLibrary } from "../store/library";
import { useEditor } from "../store/editor";
import { shouldLoop, usePlayer } from "../store/player";
import { usePrefs } from "../store/prefs";
import { useSimilar } from "../store/similar";
import { useUi } from "../store/ui";
import { toast } from "../store/toasts";
import { api, errorMessage } from "./api";
import { computeProcessing } from "./processing";
import { fileFor } from "./renders";
import { editFor, useProject } from "../store/project";
import { modKey, revealLabel } from "./platform";
import { keyName } from "./keys";
import { useRename } from "../components/Rename";
import { COLLECTION_COLORS } from "./theme";
import type { KeyChange, SampleRow, TempoChange } from "./types";

// ---- dragging samples out to a DAW or Finder ----

let dragIconPath: string | null = null;

export async function initDragIcon() {
  try {
    dragIconPath = await api.dragIcon();
  } catch {
    dragIconPath = null;
  }
}

/**
 * True while one of our own files is being dragged, so drops back onto the window aren't mistaken
 * for new folders. `ids` are the samples behind it: a render's path isn't in the library, so a drop
 * on a collection adds these instead of looking the paths up.
 */
export const useDragState = create<{ internal: boolean; ids: number[] }>(() => ({ internal: false, ids: [] }));

export function dragOut(paths: string[], ids: number[] = []) {
  if (!dragIconPath || paths.length === 0) return;
  useDragState.setState({ internal: true, ids });
  startDrag({ item: paths, icon: dragIconPath }, () => useDragState.setState({ internal: false, ids: [] })).catch((e) => {
    useDragState.setState({ internal: false, ids: [] });
    toast(`Couldn't start the drag: ${errorMessage(e)}`);
  });
}

/** Drags what you hear: the original, or (with sync, key matching or edits) a render of it. */
export function dragSample(row: SampleRow) {
  const p = computeProcessing(row, useProject.getState(), editFor(row.id));
  if (!p.processed) {
    dragOut([row.path], [row.id]);
    return;
  }
  // Renders are cached, so this is usually instant; a fresh one takes a moment while the mouse is held.
  fileFor(row, p, true)
    .then((path) => dragOut([path], [row.id]))
    .catch((e) => toast(`Couldn't render: ${errorMessage(e)}`));
}

/** Drags several samples at once, each as you'd hear it. Renders are made first, while the mouse is held. */
export function dragSamples(rows: SampleRow[]) {
  const online = rows.filter((r) => r.online);
  if (online.length <= 1) {
    if (online[0]) dragSample(online[0]);
    return;
  }
  const project = useProject.getState();
  const files = online.map((row) => {
    const p = computeProcessing(row, project, editFor(row.id));
    return p.processed ? fileFor(row, p, true) : Promise.resolve(row.path);
  });
  Promise.all(files)
    .then((paths) => dragOut(paths, online.map((r) => r.id)))
    .catch((e) => toast(`Couldn't render: ${errorMessage(e)}`));
}

// ---- tempo and key set by hand ----

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function count(n: number, one: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : `${one}s`}`;
}

/** Sets tempo and/or key on these samples and shows the change everywhere they're listed. */
export async function applyValues(ids: number[], change: { tempo?: TempoChange; key?: KeyChange }) {
  if (!ids.length) return;
  try {
    const rows = await api.setSampleValues(ids, change);
    useBrowse.getState().replaceRows(rows);
    // Filters and facets count keys and tempos.
    useBrowse.getState().refresh();
    if (ids.length > 1) toast(`Updated ${count(rows.length, "sample")}`, "info");
  } catch (e) {
    toast(errorMessage(e));
  }
}

/** Key choices for these samples: any major or minor key, a root note, none, or back to what Saga found. */
export function keySubmenu(ids: number[], rows: SampleRow[] = []): MenuItem[] {
  const one = rows.length === 1 ? rows[0] : null;
  const is = (pc: number, mode: number) => one != null && one.keyPc === pc && one.keyMode === mode;
  const set = (pc: number, mode: 0 | 1 | 2) => () => void applyValues(ids, { key: { to: "key", pc, mode } });
  const anyByHand = rows.length === 0 || rows.some((r) => r.keySource === "user");
  return [
    { label: "Major", submenu: Array.from({ length: 12 }, (_, pc) => ({ label: keyName(pc, 0), checked: is(pc, 0), onSelect: set(pc, 0) })) },
    { label: "Minor", submenu: Array.from({ length: 12 }, (_, pc) => ({ label: keyName(pc, 1), checked: is(pc, 1), onSelect: set(pc, 1) })) },
    { label: "Root note", submenu: Array.from({ length: 12 }, (_, pc) => ({ label: NOTE_NAMES[pc], checked: is(pc, 2), onSelect: set(pc, 2) })) },
    "separator",
    { label: "No key", checked: one?.keySource === "user" && one.keyPc == null, onSelect: () => void applyValues(ids, { key: { to: "noKey" } }) },
    { label: "Use what Saga found", disabled: !anyByHand, onSelect: () => void applyValues(ids, { key: { to: "detected" } }) },
  ];
}

/** Asks for a tempo to give these samples. */
export function askTempo(ids: number[], initial?: number | null) {
  usePrompt.getState().ask({
    title: ids.length > 1 ? `Tempo for ${count(ids.length, "sample")}` : "Tempo",
    placeholder: "e.g. 124 or 123.45",
    initial: initial ? String(Math.round(initial * 100) / 100) : "",
    confirm: "Set tempo",
    onSubmit: (value) => {
      const bpm = Number(value.replace(",", ".").replace(/\s*bpm$/i, ""));
      if (!Number.isFinite(bpm) || bpm < 20 || bpm > 999) {
        toast("Enter a tempo between 20 and 999 BPM");
        return;
      }
      void applyValues(ids, { tempo: { to: "bpm", bpm } });
    },
  });
}

export function tempoSubmenu(ids: number[], rows: SampleRow[] = []): MenuItem[] {
  const one = rows.length === 1 ? rows[0] : null;
  const anyByHand = rows.length === 0 || rows.some((r) => r.bpmSource === "user");
  const items: MenuItem[] = [{ label: "Set tempo…", onSelect: () => askTempo(ids, one?.bpm) }];
  if (one?.bpm) {
    const bpm = one.bpm;
    items.push(
      // "Set to", because unlike the preview's "Play at half time" these change the tempo Saga keeps for the sample.
      { label: `Set to half (${Math.round(bpm * 50) / 100})`, onSelect: () => void applyValues(ids, { tempo: { to: "bpm", bpm: bpm / 2 } }) },
      { label: `Set to double (${Math.round(bpm * 200) / 100})`, onSelect: () => void applyValues(ids, { tempo: { to: "bpm", bpm: bpm * 2 } }) },
    );
  }
  items.push(
    "separator",
    { label: "No tempo", checked: one?.bpmSource === "user" && one.bpm == null, onSelect: () => void applyValues(ids, { tempo: { to: "noTempo" } }) },
    { label: "Use what Saga found", disabled: !anyByHand, onSelect: () => void applyValues(ids, { tempo: { to: "detected" } }) },
  );
  return items;
}

/** Opens the project key picker in the title bar, for controls that need a project key and don't have one yet. */
export function askProjectKey() {
  window.dispatchEvent(new Event(OPEN_PROJECT_KEY));
}

/** The window event `askProjectKey` sends; the title bar's KeyControl opens on it. */
export const OPEN_PROJECT_KEY = "saga:open-project-key";

/** Opens the rename dialog for the picked samples, or the selected one. */
export async function renameTargets() {
  try {
    const rows = await targetRows();
    if (rows.length) await useRename.getState().open(rows);
  } catch (e) {
    toast(errorMessage(e));
  }
}

/** Favorites every picked sample. */
async function favoriteAll(ids: number[]) {
  try {
    await api.setFavorite(ids, true);
    void useLibrary.getState().refreshStats();
    useBrowse.getState().refresh();
  } catch (e) {
    toast(errorMessage(e));
  }
}

/** The right-click menu when several samples are picked: what applies to all of them. */
export function pickedMenu(): MenuItem[] {
  const browse = useBrowse.getState();
  const ids = targetIds(browse);
  const view = browse.view;
  return [
    { label: "Key", icon: <KeyRound size={14} />, submenu: keySubmenu(ids) },
    { label: "Tempo", icon: <Gauge size={14} />, submenu: tempoSubmenu(ids) },
    { label: `Rename ${count(ids.length, "file")}…`, icon: <PenLine size={14} />, hint: `${modKey}R`, onSelect: () => void renameTargets() },
    "separator",
    { label: "Add to favorites", icon: <Star size={14} />, onSelect: () => void favoriteAll(ids) },
    { label: "Add to collection", icon: <FolderPlus size={14} />, submenu: collectionSubmenu(ids) },
    ...(view.type === "collection"
      ? [
          {
            label: "Remove from this collection",
            icon: <ListMinus size={14} />,
            hint: "⌫",
            onSelect: () => void removeFromCollection(view.id, ids),
          } as MenuItem,
        ]
      : []),
    "separator",
    { label: "Clear selection", icon: <X size={14} />, hint: "Esc", onSelect: () => browse.clearPicked() },
  ];
}

// ---- common sample actions ----

/** Turns looping on or off for this kind of sample (loops or one-shots). Turning it on stops Play next,
 *  which would otherwise keep the sample from repeating. */
export function toggleLoop(row: SampleRow) {
  const next = !shouldLoop(row);
  usePrefs.getState().set({ ...(row.kind === "loop" ? { loopLoops: next } : { loopShots: next }), ...(next ? { playNext: false } : {}) });
  const player = usePlayer.getState();
  if (player.id === row.id) player.setLooping(next);
}

/** Turns Play next on or off. A loop that's repeating now plays to its end and moves on. */
export function setPlayNext(on: boolean) {
  usePrefs.getState().set({ playNext: on });
  const player = usePlayer.getState();
  if (player.row && player.status !== "idle") player.setLooping(shouldLoop(player.row));
}

/** Rows to look past for one whose drive is connected before giving up. */
const NEXT_LOOKAHEAD = 200;

/** With Play next on, plays the sample after the one that just ended: the next row of the list, or of
 *  Similar sounds on the map. Does nothing when you've since selected another sample or opened the editor. */
export async function playNextAfter(id: number | null) {
  if (!usePrefs.getState().playNext || id == null || usePlayer.getState().id !== id || useEditor.getState().openId != null) return;
  const ui = useUi.getState();
  if (ui.view === "map" && !ui.mini) {
    const similar = useSimilar.getState();
    if (similar.items[similar.index]?.row.id !== id) return;
    const next = similar.items.findIndex((x, i) => i > similar.index && x.row.online);
    if (next >= 0) similar.select(next, { play: true });
    return;
  }
  const browse = useBrowse.getState();
  if (browse.selected?.id !== id || browse.total == null) return;
  const from = browse.selectedIndex;
  for (let i = from + 1; i < Math.min(browse.total, from + 1 + NEXT_LOOKAHEAD); i++) {
    const row = await browse.loadRow(i);
    // Something else was played or selected while the next page loaded.
    if (useBrowse.getState().selected?.id !== id || usePlayer.getState().id !== id) return;
    if (!row) return;
    if (row.online) {
      useBrowse.getState().selectRow(row, i, { play: true });
      return;
    }
  }
}

/** Opens a Lab tool on this sample: the key finder, or the tuner for a one-shot. */
export function openInLab(row: SampleRow, index: number, tool: "finder" | "tempo") {
  useBrowse.getState().selectRow(row, index, { play: false });
  if (useUi.getState().mini) useUi.getState().setMini(false);
  useLab.getState().set(tool === "finder" ? { tool, finderSource: "sample" } : { tool });
  useUi.getState().setView("lab");
}

/** Shows the sound map with the samples that sound most like this one. */
export function findSimilar(row: SampleRow) {
  if (useUi.getState().mini) useUi.getState().setMini(false);
  useUi.getState().setView("map");
  useSimilar.getState().find(row);
}

export async function reveal(path: string) {
  try {
    await revealItemInDir(path);
  } catch (e) {
    toast(errorMessage(e));
  }
}

/** Opens a web page in the default browser. */
export async function openLink(url: string) {
  try {
    await openUrl(url);
  } catch (e) {
    toast(errorMessage(e));
  }
}

export async function copyText(text: string, what = "Path") {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`, "info");
  } catch {
    toast("Couldn't copy to the clipboard");
  }
}

export async function addToCollection(collectionId: number, ids: number[]) {
  try {
    await api.addToCollection(collectionId, ids);
    await useLibrary.getState().refreshCollections();
    const name = useLibrary.getState().collections.find((c) => c.id === collectionId)?.name;
    toast(`Added to ${name ?? "collection"}`, "info");
  } catch (e) {
    toast(errorMessage(e));
  }
}

/** Takes samples out of a collection (the files and the rest of the library aren't touched), with Undo. */
export async function removeFromCollection(collectionId: number, ids: number[]) {
  if (!ids.length) return;
  const refresh = async () => {
    await useLibrary.getState().refreshCollections();
    useBrowse.getState().refresh();
  };
  try {
    await api.removeFromCollection(collectionId, ids);
    if (ids.length > 1) useBrowse.getState().clearPicked();
    await refresh();
    const name = useLibrary.getState().collections.find((c) => c.id === collectionId)?.name;
    toast(`Removed ${count(ids.length, "sample")} from ${name ?? "the collection"}`, "info", {
      label: "Undo",
      run: () =>
        void api
          .addToCollection(collectionId, ids)
          .then(refresh)
          .catch((e) => toast(errorMessage(e))),
    });
  } catch (e) {
    toast(errorMessage(e));
  }
}

export function newCollection(withIds: number[] = []) {
  usePrompt.getState().ask({
    title: "New collection",
    placeholder: "e.g. Go-to kicks",
    confirm: "Create",
    onSubmit: async (name) => {
      try {
        const existing = useLibrary.getState().collections.length;
        const id = await api.createCollection(name, COLLECTION_COLORS[existing % COLLECTION_COLORS.length].hex);
        if (withIds.length) await api.addToCollection(id, withIds);
        await useLibrary.getState().refreshCollections();
      } catch (e) {
        toast(errorMessage(e));
      }
    },
  });
}

export function collectionSubmenu(ids: number[], memberOf: number[] = []): MenuItem[] {
  const collections = useLibrary.getState().collections;
  return [
    ...collections.map<MenuItem>((c) => ({
      label: c.name,
      checked: memberOf.includes(c.id),
      icon: <span className="block h-2 w-2 rounded-full" style={{ background: c.color }} />,
      onSelect: () => void addToCollection(c.id, ids),
    })),
    ...(collections.length ? (["separator"] as MenuItem[]) : []),
    { label: "New collection…", icon: <Plus size={14} />, onSelect: () => newCollection(ids) },
  ];
}

export function sampleMenu(row: SampleRow, index: number): MenuItem[] {
  const browse = useBrowse.getState();
  const player = usePlayer.getState();
  const playing = player.id === row.id && player.status === "playing";
  const view = browse.view;
  return [
    {
      label: playing ? "Pause" : "Play",
      icon: playing ? <Pause size={14} /> : <Play size={14} />,
      hint: "Space",
      onSelect: () => {
        browse.selectRow(row, index, { play: false });
        player.toggle(row);
      },
    },
    {
      label: row.favorite ? "Remove from favorites" : "Add to favorites",
      icon: <Star size={14} />,
      hint: "F",
      onSelect: () => browse.toggleFavorite(row),
    },
    { label: "Find similar sounds", icon: <SimilarIcon size={14} />, hint: "G", onSelect: () => findSimilar(row) },
    { label: "Find its key", icon: <Music2 size={14} />, onSelect: () => openInLab(row, index, "finder") },
    ...(row.kind === "oneshot" ? [{ label: "Tune it to the key", icon: <AudioLines size={14} />, onSelect: () => openInLab(row, index, "tempo") } as MenuItem] : []),
    { label: "Add to collection", icon: <FolderPlus size={14} />, submenu: collectionSubmenu([row.id]) },
    "separator",
    { label: "Key", icon: <KeyRound size={14} />, submenu: keySubmenu([row.id], [row]) },
    { label: "Tempo", icon: <Gauge size={14} />, submenu: tempoSubmenu([row.id], [row]) },
    { label: "Rename…", icon: <PenLine size={14} />, hint: `${modKey}R`, onSelect: () => useRename.getState().open([row]) },
    ...(view.type === "collection"
      ? [
          {
            label: "Remove from this collection",
            icon: <ListMinus size={14} />,
            hint: "⌫",
            onSelect: () => void removeFromCollection(view.id, [row.id]),
          } as MenuItem,
        ]
      : []),
    "separator",
    { label: revealLabel(), icon: <FolderSearch size={14} />, hint: `${modKey}⇧R`, onSelect: () => void reveal(row.path) },
    { label: "Copy path", icon: <Copy size={14} />, onSelect: () => void copyText(row.path) },
  ];
}
