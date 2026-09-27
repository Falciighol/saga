// Chord progressions for the Lab: presets, voicing, the rhythms they're played in, and what to
// try next. `patternNotes` is the one description of what a progression sounds like; the Rust
// player (src-tauri/src/sequence.rs) loops it and the MIDI clip (midi.rs) is written from it.

import { chordAt, rootName, scaleById, scaleChords, SCALES, type Chord, type HarmonicFunction, type Scale } from "./theory";

export type Rhythm = "hold" | "pulse" | "arp";

/** A chord in a progression, relative to its key so the progression can be transposed. */
export interface ProgChord {
  /** Semitones from the key's root to the chord's root. */
  iv: number;
  quality: string;
}

export interface Sketch {
  /** The key: root and scale. */
  pc: number;
  scaleId: string;
  /** One chord a bar; always MAX_BARS long, the first `length` are played. */
  bars: (ProgChord | null)[];
  length: number;
  rhythm: Rhythm;
  /** The preset or saved idea it came from, for the MIDI file's name. */
  name: string | null;
}

export const MAX_BARS = 8;
export const BAR_COUNTS = [2, 4, 8];

export interface Preset {
  name: string;
  scaleId: string;
  chords: ProgChord[];
}

const c = (iv: number, quality = ""): ProgChord => ({ iv, quality });

export const PRESETS: Preset[] = [
  { name: "Pop anthem", scaleId: "ionian", chords: [c(0), c(7), c(9, "m"), c(5)] },
  { name: "Sensitive", scaleId: "ionian", chords: [c(9, "m"), c(5), c(0), c(7)] },
  { name: "Night drive", scaleId: "aeolian", chords: [c(0, "m"), c(8), c(3), c(10)] },
  { name: "Andalusian cadence", scaleId: "aeolian", chords: [c(0, "m"), c(10), c(8), c(7)] },
  { name: "Drill", scaleId: "harmonic-minor", chords: [c(0, "m"), c(8), c(7), c(0, "m")] },
  { name: "Dorian vamp", scaleId: "dorian", chords: [c(0, "m7"), c(5, "7"), c(0, "m7"), c(5, "7")] },
  { name: "Phrygian pulse", scaleId: "phrygian", chords: [c(0, "m"), c(1), c(0, "m"), c(1)] },
  { name: "Jazz turnaround", scaleId: "ionian", chords: [c(2, "m7"), c(7, "7"), c(0, "maj7"), c(9, "m7")] },
  { name: "Royal road", scaleId: "ionian", chords: [c(5, "maj7"), c(7, "7"), c(4, "m7"), c(9, "m7")] },
];

const mod = (n: number, m: number) => ((n % m) + m) % m;

export function sketchScale(s: Pick<Sketch, "scaleId">): Scale {
  return scaleById(s.scaleId) ?? SCALES[0];
}

export function keyLabel(s: Pick<Sketch, "pc" | "scaleId">): string {
  const scale = sketchScale(s);
  return `${rootName(s.pc, scale.mode)} ${scale.id === "aeolian" ? "min" : scale.id === "ionian" ? "maj" : scale.name}`;
}

export function emptyBars(): (ProgChord | null)[] {
  return Array.from({ length: MAX_BARS }, () => null);
}

/**
 * A preset in the key `pc` of the given major or minor: on the same root when the preset's scale
 * is the same kind, otherwise on the relative major or minor, so it keeps the key's notes.
 */
export function presetSketch(p: Preset, pc: number, mode: 0 | 1, rhythm: Rhythm): Sketch {
  const scale = scaleById(p.scaleId) ?? SCALES[0];
  const root = scale.mode === mode ? pc : scale.mode === 0 ? mod(pc + 3, 12) : mod(pc + 9, 12);
  const bars = emptyBars();
  p.chords.forEach((ch, i) => (bars[i] = ch));
  return { pc: root, scaleId: p.scaleId, bars, length: p.chords.length, rhythm, name: p.name };
}

