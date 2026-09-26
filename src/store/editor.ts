import { create } from "zustand";

export type Snap = "off" | "beat" | "bar";

interface EditorState {
  /** Sample open in the editor, or null when browsing. */
  openId: number | null;
  /** Visible range in seconds; null means the whole file. */
  view: { start: number; end: number } | null;
  snap: Snap;
  open: (id: number) => void;
  close: () => void;
  setView: (view: { start: number; end: number } | null) => void;
  setSnap: (snap: Snap) => void;
}

export const useEditor = create<EditorState>((set) => ({
  openId: null,
  view: null,
  snap: "bar",
  open: (id) => set({ openId: id, view: null }),
  close: () => set({ openId: null }),
  setView: (view) => set({ view }),
  setSnap: (snap) => set({ snap }),
}));
