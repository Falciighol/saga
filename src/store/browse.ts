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
  /** Created from this time (seconds, included) to that one (not included). */
  createdFrom: number | null;
  createdTo: number | null;
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
  createdFrom: null,
  createdTo: null,
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
  /** Samples picked together (⌘/Ctrl-click, Shift-click, select all), for acting on many at once.
   *  Empty, or two or more ids; the selected row is the one previewed. */
  picked: Set<number>;
  /** Where Shift-click ranges start. */
  anchor: number;

  setView: (view: View) => void;
  setText: (text: string) => void;
  setKind: (kind: "all" | Kind) => void;
  toggleCategory: (category: string, additive: boolean) => void;
  setFilters: (patch: Partial<AdvancedFilters>) => void;
  resetFilters: () => void;
  /** Clears filters, categories and the one-shot/loop switch in one query. */
  clearAll: () => void;
  /** Puts back filters, categories and the one-shot/loop switch saved before a clear, for Undo. */
  restoreFilters: (saved: Pick<BrowseState, "filters" | "kind" | "categories">) => void;
  setSort: (sort: SortKey, desc?: boolean) => void;
  shuffle: () => void;

  ensureRange: (start: number, end: number) => void;
  refresh: () => void;
  selectIndex: (index: number, opts?: { play?: boolean }) => Promise<void>;
  selectRow: (row: SampleRow, index: number, opts?: { play?: boolean }) => void;
  move: (delta: number) => void;
  /** The row at an index, fetching its page when it isn't loaded yet. */
  loadRow: (index: number) => Promise<SampleRow | undefined>;
  rowAt: (index: number) => SampleRow | undefined;
  patchRow: (id: number, patch: Partial<SampleRow>) => void;
  /** Swaps in fresh copies of these rows wherever they're shown. */
  replaceRows: (rows: SampleRow[]) => void;
  toggleFavorite: (row: SampleRow) => void;

  /** ⌘/Ctrl-click: adds a row to the picked samples, or takes it out. */
  togglePick: (row: SampleRow, index: number) => void;
  /** Shift-click: picks every row from the anchor to this one; with `add` (⌘/Ctrl too), on top of what's picked. */
  pickRange: (index: number, add?: boolean) => Promise<void>;
  /** Picks everything the search and filters match. */
  pickAll: () => Promise<void>;
  clearPicked: () => void;
}

/** Most rows a Shift-click range reaches; select all has no limit. */
const MAX_RANGE = 5000;

/** The samples an action applies to: the picked ones, or else the selected one. */
export function targetIds(s: Pick<BrowseState, "picked" | "selected"> = useBrowse.getState()): number[] {
  if (s.picked.size > 1) return [...s.picked];
  return s.selected ? [s.selected.id] : [];
}

/** Rows for the picked samples (or the selected one), from the pages already loaded where possible. */
export async function targetRows(): Promise<SampleRow[]> {
  const s = useBrowse.getState();
  const ids = targetIds(s);
  const known = new Map<number, SampleRow>();
  for (const p of Object.values(s.pages)) for (const r of p.rows) if (s.picked.has(r.id) || r.id === s.selected?.id) known.set(r.id, r);
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) for (const r of await api.samples(missing)) known.set(r.id, r);
  return ids.map((id) => known.get(id)).filter((r): r is SampleRow => r != null);
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

/** Which way a sort starts: dates newest first, everything else A to Z, low to high. */
export function firstDesc(sort: SortKey): boolean {
  return sort === "added" || sort === "created";
}

/** The sort the list shows: the recent views put the newest first until another sort is picked. */
function listOrder(s: Pick<BrowseState, "sort" | "view" | "desc" | "seed">): { sort: SortKey; desc: boolean; seed: number } {
  if (s.sort === "relevance" && s.view.type === "recent-played") return { sort: "played", desc: false, seed: s.seed };
  if (s.sort === "relevance" && s.view.type === "recent-added") return { sort: "added", desc: true, seed: s.seed };
  return { sort: s.sort, desc: s.desc, seed: s.seed };
}

/** These rows in the order the list shows them (rows it doesn't show go last, as they were), so
 *  actions on several samples, like numbering them, follow what's on screen. */
export async function inListOrder(rows: SampleRow[]): Promise<SampleRow[]> {
  if (rows.length < 2) return rows;
  const s = useBrowse.getState();
  const ids = await api.queryIds(backendFilters(s), listOrder(s));
  const at = new Map(ids.map((id, i) => [id, i]));
  return rows
    .map((row, i) => ({ row, i, at: at.get(row.id) ?? ids.length + i }))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.row);
}

