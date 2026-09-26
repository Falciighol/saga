// Sound map data and colors. Group order mirrors `group_of` in src-tauri/src/sounds.rs.

import type { MapLayout } from "./types";

export interface MapGroup {
  name: string;
  /** Categories colored this way. */
  categories: string[];
  light: string;
  dark: string;
}

// Hues from the validated reference palette, assigned so that groups which tend to sit
// next to each other on the map (kicks by bass, snares by percussion, hats by FX…) stay
// distinct with full color vision (ΔE ≥ 19) and colorblind (ΔE ≥ 6.9, with the legend
// and cluster labels as the second channel).
export const MAP_GROUPS: MapGroup[] = [
  { name: "Kick", categories: ["Kick"], light: "#1baf7a", dark: "#199e70" },
  { name: "Snare & clap", categories: ["Snare", "Clap"], light: "#2a78d6", dark: "#3987e5" },
  { name: "Hat & cymbal", categories: ["Hat"], light: "#e87ba4", dark: "#d55181" },
  { name: "Percussion", categories: ["Perc", "Drums"], light: "#eda100", dark: "#c98500" },
  { name: "Bass", categories: ["Bass"], light: "#eb6834", dark: "#d95926" },
  { name: "Melodic", categories: ["Synth", "Keys", "Pad", "Melody", "Guitar", "Strings", "Brass"], light: "#4a3aa7", dark: "#9085e9" },
  { name: "Vocal", categories: ["Vocal"], light: "#e34948", dark: "#e66767" },
  { name: "FX", categories: ["FX"], light: "#008300", dark: "#008300" },
  { name: "Uncategorized", categories: [], light: "#8f8a80", dark: "#747981" },
];

export const OTHER_GROUP = 8;

export function groupOf(category: string | null): number {
  const g = MAP_GROUPS.findIndex((m) => category != null && m.categories.includes(category));
  return g < 0 ? OTHER_GROUP : g;
}

/** One-hue sequential ramp (blue 100→700); dark mode runs from dark to light. */
const RAMP = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"];

/** `steps` colors from low to high magnitude, for the theme. */
export function sequential(theme: "light" | "dark", steps: number): string[] {
  // Keep the faint end visible against the surface: light starts at step 250, dark at 600.
  const stops = theme === "light" ? RAMP.slice(3) : RAMP.slice(0, 11).reverse();
  return Array.from({ length: steps }, (_, i) => {
    const t = (i / Math.max(1, steps - 1)) * (stops.length - 1);
    const a = Math.floor(t);
    const b = Math.min(stops.length - 1, a + 1);
    return mixHex(stops[a], stops[b], t - a);
  });
}

function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (p: number, s: number) => (p >> s) & 255;
  const c = [16, 8, 0].map((s) => Math.round(ch(pa, s) + (ch(pb, s) - ch(pa, s)) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export interface MapData {
  key: string;
  count: number;
  ids: Int32Array;
  /** Positions in 0–1. */
  x: Float32Array;
  y: Float32Array;
  group: Uint8Array;
  /** 0–255: spectral centroid (log scale) and loudest level. */
  bright: Uint8Array;
  level: Uint8Array;
  /** Point index by sample id. */
  index: Map<number, number>;
  labels: MapLayout["labels"];
  described: number;
  pending: number;
  /** Point indices bucketed on a grid, for finding the point under the pointer. */
  grid: Int32Array[];
}

export const GRID = 96;

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodeLayout(layout: MapLayout): MapData {
  const bytes = base64Bytes(layout.points);
  const view = new DataView(bytes.buffer);
  const n = Math.floor(bytes.length / 12);
  const d: MapData = {
    key: layout.key,
    count: n,
    ids: new Int32Array(n),
    x: new Float32Array(n),
    y: new Float32Array(n),
    group: new Uint8Array(n),
    bright: new Uint8Array(n),
    level: new Uint8Array(n),
    index: new Map(),
    labels: layout.labels,
    described: layout.described,
    pending: layout.pending,
    grid: [],
  };
  const cells: number[][] = Array.from({ length: GRID * GRID }, () => []);
  for (let i = 0; i < n; i++) {
    const o = i * 12;
    d.ids[i] = view.getInt32(o, true);
    d.x[i] = view.getUint16(o + 4, true) / 65535;
    d.y[i] = view.getUint16(o + 6, true) / 65535;
    d.group[i] = bytes[o + 8];
    d.bright[i] = bytes[o + 9];
    d.level[i] = bytes[o + 10];
    d.index.set(d.ids[i], i);
    cells[cellOf(d.x[i], d.y[i])].push(i);
  }
  d.grid = cells.map((c) => Int32Array.from(c));
  return d;
}

export function cellOf(x: number, y: number): number {
  const cx = Math.min(GRID - 1, Math.max(0, Math.floor(x * GRID)));
  const cy = Math.min(GRID - 1, Math.max(0, Math.floor(y * GRID)));
  return cy * GRID + cx;
}

/** Per-point match flags from the backend's bitset, or null when everything matches. */
export function decodeMatches(bits: string | null, n: number): Uint8Array | null {
  if (bits == null) return null;
  const bytes = base64Bytes(bits);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (bytes[i >> 3] >> (i & 7)) & 1;
  return out;
}
