import { useVirtualizer } from "@tanstack/react-virtual";
import { ListEnd, Maximize2, Pause, Pin, Play, Repeat, Search, Star, X } from "lucide-react";
import { forwardRef, memo, useEffect, useRef } from "react";
import { dragSample, sampleMenu, setPlayNext, toggleLoop } from "../lib/actions";
import { bpmText, fmtCount, fmtLength, keyText } from "../lib/format";
import { keyFilterLabel } from "../lib/keys";
import { isMac, isWindows, modKey } from "../lib/platform";
import type { Processing } from "../lib/processing";
import { useRender, type RenderState } from "../lib/renders";
import type { SampleRow } from "../lib/types";
import { useBrowse } from "../store/browse";
import { useLibrary } from "../store/library";
import { useLoopOn, usePlayer } from "../store/player";
import { usePrefs } from "../store/prefs";
import { useEdit, useEdits } from "../store/project";
import { useRecord } from "../store/record";
import { useUi } from "../store/ui";
import { lengthLabel, tempoLabel } from "./FilterPanel";
import { KEY_FIT_TONE, keyFitLabel, keyFitText, useKeyFit, type KeyFit } from "./ListColumns";
import { openContextMenu } from "./Menu";
import { Clock, dragHeard, PitchStepper, PLAY_NEXT_LABEL, ReverseIcon, useElementWidth, useSeekOrDrag } from "./PreviewPanel";
import { KeyControl, SyncSwitch, TempoControl } from "./ProjectControls";
import { cx, IconButton, Kbd } from "./ui";
import { MiniWave } from "./Waveforms";
import { MiniRecord } from "./record/RecordPanel";
import { TakeList } from "./record/Takes";
import { WindowControls } from "./WindowControls";

const ROW_H = 56;

function Grip() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" className="fill-text3">
      <circle cx="9" cy="6" r="1.8" />
      <circle cx="15" cy="6" r="1.8" />
      <circle cx="9" cy="12" r="1.8" />
      <circle cx="15" cy="12" r="1.8" />
      <circle cx="9" cy="18" r="1.8" />
      <circle cx="15" cy="18" r="1.8" />
    </svg>
  );
}

/** One-shots or loops; pressing the active one shows both again. */
function KindSwitch() {
  const kind = useBrowse((s) => s.kind);
  const setKind = useBrowse((s) => s.setKind);
  const option = (value: "oneshot" | "loop", label: string) => (
    <button
      type="button"
      aria-pressed={kind === value}
      onClick={() => setKind(kind === value ? "all" : value)}
      className={cx("h-6 rounded-[5px] px-2 text-small transition-colors", kind === value ? "bg-seg font-medium text-text shadow-[0_1px_2px_rgba(0,0,0,0.12)]" : "text-text2 hover:text-text")}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Sample type" className="flex shrink-0 gap-0.5 rounded-[7px] bg-raised p-0.5">
      {option("oneshot", "Shots")}
      {option("loop", "Loops")}
    </div>
  );
}

function FilterChips() {
  const f = useBrowse((s) => s.filters);
  const setFilters = useBrowse((s) => s.setFilters);
  const total = useBrowse((s) => s.total);
  const chip = (key: string, label: string, clear: () => void, mono?: boolean) => (
    <button
      key={key}
      type="button"
      title="Remove this filter"
      onClick={clear}
      className={cx("group flex h-6 shrink-0 items-center gap-1 rounded-[5px] bg-raised px-2 text-text2 hover:text-text", mono ? "font-mono text-micro" : "text-small")}
    >
      {label}
      <X size={10} strokeWidth={2.5} className="text-text3 opacity-0 group-hover:opacity-100" />
    </button>
  );
  const chips = [];
  const tempo = tempoLabel(f);
  if (tempo) chips.push(chip("bpm", tempo, () => setFilters({ bpmMin: null, bpmMax: null, halfDouble: false }), true));
  if (f.key) chips.push(chip("key", keyFilterLabel(f.key).replace(" + compatible", " +"), () => setFilters({ key: null })));
  const length = lengthLabel(f);
  if (length) chips.push(chip("len", length, () => setFilters({ durMin: null, durMax: null }), true));
  for (const t of f.tags) chips.push(chip(`t-${t}`, t, () => setFilters({ tags: f.tags.filter((x) => x !== t) })));
  return (
    <div className="flex h-6 items-center gap-1">
      <div className="no-scrollbar flex min-w-0 gap-1 overflow-x-auto">{chips}</div>
      <div className="flex-1" />
      <span className="shrink-0 font-mono text-micro text-text3 tabular">{total == null ? "" : fmtCount(total)}</span>
    </div>
  );
}

