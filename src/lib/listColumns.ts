import { usePrefs } from "../store/prefs";
import type { SortKey } from "./types";

/** Every column the sample list can show besides the name, which is always there. */
export type ColumnId = "waveform" | "category" | "bpm" | "key" | "length" | "created" | "tags" | "added" | "format" | "rate" | "bits" | "channels" | "loudness" | "plays";

/** The sets the Columns menu sorts columns into. */
export type ColumnGroup = "sound" | "music" | "file" | "library";

/** The Columns menu's sections, in order. */
export const COLUMN_GROUPS: { id: ColumnGroup; label: string }[] = [
  { id: "sound", label: "Sound" },
  { id: "music", label: "Music" },
  { id: "file", label: "File" },
  { id: "library", label: "Library" },
];

/** A column as saved: its place in the order, and whether it shows. */
export interface ColumnPref {
  id: ColumnId;
  visible: boolean;
}

export interface ColumnDef {
  id: ColumnId;
  /** In the Columns menu. */
  label: string;
  /** In the list's header. */
  header: string;
  /** Its section in the Columns menu. */
  group: ColumnGroup;
  width: number;
  align?: "right";
  /** Clicking the header sorts by this. */
  sort?: SortKey;
  /** Whether it shows before the user picks columns. */
  shown: boolean;
}

/** The columns in their first order. A new column added here appears for everyone, in its
 *  `shown` state, after the ones they've arranged. */
export const COLUMNS: ColumnDef[] = [
  { id: "waveform", label: "Waveform", header: "Waveform", group: "sound", width: 180, shown: true },
  { id: "category", label: "Category", header: "Category", group: "sound", width: 84, shown: true },
  { id: "bpm", label: "Tempo (BPM)", header: "BPM", group: "music", width: 60, align: "right", sort: "bpm", shown: true },
  { id: "key", label: "Key", header: "Key", group: "music", width: 64, sort: "key", shown: true },
  { id: "length", label: "Length", header: "Length", group: "sound", width: 64, align: "right", sort: "duration", shown: true },
  { id: "created", label: "Date created", header: "Created", group: "library", width: 84, sort: "created", shown: true },
  { id: "tags", label: "Tags", header: "Tags", group: "library", width: 150, shown: true },
  { id: "added", label: "Date added", header: "Added", group: "library", width: 84, sort: "added", shown: false },
  { id: "format", label: "Format", header: "Format", group: "file", width: 52, shown: false },
  { id: "rate", label: "Sample rate", header: "Rate", group: "file", width: 64, align: "right", shown: false },
  { id: "bits", label: "Bit depth", header: "Bits", group: "file", width: 52, align: "right", shown: false },
  { id: "channels", label: "Channels", header: "Channels", group: "file", width: 64, shown: false },
  { id: "loudness", label: "Loudness", header: "Loudness", group: "sound", width: 80, align: "right", shown: false },
  { id: "plays", label: "Times played", header: "Plays", group: "library", width: 48, align: "right", shown: false },
];

const BY_ID = new Map(COLUMNS.map((c) => [c.id, c]));

export function columnDef(id: ColumnId): ColumnDef {
  return BY_ID.get(id)!;
}

/** Every column in the user's order with whether it shows: saved ones first (unknown ids dropped),
 *  then any the saved list doesn't have yet. */
export function resolveColumns(saved: ColumnPref[] | null): ColumnPref[] {
  const out = (saved ?? []).filter((c) => BY_ID.has(c.id));
  for (const c of COLUMNS) if (!out.some((x) => x.id === c.id)) out.push({ id: c.id, visible: c.shown });
  return out;
}

/** The columns that show, in order. */
export function visibleColumns(saved: ColumnPref[] | null): ColumnDef[] {
  return resolveColumns(saved)
    .filter((c) => c.visible)
    .map((c) => columnDef(c.id));
}

function save(columns: ColumnPref[]) {
  usePrefs.getState().set({ listColumns: columns });
}

/** The narrowest a sample's name gets. Columns never take this room: past it the list scrolls sideways. */
export const NAME_MIN = 220;
/** The narrowest the waveform gets before the list starts scrolling sideways. */
const WAVE_MIN = 96;
/** The waveform draws a bar every 3 px, so its width moves in steps of 3 and bars never smear. */
const WAVE_STEP = 3;
/** The Key column's width when it also says how each key fits ("Am in key"). */
const KEY_FIT_WIDTH = 92;
/** Space before each column (`gap-4` on the row and the header). */
const COLUMN_GAP = 16;
/** Pixels a row spends outside the name and its columns: side padding (px-4), the play button (w-8), the
 *  favorite star (w-7), the drag grip or the Columns button (w-7), the three gaps between them (gap-1) and the
 *  name's left padding (pl-1). Mirrors the classes on SampleRowView and ListHeader. */
const ROW_CHROME = 16 * 2 + 32 + 28 + 28 + 4 * 3 + 4;

export interface ColumnLayout {
  /** The columns that show, with the waveform at the width it gets. */
  columns: ColumnDef[];
  /** The width rows and the header need. When the list is narrower, it scrolls sideways. */
  minWidth: number;
}

/** Lays out the shown columns in `available` pixels. The name keeps at least NAME_MIN and every other column
 *  keeps its width. Only the waveform gives way, down to WAVE_MIN, and past that the list scrolls sideways.
 *  `keyFit` widens the Key column for the word that says how each key fits. */
export function columnLayout(shown: ColumnDef[], available: number, keyFit = false): ColumnLayout {
  const columns = keyFit ? shown.map((c) => (c.id === "key" ? { ...c, width: KEY_FIT_WIDTH } : c)) : shown;
  const fixed = columns.reduce((sum, c) => sum + COLUMN_GAP + (c.id === "waveform" ? 0 : c.width), ROW_CHROME + NAME_MIN);
  if (!columns.some((c) => c.id === "waveform")) return { columns, minWidth: fixed };
  const full = columnDef("waveform").width;
  const wave = Math.max(WAVE_MIN, Math.min(full, Math.floor((available - fixed) / WAVE_STEP) * WAVE_STEP));
  return {
    columns: wave === full ? columns : columns.map((c) => (c.id === "waveform" ? { ...c, width: wave } : c)),
    minWidth: fixed + wave,
  };
}

export function setColumnVisible(id: ColumnId, visible: boolean) {
  save(resolveColumns(usePrefs.getState().listColumns).map((c) => (c.id === id ? { ...c, visible } : c)));
}

/** Moves a column to just before another one, or to the end when `before` is null. */
export function moveColumn(id: ColumnId, before: ColumnId | null) {
  if (id === before) return;
  const all = resolveColumns(usePrefs.getState().listColumns);
  const moving = all.find((c) => c.id === id);
  if (!moving) return;
  const rest = all.filter((c) => c.id !== id);
  const at = before == null ? rest.length : rest.findIndex((c) => c.id === before);
  rest.splice(at < 0 ? rest.length : at, 0, moving);
  save(rest);
}

/** Moves a column one place left or right among the ones that show. */
export function stepColumn(id: ColumnId, step: -1 | 1) {
  const shown = resolveColumns(usePrefs.getState().listColumns).filter((c) => c.visible);
  const i = shown.findIndex((c) => c.id === id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= shown.length) return;
  // Right: the next one goes before this one. Left: this one goes before the previous one.
  if (step === 1) moveColumn(shown[j].id, id);
  else moveColumn(id, shown[j].id);
}

export function resetColumns() {
  usePrefs.getState().set({ listColumns: null });
}
