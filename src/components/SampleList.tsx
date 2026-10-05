import { useVirtualizer } from "@tanstack/react-virtual";
import { Pause, Play, Star } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";
import { dragSample, dragSamples, pickedMenu, sampleMenu } from "../lib/actions";
import { hasMod } from "../lib/platform";
import { compatibleKeys } from "../lib/keys";
import { fittingKeys, plainScale, scaleById, scaleNotes } from "../lib/theory";
import type { SampleRow } from "../lib/types";
import { activeFilterCount, targetRows, useBrowse } from "../store/browse";
import { usePlayer } from "../store/player";
import { usePrefs } from "../store/prefs";
import { useProject } from "../store/project";
import { openContextMenu } from "./Menu";
import { cx } from "./ui";
import { ColumnCell, useVisibleColumns, type CellContext } from "./ListColumns";

const ROW_H = 44;

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
    const key = filterKey ?? (projectKey ? { pc: projectKey.pc, mode: projectKey.mode, compatible: true, scale: scaleById(projectKey.scale)?.steps } : null);
    if (!key) return null;
    const steps = key.scale?.length ? key.scale : null;
    const set = !key.compatible ? [{ pc: key.pc, mode: key.mode }] : steps ? fittingKeys(key.pc, steps) : compatibleKeys(key.pc, key.mode);
    const scale = scaleNotes(key.pc, steps ?? plainScale(key.mode).steps);
    return (row: SampleRow) =>
      row.keyPc != null && (row.keyMode === 2 ? scale.includes(row.keyPc) : set.some((k) => k.pc === row.keyPc && k.mode === row.keyMode));
  }, [filterKey, projectKey]);
}

const SampleRowView = memo(function SampleRowView({ row, index, keyMatch }: { row: SampleRow; index: number; keyMatch: boolean | null }) {
  const selected = useBrowse((s) => s.selected?.id === row.id);
  const picked = useBrowse((s) => s.picked.has(row.id));
  const bpmFixed = usePrefs((s) => s.bpmFixed);
  const columns = useVisibleColumns();
  const status = usePlayer((s) => (s.id === row.id ? s.status : "idle"));
  const playing = status === "playing" || status === "loading";
  const segments = row.dir.split("/").filter(Boolean);
  const where = segments.length > 1 ? `${segments[0]}  ›  ${segments[segments.length - 1]}` : row.pack;

  const select = (play?: boolean) => useBrowse.getState().selectRow(row, index, play === undefined ? undefined : { play });
  // Acting on a row that's among the picked ones acts on all of them.
  const inPicked = () => useBrowse.getState().picked.has(row.id);
  const ctx: CellContext = { selected, keyMatch, bpmFixed };

  return (
    <div
      draggable={row.online}
      onDragStart={(e) => {
        e.preventDefault();
        if (inPicked()) {
          void targetRows().then(dragSamples);
          return;
        }
        select(false);
        dragSample(row);
      }}
      onContextMenu={(e) => {
        if (inPicked()) {
          openContextMenu(e, pickedMenu());
          return;
        }
        select(false);
        openContextMenu(e, sampleMenu(row, index));
      }}
      aria-selected={selected || picked}
      className={cx("group flex h-11 items-center gap-1 px-4", picked ? "bg-accent-soft" : selected ? "bg-raised" : "hover:bg-raised/60", !row.online && "opacity-45")}
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
        onClick={(e) => {
          const browse = useBrowse.getState();
          if (e.shiftKey) void browse.pickRange(index, hasMod(e));
          else if (hasMod(e)) browse.togglePick(row, index);
          else select();
        }}
        onDoubleClick={(e) => !e.shiftKey && !hasMod(e) && usePlayer.getState().play(row)}
        className="flex h-11 min-w-0 flex-1 items-center gap-4 pl-1 text-left"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-body font-medium text-text">
            {row.name}
            <span className="font-normal text-text3">.{row.ext}</span>
          </span>
          <span className="truncate text-[11.5px] text-text3">{where}</span>
        </span>
        {columns.map((c) => (
          <ColumnCell key={c.id} column={c} row={row} ctx={ctx} />
        ))}
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
