import { fmtBpm, hasTempo } from "./format";
import { camelot, keyName, keyRoot } from "./keys";
import type { DateStyle, KeyStyle, RenamePattern } from "./rename";
import type { SampleRow } from "./types";

/** What the dialog looks up once for the whole batch. */
export interface BatchInfo {
  /** When each file was created, in seconds since 1970, by sample id. */
  created: Map<number, number | null>;
  /** The collection the rename started from, or null when it started anywhere else. */
  collection: string | null;
}

/** What tokens draw on besides the sample itself. */
export interface TokenContext extends BatchInfo {
  /** Each sample's number for {n}, by id (see `numberRows`). */
  numbers: Map<number, number>;
}

/** One of the words in braces a rename template can hold. */
export interface Token {
  /** As written in a template, without the braces: "name" for {name}. */
  id: string;
  /** On the button that inserts it. */
  label: string;
  /** What it stands for, as the button's tooltip. */
  title: string;
  /** Why it has nothing to give in this batch, or null when it does. */
  unavailable?: (info: BatchInfo) => string | null;
  /** The text it stands for in this sample's new name; empty when it has none, which takes the
   *  separator next to it out too. */
  value: (row: SampleRow, p: RenamePattern, ctx: TokenContext) => string;
}

/** Every token, in the order their buttons show. Adding one here is all a new token needs. */
export const TOKENS: Token[] = [
  { id: "name", label: "Name", title: "The file's name as it is now, without the extension", value: (row) => row.name },
  { id: "folder", label: "Folder", title: "The name of the folder the file is in", value: (row) => folderName(row) },
  {
    id: "collection",
    label: "Collection",
    title: "The name of the collection you're renaming from",
    unavailable: (info) => (info.collection ? null : "Open a collection and select samples there to use its name"),
    value: (_row, _p, ctx) => ctx.collection ?? "",
  },
  { id: "n", label: "Number", title: "1, 2, 3… in the order the list shows, set up below", value: (row, p, ctx) => numberText(ctx.numbers.get(row.id), p.numberDigits) },
  { id: "key", label: "Key", title: "The key shown in Saga, written in the style below", value: keyValue },
  { id: "bpm", label: "BPM", title: "The tempo shown in Saga", value: bpmValue },
  { id: "date", label: "Date created", title: "The day the file was created", value: (row, p, ctx) => dateText(ctx.created.get(row.id), p.dateStyle) },
  { id: "category", label: "Category", title: "Kick, Bass, Vocal…", value: (row) => row.category ?? "" },
];

const BY_ID = new Map(TOKENS.map((t) => [t.id, t]));

/** The token written as {id}, whatever its case, or undefined for words that aren't tokens. */
export function tokenById(id: string): Token | undefined {
  return BY_ID.get(id.toLowerCase());
}

/** The last folder of the sample's path, or its pack for a file at the top of a library folder. */
export function folderName(row: Pick<SampleRow, "dir" | "pack">): string {
  return row.dir.split("/").filter(Boolean).pop() ?? row.pack;
}

/** "7", or padded with zeros to `digits`: "07", "007". */
export function numberText(n: number | undefined, digits: number): string {
  return n == null ? "" : String(n).padStart(digits, "0");
}

export function keyForName(row: Pick<SampleRow, "keyPc" | "keyMode">, style: KeyStyle, relativeMajor: boolean): string {
  if (row.keyPc == null || row.keyMode == null) return "";
  let pc = row.keyPc;
  let mode = row.keyMode;
  // A one-shot's root note has no scale to write.
  if (mode === 2) return style === "camelot" ? "" : ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][pc];
  if (relativeMajor && mode === 1) {
    pc = (pc + 3) % 12;
    mode = 0;
  }
  const m = mode as 0 | 1;
  switch (style) {
    case "short":
      return keyName(pc, m);
    case "compact":
      return `${keyRoot(pc, m)}${m === 1 ? "min" : "maj"}`;
    case "abbrev":
      return `${keyRoot(pc, m)} ${m === 1 ? "Min" : "Maj"}`;
    case "long":
      return `${keyRoot(pc, m)} ${m === 1 ? "minor" : "major"}`;
    case "camelot":
      return camelot(pc, m);
  }
}

/** Every way a name might already state this key, lowercased. */
function keySpellings(row: Pick<SampleRow, "keyPc" | "keyMode">): string[] {
  const out: string[] = [];
  for (const rel of [false, true]) {
    for (const style of ["short", "compact", "abbrev", "long", "camelot"] as KeyStyle[]) out.push(keyForName(row, style, rel).toLowerCase());
  }
  return [...new Set(out.filter(Boolean))];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function dateText(secs: number | null | undefined, style: DateStyle): string {
  if (secs == null) return "";
  const d = new Date(secs * 1000);
  const [y, m, day] = [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())];
  switch (style) {
    case "ymd":
      return `${y}-${m}-${day}`;
    case "compact":
      return `${y}${m}${day}`;
    case "dmy":
      return `${day}-${m}-${y}`;
    case "mdy":
      return `${m}-${day}-${y}`;
  }
}

/** The words in a name, lowercased: "Loop_124_Am (dry)" → loop, 124, am, dry. */
function nameWords(name: string): string[] {
  return name.toLowerCase().split(/[\s_\-.,()[\]{}]+/).filter(Boolean);
}

function bpmValue(row: SampleRow, p: RenamePattern): string {
  if (!hasTempo(row)) return "";
  const text = p.bpmWhole ? String(Math.round(row.bpm!)) : fmtBpm(row.bpm);
  if (p.skipExisting) {
    const words = nameWords(row.name);
    const said = [text, String(Math.round(row.bpm!)), fmtBpm(row.bpm)].some((t) => words.includes(t) || words.includes(`${t}bpm`));
    if (said) return "";
  }
  return text;
}

function keyValue(row: SampleRow, p: RenamePattern): string {
  const text = keyForName(row, p.keyStyle, p.relativeMajor);
  if (text && p.skipExisting) {
    const words = nameWords(row.name);
    const lower = ` ${words.join(" ")} `;
    if (keySpellings(row).some((k) => (k.includes(" ") ? lower.includes(` ${k} `) : words.includes(k)))) return "";
  }
  return text;
}
