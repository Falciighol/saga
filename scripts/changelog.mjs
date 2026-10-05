// Reads and dates CHANGELOG.md for the release scripts. The app parses the same file in src/lib/changelog.ts, so the
// headings and the key spelling here mirror it: "## x.y.z — YYYY-MM-DD", "### Good to know|New|Improved|Fixed", and
// keys in backticks with "Mod" and "Alt" for the modifier.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CHANGELOG = join(root, "CHANGELOG.md");

const read = () => readFileSync(CHANGELOG, "utf8");
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const heading = (version) => new RegExp(`^## v?${escape(version)}(?:\\s*[—–-]\\s*(\\d{4}-\\d{2}-\\d{2}))?\\s*$`, "m");

/** A version's notes as written, without its "## x.y.z" line, or null when it has none. */
export function section(version) {
  const text = read().replace(/<!--[\s\S]*?-->/g, "");
  const start = text.match(heading(version));
  if (!start) return null;
  const rest = text.slice(start.index + start[0].length);
  const end = rest.search(/^## /m);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/**
 * Puts the version and today's date on the "## Unreleased" notes, or the date on an undated "## x.y.z". Returns false
 * when there are no notes for the version, so `set-version` can stop before tagging a release without any.
 */
export function dateRelease(version, date = new Date().toISOString().slice(0, 10)) {
  const text = read();
  const dated = `## ${version} — ${date}`;
  const own = text.match(heading(version));
  if (own) {
    if (!own[1]) writeFileSync(CHANGELOG, text.replace(own[0], dated));
    return true;
  }
  if (!/^## Unreleased\s*$/im.test(text) || !section("Unreleased")) return false;
  writeFileSync(CHANGELOG, text.replace(/^## Unreleased\s*$/im, dated));
  return true;
}

// Mirrors NAMED_KEYS and isKeys() in src/lib/changelog.ts.
const NAMED_KEYS = new Set(["Mod", "Alt", "Esc", "Enter", "Space", "Tab", "click", "/", "+", "−"]);
const isKeys = (text) => text.split(" ").every((k) => NAMED_KEYS.has(k) || [...k].length === 1);

/** The notes for GitHub, which can't tell a Mac from a PC: `Mod ⇧ F` becomes `⌘/Ctrl ⇧ F`. */
export function forGitHub(notes) {
  return notes.replace(/`([^`]+)`/g, (all, inner) =>
    isKeys(inner) ? `\`${inner.replace(/\bMod\b/g, "⌘/Ctrl").replace(/\bAlt\b/g, "⌥/Alt")}\`` : all,
  );
}