const MiniRow = memo(function MiniRow({ row, index, width, keyFit }: { row: SampleRow; index: number; width: number; keyFit: KeyFit | null }) {
  const selected = useBrowse((s) => s.selected?.id === row.id);
  const status = usePlayer((s) => (s.id === row.id ? s.status : "idle"));
  const playing = status === "playing" || status === "loading";
  const bpmFixed = usePrefs((s) => s.bpmFixed);
  const tempo = bpmText(row, bpmFixed);
  const meta = row.kind === "loop" ? [tempo === "—" ? null : tempo, keyText(row)] : [fmtLength(row.duration), keyText(row)];
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
      onClick={() => select()}
      onDoubleClick={() => usePlayer.getState().play(row)}
      className={cx("flex h-14 items-center gap-1.5 pr-2 pl-1.5", selected ? "bg-raised" : "hover:bg-raised/60", !row.online && "opacity-45")}
    >
      <button
        type="button"
        aria-label={`${playing ? "Pause" : "Play"} ${row.name}`}
        onClick={(e) => {
          e.stopPropagation();
          select(false);
          usePlayer.getState().toggle(row);
        }}
        className={cx("grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full", selected || playing ? "text-accent-ink" : "text-text3 hover:text-text")}
      >
        {playing ? <Pause size={12} fill="currentColor" strokeWidth={0} /> : <Play size={12} fill="currentColor" strokeWidth={0} />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-ui font-medium">{row.name}</span>
          <span className="shrink-0 font-mono text-micro text-text3">
            {meta.filter(Boolean).join(" · ")}
            {keyFit && (
              <span className={cx("ml-1.5", KEY_FIT_TONE[keyFit.fit])} title={keyFitText(keyFit)}>
                {keyFitLabel(keyFit)}
              </span>
            )}
          </span>
        </div>
        <MiniWave peaks={row.peaks} width={Math.max(40, width)} height={16} sampleId={row.id} emphasized={selected} />
      </div>
      <button
        type="button"
        aria-label={row.favorite ? `Remove ${row.name} from favorites` : `Add ${row.name} to favorites`}
        aria-pressed={row.favorite}
        onClick={(e) => {
          e.stopPropagation();
          useBrowse.getState().toggleFavorite(row);
        }}
        className={cx("grid h-[26px] w-[26px] shrink-0 place-items-center rounded-md", row.favorite ? "text-accent-ink" : "text-text3 hover:text-text")}
      >
        <Star size={14} strokeWidth={1.75} fill={row.favorite ? "currentColor" : "none"} />
      </button>
    </div>
  );
});

