import { create } from "zustand";
import { api, errorMessage } from "../lib/api";
import type { Facets, Filters, KeyFilter, Kind, SampleRow, SortKey } from "../lib/types";
import { useLibrary } from "./library";
import { usePlayer } from "./player";
import { usePrefs } from "./prefs";
import { toast } from "./toasts";

export type View =
  | { type: "all" }
  | { type: "favorites" }
  | { type: "recent-added" }
  | { type: "recent-played" }
  | { type: "collection"; id: number }
  | { type: "folder"; sourceId: number; dir: string };

export interface AdvancedFilters {
  bpmMin: number | null;
  bpmMax: number | null;
  halfDouble: boolean;
  key: KeyFilter | null;
  durMin: number | null;
  durMax: number | null;
  formats: string[];
  channels: 1 | 2 | null;
  sampleRates: number[];
  tags: string[];
  excludeTags: string[];
}

export const EMPTY_FILTERS: AdvancedFilters = {
  bpmMin: null,
  bpmMax: null,
  halfDouble: false,
  key: null,
  durMin: null,
  durMax: null,
  formats: [],
  channels: null,
  sampleRates: [],
  tags: [],
  excludeTags: [],
};

export const PAGE_SIZE = 100;

interface Page {
  version: number;
  rows: SampleRow[];
}

interface BrowseState {
  view: View;
  text: string;
  kind: "all" | Kind;
  categories: string[];
  filters: AdvancedFilters;
  sort: SortKey;
  desc: boolean;
  seed: number;

  /** Changes whenever the set of results is redefined; stale responses are dropped. */
  queryKey: number;
  /** Changes when the underlying data changed; loaded pages get refetched. */
  version: number;
  total: number | null;
  pages: Record<number, Page>;
  facets: Facets | null;

  selectedIndex: number;
  selected: SampleRow | null;

  setView: (view: View) => void;
  setText: (text: string) => void;
  setKind: (kind: "all" | Kind) => void;
  toggleCategory: (category: string, additive: boolean) => void;
  setFilters: (patch: Partial<AdvancedFilters>) => void;
  resetFilters: () => void;
  /** Clears filters, categories and the one-shot/loop switch in one query. */
  clearAll: () => void;
  setSort: (sort: SortKey, desc?: boolean) => void;
  shuffle: () => void;

  ensureRange: (start: number, end: number) => void;
  refresh: () => void;
  selectIndex: (index: number, opts?: { play?: boolean }) => Promise<void>;
  selectRow: (row: SampleRow, index: number, opts?: { play?: boolean }) => void;
  move: (delta: number) => void;
  rowAt: (index: number) => SampleRow | undefined;
  patchRow: (id: number, patch: Partial<SampleRow>) => void;
  toggleFavorite: (row: SampleRow) => void;
}

export function backendFilters(s: Pick<BrowseState, "view" | "text" | "kind" | "categories" | "filters">): Filters {
  const f: Filters = {
    text: s.text,
    kind: s.kind === "all" ? null : s.kind,
    categories: s.categories,
    ...s.filters,
  };
  switch (s.view.type) {
    case "favorites":
      f.favorites = true;
      break;
    case "recent-added":
      f.recent = "added";
      break;
    case "recent-played":
      f.recent = "played";
      break;
    case "collection":
      f.collectionId = s.view.id;
      break;
    case "folder":
      f.sourceId = s.view.sourceId;
      f.dir = s.view.dir;
      break;
  }
  return f;
}

function effectiveSort(s: Pick<BrowseState, "sort" | "view">): SortKey {
  if (s.sort === "relevance" && s.view.type === "recent-played") return "played";
  if (s.sort === "relevance" && s.view.type === "recent-added") return "added";
  return s.sort;
}

export function activeFilterCount(f: AdvancedFilters): number {
  let n = 0;
  if (f.bpmMin != null || f.bpmMax != null) n++;
  if (f.key) n++;
  if (f.durMin != null || f.durMax != null) n++;
  if (f.formats.length) n++;
  if (f.channels) n++;
  if (f.sampleRates.length) n++;
  n += f.tags.length + f.excludeTags.length;
  return n;
}

const inflight = new Set<string>();

/** Other views that show sample rows and want favorite/tag changes too. */
export const rowPatchListeners = new Set<(id: number, patch: Partial<SampleRow>) => void>();
let textTimer: number | undefined;
let facetsTimer: number | undefined;

