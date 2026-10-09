const MINUS = "−";

export function fmtCount(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}

/** File sizes the way Finder shows them: "820 KB", "48 MB", "2.1 GB". */
export function fmtBytes(n: number): string {
  if (n < 1000) return `${n} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1000;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v < 10 && u > 0 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** Compact length for lists: "0.62 s", "7.7 s", "1:34" ("7.70 s" when `aligned`). */
export function fmtLength(s: number | null | undefined, aligned = false): string {
  if (s == null) return "—";
  // `aligned` keeps two decimals up to a minute, so lengths in a right-aligned column line up on the point.
  if (s < 1 || (aligned && s < 60)) return `${s.toFixed(2)} s`;
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

/** A take's length while it records: "0:12.4", "14:02.0". */
export function fmtTake(s: number): string {
  const safe = Math.max(0, s);
  const m = Math.floor(safe / 60);
  return `${m}:${(safe - m * 60).toFixed(1).padStart(4, "0")}`;
}

/** "124", "123.8", "123.45"; with `fixed`, always two decimals: "124.00". */
export function fmtBpm(b: number | null | undefined, fixed = false): string {
  if (b == null) return "—";
  if (fixed) return b.toFixed(2);
  return String(Math.round(b * 100) / 100);
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

/** Whether a sample's tempo is worth showing: a loop's, or one set by hand. */
export function hasTempo(row: { kind: string; bpm: number | null; bpmSource: string | null }): boolean {
  return !!row.bpm && (row.kind === "loop" || row.bpmSource === "user");
}

/** A loop's tempo for lists: "124", "≈123.8" when detected, or "—". */
export function bpmText(row: { kind: string; bpm: number | null; bpmSource: string | null }, fixed = false): string {
  if (!hasTempo(row)) return "—";
  return `${row.bpmSource === "audio" ? ESTIMATE : ""}${fmtBpm(row.bpm, fixed)}`;
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
    case "user":
      return `${what} set by you`;
    default:
      return undefined;
  }
}

/** A day as "2026-10-03" in local time, the way dates sort; "—" when unknown. */
export function fmtDate(secs: number | null | undefined): string {
  if (secs == null) return "—";
  const d = new Date(secs * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
