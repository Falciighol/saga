// Turns the project tempo/key and a sample's edits into what the audio engine should do.
// Preview, editor and renders all go through `computeProcessing`, so they always agree.

import { fmtBpm, hasTempo } from "./format";
import type { SampleRow } from "./types";

export type StretchMode = "stretch" | "repitch";
export type Multiplier = "auto" | 0.5 | 1 | 2;

export interface ProjectKey {
  pc: number;
  /** Closest major (0) or minor (1); what Match key and Camelot codes use. */
  mode: 0 | 1;
  /** A scale from the Lab (see src/lib/theory.ts); none means plain major or minor. */
  scale?: string | null;
}

export interface Project {
  bpm: number;
  key: ProjectKey | null;
  /** Loops follow the project tempo. */
  sync: boolean;
  /** Pitched samples are transposed to the project key. */
  matchKey: boolean;
  /** `[ ]` and the pitch buttons step through the project key's scale instead of by semitones. */
  scaleLock: boolean;
  click: boolean;
  mode: StretchMode;
  formants: boolean;
}

export interface Edit {
  semitones: number;
  cents: number;
  reverse: boolean;
  regionStart: number | null;
  regionEnd: number | null;
  fadeIn: number;
  fadeOut: number;
  gainDb: number;
  normalize: boolean;
  crossfade: number;
  multiplier: Multiplier;
  /** Overrides the project's stretch mode for this sample. */
  mode: StretchMode | null;
  formants: boolean | null;
}

export const DEFAULT_EDIT: Edit = {
  semitones: 0,
  cents: 0,
  reverse: false,
  regionStart: null,
  regionEnd: null,
  fadeIn: 0,
  fadeOut: 0,
  gainDb: 0,
  normalize: false,
  crossfade: 0.01,
  multiplier: "auto",
  mode: null,
  formants: null,
};

/** Mirrors `ProcessParams` in src-tauri/src/dsp.rs. */
export interface ProcessParams {
  rate: number;
  semitones: number;
  mode: StretchMode;
  formants: boolean;
  reverse: boolean;
  regionStart: number | null;
  regionEnd: number | null;
  fadeIn: number;
  fadeOut: number;
  gainDb: number;
  normalize: boolean;
  crossfade: number;
  beat: number | null;
}

export interface Processing {
  params: ProcessParams;
  mode: StretchMode;
  /** Tempo follows the project for this sample. */
  synced: boolean;
  multiplier: number;
  /** The loop's tempo after half/double-time. */
  sourceBpm: number | null;
  /** The tempo you hear. */
  targetBpm: number | null;
  rate: number;
  /** The pitch change you hear, in semitones. */
  semitones: number;
  /** Part of `semitones` that comes from matching the project key. */
  keyShift: number;
  keyFrom: string | null;
  keyTo: string | null;
  /** Anything differs from the original file. */
  processed: boolean;
  /** Region/reverse/fades/gain differ from the original. */
  shaped: boolean;
  regionStart: number;
  regionEnd: number;
  /** Seconds per pass as heard. */
  outputDuration: number;
  /** Short description for file names: "128 BPM, Am, reversed". */
  label: string;
}

const mod = (n: number, m: number) => ((n % m) + m) % m;
const MAJOR = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"];
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function keyLabel(pc: number, mode: number): string {
  const i = mod(Math.round(pc), 12);
  return mode === 1 ? MINOR[i] : mode === 0 ? MAJOR[i] : NOTES[i];
}

export const MIN_RATE = 0.25;
export const MAX_RATE = 4;

/** Half/double-time that brings a loop's tempo closest to the target. */
export function autoMultiplier(bpm: number, target: number): number {
  const options = [0.5, 1, 2];
  return options.reduce((best, m) => (Math.abs(Math.log2(target / (bpm * m))) < Math.abs(Math.log2(target / (bpm * best))) ? m : best), 1);
}

/** Semitones (−6…+5) that move a sample's key onto the project key. */
export function keyMatchShift(row: Pick<SampleRow, "keyPc" | "keyMode">, key: ProjectKey): number {
  if (row.keyPc == null || row.keyMode == null) return 0;
  let src: number;
  let dst: number;
  if (row.keyMode === 2) {
    // A lone root note goes to the project's tonic.
    src = row.keyPc;
    dst = key.pc;
  } else {
    // Compare relative minors so C major and A minor count as the same key.
    src = row.keyMode === 1 ? row.keyPc : row.keyPc + 9;
    dst = key.mode === 1 ? key.pc : key.pc + 9;
  }
  const diff = mod(dst - src, 12);
  return diff >= 6 ? diff - 12 : diff;
}

