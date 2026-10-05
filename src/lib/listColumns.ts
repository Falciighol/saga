import { usePrefs } from "../store/prefs";
import type { SortKey } from "./types";

/** Every column the sample list can show besides the name, which is always there. */
export type ColumnId = "waveform" | "category" | "bpm" | "key" | "length" | "created" | "tags" | "added" | "format" | "rate" | "bits" | "channels" | "loudness" | "plays";

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
  width: number;
  align?: "right";
  /** Clicking the header sorts by this. */
  sort?: SortKey;
  /** A container query that hides the column when the list is narrow, so names keep their room. */
  narrow?: string;
  /** Whether it shows before the user picks columns. */
  shown: boolean;
}

/** The columns in their first order. A new column added here appears for everyone, in its
 *  `shown` state, after the ones they've arranged. */
export const COLUMNS: ColumnDef[] = [
  { id: "waveform", label: "Waveform", header: "Waveform", width: 180, shown: true },
  { id: "category", label: "Category", header: "Category", width: 84, narrow: "@max-[900px]:hidden", shown: true },
  { id: "bpm", label: "Tempo", header: "BPM", width: 60, align: "right", sort: "bpm", shown: true },
  { id: "key", label: "Key", header: "Key", width: 64, sort: "key", shown: true },
  { id: "length", label: "Length", header: "Length", width: 64, align: "right", sort: "duration", shown: true },
  { id: "created", label: "Date created", header: "Created", width: 84, sort: "created", narrow: "@max-[1000px]:hidden", shown: true },
  { id: "tags", label: "Tags", header: "Tags", width: 150, narrow: "@max-[1100px]:hidden", shown: true },
  { id: "added", label: "Date added", header: "Added", width: 84, sort: "added", narrow: "@max-[1000px]:hidden", shown: false },
  { id: "format", label: "Format", header: "Format", width: 52, narrow: "@max-[1000px]:hidden", shown: false },
  { id: "rate", label: "Sample rate", header: "Rate", width: 64, align: "right", narrow: "@max-[1000px]:hidden", shown: false },
  { id: "bits", label: "Bit depth", header: "Bits", width: 52, align: "right", narrow: "@max-[1000px]:hidden", shown: false },
  { id: "channels", label: "Channels", header: "Channels", width: 64, narrow: "@max-[1000px]:hidden", shown: false },
  { id: "loudness", label: "Loudness", header: "Loudness", width: 80, align: "right", narrow: "@max-[1000px]:hidden", shown: false },
  { id: "plays", label: "Times played", header: "Plays", width: 48, align: "right", narrow: "@max-[1000px]:hidden", shown: false },
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
