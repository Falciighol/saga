import { create } from "zustand";
import { api, errorMessage } from "../lib/api";
import type {
  CaptureState,
  RecordProblem,
  RecordSettings,
  RecordSource,
  RecordSources,
  SampleRow,
  TakeFormat,
  TakeLanded,
  TakeNotice,
  TakeOptions,
  TakesRetention,
  TakeStatus,
} from "../lib/types";
import { rowPatchListeners, useBrowse } from "./browse";
import { useLibrary } from "./library";
import { usePlayer } from "./player";
import { usePrefs } from "./prefs";
import { toast } from "./toasts";
import { useUi } from "./ui";

/** "opening" while the device or app tap is being opened, before its first status arrives. */
export type RecordPhase = "idle" | "opening" | CaptureState;

interface RecordState {
  /** The Record panel is open beside the list (main window). */
  open: boolean;
  /** The mini player's record strip is open. */
  miniOpen: boolean;
  /** The mini player's list shows the takes instead of samples. */
  miniTakes: boolean;
  sources: RecordSources | null;
  phase: RecordPhase;
  /** The newest status while a source is open. */
  status: TakeStatus | null;
  /** What kept the source from opening, shown on the stage until the next try. */
  problem: RecordProblem | null;
  /** Unsaved takes, then the ones saved this session, newest first. */
  takes: SampleRow[];
  /** Samples from this source are unsaved takes. */
  takesSourceId: number | null;
  /** Space the unsaved takes take on disk. */
  bytes: number;
  /** Takes saved this session: still listed, marked "In Recordings". */
  saved: number[];
  /** Takes on their way to the Trash, hidden while their Undo is offered. */
  deleting: number[];
  /** The take that just landed, for its entrance. */
  landed: number | null;
  /** The take picked in the tray, previewed below. */
  selectedId: number | null;
  /** The take being renamed in the tray. */
  renaming: number | null;
  /** Settings › Recording, which the backend keeps. */
  settings: RecordSettings | null;

  setOpen: (open: boolean) => void;
  setMiniOpen: (open: boolean) => void;
  setMiniTakes: (on: boolean) => void;
  loadSources: () => Promise<RecordSources | null>;
  loadTakes: () => Promise<void>;
  setSource: (source: RecordSource) => void;
  /** The take options in the preferences changed: the open source follows them. */
  optionsChanged: () => void;
  arm: () => Promise<void>;
  recordNow: () => void;
  stop: () => Promise<void>;
  select: (row: SampleRow, opts?: { play?: boolean }) => void;
  /** `quiet`: no confirmation, for a take saved because it's being dragged out. */
  save: (id: number, opts?: { quiet?: boolean }) => Promise<SampleRow | null>;
  /** Saves every unsaved take that's still listed, one after the other, with one confirmation. */
  saveAll: () => Promise<void>;
  remove: (ids: number[]) => void;
  clearUnsaved: () => Promise<void>;
  rename: (id: number, name: string) => Promise<void>;
  setRenaming: (id: number | null) => void;
  loadSettings: () => Promise<void>;
  setSettings: (patch: { format?: TakeFormat; retention?: TakesRetention }) => Promise<void>;
  /** Keys as Tauri spells them, or null to clear. Resolves to false when they couldn't be used. */
  setShortcut: (shortcut: string | null) => Promise<boolean>;

  onStatus: (s: TakeStatus) => void;
  onLanded: (e: TakeLanded) => void;
  onNotice: (n: TakeNotice) => void;
  /** The library changed: takes being analyzed get their tempo and key. */
  refreshRows: () => void;
}

/** How long a deleted take waits, hidden, for Undo before it goes to the Trash. Matches a toast with an action. */
const UNDO_FOR = 10_000;

/** The live waveform's bars, newest last, kept outside React so the stage can draw them every frame. */
export const LIVE_BARS = 400;
export const live = {
  bars: new Float32Array(LIVE_BARS),
  /** Bars held, up to LIVE_BARS. */
  count: 0,
  /** Bars ever pushed since arming. */
  total: 0,
  /** `total` where the take being recorded begins (its pre-roll included), or -1. */
  takeStart: -1,
};