export function computeProcessing(row: SampleRow, project: Project, edit: Edit = DEFAULT_EDIT): Processing {
  const duration = row.duration ?? 0;
  const mode = edit.mode ?? project.mode;
  // A tempo set by hand counts even on a one-shot: it was given one to sync.
  const isLoopWithTempo = hasTempo(row);
  const multiplier = isLoopWithTempo ? (edit.multiplier === "auto" ? autoMultiplier(row.bpm!, project.bpm) : edit.multiplier) : 1;
  const sourceBpm = isLoopWithTempo ? row.bpm! * multiplier : null;
  const synced = project.sync && sourceBpm != null;
  const tempoRatio = synced ? project.bpm / sourceBpm! : 1;

  const keyShift = project.matchKey && project.key ? keyMatchShift(row, project.key) : 0;
  const manual = edit.semitones + edit.cents / 100;

  let rate: number;
  let semitones: number;
  let paramSemitones: number;
  if (mode === "repitch") {
    // Speed and pitch are one control: tempo sync wins, otherwise pitch sets the speed.
    rate = synced ? tempoRatio : Math.pow(2, (keyShift + manual) / 12);
    rate = Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
    semitones = 12 * Math.log2(rate);
    paramSemitones = 0;
  } else {
    rate = Math.min(MAX_RATE, Math.max(MIN_RATE, tempoRatio));
    semitones = keyShift + manual;
    paramSemitones = semitones;
  }

  const targetBpm = isLoopWithTempo ? (synced ? project.bpm : row.bpm! * (mode === "repitch" ? rate : 1)) : null;

  const regionStart = Math.max(0, Math.min(edit.regionStart ?? 0, duration));
  const regionEnd = Math.max(regionStart, Math.min(edit.regionEnd ?? duration, duration));
  const partialRegion = edit.regionStart != null || edit.regionEnd != null;
  const shaped = edit.reverse || partialRegion || edit.fadeIn > 0 || edit.fadeOut > 0 || edit.gainDb !== 0 || edit.normalize;
  const pitched = Math.abs(semitones) > 1e-3;
  const tempoChanged = Math.abs(rate - 1) > 1e-4;
  const processed = shaped || pitched || tempoChanged;

  const keyFrom = row.keyPc != null && row.keyMode != null ? keyLabel(row.keyPc, row.keyMode) : null;
  const wholeShift = Math.round(semitones);
  const keyTo =
    row.keyPc != null && row.keyMode != null
      ? Math.abs(semitones - wholeShift) < 0.05
        ? keyLabel(row.keyPc + wholeShift, row.keyMode)
        : `${keyLabel(row.keyPc + wholeShift, row.keyMode)}${semitones - wholeShift > 0 ? "+" : "−"}`
      : null;

  const parts: string[] = [];
  if (tempoChanged && targetBpm != null) parts.push(`${fmtBpm(Math.round(targetBpm * 100) / 100)} BPM`);
  else if (tempoChanged) parts.push(`×${rate.toFixed(2)}`);
  if (pitched) parts.push(keyTo && !keyTo.endsWith("+") && !keyTo.endsWith("−") ? keyTo : `${semitones > 0 ? "+" : "−"}${Math.abs(semitones).toFixed(semitones % 1 ? 2 : 0)} st`);
  if (edit.reverse) parts.push("reversed");
  if (partialRegion) {
    const beat = sourceBpm ? 60 / sourceBpm : null;
    parts.push(
      beat
        ? `bars ${Math.floor(regionStart / (beat * 4)) + 1}–${Math.round(regionEnd / (beat * 4))}`
        : `${regionStart.toFixed(2)}–${regionEnd.toFixed(2)} s`,
    );
  }
  if (!parts.length && shaped) parts.push("edit");

  return {
    params: {
      rate,
      semitones: paramSemitones,
      mode,
      formants: edit.formants ?? project.formants,
      reverse: edit.reverse,
      regionStart: partialRegion ? regionStart : null,
      regionEnd: partialRegion ? regionEnd : null,
      fadeIn: edit.fadeIn,
      fadeOut: edit.fadeOut,
      gainDb: edit.gainDb,
      normalize: edit.normalize,
      crossfade: edit.crossfade,
      beat: sourceBpm ? 60 / sourceBpm : null,
    },
    mode,
    synced,
    multiplier,
    sourceBpm,
    targetBpm,
    rate,
    semitones,
    keyShift,
    keyFrom,
    keyTo,
    processed,
    shaped,
    regionStart,
    regionEnd,
    outputDuration: (regionEnd - regionStart) / rate,
    label: parts.join(", "),
  };
}
