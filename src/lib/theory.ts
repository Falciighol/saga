// Scales, note spelling and chords for the Lab. The one source of truth on the frontend; the Rust
// side only needs a scale's intervals (see `KeyFilter.scale` and `fitting_keys` in keys.rs).

export type ScaleFamily = "modes" | "minor" | "pent" | "sym" | "world";

export interface Scale {
  id: string;
  name: string;
  /** Another common name. */
  alt?: string;
  family: ScaleFamily;
  /** Closest major (0) or minor (1) key, judged by the third. Used for Match key and Camelot codes. */
  mode: 0 | 1;
  /** Semitones above the root. */
  steps: number[];
  /** One line on how it sounds and where it's used. */
  feel: string;
}

export const FAMILIES: { id: ScaleFamily; label: string }[] = [
  { id: "modes", label: "Diatonic modes" },
  { id: "minor", label: "Minor variants" },
  { id: "pent", label: "Pentatonic & blues" },
  { id: "sym", label: "Symmetric" },
  { id: "world", label: "World & colour" },
];

const s = (id: string, name: string, family: ScaleFamily, mode: 0 | 1, steps: number[], feel: string, alt?: string): Scale => ({ id, name, alt, family, mode, steps, feel });

export const SCALES: Scale[] = [
  s("ionian", "Major", "modes", 0, [0, 2, 4, 5, 7, 9, 11], "Bright and settled. Most pop and dance music.", "Ionian"),
  s("dorian", "Dorian", "modes", 1, [0, 2, 3, 5, 7, 9, 10], "Minor with a lifted 6th. Soulful, funky, house chords."),
  s("phrygian", "Phrygian", "modes", 1, [0, 1, 3, 5, 7, 8, 10], "Dark, tense ♭2. Techno, metal, flamenco colour."),
  s("lydian", "Lydian", "modes", 0, [0, 2, 4, 6, 7, 9, 11], "Major with a floating ♯4. Dreamy, cinematic."),
  s("mixolydian", "Mixolydian", "modes", 0, [0, 2, 4, 5, 7, 9, 10], "Major with a ♭7. Rock, funk, festival anthems."),
  s("aeolian", "Minor", "modes", 1, [0, 2, 3, 5, 7, 8, 10], "Natural minor. Moody, the default for trap and techno.", "Aeolian"),
  s("locrian", "Locrian", "modes", 1, [0, 1, 3, 5, 6, 8, 10], "Unstable ♭5, no real home. Use it for tension."),
  s("harmonic-minor", "Harmonic minor", "minor", 1, [0, 2, 3, 5, 7, 8, 11], "Minor with a leading tone. Drill, classical, an eastern edge."),
  s("melodic-minor", "Melodic minor", "minor", 1, [0, 2, 3, 5, 7, 9, 11], "Minor below, major above. Jazz, neo-soul."),
  s("phrygian-dominant", "Phrygian dominant", "minor", 0, [0, 1, 4, 5, 7, 8, 10], "♭2 with a major 3rd. Middle Eastern, flamenco, drill leads."),
  s("dorian-s4", "Dorian ♯4", "minor", 1, [0, 2, 3, 6, 7, 9, 10], "Dorian with a raised 4th. Klezmer, folk.", "Ukrainian Dorian"),
  s("lydian-dominant", "Lydian dominant", "minor", 0, [0, 2, 4, 6, 7, 9, 10], "♯4 and ♭7. Bright but bluesy, video game themes."),
  s("mixolydian-b6", "Mixolydian ♭6", "minor", 0, [0, 2, 4, 5, 7, 8, 10], "Starts major, ends minor. Bittersweet."),
  s("locrian-n2", "Locrian ♮2", "minor", 1, [0, 2, 3, 5, 6, 8, 10], "Half-diminished sound. Dark jazz."),
  s("altered", "Altered", "minor", 0, [0, 1, 3, 4, 6, 8, 10], "Every tension at once. Played over a dominant chord."),
  s("major-pent", "Major pentatonic", "pent", 0, [0, 2, 4, 7, 9], "Five safe notes. Hooks that can't clash."),
  s("minor-pent", "Minor pentatonic", "pent", 1, [0, 3, 5, 7, 10], "The riff scale. Hip-hop, rock, basslines."),
  s("minor-blues", "Blues", "pent", 1, [0, 3, 5, 6, 7, 10], "Minor pentatonic plus the ♭5 blue note."),
  s("major-blues", "Major blues", "pent", 0, [0, 2, 3, 4, 7, 9], "Major pentatonic with a ♭3 slide. Gospel, soul."),
  s("sus-pent", "Suspended pentatonic", "pent", 1, [0, 2, 5, 7, 10], "No thirds, neither major nor minor. Open, modal.", "Egyptian"),
  s("whole-tone", "Whole tone", "sym", 0, [0, 2, 4, 6, 8, 10], "All whole steps. Dream sequences, weightless."),
  s("dim-hw", "Diminished (half-whole)", "sym", 0, [0, 1, 3, 4, 6, 7, 9, 10], "Over dominant chords. Tense, cinematic."),
  s("dim-wh", "Diminished (whole-half)", "sym", 1, [0, 2, 3, 5, 6, 8, 9, 11], "Over diminished chords. Horror, suspense."),
  s("augmented", "Augmented", "sym", 0, [0, 3, 4, 7, 8, 11], "Two augmented triads. Glassy and strange."),
  s("harmonic-major", "Harmonic major", "world", 0, [0, 2, 4, 5, 7, 8, 11], "Major with a ♭6. Film scores, a melancholy lift."),
  s("double-harmonic", "Double harmonic", "world", 0, [0, 1, 4, 5, 7, 8, 11], "Two augmented seconds. Arabic, exotic leads.", "Byzantine"),
  s("hungarian-minor", "Hungarian minor", "world", 1, [0, 2, 3, 6, 7, 8, 11], "Harmonic minor with a ♯4. Dramatic, gypsy jazz."),
  s("neapolitan-minor", "Neapolitan minor", "world", 1, [0, 1, 3, 5, 7, 8, 11], "Harmonic minor with a ♭2. Operatic, dark."),
  s("neapolitan-major", "Neapolitan major", "world", 1, [0, 1, 3, 5, 7, 9, 11], "Melodic minor with a ♭2. Unusual, luminous."),
  s("persian", "Persian", "world", 0, [0, 1, 4, 5, 6, 8, 11], "♭2, ♭5 and ♭6 with a major 3rd. Very dense colour."),
  s("hirajoshi", "Hirajoshi", "world", 1, [0, 2, 3, 7, 8], "Japanese pentatonic. Koto, lo-fi melodies."),
  s("in-sen", "In-sen", "world", 1, [0, 1, 5, 7, 10], "Japanese, with a ♭2. Sparse and haunting."),
  s("iwato", "Iwato", "world", 1, [0, 1, 5, 6, 10], "Japanese, the darkest of the three. Ambient, horror."),
  s("kumoi", "Kumoi", "world", 1, [0, 2, 3, 7, 9], "Minor pentatonic with a 6th. Gentle, wistful."),
  s("bebop-dominant", "Bebop dominant", "world", 0, [0, 2, 4, 5, 7, 9, 10, 11], "Mixolydian plus a passing 7th, so lines land on the beat."),
  s("bebop-major", "Bebop major", "world", 0, [0, 2, 4, 5, 7, 8, 9, 11], "Major plus a passing ♭6. Walking lines."),
  s("enigmatic", "Enigmatic", "world", 0, [0, 1, 4, 6, 8, 10, 11], "Verdi's puzzle scale. Unresolved, eerie."),
];

