// Builds the Windows release on this PC and adds it to the version's draft GitHub
// release (opened only by .github/workflows/release.yml), next to the Mac build from `npm run release:mac`.
//   npm run release:windows
//
// One NSIS installer, not code-signed (Windows shows SmartScreen's "unknown publisher" warning), plus
// the updater's signature for it. Both are uploaded to the draft, and its latest.json gets a
// windows-x86_64 entry. If the draft already has a latest.json (the Mac's), that one is the starting
// point so its entries survive, in whichever order the two builds are made. This script never creates
// a release. The files are also kept in release-windows/; if gh fails, the script says what is still
// missing on the draft so you can finish by hand.
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

/** Runs gh without stopping the script; null means it failed. */
const gh = (args, opts = {}) => run("gh", args, { allowFail: true, ...opts });

// What is left for you to do by hand.
const todo = { uploads: false, latest: "" };
const releasesUrl = `https://github.com/${repo}/releases`;

step(`Adding the Windows build to the ${tag} draft`);
const found = gh(["api", `repos/${repo}/releases`, "--paginate", "--jq", `.[] | select(.tag_name == "${tag}") | (.id | tostring) + " " + (.draft | tostring)`]);
const [releaseId, isDraft] = (found ?? "").split("\n")[0].split(" ");
let existing = null; // asset names already on the draft, once known
if (found == null) {
  console.log("  gh couldn't list the releases");
  Object.assign(todo, { uploads: true, latest: "unmerged" });
} else if (releaseId && isDraft !== "true") {
  fail(`${tag} is already published. Bump the version with npm run set-version -- <x.y.z>. The build is in ${out}.`);
} else if (!releaseId) {
  fail(`There's no ${tag} draft. Wait for the Release workflow to open it (push the ${tag} tag, or run it from the Actions tab), then run this again. The build is in ${out}.`);
} else {
  existing = gh(["api", `repos/${repo}/releases/${releaseId}`, "--jq", ".assets[].name"])?.split("\n").filter(Boolean) ?? null;
}

if (!todo.uploads) {
  if (gh(["release", "upload", tag, "-R", repo, "--clobber", join(out, installerName), join(out, `${installerName}.sig`)], { inherit: true }) == null) {
    console.log("  gh couldn't upload the installer");
    todo.uploads = true;
  }
}

// latest.json: start from the draft's (it may hold the Mac) so its entries carry over.
let latest = { version, notes: "", pub_date: new Date().toISOString(), platforms: {} };
if (!todo.latest) {
  if (existing?.includes("latest.json")) {
    const staging = mkdtempSync(join(tmpdir(), "saga-release-"));
    const fetched = gh(["release", "download", tag, "-R", repo, "-p", "latest.json", "-D", staging]) != null;
    if (fetched) latest = JSON.parse(readFileSync(join(staging, "latest.json"), "utf8"));
    else todo.latest = "unmerged";
    rmSync(staging, { recursive: true, force: true });
  } else if (existing == null) {
    todo.latest = "unmerged"; // couldn't tell whether the draft has one
  }
}
latest.version = version;
latest.platforms[platform] = { signature, url: `https://github.com/${repo}/releases/download/${tag}/${installerName}` };
const latestPath = join(out, "latest.json");
writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
if (!todo.latest) {
  if (gh(["release", "upload", tag, "-R", repo, "--clobber", latestPath], { inherit: true }) == null) {
    console.log("  gh couldn't upload latest.json");
    todo.latest = "merged";
  }
}

if (!todo.uploads && !todo.latest) {
  console.log(`\n✓ Saga ${version} for Windows is on the ${tag} draft. latest.json covers ${Object.keys(latest.platforms).join(", ")}.`);
  console.log(`  Add the Mac build with npm run release:mac if it isn't there yet, check the draft, then publish it: ${releasesUrl}`);
} else {
  process.exitCode = 1;
  console.log(`\n! The build is done and its files are in ${out}, but gh couldn't finish. Still to do by hand at ${releasesUrl}:`);
  let n = 0;
  if (todo.uploads) console.log(`  ${++n}. Upload ${installerName} and ${installerName}.sig from ${out} to the ${tag} draft (the Release workflow opens it).`);
  if (todo.latest === "merged") {
    console.log(`  ${++n}. Upload ${latestPath} to the draft, replacing its latest.json. It is already merged with the draft's.`);
  } else if (todo.latest === "unmerged") {
    console.log(`  ${++n}. latest.json: if the draft has none, upload ${latestPath}. If it has one (from the Mac build), edit that one instead:`);
    console.log(`     download it, copy the "${platform}" entry under "platforms" from ${latestPath} into it,`);
    console.log(`     and upload the result over the draft's copy. Its "version" must be "${version}".`);
  }
  console.log(`  ${++n}. Check the draft lists the .dmg, the Windows setup .exe and a latest.json with darwin-aarch64, darwin-x86_64 and windows-x86_64, then publish it.`);
}
