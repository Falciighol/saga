// Dev-only stand-in for the Rust backend, so the UI can be worked on in a plain browser
// (`npm run dev`, then open http://localhost:1420). Never bundled into the app.

import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { camelot, compatibleKeys, keyName } from "../lib/keys";
import { fittingKeys, scaleFit, scaleNotes } from "../lib/theory";
import { groupOf } from "../lib/soundmap";
import type { Collection, Facets, Filters, KeyChange, PitchProfile, QueryRequest, SampleRow, SourceInfo, TempoChange } from "../lib/types";
import { BPM_HIST_BINS, BPM_HIST_MIN, BPM_HIST_STEP, DUR_HIST_BINS, DUR_HIST_MAX, DUR_HIST_MIN } from "../lib/types";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS: Record<string, [number, number]> = {
  Am: [9, 1], Em: [4, 1], Dm: [2, 1], Gm: [7, 1], "F#m": [6, 1], Bbm: [10, 1], Cm: [0, 1], C: [0, 0], F: [5, 0], G: [7, 0], Eb: [3, 0],
};
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function envelope(kind: string, r: () => number, beats: number): Uint8Array {
  const out = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    const t = (i + 0.5) / 512;
    const p16 = t * beats * 4;
    const ph = p16 - Math.floor(p16);
    const inBeat = Math.floor(p16) % 4;
    let v: number;
    switch (kind) {
      case "hit":
        v = t < 0.02 ? 1 : Math.exp(-t * 7) * (0.85 + 0.15 * r());
        break;
      case "long":
        v = Math.exp(-t * 2.2) * (0.8 + 0.2 * r());
        break;
      case "drums":
        v = (inBeat === 0 ? 1 : inBeat === 2 ? 0.5 : 0.28) * Math.exp(-ph * 3) * (0.8 + 0.2 * r());
        break;
      case "pad":
        v = (0.4 + 0.2 * Math.sin(t * 12)) * Math.min(1, t * 5) * Math.min(1, (1 - t) * 4) * (0.85 + 0.15 * r());
        break;
      default: {
        const p2 = (t * beats) / 2;
        v = (0.55 + 0.25 * r()) * Math.exp(-(p2 - Math.floor(p2)) * 1.4) + 0.06;
      }
    }
    out[i] = Math.round(Math.min(1, v) * 255);
  }
  return out;
}

function b64(a: Uint8Array) {
  let s = "";
  for (const x of a) s += String.fromCharCode(x);
  return btoa(s);
}

const SOURCES: SourceInfo[] = [
  { id: 1, path: "/Volumes/Samples/Sample Packs", name: "Sample Packs", online: true, count: 0, excluded: [] },
  { id: 2, path: "/Users/me/Splice/sounds", name: "Splice", online: true, count: 0, excluded: [] },
  { id: 3, path: "/Users/me/Music/Recordings", name: "Recordings", online: true, count: 0, excluded: [] },
];

const PACKS = [
  { source: 1, pack: "Dusty Tape Drums Vol.2", prefix: "DT2", cats: ["Kick", "Snare", "Hat", "Perc", "Drums"], tags: ["tape", "dusty"] },
  { source: 1, pack: "Nightdrive Synthwave", prefix: "Nightdrive", cats: ["Bass", "Synth", "Pad", "Drums"], tags: ["analog", "synthwave"] },
  { source: 1, pack: "Vocal Chops Amber", prefix: "Amber_Vox", cats: ["Vocal"], tags: ["female", "chopped"] },
  { source: 1, pack: "Warehouse Techno Tools", prefix: "WTT", cats: ["Kick", "Clap", "Hat", "Perc", "FX", "Drums"], tags: ["techno", "909"] },
  { source: 2, pack: "Lo-Fi Keys & Textures", prefix: "LoFi", cats: ["Keys", "Pad", "Bass"], tags: ["lofi", "warm"] },
  { source: 3, pack: "Recordings", prefix: "Take", cats: ["Guitar", "Vocal", "Perc"], tags: [] },
];
const WORDS: Record<string, string[]> = {
  Kick: ["Kick_Punchy", "Kick_Round", "Kick_Dusty", "Kick_Sub"],
  Snare: ["Snare_Crack", "Snare_Room", "Rim_Tight"],
  Clap: ["Clap_Wide", "Clap_Stack"],
  Hat: ["Hat_Closed", "Hat_Open", "Ride_Soft"],
  Perc: ["Perc_Shaker", "Perc_Conga", "Perc_Rumble"],
  Drums: ["Drum_Loop", "Top_Loop", "Break_Loop"],
  Bass: ["Bass_Loop", "Bass_Pluck", "Reese_Loop"],
  Synth: ["Arp_Loop", "Chord_Stabs", "Lead_Loop"],
  Keys: ["Rhodes_Loop", "Piano_Chords"],
  Pad: ["Pad_Texture", "Drone_Air"],
  Vocal: ["Vox_Chop_Loop", "Vox_Phrase", "Vox_Shot_Hey"],
  Guitar: ["Guitar_Riff", "Guitar_Strum"],
  FX: ["FX_Riser", "FX_Impact", "FX_Sweep"],
};

const DAY = 86_400;

/** Spread over the last 400 days, a few created today, with Saga finding each a few days later. */
function mockDates(id: number): Pick<SampleRow, "created" | "added"> {
  const now = Math.floor(Date.now() / 1000);
  const created = now - ((id * 7919) % 400) * DAY - ((id * 3631) % DAY);
  return { created, added: Math.min(now, created + ((id * 31) % 5) * DAY) };
}

