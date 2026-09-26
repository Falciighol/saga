import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Pause, Play, Star } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";
import { dragSample, sampleMenu } from "../lib/actions";
import { bpmText, fmtLength, keyText, sourceHint } from "../lib/format";
import { compatibleKeys } from "../lib/keys";
import type { SampleRow, SortKey } from "../lib/types";
import { activeFilterCount, useBrowse } from "../store/browse";
import { usePlayer } from "../store/player";
import { useProject } from "../store/project";
import { openContextMenu } from "./Menu";
import { cx } from "./ui";
import { MiniWave } from "./Waveforms";

const ROW_H = 44;
const COLS = {
  wave: 180,
  category: 84,
  bpm: 60,
  key: 64,
  length: 64,
  tags: 150,
};

function GripIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" className="fill-current">
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

/** Marks keys that fit the key filter, or the project key when there's no filter. */
function useKeyMatcher() {
  const filterKey = useBrowse((s) => s.filters.key);
  const projectKey = useProject((s) => s.key);
  return useMemo(() => {
    const key = filterKey ?? (projectKey ? { ...projectKey, compatible: true } : null);
    if (!key) return null;
    const set = key.compatible ? compatibleKeys(key.pc, key.mode) : [{ pc: key.pc, mode: key.mode }];
    const scale = (key.mode === 1 ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map((i) => (key.pc + i) % 12);
    return (row: SampleRow) =>
      row.keyPc != null && (row.keyMode === 2 ? scale.includes(row.keyPc) : set.some((k) => k.pc === row.keyPc && k.mode === row.keyMode));
  }, [filterKey, projectKey]);
}

const SampleRowView = memo(function SampleRowView({ row, index, keyMatch }: { row: SampleRow; index: number; keyMatch: boolean | null }) {
  const selected = useBrowse((s) => s.selected?.id === row.id);
  const status = usePlayer((s) => (s.id === row.id ? s.status : "idle"));
  const playing = status === "playing" || status === "loading";
  const segments = row.dir.split("/").filter(Boolean);
  const where = segments.length > 1 ? `${segments[0]}  ›  ${segments[segments.length - 1]}` : row.pack;

  const select = (play?: boolean) => useBrowse.getState().selectRow(row, index, play === undefined ? undefined : { play });

  return (
    <div
      draggable={row.online}
      onDragStart={(e) => {
        e.preventDefault();
        select(false);
        dragSample(row);
      }}
      onContextMenu={(e) => {
        select(false);
        openContextMenu(e, sampleMenu(row, index));
      }}
      className={cx("group flex h-11 items-center gap-1 px-4", selected ? "bg-raised" : "hover:bg-raised/60", !row.online && "opacity-45")}
      title={row.online ? undefined : "This sample's drive isn't connected"}
    >
      <button
        type="button"
        aria-label={`${playing ? "Pause" : "Play"} ${row.name}`}
        onClick={() => {
          select(false);
          usePlayer.getState().toggle(row);
        }}
        className={cx("grid h-8 w-8 shrink-0 place-items-center rounded-full", selected || playing ? "text-accent-ink" : "text-text3 hover:text-text")}
      >
        {playing ? <Pause size={14} fill="currentColor" strokeWidth={0} /> : <Play size={14} fill="currentColor" strokeWidth={0} />}
      </button>
      <button
        type="button"
        aria-label={row.favorite ? `Remove ${row.name} from favorites` : `Add ${row.name} to favorites`}
        aria-pressed={row.favorite}
        onClick={() => useBrowse.getState().toggleFavorite(row)}
        className={cx("grid h-7 w-7 shrink-0 place-items-center rounded-md", row.favorite ? "text-accent-ink" : "text-text3 opacity-0 group-hover:opacity-100 focus-visible:opacity-100", selected && "opacity-100")}
      >
        <Star size={15} strokeWidth={1.75} fill={row.favorite ? "currentColor" : "none"} />
      </button>
      <button
        type="button"
        onClick={() => select()}
        onDoubleClick={() => usePlayer.getState().play(row)}
        className="flex h-11 min-w-0 flex-1 items-center gap-4 pl-1 text-left"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-body font-medium text-text">
            {row.name}
            <span className="font-normal text-text3">.{row.ext}</span>
          </span>
          <span className="truncate text-[11.5px] text-text3">{where}</span>
        </span>
        <span className="relative shrink-0" style={{ width: COLS.wave }}>
          {row.status === 2 ? (
            <span className="block text-center text-micro text-text3">Can't read this file</span>
          ) : (
            <MiniWave peaks={row.peaks} width={COLS.wave} height={28} sampleId={row.id} emphasized={selected} />
          )}
        </span>
        <span className="shrink-0 truncate text-ui text-text2 @max-[900px]:hidden" style={{ width: COLS.category }}>
          {row.category ?? <span className="text-text3">—</span>}
        </span>
        <span
          className="shrink-0 text-right font-mono text-small text-text2 tabular"
          style={{ width: COLS.bpm }}
          title={row.kind === "loop" ? sourceHint("Tempo", row.bpmSource) : undefined}
        >
          {bpmText(row) === "—" ? <span className="text-text3">—</span> : bpmText(row)}
        </span>
        <span
          className="flex shrink-0 items-center gap-[7px] font-mono text-small text-text2"
          style={{ width: COLS.key }}
          title={[row.camelot, sourceHint("Key", row.keySource)].filter(Boolean).join(" · ") || undefined}
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: row.key == null || keyMatch == null ? "transparent" : keyMatch ? "var(--accent)" : "var(--line2)" }}
          />
          {keyText(row) ?? <span className="text-text3">—</span>}
        </span>
        <span className="shrink-0 text-right font-mono text-small text-text2 tabular" style={{ width: COLS.length }}>
          {row.status === 0 && row.duration == null ? <span className="animate-soft-pulse text-text3">…</span> : fmtLength(row.duration)}
        </span>
        <span className="flex shrink-0 gap-1 overflow-hidden @max-[1100px]:hidden" style={{ width: COLS.tags }}>
          {row.tags.slice(0, 2).map((t) => (
            <span key={t} className="flex h-5 items-center rounded bg-raised2 px-[7px] text-micro whitespace-nowrap text-text2">
              {t}
            </span>
          ))}
        </span>
      </button>
      <span
        aria-hidden="true"
        title="Drag into your DAW"
        className="grid h-8 w-7 shrink-0 cursor-grab place-items-center rounded-md text-text3 opacity-0 group-hover:opacity-100"
      >
        <GripIcon />
      </span>
    </div>
  );
});

