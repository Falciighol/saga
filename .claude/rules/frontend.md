---
paths:
  - "src/**"
  - "index.html"
  - "vite.config.ts"
  - "tsconfig.json"
---

# Frontend conventions (React 19, Zustand 5, Tailwind 4, TypeScript strict)

## Structure
- `src/components/`: one main component per file, PascalCase, plus small private helpers in the
  same file. Lab UI lives in `components/lab/`. Shared primitives are in `components/ui.tsx`
  (`cx`, `Switch`, `Segmented`, `Chip`, `IconButton`, `SectionLabel`, `Divider`, `Kbd`), and `Popover.tsx`,
  `Menu.tsx` (`openContextMenu`, `openMenuBelow`) and `Prompt.tsx` (`usePrompt`, confirm) cover
  overlays. Use these before writing a new button, toggle, menu or modal.
- `src/store/`: one Zustand store per domain (`useX = create<XState>(…)`). Cross-store reads use
  `useOther.getState()` inside actions, never hooks. Exported helper functions next to the store
  (`targetIds`, `editFor`, `shouldLoop`, `paramsFor`) are fine. Keep them pure or clearly named
  for their side effect.
- `src/lib/`: framework-free logic (theory, processing, format, rename, keys) plus `api.ts` and
  `actions.tsx`. User actions that several places trigger (a button, a menu item, a hotkey) go in
  `lib/actions.tsx` as one function that all of them call.
- `src/hooks/`: app-level hooks (`useHotkeys`, `useThemeSync`).
- `src/dev/mockBackend.ts`: dev only, loaded by `main.tsx` when not running in Tauri. Never import
  it from app code.
- Size: `SoundMap`, `Editor`, `SettingsDialog`, `PreviewPanel` and `mockBackend` are already 600 to
  900 lines. For a substantial addition, put the new part in its own file (for example a
  `settings/` subfolder, one file per section) instead of growing them further. Don't split
  existing files unprompted.

## State
- Component subscriptions select narrowly: `useBrowse((s) => s.total)`, not `useBrowse()`.
  Whole-store subscriptions (like `usePrefs()` in SettingsDialog) are fine only where the
  component really uses most of it.
- Event handlers and effects read fresh state with `useX.getState()`, which avoids stale closures
  and long dependency lists.
- Persisted stores (`persist`, names `saga-prefs`, `saga-project`, `saga-lab`) use `partialize` to
  drop functions and transient fields. **Target practice:** when you rename, remove or change the
  type of a persisted field, add `version` and `migrate` to that store's `persist` options. None
  have them yet, and a silent shape change corrupts users' saved settings. Adding a field with a
  default needs no migration. Put the default in `DEFAULT_PREFS` (or the initial state).
- Per-sample edits (`useEdits`) are session-only on purpose. Don't persist them.
- A new user preference goes in `PrefValues` with a doc comment, a default in `DEFAULT_PREFS`, and
  a Settings row with a `hint`.

## Async and errors
- Show failures with `toast(errorMessage(e))` (`store/toasts.ts`). Use `toast(msg, "info")` for
  confirmations, and add an `action` (such as Undo) when the user can reverse it.
- Drop stale responses. `useBrowse` does this with `queryKey`/`version`, so follow that pattern for
  any query the user can re-trigger quickly.
- Debounce engine updates the way `startParamsSync` does (25 ms). Never call `api.setParams` on
  every pointer move without one.

## Styling
- Tailwind utilities with the theme tokens from `index.css` `@theme`: colors `bg panel raised
  raised2 seg line line2 text text2 text3 accent accent-ink accent-soft on-accent`, text sizes
  `text-micro/small/ui/body/title`, `font-sans`/`font-mono`, `shadow-pop`. **Never hardcode
  colors.** Palette values come from `lib/theme.ts` (`applyPalette`), and canvas drawing reads
  `usePalette()`.
- Numbers (tempo, key, time, paths) use `font-mono` and `tabular`.
- Combine classes with `cx(...)`. Inline `style` is only for computed values (sizes, transforms,
  CSS variables).
- Use container queries (`@container` on `<main>`) for responsive bits. The window can be the
  mini player (about 400 px) or zoomed from 75% to 200% (`uiScale`).
- New CSS animations get a class in `index.css` and an entry in its
  `prefers-reduced-motion: reduce` block.
- Use `lucide-react` icons at `size={14}` in menus and about 16 in buttons, matching the
  neighbours.

## Accessibility
- Icon-only buttons use `IconButton` (it sets `aria-label` and `title`). Toggles set
  `aria-pressed`, switches `role="switch"`, and overlays `role="dialog"` (this also pauses global
  hotkeys).
- Anything clickable that isn't a `<button>` needs a role, `tabIndex` and an Enter/Space handler
  (see KeyWheel).
- Truncated text gets an automatic tooltip from `lib/autoTitle.ts`. Don't add `title` just to
  repeat visible text.

## Platform
- Use `isMac`/`isWindows` from `lib/platform.ts`. Windows draws its own caption buttons
  (`WindowControls`), and macOS uses the overlay title bar with traffic lights at x=16, y=26.
- In production the web view's own context menu is suppressed in `App.tsx`. Right-click menus go
  through `openContextMenu`.

## Verifying in the browser pane
- Start the `saga-ui` launch config (port 1420). The mock backend serves fake samples, so lists,
  menus, the map and the Lab all work. Native-only behavior (drag to DAW, audio, file dialogs,
  window mode) can't be checked there. Say so instead of claiming it works.
- `resize_window` below 768 px won't give a narrow layout. To test the mini player, add a fixed
  400×600 `<iframe src="/">` to the page and call `useUi.getState().setMini(true)` in the frame.
  Drive the real UI with dispatched events, because a fresh `import()` of a store after HMR is a
  different instance.
- Check both themes (`prefs.theme`) and at least one non-default accent when you touch colors.

## Tests (target practice)
There are no frontend tests. Pure modules in `src/lib` (`theory`, `rename`, `processing`,
`format`, `keys`, `progressions`) are the natural first candidates for Vitest. Propose adding it
before writing tests, and don't add the dependency without asking. Until then, cover logic that
also exists in Rust through the Rust tests.
