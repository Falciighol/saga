export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/** Windows draws no title bar for us, so the app shows its own caption buttons. */
export const isWindows = typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);

export const modKey = isMac ? "⌘" : "Ctrl";

/** True when the keyboard event used the platform's primary modifier. */
export function hasMod(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

export function isTextInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return !["checkbox", "radio", "range", "button", "submit"].includes(el.type);
  }
  return false;
}

export function revealLabel(): string {
  return isMac ? "Reveal in Finder" : "Show in folder";
}
