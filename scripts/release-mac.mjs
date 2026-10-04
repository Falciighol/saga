// Builds the notarized macOS release on this Mac and adds it to the version's draft GitHub
// release (opened only by .github/workflows/release.yml; this
// script never creates a release), next to the Windows build from
// `npm run release:windows`.
//   npm run release:mac
//
// The files to upload are also collected in release-mac/. If gh fails at any point, the script says
// what is still missing on the draft so you can finish by hand.
//
// One universal app (Apple Silicon and Intel), signed with the Developer ID Application
// certificate in your login keychain and notarized by Apple. Uploads the .dmg and the signed
// update bundle, then adds darwin-aarch64 and darwin-x86_64 to the release's latest.json.
//
// Notarization credentials, first found wins:
//   - APPLE_API_KEY + APPLE_API_ISSUER (the .p8 in ~/.private_keys or ~/.appstoreconnect/private_keys)
//   - APPLE_ID + APPLE_PASSWORD (+ APPLE_TEAM_ID) in the environment
//   - a keychain item named "saga-notarize" holding your Apple ID and an app-specific password:
//       security add-generic-password -s saga-notarize -a you@example.com -w
//     (it asks for the password; the team ID comes from the certificate)
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseNotes } from "./release-notes.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const updaterKey = join(homedir(), ".tauri", "saga_updater.key");
const target = "universal-apple-darwin";

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

if (process.platform !== "darwin") fail("Run this on a Mac.");

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
if (run("gh", ["api", `repos/${repo}`, "--jq", ".full_name"], { allowFail: true }) == null) {
  console.log(`  warning: gh can't reach ${repo} (gh auth switch?). The build goes ahead; you'll get a list of what to upload by hand.`);
}
if (!existsSync(updaterKey)) fail(`The updater key isn't at ${updaterKey}.`);

step("Finding the signing identity and notarization credentials");
const identities = [...run("security", ["find-identity", "-v", "-p", "codesigning"]).matchAll(/"(Developer ID Application: .+?)"/g)].map((m) => m[1]);
const identity = process.env.APPLE_SIGNING_IDENTITY ?? (identities.length === 1 ? identities[0] : null);
if (!identity) {
  fail(identities.length
    ? `Several Developer ID certificates found; pick one with APPLE_SIGNING_IDENTITY:\n  ${identities.join("\n  ")}`
    : "No Developer ID Application certificate in your keychain. Create one at developer.apple.com › Certificates.");
}
const env = { ...process.env, APPLE_SIGNING_IDENTITY: identity, TAURI_SIGNING_PRIVATE_KEY: updaterKey };
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
// With these set, Tauri would import a certificate into a temporary keychain instead of using yours.
delete env.APPLE_CERTIFICATE;
delete env.APPLE_CERTIFICATE_PASSWORD;
if (env.APPLE_API_KEY && env.APPLE_API_ISSUER) {
  console.log(`  notarizing with App Store Connect API key ${env.APPLE_API_KEY}`);
} else {
  if (!env.APPLE_ID || !env.APPLE_PASSWORD) {
    const item = run("security", ["find-generic-password", "-s", "saga-notarize"], { allowFail: true });
    const account = item?.match(/"acct"<blob>="(.+?)"/)?.[1];
    if (!account) {
      fail("No notarization credentials. Save your Apple ID and an app-specific password (from account.apple.com) once with:\n  security add-generic-password -s saga-notarize -a you@example.com -w");
    }
    env.APPLE_ID = account;
    env.APPLE_PASSWORD = run("security", ["find-generic-password", "-s", "saga-notarize", "-a", account, "-w"]);
  }
  env.APPLE_TEAM_ID ??= identity.match(/\(([A-Z0-9]{10})\)$/)?.[1] ?? fail("Set APPLE_TEAM_ID; it isn't in the certificate's name.");
  console.log(`  notarizing as ${env.APPLE_ID} (team ${env.APPLE_TEAM_ID})`);
}
console.log(`  signing with ${identity}`);

step("Building, signing and notarizing (this takes a while)");
run("rustup", ["target", "add", "aarch64-apple-darwin", "x86_64-apple-darwin"]);
run("node", ["scripts/tauri.mjs", "build", "--target", target, "--bundles", "app,dmg", "--config", "src-tauri/tauri.release.conf.json"], { env, inherit: true });

const bundle = join(root, "src-tauri", "target", target, "release", "bundle");
const app = join(bundle, "macos", "Saga.app");
const dmg = join(bundle, "dmg", `Saga_${version}_universal.dmg`);
const archive = join(bundle, "macos", "Saga.app.tar.gz");
for (const f of [app, dmg, archive, `${archive}.sig`]) if (!existsSync(f)) fail(`The build didn't make ${f}`);

