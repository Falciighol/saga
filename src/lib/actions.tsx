import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AudioLines, Copy, FolderSearch, FolderPlus, ListMinus, Music2, Pause, Play, Plus, Star } from "lucide-react";
import { create } from "zustand";
import type { MenuItem } from "../components/Menu";
import { usePrompt } from "../components/Prompt";
import { SimilarIcon } from "../components/ViewToggle";
import { useBrowse } from "../store/browse";
import { useLab } from "../store/lab";
import { useLibrary } from "../store/library";
import { usePlayer } from "../store/player";
import { useSimilar } from "../store/similar";
import { useUi } from "../store/ui";
import { toast } from "../store/toasts";
import { api, errorMessage } from "./api";
import { computeProcessing } from "./processing";
import { fileFor } from "./renders";
import { editFor, useProject } from "../store/project";
import { revealLabel } from "./platform";
import { COLLECTION_COLORS } from "./theme";
import type { SampleRow } from "./types";

// ---- dragging samples out to a DAW or Finder ----

let dragIconPath: string | null = null;

export async function initDragIcon() {
  try {
    dragIconPath = await api.dragIcon();
  } catch {
    dragIconPath = null;
  }
}

/** True while one of our own samples is being dragged, so drops back onto the window aren't mistaken for new folders. */
export const useDragState = create<{ internal: boolean }>(() => ({ internal: false }));

export function dragOut(paths: string[]) {
  if (!dragIconPath || paths.length === 0) return;
  useDragState.setState({ internal: true });
  startDrag({ item: paths, icon: dragIconPath }, () => useDragState.setState({ internal: false })).catch((e) => {
    useDragState.setState({ internal: false });
    toast(`Couldn't start the drag: ${errorMessage(e)}`);
  });
}

/** Drags what you hear: the original, or (with sync, key matching or edits) a render of it. */
export function dragSample(row: SampleRow) {
  const p = computeProcessing(row, useProject.getState(), editFor(row.id));
  if (!p.processed) {
    dragOut([row.path]);
    return;
  }
  // Renders are cached, so this is usually instant; a fresh one takes a moment while the mouse is held.
  fileFor(row, p)
    .then((path) => dragOut([path]))
    .catch((e) => toast(`Couldn't render: ${errorMessage(e)}`));
}

// ---- common sample actions ----

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
    ...(view.type === "collection"
      ? [
          {
            label: "Remove from this collection",
            icon: <ListMinus size={14} />,
            onSelect: async () => {
              await api.removeFromCollection(view.id, [row.id]);
              await useLibrary.getState().refreshCollections();
              useBrowse.getState().refresh();
            },
          } as MenuItem,
        ]
      : []),
    "separator",
    { label: revealLabel(), icon: <FolderSearch size={14} />, onSelect: () => void reveal(row.path) },
    { label: "Copy path", icon: <Copy size={14} />, onSelect: () => void copyText(row.path) },
  ];
}
