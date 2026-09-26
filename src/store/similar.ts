import { create } from "zustand";
import { api, errorMessage } from "../lib/api";
import type { Aspect, RecordLevel, SampleRow, SimilarItem, SimilarResult } from "../lib/types";
import { rowPatchListeners, useBrowse } from "./browse";
import { usePrefs } from "./prefs";
import { toast } from "./toasts";

export type SimilarTarget = { kind: "sample"; row: SampleRow } | { kind: "recording" } | { kind: "file"; name: string; path: string };

interface SimilarState {
  target: SimilarTarget | null;
  /** Only search this library folder. */
  sourceId: number | null;
  items: SimilarItem[];
  loading: boolean;
  message: string | null;
  described: number;
  pending: number;
  /** Highlighted result, for keyboard browsing (-1 for none). */
  index: number;
  /** Set while listening to the microphone. */
  recording: { level: number; seconds: number } | null;

  find: (row: SampleRow) => void;
  refresh: () => void;
  /** Tries again when results were waiting for analysis. */
  refreshIfWaiting: () => void;
  setAspect: (aspect: Aspect) => void;
  setScope: (sourceId: number | null) => void;
  fromFile: (path: string) => void;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  cancelRecording: () => void;
  onLevel: (e: RecordLevel) => void;
  select: (index: number, opts?: { play?: boolean }) => void;
  move: (delta: number) => void;
}

let seq = 0;

export const useSimilar = create<SimilarState>((set, get) => {
  const run = async (target: SimilarTarget, request: () => Promise<SimilarResult>, keepIndex = false) => {
    const mine = ++seq;
    set({ target, loading: true, ...(keepIndex ? {} : { index: -1 }) });
    try {
      const res = await request();
      if (mine !== seq) return;
      const t = res.target && target.kind === "sample" ? { kind: "sample" as const, row: res.target } : target;
      set({ target: t, items: res.items, message: res.message, described: res.described, pending: res.pending, loading: false });
    } catch (e) {
      if (mine !== seq) return;
      set({ items: [], message: errorMessage(e), loading: false });
    }
  };

  const request = (target: SimilarTarget) => {
    const { similarAspect } = usePrefs.getState();
    const { sourceId } = get();
    switch (target.kind) {
      case "sample":
        return () => api.findSimilar(target.row.id, similarAspect, sourceId);
      case "file":
        return () => api.similarToFile(target.path, similarAspect, sourceId);
      case "recording":
        return () => api.similarToRecording(similarAspect, sourceId);
    }
  };

  return {
    target: null,
    sourceId: null,
    items: [],
    loading: false,
    message: null,
    described: 0,
    pending: 0,
    index: -1,
    recording: null,

    find: (row) => {
      const target: SimilarTarget = { kind: "sample", row };
      void run(target, request(target));
    },

    refresh: () => {
      const t = get().target;
      if (t) void run(t, request(t), true);
    },

    refreshIfWaiting: () => {
      const s = get();
      if (s.target && !s.loading && s.pending > 0 && s.items.length < 10) s.refresh();
    },

    setAspect: (aspect) => {
      usePrefs.getState().set({ similarAspect: aspect });
      get().refresh();
    },

    setScope: (sourceId) => {
      set({ sourceId });
      get().refresh();
    },

    fromFile: (path) => {
      const name = path.split(/[\\/]/).pop() ?? path;
      const target: SimilarTarget = { kind: "file", name, path };
      void run(target, request(target));
    },

    startRecording: async () => {
      if (get().recording) return;
      set({ recording: { level: 0, seconds: 0 } });
      try {
        await api.startRecording();
      } catch (e) {
        set({ recording: null });
        toast(errorMessage(e));
      }
    },

    stopRecording: async () => {
      if (!get().recording) return;
      set({ recording: null });
      const { similarAspect } = usePrefs.getState();
      await run({ kind: "recording" }, () => api.stopRecording(similarAspect, get().sourceId));
    },

    cancelRecording: () => {
      set({ recording: null });
      void api.cancelRecording();
    },

    onLevel: (e) => {
      if (!get().recording) return;
      if (e.done) void get().stopRecording();
      else set({ recording: { level: e.level, seconds: e.seconds } });
    },

    select: (index, opts) => {
      const item = get().items[index];
      if (!item) return;
      set({ index });
      useBrowse.getState().selectRow(item.row, -1, opts);
    },

    move: (delta) => {
      const { items, index } = get();
      if (!items.length) return;
      const next = index < 0 ? (delta > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, index + delta));
      if (next !== index) get().select(next);
    },
  };
});

rowPatchListeners.add((id, patch) => {
  const s = useSimilar.getState();
  const hit = s.items.some((i) => i.row.id === id) || (s.target?.kind === "sample" && s.target.row.id === id);
  if (!hit) return;
  useSimilar.setState({
    items: s.items.map((i) => (i.row.id === id ? { ...i, row: { ...i.row, ...patch } } : i)),
    target: s.target?.kind === "sample" && s.target.row.id === id ? { kind: "sample", row: { ...s.target.row, ...patch } } : s.target,
  });
});
