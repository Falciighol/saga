// Builds the notarized macOS release on this Mac and adds it to the version's draft GitHub
// release (opened by .github/workflows/release.yml), next to the Windows build from
// `npm run release:windows`.
//   npm run release:mac
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
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const updaterKey = join(homedir(), ".tauri", "saga_updater.key");
const target = "universal-apple-darwin";
const notes = "Download the installer for your computer below. If Saga is already installed, it will offer this update on its own.";

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
  fail(`gh can't reach ${repo}. Sign in with an account that can (gh auth switch).`);
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

// Both architectures update from the one universal bundle.
const staging = mkdtempSync(join(tmpdir(), "saga-release-"));
const archiveName = "Saga_universal.app.tar.gz";
copyFileSync(archive, join(staging, archiveName));
copyFileSync(`${archive}.sig`, join(staging, `${archiveName}.sig`));
const signature = readFileSync(`${archive}.sig`, "utf8").trim();

// The workflow opens the draft; don't race it into opening a second one.
step("Waiting for any running Release workflow");
for (;;) {
  const running = ["in_progress", "queued"].flatMap((status) =>
    JSON.parse(run("gh", ["run", "list", "-R", repo, "--workflow", "release.yml", "--status", status, "--json", "databaseId"]) || "[]"),
  );
  if (!running.length) break;
  console.log(`  ${running.length} running; checking again in 30 s`);
  spawnSync("sleep", ["30"]);
}

step(`Adding the Mac build to the ${tag} draft`);
const release = run("gh", ["api", `repos/${repo}/releases`, "--paginate", "--jq", `.[] | select(.tag_name == "${tag}") | .draft`]).split("\n")[0];
if (release === "false") fail(`${tag} is already published. Bump the version with npm run set-version -- <x.y.z>.`);
if (!release) {
  run("gh", ["release", "create", tag, "-R", repo, "--draft", "--target", sha, "--title", `Saga ${version}`, "--notes", notes]);
  console.log("  opened the draft; add the Windows build with npm run release:windows");
}
run("gh", ["release", "upload", tag, "-R", repo, "--clobber", dmg, join(staging, archiveName), join(staging, `${archiveName}.sig`)], { inherit: true });

const latestPath = join(staging, "latest.json");
const downloaded = run("gh", ["release", "download", tag, "-R", repo, "-p", "latest.json", "-D", staging], { allowFail: true }) != null;
const latest = downloaded && existsSync(latestPath)
  ? JSON.parse(readFileSync(latestPath, "utf8"))
  : { version, notes: "", pub_date: new Date().toISOString(), platforms: {} };
latest.version = version;
const url = `https://github.com/${repo}/releases/download/${tag}/${archiveName}`;
for (const platform of ["darwin-aarch64", "darwin-x86_64"]) latest.platforms[platform] = { signature, url };
writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
run("gh", ["release", "upload", tag, "-R", repo, "--clobber", latestPath], { inherit: true });

console.log(`\n✓ Saga ${version} for Mac is on the ${tag} draft. latest.json covers ${Object.keys(latest.platforms).join(", ")}.`);
console.log(`  Check the draft, then publish it: https://github.com/${repo}/releases`);
