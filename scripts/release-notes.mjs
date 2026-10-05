// Fills .github/RELEASE_TEMPLATE.md in for a version: puts the version's notes from CHANGELOG.md under
// "What's new" (keeping the template's skeleton when it has none), swaps X.Y.Z for the version, points
// the changelog link at the previous tag (or drops it when there isn't one), and removes the comments.
//
//   node scripts/release-notes.mjs [version]     prints the notes
//
// Used by the Release workflow when it opens the draft.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { forGitHub, section } from "./changelog.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// GitHub shows the sections in the template's order, with its emoji.
const SECTIONS = [
  ["New", "✨ New"],
  ["Improved", "🔧 Improved"],
  ["Fixed", "🐛 Fixed"],
  ["Good to know", "⚠️ Good to know"],
];

/** A version's CHANGELOG.md notes laid out like the template's "What's new", or null when it has none. */
function whatsNew(version) {
  const notes = section(version);
  if (!notes) return null;
  const [headline, ...parts] = notes.split(/^### /m);
  const bodies = Object.fromEntries(parts.map((p) => [p.slice(0, p.indexOf("\n")).trim().toLowerCase(), p.slice(p.indexOf("\n") + 1).trim()]));
  const sections = SECTIONS.filter(([name]) => bodies[name.toLowerCase()]).map(([name, title]) => `### ${title}\n${bodies[name.toLowerCase()]}`);
  return forGitHub([`## What's new in Saga ${version}`, headline.trim(), ...sections].filter(Boolean).join("\n\n"));
}

export function releaseNotes(version) {
  const tag = `v${version}`;
  const tags = spawnSync("git", ["tag", "--list", "v*", "--sort=-v:refname"], { cwd: root, encoding: "utf8" });
  const previous = tags.status === 0 ? tags.stdout.split("\n").find((t) => t && t !== tag) : undefined;
  let text = readFileSync(join(root, ".github", "RELEASE_TEMPLATE.md"), "utf8").replace(/<!--[\s\S]*?-->\n*/g, "");
  const notes = whatsNew(version);
  if (notes) text = text.replace(/^## What's new in Saga X\.Y\.Z[\s\S]*?(?=^## )/m, `${notes}\n\n`);
  else console.error(`CHANGELOG.md has no notes for ${version}, so the draft keeps the template's skeleton.`);
  text = text.replaceAll("X.Y.Z", version);
  text = previous
    ? text.replaceAll("vPREVIOUS", previous)
    : text.replace(/\n\*\*Full changelog\*\*:.*\n?/, "\n");
  return text.trim() + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2] ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  process.stdout.write(releaseNotes(version));
}
