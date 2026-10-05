import source from "../../CHANGELOG.md?raw";
import { altKey, modKey } from "./platform";

/** The sections a version's notes can have, in the order they're shown. */
export type ChangeKind = "good" | "new" | "improved" | "fixed";

export const CHANGE_KINDS: ChangeKind[] = ["good", "new", "improved", "fixed"];

export const CHANGE_LABELS: Record<ChangeKind, string> = {
  good: "Good to know",
  new: "New",
  improved: "Improved",
  fixed: "Fixed",
};

export interface Change {
  /** "Resizable sidebar"; fixes usually have none. */
  name: string | null;
  /** The rest of the entry, still marked up with `keys` and **bold**. */
  text: string;
}

export interface Release {
  version: string;
  /** "2026-10-04", or null until `set-version` dates it. */
  date: string | null;
  /** The one sentence under the version. */
  headline: string;
  changes: Record<ChangeKind, Change[]>;
}

const HEADINGS: Record<string, ChangeKind> = {
  "good to know": "good",
  new: "new",
  improved: "improved",
  fixed: "fixed",
};

/**
 * Reads CHANGELOG.md, newest version first. "Unreleased" and anything the format doesn't know are skipped rather than
 * shown half-parsed. Mirrors `section()` in scripts/release-notes.mjs, which reads the same headings.
 */
export function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let kind: ChangeKind | null = null;
  let headline: string[] = [];

  for (const raw of md.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    const version = line.match(/^##\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*(?:[—–-]\s*(\d{4}-\d{2}-\d{2}))?\s*$/);
    if (line.startsWith("## ")) {
      release = version ? { version: version[1], date: version[2] ?? null, headline: "", changes: { good: [], new: [], improved: [], fixed: [] } } : null;
      if (release) releases.push(release);
      kind = null;
      headline = [];
      continue;
    }
    if (!release) continue;
    if (line.startsWith("### ")) {
      kind = HEADINGS[line.slice(4).trim().toLowerCase()] ?? null;
      continue;
    }
    if (!kind) {
      // Text before the first section is the headline, however it's wrapped.
      if (line.trim()) {
        headline.push(line.trim());
        release.headline = headline.join(" ");
      }
      continue;
    }
    const entry = line.match(/^[-*]\s+(?:\*\*(.+?)\*\*:?\s*)?(.*)$/);
    if (entry) {
      const text = entry[2].trim();
      release.changes[kind].push({ name: entry[1]?.trim() ?? null, text: text.charAt(0).toUpperCase() + text.slice(1) });
    } else if (line.trim() && release.changes[kind].length) {
      // A wrapped entry continues on the next indented line.
      const last = release.changes[kind][release.changes[kind].length - 1];
      last.text = `${last.text} ${line.trim()}`;
    }
  }
  return releases;
}

/** Orders "1.0.10" after "1.0.9". A pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Every release in the bundled CHANGELOG.md, newest first. */
export const RELEASES: Release[] = parseChangelog(source).sort((a, b) => compareVersions(b.version, a.version));

/** Releases after `since` (exclusive) up to `current` (inclusive), newest first. With no `since`, just `current`. */
export function releasesBetween(since: string | null, current: string): Release[] {
  return RELEASES.filter((r) => compareVersions(r.version, current) <= 0 && (since ? compareVersions(r.version, since) > 0 : r.version === current));
}

/**
 * An entry's text as runs of plain text, **bold**, keys and other `code` (file names, search terms, key spellings).
 * Keys get Mod and Alt spelled for this computer.
 */
export type Run = { kind: "text" | "bold" | "key" | "code"; text: string };

export function inlineRuns(text: string): Run[] {
  const runs: Run[] = [];
  for (const part of text.split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
    if (!part) continue;
    if (part.startsWith("`")) {
      const inner = part.slice(1, -1);
      runs.push(isKeys(inner) ? { kind: "key", text: keyLabel(inner) } : { kind: "code", text: inner });
    }
    else if (part.startsWith("**")) runs.push({ kind: "bold", text: part.slice(2, -2) });
    else runs.push({ kind: "text", text: part });
  }
  return runs;
}

/** The same text with its marks dropped, for one-line summaries. */
export function plainText(text: string): string {
  return inlineRuns(text)
    .map((r) => r.text)
    .join("");
}

const NAMED_KEYS = new Set(["Mod", "Alt", "Esc", "Enter", "Space", "Tab", "click", "/", "+", "−"]);

/**
 * `G`, `Mod ⇧ F` and `Alt click` are keys; `Kick 2`, `F#m` and `Stem*` are text to show as written. Mirrors isKeys() in
 * scripts/changelog.mjs.
 */
function isKeys(text: string): boolean {
  return text.split(" ").every((k) => NAMED_KEYS.has(k) || [...k].length === 1);
}

function keyLabel(key: string): string {
  return key.replace(/\bMod\b/g, modKey).replace(/\bAlt\b/g, altKey);
}
