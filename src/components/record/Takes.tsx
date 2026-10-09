import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, Download, MoreHorizontal, Pause, Play, Trash2 } from "lucide-react";
import { memo, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { dragSample } from "../../lib/actions";
import { bpmText, fmtBytes, fmtLength, keyText } from "../../lib/format";
import { hasMod, modKey } from "../../lib/platform";
import type { SampleRow, TakesRetention } from "../../lib/types";
import { useBrowse } from "../../store/browse";
import { usePlayer } from "../../store/player";
import { usePrefs } from "../../store/prefs";
import { useRecord } from "../../store/record";
import { openContextMenu, openMenuBelow, type MenuItem } from "../Menu";
import { useElementWidth } from "../PreviewPanel";
import { useConfirm } from "../Prompt";
import { cx, IconButton } from "../ui";
import { MiniWave } from "../Waveforms";

const ROW_H = 56;

const RETENTION: { value: TakesRetention; label: string; note: string | null }[] = [
  { value: "keep", label: "Keep until I delete them", note: null },
  { value: "week", label: "Move to the Trash after 7 days", note: "Unsaved takes go to the Trash after 7 days." },
  { value: "quit", label: "Move to the Trash when Saga quits", note: "Unsaved takes go to the Trash when Saga quits." },
];

/** Takes still listed: unsaved ones and the ones saved this session, minus those waiting for their Undo. */
export function useVisibleTakes(): SampleRow[] {
  const takes = useRecord((s) => s.takes);
  const deleting = useRecord((s) => s.deleting);
  return deleting.length ? takes.filter((t) => !deleting.includes(t.id)) : takes;
}

function askClearUnsaved() {
  const n = useRecord.getState().takes.filter((t) => t.sourceId === useRecord.getState().takesSourceId).length;
  if (!n) return;
  useConfirm.getState().ask({
    title: `Move ${n === 1 ? "1 unsaved take" : `${n} unsaved takes`} to the Trash?`,
    body: "Takes you saved stay in Recordings. You can get these back from the Trash.",
    confirm: "Move to Trash",
    danger: true,
    onConfirm: () => void useRecord.getState().clearUnsaved(),
  });
}

function takesMenu(): MenuItem[] {
  const r = useRecord.getState();
  const retention = r.settings?.retention ?? "keep";
  const unsaved = r.takes.some((t) => t.sourceId === r.takesSourceId);
  return [
    { label: "Clear unsaved…", icon: <Trash2 size={14} />, disabled: !unsaved, onSelect: askClearUnsaved },
    "separator",
    { label: "Unsaved takes", heading: true },
    ...RETENTION.map<MenuItem>((o) => ({ label: o.label, checked: retention === o.value, onSelect: () => void useRecord.getState().setSettings({ retention: o.value }) })),
  ];
}

/** "Takes", how many and how much space the unsaved ones take, and the tray's menu. */
export function TakesHeader({ compact }: { compact?: boolean }) {
  const takes = useVisibleTakes();
  const bytes = useRecord((s) => s.bytes);
  const takesSourceId = useRecord((s) => s.takesSourceId);
  const unsaved = takes.filter((t) => t.sourceId === takesSourceId).length;
  return (
    <div className={cx("flex shrink-0 items-center gap-2", compact ? "h-9 px-3" : "h-10 pr-2 pl-4")}>
      <span className="text-ui font-semibold">Takes</span>
      <span className="min-w-0 flex-1 truncate font-mono text-micro text-text3 tabular">
        {takes.length > 0 && `${takes.length}${bytes > 0 ? ` · ${fmtBytes(bytes)}` : ""}`}
      </span>
      {unsaved > 0 && (
        <button
          type="button"
          title={unsaved === 1 ? "Save the take to Recordings" : `Save all ${unsaved} unsaved takes to Recordings`}
          onClick={() => void useRecord.getState().saveAll()}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-small text-text2 transition-colors hover:bg-raised hover:text-text"
        >
          <Download size={13} strokeWidth={1.75} />
          Save all
        </button>
      )}
      <IconButton label="Takes options" size={28} onClick={(e) => openMenuBelow(e.currentTarget, takesMenu, "right")}>
        <MoreHorizontal size={15} />
      </IconButton>
    </div>
  );
}

/** What happens to unsaved takes, when it isn't "keep them". */
export function RetentionNote() {
  const retention = useRecord((s) => s.settings?.retention ?? "keep");
  const note = RETENTION.find((o) => o.value === retention)?.note;
  if (!note) return null;
  return <p className="m-0 shrink-0 border-t border-line px-4 py-2 text-small text-text3">{note}</p>;
}

function rowMenu(row: SampleRow, saved: boolean): MenuItem[] {
  const r = useRecord.getState();
  return [
    { label: "Play", icon: <Play size={14} />, hint: "Space", onSelect: () => r.select(row, { play: true }) },
    ...(saved ? [] : [{ label: "Save to Recordings", icon: <Download size={14} />, hint: `${modKey}S`, onSelect: () => void r.save(row.id) } as MenuItem]),
    { label: "Rename…", hint: "F2", onSelect: () => r.setRenaming(row.id) },
    "separator",
    { label: "Move to the Trash", icon: <Trash2 size={14} />, hint: "⌫", danger: true, onSelect: () => r.remove([row.id]) },
  ];
}

const TakeRow = memo(function TakeRow({ row, waveWidth, compact }: { row: SampleRow; waveWidth: number; compact?: boolean }) {
  const selected = useRecord((s) => s.selectedId === row.id);
  const previewed = useBrowse((s) => s.selected?.id === row.id);
  const saved = row.sourceId !== useRecord((s) => s.takesSourceId);
  const landed = useRecord((s) => s.landed === row.id);
  const renaming = useRecord((s) => s.renaming === row.id);
  const status = usePlayer((s) => (s.id === row.id ? s.status : "idle"));
  const bpmFixed = usePrefs((s) => s.bpmFixed);
  const playing = status === "playing" || status === "loading";
  const listening = row.status === 0;
  const tempo = bpmText(row, bpmFixed);
  const meta = [fmtLength(row.duration), row.kind === "loop" && tempo !== "—" ? tempo : null, keyText(row)].filter(Boolean).join(" · ");
  const active = selected || previewed;
  const r = useRecord.getState;
  return (
    <div
      role="option"
      aria-selected={active}
      draggable={!renaming}
      onDragStart={(e) => {
        e.preventDefault();
        dragSample(row);
      }}
      onClick={() => r().select(row)}
      onDoubleClick={() => r().setRenaming(row.id)}
      onContextMenu={(e) => {
        r().select(row, { play: false });
        openContextMenu(e, rowMenu(row, saved));
      }}
      onAnimationEnd={() => landed && useRecord.setState({ landed: null })}
      className={cx(
        "group relative flex h-14 items-center gap-2 pr-2 pl-1.5",
        active ? "bg-raised" : "hover:bg-raised/60",
        landed && "animate-take-land",
        renaming ? "cursor-text" : "cursor-grab active:cursor-grabbing",
      )}
    >
      <button
        type="button"
        aria-label={`${playing ? "Pause" : "Play"} ${row.name}`}
        onClick={(e) => {
          e.stopPropagation();
          r().select(row, { play: false });
          usePlayer.getState().toggle(row);
        }}
        className={cx("grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full", active || playing ? "text-accent-ink" : "text-text3 hover:text-text")}
      >
        {playing ? <Pause size={12} fill="currentColor" strokeWidth={0} /> : <Play size={12} fill="currentColor" strokeWidth={0} className="translate-x-px" />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {renaming ? (
          <RenameField row={row} />
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-ui font-medium">{row.name}</span>
            {saved && (
              <span className="flex shrink-0 items-center gap-0.5 text-micro text-text3" title="Saved in Recordings, in your library">
                <Check size={11} strokeWidth={2.25} />
                {!compact && "In Recordings"}
              </span>
            )}
          </span>
        )}
        <span className="flex min-w-0 items-center gap-2 font-mono text-micro text-text3 tabular">
          {listening ? (
            <>
              <span>{fmtLength(row.duration)}</span>
              <span className="animate-soft-pulse" aria-label="Finding tempo and key">
                Listening…
              </span>
            </>
          ) : (
            <span className="truncate">{meta}</span>
          )}
        </span>
      </div>
      {!compact && (
        <span className="shrink-0 group-focus-within:invisible group-hover:invisible">
          <MiniWave peaks={row.peaks} width={waveWidth} height={20} sampleId={row.id} emphasized={active} />
        </span>
      )}
      <div
        className={cx(
          "absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-0.5 rounded-lg",
          active ? "bg-raised" : "bg-panel",
          compact ? "" : "invisible group-focus-within:visible group-hover:visible",
          renaming && "hidden",
        )}
      >
        {!saved && !compact && (
          <IconButton
            label={`Save to Recordings (${modKey}S)`}
            size={28}
            onClick={(e) => {
              e.stopPropagation();
              void r().save(row.id);
            }}
          >
            <Download size={14} strokeWidth={1.75} />
          </IconButton>
        )}
        {!compact && (
          <IconButton
            label="Move to the Trash (⌫)"
            size={28}
            onClick={(e) => {
              e.stopPropagation();
              r().remove([row.id]);
            }}
          >
            <Trash2 size={14} strokeWidth={1.75} />
          </IconButton>
        )}
      </div>
    </div>
  );
});

/** Renames an unsaved take in place: Enter or leaving keeps the name, Esc puts it back. */
function RenameField({ row }: { row: SampleRow }) {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    void useRecord.getState().rename(row.id, input.current?.value ?? row.name);
  };
  return (
    <input
      ref={input}
      type="text"
      spellCheck={false}
      autoCorrect="off"
      aria-label={`Name for ${row.name}`}
      defaultValue={row.name}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          done.current = true;
          useRecord.getState().setRenaming(null);
        }
      }}
      onBlur={commit}
      className="h-6 min-w-0 rounded-md border border-line2 bg-bg px-1.5 text-ui text-text outline-none focus:border-accent-wave"
    />
  );
}

