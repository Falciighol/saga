import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { MonoChoice, SansChoice } from "../lib/fonts";
import type { Accent, ThemePref } from "../lib/theme";
import type { ColumnPref } from "../lib/listColumns";
import type { RenamePattern } from "../lib/rename";
import type { SavedPreset } from "../lib/renamePresets";
import type { Aspect, RecordSource } from "../lib/types";

export type MapColor = "category" | "brightness" | "loudness";
export type MapArrange = Exclude<Aspect, "overall">;
/** What dragging across the sound map does; Shift-drag does the other. */
export type MapDrag = "audition" | "lasso";

export interface PrefValues {
  theme: ThemePref;
  accent: Accent;
  /** Font for names, labels and menus. */
  sansFont: SansChoice;
  /** The installed family used when sansFont is "installed"; kept when switching back to a bundled font. */
  sansInstalled: string | null;
  /** Font for tempos, keys, times and paths. */
  monoFont: MonoChoice;
  monoInstalled: string | null;
  /** Interface zoom, 1 = 100%. */
  uiScale: number;
  /** Width of the library sidebar in interface pixels; drag its edge to change it. */
  sidebarWidth: number;
  volume: number;
  /** Play a sample as soon as it's selected. */
  autoplay: boolean;
  /** When a sample ends, play the next one in the list. Everything plays once while this is on. */
  playNext: boolean;
  /** Loop loops while previewing. */
  loopLoops: boolean;
  /** Loop one-shots while previewing. */
  loopShots: boolean;
  mapColor: MapColor;
  mapArrange: MapArrange;
  mapDrag: MapDrag;
  /** What Find similar compares. */
  similarAspect: Aspect;
  /** Keep the mini player above other windows. */
  miniOnTop: boolean;
  /** The key popup's MIDI clip also runs through the related keys. */
  keyMidiRelated: boolean;
  /** Look for new versions on launch and download them in the background. */
  autoUpdate: boolean;
  /** Show tempos with two decimals always ("124.00"), not only when they have them. */
  bpmFixed: boolean;
  /** The last rename pattern, so batch renames can be repeated. */
  renamePattern: RenamePattern | null;
  /** Rename patterns saved under names of the user's own, listed after the built-in presets. */
  renamePresets: SavedPreset[];
  /** The sample list's columns in the user's order, and which show; null for the usual ones. */
  listColumns: ColumnPref[] | null;
  /** The newest version whose What's new the user has seen or put off; null before Saga started recording it. */
  lastSeenVersion: string | null;
  /** What the Record panel records; null until the user picks something. */
  recordSource: RecordSource | null;
  /** An armed take waits for the first sound instead of starting at once. */
  recordStartOnSound: boolean;
  /** Seconds of silence that end a take; null never ends one. */
  recordStopAfter: number | null;
  /** Arm again after each take, so every sound becomes its own take. */
  recordKeepGoing: boolean;
  /** The level that starts a take, in dBFS; null follows the source's noise floor. */
  recordThresholdDb: number | null;
}

interface Prefs extends PrefValues {
  set: (patch: Partial<PrefValues>) => void;
}

export const DEFAULT_PREFS: PrefValues = {
  theme: "system",
  accent: "violet",
  sansFont: "instrument",
  sansInstalled: null,
  monoFont: "geist-mono",
  monoInstalled: null,
  uiScale: 1,
  sidebarWidth: 232,
  volume: 0.8,
  autoplay: true,
  playNext: false,
  loopLoops: true,
  loopShots: false,
  mapColor: "category",
  mapArrange: "timbre",
  mapDrag: "audition",
  similarAspect: "overall",
  miniOnTop: true,
  keyMidiRelated: false,
  autoUpdate: true,
  bpmFixed: false,
  renamePattern: null,
  renamePresets: [],
  listColumns: null,
  lastSeenVersion: null,
  recordSource: null,
  recordStartOnSound: true,
  recordStopAfter: 2,
  recordKeepGoing: false,
  recordThresholdDb: null,
};

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFS,
      set: (patch) => set(patch),
    }),
    {
      name: "saga-prefs",
      partialize: ({ set: _set, ...values }) => values,
    },
  ),
);
