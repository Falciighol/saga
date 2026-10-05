import { ArrowDown, ArrowUp, Columns3 } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { bpmText, fmtChannels, fmtDate, fmtDb, fmtLength, fmtRate, hasTempo, keyText, sourceHint } from "../lib/format";
import { columnDef, COLUMN_GROUPS, COLUMNS, moveColumn, NAME_MIN, resetColumns, resolveColumns, setColumnVisible, stepColumn, visibleColumns, type ColumnDef, type ColumnId } from "../lib/listColumns";
import { compatibleKeys, projectKeyLabel } from "../lib/keys";
import { altKey, hasMod } from "../lib/platform";
import { keyMatchShift } from "../lib/processing";
import { fittingKeys, plainScale, scaleById, scaleBySteps, scaleNotes } from "../lib/theory";
import type { SampleRow, SortKey } from "../lib/types";
import { firstDesc, useBrowse } from "../store/browse";
import { usePrefs } from "../store/prefs";
import { useProject } from "../store/project";
import { openContextMenu, openMenuBelow, useMenu, type MenuItem } from "./Menu";

/** "Tempo (BPM)" → "tempo (BPM)", for a column's name mid-sentence. */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
import { cx, IconButton } from "./ui";
import { MiniWave } from "./Waveforms";

/** How a sample's key sits with the project key, or with the key filter when one is set. */
export interface KeyFit {
  /** "in": the same key. "relative": its relative major or minor, the same notes. "fits": its notes fit. "off": they
   *  don't. */
  fit: "in" | "relative" | "fits" | "off";
  /** Semitones Match key moves it by to land on the key (−6…+5). */
  shift: number;
  /** The key it's measured against: "C maj". */
  to: string;
}

/** What a row knows that its cells draw with. */
export interface CellContext {
  selected: boolean;
  /** How the key fits the key filter or project key; null when there's nothing to fit, or the sample has no key. */
  keyFit: KeyFit | null;
  bpmFixed: boolean;
}

/** How each row's key fits the key filter, or the project key when there's no filter. Null when neither is set. The
 *  answer for a key is worked out once and reused, so rows that memoize on it don't redraw. */
export function useKeyFit(): ((row: SampleRow) => KeyFit | null) | null {
  const filterKey = useBrowse((s) => s.filters.key);
  const projectKey = useProject((s) => s.key);
  return useMemo(() => {
    const key = filterKey ?? (projectKey ? { pc: projectKey.pc, mode: projectKey.mode, compatible: true, scale: scaleById(projectKey.scale)?.steps } : null);
    if (!key) return null;
    const steps = key.scale?.length ? key.scale : null;
    const set = !key.compatible ? [{ pc: key.pc, mode: key.mode }] : steps ? fittingKeys(key.pc, steps) : compatibleKeys(key.pc, key.mode);
    const scale = scaleNotes(key.pc, steps ?? plainScale(key.mode).steps);
    const to = projectKeyLabel(filterKey ? { pc: key.pc, mode: key.mode, scale: scaleBySteps(key.scale)?.id } : projectKey!);
    const known = new Map<number, KeyFit>();
    return (row: SampleRow) => {
      if (row.keyPc == null || row.keyMode == null) return null;
      const id = row.keyMode * 12 + row.keyPc;
      let answer = known.get(id);
      if (!answer) {
        const fits = row.keyMode === 2 ? scale.includes(row.keyPc) : set.some((k) => k.pc === row.keyPc && k.mode === row.keyMode);
        const shift = keyMatchShift(row, { pc: key.pc, mode: key.mode });
        const same = row.keyMode === 2 ? row.keyPc === key.pc : row.keyPc === key.pc && row.keyMode === key.mode;
        answer = { fit: !fits ? "off" : same ? "in" : shift === 0 ? "relative" : "fits", shift, to };
        known.set(id, answer);
      }
      return answer;
    };
  }, [filterKey, projectKey]);
}

