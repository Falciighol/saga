import { create } from "zustand";
import { api, errorMessage } from "../lib/api";
import type { Collection, DirNode, IndexProgress, LibraryStats, SourceInfo } from "../lib/types";
import { toast } from "./toasts";

export const dirKey = (sourceId: number, dir: string) => `${sourceId}:${dir}`;

/** True when `key` is a folder somewhere below `dir`. A source's own key ("3:") is a prefix of its folders' keys, so it's ruled out by name. */
export function isBelow(key: string, sourceId: number, dir: string): boolean {
  const own = dirKey(sourceId, dir);
  return key !== own && key.startsWith(dir ? `${own}/` : own);
}

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
  /** Closes every folder inside `dir`, leaving `dir` itself as it is. With no source, closes every folder in the tree. */
  collapseAll: (sourceId?: number, dir?: string) => void;
  loadDirs: (sourceId: number, dir: string) => Promise<void>;
  addFolders: (paths: string[], exclude?: Record<string, string[]>) => Promise<number>;
  /** Leaves a subfolder out of the library (its samples go), or lets it back in. */
  setExcluded: (sourceId: number, dir: string, excluded: boolean) => Promise<boolean>;
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
      // Every source's top level is always loaded, so the sidebar knows whether to offer an arrow. Then keep open folders current.
      const wanted = new Set(sources.map((s) => dirKey(s.id, "")));
      for (const key of Object.keys(get().expanded)) if (get().expanded[key]) wanted.add(key);
      for (const key of wanted) {
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

  collapseAll: (sourceId, dir = "") => {
    if (sourceId == null) return set({ expanded: {} });
    set((s) => ({ expanded: Object.fromEntries(Object.entries(s.expanded).filter(([k]) => !isBelow(k, sourceId, dir))) }));
  },

  loadDirs: async (sourceId, dir) => {
    try {
      const nodes = await api.listDirs(sourceId, dir);
      set((s) => ({ dirs: { ...s.dirs, [dirKey(sourceId, dir)]: nodes } }));
    } catch (e) {
      toast(errorMessage(e));
    }
  },

  setExcluded: async (sourceId, dir, excluded) => {
    try {
      await api.setDirExcluded(sourceId, dir, excluded);
      await get().refresh();
      return true;
    } catch (e) {
      toast(errorMessage(e));
      return false;
    }
  },

  addFolders: async (paths, exclude) => {
    if (paths.length === 0) return 0;
    try {
      const ids = await api.addSources(paths, exclude);
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