export const useBrowse = create<BrowseState>((set, get) => {
  const fetchPage = async (page: number) => {
    const s = get();
    const key = `${s.queryKey}:${s.version}:${page}`;
    if (inflight.has(key)) return;
    inflight.add(key);
    const { queryKey, version } = s;
    try {
      const res = await api.query({
        filters: backendFilters(s),
        sort: effectiveSort(s),
        desc: s.desc,
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
        seed: s.seed,
      });
      if (get().queryKey !== queryKey) return;
      set((cur) => {
        const selected = cur.selected ? (res.rows.find((r) => r.id === cur.selected!.id) ?? cur.selected) : null;
        return { pages: { ...cur.pages, [page]: { version, rows: res.rows } }, total: res.total, selected };
      });
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      inflight.delete(key);
    }
  };

  const scheduleFacets = () => {
    window.clearTimeout(facetsTimer);
    facetsTimer = window.setTimeout(async () => {
      const s = get();
      const { queryKey } = s;
      try {
        const facets = await api.facets(backendFilters(s));
        if (get().queryKey === queryKey) set({ facets });
      } catch {
        /* facets are advisory */
      }
    }, 180);
  };

  const run = () => {
    set((s) => ({ queryKey: s.queryKey + 1, total: null, pages: {}, selectedIndex: -1 }));
    void fetchPage(0);
    scheduleFacets();
  };

  return {
    view: { type: "all" },
    text: "",
    kind: "all",
    categories: [],
    filters: EMPTY_FILTERS,
    sort: "relevance",
    desc: false,
    seed: 1,

    queryKey: 0,
    version: 0,
    total: null,
    pages: {},
    facets: null,

    selectedIndex: -1,
    selected: null,

    setView: (view) => {
      set({ view });
      run();
    },
    setText: (text) => {
      set({ text });
      window.clearTimeout(textTimer);
      textTimer = window.setTimeout(run, 140);
    },
    setKind: (kind) => {
      set({ kind });
      run();
    },
    toggleCategory: (category, additive) => {
      const cur = get().categories;
      let next: string[];
      if (additive) next = cur.includes(category) ? cur.filter((c) => c !== category) : [...cur, category];
      else next = cur.length === 1 && cur[0] === category ? [] : [category];
      set({ categories: next });
      run();
    },
    setFilters: (patch) => {
      set((s) => ({ filters: { ...s.filters, ...patch } }));
      run();
    },
    resetFilters: () => {
      set({ filters: EMPTY_FILTERS });
      run();
    },
    clearAll: () => {
      set({ filters: EMPTY_FILTERS, categories: [], kind: "all" });
      run();
    },
    setSort: (sort, desc) => {
      set({ sort, desc: desc ?? false });
      run();
    },
    shuffle: () => {
      set({ sort: "random", seed: Math.floor(Math.random() * 2 ** 30) });
      run();
    },

    ensureRange: (start, end) => {
      const s = get();
      const last = s.total == null ? start : Math.max(0, s.total - 1);
      for (let p = Math.floor(start / PAGE_SIZE); p <= Math.floor(Math.min(end, last) / PAGE_SIZE); p++) {
        const page = s.pages[p];
        if (!page || page.version !== s.version) void fetchPage(p);
      }
    },

    refresh: () => {
      set((s) => ({ version: s.version + 1 }));
      void fetchPage(0);
      scheduleFacets();
      const sel = get().selected;
      if (sel) {
        api.sample(sel.id).then((row) => {
          if (get().selected?.id === sel.id) set({ selected: row });
        });
      }
    },

    rowAt: (index) => get().pages[Math.floor(index / PAGE_SIZE)]?.rows[index % PAGE_SIZE],

    selectRow: (row, index, opts) => {
      set({ selected: row, selectedIndex: index });
      const play = opts?.play ?? usePrefs.getState().autoplay;
      if (play) usePlayer.getState().play(row);
    },

    selectIndex: async (index, opts) => {
      const s = get();
      if (s.total == null || index < 0 || index >= s.total) return;
      let row = s.rowAt(index);
      if (!row) {
        await fetchPage(Math.floor(index / PAGE_SIZE));
        row = get().rowAt(index);
      }
      if (row) get().selectRow(row, index, opts);
    },

    move: (delta) => {
      const s = get();
      if (!s.total) return;
      const from = s.selectedIndex < 0 ? (delta > 0 ? -1 : s.total) : s.selectedIndex;
      const to = Math.max(0, Math.min(s.total - 1, from + delta));
      if (to !== s.selectedIndex) void s.selectIndex(to);
    },

    patchRow: (id, patch) => {
      rowPatchListeners.forEach((l) => l(id, patch));
      set((s) => {
        const pages: Record<number, Page> = {};
        for (const [k, p] of Object.entries(s.pages)) {
          pages[Number(k)] = p.rows.some((r) => r.id === id)
            ? { ...p, rows: p.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) }
            : p;
        }
        return { pages, selected: s.selected?.id === id ? { ...s.selected, ...patch } : s.selected };
      });
    },

    toggleFavorite: (row) => {
      const favorite = !row.favorite;
      get().patchRow(row.id, { favorite });
      api
        .setFavorite([row.id], favorite)
        .then(() => {
          void useLibrary.getState().refreshStats();
          if (get().view.type === "favorites") get().refresh();
        })
        .catch((e) => {
          get().patchRow(row.id, { favorite: !favorite });
          toast(errorMessage(e));
        });
    },
  };
});

/** Kick off the first query. */
export function startBrowsing() {
  useBrowse.getState().setView({ type: "all" });
}
