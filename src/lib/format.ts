const MINUS = "−";

export function fmtCount(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}

/** Compact length for lists: "0.62 s", "7.7 s", "1:34". */
export function fmtLength(s: number | null | undefined): string {
  if (s == null) return "—";
  if (s < 1) return `${s.toFixed(2)} s`;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Transport clock: "0:02.61". */
export function fmtClock(s: number): string {
  const safe = Math.max(0, s);
  const m = Math.floor(safe / 60);
  const sec = safe - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
}

export function fmtBpm(b: number | null | undefined): string {
  if (b == null) return "—";
  return Number.isInteger(b) ? String(b) : b.toFixed(1);
}

export function fmtRate(hz: number | null | undefined): string {
  if (!hz) return "";
  const k = hz / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)} kHz`;
}

export function fmtChannels(n: number | null | undefined): string {
  if (!n) return "";
  if (n === 1) return "Mono";
  if (n === 2) return "Stereo";
  return `${n} ch`;
}

export function fmtDb(v: number | null | undefined, unit: string): string {
  if (v == null) return "";
  const s = Math.abs(v).toFixed(1);
  return `${v < 0 ? MINUS : ""}${s} ${unit}`;
}

export function barsCount(duration: number | null, bpm: number | null): number | null {
  if (!duration || !bpm) return null;
  const bars = (duration * bpm) / 240;
  const rounded = Math.round(bars);
  return rounded > 0 && Math.abs(bars - rounded) < 0.1 ? rounded : null;
}

export function fmtSeconds(s: number): string {
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 10) return `${Number(s.toFixed(1))} s`;
  if (s < 60) return `${Math.round(s)} s`;
  return `${Math.round(s / 60)} min`;
}

/** Marks values detected from the audio, which are estimates. */
export const ESTIMATE = "≈";

/** A loop's tempo for lists: "124", "≈123.8" when detected, or "—". */
export function bpmText(row: { kind: string; bpm: number | null; bpmSource: string | null }): string {
  if (row.kind !== "loop" || !row.bpm) return "—";
  return `${row.bpmSource === "audio" ? ESTIMATE : ""}${fmtBpm(row.bpm)}`;
}

export function keyText(row: { key: string | null; keySource: string | null }): string | null {
  if (!row.key) return null;
  return `${row.keySource === "audio" ? ESTIMATE : ""}${row.key}`;
}

/** One line about a sound: "Bass · 8.1 s · Cm · −14.5 LUFS". */
export function soundSummary(row: {
  category: string | null;
  duration: number | null;
  key: string | null;
  keySource: string | null;
  loudness: number | null;
  peakDb: number | null;
}): string {
  return [row.category ?? "Uncategorized", fmtLength(row.duration), keyText(row), fmtDb(row.loudness, "LUFS") || fmtDb(row.peakDb, "dB peak")].filter(Boolean).join(" · ");
}

export function sourceHint(what: "Tempo" | "Key", source: string | null): string | undefined {
  switch (source) {
    case "metadata":
      return `${what} from the file's loop data`;
    case "name":
      return `${what} from the file name`;
    case "audio":
      return `${what} detected from the audio — worth checking`;
    default:
      return undefined;
  }
}
