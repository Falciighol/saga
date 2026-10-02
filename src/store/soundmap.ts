import { create } from "zustand";
import { api, errorMessage } from "../lib/api";
import { decodeLayout, decodeMatches, type MapData } from "../lib/soundmap";
import type { SampleRow } from "../lib/types";
import { backendFilters, useBrowse } from "./browse";
import { usePrefs } from "./prefs";

interface SoundMapState {
  data: MapData | null;
  /** Arranging (the first time can take a second or two). */
  loading: boolean;
  error: string | null;
  /** 1 per point that matches the search and filters, or null when all do. */
  matches: Uint8Array | null;
  matched: number;
  /** Samples picked with the lasso. */
  selection: number[];
  /** Legend focus: only this color group is drawn at full strength. */
  isolate: number | null;
  /** The sound under the pointer, with its color on the map; shown in the Similar sounds panel. */
  hovered: { row: SampleRow; color: string } | null;
  load: () => Promise<void>;
  refreshMatches: () => Promise<void>;
  setSelection: (ids: number[]) => void;
  setIsolate: (group: number | null) => void;
  setHovered: (hovered: SoundMapState["hovered"]) => void;
}

let loadSeq = 0;
let matchSeq = 0;
let lastRetry = 0;

export const useSoundMap = create<SoundMapState>((set, get) => ({
  data: null,
  loading: false,
  error: null,
  matches: null,
  matched: 0,
  selection: [],
  isolate: null,
  hovered: null,

  load: async () => {
    const mine = ++loadSeq;
    const kind = useBrowse.getState().kind;
    set({ loading: true, error: null });
    try {
      const layout = await api.soundMap(kind === "all" ? null : kind, usePrefs.getState().mapArrange);
      if (mine !== loadSeq) return;
      const data = decodeLayout(layout);
      const keep = new Set(get().selection.filter((id) => data.index.has(id)));
      set({ data, loading: false, selection: [...keep] });
      await get().refreshMatches();
    } catch (e) {
      if (mine === loadSeq) set({ loading: false, error: errorMessage(e) });
    }
  },

  refreshMatches: async () => {
    const data = get().data;
    if (!data) return;
    const mine = ++matchSeq;
    try {
      const res = await api.mapMatches(data.key, backendFilters(useBrowse.getState()));
      if (mine !== matchSeq || get().data !== data) return;
      set({ matches: decodeMatches(res.bits, data.count), matched: res.matched });
    } catch {
      // The layout was rearranged meanwhile; fetch the new one (but never in a tight loop).
      if (mine === matchSeq && !get().loading && Date.now() - lastRetry > 2000) {
        lastRetry = Date.now();
        void get().load();
      }
    }
  },

  setSelection: (selection) => set({ selection }),
  setIsolate: (isolate) => set({ isolate }),
  setHovered: (hovered) => set({ hovered }),
}));