/** The word after a key: "in key", "relative", "fits", or how far Match key would move it: "+2 st". */
export function keyFitLabel(f: KeyFit): string {
  if (f.fit === "in") return "in key";
  if (f.fit !== "off") return f.fit;
  return f.shift === 0 ? "off" : `${f.shift > 0 ? "+" : "−"}${Math.abs(f.shift)} st`;
}

/** The sentence for a key's tooltip: "Fits C maj. Match key moves it down 5 semitones." */
export function keyFitText(f: KeyFit): string {
  const how = { in: `In ${f.to}`, relative: `Relative of ${f.to}, the same notes`, fits: `Fits ${f.to}`, off: `Doesn't fit ${f.to}` }[f.fit];
  if (f.shift === 0) return `${how}.`;
  const n = Math.abs(f.shift);
  return `${how}. Match key moves it ${f.shift > 0 ? "up" : "down"} ${n} semitone${n === 1 ? "" : "s"}.`;
}

/** The colour of the word after a key: strongest for the same notes, quiet for a key that needs moving. */
export const KEY_FIT_TONE: Record<KeyFit["fit"], string> = { in: "text-accent-ink", relative: "text-accent-ink", fits: "text-text2", off: "text-text3" };

// Read out as "none" rather than "em dash".
const dash = (
  <>
    <span aria-hidden="true" className="text-text3">
      —
    </span>
    <span className="sr-only">none</span>
  </>
);
const mono = "font-mono text-small text-text2 tabular";

/** "…" while Saga hasn't listened to the sample yet, so a value it hasn't found yet doesn't read as "none". */
function pending(row: SampleRow): ReactNode {
  if (row.status !== 0) return null;
  return (
    <>
      <span aria-hidden="true" className="animate-soft-pulse text-text3">
        …
      </span>
      <span className="sr-only">not known yet</span>
    </>
  );
}

/** A day, with the time in its tooltip. */
function dateCell(secs: number | null) {
  return secs == null ? dash : fmtDate(secs);
}

function dateTitle(secs: number | null): string | undefined {
  return secs == null ? undefined : new Date(secs * 1000).toLocaleString();
}

/** How each column draws a row's value, given the width the column gets. */
const CELLS: Record<
  ColumnId,
  { className?: string; title?: (row: SampleRow, ctx: CellContext) => string | undefined; render: (row: SampleRow, ctx: CellContext, width: number) => ReactNode }
> = {
  waveform: {
    className: "relative",
    render: (row, ctx, width) =>
      row.status === 2 ? (
        <span className="block text-center text-micro text-text3">Can't read this file</span>
      ) : (
        <MiniWave peaks={row.peaks} width={width} height={28} sampleId={row.id} emphasized={ctx.selected} />
      ),
  },
  category: { className: "truncate text-ui text-text2", render: (row) => row.category ?? dash },
  bpm: {
    className: mono,
    title: (row) => (hasTempo(row) ? sourceHint("Tempo", row.bpmSource) : undefined),
    render: (row, ctx) => {
      const tempo = bpmText(row, ctx.bpmFixed);
      return tempo === "—" ? (pending(row) ?? dash) : tempo;
    },
  },
  key: {
    className: "flex items-baseline gap-1.5 overflow-hidden font-mono text-small whitespace-nowrap text-text2",
    title: (row, ctx) => [ctx.keyFit && keyFitText(ctx.keyFit), row.camelot, sourceHint("Key", row.keySource)].filter(Boolean).join(" · ") || undefined,
    render: (row, ctx) =>
      row.key == null ? (
        pending(row) ?? dash
      ) : (
        <>
          <span className="shrink-0">{keyText(row)}</span>
          {ctx.keyFit && <span className={cx("truncate text-micro", KEY_FIT_TONE[ctx.keyFit.fit])}>{keyFitLabel(ctx.keyFit)}</span>}
        </>
      ),
  },
  length: {
    className: mono,
    render: (row) => (row.duration == null ? (pending(row) ?? dash) : fmtLength(row.duration, true)),
  },
  created: { className: mono, title: (row) => dateTitle(row.created), render: (row) => dateCell(row.created) },
  tags: {
    className: "flex items-center gap-1 overflow-hidden",
    title: (row) => (row.tags.length > 2 ? row.tags.join(", ") : undefined),
    // Two tags, and how many more. A long tag shortens with an ellipsis rather than pushing the count out.
    render: (row) => (
      <>
        {row.tags.slice(0, 2).map((t) => (
          <span key={t} className="flex h-5 min-w-0 items-center rounded bg-raised2 px-[7px] text-micro text-text2">
            <span className="truncate">{t}</span>
          </span>
        ))}
        {row.tags.length > 2 && (
          <span className="shrink-0 font-mono text-micro text-text3">
            +{row.tags.length - 2}
            <span className="sr-only"> more</span>
          </span>
        )}
      </>
    ),
  },
  added: { className: mono, title: (row) => dateTitle(row.added), render: (row) => dateCell(row.added) },
  format: { className: mono, render: (row) => row.ext.toUpperCase() },
  rate: { className: mono, render: (row) => fmtRate(row.sampleRate) || dash },
  bits: { className: mono, render: (row) => (row.bitDepth ? `${row.bitDepth}-bit` : dash) },
  channels: { className: "truncate text-ui text-text2", render: (row) => fmtChannels(row.channels) || dash },
  loudness: { className: mono, render: (row) => fmtDb(row.loudness, "LUFS") || dash },
  plays: { className: mono, render: (row) => (row.playCount ? row.playCount.toLocaleString("en-US") : dash) },
};

