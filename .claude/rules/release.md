---
paths:
  - "scripts/**"
  - ".github/**"
  - "package.json"
  - "src-tauri/Cargo.toml"
  - "src-tauri/tauri.conf.json"
  - "src-tauri/tauri.*.conf.json"
  - "src-tauri/Entitlements.plist"
  - "src-tauri/Info.plist"
---

# Versions, builds and releases

The full procedure is in docs/DEVELOPMENT.md "Releasing". The parts that are easy to break:

- **The version lives in four files** (`package.json`, `tauri.conf.json`, `Cargo.toml`,
  `Cargo.lock`). Change it only with `npm run set-version -- x.y.z`, which edits all four,
  **commits and tags `vX.Y.Z`** (pass `--no-git` to only edit). CI runs
  `node scripts/version.mjs --check` and rejects a tag that disagrees.
- **The Mac updater downloads `Saga_universal.app.tar.gz`** from the release, and `latest.json`'s
  darwin entries point at it. `release-mac.mjs` must keep uploading it next to the .dmg.
- **Never push tags, publish a release, or run `release:*` / `gumroad:publish` unless asked.**
  They reach users. The draft release from the workflow becomes live only when someone publishes
  it by hand.
- **The updater:** `plugins.updater.pubkey` and `endpoints` in `tauri.conf.json` must not change
  without the user's say-so. A wrong key means installed copies can never update again. The
  private key is never in the repo. Updater artifacts are built only with
  `--config src-tauri/tauri.release.conf.json`.
- **Platform configs:** `tauri.windows.conf.json` replaces the window definition on Windows
  (`decorations: false`, so the app draws its own caption buttons in `WindowControls.tsx`). If you
  change a window size or minimum in `tauri.conf.json`, mirror it there. macOS uses the overlay
  title bar (`trafficLightPosition` 16/26, which the TitleBar layout depends on).
- **Capabilities:** new plugin permissions go in `src-tauri/capabilities/default.json`. Keep them
  minimal (allow specific window ops, not `core:window:default` wholesale).
- **macOS:** `Entitlements.plist` keeps the microphone working under the hardened runtime (Find by
  recording). `scripts/tauri.mjs` puts `scripts/macos/actool` on the PATH for the Icon Composer
  icon. Don't call `tauri` directly on macOS.
- **The release scripts** (`release-mac.mjs`, `release-windows.mjs`) require a clean, pushed tree,
  merge into the draft's existing `latest.json`, and must keep working when `gh` fails partway
  (they list what's left to do by hand). Keep both properties when you edit them.
- **The repository must stay public**, because the app fetches `latest.json` and bundles without
  credentials.
- `gumroad/landing.html` is generated (and gitignored). Edit `gumroad/landing.src.html`.
