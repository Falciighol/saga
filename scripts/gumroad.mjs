// Builds the Gumroad landing page and previews or publishes it with the Gumroad CLI.
//   node scripts/gumroad.mjs build     write gumroad/landing.html (screenshots inlined as data: URIs)
//   node scripts/gumroad.mjs preview   build, then run Gumroad's sanitizer without publishing
//   node scripts/gumroad.mjs publish   build, preview, and publish only if nothing was stripped
//
// Gumroad caps the page at 500,000 characters, so gumroad/assets holds 1280px copies of the
// docs/screenshots images. The page can't load anything from outside, so they're inlined.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PRODUCT = "qihzlk";
const LIMIT = 500_000;
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "gumroad");
const out = join(dir, "landing.html");

function build() {
  const html = readFileSync(join(dir, "landing.src.html"), "utf8").replace(/\{\{([a-z-]+)\}\}/g, (_, name) =>
    "data:image/webp;base64," + readFileSync(join(dir, "assets", `${name}.webp`)).toString("base64"),
  );
  if (html.length > LIMIT) {
    console.error(`landing.html is ${html.length} characters; Gumroad's limit is ${LIMIT}.`);
    process.exit(1);
  }
  writeFileSync(out, html);
  console.log(`${html.length} characters\tgumroad/landing.html`);
}

// The installer puts the CLI in ~/.local/bin, which isn't always on PATH.
function gumroad(...args) {
  const local = join(homedir(), ".local", "bin", process.platform === "win32" ? "gumroad.exe" : "gumroad");
  const bin = existsSync(local) ? local : "gumroad";
  const res = JSON.parse(execFileSync(bin, [...args, "--json", "--no-input", "--non-interactive"], { encoding: "utf8", maxBuffer: 64 << 20 }));
  if (!res.success) {
    console.error(res.error?.message ?? JSON.stringify(res));
    process.exit(1);
  }
  return res;
}

function check(res, step) {
  const report = res.sanitization_report;
  if (res.warning) console.error(`${step}: ${res.warning}`);
  for (const t of report.removed_tags) console.error(`${step}: removed <${t.tag}> (${t.reason})`);
  for (const a of report.removed_attributes) console.error(`${step}: removed ${a.attribute} on <${a.tag}> (${a.reason})`);
  const clean = !res.warning && report.total_removed === 0;
  console.log(`${step}: ${clean ? "clean" : "not clean"}`);
  return clean;
}

const cmd = process.argv[2];
if (!["build", "preview", "publish"].includes(cmd)) {
  console.error("Usage: node scripts/gumroad.mjs build|preview|publish");
  process.exit(1);
}
build();
if (cmd === "build") process.exit(0);
if (!check(gumroad("products", "page", "preview", PRODUCT, out), "preview")) process.exit(1);
if (cmd === "preview") process.exit(0);
check(gumroad("products", "page", "publish", PRODUCT, out), "publish");
console.log(gumroad("products", "page", "url", PRODUCT).product.landing_url);