const BY_ID = new Map(SCALES.map((x) => [x.id, x]));

export function scaleById(id: string | null | undefined): Scale | undefined {
  return id ? BY_ID.get(id) : undefined;
}

export function scaleBySteps(steps: number[] | null | undefined): Scale | undefined {
  if (!steps?.length) return undefined;
  return SCALES.find((x) => x.steps.length === steps.length && x.steps.every((v, i) => v === steps[i]));
}

/** The plain major or minor scale, for keys picked on the key wheel. */
export function plainScale(mode: 0 | 1): Scale {
  return BY_ID.get(mode === 1 ? "aeolian" : "ionian")!;
}

/** Major and minor are shown as "A min", other scales by name. */
export function isPlain(scale: Scale): boolean {
  return scale.id === "ionian" || scale.id === "aeolian";
}

/** Modes from brightest to darkest. */
export const MODE_BRIGHTNESS = ["lydian", "ionian", "mixolydian", "dorian", "aeolian", "phrygian", "locrian"];

const mod = (n: number, m: number) => ((n % m) + m) % m;

const SHARPS = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const FLATS = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];

/** How a root is written: flats, except C♯ and G♯ minor, which are far more common than D♭ and A♭ minor. */
export function rootName(pc: number, mode: 0 | 1): string {
  const p = mod(pc, 12);
  if (p === 1) return mode === 1 ? "C♯" : "D♭";
  if (p === 8) return mode === 1 ? "G♯" : "A♭";
  return ["C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"][p];
}