/** The columns that show, in the user's order. */
export function useVisibleColumns(): ColumnDef[] {
  const saved = usePrefs((s) => s.listColumns);
  return useMemo(() => visibleColumns(saved), [saved]);
}

function columnClass(c: ColumnDef): string {
  return cx("shrink-0", c.align === "right" && "justify-end text-right");
}

export function ColumnCell({ column, row, ctx }: { column: ColumnDef; row: SampleRow; ctx: CellContext }) {
  const cell = CELLS[column.id];
  return (
    <span className={cx(columnClass(column), cell.className)} style={{ width: column.width }} title={cell.title?.(row, ctx)}>
      {/* The row is one button, so each value says what it is: "…, Tempo: 124, Key: Am". */}
      {column.id !== "waveform" && <span className="sr-only">, {column.label}: </span>}
      {cell.render(row, ctx, column.width)}
    </span>
  );
}

/** Showing and hiding columns, by section, and for a column's own header, moving or hiding it. Ticking a column or
 *  moving one leaves the menu open, so several changes take one trip; open it with `() => columnsMenu(…)` so it
 *  redraws. */
export function columnsMenu(at?: ColumnId): MenuItem[] {
  const all = resolveColumns(usePrefs.getState().listColumns);
  const shown = all.filter((c) => c.visible);
  const items: MenuItem[] = [];
  if (at) {
    const i = shown.findIndex((c) => c.id === at);
    items.push(
      { label: "Move left", hint: `${altKey}←`, disabled: i <= 0, keepOpen: true, onSelect: () => stepColumn(at, -1) },
      { label: "Move right", hint: `${altKey}→`, disabled: i < 0 || i >= shown.length - 1, keepOpen: true, onSelect: () => stepColumn(at, 1) },
      { label: `Hide ${lowerFirst(columnDef(at).label)}`, onSelect: () => setColumnVisible(at, false) },
      "separator",
    );
  }
  for (const g of COLUMN_GROUPS) {
    items.push({ label: g.label, heading: true });
    for (const c of COLUMNS.filter((x) => x.group === g.id)) {
      const on = all.find((x) => x.id === c.id)?.visible ?? c.shown;
      items.push({ label: c.label, checked: on, keepOpen: true, onSelect: () => setColumnVisible(c.id, !on) });
    }
  }
  items.push(
    "separator",
    { label: "Reset columns", disabled: usePrefs.getState().listColumns == null, onSelect: resetColumns },
  );
  return items;
}