step("Checking the app passes Gatekeeper");
const gatekeeper = spawnSync("spctl", ["--assess", "--type", "execute", "-vv", app], { encoding: "utf8" });
if (gatekeeper.status !== 0 || !/Notarized Developer ID/.test(gatekeeper.stderr)) fail(`Gatekeeper rejected the app:\n${gatekeeper.stderr}`);
run("xcrun", ["stapler", "validate", app]);
console.log("  accepted: notarized Developer ID, ticket stapled");

// Everything to upload is collected in release-mac/ before gh is touched, so a gh failure never costs
// the build: whatever gh couldn't do is listed at the end for you to finish by hand.
// Both architectures update from the one universal bundle.
const out = join(root, "release-mac");
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const archiveName = "Saga_universal.app.tar.gz";
const dmgName = basename(dmg);
copyFileSync(dmg, join(out, dmgName));
const signature = readFileSync(`${archive}.sig`, "utf8").trim();
const assets = [dmgName];

/** Runs gh without stopping the script; null means it failed. */
const gh = (args, opts = {}) => run("gh", args, { allowFail: true, ...opts });

// What is left for you to do by hand.
const todo = { publishedAlready: false, draft: false, uploads: false, latest: "" };

step(`Adding the Mac build to the ${tag} draft`);
const found = gh(["api", `repos/${repo}/releases`, "--paginate", "--jq", `.[] | select(.tag_name == "${tag}") | (.id | tostring) + " " + (.draft | tostring)`]);
const [releaseId, isDraft] = (found ?? "").split("\n")[0].split(" ");
let existing = null; // asset names already on the draft, once known
if (found == null) {
  console.log("  gh couldn't list the releases");
  Object.assign(todo, { draft: true, uploads: true, latest: "unmerged" });
} else if (releaseId && isDraft !== "true") {
  fail(`${tag} is already published. Bump the version with npm run set-version -- <x.y.z>. The build is in ${out}.`);
} else {
  if (!releaseId) {
    fail(`There's no ${tag} draft. Run the Release workflow first (push the ${tag} tag, or run it from the Actions tab), then run this again. The build is in ${out}.`);
  }
  existing = gh(["api", `repos/${repo}/releases/${releaseId}`, "--jq", ".assets[].name"])?.split("\n").filter(Boolean) ?? null;
}

if (!todo.uploads) {
  if (gh(["release", "upload", tag, "-R", repo, "--clobber", ...assets.map((f) => join(out, f))], { inherit: true }) == null) {
    console.log("  gh couldn't upload the installer");
    todo.uploads = true;
  }
}

// latest.json: start from the draft's (it may hold Windows) so its entries carry over.
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
const url = `https://github.com/${repo}/releases/download/${tag}/${archiveName}`;
for (const platform of ["darwin-aarch64", "darwin-x86_64"]) latest.platforms[platform] = { signature, url };
const latestPath = join(out, "latest.json");
writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
if (!todo.latest) {
  if (gh(["release", "upload", tag, "-R", repo, "--clobber", latestPath], { inherit: true }) == null) {
    console.log("  gh couldn't upload latest.json");
    todo.latest = "merged";
  }
}

const releasesUrl = `https://github.com/${repo}/releases`;
if (!todo.draft && !todo.uploads && !todo.latest) {
  console.log(`\n✓ Saga ${version} for Mac is on the ${tag} draft. latest.json covers ${Object.keys(latest.platforms).join(", ")}.`);
  console.log(`  Check the draft, then publish it: ${releasesUrl}`);
} else {
  process.exitCode = 1;
  console.log(`\n! The build is done and its files are in ${out}, but gh couldn't finish. Still to do by hand at ${releasesUrl}:`);
  let n = 0;
  if (todo.draft) {
    console.log(`  ${++n}. Make sure the ${tag} draft exists. Only the Release workflow opens it; run it from the Actions tab if it hasn't.`);
  }
  if (todo.uploads) console.log(`  ${++n}. Upload ${assets.join(", ")} from ${out} to the draft.`);
  if (todo.latest === "merged") {
    console.log(`  ${++n}. Upload ${latestPath} to the draft, replacing its latest.json. It is already merged with the draft's.`);
  } else if (todo.latest === "unmerged") {
    console.log(`  ${++n}. latest.json: if the draft has none, upload ${latestPath}. If it has one (from the Windows build), edit that one instead:`);
    console.log(`     download it, copy the darwin-aarch64 and darwin-x86_64 entries under "platforms" from ${latestPath} into it,`);
    console.log("     and upload the result over the draft's copy. Its \"version\" must be " + `"${version}".`);
  }
  console.log(`  ${++n}. Check the draft lists the .dmg, the Windows setup .exe and a latest.json with darwin-aarch64, darwin-x86_64 and windows-x86_64, then publish it.`);
}