function MiniList() {
  const total = useBrowse((s) => s.total);
  const queryKey = useBrowse((s) => s.queryKey);
  const version = useBrowse((s) => s.version);
  const pages = useBrowse((s) => s.pages);
  const selectedIndex = useBrowse((s) => s.selectedIndex);
  const ensureRange = useBrowse((s) => s.ensureRange);
  const rowAt = useBrowse((s) => s.rowAt);
  const parent = useRef<HTMLDivElement>(null);
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const keyFitFor = useKeyFit();
  const virtualizer = useVirtualizer({ count: total ?? 0, getScrollElement: () => parent.current, estimateSize: () => ROW_H, overscan: 10 });
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? 0;
  useEffect(() => {
    if (total) ensureRange(first, last);
  }, [first, last, total, pages, version, queryKey, ensureRange]);
  useEffect(() => {
    parent.current?.scrollTo({ top: 0 });
  }, [queryKey]);
  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
  }, [selectedIndex, virtualizer]);
  // Waveforms fill the row between the play button and the star.
  const waveWidth = width - 30 - 26 - 6 * 2 - 14;
  return (
    <div ref={parent} className="mt-2 min-h-0 flex-1 overflow-y-auto border-t border-line" aria-label="Samples">
      <div ref={measure} className="w-full" />
      {total === 0 ? (
        <p className="m-0 px-6 py-10 text-center text-ui text-text3">Nothing matches. Try fewer words.</p>
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((vi) => {
            const row = rowAt(vi.index);
            return (
              <div key={vi.key} className="absolute top-0 left-0 w-full" style={{ height: ROW_H, transform: `translateY(${vi.start}px)` }}>
                {row ? <MiniRow row={row} index={vi.index} width={waveWidth} keyFit={keyFitFor ? keyFitFor(row) : null} /> : <div className="mx-11 mt-5 h-2.5 w-48 rounded bg-raised" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The mini player's drag button; like the full window's tile, it says when the drive is gone or the render failed. */
function MiniDrag({ row, state, processing, onRetry }: { row: SampleRow; state: RenderState; processing: Processing; onRetry: () => void }) {
  const offline = !row.online;
  const failed = !offline && state.kind === "error";
  return (
    <div
      role="button"
      tabIndex={failed ? 0 : -1}
      draggable={!offline && !failed}
      aria-label={failed ? "Couldn't render. Try again" : offline ? "Drive not connected" : "Drag into your DAW"}
      title={
        offline
          ? "This sample's drive isn't connected"
          : state.kind === "error"
            ? `Couldn't render: ${state.message}. Click to try again.`
            : state.kind === "rendering"
              ? "Rendering…"
              : processing.processed
                ? `Drag the processed clip (${processing.label})`
                : "Drag into your DAW"
      }
      onDragStart={(e) => {
        e.preventDefault();
        dragHeard(row, state);
      }}
      onClick={failed ? onRetry : undefined}
      onKeyDown={(e) => {
        if (failed && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onRetry();
        }
      }}
      className={cx(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-[7px] border border-line2 bg-raised pr-2.5 pl-2 text-small font-semibold",
        offline ? "cursor-default opacity-60" : failed ? "cursor-pointer hover:bg-raised2" : "cursor-grab active:cursor-grabbing",
        state.kind === "rendering" && !offline && "animate-soft-pulse",
      )}
    >
      <Grip />
      {failed ? "Retry" : "Drag"}
    </div>
  );
}

/** The selected sample's waveform; click to play from a position, or drag it into your DAW (as in the full window). */
function PreviewWave({ row, reverse, state, beat }: { row: SampleRow; reverse: boolean; state: RenderState; beat: number | null }) {
  const [box, width] = useElementWidth<HTMLDivElement>();
  const duration = row.duration ?? 0;
  const grab = useSeekOrDrag(row, state, (clientX) => {
    const r = box.current!.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return (reverse ? 1 - f : f) * duration;
  }, { reverse, beat });
  return (
    <div
      ref={box}
      className={cx("relative h-[52px] rounded-sm", grab.canDrag && "cursor-grab active:cursor-grabbing", !row.online && "opacity-50")}
      role="slider"
      tabIndex={0}
      aria-label={`Waveform of ${row.name}. Click or use the arrow keys to play from a position${grab.canDrag ? ", or drag it into your DAW" : ""}.`}
      title={!row.online ? "This sample's drive isn't connected" : grab.canDrag ? (state.kind === "rendering" ? "Rendering…" : "Click to play from here, or drag into your DAW") : undefined}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration * 100) / 100}
      {...grab.aria}
      {...grab.handlers}
      onMouseLeave={grab.cancel}
    >
      {width > 0 && <MiniWave peaks={row.peaks} width={width} height={52} sampleId={row.id} emphasized />}
    </div>
  );
}

function MiniPreview() {
  const row = useBrowse((s) => s.selected);
  const status = usePlayer((s) => (row && s.id === row.id ? s.status : "idle"));
  const loopOn = useLoopOn(row);
  const playNext = usePrefs((s) => s.playNext);
  const edit = useEdit(row?.id);
  const update = useEdits((s) => s.update);
  const { state, processing, retry } = useRender(row);
  if (!row || !processing) {
    return (
      <section aria-label="Preview" className="flex h-[150px] shrink-0 items-center justify-center border-t border-line bg-panel px-6 text-center text-ui text-text3">
        Select a sample · ↑ ↓ to browse · Space to play
      </section>
    );
  }
  const playing = status === "playing" || status === "loading";
  return (
    <section aria-label="Preview" className="flex shrink-0 flex-col gap-2.5 border-t border-line bg-panel p-3.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-body font-semibold" title={row.name}>
          {row.name}
        </span>
        <Clock row={row} />
      </div>
      <PreviewWave row={row} reverse={edit.reverse} state={state} beat={processing.params.beat} />
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => usePlayer.getState().toggle(row)}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-on-accent"
        >
          {playing ? <Pause size={12} fill="currentColor" strokeWidth={0} /> : <Play size={12} fill="currentColor" strokeWidth={0} className="translate-x-px" />}
        </button>
        <IconButton
          label="Loop (L)"
          size={30}
          active={loopOn}
          aria-pressed={loopOn}
          onClick={() => toggleLoop(row)}
        >
          <Repeat size={15} strokeWidth={1.75} />
        </IconButton>
        <IconButton label={PLAY_NEXT_LABEL} size={30} active={playNext} aria-pressed={playNext} onClick={() => setPlayNext(!playNext)}>
          <ListEnd size={15} strokeWidth={1.75} />
        </IconButton>
        <IconButton label="Reverse (⇧R)" size={30} active={edit.reverse} aria-pressed={edit.reverse} onClick={() => update(row.id, { reverse: !edit.reverse })}>
          <ReverseIcon size={15} />
        </IconButton>
        <PitchStepper row={row} processing={processing} compact />
        <div className="flex-1" />
        <MiniDrag row={row} state={state} processing={processing} onRetry={retry} />
      </div>
    </section>
  );
}

/** Search, the project controls and the sample list. */
const MiniBrowse = forwardRef<HTMLInputElement>(function MiniBrowse(_, searchRef) {
  const text = useBrowse((s) => s.text);
  const setText = useBrowse((s) => s.setText);
  return (
    <>
      <div className="flex shrink-0 flex-col gap-2.5 px-3 pt-3">
        <label className="flex h-[34px] items-center gap-2 rounded-lg bg-raised pr-2 pl-2.5 text-text3 focus-within:ring-1 focus-within:ring-line2">
          <Search size={14} strokeWidth={2} aria-hidden="true" />
          <input
            ref={searchRef}
            type="text"
            spellCheck={false}
            autoCorrect="off"
            aria-label="Search samples"
            placeholder="Search samples"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-text3"
          />
          {text ? (
            <button type="button" aria-label="Clear search" onClick={() => setText("")} className="grid h-5 w-5 place-items-center rounded text-text3 hover:text-text">
              <X size={13} />
            </button>
          ) : (
            <Kbd>{modKey}K</Kbd>
          )}
        </label>
        <div className="flex items-center gap-1.5">
          <TempoControl compact />
          <KeyControl compact />
          <SyncSwitch />
          <div className="flex-1" />
          <KindSwitch />
        </div>
        <FilterChips />
      </div>
      <MiniList />
    </>
  );
});

/** A narrow window that can stay on top next to your DAW: search, list and preview. */
export const MiniPlayer = forwardRef<HTMLInputElement>(function MiniPlayer(_, searchRef) {
  const onTop = usePrefs((s) => s.miniOnTop);
  const hasSources = useLibrary((s) => s.sources.length > 0);
  const recordOpen = useRecord((s) => s.miniOpen);
  const miniTakes = useRecord((s) => s.miniTakes);
  const phase = useRecord((s) => s.phase);
  const { setMini, setOnTop } = useUi.getState();
  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <header data-tauri-drag-region className={cx("flex h-12 shrink-0 items-center gap-1.5 border-b border-line bg-panel", isWindows ? "pr-0" : "pr-2.5")} style={{ paddingLeft: isMac ? 84 : 12 }}>
        <div data-tauri-drag-region className="h-full flex-1" />
        <IconButton
          label={recordOpen ? "Hide recording" : "Record (R)"}
          size={28}
          active={recordOpen}
          aria-pressed={recordOpen}
          onClick={() => useRecord.getState().setMiniOpen(!recordOpen)}
        >
          <span aria-hidden="true" className={cx("grid h-[15px] w-[15px] place-items-center rounded-full border-[1.5px]", phase === "idle" || phase === "opening" ? "border-current" : "border-rec")}>
            <span className={cx("block h-[7px] w-[7px] rounded-full", phase === "armed" ? "border border-rec" : "bg-rec", phase !== "idle" && phase !== "opening" && "animate-rec-blink")} />
          </span>
        </IconButton>
        <button
          type="button"
          aria-pressed={onTop}
          title={onTop ? "Staying on top of other windows" : "Keep this window on top of other apps"}
          onClick={() => setOnTop(!onTop)}
          className={cx("flex h-7 items-center gap-1.5 rounded-md px-2 text-small", onTop ? "bg-raised2 text-accent-ink" : "text-text2 hover:bg-raised hover:text-text")}
        >
          <Pin size={14} strokeWidth={1.75} />
          <span>On top</span>
        </button>
        <IconButton label="Back to the full window" size={28} onClick={() => setMini(false)}>
          <Maximize2 size={15} strokeWidth={1.75} />
        </IconButton>
        {isWindows && <div className="w-1.5 shrink-0" />}
        <WindowControls />
      </header>
      {recordOpen && <MiniRecord />}
      {hasSources || recordOpen ? (
        <>
          {miniTakes && recordOpen ? (
            <TakeList compact className="border-b border-line" />
          ) : hasSources ? (
            <MiniBrowse ref={searchRef} />
          ) : (
            <div className="flex-1" />
          )}
          <MiniPreview />
        </>
      ) : (
        <div className="grid flex-1 place-items-center p-8 text-center">
          <div className="flex flex-col items-center gap-3">
            <span className="text-ui text-text3">Add your sample folders in the full window first.</span>
            <button type="button" onClick={() => setMini(false)} className="h-8 rounded-lg border border-line2 px-3 text-ui hover:bg-raised">
              Open the full window
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