export function sharpName(pc: number): string {
  return SHARPS[mod(pc, 12)];
}

export function scaleLabel(pc: number, scale: Scale): string {
  return `${rootName(pc, scale.mode)} ${scale.name}`;
}

const LETTERS = "CDEFGAB";
const NATURAL = [0, 2, 4, 5, 7, 9, 11];
const ACCIDENTAL: Record<number, string> = { [-2]: "𝄫", [-1]: "♭", 0: "", 1: "♯", 2: "𝄪" };

/** Note names for a scale: one letter per degree for seven-note scales, otherwise the key's sharps or flats. */
export function spell(pc: number, scale: Scale): string[] {
  const root = rootName(pc, scale.mode);
  if (scale.steps.length === 7) {
    const first = LETTERS.indexOf(root[0]);
    return scale.steps.map((iv, i) => {
      const letter = (first + i) % 7;
      const note = mod(pc + iv, 12);
      return LETTERS[letter] + ACCIDENTAL[mod(note - NATURAL[letter] + 6, 12) - 6];
    });
  }
  const sharps = root.includes("♯") || (scale.mode === 0 && [7, 2, 9, 4, 11].includes(mod(pc, 12)));
  return scale.steps.map((iv, i) => (i === 0 ? root : (sharps ? SHARPS : FLATS)[mod(pc + iv, 12)]));
}

/** A degree's name relative to the root: "1", "♭3", "♯4"… */
export function degreeName(iv: number, steps: number[]): string {
  if (iv === 6) return steps.includes(5) ? "♭5" : "♯4";
  if (iv === 8) return steps.includes(7) ? "♭6" : "♯5";
  return ["1", "♭2", "2", "♭3", "3", "4", "", "5", "", "6", "♭7", "7"][mod(iv, 12)];
}

const PARENT: Record<0 | 1, number[]> = { 0: [0, 2, 4, 5, 7, 9, 11], 1: [0, 2, 3, 5, 7, 8, 10] };

/** Degrees (indexes into `steps`) that set a seven-note scale apart from plain major or minor. */
export function colourDegrees(scale: Scale): number[] {
  if (scale.steps.length !== 7) return [];
  const p = PARENT[scale.mode];
  return scale.steps.flatMap((iv, i) => (iv !== p[i] ? [i] : []));
}

export function scaleNotes(pc: number, steps: number[]): number[] {
  return [...new Set(steps.map((iv) => mod(pc + iv, 12)))];
}

const MAJOR_STEPS = PARENT[0];
const MINOR_STEPS = PARENT[1];

/**
 * Major and minor keys whose notes hold the scale: every note of a scale of five notes or fewer,
 * all but one of a longer one. Mirrors `fitting_keys` in src-tauri/src/keys.rs.
 */
export function fittingKeys(pc: number, steps: number[]): { pc: number; mode: 0 | 1 }[] {
  const notes = scaleNotes(pc, steps);
  const need = notes.length <= 5 ? notes.length : Math.min(7, notes.length - 1);
  const out: { pc: number; mode: 0 | 1 }[] = [];
  for (let p = 0; p < 12; p++) {
    for (const mode of [0, 1] as const) {
      const key = scaleNotes(p, mode === 1 ? MINOR_STEPS : MAJOR_STEPS);
      if (notes.filter((n) => key.includes(n)).length >= need) out.push({ pc: p, mode });
    }
  }
  return out;
}

export type HarmonicFunction = "tonic" | "subdominant" | "dominant";

export interface Chord {
  /** Semitones from the scale's root to the chord's root. */
  iv: number;
  /** "", "m", "°", "+", "sus2", "sus4", "maj7", "7", "m7", "ø7", "°7"… */
  quality: string;
  /** Semitones above the chord's root. */
  tones: number[];
  name: string;
  roman: string;
  fn: HarmonicFunction;
  notes: string[];
}

