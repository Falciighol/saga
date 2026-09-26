import type { KeyFilter } from "./types";

const MAJOR = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"];
const LONG_ROOT = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];

export function keyName(pc: number, mode: 0 | 1): string {
  return mode === 1 ? MINOR[pc] : MAJOR[pc];
}

export function keyLongName(pc: number, mode: 0 | 1): string {
  return `${mode === 1 ? LONG_ROOT[pc] : MAJOR[pc]} ${mode === 1 ? "minor" : "major"}`;
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

/** Camelot number (1–12) for a key; A is minor, B is major. */
export function camelot(pc: number, mode: 0 | 1): string {
  const minorPc = mode === 1 ? pc : pc - 3;
  const steps = mod(mod(minorPc - 9, 12) * 7, 12);
  return `${mod(7 + steps, 12) + 1}${mode === 1 ? "A" : "B"}`;
}

/** Wheel position n (1–12) → the minor and major keys that sit there. */
export function wheelKeys(n: number): { minor: number; major: number } {
  const minor = mod(9 + 7 * (n - 8), 12);
  return { minor, major: mod(minor + 3, 12) };
}

export function compatibleKeys(pc: number, mode: 0 | 1): { pc: number; mode: 0 | 1 }[] {
  return mode === 1
    ? [
        { pc, mode: 1 },
        { pc: mod(pc + 7, 12), mode: 1 },
        { pc: mod(pc + 5, 12), mode: 1 },
        { pc: mod(pc + 3, 12), mode: 0 },
      ]
    : [
        { pc, mode: 0 },
        { pc: mod(pc + 7, 12), mode: 0 },
        { pc: mod(pc + 5, 12), mode: 0 },
        { pc: mod(pc + 9, 12), mode: 1 },
      ];
}

export function keyFilterLabel(k: KeyFilter): string {
  return `${keyLongName(k.pc, k.mode).replace(" minor", " min").replace(" major", " maj")}${k.compatible ? " + compatible" : ""}`;
}

export function keyFilterToken(k: KeyFilter): string {
  return `key:${keyName(k.pc, k.mode)}${k.compatible ? "+" : ""}`;
}