/** How a column title tells you it moves. */
const MOVE_HINT = `Drag (or ${altKey} ← →) to move this column, right-click to choose columns`;
/** The keys a focused column title takes, for screen readers. */
const TITLE_KEYS = "Alt+ArrowLeft Alt+ArrowRight Shift+F10";

/** A title that sorts. `name` is what a screen reader says for it ("Tempo", where the title reads "BPM"). */
function SortHeader({ label, name, sortKey, align, movable }: { label: string; name: string; sortKey: SortKey; align?: "right"; movable?: boolean }) {
  const sort = useBrowse((s) => s.sort);
  const desc = useBrowse((s) => s.desc);
  const setSort = useBrowse((s) => s.setSort);
  const on = sort === sortKey;
  return (
    <button
      type="button"
      aria-label={on ? `${name}, sorted ${desc ? "descending" : "ascending"}` : `Sort by ${lowerFirst(name)}`}
      title={movable ? MOVE_HINT : undefined}
      aria-keyshortcuts={movable ? TITLE_KEYS : "Shift+F10"}
      onClick={() => setSort(sortKey, on ? !desc : firstDesc(sortKey))}
      className={cx("flex w-full min-w-0 items-center gap-1 uppercase hover:text-text2", on && "text-text2", align === "right" && "justify-end")}
    >
      <span className="truncate">{label}</span>
      {on && (desc ? <ArrowDown size={11} className="shrink-0" /> : <ArrowUp size={11} className="shrink-0" />)}
    </button>
  );
}

/** Pixels the pointer moves before a press on a header becomes a drag. */
const DRAG_START = 5;

interface Drag {
  id: ColumnId;
  /** Where the dragged column would go: before this one, or at the end when null. */
  before: ColumnId | null;
  /** The drop line's x, in pixels from the header's left edge. */
  x: number;
}

/** The list's header: click a title to sort, drag one to move its column, right-click (or the
 *  button at the end) to choose which columns show. It sits inside the list's scroll area, sticky at the top,
 *  so it always shares the rows' width and follows them when the list scrolls sideways. */
