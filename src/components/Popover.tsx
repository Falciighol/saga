import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./ui";

/** A trigger with a panel that opens below it (nudged sideways to stay in the window) and closes on outside click or Escape. */
export function Popover({
  trigger,
  children,
  align = "left",
  side = "below",
  openOn,
  className,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right" | "center";
  /** "above" is for triggers near the bottom of the window, such as the preview panel's. */
  side?: "below" | "above";
  /** A window event that opens it from elsewhere, such as Match asking for a project key. */
  openOn?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // In a narrow window (the mini player) a panel aligned to its trigger can hang off an edge.
  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      const el = panel.current;
      const anchor = box.current;
      if (!el || !anchor) return;
      el.style.left = el.style.right = el.style.translate = "";
      const r = el.getBoundingClientRect();
      const width = el.offsetWidth;
      // The pop-in animation scales from the center; use the unscaled edges.
      const left = r.left + (r.width - width) / 2;
      const m = 8;
      const fitted = Math.max(m, Math.min(left, window.innerWidth - m - width));
      if (fitted === left) return;
      el.style.left = `${fitted - anchor.getBoundingClientRect().left}px`;
      el.style.right = "auto";
      el.style.translate = "none";
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);

  useEffect(() => {
    if (!openOn) return;
    const onOpen = () => setOpen(true);
    window.addEventListener(openOn, onOpen);
    return () => window.removeEventListener(openOn, onOpen);
  }, [openOn]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          ref={panel}
          role="dialog"
          className={cx(
            "animate-pop absolute z-40 rounded-xl border border-line2 bg-panel shadow-pop",
            side === "below" ? "top-full mt-1.5" : "bottom-full mb-1.5",
            align === "left" && "left-0",
            align === "right" && "right-0",
            align === "center" && "left-1/2 -translate-x-1/2",
            className,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
