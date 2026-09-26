import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cssFamily } from "../lib/fonts";
import type { InstalledFont } from "../lib/types";
import { cx, Switch } from "./ui";

const ROW_H = 34;

/** The families installed on this computer; null while loading. */
export type FontList = InstalledFont[] | null | "error";

const face = (family: string) => ({ fontFamily: `${cssFamily(family)}, var(--sans)` });

/** Picks any font installed on this computer, with each family drawn in its own face. */
export function InstalledFontPicker({
  label,
  fonts,
  value,
  active,
  mono,
  fallback,
  onPick,
}: {
  label: string;
  fonts: FontList;
  /** The last installed family chosen, even while a bundled font is in use. */
  value: string | null;
  /** The installed family is the one in use. */
  active: boolean;
  /** Offer a "Monospaced only" filter, on at first. */
  mono?: boolean;
  /** What's shown instead when the family isn't installed any more. */
  fallback: string;
  onPick: (family: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [monoOnly, setMonoOnly] = useState(!!mono);
  const [cursor, setCursor] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const list = Array.isArray(fonts) ? fonts : [];
  const missing = value != null && Array.isArray(fonts) && !fonts.some((f) => f.family === value);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((f) => (!monoOnly || f.mono) && (!q || f.family.toLowerCase().includes(q)));
  }, [list, query, monoOnly]);

  const virtualizer = useVirtualizer({ count: shown.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 6 });

  // Start at the current family (or the top) whenever the list opens or its filter changes.
  useEffect(() => {
    if (!open) return;
    const at = Math.max(0, shown.findIndex((f) => f.family === value));
    setCursor(at);
    requestAnimationFrame(() => {
      if (at > 0) virtualizer.scrollToIndex(at, { align: "center" });
      panel.current?.scrollIntoView({ block: "nearest" });
    });
  }, [open, shown]);

  const pick = (family: string) => {
    onPick(family);
    setOpen(false);
    setQuery("");
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(shown.length - 1, Math.max(0, cursor + (e.key === "ArrowDown" ? 1 : -1)));
      setCursor(next);
      virtualizer.scrollToIndex(next, { align: "auto" });
    } else if (e.key === "Enter" && shown[cursor]) {
      pick(shown[cursor].family);
    } else if (e.key === "Escape") {
      // Keep Settings open: clear the search first, then close the list.
      e.stopPropagation();
      if (query) setQuery("");
      else setOpen(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "flex h-10 w-full items-center gap-3 rounded-lg border px-3 text-left transition-colors",
          active ? "border-accent bg-accent-soft" : "border-line2 hover:bg-raised",
        )}
      >
        <span className={cx("shrink-0 text-small", active ? "text-accent-ink" : "text-text3")}>Installed</span>
        {value ? (
          <span className="min-w-0 flex-1 truncate text-body text-text" style={face(value)}>
            {value}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-ui text-text2">Choose a font on this computer…</span>
        )}
        {missing && <span className="shrink-0 text-small text-text3">Not installed</span>}
        <ChevronDown size={14} className={cx("shrink-0 text-text3 transition-transform", open && "rotate-180")} />
      </button>
      {active && missing && (
        <p className="mt-1.5 text-small text-text3">
          {value} isn't installed on this computer, so Saga is using {fallback}.
        </p>
      )}

      {open && (
        <div ref={panel} className="mt-2 overflow-hidden rounded-lg border border-line2">
          <div className="flex h-9 items-center gap-2 border-b border-line pr-2 pl-3">
            <Search size={14} className="shrink-0 text-text3" aria-hidden="true" />
            <input
              autoFocus
              aria-label={`Search installed fonts for the ${label.toLowerCase()}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
              placeholder={list.length ? `Search ${list.length} fonts` : "Search fonts"}
              className="h-full min-w-0 flex-1 bg-transparent text-ui text-text outline-none placeholder:text-text3"
            />
            {mono && <Switch size="sm" checked={monoOnly} onChange={setMonoOnly} label="Monospaced only" className="shrink-0 text-small" />}
          </div>
          <div ref={scroller} role="listbox" aria-label={`Installed fonts for the ${label.toLowerCase()}`} className="h-[204px] overflow-y-auto">
            {fonts === null ? (
              <p className="animate-soft-pulse px-3 py-3 text-ui text-text3">Reading installed fonts…</p>
            ) : fonts === "error" ? (
              <p className="px-3 py-3 text-ui text-text3">Couldn't read the fonts installed on this computer.</p>
            ) : shown.length === 0 ? (
              <p className="px-3 py-3 text-ui text-text3">
                {query ? `No ${monoOnly ? "monospaced " : ""}fonts match “${query.trim()}”.` : "No fonts found."}
              </p>
            ) : (
              <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((row) => {
                  const f = shown[row.index];
                  const on = f.family === value;
                  return (
                    <button
                      key={f.family}
                      type="button"
                      role="option"
                      aria-selected={on}
                      tabIndex={-1}
                      onMouseEnter={() => setCursor(row.index)}
                      onClick={() => pick(f.family)}
                      className={cx("absolute inset-x-0 flex items-center gap-2 px-3 text-left", row.index === cursor && "bg-raised")}
                      style={{ top: row.start, height: ROW_H }}
                    >
                      <span className="min-w-0 flex-1 truncate text-body text-text" style={face(f.family)}>
                        {f.family}
                      </span>
                      {on && <Check size={14} className="shrink-0 text-accent-ink" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
