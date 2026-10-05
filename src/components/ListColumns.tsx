import { ArrowDown, ArrowUp, Columns3 } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { bpmText, fmtChannels, fmtDate, fmtDb, fmtLength, fmtRate, hasTempo, keyText, sourceHint } from "../lib/format";
import { columnDef, COLUMNS, moveColumn, resetColumns, resolveColumns, setColumnVisible, stepColumn, visibleColumns, type ColumnDef, type ColumnId } from "../lib/listColumns";
import type { SampleRow, SortKey } from "../lib/types";
import { firstDesc, useBrowse } from "../store/browse";
import { usePrefs } from "../store/prefs";
import { openContextMenu, openMenuBelow, type MenuItem } from "./Menu";
import { cx, IconButton } from "./ui";
import { MiniWave } from "./Waveforms";

/** What a row knows that its cells draw with. */
export interface CellContext {
  selected: boolean;
  /** Whether the key fits the key filter or project key; null when there's nothing to fit. */
  keyMatch: boolean | null;
  bpmFixed: boolean;
}

const dash = <span className="text-text3">—</span>;
const mono = "font-mono text-small text-text2 tabular";

/** A day, with the time in its tooltip. */
function dateCell(secs: number | null) {
  return secs == null ? dash : fmtDate(secs);
}

function dateTitle(secs: number | null): string | undefined {
  return secs == null ? undefined : new Date(secs * 1000).toLocaleString();
}

/** How each column draws a row's value. */
const CELLS: Record<ColumnId, { className?: string; title?: (row: SampleRow) => string | undefined; render: (row: SampleRow, ctx: CellContext) => ReactNode }> = {
  waveform: {
    className: "relative",
    render: (row, ctx) =>
      row.status === 2 ? (
        <span className="block text-center text-micro text-text3">Can't read this file</span>
      ) : (
        <MiniWave peaks={row.peaks} width={columnDef("waveform").width} height={28} sampleId={row.id} emphasized={ctx.selected} />
      ),
  },
  category: { className: "truncate text-ui text-text2", render: (row) => row.category ?? dash },
  bpm: {
    className: mono,
    title: (row) => (hasTempo(row) ? sourceHint("Tempo", row.bpmSource) : undefined),
    render: (row, ctx) => {
      const tempo = bpmText(row, ctx.bpmFixed);
      return tempo === "—" ? dash : tempo;
    },
  },
  key: {
    className: "flex items-center gap-[7px] font-mono text-small text-text2",
    title: (row) => [row.camelot, sourceHint("Key", row.keySource)].filter(Boolean).join(" · ") || undefined,
    render: (row, ctx) => (
      <>
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: row.key == null || ctx.keyMatch == null ? "transparent" : ctx.keyMatch ? "var(--accent)" : "var(--line2)" }}
        />
        {keyText(row) ?? dash}
      </>
    ),
  },
  length: {
    className: mono,
    render: (row) => (row.status === 0 && row.duration == null ? <span className="animate-soft-pulse text-text3">…</span> : fmtLength(row.duration)),
  },
  created: { className: mono, title: (row) => dateTitle(row.created), render: (row) => dateCell(row.created) },
  tags: {
    className: "flex gap-1 overflow-hidden",
    render: (row) =>
      row.tags.slice(0, 2).map((t) => (
        <span key={t} className="flex h-5 items-center rounded bg-raised2 px-[7px] text-micro whitespace-nowrap text-text2">
          {t}
        </span>
      )),
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
  return cx("shrink-0", c.align === "right" && "justify-end text-right", c.narrow);
}

export function ColumnCell({ column, row, ctx }: { column: ColumnDef; row: SampleRow; ctx: CellContext }) {
  const cell = CELLS[column.id];
  return (
    <span className={cx(columnClass(column), cell.className)} style={{ width: column.width }} title={cell.title?.(row)}>
      {cell.render(row, ctx)}
    </span>
  );
}