const TRIADS: [string, number[]][] = [
  ["", [4, 7]],
  ["m", [3, 7]],
  ["°", [3, 6]],
  ["+", [4, 8]],
  ["sus4", [5, 7]],
  ["sus2", [2, 7]],
];
const SEVENTHS: [string, number[]][] = [
  ["maj7", [4, 7, 11]],
  ["7", [4, 7, 10]],
  ["m7", [3, 7, 10]],
  ["ø7", [3, 6, 10]],
  ["°7", [3, 6, 9]],
  ["m(maj7)", [3, 7, 11]],
  ["+maj7", [4, 8, 11]],
  ["7sus4", [5, 7, 10]],
];
/** Every chord quality the Lab plays, as semitones above the chord's root. */
export const QUALITIES: Record<string, number[]> = Object.fromEntries([...TRIADS, ...SEVENTHS].map(([q, v]) => [q, [0, ...v]]));
const NUMERALS = ["I", "♭II", "II", "♭III", "III", "IV", "♯IV", "V", "♭VI", "VI", "♭VII", "VII"];

/** Roman numeral for a chord `iv` semitones above the key's root: lower case for minor and diminished. */
export function romanNumeral(iv: number, quality: string, steps: number[]): string {
  let n = NUMERALS[mod(iv, 12)];
  if (mod(iv, 12) === 6 && steps.includes(5)) n = "♭V";
  const lower = (quality.startsWith("m") && !quality.startsWith("maj")) || quality.startsWith("°") || quality.startsWith("ø");
  const suffix = quality === "m" ? "" : quality === "m7" ? "7" : quality === "m(maj7)" ? "(maj7)" : quality;
  return (lower ? n.toLowerCase() : n) + suffix;
}

function functionOf(iv: number, degree: number | null): HarmonicFunction {
  if (degree != null) return [0, 2, 5].includes(degree) ? "tonic" : [1, 3].includes(degree) ? "subdominant" : "dominant";
  const i = mod(iv, 12);
  return [0, 3, 4, 8, 9].includes(i) ? "tonic" : [1, 2, 5].includes(i) ? "subdominant" : "dominant";
}

/**
 * Chords that stay inside the scale. Seven-note scales stack thirds on each degree; other scales
 * get up to two triads or sus chords per note whose tones all fit.
 */
export function scaleChords(pc: number, scale: Scale, sevenths: boolean): Chord[] {
  const st = scale.steps;
  const names = spell(pc, scale);
  const nameOf = (iv: number) => names[st.indexOf(mod(iv, 12))] ?? sharpName(pc + iv);
  if (st.length === 7) {
    return st.map((iv, i) => {
      const at = (k: number) => st[(i + k) % 7] + (i + k >= 7 ? 12 : 0);
      const ivs = [at(2) - iv, at(4) - iv, ...(sevenths ? [at(6) - iv] : [])];
      const table = sevenths ? SEVENTHS : TRIADS;
      const quality = table.find(([, v]) => v.every((x, k) => x === ivs[k]))?.[0] ?? `(${ivs.join(",")})`;
      const tones = [0, ...ivs];
      return {
        iv,
        quality,
        tones,
        name: names[i] + quality,
        roman: romanNumeral(iv, quality, st),
        fn: functionOf(iv, i),
        notes: tones.map((t) => nameOf(iv + t)),
      };
    });
  }
  const out: Chord[] = [];
  for (const iv of st) {
    let found = 0;
    for (const [quality, v] of TRIADS) {
      if (found === 2) break;
      if (!v.every((x) => st.includes(mod(iv + x, 12)))) continue;
      found++;
      const tones = [0, ...v];
      out.push({ iv, quality, tones, name: nameOf(iv) + quality, roman: romanNumeral(iv, quality, st), fn: functionOf(iv, null), notes: tones.map((t) => nameOf(iv + t)) });
    }
  }
  return out.slice(0, 10);
}

/** Letters above a chord's root for each of its tones: the 3rd is two letters up, the 5th four… */
const LETTER_STEPS: Record<number, number> = { 0: 0, 2: 1, 3: 2, 4: 2, 5: 3, 6: 4, 7: 4, 8: 4, 9: 6, 10: 6, 11: 6 };

/** A chord's notes spelled up from its root name, so A♭ major is A♭ C E♭ rather than G♯ C D♯. */
function spellChord(rootName: string, rootPc: number, tones: number[]): string[] {
  const first = LETTERS.indexOf(rootName[0]);
  return tones.map((t) => {
    const letter = (first + (LETTER_STEPS[t] ?? 0)) % 7;
    const note = mod(rootPc + t, 12);
    const acc = ACCIDENTAL[mod(note - NATURAL[letter] + 6, 12) - 6];
    return acc == null ? sharpName(note) : LETTERS[letter] + acc;
  });
}

