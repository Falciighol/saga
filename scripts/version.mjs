// Sets the app version everywhere it's written, or checks that they agree.
//   node scripts/version.mjs 0.2.0     set it, commit the bump and tag v0.2.0 (pass --no-git to only edit files)
//   node scripts/version.mjs --check   exit 1 if the files disagree (CI runs this before a release)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  "package.json": /("version":\s*")([^"]+)(")/,
  "src-tauri/tauri.conf.json": /("version":\s*")([^"]+)(")/,
  "src-tauri/Cargo.toml": /(\[package\][^[]*?\nversion\s*=\s*")([^"]+)(")/,
  "src-tauri/Cargo.lock": /(\nname = "saga"\nversion = ")([^"]+)(")/,
};

const read = (f) => readFileSync(join(root, f), "utf8");
const current = Object.fromEntries(Object.entries(files).map(([f, re]) => [f, read(f).match(re)?.[2]]));
const arg = process.argv.slice(2).find((a) => a !== "--no-git");

if (!arg || arg === "--check") {
  const versions = new Set(Object.values(current));
  for (const [f, v] of Object.entries(current)) console.log(`${v ?? "missing"}\t${f}`);
  if (versions.size !== 1 || versions.has(undefined)) {
    console.error("Versions disagree. Run: npm run set-version -- <x.y.z>");
    process.exit(1);
  }
  process.exit(0);
}

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(arg)) {
  console.error(`Not a semver version: ${arg}`);
  process.exit(1);
}
for (const [f, re] of Object.entries(files)) {
  writeFileSync(join(root, f), read(f).replace(re, `$1${arg}$3`));
  console.log(`${current[f]} → ${arg}\t${f}`);
}

if (process.argv.includes("--no-git")) process.exit(0);
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "inherit" });
git("add", ...Object.keys(files));
git("commit", "-m", `chore: bump version to ${arg} in package.json, Cargo.toml, Cargo.lock, and tauri.conf.json`);
git("tag", `v${arg}`);
console.log(`Committed and tagged v${arg}. Push with: git push origin main v${arg}`);
