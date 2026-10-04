// Fills .github/RELEASE_TEMPLATE.md in for a version: swaps X.Y.Z for the version, points the
// changelog link at the previous tag (or drops it when there isn't one), and removes the comments.
//
//   node scripts/release-notes.mjs [version]     prints the notes
//
// Used by the Release workflow when it opens the draft.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function releaseNotes(version) {
  const tag = `v${version}`;
  const tags = spawnSync("git", ["tag", "--list", "v*", "--sort=-v:refname"], { cwd: root, encoding: "utf8" });
  const previous = tags.status === 0 ? tags.stdout.split("\n").find((t) => t && t !== tag) : undefined;
  let text = readFileSync(join(root, ".github", "RELEASE_TEMPLATE.md"), "utf8").replace(/<!--[\s\S]*?-->\n*/g, "");
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