export function ListHeader({ columns, minWidth, overflowing }: { columns: ColumnDef[]; minWidth: number; overflowing: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // A drag ends in a click on the title it started from, which mustn't sort.
  const swallowUntil = useRef(0);
  // A column moved from the keyboard: its title gets focus back once the header has re-rendered in the new order.
  const refocus = useRef<ColumnId | null>(null);
  const [said, setSaid] = useState("");

  useLayoutEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    box.current?.querySelector<HTMLElement>(`[data-column="${id}"] button`)?.focus();
  }, [columns]);

  // ⌥/Alt ← → move the focused column, ⇧F10 or the menu key open its menu.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const target = e.target as HTMLElement;
    const id = target.closest<HTMLElement>("[data-column]")?.dataset.column as ColumnId | undefined;
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault();
      openMenuBelow(target, () => columnsMenu(id));
      return;
    }
    if (!id || !e.altKey || e.shiftKey || hasMod(e) || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    // On Windows, Alt+← would otherwise go back a page.
    e.preventDefault();
    const step = e.key === "ArrowLeft" ? -1 : 1;
    const to = columns.findIndex((c) => c.id === id) + step;
    if (to < 0 || to >= columns.length) return;
    refocus.current = id;
    stepColumn(id, step);
    setSaid(`${columnDef(id).label} moved to column ${to + 1} of ${columns.length}`);
  };

  const startDrag = (e: React.PointerEvent, id: ColumnId) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    let current: Drag | null = null;
    let cancelled = false;
    const where = (x: number): Drag => {
      const header = box.current!.getBoundingClientRect();
      const cells = [...box.current!.querySelectorAll<HTMLElement>("[data-column]")].filter((el) => el.offsetWidth > 0);
      for (const el of cells) {
        const r = el.getBoundingClientRect();
        if (x < r.left + r.width / 2) return { id, before: el.dataset.column as ColumnId, x: r.left - header.left - 8 };
      }
      const last = cells[cells.length - 1].getBoundingClientRect();
      return { id, before: null, x: last.right - header.left + 8 };
    };
    const move = (ev: PointerEvent) => {
      if (cancelled || (!current && Math.abs(ev.clientX - startX) < DRAG_START)) return;
      current = where(ev.clientX);
      setDrag(current);
    };
    // Esc drops a drag where it started. Caught before the global keys, so it doesn't also stop playback.
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !current || cancelled) return;
      ev.stopPropagation();
      cancelled = true;
      setDrag(null);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key, true);
      if (current) {
        swallowUntil.current = performance.now() + 300;
        if (!cancelled) moveColumn(current.id, current.before);
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key, true);
  };

  return (
    <div
      ref={box}
      className={cx(
        "sticky top-0 z-10 flex h-8 shrink-0 items-center gap-1 border-b border-line bg-bg px-4 text-micro font-medium tracking-[0.05em] text-text3 select-none",
        drag && "cursor-grabbing",
      )}
      style={{ minWidth }}
      onClickCapture={(e) => {
        if (performance.now() < swallowUntil.current) {
          e.stopPropagation();
          e.preventDefault();
        }
      }}
      onContextMenu={(e) => {
        // The menu key also fires this, after onKeyDown has opened the menu under the title.
        if (useMenu.getState().menu) return e.preventDefault();
        const at = (e.target as HTMLElement).closest<HTMLElement>("[data-column]")?.dataset.column as ColumnId | undefined;
        openContextMenu(e, () => columnsMenu(at));
      }}
      onKeyDown={onKeyDown}
    >
      <span className="w-8 shrink-0" />
      <span className="w-7 shrink-0" />
      <div className="flex min-w-0 flex-1 gap-4 pl-1">
        <div className="min-w-0 flex-1" style={{ minWidth: NAME_MIN }}>
          <SortHeader label="Name" name="Name" sortKey="name" />
        </div>
        {columns.map((c) => (
          <div
            key={c.id}
            data-column={c.id}
            onPointerDown={(e) => startDrag(e, c.id)}
            className={cx("flex", columnClass(c), drag?.id === c.id && "opacity-40")}
            style={{ width: c.width }}
          >
            {c.sort ? (
              <SortHeader label={c.header} name={c.label} sortKey={c.sort} align={c.align} movable />
            ) : (
              // A title that can't sort still takes focus, so its column can be moved and its menu opened from the
              // keyboard. Enter opens the menu; a click does nothing, as before.
              <button
                type="button"
                aria-label={`${c.label} column`}
                aria-haspopup="menu"
                aria-keyshortcuts={TITLE_KEYS}
                title={MOVE_HINT}
                onClick={(e) => e.detail === 0 && openMenuBelow(e.currentTarget, () => columnsMenu(c.id))}
                className={cx("flex w-full min-w-0 items-center uppercase", c.align === "right" && "justify-end")}
              >
                <span className="truncate">{c.header}</span>
              </button>
            )}
          </div>
        ))}
      </div>
      {/* Stays in reach when the list scrolls sideways. Its right padding stands in for the header's own, so it
          lines up with the rows' drag grip. */}
      <span className="sticky right-0 -mr-4 flex shrink-0 bg-bg pr-4">
        {overflowing && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-full w-6 bg-linear-to-r from-transparent to-bg" />}
        <IconButton label="Choose columns" aria-haspopup="menu" size={28} onClick={(e) => openMenuBelow(e.currentTarget, () => columnsMenu(), "right")}>
          <Columns3 size={14} />
        </IconButton>
      </span>
      {drag && <span aria-hidden="true" className="pointer-events-none absolute top-1 bottom-1 w-0.5 rounded-full bg-accent" style={{ left: drag.x }} />}
      <span aria-live="polite" className="sr-only">
        {said}
      </span>
    </div>
  );
}
