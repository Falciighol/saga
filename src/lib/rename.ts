import { tokenById, type BatchInfo, type TokenContext } from "./renameTokens";
import type { SampleRow } from "./types";

/** How a key is written into a name: F#m, F#min, F# Min, F# minor or 11A. */
export type KeyStyle = "short" | "compact" | "abbrev" | "long" | "camelot";
export type DateStyle = "ymd" | "compact" | "dmy" | "mdy";
/** Whether {n} counts across everything being renamed, or starts again in each folder. */
export type NumberEach = "selection" | "folder";

/** A batch rename: a template of text and tokens, and how each token is written. */
export interface RenamePattern {
  /** "{name}_{bpm}_{key}": tokens are replaced, everything else is kept as typed. */
  template: string;
  keyStyle: KeyStyle;
  /** Minor keys written as their relative major (F♯ minor → A), for libraries sorted by major key. */
  relativeMajor: boolean;
  /** Whole beats (124) or as stored, up to two decimals (123.45). */
  bpmWhole: boolean;
  /** Write "BPM" after the tempo ("124 BPM"), so it's left out along with a missing tempo. */
  bpmSuffix: boolean;
  dateStyle: DateStyle;
  /** Leave out a tempo or key the name already has, so "Loop_124_Am" doesn't become "Loop_124_Am_124_Am". */
  skipExisting: boolean;
  /** The first number {n} gives. */
  numberFrom: number;
  /** How many digits {n} is padded to with zeros: 1 gives "7", 2 gives "07". */
  numberDigits: number;
  numberEach: NumberEach;
}

/** Patterns saved before a field existed are read over this, so every field has a value. */
export const DEFAULT_PATTERN: RenamePattern = {
  template: "{name}_{bpm}_{key}",
  keyStyle: "short",
  relativeMajor: false,
  bpmWhole: true,
  bpmSuffix: false,
  dateStyle: "ymd",
  skipExisting: true,
  numberFrom: 1,
  numberDigits: 1,
  numberEach: "selection",
};

/** Characters macOS or Windows won't take in a file name. */
const BAD_CHARS = /[/\\:*?"<>|\u0000-\u001f]/;
const SEPARATORS = /^[\s_\-.,]+$/;

/** Whether the template holds this token ("{n}", any case). */
export function usesToken(template: string, id: string): boolean {
  return template.toLowerCase().includes(`{${id.toLowerCase()}}`);
}

/** Takes every copy of a token out of the template, with the separator before it (or after it, at
 *  the start), so "{name}_{bpm}_{key}" becomes "{name}_{key}". Typed words around it stay. */
export function removeToken(template: string, id: string): string {
  const re = new RegExp(`\\{${id}\\}`, "i");
  let out = template;
  for (let m = re.exec(out); m; m = re.exec(out)) {
    let start = m.index;
    let end = start + m[0].length;
    const before = /[\s_\-.,]+$/.exec(out.slice(0, start));
    const after = /^[\s_\-.,]+/.exec(out.slice(end));
    if (before) start -= before[0].length;
    else if (after) end += after[0].length;
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

/** Numbers the rows in the order given (the list's): across all of them, or again from the first
 *  number in each folder. */
export function numberRows(rows: SampleRow[], p: Pick<RenamePattern, "numberFrom" | "numberEach">): Map<number, number> {
  const next = new Map<string, number>();
  const out = new Map<number, number>();
  for (const row of rows) {
    const group = p.numberEach === "folder" ? `${row.sourceId}\u0000${row.dir}` : "";
    const n = next.get(group) ?? p.numberFrom;
    out.set(row.id, n);
    next.set(group, n + 1);
  }
  return out;
}

/** Fills in the template. A token with nothing to say takes the separator next to it along, so a
 *  sample without a key gets "Loop_124", not "Loop_124_". Words in braces that aren't tokens stay. */
export function applyPattern(row: SampleRow, p: RenamePattern, ctx: TokenContext): string {
  const parts: { text: string; token: boolean; bpm?: boolean }[] = [];
  let last = 0;
  for (const m of p.template.matchAll(/\{(\w+)\}/g)) {
    if (m.index! > last) parts.push({ text: p.template.slice(last, m.index), token: false });
    const token = tokenById(m[1]);
    parts.push({ text: token ? token.value(row, p, ctx) : m[0], token: !!token, bpm: token?.id === "bpm" });
    last = m.index! + m[0].length;
  }
  if (last < p.template.length) parts.push({ text: p.template.slice(last), token: false });

  // "124 BPM", unless the template already says BPM straight after the token ("{bpm} BPM").
  for (let i = 0; i < parts.length; i++) {
    if (p.bpmSuffix && parts[i].bpm && parts[i].text && !/^\s*bpm(?![a-z])/i.test(parts[i + 1]?.text ?? "")) parts[i].text += " BPM";
  }

  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].token || parts[i].text) continue;
    const before = parts[i - 1];
    const after = parts[i + 1];
    if (before && !before.token && SEPARATORS.test(before.text)) before.text = "";
    else if (after && !after.token && SEPARATORS.test(after.text)) after.text = "";
  }
  return parts
    .map((x) => x.text)
    .join("")
    .replace(/\s*(\(\s*\)|\[\s*\])/g, "")
    .replace(/\(\s*[,;]\s*/g, "(")
    .replace(/\s*[,;]\s*\)/g, ")")
    .replace(/ {2,}/g, " ")
    .replace(/^[\s_\-.,]+|[\s_\-.,]+$/g, "");
}

/** Why a name can't be a file name, or null when it can. Mirrors `valid_name` in rename.rs. */
export function nameProblem(name: string): string | null {
  if (!name.trim()) return "Empty name";
  if (BAD_CHARS.test(name)) return 'Names can\'t contain / \\ : * ? " < > |';
  if (name.startsWith(".") || name.endsWith(".")) return "Names can't start or end with a dot";
  if (name.length > 200) return "Too long";
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) return "Windows keeps that name for itself";
  return null;
}

export interface PlannedRename {
  row: SampleRow;
  to: string;
  /** Why it can't be renamed; null when it can. */
  problem: string | null;
  unchanged: boolean;
}

/** The new name of every row (in the list's order, which {n} counts in), with the ones that clash
 *  with each other marked. Files may trade names: the backend moves them all at once. */
export function planRenames(rows: SampleRow[], p: RenamePattern, info: BatchInfo): PlannedRename[] {
  const ctx: TokenContext = { ...info, numbers: usesToken(p.template, "n") ? numberRows(rows, p) : new Map() };
  const plans = rows.map<PlannedRename>((row) => {
    const to = applyPattern(row, p, ctx);
    const unchanged = to === row.name;
    return { row, to, unchanged, problem: unchanged ? null : !row.online ? "Drive not connected" : nameProblem(to) };
  });
  // Two files in one folder can't end up with the same name (whatever the case, on macOS and Windows).
  const key = (x: PlannedRename) => `${x.row.sourceId}\u0000${x.row.dir}\u0000${x.to.toLowerCase()}.${x.row.ext}`;
  const taken = new Map<string, number>();
  for (const x of plans) taken.set(key(x), (taken.get(key(x)) ?? 0) + 1);
  for (const x of plans) {
    if (!x.problem && !x.unchanged && taken.get(key(x))! > 1) x.problem = "Same name as another file here";
  }
  return plans;
}
