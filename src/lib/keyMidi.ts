// The project key as a MIDI clip to drag out of the key popup: a bar up its scale and, if asked,
// a bar for each related key. Written by the same command as the Lab's progressions (midi.rs).

import type { Sequence } from "./api";
import { compatibleKeys, keyLongName, projectKeyLabel } from "./keys";
import type { ProjectKey } from "./processing";
import { fittingKeys, isPlain, noteFrom, plainScale, scaleById, type Scale } from "./theory";

const BAR = 4;
/** Beats per note: eighths. */
const STEP = 0.5;

export interface KeyClip {
  notes: Sequence["notes"];
  beats: number;
  /** The clip's track and file name: "A min scale". */
  name: string;
  /** The related keys in the clip, in order: "E minor", "D minor", "C major". */
  related: string[];
}

/** The keys the wheel marks for a project key: its neighbours and relative, or for a Lab scale the keys that hold its notes. */
export function relatedKeys(key: ProjectKey): { pc: number; mode: 0 | 1 }[] {
  const scale = scaleById(key.scale);
  // From the key's own root upwards, rather than from C.
  if (scale && !isPlain(scale)) return fittingKeys(key.pc, scale.steps).sort((a, b) => ((a.pc - key.pc + 12) % 12) - ((b.pc - key.pc + 12) % 12));
  return compatibleKeys(key.pc, key.mode).filter((k) => k.pc !== key.pc || k.mode !== key.mode);
}

/** Up the scale from the root in eighths; the octave is held to the bar line so every scale ends on one. */
function run(pc: number, scale: Scale, at: number): { notes: Sequence["notes"]; beats: number } {
  const ivs = [...scale.steps, 12];
  const beats = Math.ceil((ivs.length * STEP) / BAR) * BAR;
  const notes = ivs.map((iv, i) => ({
    note: noteFrom(pc, iv),
    start: at + i * STEP,
    length: i === ivs.length - 1 ? beats - i * STEP : STEP,
    velocity: 0.8,
  }));
  return { notes, beats };
}

export function keyClip(key: ProjectKey, related: boolean): KeyClip {
  const others = related ? relatedKeys(key) : [];
  const first = run(key.pc, scaleById(key.scale) ?? plainScale(key.mode), 0);
  const notes = [...first.notes];
  let beats = first.beats;
  for (const k of others) {
    const next = run(k.pc, plainScale(k.mode), beats);
    notes.push(...next.notes);
    beats += next.beats;
  }
  const label = projectKeyLabel(key);
  return {
    notes,
    beats,
    name: others.length ? `${label} and related keys` : `${label} scale`,
    related: others.map((k) => keyLongName(k.pc, k.mode)),
  };
}
