import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { MonoChoice, SansChoice } from "../lib/fonts";
import type { Accent, ThemePref } from "../lib/theme";
import type { Aspect } from "../lib/types";

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
  volume: number;
  /** Play a sample as soon as it's selected. */
  autoplay: boolean;
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
}

interface Prefs extends PrefValues {
  set: (patch: Partial<PrefValues>) => void;
}

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      theme: "system",
      accent: "violet",
      sansFont: "instrument",
      sansInstalled: null,
      monoFont: "geist-mono",
      monoInstalled: null,
      uiScale: 1,
      volume: 0.8,
      autoplay: true,
      loopLoops: true,
      loopShots: false,
      mapColor: "category",
      mapArrange: "timbre",
      mapDrag: "audition",
      similarAspect: "overall",
      miniOnTop: true,
      keyMidiRelated: false,
      autoUpdate: true,
      set: (patch) => set(patch),
    }),
    {
      name: "saga-prefs",
      partialize: ({ set: _set, ...values }) => values,
    },
  ),
);