/**
 * Any chord on any root of the key, whether or not it's in the scale: a chord of the palette, a
 * borrowed one, or one from a preset. `iv` is semitones from the key's root.
 */
export function chordAt(pc: number, scale: Scale, iv: number, quality: string): Chord {
  const st = scale.steps;
  const at = mod(iv, 12);
  const degree = st.indexOf(at);
  const tones = QUALITIES[quality] ?? QUALITIES[""];
  const root = degree >= 0 ? spell(pc, scale)[degree] : FLATS[mod(pc + at, 12)];
  return {
    iv: at,
    quality,
    tones,
    name: root + quality,
    roman: romanNumeral(at, quality, st),
    fn: functionOf(at, degree >= 0 && st.length === 7 ? degree : null),
    notes: spellChord(root, pc + at, tones),
  };
}

/** Every note of the chord is in the scale. */
export function inScale(scale: Scale, chord: Pick<Chord, "iv" | "tones">): boolean {
  return chord.tones.every((t) => scale.steps.includes(mod(chord.iv + t, 12)));
}

export interface Borrowed extends Chord {
  /** Where it comes from: "from minor", "Neapolitan", "V of V"… */
  source: string;
}

/** Chords from outside the scale that producers reach for, by whether the key is major or minor. */
const BORROWED: Record<0 | 1, [number, string, string][]> = {
  0: [
    [5, "m", "from minor"],
    [8, "", "from minor"],
    [10, "", "from minor"],
    [3, "", "from minor"],
    [2, "", "V of V"],
    [4, "", "V of vi"],
  ],
  1: [
    [7, "", "harmonic minor"],
    [5, "", "from Dorian"],
    [1, "", "Neapolitan"],
    [0, "", "Picardy third"],
    [2, "7", "V of V"],
  ],
};

/** Borrowed and secondary chords that aren't already in the scale. */
export function borrowedChords(pc: number, scale: Scale): Borrowed[] {
  return BORROWED[scale.mode]
    .map(([iv, quality, source]) => ({ ...chordAt(pc, scale, iv, quality), source }))
    .filter((c) => !inScale(scale, c));
}

export interface Related {
  pc: number;
  scale: Scale;
  /** Why it's related: "same notes", "parallel", or the note that changes ("6 → ♭6"). */
  why: string;
}

const MODE_OFFSET: Record<string, number> = { ionian: 0, dorian: 2, phrygian: 4, lydian: 5, mixolydian: 7, aeolian: 9, locrian: 11 };

