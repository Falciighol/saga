import { create } from "zustand";
import { api, errorMessage } from "../lib/api";
import { computeProcessing, type ProcessParams } from "../lib/processing";
import type { PlaybackEvent, SampleRow } from "../lib/types";
import { usePrefs, type PrefValues } from "./prefs";
import { editFor, useEdits, useProject } from "./project";
import { toast } from "./toasts";

type Status = "idle" | "loading" | "playing" | "paused";

interface PlayerState {
  id: number | null;
  row: SampleRow | null;
  status: Status;
  looping: boolean;
  /** Seconds along the playback timeline at `anchorAt` (performance.now()); the UI extrapolates. */
  anchor: number;
  anchorAt: number;
  /** Timeline length in seconds of the original. */
  length: number;
  /** Seconds of the original per second heard. */
  rate: number;
  reverse: boolean;
  regionStart: number;
  regionEnd: number;

  play: (row: SampleRow, start?: number | null) => void;
  toggle: (row: SampleRow | null) => void;
  /** Jump to a time in the original file (starting playback if needed). */
  seek: (row: SampleRow, seconds: number) => void;
  stop: () => void;
  setLooping: (looping: boolean) => void;
  handleEvent: (e: PlaybackEvent) => void;
}

/** Whether this sample repeats when played. Nothing does while Play next is on, so the next one can start. */
export function shouldLoop(row: Pick<SampleRow, "kind">): boolean {
  return loopsIn(usePrefs.getState(), row);
}

/** `shouldLoop` for components, re-rendering when the loop or Play next settings change. */
export function useLoopOn(row: Pick<SampleRow, "kind"> | null): boolean {
  return usePrefs((p) => row != null && loopsIn(p, row));
}

function loopsIn(p: Pick<PrefValues, "playNext" | "loopLoops" | "loopShots">, row: Pick<SampleRow, "kind">): boolean {
  if (p.playNext) return false;
  return row.kind === "loop" ? p.loopLoops : p.loopShots;
}

export function paramsFor(row: SampleRow): ProcessParams {
  return computeProcessing(row, useProject.getState(), editFor(row.id)).params;
}

type Timeline = Pick<PlayerState, "status" | "anchor" | "anchorAt" | "length" | "rate" | "looping" | "reverse" | "regionStart" | "regionEnd">;

/** Seconds along the playback timeline, extrapolated from the last engine event. */
export function timelinePosition(s: Timeline): number {
  if (s.status !== "playing") return s.anchor;
  const t = s.anchor + ((performance.now() - s.anchorAt) / 1000) * s.rate;
  if (s.length <= 0) return t;
  return s.looping ? t % s.length : Math.min(t, s.length);
}

/** Current position in seconds of the original file. */
export function playerPosition(s: Timeline): number {
  const t = timelinePosition(s);
  return s.reverse ? s.regionEnd - t : s.regionStart + t;
}

/** Where a sample will play before the engine confirms, so the playhead starts in the right place. */
function expectedTimeline(row: SampleRow, params: ProcessParams, start: number | null) {
  const duration = row.duration ?? 0;
  const regionStart = params.regionStart ?? 0;
  const regionEnd = params.regionEnd ?? duration;
  const length = Math.max(0, regionEnd - regionStart);
  let anchor = 0;
  if (start != null) {
    const t = Math.min(regionEnd, Math.max(regionStart, start));
    anchor = params.reverse ? regionEnd - t : t - regionStart;
  }
  const processedRate = params.mode === "repitch" || Math.abs(params.rate - 1) > 1e-4 || Math.abs(params.semitones) > 1e-3;
  return { anchor, length, rate: processedRate ? params.rate : 1, reverse: params.reverse, regionStart, regionEnd };
}

export const usePlayer = create<PlayerState>((set, get) => ({
  id: null,
  row: null,
  status: "idle",
  looping: false,
  anchor: 0,
  anchorAt: 0,
  length: 0,
  rate: 1,
  reverse: false,
  regionStart: 0,
  regionEnd: 0,

  play: (row, start = null) => {
    if (!row.online) {
      toast("This sample's drive isn't connected");
      return;
    }
    const looping = shouldLoop(row);
    const params = paramsFor(row);
    set({ id: row.id, row, status: "loading", looping, anchorAt: performance.now(), ...expectedTimeline(row, params, start) });
    api.play(row.id, start, looping, params).catch((e) => {
      set({ status: "idle" });
      toast(errorMessage(e));
    });
  },

  toggle: (row) => {
    const s = get();
    if (!row) return;
    if (s.id !== row.id || s.status === "idle") {
      s.play(row);
      return;
    }
    if (s.status === "playing" || s.status === "loading") {
      set({ status: "paused", anchor: timelinePosition(s), anchorAt: performance.now() });
      void api.pause();
    } else {
      set({ status: "playing", anchorAt: performance.now() });
      void api.resume();
    }
  },

  seek: (row, seconds) => {
    const s = get();
    if (s.id !== row.id || s.status === "idle") {
      s.play(row, seconds);
      return;
    }
    const t = Math.min(s.regionEnd, Math.max(s.regionStart, seconds));
    set({ anchor: s.reverse ? s.regionEnd - t : t - s.regionStart, anchorAt: performance.now() });
    void api.seek(seconds);
  },

  stop: () => {
    set({ status: "idle", anchor: 0 });
    void api.stop();
  },

  setLooping: (looping) => {
    set({ looping });
    void api.setLoop(looping);
  },

  handleEvent: (e) => {
    const s = get();
    const timeline = {
      anchor: e.timeline,
      anchorAt: performance.now(),
      length: e.length,
      rate: e.rate,
      reverse: e.reverse,
      regionStart: e.regionStart,
      regionEnd: e.regionEnd,
      looping: e.looping,
    };
    switch (e.state) {
      case "playing":
        if (e.id != null && e.id === s.id) set({ status: "playing", ...timeline });
        break;
      case "paused":
        if (e.id === s.id) set({ status: "paused", ...timeline });
        break;
      case "stopped":
        if (s.status !== "loading") set({ status: "idle", anchor: 0 });
        break;
      case "ended":
        if (e.id === s.id) set({ status: "idle", anchor: 0 });
        break;
      case "error":
        if (e.id == null || e.id === s.id) set({ status: "idle" });
        if (e.message) toast(e.message);
        break;
    }
  },
}));

let paramsTimer: number | undefined;

/** Pushes tempo/key/edit changes to whatever is playing, so you hear them immediately. */
export function startParamsSync() {
  const push = () => {
    window.clearTimeout(paramsTimer);
    paramsTimer = window.setTimeout(() => {
      const s = usePlayer.getState();
      if (!s.row || s.status === "idle") return;
      void api.setParams(paramsFor(s.row));
    }, 25);
  };
  const unsubProject = useProject.subscribe((p, prev) => {
    if (p.click !== prev.click) void api.setClick(p.click);
    push();
  });
  const unsubEdits = useEdits.subscribe((e, prev) => {
    const id = usePlayer.getState().id;
    if (id != null && e.edits[id] !== prev.edits[id]) push();
  });
  void api.setClick(useProject.getState().click);
  return () => {
    unsubProject();
    unsubEdits();
    window.clearTimeout(paramsTimer);
  };
}