function SortHeader({ label, sortKey, width, align }: { label: string; sortKey: SortKey; width?: number; align?: "right" }) {
  const sort = useBrowse((s) => s.sort);
  const desc = useBrowse((s) => s.desc);
  const setSort = useBrowse((s) => s.setSort);
  const on = sort === sortKey;
  return (
    <button
      type="button"
      onClick={() => setSort(sortKey, on ? !desc : false)}
      className={cx("flex shrink-0 items-center gap-1 uppercase hover:text-text2", on && "text-text2", align === "right" && "justify-end", !width && "flex-1")}
      style={width ? { width } : undefined}
    >
      {label}
      {on && (desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
    </button>
  );
}

export function ListHeader() {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-4 text-micro font-medium tracking-[0.05em] text-text3">
      <span className="w-8 shrink-0" />
      <span className="w-7 shrink-0" />
      <div className="flex min-w-0 flex-1 gap-4 pl-1">
        <SortHeader label="Name" sortKey="name" />
        <span className="shrink-0 uppercase" style={{ width: COLS.wave }}>
          Waveform
        </span>
        <span className="shrink-0 uppercase @max-[900px]:hidden" style={{ width: COLS.category }}>
          Category
        </span>
        <SortHeader label="BPM" sortKey="bpm" width={COLS.bpm} align="right" />
        <SortHeader label="Key" sortKey="key" width={COLS.key} />
        <SortHeader label="Length" sortKey="duration" width={COLS.length} align="right" />
        <span className="shrink-0 uppercase @max-[1100px]:hidden" style={{ width: COLS.tags }}>
          Tags
        </span>
      </div>
      <span className="w-7 shrink-0" />
    </div>
  );
}

function EmptyState() {
  const view = useBrowse((s) => s.view);
  const text = useBrowse((s) => s.text);
  const filters = useBrowse((s) => s.filters);
  const categories = useBrowse((s) => s.categories);
  const kind = useBrowse((s) => s.kind);
  const clearAll = useBrowse((s) => s.clearAll);
  const setText = useBrowse((s) => s.setText);
  const narrowed = text.trim() !== "" || activeFilterCount(filters) > 0 || categories.length > 0 || kind !== "all";

  let title = "Nothing matches";
  let body = "Try fewer words, or clear the filters to widen the search.";
  if (!narrowed) {
    switch (view.type) {
      case "favorites":
        title = "No favorites yet";
        body = "Press F or click the star on any sample to keep it here.";
        break;
      case "collection":
        title = "This collection is empty";
        body = "Right-click a sample and choose Add to collection, or drag samples onto the collection.";
        break;
      case "recent-played":
        title = "Nothing played yet";
        body = "Samples you preview show up here, newest first.";
        break;
      case "recent-added":
        title = "Nothing new this week";
        body = "Samples added to your folders in the last 7 days show up here.";
        break;
      default:
        title = "No samples here yet";
        body = "Samples appear as soon as they're indexed.";
    }
  }
  return (
    <div className="flex flex-col items-center gap-2.5 px-6 py-16 text-center">
      <span className="text-[14px] font-medium">{title}</span>
      <span className="max-w-[380px] text-ui text-text3">{body}</span>
      {narrowed && (
        <button
          type="button"
          onClick={() => {
            setText("");
            clearAll();
          }}
          className="mt-1 h-[30px] rounded-lg border border-line2 px-3 text-ui hover:bg-raised"
        >
          Clear search and filters
        </button>
      )}
    </div>
  );
}

export function SampleList() {
  const total = useBrowse((s) => s.total);
  const queryKey = useBrowse((s) => s.queryKey);
  const version = useBrowse((s) => s.version);
  const pages = useBrowse((s) => s.pages);
  const selectedIndex = useBrowse((s) => s.selectedIndex);
  const ensureRange = useBrowse((s) => s.ensureRange);
  const rowAt = useBrowse((s) => s.rowAt);
  const keyMatcher = useKeyMatcher();
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: total ?? 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? 0;

  useEffect(() => {
    if (total) ensureRange(first, last);
  }, [first, last, total, pages, version, queryKey, ensureRange]);

  useEffect(() => {
    parentRef.current?.scrollTo({ top: 0 });
  }, [queryKey]);

  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
  }, [selectedIndex, virtualizer]);

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto py-1" aria-label="Samples">
      {total === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((vi) => {
            const row = rowAt(vi.index);
            return (
              <div key={vi.key} className="absolute top-0 left-0 w-full" style={{ height: ROW_H, transform: `translateY(${vi.start}px)` }}>
                {row ? (
                  <SampleRowView row={row} index={vi.index} keyMatch={keyMatcher ? keyMatcher(row) : null} />
                ) : (
                  <div className="flex h-11 items-center gap-4 px-[88px]">
                    <span className="h-2.5 w-56 rounded bg-raised" />
                    <span className="h-2.5 w-40 rounded bg-raised" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