export function activeFilterCount(f: AdvancedFilters): number {
  let n = 0;
  if (f.bpmMin != null || f.bpmMax != null) n++;
  if (f.key) n++;
  if (f.durMin != null || f.durMax != null) n++;
  if (f.formats.length) n++;
  if (f.channels) n++;
  if (f.sampleRates.length) n++;
  if (f.createdFrom != null || f.createdTo != null) n++;
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
      const res = await api.query({ filters: backendFilters(s), ...listOrder(s), offset: page * PAGE_SIZE, limit: PAGE_SIZE });
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
    set((s) => ({ queryKey: s.queryKey + 1, total: null, pages: {}, selectedIndex: -1, picked: new Set<number>(), anchor: -1 }));
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
    picked: new Set<number>(),
    anchor: -1,

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
    restoreFilters: ({ filters, kind, categories }) => {
      set({ filters, kind, categories });
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
      set({ selected: row, selectedIndex: index, anchor: index, picked: new Set<number>() });
      const play = opts?.play ?? usePrefs.getState().autoplay;
      if (play) usePlayer.getState().play(row);
    },

    loadRow: async (index) => {
      const s = get();
      if (s.total == null || index < 0 || index >= s.total) return undefined;
      const row = s.rowAt(index);
      if (row) return row;
      await fetchPage(Math.floor(index / PAGE_SIZE));
      return get().rowAt(index);
    },

    selectIndex: async (index, opts) => {
      const row = await get().loadRow(index);
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

    togglePick: (row, index) => {
      const s = get();
      const picked = new Set(s.picked.size ? s.picked : s.selected ? [s.selected.id] : []);
      if (picked.has(row.id)) {
        picked.delete(row.id);
        // The row previewed moves to one still picked.
        if (s.selected?.id === row.id) {
          const rest = [...picked].pop();
          const at = rest == null ? -1 : findLoaded(s, rest);
          set({ selected: at >= 0 ? s.rowAt(at)! : s.selected, selectedIndex: at >= 0 ? at : s.selectedIndex });
        }
      } else {
        picked.add(row.id);
        set({ selected: row, selectedIndex: index });
      }
      set({ picked: picked.size > 1 ? picked : new Set<number>(), anchor: index });
    },

    pickRange: async (index, add) => {
      const s = get();
      if (s.anchor < 0 || s.total == null) {
        const row = s.rowAt(index);
        if (row) s.selectRow(row, index, { play: false });
        return;
      }
      const from = Math.max(0, Math.min(s.anchor, index, s.total - 1));
      const to = Math.min(s.total - 1, Math.max(s.anchor, index), from + MAX_RANGE - 1);
      const { queryKey } = s;
      for (let p = Math.floor(from / PAGE_SIZE); p <= Math.floor(to / PAGE_SIZE); p++) {
        const page = get().pages[p];
        if (!page || page.version !== get().version) await fetchPage(p);
      }
      if (get().queryKey !== queryKey) return;
      const cur = get();
      const picked = new Set<number>(add ? (cur.picked.size ? cur.picked : cur.selected ? [cur.selected.id] : []) : []);
      for (let i = from; i <= to; i++) {
        const r = get().rowAt(i);
        if (r) picked.add(r.id);
      }
      const row = get().rowAt(index);
      set({ picked: picked.size > 1 ? picked : new Set<number>(), ...(row ? { selected: row, selectedIndex: index } : {}) });
    },

    pickAll: async () => {
      const s = get();
      const { queryKey } = s;
      try {
        const ids = await api.queryIds(backendFilters(s), listOrder(s));
        if (get().queryKey !== queryKey) return;
        set({ picked: ids.length > 1 ? new Set(ids) : new Set<number>() });
        if (!get().selected && ids.length) void get().selectIndex(0, { play: false });
      } catch (e) {
        toast(errorMessage(e));
      }
    },

    clearPicked: () => set({ picked: new Set<number>() }),

    replaceRows: (rows) => {
      const fresh = new Map(rows.map((r) => [r.id, r]));
      rows.forEach((r) => rowPatchListeners.forEach((l) => l(r.id, r)));
      set((s) => {
        const pages: Record<number, Page> = {};
        for (const [k, p] of Object.entries(s.pages)) {
          pages[Number(k)] = p.rows.some((r) => fresh.has(r.id)) ? { ...p, rows: p.rows.map((r) => fresh.get(r.id) ?? r) } : p;
        }
        return { pages, selected: s.selected ? (fresh.get(s.selected.id) ?? s.selected) : null };
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

/** Where a sample sits among the loaded rows, or -1. */
function findLoaded(s: BrowseState, id: number): number {
  for (const [k, p] of Object.entries(s.pages)) {
    const i = p.rows.findIndex((r) => r.id === id);
    if (i >= 0) return Number(k) * PAGE_SIZE + i;
  }
  return -1;
}

/** Kick off the first query. */
export function startBrowsing() {
  useBrowse.getState().setView({ type: "all" });
}
