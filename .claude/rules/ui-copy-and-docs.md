---
paths:
  - "src/components/**"
  - "src/lib/actions.tsx"
  - "src/store/toasts.ts"
  - "README.md"
  - "docs/**"
  - "gumroad/**"
  - ".github/RELEASE_TEMPLATE.md"
---

# Words in the app and in the docs

Saga talks to music producers, not developers. Match the voice already in the README, the
Settings hints and the toasts.

## Voice
- Plain, short and concrete. Say what happens, from the user's side: "Previews a sample as soon as
  you select it," not "Enables autoplay on selection change."
- Sentence case for every label, button, menu item and heading ("Find similar sounds", "Clear old
  renders…"). Product nouns are capitalized only when they're names: the Lab, Settings, Renders.
- Use the user's words: sample, loop, one-shot, pack, folder, library, project tempo / key, sound
  map, collection, saved sounds folder, render, variation. Never surface internal names like
  source, chroma, features, scratch, pc, mode 0/1, or FTS.
- Contractions are fine and expected ("Couldn't", "isn't", "you'd").
- Errors start with "Couldn't …" and give the cause in plain words when it's known:
  `Couldn't render: ${errorMessage(e)}`. Confirmations are short and in the past tense ("Path
  copied", "Updated 12 samples") and use the `"info"` tone.
- An ellipsis character (`…`, not `...`) marks a menu item or button that opens a dialog or
  prompt before acting ("Rename…", "Set tempo…", "New collection…").
- Counts use `toLocaleString("en-US")` and singular/plural ("1 sample", "1,204 samples"). Reuse
  `count()` in actions.tsx or the formatters in `lib/format.ts`.
- Shortcuts in text: `modKey` for ⌘/Ctrl, the symbols ⇧ ← → ↑ ↓ ⌫, and a bare letter for single
  keys. Labels that have a key end with it in parentheses: "Reverse (R)".
- Estimated values carry ≈ (`≈123.8`, `≈Am`). Keep that marker wherever detected values show.

## Docs that must move with the code
| When you change… | Update |
| --- | --- |
| a user-facing feature | README "Features" (and a screenshot note if the UI changed noticeably) |
| a keyboard shortcut | README tables + Settings `SHORTCUTS` + tooltips/menu hints (see keyboard-shortcuts.md) |
| search syntax (`query.rs`) | README "Search syntax" table |
| a module, store or folder | docs/DEVELOPMENT.md "Layout" |
| a test area or report | docs/DEVELOPMENT.md "Tests" |
| the release flow or scripts | docs/DEVELOPMENT.md "Releasing", and the header comment of `.github/workflows/release.yml` |
| a product promise (files, privacy, deletion) | README "Why Saga", the Welcome screen and the matching Settings text, which all say the same thing |

README screenshots in `docs/screenshots/*.webp` come from the mock backend (`npm run dev`), in
both themes for the hero. The Gumroad assets are 1280 px copies of them. Gumroad's page cap is
500,000 characters (see DEVELOPMENT.md).
