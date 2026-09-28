// Builds the Windows release on this PC and collects what to upload to the version's draft GitHub
// release (opened by .github/workflows/release.yml), next to the Mac build from `npm run release:mac`.
//   npm run release:windows
//
// One NSIS installer, not code-signed (Windows shows SmartScreen's "unknown publisher" warning), plus
// the updater's signature for it. Nothing is uploaded: the files land in release-windows/ for you to
// drag onto the draft. latest.json there gets a windows-x86_64 entry; if `gh` is signed in and the draft
// already has a latest.json (the Mac's), that one is the starting point so its entries survive.
//
// The updater key has to be on this PC: copy ~/.tauri/saga_updater.key from the Mac to the same path
// here (%USERPROFILE%\.tauri\saga_updater.key), or set TAURI_SIGNING_PRIVATE_KEY to its path or contents.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release-windows");
const updaterKey = join(homedir(), ".tauri", "saga_updater.key");
const platform = { x64: "windows-x86_64", arm64: "windows-aarch64" }[process.arch];

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function step(message) {
  console.log(`\n→ ${message}`);
}

/** Runs a command and returns its stdout, or null when it fails and `allowFail` is set. `inherit` streams the output. */
function run(cmd, args, { env = process.env, inherit = false, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { cwd: root, env, encoding: "utf8", stdio: inherit ? "inherit" : "pipe" });
  if (r.status === 0) return (r.stdout ?? "").trim();
  if (allowFail) return null;
  fail(`${cmd} ${args[0] ?? ""} failed${r.stderr ? `:\n${r.stderr.trim()}` : ""}`);
}

if (process.platform !== "win32") fail("Run this on Windows.");
if (!platform) fail(`No Windows updater platform for ${process.arch}.`);

// The build has to match a pushed commit at the release's version.
step("Checking the version and git");
run("node", ["scripts/version.mjs", "--check"]);
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const tag = `v${version}`;
if (run("git", ["status", "--porcelain"])) fail("Commit or set aside your changes first, so the build matches a commit.");
const sha = run("git", ["rev-parse", "HEAD"]);
if (!run("git", ["branch", "-r", "--contains", sha])) fail("Push this commit first; the release is made from it.");
const remote = run("git", ["remote", "get-url", "origin"]);
const repo = remote.match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1] ?? fail(`origin isn't a GitHub repository: ${remote}`);

const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  if (!existsSync(updaterKey)) fail(`The updater key isn't at ${updaterKey}. Copy it from the Mac, or set TAURI_SIGNING_PRIVATE_KEY.`);
  env.TAURI_SIGNING_PRIVATE_KEY = updaterKey;
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";

step("Building the installer (this takes a while)");
run("node", ["scripts/tauri.mjs", "build", "--bundles", "nsis", "--config", "src-tauri/tauri.release.conf.json"], { env, inherit: true });

const nsis = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const installerName = existsSync(nsis) ? readdirSync(nsis).find((f) => f.startsWith(`Saga_${version}_`) && f.endsWith("-setup.exe")) : null;
if (!installerName) fail(`The build didn't make Saga_${version}_*-setup.exe in ${nsis}`);
const installer = join(nsis, installerName);
if (!existsSync(`${installer}.sig`)) fail(`The build didn't sign the installer (${installerName}.sig). Is createUpdaterArtifacts on and the key right?`);
const signature = readFileSync(`${installer}.sig`, "utf8").trim();

step("Collecting the files to upload");
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
copyFileSync(installer, join(out, installerName));
copyFileSync(`${installer}.sig`, join(out, `${installerName}.sig`));

// Start from the draft's latest.json when gh can fetch it, so the Mac entries carry over.
const staging = mkdtempSync(join(tmpdir(), "saga-release-"));
const fetched = run("gh", ["release", "download", tag, "-R", repo, "-p", "latest.json", "-D", staging], { allowFail: true }) != null;
const latest = fetched && existsSync(join(staging, "latest.json"))
  ? JSON.parse(readFileSync(join(staging, "latest.json"), "utf8"))
  : { version, notes: "", pub_date: new Date().toISOString(), platforms: {} };
rmSync(staging, { recursive: true, force: true });
latest.version = version;
latest.platforms[platform] = { signature, url: `https://github.com/${repo}/releases/download/${tag}/${installerName}` };
writeFileSync(join(out, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);

console.log(`\n✓ Saga ${version} for Windows is in ${out}`);
console.log(`  Drag ${installerName}, ${installerName}.sig and latest.json onto the ${tag} draft: https://github.com/${repo}/releases`);
const platforms = Object.keys(latest.platforms);
if (fetched) {
  console.log(`  latest.json was merged with the draft's, and covers ${platforms.join(", ")}. Replace the draft's copy with this one.`);
} else {
  console.log(`  latest.json covers only ${platforms.join(", ")}: it couldn't be merged with the draft's (gh missing, signed out, or no latest.json there yet).`);
  console.log("  If the draft already has the Mac's latest.json, don't replace it with this one; run this script again once gh works.");
  console.log("  Otherwise upload this one, then run npm run release:mac, which adds the Mac entries to it.");
}