function build(): SampleRow[] {
  const r = rng(42);
  const rows: SampleRow[] = [];
  let id = 1;
  for (const p of PACKS) {
    for (const cat of p.cats) {
      const n = 6 + Math.floor(r() * 10);
      for (let i = 0; i < n; i++) {
        const base = WORDS[cat][Math.floor(r() * WORDS[cat].length)];
        const loop = /Loop|Stabs|Riff|Strum|Phrase|Drone|Texture|Chords/.test(base) || cat === "Drums";
        const bpm = loop ? [90, 118, 120, 122, 124, 126, 128, 140, 174][Math.floor(r() * 9)] : null;
        const keyNames = Object.keys(KEYS);
        const pitched = !["Kick", "Snare", "Clap", "Hat", "Perc", "Drums", "FX"].includes(cat) || (cat === "Kick" && r() > 0.5);
        const keyName = pitched ? (loop ? keyNames[Math.floor(r() * keyNames.length)] : NOTES[Math.floor(r() * 12)]) : null;
        const bars = loop ? [2, 4, 4, 8, 8, 16][Math.floor(r() * 6)] : 0;
        const duration = loop && bpm ? (bars * 240) / bpm : 0.12 + r() * (cat === "FX" ? 4 : 1.6);
        // Own recordings have no tempo or key in their names; Saga detects them from the audio.
        const detected = p.source === 3;
        const name = detected
          ? `${p.prefix}_${base}_${String(i + 1).padStart(2, "0")}`
          : `${p.prefix}_${base}${bpm ? `_${bpm}` : ""}${keyName ? `_${keyName}` : ""}_${String(i + 1).padStart(2, "0")}`;
        const key = keyName ? (KEYS[keyName] ?? [NOTES.indexOf(keyName), 2]) : null;
        const kindShape = loop ? (cat === "Drums" ? "drums" : cat === "Pad" ? "pad" : "melodic") : cat === "FX" || cat === "Bass" ? "long" : "hit";
        const sub = loop ? "Loops" : "One Shots";
        rows.push({
          id: id++,
          sourceId: p.source,
          path: `${SOURCES[p.source - 1].path}/${p.pack}/${sub}/${name}.wav`,
          name,
          ext: r() > 0.85 ? "aif" : "wav",
          dir: p.source === 3 ? "" : `${p.pack}/${sub}`,
          pack: p.source === 3 ? "Recordings" : p.pack,
          duration,
          sampleRate: r() > 0.5 ? 44100 : 48000,
          channels: r() > 0.3 ? 2 : 1,
          bitDepth: 24,
          bpm: detected && bpm ? bpm - 0.2 : bpm,
          bpmSource: bpm ? (detected ? "audio" : "name") : null,
          key: keyName,
          keySource: keyName ? (detected ? "audio" : "name") : null,
          keyPc: key ? key[0] : null,
          keyMode: key ? key[1] : null,
          camelot: null,
          kind: loop ? "loop" : "oneshot",
          category: cat,
          tags: [...p.tags],
          userTags: [],
          peakDb: -0.3 - r() * 6,
          loudness: -6 - r() * 12,
          peaks: b64(envelope(kindShape, r, Math.max(4, bars * 4))),
          status: 1,
          favorite: r() > 0.9,
          online: true,
          playCount: 0,
          // From the id, not the random stream, so adding dates didn't change the rest of the mock.
          ...mockDates(id - 1),
        });
      }
    }
  }
  return rows;
}

const ALL_ROWS = build();
/** Everything in the library: all rows but the ones in excluded folders or removed sources. */
let ROWS = ALL_ROWS;

/** Folder names left out everywhere, like the real setting. */
let excludedNames: string[] = [];