/** Showing and hiding columns, and for a column's own header, moving or hiding it. */
export function columnsMenu(at?: ColumnId): MenuItem[] {
  const all = resolveColumns(usePrefs.getState().listColumns);
  const shown = all.filter((c) => c.visible);
  const items: MenuItem[] = [];
  if (at) {
    const i = shown.findIndex((c) => c.id === at);
    items.push(
      { label: "Move left", disabled: i <= 0, onSelect: () => stepColumn(at, -1) },
      { label: "Move right", disabled: i < 0 || i >= shown.length - 1, onSelect: () => stepColumn(at, 1) },
      { label: `Hide ${columnDef(at).label.toLowerCase()}`, onSelect: () => setColumnVisible(at, false) },
      "separator",
    );
  }
  items.push(
    ...COLUMNS.map((c) => {
      const on = all.find((x) => x.id === c.id)?.visible ?? c.shown;
      return { label: c.label, checked: on, onSelect: () => setColumnVisible(c.id, !on) };
    }),
    "separator",
    { label: "Reset columns", disabled: usePrefs.getState().listColumns == null, onSelect: resetColumns },
  );
  return items;
}

function SortHeader({ label, sortKey, align }: { label: string; sortKey: SortKey; align?: "right" }) {
  const sort = useBrowse((s) => s.sort);
  const desc = useBrowse((s) => s.desc);
  const setSort = useBrowse((s) => s.setSort);
  const on = sort === sortKey;
  return (
    <button
      type="button"
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
 *  button at the end) to choose which columns show. */
export function ListHeader() {
  const columns = useVisibleColumns();
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // A drag ends in a click on the title it started from, which mustn't sort.
  const swallowUntil = useRef(0);

  const startDrag = (e: React.PointerEvent, id: ColumnId) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    let current: Drag | null = null;
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
      if (!current && Math.abs(ev.clientX - startX) < DRAG_START) return;
      current = where(ev.clientX);
      setDrag(current);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (current) {
        swallowUntil.current = performance.now() + 300;
        moveColumn(current.id, current.before);
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <div
      ref={box}
      className={cx("relative flex h-8 shrink-0 items-center gap-1 border-b border-line px-4 text-micro font-medium tracking-[0.05em] text-text3 select-none", drag && "cursor-grabbing")}
      onClickCapture={(e) => {
        if (performance.now() < swallowUntil.current) {
          e.stopPropagation();
          e.preventDefault();
        }
      }}
      onContextMenu={(e) => {
        const at = (e.target as HTMLElement).closest<HTMLElement>("[data-column]")?.dataset.column as ColumnId | undefined;
        openContextMenu(e, columnsMenu(at));
      }}
    >
      <span className="w-8 shrink-0" />
      <span className="w-7 shrink-0" />
      <div className="flex min-w-0 flex-1 gap-4 pl-1">
        <div className="min-w-0 flex-1">
          <SortHeader label="Name" sortKey="name" />
        </div>
        {columns.map((c) => (
          <div
            key={c.id}
            data-column={c.id}
            onPointerDown={(e) => startDrag(e, c.id)}
            className={cx("flex", columnClass(c), drag?.id === c.id && "opacity-40")}
            style={{ width: c.width }}
            title="Drag to move this column, right-click to choose columns"
          >
            {c.sort ? <SortHeader label={c.header} sortKey={c.sort} align={c.align} /> : <span className="truncate uppercase">{c.header}</span>}
          </div>
        ))}
      </div>
      <IconButton label="Choose columns" size={28} onClick={(e) => openMenuBelow(e.currentTarget, columnsMenu(), "right")} className="-mr-0.5">
        <Columns3 size={14} />
      </IconButton>
      {drag && <span aria-hidden="true" className="pointer-events-none absolute top-1 bottom-1 w-0.5 rounded-full bg-accent" style={{ left: drag.x }} />}
    </div>
  );
}
