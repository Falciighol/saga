import { create } from "zustand";
import { api, errorMessage } from "../lib/api";
import type { Collection, DirNode, IndexProgress, LibraryStats, SourceInfo } from "../lib/types";
import { toast } from "./toasts";

export const dirKey = (sourceId: number, dir: string) => `${sourceId}:${dir}`;

interface LibraryState {
  loaded: boolean;
  sources: SourceInfo[];
  collections: Collection[];
  stats: LibraryStats | null;
  progress: IndexProgress;
  dirs: Record<string, DirNode[]>;
  expanded: Record<string, boolean>;

  refresh: () => Promise<void>;
  refreshStats: () => Promise<void>;
  refreshCollections: () => Promise<void>;
  setProgress: (p: IndexProgress) => void;
  toggleExpanded: (sourceId: number, dir: string) => void;
  loadDirs: (sourceId: number, dir: string) => Promise<void>;
  addFolders: (paths: string[]) => Promise<number>;
  removeSource: (id: number) => Promise<void>;
  rescan: (id: number) => Promise<void>;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  loaded: false,
  sources: [],
  collections: [],
  stats: null,
  progress: { scanning: false, found: 0, done: 0, total: 0, watching: 0, refreshing: false },
  dirs: {},
  expanded: {},

  refresh: async () => {
    try {
      const [sources, collections, stats] = await Promise.all([api.listSources(), api.collections(), api.stats()]);
      set({ sources, collections, stats, loaded: true });
      // Keep open folders in the tree current.
      for (const key of Object.keys(get().expanded)) {
        if (!get().expanded[key]) continue;
        const [id, ...rest] = key.split(":");
        void get().loadDirs(Number(id), rest.join(":"));
      }
    } catch (e) {
      toast(errorMessage(e));
    }
  },

  refreshStats: async () => {
    try {
      set({ stats: await api.stats() });
    } catch {
      /* stats are cosmetic */
    }
  },

  refreshCollections: async () => {
    try {
      set({ collections: await api.collections() });
    } catch (e) {
      toast(errorMessage(e));
    }
  },

  setProgress: (progress) => set({ progress }),

  toggleExpanded: (sourceId, dir) => {
    const key = dirKey(sourceId, dir);
    const open = !get().expanded[key];
    set((s) => ({ expanded: { ...s.expanded, [key]: open } }));
    if (open) void get().loadDirs(sourceId, dir);
  },

  loadDirs: async (sourceId, dir) => {
    try {
      const nodes = await api.listDirs(sourceId, dir);
      set((s) => ({ dirs: { ...s.dirs, [dirKey(sourceId, dir)]: nodes } }));
    } catch (e) {
      toast(errorMessage(e));
    }
  },

  addFolders: async (paths) => {
    if (paths.length === 0) return 0;
    try {
      const ids = await api.addSources(paths);
      await get().refresh();
      if (ids.length === 0) toast("Those folders are already in your library", "info");
      return ids.length;
    } catch (e) {
      toast(errorMessage(e));
      return 0;
    }
  },

  removeSource: async (id) => {
    try {
      await api.removeSource(id);
      await get().refresh();
    } catch (e) {
      toast(errorMessage(e));
    }
  },

  rescan: async (id) => {
    try {
      await api.rescanSource(id);
    } catch (e) {
      toast(errorMessage(e));
    }
  },
}));
