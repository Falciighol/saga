import { hasTempo, fmtBpm } from "./format";
import { camelot, keyName, keyRoot } from "./keys";
import type { SampleRow } from "./types";

/** How a key is written into a name. */
export type KeyStyle = "short" | "compact" | "long" | "camelot";
export type DateStyle = "ymd" | "compact" | "dmy" | "mdy";

/** A batch rename: a template of text and tokens, and how each token is written. */
export interface RenamePattern {
  /** "{name}_{bpm}_{key}": tokens are replaced, everything else is kept as typed. */
  template: string;
  keyStyle: KeyStyle;
  /** Minor keys written as their relative major (F♯ minor → A), for libraries sorted by major key. */
  relativeMajor: boolean;
  /** Whole beats (124) or as stored, up to two decimals (123.45). */
  bpmWhole: boolean;
  dateStyle: DateStyle;
  /** Leave out a tempo or key the name already has, so "Loop_124_Am" doesn't become "Loop_124_Am_124_Am". */
  skipExisting: boolean;
}

export const DEFAULT_PATTERN: RenamePattern = {
  template: "{name}_{bpm}_{key}",
  keyStyle: "short",
  relativeMajor: false,
  bpmWhole: true,
  dateStyle: "ymd",
  skipExisting: true,
};

export const TOKENS: { token: string; label: string; title: string }[] = [
  { token: "{name}", label: "Name", title: "The file's name as it is now, without the extension" },
  { token: "{key}", label: "Key", title: "The key shown in Saga, written in the style below" },
  { token: "{bpm}", label: "BPM", title: "The tempo shown in Saga" },
  { token: "{date}", label: "Date created", title: "The day the file was created" },
  { token: "{category}", label: "Category", title: "Kick, Bass, Vocal…" },
];

export const PRESETS: { label: string; template: string }[] = [
  { label: "Name, then tempo and key", template: "{name}_{bpm}_{key}" },
  { label: "Tempo and key, then name", template: "{bpm}_{key}_{name}" },
  { label: "Name (key, tempo BPM)", template: "{name} ({key}, {bpm} BPM)" },
  { label: "Name with date created", template: "{name}_{date}" },
  { label: "Key, tempo and date", template: "{name}_{key}_{bpm}_{date}" },
];

/** Characters macOS or Windows won't take in a file name. */
const BAD_CHARS = /[/\\:*?"<>|\u0000-\u001f]/;
const SEPARATORS = /^[\s_\-.,]+$/;

/** Takes every copy of a token out of the template, with the separator before it (or after it, at
 *  the start), so "{name}_{bpm}_{key}" becomes "{name}_{key}". Typed words around it stay. */
export function removeToken(template: string, token: string): string {
  const re = new RegExp(`\\{${token.slice(1, -1)}\\}`, "i");
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
    for (const style of ["short", "compact", "long", "camelot"] as KeyStyle[]) out.push(keyForName(row, style, rel).toLowerCase());
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

/** The value each token stands for in this row's new name; empty when it has none. */
function tokenValue(token: string, row: SampleRow, created: number | null | undefined, p: RenamePattern): string {
  switch (token) {
    case "name":
      return row.name;
    case "bpm": {
      if (!hasTempo(row)) return "";
      const text = p.bpmWhole ? String(Math.round(row.bpm!)) : fmtBpm(row.bpm);
      if (p.skipExisting) {
        const words = nameWords(row.name);
        const said = [text, String(Math.round(row.bpm!)), fmtBpm(row.bpm)].some((t) => words.includes(t) || words.includes(`${t}bpm`));
        if (said) return "";
      }
      return text;
    }
    case "key": {
      const text = keyForName(row, p.keyStyle, p.relativeMajor);
      if (text && p.skipExisting) {
        const words = nameWords(row.name);
        const lower = ` ${words.join(" ")} `;
        if (keySpellings(row).some((k) => (k.includes(" ") ? lower.includes(` ${k} `) : words.includes(k)))) return "";
      }
      return text;
    }
    case "date":
      return dateText(created, p.dateStyle);
    case "category":
      return row.category ?? "";
    default:
      return `{${token}}`;
  }
}

/** Fills in the template. A token with nothing to say takes the separator next to it along, so a
 *  sample without a key gets "Loop_124", not "Loop_124_". */
export function applyPattern(row: SampleRow, created: number | null | undefined, p: RenamePattern): string {
  const parts: { text: string; token: boolean }[] = [];
  let last = 0;
  for (const m of p.template.matchAll(/\{(\w+)\}/g)) {
    if (m.index! > last) parts.push({ text: p.template.slice(last, m.index), token: false });
    parts.push({ text: tokenValue(m[1].toLowerCase(), row, created, p), token: true });
    last = m.index! + m[0].length;
  }
  if (last < p.template.length) parts.push({ text: p.template.slice(last), token: false });

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

/** Why a name can't be a file name, or null when it can. Mirrors `valid_name` in commands.rs. */
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

/** The new name of every row, with the ones that clash with each other marked. */
export function planRenames(rows: SampleRow[], dates: Map<number, number | null>, p: RenamePattern): PlannedRename[] {
  const plans = rows.map<PlannedRename>((row) => {
    const to = applyPattern(row, dates.get(row.id), p);
    const unchanged = to === row.name;
    return { row, to, unchanged, problem: unchanged ? null : !row.online ? "Drive not connected" : nameProblem(to) };
  });
  // Two files in one folder can't end up with the same name (whatever the case, on macOS and Windows).
  const taken = new Map<string, number>();
  for (const x of plans) {
    const k = `${x.row.sourceId}\u0000${x.row.dir}\u0000${x.to.toLowerCase()}.${x.row.ext}`;
    taken.set(k, (taken.get(k) ?? 0) + 1);
  }
  for (const x of plans) {
    const k = `${x.row.sourceId}\u0000${x.row.dir}\u0000${x.to.toLowerCase()}.${x.row.ext}`;
    if (!x.problem && !x.unchanged && taken.get(k)! > 1) x.problem = "Same name as another file here";
  }
  return plans;
}
