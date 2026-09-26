// Fonts are bundled (imported in index.css) so they work offline and look the same on every machine.
// "System" uses the OS font instead, and "installed" any family installed on this computer.

import { isMac } from "./platform";

export type SansFont = "instrument" | "inter" | "geist" | "plex" | "dm" | "manrope" | "atkinson" | "system";
export type MonoFont = "geist-mono" | "jetbrains" | "plex-mono" | "system";
/** A bundled font, or "installed" for the family chosen from the ones installed on this computer. */
export type SansChoice = SansFont | "installed";
export type MonoChoice = MonoFont | "installed";

interface FontDef {
  label: string;
  /** Full name, when the label is shortened. */
  title?: string;
  stack: string;
}

const SANS_FALLBACK = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
const MONO_FALLBACK = `ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace`;

export const SANS_FONTS: Record<SansFont, FontDef> = {
  instrument: { label: "Instrument Sans", stack: `"Instrument Sans Variable", ${SANS_FALLBACK}` },
  inter: { label: "Inter", stack: `"Inter Variable", ${SANS_FALLBACK}` },
  geist: { label: "Geist", stack: `"Geist Variable", ${SANS_FALLBACK}` },
  plex: { label: "IBM Plex Sans", stack: `"IBM Plex Sans Variable", ${SANS_FALLBACK}` },
  dm: { label: "DM Sans", stack: `"DM Sans Variable", ${SANS_FALLBACK}` },
  manrope: { label: "Manrope", stack: `"Manrope Variable", ${SANS_FALLBACK}` },
  atkinson: { label: "Atkinson", title: "Atkinson Hyperlegible, designed for low vision", stack: `"Atkinson Hyperlegible Next Variable", ${SANS_FALLBACK}` },
  system: { label: "System", title: isMac ? "SF Pro" : "Your system's font", stack: `system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", sans-serif` },
};

export const MONO_FONTS: Record<MonoFont, FontDef> = {
  "geist-mono": { label: "Geist Mono", stack: `"Geist Mono", ${MONO_FALLBACK}` },
  jetbrains: { label: "JetBrains Mono", stack: `"JetBrains Mono Variable", ${MONO_FALLBACK}` },
  "plex-mono": { label: "IBM Plex Mono", stack: `"IBM Plex Mono", ${MONO_FALLBACK}` },
  system: { label: "System", title: isMac ? "SF Mono" : "Your system's monospaced font", stack: MONO_FALLBACK },
};

export const SANS_ORDER: SansFont[] = ["instrument", "inter", "geist", "plex", "dm", "manrope", "atkinson", "system"];
export const MONO_ORDER: MonoFont[] = ["geist-mono", "jetbrains", "plex-mono", "system"];

/** A family name as a quoted CSS string. */
export function cssFamily(name: string): string {
  return `"${name.replace(/["\\]/g, "\\$&")}"`;
}

// An installed family falls back to the default font if it's been uninstalled since.
// Unknown values (a font removed in a later version) fall back to the defaults too.
export function sansStack(choice: SansChoice, installed: string | null): string {
  if (choice === "installed") return installed ? `${cssFamily(installed)}, ${SANS_FONTS.instrument.stack}` : SANS_FONTS.instrument.stack;
  return (SANS_FONTS[choice] ?? SANS_FONTS.instrument).stack;
}

export function monoStack(choice: MonoChoice, installed: string | null): string {
  if (choice === "installed") return installed ? `${cssFamily(installed)}, ${MONO_FONTS["geist-mono"].stack}` : MONO_FONTS["geist-mono"].stack;
  return (MONO_FONTS[choice] ?? MONO_FONTS["geist-mono"]).stack;
}

export function applyFonts(sans: string, mono: string) {
  const root = document.documentElement;
  root.style.setProperty("--sans", sans);
  root.style.setProperty("--mono", mono);
}
