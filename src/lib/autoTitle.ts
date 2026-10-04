/**
 * Shows the full text of anything the UI has cut short with an ellipsis, as a native tooltip.
 *
 * One delegated listener instead of a `title` on every `truncate` element: the tooltip is added on
 * hover, only while the text really is cut off, so nothing changes for text that fits. Elements
 * that already carry their own `title` (or sit inside one) are left alone, and `data-no-auto-title`
 * on an element or an ancestor opts out.
 */
const AUTO = "data-auto-title";
const MAX_DEPTH = 4;

function ellipsized(start: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = start;
  for (let i = 0; el && i < MAX_DEPTH; i++, el = el.parentElement) {
    if (getComputedStyle(el).textOverflow === "ellipsis") return el;
  }
  return null;
}

function onOver(e: MouseEvent) {
  if (!(e.target instanceof HTMLElement)) return;
  const el = ellipsized(e.target);
  if (!el) return;
  const ours = el.hasAttribute(AUTO);
  if (!ours && el.closest("[title], [data-no-auto-title]")) return;
  const text = el.scrollWidth > el.clientWidth ? (el.textContent ?? "").replace(/\s+/g, " ").trim() : "";
  if (text) {
    el.title = text;
    el.setAttribute(AUTO, "");
  } else if (ours) {
    // The node was reused for shorter text (or the pane got wider): drop the stale tooltip.
    el.removeAttribute("title");
    el.removeAttribute(AUTO);
  }
}

export function installAutoTitle() {
  document.addEventListener("mouseover", onOver, { passive: true });
}