/** The parent key and parallel key of a mode, and scales of the same size one note away on the same root. */
export function relatedScales(pc: number, scale: Scale): Related[] {
  const mine = scaleNotes(pc, scale.steps);
  const out: Related[] = [];
  if (scale.id in MODE_OFFSET) {
    if (scale.id === "ionian") out.push({ pc: mod(pc + 9, 12), scale: BY_ID.get("aeolian")!, why: "same notes" });
    else out.push({ pc: mod(pc - MODE_OFFSET[scale.id], 12), scale: BY_ID.get("ionian")!, why: "same notes" });
    out.push({ pc, scale: plainScale(scale.mode === 1 ? 0 : 1), why: "parallel" });
  }
  for (const other of SCALES) {
    if (other.id === scale.id || other.steps.length !== scale.steps.length) continue;
    const theirs = scaleNotes(pc, other.steps);
    if (theirs.filter((n) => mine.includes(n)).length !== mine.length - 1) continue;
    const added = theirs.find((n) => !mine.includes(n))!;
    const dropped = mine.find((n) => !theirs.includes(n))!;
    out.push({ pc, scale: other, why: `${degreeName(mod(dropped - pc, 12), scale.steps)} → ${degreeName(mod(added - pc, 12), other.steps)}` });
  }
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.pc}:${r.scale.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** MIDI note for a pitch class in the octave starting at C3, where the Lab plays from. */
export function noteFrom(pc: number, iv: number, octave = 3): number {
  return 12 * (octave + 1) + mod(pc, 12) + iv;
}

// ---- listening: pitch profiles, key finding, tuning ----

/**
 * How well a pitch profile (12 values, C first) sits inside a scale: 0 when no more of its energy
 * falls on the scale's notes than would on any notes of the same count (a noise burst), 1 when all
 * of it does. Null for a silent profile. Mirrors `scale_fit` in src-tauri/src/keys.rs, which the
 * "notes fit" filter and the fit sort use.
 */
export function scaleFit(chroma: number[], pc: number, steps: number[]): number | null {
  const notes = scaleNotes(pc, steps);
  const total = chroma.reduce((a, b) => a + b, 0);
  if (!(total > 0) || !notes.length) return null;
  if (notes.length >= 12) return 1;
  const inside = notes.reduce((a, n) => a + chroma[n], 0) / total;
  const chance = notes.length / 12;
  return Math.max(0, Math.min(1, (inside - chance) / (1 - chance)));
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/**
 * A scale's notes weighted the way music leans on them: the root most, then the fifth and a minor
 * third. For major and minor these are the key profiles in src-tauri/src/detect.rs.
 */
function template(pc: number, scale: Scale): number[] {
  return Array.from({ length: 12 }, (_, n) => {
    const iv = mod(n - pc, 12);
    if (!scale.steps.includes(iv)) return 0;
    return iv === 0 ? 2 : iv === 7 || iv === 3 ? 1.5 : 1;
  });
}

/** Scales people reach for most, so among scales that fit about as well the familiar one comes first. */
const COMMON: Record<string, number> = {
  "minor-pent": 0.6,
  "major-pent": 0.5,
  dorian: 0.45,
  mixolydian: 0.35,
  "harmonic-minor": 0.35,
  phrygian: 0.3,
  "minor-blues": 0.3,
};
const COMMON_WEIGHT = 0.15;

export interface KeyMatch {
  pc: number;
  scale: Scale;
  /** Correlation of the profile with the scale's weighted notes (Pearson r, up to 1). */
  score: number;
}

function rank(chroma: number[], scales: Scale[], prior: number): KeyMatch[] {
  const out: KeyMatch[] = [];
  for (const scale of scales) {
    for (let pc = 0; pc < 12; pc++) {
      out.push({ pc, scale, score: pearson(chroma, template(pc, scale)) + prior * (COMMON[scale.id] ?? 0) });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * The major and minor keys whose profiles best match a pitch profile, as src-tauri/src/detect.rs
 * ranks them. On loops from real packs whose names state a key, the stated key is first about a
 * third of the time and in the top four three times in four (see `detect::report::scale_fit_report`).
 */
export function rankKeys(chroma: number[], limit = 4): KeyMatch[] {
  return rank(chroma, [plainScale(0), plainScale(1)], 0).slice(0, limit);
}

/** The other scales (modes, pentatonics, colour scales) on any root that fit a pitch profile best. */
export function rankScales(chroma: number[], limit = 5): KeyMatch[] {
  return rank(
    chroma,
    SCALES.filter((x) => !isPlain(x)),
    COMMON_WEIGHT,
  ).slice(0, limit);
}

/**
 * Semitones from a sound's root to the next place the scale allows, up (`dir` 1) or down (−1).
 * A lone root note (`mode` 2) steps along the scale's notes; a major or minor key (0 or 1) steps to
 * the next transposition whose key fits the scale, so a loop's harmony stays inside it. Null when
 * nothing within an octave fits.
 */
export function scaleStep(root: number, mode: 0 | 1 | 2, pc: number, steps: number[], dir: 1 | -1): number | null {
  const notes = scaleNotes(pc, steps);
  const keys = mode === 2 ? [] : fittingKeys(pc, steps);
  for (let d = 1; d <= 12; d++) {
    const t = mod(root + dir * d, 12);
    if (mode === 2 ? notes.includes(t) : keys.some((k) => k.pc === t && k.mode === mode)) return dir * d;
  }
  return null;
}

/** Frequency of a MIDI note with A4 tuned to `ref` Hz. */
export function noteHz(midi: number, ref = 440): number {
  return ref * 2 ** ((midi - 69) / 12);
}

/** The MIDI note (with a fraction for cents) that sounds at `hz`, A4 at 440. */
export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

/** "A1", "C♯4": a MIDI note's name with its octave (C4 is middle C). */
export function noteLabel(midi: number): string {
  const m = Math.round(midi);
  return `${sharpName(m)}${Math.floor(m / 12) - 1}`;
}