/**
 * The takes, newest first. Click to preview below, drag into the DAW (which saves the take), or use the keys while
 * the list has focus: ↑ ↓ move, Space plays, Enter plays from the start, ⌫ deletes, ⌘S saves, F2 renames.
 */
export function TakeList({ compact, className }: { compact?: boolean; className?: string }) {
  const takes = useVisibleTakes();
  const selectedId = useRecord((s) => s.selectedId);
  const landed = useRecord((s) => s.landed);
  const parent = useRef<HTMLDivElement>(null);
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const virtualizer = useVirtualizer({ count: takes.length, getScrollElement: () => parent.current, estimateSize: () => ROW_H, overscan: 8 });
  const index = takes.findIndex((t) => t.id === selectedId);

  useEffect(() => {
    if (landed != null) parent.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [landed]);
  useEffect(() => {
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  }, [index, virtualizer]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget && (e.target as HTMLElement).tagName === "INPUT") return;
    const r = useRecord.getState();
    const current = takes[index] ?? null;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      handled();
      if (!takes.length) return;
      const next = takes[Math.max(0, Math.min(takes.length - 1, index < 0 ? 0 : index + (e.key === "ArrowDown" ? 1 : -1)))];
      r.select(next);
    } else if (e.key === " " && current) {
      handled();
      usePlayer.getState().toggle(current);
    } else if (e.key === "Enter" && current) {
      handled();
      usePlayer.getState().play(current);
    } else if ((e.key === "Backspace" || e.key === "Delete") && current) {
      handled();
      const at = index;
      r.remove([current.id]);
      const rest = takes.filter((t) => t.id !== current.id);
      if (rest.length) r.select(rest[Math.min(at, rest.length - 1)], { play: false });
    } else if (hasMod(e) && e.key.toLowerCase() === "s" && current) {
      handled();
      void r.save(current.id);
    } else if (e.key === "F2" && current) {
      handled();
      r.setRenaming(current.id);
    }
  };

  // The waveform fills what's left beside the play button and the name.
  const waveWidth = Math.max(40, Math.min(88, Math.round(width * 0.28)));
  return (
    <div
      ref={parent}
      role="listbox"
      aria-label="Takes"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cx("min-h-0 flex-1 overflow-y-auto outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]", className)}
    >
      <div ref={measure} className="w-full" />
      {takes.length === 0 ? (
        <p className="m-0 px-6 py-8 text-center text-ui leading-snug text-pretty text-text3">Takes you record show up here. Drag one into your DAW to keep it.</p>
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => (
            <div key={takes[vi.index].id} className="absolute top-0 left-0 w-full" style={{ height: ROW_H, transform: `translateY(${vi.start}px)` }}>
              <TakeRow row={takes[vi.index]} waveWidth={waveWidth} compact={compact} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The newest take on its own, for the mini player: the one most likely to be dragged next. */
export function LatestTake() {
  const takes = useVisibleTakes();
  const latest = takes[0];
  if (!latest) return null;
  return (
    <div className="border-t border-line">
      <TakeRow row={latest} waveWidth={0} compact />
    </div>
  );
}