function nameExcluded(seg: string): boolean {
  return excludedNames.some((n) => new RegExp(`^${n.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i").test(seg));
}

function applyExclusions() {
  ROWS = ALL_ROWS.filter((r) => {
    const src = SOURCES.find((s) => s.id === r.sourceId);
    return src != null && !src.excluded.some((dir) => r.dir === dir || r.dir.startsWith(`${dir}/`)) && !r.dir.split("/").some((seg) => seg && nameExcluded(seg));
  });
  void emit("library-changed");
}

/** Tempo and key as found, to go back to after setting them by hand. */
const FOUND = new Map(ALL_ROWS.map((r) => [r.id, { bpm: r.bpm, bpmSource: r.bpmSource, key: r.key, keySource: r.keySource, keyPc: r.keyPc, keyMode: r.keyMode, camelot: r.camelot }]));

function setValues(r: SampleRow, tempo: TempoChange | null, key: KeyChange | null) {
  const found = FOUND.get(r.id)!;
  if (tempo?.to === "bpm") Object.assign(r, { bpm: Math.round(tempo.bpm * 100) / 100, bpmSource: "user" });
  else if (tempo?.to === "noTempo") Object.assign(r, { bpm: null, bpmSource: "user" });
  else if (tempo?.to === "detected") Object.assign(r, { bpm: found.bpm, bpmSource: found.bpmSource });
  if (key?.to === "key") {
    const name = key.mode === 2 ? NOTES[key.pc] : keyName(key.pc, key.mode);
    Object.assign(r, { key: name, keySource: "user", keyPc: key.pc, keyMode: key.mode, camelot: key.mode === 2 ? null : camelot(key.pc, key.mode) });
  } else if (key?.to === "noKey") Object.assign(r, { key: null, keySource: "user", keyPc: null, keyMode: null, camelot: null });
  else if (key?.to === "detected") Object.assign(r, { key: found.key, keySource: found.keySource, keyPc: found.keyPc, keyMode: found.keyMode, camelot: found.camelot });
}

/** Folders the mock pretends are inside any folder that gets added. */
const MOCK_SUBFOLDERS = [
  { name: "Drum Machines", hasChildren: true },
  { name: "Field Recordings", hasChildren: false },
  { name: "Old Projects", hasChildren: true },
  { name: "Vinyl Rips", hasChildren: false },
];
const collections: Collection[] = [
  { id: 1, name: "Nightdrive EP", color: "#D9A441", count: 0 },
  { id: 2, name: "Go-to kicks", color: "#B887D6", count: 0 },
];
const members = new Map<number, Set<number>>([
  [1, new Set(ROWS.filter((r) => r.pack === "Nightdrive Synthwave").slice(0, 8).map((r) => r.id))],
  [2, new Set(ROWS.filter((r) => r.category === "Kick").slice(0, 5).map((r) => r.id))],
]);

// ---- sound map and similarity: clusters by category, like the real map ----

const CENTERS: [number, number][] = [
  [0.24, 0.3], [0.5, 0.18], [0.79, 0.26], [0.59, 0.46], [0.23, 0.66], [0.5, 0.74], [0.78, 0.7], [0.89, 0.49], [0.12, 0.88],
];
const ORDER: Record<string, number[]> = {
  timbre: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  pitch: [4, 7, 1, 8, 0, 6, 5, 2, 3],
  envelope: [2, 0, 5, 1, 3, 8, 7, 4, 6],
};

function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(Math.max(1e-6, r()))) * Math.cos(2 * Math.PI * r());
}

function position(row: SampleRow, aspect: string): [number, number] {
  const g = groupOf(row.category);
  const [cx, cy] = CENTERS[(ORDER[aspect] ?? ORDER.timbre)[g]];
  const r = rng(row.id * 31 + aspect.length);
  return [Math.min(1, Math.max(0, cx + gauss(r) * 0.055)), Math.min(1, Math.max(0, cy + gauss(r) * 0.05))];
}

function similarTo(point: (aspect: string) => [number, number], kind: string | null, sourceId: number | null, aspect: string, skip?: number) {
  const aspects = aspect === "overall" ? ["timbre", "pitch", "envelope"] : [aspect];
  const dist = (r: SampleRow) =>
    aspects.reduce((sum, a) => {
      const [x, y] = position(r, a);
      const [px, py] = point(a);
      return sum + Math.hypot(x - px, y - py);
    }, 0) / aspects.length;
  return ROWS.filter((r) => r.id !== skip && (!kind || r.kind === kind) && (sourceId == null || r.sourceId === sourceId))
    .map((row) => ({ row, d: dist(row) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 40)
    .map(({ row, d }) => ({ row, score: Math.max(0, Math.min(1, 1 - d / 0.45)) }));
}

const layouts = new Map<string, number[]>();

function soundMap(kind: string | null, aspect: string) {
  const rows = ROWS.filter((r) => !kind || r.kind === kind);
  const bytes = new Uint8Array(rows.length * 12);
  const view = new DataView(bytes.buffer);
  const counts = new Map<number, { n: number; x: number; y: number }>();
  rows.forEach((r, i) => {
    const [x, y] = position(r, aspect);
    const g = groupOf(r.category);
    view.setInt32(i * 12, r.id, true);
    view.setUint16(i * 12 + 4, Math.round(x * 65535), true);
    view.setUint16(i * 12 + 6, Math.round(y * 65535), true);
    bytes[i * 12 + 8] = g;
    bytes[i * 12 + 9] = Math.round(Math.min(1, Math.max(0, [0.15, 0.55, 0.95, 0.7, 0.2, 0.5, 0.45, 0.8, 0.5][g] + gauss(rng(r.id)) * 0.12)) * 255);
    bytes[i * 12 + 10] = Math.round(Math.min(1, Math.max(0, ((r.peakDb ?? -6) + 18) / 18)) * 255);
    const c = counts.get(g) ?? { n: 0, x: 0, y: 0 };
    counts.set(g, { n: c.n + 1, x: c.x + x, y: c.y + y });
  });
  const key = `${kind ?? "all"}-${aspect}-1`;
  layouts.set(key, rows.map((r) => r.id));
  return {
    key,
    count: rows.length,
    points: b64(bytes),
    labels: [...counts.entries()].filter(([g]) => g !== 8).map(([group, c]) => ({ group, x: c.x / c.n, y: c.y / c.n, count: c.n })),
    described: ROWS.length,
    pending: 0,
  };
}

let savedSounds: string | null = null;
/** Files in the Renders folder by age in days, about a day's heavy use and some older ones. */
let mockRenders: { days: number; bytes: number }[] = Array.from({ length: 1340 }, (_, i) => ({ days: i < 300 ? 0 : i < 700 ? 3 + (i % 4) : i < 1020 ? 12 + (i % 15) : 40 + (i % 60), bytes: 1_200_000 + ((i * 7919) % 2_400_000) }));
let mockScratchBytes = 128_000_000;

function mockUsage() {
  const count = (keep: (r: { days: number }) => boolean) => {
    const rs = mockRenders.filter(keep);
    return { files: rs.length, bytes: rs.reduce((a, r) => a + r.bytes, 0) };
  };
  return {
    path: `${savedSounds ?? "/Users/me/Music/Saga"}/Renders`,
    all: count(() => true),
    olderThanWeek: count((r) => r.days > 7),
    olderThanMonth: count((r) => r.days > 30),
    scratch: { files: mockScratchBytes ? 40 : 0, bytes: mockScratchBytes },
  };
}
let recordTimer: number | undefined;

/**
 * A made-up pitch profile like the ones analysis stores: a key's notes with its tonic, fifth and
 * third strongest, overtones and some noise; a root note with its fifth; drums close to flat.
 * Some keyless melodic samples get a scale too, so "notes that fit" has something to find.
 */
const profiles = new Map<number, PitchProfile>();
function mockProfile(row: SampleRow): PitchProfile {
  const cached = profiles.get(row.id);
  if (cached) return cached;
  const r = rng(row.id * 7919 + 13);
  const chroma = Array.from({ length: 12 }, () => 0.02 + r() * 0.08);
  let hz: number | null = null;
  let clarity = 0.1 + r() * 0.2;
  const drum = ["Snare", "Clap", "Hat", "Perc", "Drums"].includes(row.category ?? "");
  let pc = row.keyPc;
  let mode = row.keyMode;
  if (pc == null && row.category === "Kick") {
    // An untagged kick still rings at a note, which the tuner can measure.
    pc = Math.floor(r() * 12);
    mode = 2;
  } else if (pc == null && !drum && r() > 0.5) {
    pc = Math.floor(r() * 12);
    mode = r() > 0.5 ? 1 : 0;
  }
  if (pc != null && mode === 2) {
    chroma[pc] += 1;
    chroma[(pc + 7) % 12] += 0.35;
    chroma[(pc + 4) % 12] += 0.1;
    const octave = row.category === "Kick" || row.category === "Bass" ? 1 : 3;
    hz = 440 * 2 ** ((12 * (octave + 1) + pc + (r() - 0.5) * 0.8 - 69) / 12);
    clarity = 0.7 + r() * 0.25;
  } else if (pc != null && (mode === 0 || mode === 1)) {
    const steps = mode === 1 ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    for (const iv of steps) chroma[(pc + iv) % 12] += iv === 0 ? 1 : iv === 7 ? 0.8 : iv === 3 || iv === 4 ? 0.7 : 0.25 + r() * 0.3;
    // The fifth harmonic of the tonic, a major third up, leaks in.
    chroma[(pc + 4) % 12] += 0.12;
  } else if (!drum) {
    for (let i = 0; i < 12; i++) chroma[i] += r() * 0.2;
  }
  const sum = chroma.reduce((a, b) => a + b, 0);
  const norm = chroma.map((v) => v / sum);
  const max = Math.max(...norm);
  const profile = { chroma: norm, tonality: Math.max(0, (max - 1 / 12) / (11 / 12)), hz, clarity };
  profiles.set(row.id, profile);
  return profile;
}

function keySteps(k: NonNullable<Filters["key"]>): number[] {
  return k.scale?.length ? k.scale : k.mode === 1 ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
}

/** Mirrors `MIN_SCALE_FIT` in src-tauri/src/keys.rs. */
const MIN_SCALE_FIT = 0.2;

function matches(r: SampleRow, f: Filters, omit?: string): boolean {
  const words = (f.text ?? "").toLowerCase().split(/\s+/).filter((w) => w && !w.includes(":"));
  const hay = `${r.name} ${r.dir} ${r.category} ${r.tags.join(" ")}`.toLowerCase();
  if (words.some((w) => (w.startsWith("-") ? hay.includes(w.slice(1)) : !hay.includes(w)))) return false;
  if (omit !== "kind" && f.kind && r.kind !== f.kind) return false;
  if (omit !== "cat" && f.categories?.length && !f.categories.includes(r.category ?? "")) return false;
  if (omit !== "bpm" && (f.bpmMin != null || f.bpmMax != null)) {
    if (r.bpm == null) return false;
    const inRange = (b: number) => (f.bpmMin == null || b >= f.bpmMin) && (f.bpmMax == null || b <= f.bpmMax);
    if (!(inRange(r.bpm) || (f.halfDouble && (inRange(r.bpm * 2) || inRange(r.bpm / 2))))) return false;
  }
  if (omit !== "key" && f.key) {
    const steps = f.key.scale?.length ? f.key.scale : null;
    const set = !f.key.compatible ? [{ pc: f.key.pc, mode: f.key.mode }] : steps ? fittingKeys(f.key.pc, steps) : compatibleKeys(f.key.pc, f.key.mode);
    const roots = scaleNotes(f.key.pc, steps ?? (f.key.mode === 1 ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]));
    if (r.keyPc == null) {
      if (!f.key.includeUnpitched && !(f.key.byNotes && (scaleFit(mockProfile(r).chroma, f.key.pc, keySteps(f.key)) ?? 0) >= MIN_SCALE_FIT)) return false;
    } else if (r.keyMode === 2) {
      if (f.key.rootInScale ? !roots.includes(r.keyPc) : r.keyPc !== f.key.pc) return false;
    } else if (!set.some((k) => k.pc === r.keyPc && k.mode === r.keyMode)) return false;
  }
  if (omit !== "dur") {
    if (f.durMin != null && (r.duration ?? 0) < f.durMin) return false;
    if (f.durMax != null && (r.duration ?? 0) > f.durMax) return false;
  }
  if (f.formats?.length && !f.formats.some((x) => r.ext.startsWith(x.slice(0, 3)))) return false;
  if (f.channels && (f.channels === 1 ? r.channels !== 1 : (r.channels ?? 0) < 2)) return false;
  if (f.sampleRates?.length && !f.sampleRates.includes(r.sampleRate ?? 0)) return false;
  if (f.tags?.some((t) => !r.tags.includes(t))) return false;
  if (f.excludeTags?.some((t) => r.tags.includes(t))) return false;
  if (f.createdFrom != null && (r.created ?? -Infinity) < f.createdFrom) return false;
  if (f.createdTo != null && (r.created ?? Infinity) >= f.createdTo) return false;
  if (f.favorites && !r.favorite) return false;
  if (f.collectionId != null && !members.get(f.collectionId)?.has(r.id)) return false;
  if (f.sourceId != null && r.sourceId !== f.sourceId) return false;
  if (f.dir && !(r.dir === f.dir || r.dir.startsWith(`${f.dir}/`))) return false;
  if (f.recent === "played" && r.playCount === 0) return false;
  return true;
}

function query(req: QueryRequest) {
  let rows = ROWS.filter((r) => matches(r, req.filters));
  const dir = req.desc ? -1 : 1;
  const by = (k: (r: SampleRow) => number | string | null) =>
    rows.sort((a, b) => {
      const x = k(a) ?? Infinity;
      const y = k(b) ?? Infinity;
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
  if (req.sort === "name") by((r) => r.name.toLowerCase());
  else if (req.sort === "bpm") by((r) => r.bpm);
  else if (req.sort === "duration") by((r) => r.duration);
  else if (req.sort === "created") by((r) => r.created);
  else if (req.sort === "added") by((r) => r.added);
  else if (req.sort === "key") by((r) => (r.keyPc == null ? null : r.keyPc * 3 + (r.keyMode ?? 0)));
  else if (req.sort === "fit" && req.filters.key) {
    const k = req.filters.key;
    const fit = (r: SampleRow) => scaleFit(mockProfile(r).chroma, k.pc, keySteps(k)) ?? -1;
    rows.sort((a, b) => fit(b) - fit(a) || a.name.localeCompare(b.name));
  }
  else if (req.sort === "random") rows = rows.map((r) => [((r.id * 2654435761 + req.seed) % 4294967291) >>> 0, r] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  // Copies, like rows that come over IPC: the UI tells changes apart by identity.
  return { total: rows.length, offset: req.offset, rows: rows.slice(req.offset, req.offset + req.limit).map((r) => ({ ...r })) };
}

function facets(f: Filters): Facets {
  const all = ROWS.filter((r) => matches(r, f));
  const noKind = ROWS.filter((r) => matches(r, f, "kind"));
  const noCat = ROWS.filter((r) => matches(r, f, "cat"));
  const cats = new Map<string, number>();
  for (const r of noCat) cats.set(r.category!, (cats.get(r.category!) ?? 0) + 1);
  const bpmHist = new Array(BPM_HIST_BINS).fill(0);
  for (const r of ROWS.filter((r) => matches(r, f, "bpm"))) {
    if (r.bpm == null) continue;
    const b = Math.floor((r.bpm - BPM_HIST_MIN) / BPM_HIST_STEP);
    if (b >= 0 && b < BPM_HIST_BINS) bpmHist[b]++;
  }
  const durHist = new Array(DUR_HIST_BINS).fill(0);
  const lo = Math.log(DUR_HIST_MIN);
  const hi = Math.log(DUR_HIST_MAX);
  for (const r of ROWS.filter((r) => matches(r, f, "dur"))) {
    const x = Math.floor(((Math.log(r.duration!) - lo) / (hi - lo)) * DUR_HIST_BINS);
    durHist[Math.max(0, Math.min(DUR_HIST_BINS - 1, x))]++;
  }
  const keys = new Array(24).fill(0);
  for (const r of ROWS.filter((r) => matches(r, f, "key"))) if (r.keyMode === 0 || r.keyMode === 1) keys[r.keyPc! * 2 + r.keyMode]++;
  const tags = new Map<string, number>();
  for (const r of all) for (const t of r.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
  return {
    total: all.length,
    loops: noKind.filter((r) => r.kind === "loop").length,
    oneshots: noKind.filter((r) => r.kind === "oneshot").length,
    categories: [...cats.entries()],
    bpmHist,
    durHist,
    keys,
    tags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
  };
}

interface MockParams {
  rate: number;
  mode: string;
  semitones: number;
  reverse: boolean;
  regionStart: number | null;
  regionEnd: number | null;
}
let playing: { id: number; duration: number; looping: boolean; params: MockParams; timeline: number; at: number; paused: boolean } | null = null;

function playbackEvent(state: string) {
  if (!playing) return;
  const p = playing.params;
  const rs = p.regionStart ?? 0;
  const re = p.regionEnd ?? playing.duration;
  const processed = p.mode === "repitch" ? Math.abs(p.rate - 1) > 1e-4 : Math.abs(p.rate - 1) > 1e-4 || Math.abs(p.semitones) > 1e-3;
  void emit("playback", {
    id: playing.id,
    state,
    timeline: playing.timeline,
    length: re - rs,
    rate: processed ? p.rate : 1,
    reverse: p.reverse,
    regionStart: rs,
    regionEnd: re,
    looping: playing.looping,
    message: null,
  });
}

/** Rough Web Audio stand-ins for the Rust synth presets, so the Lab can be heard in a plain browser. */
let audio: AudioContext | null = null;
const sounding = new Set<AudioScheduledSourceNode>();
/** Notes from the progression player, stopped on their own. */
const seqSounding = new Set<AudioScheduledSourceNode>();

function mockNote(ctx: AudioContext, note: number, t0: number, length: number, velocity: number, preset: string, from = sounding) {
  const f = 440 * 2 ** ((note - 69) / 12);
  const g = ctx.createGain();
  const v = velocity * 0.18;
  const attack = preset === "pad" ? 0.28 : 0.004;
  const release = preset === "pad" ? 0.45 : preset === "pluck" ? 0.06 : 0.12;
  const end = t0 + Math.max(0.05, length);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(v, t0 + attack);
  if (preset !== "pad") g.gain.setTargetAtTime(preset === "pluck" ? 0 : v * 0.2, t0 + attack, preset === "pluck" ? 0.35 : 0.6);
  g.gain.setTargetAtTime(0, end, release / 3);
  g.connect(ctx.destination);
  (preset === "pad" ? [0.9965, 1.0035, 0.5] : [1, 2]).forEach((ratio, i) => {
    const o = ctx.createOscillator();
    o.type = preset === "keys" ? "sine" : preset === "pad" ? "triangle" : "sawtooth";
    o.frequency.value = f * ratio;
    const og = ctx.createGain();
    og.gain.value = i === 0 ? 1 : preset === "pad" ? 0.6 : 0.15;
    let out: AudioNode = og;
    if (preset === "pluck") {
      const lp = ctx.createBiquadFilter();
      lp.frequency.setValueAtTime(f * 8, t0);
      lp.frequency.exponentialRampToValueAtTime(f * 1.5, t0 + 0.4);
      og.connect(lp);
      out = lp;
    }
    o.connect(og);
    out.connect(g);
    o.start(t0);
    o.stop(end + release * 4);
    from.add(o);
    o.onended = () => from.delete(o);
  });
}

function mockNotes(notes: { note: number; at?: number; length: number; velocity?: number }[], preset: string) {
  audio ??= new AudioContext();
  const ctx = audio;
  void ctx.resume();
  for (const n of notes) mockNote(ctx, n.note, ctx.currentTime + 0.02 + (n.at ?? 0), n.length, n.velocity ?? 1, preset);
}

/** The progression player: a look-ahead scheduler at the project tempo, like the Rust one without loop following. */
interface MockSequence {
  notes: { note: number; start: number; length: number; velocity: number }[];
  beats: number;
  bpm: number;
  preset: string;
}
let seq: MockSequence | null = null;
/** Audio-clock time of beat 0, beats scheduled so far, last whole beat reported. */
let seqOrigin = 0;
let seqUntil = 0;
let seqReported = -Infinity;
let seqTimer: number | undefined;
let clickOn = false;

function seqBeat(ctx: AudioContext, s: MockSequence): number {
  return ((ctx.currentTime - seqOrigin) * s.bpm) / 60;
}

function mockClick(ctx: AudioContext, t0: number, down: boolean) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.value = down ? 1760 : 1175;
  g.gain.setValueAtTime(0.25, t0);
  g.gain.setTargetAtTime(0, t0, 0.025);
  o.connect(g).connect(ctx.destination);
  o.start(t0);
  o.stop(t0 + 0.2);
}

function tickSequence() {
  const ctx = audio;
  const s = seq;
  if (!ctx || !s || s.beats <= 0) return;
  const spb = 60 / s.bpm;
  const horizon = seqBeat(ctx, s) + 0.12 / spb;
  const from = Math.max(0, seqUntil);
  for (let pass = Math.floor(from / s.beats); pass * s.beats < horizon; pass++) {
    for (const n of s.notes) {
      const b = pass * s.beats + n.start;
      if (b >= from && b < horizon) mockNote(ctx, n.note, seqOrigin + b * spb, n.length * spb, n.velocity, s.preset, seqSounding);
    }
  }
  if (clickOn) for (let b = Math.ceil(from); b < horizon; b++) mockClick(ctx, seqOrigin + b * spb, b % 4 === 0);
  seqUntil = Math.max(seqUntil, horizon);
  const beat = seqBeat(ctx, s);
  if (Math.floor(beat) !== seqReported) {
    seqReported = Math.floor(beat);
    void emit("lab-transport", { playing: true, beat, bpm: s.bpm });
  }
}

function playSequence(s: MockSequence) {
  audio ??= new AudioContext();
  void audio.resume();
  if (seq) {
    // Keep its place at the new tempo.
    seqOrigin = audio.currentTime - (seqBeat(audio, seq) * 60) / s.bpm;
  } else {
    seqOrigin = audio.currentTime + 0.05;
    seqUntil = 0;
    seqReported = -Infinity;
    seqTimer = window.setInterval(tickSequence, 25);
  }
  seq = s;
  tickSequence();
}

function stopSequence() {
  if (!seq) return;
  window.clearInterval(seqTimer);
  seq = null;
  if (audio) for (const o of seqSounding) o.stop(audio.currentTime + 0.05);
  void emit("lab-transport", { playing: false, beat: 0, bpm: 0 });
}

/** Where the mock "playhead" is along the timeline right now. */
function mockTimeline(): number {
  if (!playing) return 0;
  if (playing.paused) return playing.timeline;
  const p = playing.params;
  const length = (p.regionEnd ?? playing.duration) - (p.regionStart ?? 0);
  const t = playing.timeline + ((performance.now() - playing.at) / 1000) * p.rate;
  return playing.looping && length > 0 ? t % length : Math.min(t, length);
}

export function installMockBackend() {
  mockWindows("main");
  // Like the engine, report when a sample that isn't looping reaches its end (Play next waits for it).
  window.setInterval(() => {
    if (!playing || playing.paused || playing.looping) return;
    const p = playing.params;
    const length = (p.regionEnd ?? playing.duration) - (p.regionStart ?? 0);
    if (mockTimeline() < length) return;
    playing.timeline = length;
    playbackEvent("ended");
    playing = null;
  }, 50);
  mockIPC(
    (cmd, raw) => {
      const args = (raw ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case "list_sources":
          return SOURCES.map((s) => ({ ...s, count: ROWS.filter((r) => r.sourceId === s.id).length }));
        case "plugin:dialog|open":
          // Stands in for the folder picker, so adding folders can be tried in a browser.
          return (args.options as { directory?: boolean } | undefined)?.directory ? ["/Users/me/Music/Sample Stash"] : null;
        case "folder_candidates":
          return [...new Set(args.paths as string[])]
            .filter((p) => !SOURCES.some((s) => p === s.path || p.startsWith(`${s.path}/`)))
            .map((path) => ({ path, name: path.split("/").pop() ?? path, subfolders: MOCK_SUBFOLDERS }));
        case "list_subfolders":
          return ["808", "909", "LinnDrum"].map((name) => ({ name, hasChildren: false }));
        case "add_sources": {
          const exclude = (args.exclude ?? {}) as Record<string, string[]>;
          const ids: number[] = [];
          for (const path of args.paths as string[]) {
            if (SOURCES.some((s) => path === s.path || path.startsWith(`${s.path}/`))) continue;
            const id = Math.max(0, ...SOURCES.map((s) => s.id)) + 1;
            SOURCES.push({ id, path, name: path.split("/").pop() ?? path, online: true, count: 0, excluded: [...(exclude[path] ?? [])].sort() });
            ids.push(id);
          }
          return ids;
        }
        case "remove_source":
          SOURCES.splice(SOURCES.findIndex((s) => s.id === args.id), 1);
          applyExclusions();
          return null;
        case "set_dir_excluded": {
          const src = SOURCES.find((s) => s.id === args.sourceId)!;
          const dir = args.dir as string;
          src.excluded = src.excluded.filter((d) => d !== dir && !d.startsWith(`${dir}/`));
          if (args.excluded) src.excluded = [...src.excluded, dir].sort();
          applyExclusions();
          return null;
        }
        case "list_dirs": {
          const src = args.sourceId as number;
          const parent = args.dir as string;
          const kids = new Map<string, { count: number; deeper: boolean }>();
          for (const r of ROWS.filter((r) => r.sourceId === src && r.dir && (parent === "" || r.dir.startsWith(`${parent}/`)))) {
            const rest = parent ? r.dir.slice(parent.length + 1) : r.dir;
            const [child, ...more] = rest.split("/");
            const e = kids.get(child) ?? { count: 0, deeper: false };
            e.count++;
            e.deeper ||= more.length > 0;
            kids.set(child, e);
          }
          // Mirrors Db::dirs: numbers count by value, so "Take 2" comes before "Take 10".
          return [...kids.entries()]
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
            .map(([name, e]) => ({ name, dir: parent ? `${parent}/${name}` : name, count: e.count, hasChildren: e.deeper }));
        }
        case "query_samples":
          return query(args.request as QueryRequest);
        case "get_facets":
          return facets(args.filters as Filters);
        case "get_sample": {
          const r = ROWS.find((x) => x.id === args.id);
          return r ? { ...r } : null;
        }
        case "get_samples":
          return (args.ids as number[]).flatMap((id) => ROWS.filter((r) => r.id === id).map((r) => ({ ...r })));
        case "query_ids": {
          const filters = args.filters as Filters;
          if (!args.sort) return ROWS.filter((r) => matches(r, filters)).map((r) => r.id);
          const req = { filters, sort: args.sort, desc: args.desc, seed: args.seed, offset: 0, limit: ROWS.length } as QueryRequest;
          return query(req).rows.map((r) => r.id);
        }
        case "set_sample_values": {
          const rows = (args.ids as number[]).map((id) => ROWS.find((r) => r.id === id)).filter((r): r is SampleRow => r != null);
          for (const r of rows) setValues(r, args.tempo as TempoChange | null, args.key as KeyChange | null);
          return rows.map((r) => ({ ...r }));
        }
        case "excluded_names":
          return excludedNames;
        case "set_excluded_names": {
          const seen = new Set<string>();
          excludedNames = (args.names as string[]).map((n) => n.trim()).filter((n) => n && !/[/\\]/.test(n) && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
          applyExclusions();
          return excludedNames;
        }
        case "file_dates":
          return (args.ids as number[]).map((id) => ({ id, created: 1_727_000_000 + id * 86_400, modified: 1_727_000_000 + id * 90_000 }));
        case "rename_samples":
          return (args.renames as { id: number; name: string }[]).map(({ id, name }) => {
            const r = ROWS.find((x) => x.id === id);
            if (!r) return { id, from: "", to: name, error: "No longer in the library" };
            if (/[/\\:*?"<>|]/.test(name)) return { id, from: r.name, to: name, error: "Names can't contain / \\ : * ? \" < > |" };
            const from = r.name;
            r.path = r.path.replace(new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.\\w+)$`), `${name}$1`);
            r.name = name;
            return { id, from, to: name, error: null };
          });
        case "pitch_profile": {
          const r = ROWS.find((x) => x.id === args.id);
          return r ? mockProfile(r) : null;
        }
        case "library_stats":
          return {
            total: ROWS.length,
            favorites: ROWS.filter((r) => r.favorite).length,
            loops: ROWS.filter((r) => r.kind === "loop").length,
            oneshots: ROWS.filter((r) => r.kind === "oneshot").length,
            recentlyAdded: 24,
            played: ROWS.filter((r) => r.playCount > 0).length,
          };
        case "index_progress":
          return { scanning: false, found: 0, done: 812, total: 2400, watching: 3, refreshing: true };
        case "find_similar": {
          const target = ROWS.find((r) => r.id === args.id) ?? null;
          if (!target) return { target: null, items: [], described: ROWS.length, pending: 0, message: "Sample not found" };
          const items = similarTo((a) => position(target, a), target.kind, args.sourceId as number | null, args.aspect as string, target.id);
          return { target, items, described: ROWS.length, pending: 0, message: null };
        }
        case "similar_to_file":
        case "similar_to_recording":
        case "stop_recording": {
          window.clearInterval(recordTimer);
          const like = ROWS.find((r) => r.category === "Kick")!;
          return { target: null, items: similarTo((a) => position(like, a), null, args.sourceId as number | null, args.aspect as string), described: ROWS.length, pending: 0, message: null };
        }
        case "start_recording": {
          const started = performance.now();
          window.clearInterval(recordTimer);
          recordTimer = window.setInterval(() => {
            const seconds = (performance.now() - started) / 1000;
            void emit("record-level", { level: 0.05 + Math.abs(Math.sin(seconds * 7)) * 0.2, seconds, done: seconds >= 8 });
            if (seconds >= 8) window.clearInterval(recordTimer);
          }, 50);
          return null;
        }
        case "cancel_recording":
          window.clearInterval(recordTimer);
          return null;
        case "sound_map":
          return soundMap(args.kind as string | null, args.aspect as string);
        case "map_matches": {
          const ids = layouts.get(args.key as string);
          if (!ids) throw new Error("The sound map changed. Reload it.");
          const f = args.filters as Filters;
          const bits = new Uint8Array(Math.ceil(ids.length / 8));
          let matched = 0;
          ids.forEach((id, i) => {
            const r = ROWS.find((x) => x.id === id)!;
            if (matches(r, f)) {
              bits[i >> 3] |= 1 << (i & 7);
              matched++;
            }
          });
          return { bits: matched === ids.length ? null : b64(bits), matched };
        }
        case "set_window_mode":
          return null;
        case "set_ui_scale":
          // Stands in for the webview zoom.
          document.documentElement.style.zoom = String(args.scale);
          return null;
        case "set_favorite":
          for (const id of args.ids as number[]) {
            const r = ROWS.find((x) => x.id === id);
            if (r) r.favorite = args.favorite as boolean;
          }
          return null;
        case "set_user_tags": {
          const r = ROWS.find((x) => x.id === args.id)!;
          r.userTags = (args.tags as string[]).map((t) => t.toLowerCase());
          r.tags = [...new Set([...r.tags, ...r.userTags])];
          return r;
        }
        case "list_collections":
          return collections.map((c) => ({ ...c, count: members.get(c.id)?.size ?? 0 }));
        case "create_collection": {
          const id = collections.length + 1;
          collections.push({ id, name: args.name as string, color: args.color as string, count: 0 });
          members.set(id, new Set());
          return id;
        }
        case "add_to_collection":
          for (const id of args.ids as number[]) members.get(args.collectionId as number)?.add(id);
          return null;
        case "remove_from_collection":
          for (const id of args.ids as number[]) members.get(args.collectionId as number)?.delete(id);
          return null;
        case "sample_collections":
          return [...members.entries()].filter(([, s]) => s.has(args.id as number)).map(([c]) => c);
        case "play": {
          const r = ROWS.find((x) => x.id === args.id)!;
          r.playCount++;
          const params = args.params as MockParams;
          const start = args.start as number | null;
          const rs = params.regionStart ?? 0;
          const re = params.regionEnd ?? r.duration ?? 1;
          const timeline = start == null ? 0 : params.reverse ? re - start : start - rs;
          playing = { id: r.id, duration: r.duration ?? 1, looping: args.looping as boolean, params, timeline: Math.max(0, timeline), at: performance.now(), paused: false };
          setTimeout(() => playbackEvent("playing"), 30);
          return null;
        }
        case "set_params":
          if (playing) {
            playing.timeline = mockTimeline();
            playing.at = performance.now();
            playing.params = args.params as MockParams;
            playbackEvent(playing.paused ? "paused" : "playing");
          }
          return null;
        case "stop":
          playing = null;
          return null;
        case "set_loop":
          if (playing) {
            playing.timeline = mockTimeline();
            playing.at = performance.now();
            playing.looping = args.looping as boolean;
          }
          return null;
        case "pause":
          if (playing) {
            playing.timeline = mockTimeline();
            playing.paused = true;
            playbackEvent("paused");
          }
          return null;
        case "resume":
          if (playing) {
            playing.at = performance.now();
            playing.paused = false;
            playbackEvent("playing");
          }
          return null;
        case "seek":
          if (playing) {
            const p = playing.params;
            const rs = p.regionStart ?? 0;
            const re = p.regionEnd ?? playing.duration;
            const t = Math.min(re, Math.max(rs, args.position as number));
            playing.timeline = p.reverse ? re - t : t - rs;
            playing.at = performance.now();
            playbackEvent(playing.paused ? "paused" : "playing");
          }
          return null;
        case "play_notes":
          mockNotes(args.notes as { note: number; at?: number; length: number; velocity?: number }[], args.preset as string);
          return null;
        case "stop_notes":
          if (audio) for (const o of sounding) o.stop(audio.currentTime + 0.05);
          return null;
        case "play_sequence":
          playSequence(args.sequence as MockSequence);
          return null;
        case "stop_sequence":
          stopSequence();
          return null;
        case "set_click":
          clickOn = Boolean(args.on);
          return null;
        case "save_midi":
          return `/Users/me/Music/Saga/Renders/${args.name} (${args.label}).mid`;
        case "render_sample": {
          const dir = args.keep ? "/Users/me/Music/Saga/Renders" : "/Users/me/Library/Caches/saga/renders";
          return new Promise((resolve) => setTimeout(() => resolve(`${dir}/${args.label || "render"}.wav`), 200));
        }
        case "renders_usage":
          return mockUsage();
        case "clear_renders": {
          const days = args.olderThanDays as number | null;
          const gone = mockRenders.filter((r) => days == null || r.days > days);
          mockRenders = mockRenders.filter((r) => !gone.includes(r));
          mockScratchBytes = 0;
          return { cleared: { files: gone.length, bytes: gone.reduce((a, r) => a + r.bytes, 0) }, failed: 0, usage: mockUsage() };
        }
        case "save_variation":
          return `/Users/me/Music/Saga/Variations/${args.label}.wav`;
        case "waveform_detail": {
          const r = ROWS.find((x) => x.id === args.id)!;
          const env = Uint8Array.from(atob(r.peaks!), (c) => c.charCodeAt(0));
          const d = r.duration ?? 1;
          const n = args.buckets as number;
          const a = (args.start as number) / d;
          const b = (args.end as number) / d;
          const channel = (wobble: number) => {
            const out = new Uint8Array(n);
            for (let i = 0; i < n; i++) {
              const f = a + ((b - a) * (i + 0.5)) / n;
              const v = env[Math.min(511, Math.floor(f * 512))];
              out[i] = Math.min(255, Math.round(v * (0.85 + 0.15 * Math.abs(Math.sin(i * 0.37 + wobble)))));
            }
            return b64(out);
          };
          return { channels: r.channels === 1 ? [channel(0)] : [channel(0), channel(1.3)], duration: d };
        }
        case "list_installed_fonts":
          // Families that ship with macOS, so the preview can draw them.
          return [
            ["American Typewriter", false], ["Andale Mono", true], ["Apple Color Emoji", false], ["Arial", false], ["Avenir", false],
            ["Avenir Next", false], ["Baskerville", false], ["Courier New", true], ["Didot", false], ["Futura", false],
            ["Georgia", false], ["Gill Sans", false], ["Helvetica", false], ["Helvetica Neue", false], ["Menlo", true],
            ["Monaco", true], ["Optima", false], ["PT Mono", true], ["PT Sans", false], ["Rockwell", false],
            ["Times New Roman", false], ["Trebuchet MS", false], ["Verdana", false],
          ].map(([family, mono]) => ({ family, mono }));
        case "list_output_devices":
          return { devices: ["MacBook Pro Speakers", "Audio Interface"], current: null };
        case "drag_icon":
          return "/tmp/drag.png";
        case "saved_sounds_dir":
          return { path: savedSounds ?? "/Users/me/Music/Saga", isDefault: savedSounds == null };
        case "set_saved_sounds_dir":
          savedSounds = (args.path as string | null) ?? null;
          return { path: savedSounds ?? "/Users/me/Music/Saga", isDefault: savedSounds == null };
        case "suggested_folders":
          return [];
        case "plugin:app|version":
          return "0.1.0";
        case "plugin:opener|open_url":
          window.open(String(args.url), "_blank", "noopener");
          return null;
        case "plugin:updater|check":
          // null: no update. Return { rid: 1, currentVersion: "0.1.0", version: "0.2.0", rawJson: {} } to see the flow.
          return null;
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}