/** The audio held while armed, which a take begins with: half a second of 25 ms bars. */
const PRE_ROLL_BARS = 20;

function pushBars(bars: number[]) {
  for (const b of bars) {
    live.bars.copyWithin(0, 1);
    live.bars[LIVE_BARS - 1] = b;
    live.count = Math.min(LIVE_BARS, live.count + 1);
    live.total++;
  }
}

function clearBars() {
  live.bars.fill(0);
  live.count = 0;
  live.total = 0;
  live.takeStart = -1;
}

export function takeOptions(): TakeOptions {
  const p = usePrefs.getState();
  return {
    startOnSound: p.recordStartOnSound,
    stopAfter: p.recordStopAfter,
    keepGoing: p.recordKeepGoing,
    thresholdDb: p.recordThresholdDb,
    utcOffset: -new Date().getTimezoneOffset(),
  };
}

/** True for a take that hasn't been saved yet. */
export function isTake(row: Pick<SampleRow, "sourceId"> | null | undefined): boolean {
  const id = useRecord.getState().takesSourceId;
  return row != null && id != null && row.sourceId === id;
}

/** True for a take that hasn't been saved yet, as a hook. */
export function useIsTake(row: Pick<SampleRow, "sourceId"> | null | undefined): boolean {
  const id = useRecord((s) => s.takesSourceId);
  return row != null && id != null && row.sourceId === id;
}

/** The source's own words: "Scarlett 2i2 USB · In 3+4", "Chrome", "Everything you hear". */
export function sourceLabel(source: RecordSource | null): string {
  if (!source) return "Choose what to record";
  if (source.kind === "app") return source.name;
  if (source.kind === "system") return "Everything you hear";
  return source.device || "Default input";
}

