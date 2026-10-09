// The palette lives here (not in CSS) so canvas waveforms can use the exact same colors.

export type ThemePref = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";
export type Accent = "violet" | "blue" | "mint" | "lime" | "amber" | "coral";

export const ACCENTS: Record<Accent, { label: string; hex: string }> = {
  violet: { label: "Violet", hex: "#9D8CFF" },
  blue: { label: "Blue", hex: "#6FA6FF" },
  mint: { label: "Mint", hex: "#4FD1A5" },
  lime: { label: "Lime", hex: "#B8E65A" },
  amber: { label: "Amber", hex: "#F2B544" },
  coral: { label: "Coral", hex: "#FF7A5C" },
};

export const ACCENT_ORDER: Accent[] = ["violet", "blue", "mint", "lime", "amber", "coral"];

interface Base {
  bg: string;
  panel: string;
  raised: string;
  raised2: string;
  seg: string;
  line: string;
  line2: string;
  text: string;
  text2: string;
  text3: string;
  wave: string;
  wave2: string;
  overlay: string;
  shadow: string;
  /** Recording, and only recording: the Record button, the REC dot, a take being written. A cooler,
   *  deeper red than the Coral accent and the red of destructive actions, so it reads as "recording"
   *  next to every accent. */
  rec: string;
  /** `rec` as a quiet fill, for the armed ring. */
  recSoft: string;
  /** Marks drawn on `rec`, such as the stop square. */
  onRec: string;
}

const GRAPHITE_DARK: Base = {
  bg: "#0F1012",
  panel: "#131417",
  raised: "#1B1D21",
  raised2: "#25282D",
  seg: "#2C3036",
  line: "#222529",
  line2: "#31353B",
  text: "#ECEAE6",
  text2: "#A6A9AF",
  text3: "#868A91",
  wave: "#4A4F57",
  wave2: "#747981",
  overlay: "rgba(6, 7, 8, 0.6)",
  shadow: "0 18px 48px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04)",
  rec: "#F0444F",
  recSoft: "rgba(240, 68, 79, 0.16)",
  onRec: "#FFFFFF",
};

const GRAPHITE_LIGHT: Base = {
  bg: "#F2F1ED",
  panel: "#FAF9F6",
  raised: "#ECEAE4",
  raised2: "#E2DFD7",
  seg: "#FFFFFF",
  line: "#E4E1DA",
  line2: "#D0CCC3",
  text: "#1B1B19",
  text2: "#56554F",
  text3: "#6C6A64",
  wave: "#C4C0B6",
  wave2: "#8F8A80",
  overlay: "rgba(40, 36, 28, 0.28)",
  shadow: "0 18px 48px rgba(40, 30, 10, 0.16), 0 0 0 1px rgba(0, 0, 0, 0.05)",
  rec: "#D42536",
  recSoft: "rgba(212, 37, 54, 0.14)",
  onRec: "#FFFFFF",
};

export interface Palette extends Base {
  accent: string;
  /** Accent for text and icons; darkened on light backgrounds for contrast. */
  accentInk: string;
  /** Accent for waveforms and meters. */
  accentWave: string;
  onAccent: string;
  accentSoft: string;
}

function mix(hex: string, toward: [number, number, number], amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v, i) => Math.round(v + (toward[i] - v) * amount));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function palette(theme: ResolvedTheme, accent: Accent): Palette {
  const base = theme === "dark" ? GRAPHITE_DARK : GRAPHITE_LIGHT;
  const a = ACCENTS[accent].hex;
  return {
    ...base,
    accent: a,
    accentInk: theme === "dark" ? a : mix(a, [0, 0, 0], 0.5),
    accentWave: theme === "dark" ? a : mix(a, [0, 0, 0], 0.22),
    onAccent: "#131018",
    accentSoft: alpha(a, theme === "dark" ? 0.14 : 0.18),
  };
}

const VAR_NAMES: Record<keyof Palette, string> = {
  bg: "--bg",
  panel: "--panel",
  raised: "--raised",
  raised2: "--raised2",
  seg: "--seg",
  line: "--line",
  line2: "--line2",
  text: "--text",
  text2: "--text2",
  text3: "--text3",
  wave: "--wave",
  wave2: "--wave2",
  overlay: "--overlay",
  shadow: "--shadow",
  rec: "--rec",
  recSoft: "--rec-soft",
  onRec: "--on-rec",
  accent: "--accent",
  accentInk: "--accent-ink",
  accentWave: "--accent-wave",
  onAccent: "--on-accent",
  accentSoft: "--accent-soft",
};

export function applyPalette(p: Palette, theme: ResolvedTheme) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(VAR_NAMES)) {
    root.style.setProperty(v, p[k as keyof Palette]);
  }
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/** Colors offered for collections; distinct in lightness as well as hue. */
export const COLLECTION_COLORS = [
  { name: "Amber", hex: "#D9A441" },
  { name: "Blue", hex: "#6FA3D8" },
  { name: "Violet", hex: "#B887D6" },
  { name: "Green", hex: "#5DBB8A" },
  { name: "Coral", hex: "#E07C6A" },
  { name: "Grey", hex: "#9AA0A8" },
];