/** Changes how many bars play; bars that open up repeat the ones before them unless already set. */
export function resize(bars: (ProgChord | null)[], from: number, to: number): (ProgChord | null)[] {
  const out = [...bars];
  for (let i = from; i < to; i++) out[i] ??= out[i % from] ?? null;
  return out;
}

export function chordOf(s: Pick<Sketch, "pc" | "scaleId">, ch: ProgChord): Chord {
  return chordAt(s.pc, sketchScale(s), ch.iv, ch.quality);
}

/**
 * Voices a chord in a fixed window (F3 to E4) with its root in the bass below, so moving from
 * chord to chord changes few notes by small steps, the way a keyboard player would.
 */
export function voicing(pc: number, ch: ProgChord): { bass: number; upper: number[] } {
  const root = mod(pc + ch.iv, 12);
  const tones = chordAt(pc, SCALES[0], ch.iv, ch.quality).tones;
  const upper = tones.map((t) => 53 + mod(root + t - 5, 12)).sort((a, b) => a - b);
  return { bass: 36 + root - (root > 9 ? 12 : 0), upper };
}

/** A note of a progression, in beats from its start. */
export interface PatternNote {
  note: number;
  start: number;
  length: number;
  velocity: number;
}

/** Up the chord to the octave and back down: 0 1 2 3 2 1… */
function pingPong(n: number): number[] {
  const up = Array.from({ length: n }, (_, i) => i);
  return [...up, ...up.slice(1, -1).reverse()];
}

/** The notes a progression plays, bar by bar in 4/4: the bass holds, the chord follows the rhythm. */
export function patternNotes(s: Sketch): PatternNote[] {
  const out: PatternNote[] = [];
  for (let b = 0; b < s.length; b++) {
    const ch = s.bars[b];
    if (!ch) continue;
    const { bass, upper } = voicing(s.pc, ch);
    const t = b * 4;
    out.push({ note: bass, start: t, length: 3.9, velocity: 0.8 });
    if (s.rhythm === "hold") {
      for (const n of upper) out.push({ note: n, start: t, length: 3.9, velocity: 0.7 });
    } else if (s.rhythm === "pulse") {
      for (let q = 0; q < 4; q++) for (const n of upper) out.push({ note: n, start: t + q, length: 0.8, velocity: q === 0 ? 0.75 : 0.6 });
    } else {
      const notes = [...upper, upper[0] + 12];
      const order = pingPong(notes.length);
      for (let k = 0; k < 8; k++) out.push({ note: notes[order[k % order.length]], start: t + k / 2, length: 0.45, velocity: k % 2 === 0 ? 0.75 : 0.6 });
    }
  }
  return out;
}

export interface Suggestion extends Chord {
  why: string;
}

const NEXT: Record<HarmonicFunction, HarmonicFunction[]> = {
  tonic: ["subdominant", "dominant"],
  subdominant: ["dominant", "tonic"],
  dominant: ["tonic", "subdominant"],
};
const WHY: Record<HarmonicFunction, string> = { tonic: "resolves home", subdominant: "moves away", dominant: "builds tension" };

/**
 * Chords of the scale to try after `prev`: home leads away, away leads to tension, tension
 * resolves. With nothing before it, the chords that feel like home.
 */
export function suggestions(s: Pick<Sketch, "pc" | "scaleId">, prev: ProgChord | null, sevenths: boolean): Suggestion[] {
  const palette = scaleChords(s.pc, sketchScale(s), sevenths);
  if (!prev) return palette.filter((ch) => ch.fn === "tonic").slice(0, 4).map((ch) => ({ ...ch, why: "start at home" }));
  const from = chordOf(s, prev).fn;
  return NEXT[from]
    .flatMap((fn) => palette.filter((ch) => ch.fn === fn && !(ch.iv === prev.iv && ch.quality === prev.quality)))
    .slice(0, 4)
    .map((ch) => ({ ...ch, why: WHY[ch.fn] }));
}

export function sameChord(a: ProgChord | null | undefined, b: ProgChord | null | undefined): boolean {
  return a != null && b != null && mod(a.iv, 12) === mod(b.iv, 12) && a.quality === b.quality;
}