function sameSource(a: RecordSource | null, b: RecordSource | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

let optionsTimer: number | undefined;

export const useRecord = create<RecordState>((set, get) => ({
  open: false,
  miniOpen: false,
  miniTakes: false,
  sources: null,
  phase: "idle",
  status: null,
  problem: null,
  takes: [],
  takesSourceId: null,
  bytes: 0,
  saved: [],
  deleting: [],
  landed: null,
  selectedId: null,
  renaming: null,
  settings: null,

  setOpen: (open) => {
    set({ open });
    if (open) {
      void get().loadSources();
      void get().loadTakes();
    }
  },
  setMiniOpen: (miniOpen) => {
    set({ miniOpen, ...(miniOpen ? {} : { miniTakes: false }) });
    if (miniOpen) {
      void get().loadSources();
      void get().loadTakes();
    }
  },
  setMiniTakes: (miniTakes) => set({ miniTakes }),

  loadSources: async () => {
    try {
      const sources = await api.recordSources();
      set({ sources });
      return sources;
    } catch (e) {
      toast(`Couldn't list what can be recorded: ${errorMessage(e)}`);
      return null;
    }
  },

  loadTakes: async () => {
    try {
      const list = await api.listTakes();
      set((s) => {
        // Saved this session stay listed after the unsaved ones that are still around.
        const unsaved = list.rows.filter((r) => !s.deleting.includes(r.id));
        const keep = s.takes.filter((t) => s.saved.includes(t.id) && !unsaved.some((u) => u.id === t.id));
        return { takes: [...unsaved, ...keep].sort((a, b) => b.added - a.added || b.id - a.id), takesSourceId: list.sourceId, bytes: list.bytes };
      });
    } catch (e) {
      toast(`Couldn't load your takes: ${errorMessage(e)}`);
    }
  },

  setSource: (source) => {
    const before = usePrefs.getState().recordSource;
    usePrefs.getState().set({ recordSource: source });
    set({ problem: null });
    // Switching sources while armed opens the new one; a take being recorded is kept.
    if (!sameSource(before, source) && get().phase !== "idle") void get().arm();
  },

  optionsChanged: () => {
    window.clearTimeout(optionsTimer);
    if (get().phase === "idle") return;
    // Dragging the threshold sends many changes; the engine only needs the last one.
    optionsTimer = window.setTimeout(() => {
      api.setTakeOptions(takeOptions()).catch((e) => toast(errorMessage(e)));
    }, 25);
  },

  arm: async () => {
    const source = usePrefs.getState().recordSource;
    if (!source) {
      if (!useUi.getState().mini) set({ open: true });
      return;
    }
    set({ phase: "opening", problem: null });
    clearBars();
    try {
      const problem = await api.armTake(source, takeOptions());
      if (problem) set({ phase: "idle", problem, status: null });
    } catch (e) {
      set({ phase: "idle", problem: { message: errorMessage(e), settings: null }, status: null });
    }
  },

  recordNow: () => {
    api.recordTakeNow().catch((e) => toast(errorMessage(e)));
  },

  stop: async () => {
    try {
      await api.stopTake();
    } catch (e) {
      toast(errorMessage(e));
    }
  },

  select: (row, opts) => {
    set({ selectedId: row.id });
    useBrowse.getState().selectRow(row, -1, opts);
  },

  save: async (id, opts) => {
    try {
      const row = await api.saveTake(id);
      if (!opts?.quiet) toast(`Saved “${row.name}” to Recordings`, "info");
      set((s) => ({ takes: s.takes.map((t) => (t.id === id ? row : t)), saved: s.saved.includes(id) ? s.saved : [...s.saved, id] }));
      useBrowse.getState().replaceRows([row]);
      // Recordings may be a new library folder, and the list may now show the take.
      void useLibrary.getState().refresh();
      useBrowse.getState().refresh();
      void api.listTakes().then((l) => set({ bytes: l.bytes })).catch(() => {});
      return row;
    } catch (e) {
      toast(errorMessage(e));
      return null;
    }
  },

  saveAll: async () => {
    const { takes, takesSourceId, deleting } = get();
    const ids = takes.filter((t) => t.sourceId === takesSourceId && !deleting.includes(t.id)).map((t) => t.id);
    let saved = 0;
    // One at a time: each save moves a file into Recordings and holds the rescans while it does.
    for (const id of ids) if (await get().save(id, { quiet: true })) saved++;
    if (saved) toast(`Saved ${saved === 1 ? "1 take" : `${saved} takes`} to Recordings`, "info");
  },

  remove: (ids) => {
    const rows = get().takes.filter((t) => ids.includes(t.id));
    if (!rows.length) return;
    const player = usePlayer.getState();
    if (player.id != null && ids.includes(player.id)) player.stop();
    set((s) => ({ deleting: [...s.deleting, ...ids], selectedId: ids.includes(s.selectedId ?? -1) ? null : s.selectedId }));
    let undone = false;
    const timer = window.setTimeout(() => {
      if (undone) return;
      api
        .trashTakes(ids)
        .then(() => {
          set((s) => ({ takes: s.takes.filter((t) => !ids.includes(t.id)), deleting: s.deleting.filter((d) => !ids.includes(d)) }));
          void get().loadTakes();
          if (rows.some((r) => get().saved.includes(r.id))) {
            void useLibrary.getState().refresh();
            useBrowse.getState().refresh();
          }
        })
        .catch((e) => {
          set((s) => ({ deleting: s.deleting.filter((d) => !ids.includes(d)) }));
          toast(errorMessage(e));
        });
    }, UNDO_FOR);
    const what = rows.length === 1 ? `“${rows[0].name}”` : `${rows.length} takes`;
    toast(`Moved ${what} to the Trash`, "info", {
      label: "Undo",
      run: () => {
        undone = true;
        window.clearTimeout(timer);
        set((s) => ({ deleting: s.deleting.filter((d) => !ids.includes(d)) }));
      },
    });
  },

  clearUnsaved: async () => {
    try {
      const n = await api.clearUnsavedTakes();
      if (n) toast(`Moved ${n === 1 ? "1 take" : `${n} takes`} to the Trash`, "info");
      await get().loadTakes();
    } catch (e) {
      toast(errorMessage(e));
    }
  },

  rename: async (id, name) => {
    set({ renaming: null });
    const take = get().takes.find((t) => t.id === id);
    const clean = name.trim();
    if (!take || !clean || clean === take.name) return;
    try {
      const [out] = await api.renameSamples([{ id, name: clean }]);
      if (out?.error) {
        toast(`Couldn't rename: ${out.error}`);
        return;
      }
      const [row] = await api.samples([id]);
      if (row) {
        set((s) => ({ takes: s.takes.map((t) => (t.id === id ? row : t)) }));
        useBrowse.getState().replaceRows([row]);
      }
    } catch (e) {
      toast(errorMessage(e));
    }
  },
  setRenaming: (renaming) => set({ renaming }),

  loadSettings: async () => {
    try {
      set({ settings: await api.recordSettings() });
    } catch (e) {
      toast(errorMessage(e));
    }
  },
  setSettings: async (patch) => {
    try {
      set({ settings: await api.setRecordSettings(patch) });
    } catch (e) {
      toast(errorMessage(e));
    }
  },
  setShortcut: async (shortcut) => {
    try {
      set({ settings: await api.setRecordShortcut(shortcut) });
      return true;
    } catch (e) {
      toast(errorMessage(e));
      return false;
    }
  },

  onStatus: (s) => {
    const before = get().phase;
    pushBars(s.bars);
    if (s.state === "recording" && before !== "recording") live.takeStart = Math.max(0, live.total - s.bars.length - PRE_ROLL_BARS);
    if (s.state !== "recording") live.takeStart = -1;
    set({ phase: s.state, status: s });
  },

  onLanded: ({ id }) => {
    void api
      .sample(id)
      .then((row) => {
        if (!row) return;
        set((s) => ({ takes: [row, ...s.takes.filter((t) => t.id !== id)], landed: id }));
        void api.listTakes().then((l) => set({ bytes: l.bytes, takesSourceId: l.sourceId })).catch(() => {});
      })
      .catch((e) => toast(errorMessage(e)));
  },

  onNotice: (n) => {
    const settings = n.settings;
    toast(n.message, n.tone, settings ? { label: "Open settings", run: () => void openPrivacySettings(settings) } : undefined);
  },

  refreshRows: () => {
    const ids = get().takes.map((t) => t.id);
    if (!ids.length) return;
    api
      .samples(ids)
      .then((rows) => {
        const fresh = new Map(rows.map((r) => [r.id, r]));
        set((s) => ({ takes: s.takes.flatMap((t) => (fresh.has(t.id) ? [fresh.get(t.id)!] : [])) }));
      })
      .catch(() => {
        // The next library change tries again; the tray keeps what it shows meanwhile.
      });
  },
}));

// Tempo or key set by hand in the preview, or a favorite, shows in the tray too.
rowPatchListeners.add((id, patch) => {
  if (useRecord.getState().takes.some((t) => t.id === id)) {
    useRecord.setState((s) => ({ takes: s.takes.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  }
});

export async function openPrivacySettings(what: "microphone" | "systemAudio") {
  try {
    await api.openPrivacySettings(what);
  } catch (e) {
    toast(errorMessage(e));
  }
}

/**
 * `R` and the record shortcut, one step at a time: open the panel, then arm, record now and stop.
 * `fromAnywhere` (the global shortcut) opens the panel and arms in one press, since the window may be
 * behind the DAW.
 */
export function stepRecording(fromAnywhere = false) {
  const r = useRecord.getState();
  const mini = useUi.getState().mini;
  const shown = mini ? r.miniOpen : r.open;
  if (!shown) {
    if (mini) r.setMiniOpen(true);
    else r.setOpen(true);
    if (!fromAnywhere) return;
  }
  switch (r.phase) {
    case "idle":
      void r.arm();
      break;
    case "armed":
      r.recordNow();
      break;
    case "recording":
      void r.stop();
      break;
    case "opening":
      break;
  }
}
