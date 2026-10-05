---
name: release
description: Ship a new version of Saga. Checks the changelog against what changed, sets the version, opens the draft GitHub release and hands off the Mac and Windows builds. Only runs when the user types /release.
argument-hint: "[x.y.z]"
disable-model-invocation: true
---

# Release a version of Saga

The procedure behind "Releasing" in docs/DEVELOPMENT.md, with the release notes written along the way. Follow the steps in
order. **Stop and ask** wherever a step says so: pushing, building for release and publishing reach users, and a tag
can't be taken back cleanly once installed copies have seen it.

Never publish the release, move or delete a pushed tag, force-push, or change the updater `pubkey`/endpoints. Those
stay the user's.

## 1. Check the ground

- On `main`, up to date with `origin/main` (`git fetch`, then `git status -sb`).
- Clean tree. The release scripts refuse a dirty one. `.impeccable/hook.cache.json` is rewritten by the design hook
  and is the usual culprit: ask whether to commit it or `git checkout` it.
- The last release: `git tag --list 'v*' --sort=-v:refname | head -1`. Read `package.json` for the current version.

## 2. Make the notes complete

1. `git log <last tag>..HEAD` (with bodies) and read `## Unreleased` in CHANGELOG.md.
2. List the user-facing commits with no entry, and entries with no commit behind them. Skip refactors, docs, tooling,
   CI and dependency bumps users can't notice. A dependency bump that fixes something they could hear or see counts.
3. Look for things that belong in **Good to know**:
   - `analysis::VERSION` changed in `src-tauri/src/analysis.rs` (the whole library is listened to again) or
     `DECODE_VERSION` (files that failed are retried).
   - A shortcut changed or went away.
   - A persisted setting was renamed or reset, or a feature was removed.
   - Anything that changes files on disk.
4. Check every claim against the code before writing it: what the user clicks, the label it has, the key. Don't
   describe a feature from a commit title alone.
5. Write in the voice from `.claude/rules/ui-copy-and-docs.md` and the format in the CHANGELOG.md header comment:
   a one-sentence headline, then `Good to know`, `New`, `Improved`, `Fixed`, with keys in backticks (`` `Mod ⇧ F` ``).

## 3. Agree on the version and the words

Propose the version (the next patch unless the user says otherwise; `$ARGUMENTS` wins when given) and show the
finished `## Unreleased` section. **Wait for approval.** The tagged commit's CHANGELOG.md is what the app shows after
the update, so the wording is final once it's tagged.

Commit the edits: `docs(changelog): notes for x.y.z`.

## 4. Set the version

```bash
npm run set-version -- x.y.z
```

It dates the notes (`## x.y.z — <today>`), writes the version to the four files, commits them with the changelog and
tags `vX.Y.Z`. If it says there are no notes, go back to step 2. Then confirm `node scripts/version.mjs --check` and
`node scripts/release-notes.mjs x.y.z` read well.

## 5. Push (ask first)

**Ask before running** `git push origin main vX.Y.Z`. It starts the Release workflow, which opens the draft.

Then check on it: `gh run list --workflow release.yml -L 1` and, once it runs, `gh run watch <id> --exit-status`
(with a timeout). If it sits queued with no runner for more than a couple of minutes, or fails, offer to open the
draft by hand, which is all the workflow does:

```bash
node scripts/release-notes.mjs x.y.z > <scratchpad>/notes-x.y.z.md
gh release create vX.Y.Z --draft --verify-tag --title "Saga x.y.z" --notes-file <scratchpad>/notes-x.y.z.md
```

Check first that no release exists for the tag (`gh release view vX.Y.Z`). The workflow skips an existing draft, so
re-running it later is safe.

## 6. Builds (the user's machines)

- Mac: `npm run release:mac`. It signs, notarizes and uploads. Run it only if the user asks, on their Mac.
- Windows: `npm run release:windows` on the Windows PC. Remind the user, since it can't run from here.

## 7. Before publishing

Give the user this checklist for the draft, and leave publishing to them:

- [ ] `Saga_x.y.z_universal.dmg`
- [ ] `Saga_universal.app.tar.gz` (what the Mac updater downloads)
- [ ] `Saga_x.y.z_x64-setup.exe`
- [ ] `latest.json` listing `darwin-aarch64`, `darwin-x86_64` and `windows-x86_64`
- [ ] "What's new" reads right

Wording fixed after tagging: edit the draft's text, and fix CHANGELOG.md too, so the app has it right from the next
version on.
