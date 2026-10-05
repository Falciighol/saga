import { FolderPlus, FolderSearch, ListEnd, Minus, Pause, Play, Plus, Repeat, SlidersHorizontal, Star, Volume2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { usePalette } from "../hooks/useTheme";
import { askProjectKey, collectionSubmenu, dragOut, dragSample, findSimilar, keySubmenu, reveal, setPlayNext, tempoSubmenu, toggleLoop } from "../lib/actions";
import { api, errorMessage } from "../lib/api";
import { barsCount, ESTIMATE, fmtBpm, fmtChannels, fmtClock, fmtDb, fmtRate, hasTempo, sourceHint } from "../lib/format";
import { modKey, revealLabel } from "../lib/platform";
import { projectKeyLabel } from "../lib/keys";
import { DEFAULT_EDIT, keyLabel, type Processing } from "../lib/processing";
import { useRender, type RenderState } from "../lib/renders";
import { usePixelRatio } from "../lib/scale";
import type { SampleRow } from "../lib/types";
import { decodePeaks, setupCanvas, toBars } from "../lib/waveform";
import { useBrowse } from "../store/browse";
import { useEditor } from "../store/editor";
import { playerPosition, shouldLoop, timelinePosition, useLoopOn, usePlayer } from "../store/player";
import { usePrefs } from "../store/prefs";
import { pitchStep, stepPitch, useEdit, useEdits, useProject } from "../store/project";
import { toast } from "../store/toasts";
import { openMenuBelow, type MenuItem } from "./Menu";
import { Popover } from "./Popover";
import { cx, Divider, IconButton, SectionLabel, Switch } from "./ui";
import { SimilarIcon } from "./ViewToggle";

export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Like useElementWidth, for things that also give way vertically (the preview waveform). */
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const width = Math.floor(e.contentRect.width);
      const height = Math.floor(e.contentRect.height);
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export function ReverseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4" />
    </svg>
  );
}

export function MetronomeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3h6l4 18H5z" />
      <path d="m12 16 5-9" />
    </svg>
  );
}

/** Drags out what you hear: the original file, or the render the preview made of it. */
export function dragHeard(row: SampleRow, state: RenderState) {
  if (state.kind === "original") dragOut([state.path], [row.id]);
  else dragSample(row);
}

/**
 * Lets a waveform both seek and drag out, here and in the mini player. A press that doesn't move seeks where it's
 * released; moving past the browser's drag threshold drags out what you hear instead (the same file as the drag tile)
 * and leaves playback where it was. With focus, ← → seek a beat (⇧ a bar), or a twentieth of a one-shot (⇧ a quarter),
 * and Home goes back to the start. The keys work along the display, which is flipped when reversing, so the left edge
 * is always where playback starts and → always moves the playhead right.
 */
export function useSeekOrDrag(
  row: SampleRow,
  state: RenderState,
  timeAt: (clientX: number) => number,
  { reverse, beat }: { reverse: boolean; beat: number | null },
) {
  const pressed = useRef(false);
  // Where the keyboard last put the playhead, as time from the left edge, for screen readers; a live value would
  // re-render every frame.
  const [now, setNow] = useState(0);
  useEffect(() => setNow(0), [row.id]);
  const duration = row.duration ?? 0;
  const canDrag = row.online && state.kind !== "error";
  // File time and display time are the same thing read from opposite ends when reversing.
  const flip = (t: number) => (reverse ? duration - t : t);
  const position = () => {
    const s = usePlayer.getState();
    return s.id === row.id && s.status !== "idle" ? flip(playerPosition(s)) : now;
  };
  const seekTo = (p: number) => {
    const to = Math.max(0, Math.min(duration - 0.001, p));
    setNow(to);
    usePlayer.getState().seek(row, flip(to));
  };
  const bar = beat ? `, bar ${Math.floor(now / (beat * 4)) + 1}` : "";
  return {
    canDrag,
    /** Slider values for the waveform element. */
    aria: { "aria-valuenow": Math.round(now * 100) / 100, "aria-valuetext": `${fmtClock(now)} of ${fmtClock(duration)}${bar}` },
    /** Forgets a press that left the waveform, so releasing back over it later doesn't seek. */
    cancel: () => {
      pressed.current = false;
    },
    handlers: {
      draggable: canDrag,
      onMouseDown: (e: ReactMouseEvent) => {
        pressed.current = e.button === 0;
      },
      onMouseUp: (e: ReactMouseEvent) => {
        if (!pressed.current) return;
        pressed.current = false;
        if (row.duration) usePlayer.getState().seek(row, timeAt(e.clientX));
      },
      onDragStart: (e: DragEvent) => {
        e.preventDefault();
        pressed.current = false;
        dragHeard(row, state);
      },
      onFocus: () => setNow(position()),
      onKeyDown: (e: ReactKeyboardEvent) => {
        if (!duration || hasModifier(e)) return;
        const step = beat ? beat * (e.shiftKey ? 4 : 1) : duration * (e.shiftKey ? 0.25 : 0.05);
        const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!dir && e.key !== "Home") return;
        // The app's own ← (back to the start) and ↑ ↓ wait until the waveform lets go of focus.
        e.preventDefault();
        e.stopPropagation();
        seekTo(e.key === "Home" ? 0 : position() + dir * step);
      },
    },
  };
}

const hasModifier = (e: ReactKeyboardEvent) => e.metaKey || e.ctrlKey || e.altKey;

/** Label of the Play next buttons here and in the mini player. */
export const PLAY_NEXT_LABEL = "Play the next sample when one ends";

/** The waveform as you hear it: reversed when reversing, with the loop region highlighted. */
function BigWaveform({ row, processing, state, ruler: showRuler = true }: { row: SampleRow; processing: Processing; state: RenderState; ruler?: boolean }) {
  // The box is 96px tall when the panel has room, and shrinks first when the window is short or zoomed in.
  const [box, { width, height }] = useElementSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef<HTMLDivElement>(null);
  const hoverLabel = useRef<HTMLSpanElement>(null);
  const hoverTime = useRef<HTMLSpanElement>(null);
  const hoverHint = useRef<HTMLSpanElement>(null);
  const colors = usePalette();
  const ratio = usePixelRatio();
  const status = usePlayer((s) => (s.id === row.id ? s.status : "idle"));
  const looping = useLoopOn(row);
  const step = 3;
  const duration = row.duration ?? 0;
  const reverse = processing.params.reverse;
  const bars = barsCount(duration, processing.sourceBpm);
  const toX = (t: number) => (duration ? (reverse ? duration - t : t) / duration : 0);

  const values = useMemo(() => {
    const p = decodePeaks(row.peaks);
    if (!p || !width) return null;
    const v = toBars(p, Math.floor(width / step));
    return reverse ? v.slice().reverse() : v;
  }, [row.peaks, width, reverse]);

  const ruler = useMemo(() => {
    if (!width || !duration) return [];
    if (bars) {
      const every = bars > 16 ? 4 : bars > 8 ? 2 : 1;
      return Array.from({ length: Math.ceil(bars / every) }, (_, i) => ({ x: toX((i * every * duration) / bars), label: String(i * every + 1) }));
    }
    return [0, 0.25, 0.5, 0.75].map((f) => ({ x: f, label: `${(duration * (reverse ? 1 - f : f)).toFixed(duration < 2 ? 2 : 1)} s` }));
  }, [width, duration, bars, reverse]);

  const rs = toX(processing.regionStart);
  const re = toX(processing.regionEnd);
  const regionLeft = Math.min(rs, re);
  const regionRight = Math.max(rs, re);
  const partial = processing.params.regionStart != null;

  useEffect(() => {
    const c = canvas.current;
    if (!c || !width || !height) return;
    const draw = () => {
      const ctx = setupCanvas(c, width, height);
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      if (bars) {
        const beats = bars * 4;
        for (let b = 1; b < beats; b++) {
          const x = Math.round((b / beats) * width) + 0.5;
          ctx.fillStyle = b % 4 === 0 ? colors.line2 : colors.line;
          if (b % 4 === 0 || beats <= 32) ctx.fillRect(x, 0, 1, height);
        }
      }
      const s = usePlayer.getState();
      const active = s.id === row.id && s.status !== "idle";
      const pos = active ? toX(playerPosition(s)) : null;
      const count = Math.floor(width / step);
      const mid = height / 2;
      ctx.lineCap = "round";
      ctx.lineWidth = 2;
      if (!values) {
        ctx.fillStyle = colors.wave;
        for (let i = 0; i < count; i += 2) ctx.fillRect(i * step, mid - 0.5, 2, 1);
      } else {
        const lo = Math.round(regionLeft * count);
        const hi = Math.round(regionRight * count);
        const cut = pos == null ? -1 : Math.round(pos * count);
        const pass = (from: number, to: number, color: string) => {
          if (to <= from) return;
          ctx.strokeStyle = color;
          ctx.beginPath();
          for (let i = from; i < to; i++) {
            const a = Math.max(0.5, values[i] * (mid - 2));
            const x = i * step + step / 2;
            ctx.moveTo(x, mid - a);
            ctx.lineTo(x, mid + a);
          }
          ctx.stroke();
        };
        // Outside the loop region is dimmed; inside, played audio is in the accent color.
        pass(0, lo, colors.wave);
        pass(hi, count, colors.wave);
        // The display is flipped when reversing, so playback always moves left to right.
        if (cut >= 0) {
          const c = Math.min(hi, Math.max(lo, cut));
          pass(lo, c, colors.accentWave);
          pass(c, hi, colors.wave2);
        } else pass(lo, hi, colors.wave2);
      }
      if (pos != null) {
        ctx.fillStyle = colors.text;
        ctx.fillRect(Math.round(pos * width) - 1, 0, 2, height);
      }
    };
    if (status !== "playing") {
      draw();
      return;
    }
    let raf = 0;
    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [values, width, height, colors, ratio, status, bars, row.id, regionLeft, regionRight, reverse]);

  const timeAt = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return (reverse ? 1 - f : f) * duration;
  };
  const grab = useSeekOrDrag(row, state, timeAt, { reverse, beat: processing.params.beat });

  return (
    <div className="relative flex min-h-0 flex-col">
      {showRuler && (
        <>
          <div className="relative h-4 shrink-0">
            {ruler.map((m) => (
              <span
                key={m.label}
                // Reversed bars run leftwards from where they start, so their labels hang left of the line. Seconds are
                // points in time, not spans, and keep to the right.
                className={cx("absolute top-0 h-3.5 font-mono text-micro leading-3.5 text-text3", reverse && bars ? "-translate-x-full border-r border-line2 pr-1" : "border-l border-line2 pl-1")}
                style={{ left: `${m.x * 100}%` }}
              >
                {m.label}
              </span>
            ))}
          </div>
          <div className="relative mt-1 h-[3px] shrink-0">
            {looping && (
              <div className="absolute top-0 h-[3px] rounded-full bg-accent-wave" style={{ left: `${regionLeft * 100}%`, width: `${(regionRight - regionLeft) * 100}%` }} />
            )}
          </div>
        </>
      )}
      <div
        ref={box}
        className={cx("relative h-24 min-h-6 rounded-sm", showRuler && "mt-1.5", grab.canDrag && "cursor-grab active:cursor-grabbing", !row.online && "opacity-50")}
        role="slider"
        tabIndex={0}
        aria-label={`Waveform of ${row.name}. Click or use the arrow keys to play from a position${grab.canDrag ? ", or drag it into your DAW" : ""}.`}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration * 100) / 100}
        {...grab.aria}
        {...grab.handlers}
        onMouseMove={(e) => {
          const t = timeAt(e.clientX);
          const x = toX(t);
          if (hoverRef.current) {
            hoverRef.current.style.opacity = "1";
            hoverRef.current.style.left = `${x * 100}%`;
          }
          // The readout sits right of the line, and flips to its left near the end so it stays in the panel.
          if (hoverLabel.current) {
            hoverLabel.current.style.left = x > 0.7 ? "auto" : "";
            hoverLabel.current.style.right = x > 0.7 ? "6px" : "";
          }
          if (hoverTime.current) hoverTime.current.textContent = fmtClock(t);
          if (hoverHint.current) {
            hoverHint.current.textContent = !row.online
              ? " · drive not connected"
              : !grab.canDrag
                ? ""
                : state.kind === "rendering"
                  ? " · Rendering…"
                  : " · drag into your DAW";
          }
        }}
        onMouseLeave={() => {
          grab.cancel();
          if (hoverRef.current) hoverRef.current.style.opacity = "0";
        }}
      >
        {partial && (
          <div className="pointer-events-none absolute top-0 bottom-0 bg-accent-soft" style={{ left: `${regionLeft * 100}%`, width: `${(regionRight - regionLeft) * 100}%` }} />
        )}
        <canvas ref={canvas} style={{ width: width || "100%", height: height || "100%" }} className="absolute inset-0 block" />
        <div ref={hoverRef} className="pointer-events-none absolute top-0 bottom-0 w-px bg-text3 opacity-0" style={{ left: 0 }}>
          <span ref={hoverLabel} className={cx("absolute left-1.5 rounded bg-raised2 px-1 text-micro whitespace-nowrap", showRuler ? "-top-5" : "top-1")}>
            <span ref={hoverTime} className="font-mono text-text2 tabular" />
            <span ref={hoverHint} className="text-text2" />
          </span>
        </div>
      </div>
    </div>
  );
}

/** Elapsed / total as heard (after tempo changes). */
export function Clock({ row }: { row: SampleRow }) {
  const ref = useRef<HTMLSpanElement>(null);
  const status = usePlayer((s) => (s.id === row.id ? s.status : "idle"));
  useEffect(() => {
    const set = () => {
      const s = usePlayer.getState();
      const active = s.id === row.id && s.status !== "idle";
      const rate = active ? s.rate : 1;
      const heard = active ? timelinePosition(s) / rate : 0;
      const total = active ? s.length / rate : (row.duration ?? 0);
      if (ref.current) ref.current.textContent = `${fmtClock(heard)} / ${fmtClock(total)}`;
    };
    set();
    if (status !== "playing") return;
    let raf = 0;
    const loop = () => {
      set();
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [status, row.id, row.duration]);
  return <span ref={ref} className="font-mono text-small whitespace-nowrap text-text2 tabular" />;
}

/** Shows the first `limit` tags as chips and the rest behind a "+N" button, so the file name keeps its room. */
function TagEditor({ row, limit }: { row: SampleRow; limit: number }) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  // Set once Enter or Escape has dealt with the input, so the blur that follows doesn't add the tag again.
  const finished = useRef(false);
  const patchRow = useBrowse((s) => s.patchRow);
  const rest = row.tags.slice(limit);

  const save = async (tags: string[]) => {
    try {
      const updated = await api.setUserTags(row.id, tags);
      if (updated) patchRow(row.id, { tags: updated.tags, userTags: updated.userTags });
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  // Tags Saga found are listed for reference; the ones you added can be removed from here too.
  const showRest = (el: HTMLElement) => {
    const found = rest.filter((t) => !row.userTags.includes(t));
    const mine = rest.filter((t) => row.userTags.includes(t));
    const items: MenuItem[] = found.map((t) => ({ label: t, disabled: true }));
    if (found.length && mine.length) items.push("separator");
    for (const t of mine) items.push({ label: `Remove tag “${t}”`, onSelect: () => void save(row.userTags.filter((x) => x !== t)) });
    openMenuBelow(el, items);
  };

  return (
    <div className="flex shrink-0 items-center gap-1">
      {row.tags.slice(0, limit).map((t) => {
        const mine = row.userTags.includes(t);
        return (
          <span key={t} className={cx("flex h-[22px] items-center rounded bg-raised2 text-micro text-text2", mine ? "pr-0.5 pl-2" : "px-2")}>
            {t}
            {mine && (
              <button type="button" aria-label={`Remove tag ${t}`} onClick={() => void save(row.userTags.filter((x) => x !== t))} className="grid h-[18px] w-[18px] place-items-center rounded text-text3 hover:text-text">
                <X size={10} strokeWidth={2.5} />
              </button>
            )}
          </span>
        );
      })}
      {rest.length > 0 && (
        <button
          type="button"
          onClick={(e) => showRest(e.currentTarget)}
          title={rest.join(", ")}
          aria-label={`${rest.length} more ${rest.length === 1 ? "tag" : "tags"}: ${rest.join(", ")}`}
          className="flex h-[22px] items-center rounded bg-raised2 px-2 font-mono text-micro text-text2 tabular hover:text-text"
        >
          +{rest.length}
        </button>
      )}
      {adding ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            // Clicking away keeps what you typed, like pressing Enter.
            if (!finished.current && value.trim()) void save([...row.userTags, value.trim()]);
            setValue("");
            setAdding(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) {
              finished.current = true;
              void save([...row.userTags, value.trim()]);
              setValue("");
              setAdding(false);
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              finished.current = true;
              setValue("");
              setAdding(false);
            }
          }}
          placeholder="tag"
          aria-label="New tag"
          className="h-[22px] w-24 rounded border border-accent bg-raised px-1.5 text-micro text-text outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            finished.current = false;
            setAdding(true);
          }}
          className="flex h-[22px] items-center gap-0.5 rounded border border-dashed border-line2 px-2 text-micro text-text3 hover:text-text"
        >
          <Plus size={10} strokeWidth={2.5} /> Tag
        </button>
      )}
    </div>
  );
}

export function GripIcon({ className }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

/**
 * Drags what you hear. With sync, key matching or edits it hands over a render. It also says when it can't: the drive
 * isn't connected, or the render failed (click, Enter or Space to try again; the cause is in the tooltip).
 */
export function DragTile({ row, state, processing, tall, onRetry }: { row: SampleRow; state: RenderState; processing: Processing | null; tall?: boolean; onRetry?: () => void }) {
  const offline = !row.online;
  const failed = !offline && state.kind === "error";
  const detail = offline
    ? "Drive not connected"
    : state.kind === "original"
      ? "Original file"
      : state.kind === "rendering"
        ? "Rendering…"
        : state.kind === "error"
          ? onRetry
            ? "Couldn't render · Retry"
            : "Couldn't render"
          : processing?.label || "Rendered";
  const retry = failed ? onRetry : undefined;
  return (
    <div
      draggable={!offline && !failed}
      role="button"
      tabIndex={retry ? 0 : -1}
      aria-label={retry ? "Couldn't render. Try again" : `Drag into your DAW: ${detail}`}
      title={
        offline
          ? "This sample's drive isn't connected. Connect it to play or drag the sample."
          : state.kind === "error"
            ? `Couldn't render: ${state.message}${retry ? ". Click to try again." : ""}`
            : state.kind === "ready"
              ? "Saved in the Renders folder of your saved sounds when you drag it out"
              : undefined
      }
      onDragStart={(e) => {
        e.preventDefault();
        dragHeard(row, state);
      }}
      onClick={retry}
      onKeyDown={(e) => {
        if (retry && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          retry();
        }
      }}
      className={cx(
        "flex shrink-0 items-center gap-2.5 rounded-lg border pr-3.5 pl-2.5",
        tall ? "h-[76px] border-dashed border-accent-wave bg-accent-soft" : "h-9 border-line2 bg-raised",
        offline ? "cursor-default opacity-60" : retry ? "cursor-pointer hover:bg-raised2" : failed ? "cursor-default" : "cursor-grab active:cursor-grabbing",
        state.kind === "rendering" && !offline && "cursor-progress",
      )}
    >
      <GripIcon className={tall ? "fill-accent-ink" : "fill-text3"} />
      <span className="flex min-w-0 flex-col gap-px">
        <span className="text-ui font-semibold">{tall && processing?.processed ? "Drag processed clip" : "Drag to DAW"}</span>
        <span className={cx("max-w-[190px] truncate font-mono text-micro", state.kind === "rendering" && !offline && "animate-soft-pulse", failed ? "text-text2" : "text-text3")}>{detail}</span>
      </span>
    </div>
  );
}

function TempoReadout({ row, processing }: { row: SampleRow; processing: Processing }) {
  const edit = useEdit(row.id);
  const update = useEdits((s) => s.update);
  const project = useProject();
  const fixed = usePrefs((s) => s.bpmFixed);
  // Changing the tempo Saga keeps for the sample is in the same menu as the ways of playing it, under its own name,
  // so "Play at half time" (this session) and "Set to half" (kept) can't be mistaken for each other.
  const byHand: MenuItem = { label: "Change the sample's tempo", submenu: tempoSubmenu([row.id], [row]) };
  if (!hasTempo(row)) {
    return (
      <button
        type="button"
        onClick={(e) => openMenuBelow(e.currentTarget, tempoSubmenu([row.id], [row]))}
        title={row.bpmSource === "user" ? "No tempo, set by you" : "Give it a tempo"}
        className="flex h-7 items-center rounded-md px-1.5 font-mono text-body text-text2 hover:bg-raised"
      >
        {row.kind === "oneshot" && row.bpmSource !== "user" ? "One-shot" : "No tempo"}
      </button>
    );
  }
  const menu = (el: HTMLElement) => {
    const items: MenuItem[] = [
      { label: "Half or double time, whichever fits the project", checked: edit.multiplier === "auto", onSelect: () => update(row.id, { multiplier: "auto" }) },
      { label: `Play at half time (${fmtBpm(row.bpm! / 2)})`, checked: edit.multiplier === 0.5, onSelect: () => update(row.id, { multiplier: 0.5 }) },
      { label: `Play as tagged (${fmtBpm(row.bpm!)})`, checked: edit.multiplier === 1, onSelect: () => update(row.id, { multiplier: 1 }) },
      { label: `Play at double time (${fmtBpm(row.bpm! * 2)})`, checked: edit.multiplier === 2, onSelect: () => update(row.id, { multiplier: 2 }) },
      "separator",
      { label: "Stretch — keep the pitch", checked: processing.mode === "stretch", onSelect: () => update(row.id, { mode: "stretch" }) },
      { label: "Repitch — like tape", checked: processing.mode === "repitch", onSelect: () => update(row.id, { mode: "repitch" }) },
      "separator",
      byHand,
    ];
    openMenuBelow(el, items);
  };
  const changed = Math.abs(processing.rate - 1) > 1e-4;
  const est = row.bpmSource === "audio" ? ESTIMATE : "";
  // The readout starts from the file's own tempo, the one the list shows, and marks half or double time after it:
  // "174 ½× → 120" rather than "87 → 120".
  const counted = processing.multiplier === 0.5 ? "½×" : processing.multiplier === 2 ? "2×" : "";
  const file = `${est}${fmtBpm(row.bpm!, fixed)}`;
  // The speed is hidden next to the tempo when the panel is narrow, so the tooltip always carries it.
  const speed = changed ? `Playing at ×${processing.rate.toFixed(3)}${processing.mode === "repitch" ? ", like tape" : ""}. ` : "";
  const half = counted ? `Counted at ${processing.multiplier === 0.5 ? "half" : "double"} time (${fmtBpm(processing.sourceBpm!, fixed)} BPM). ` : "";
  const about = row.bpmSource === "audio" ? `${sourceHint("Tempo", "audio")}. Half and double time, and setting it yourself, are in this menu.` : row.bpmSource === "user" ? `${sourceHint("Tempo", "user")}. Tempo options` : "Tempo options";
  return (
    <button type="button" onClick={(e) => menu(e.currentTarget)} className="flex h-7 items-center gap-2 rounded-md px-1.5 hover:bg-raised" title={half + speed + about}>
      <span className="font-mono text-body whitespace-nowrap tabular">
        {file}
        {counted && <span className="text-accent-ink"> {counted}</span>}
        {changed ? ` → ${fmtBpm(Math.round(processing.targetBpm! * 100) / 100, fixed)}` : " BPM"}
      </span>
      <span className="font-mono text-small text-text3 tabular @max-[1000px]/preview:hidden">
        {changed ? `×${processing.rate.toFixed(3)}${processing.mode === "repitch" ? " tape" : ""}` : project.sync ? "in sync" : "original"}
      </span>
    </button>
  );
}

/** A pitch change in semitones: "+3 st", "−1.5 st", "±0 st". */
const fmtSt = (v: number) => `${v > 0.004 ? "+" : v < -0.004 ? "−" : "±"}${Math.abs(v).toFixed(Math.abs(v % 1) > 0.004 ? 1 : 0)} st`;

export function PitchStepper({ row, processing, compact }: { row: SampleRow; processing: Processing; compact?: boolean }) {
  const update = useEdits((s) => s.update);
  const edit = useEdit(row.id);
  const project = useProject();
  const locked = processing.mode === "repitch" && processing.synced;
  const value = processing.semitones;
  const label = fmtSt(value);
  const yours = edit.semitones + edit.cents / 100;
  const reset = () => update(row.id, { semitones: 0, cents: 0 });
  // With scale lock, the buttons say where they go: "Up to E (+2 st) in A Dorian".
  const scaled = project.scaleLock && project.key != null && row.keyPc != null;
  const scaleName = project.key ? projectKeyLabel(project.key) : "";
  const hint = (dir: 1 | -1) => {
    const d = pitchStep(row, dir, project);
    if (!scaled) return dir > 0 ? "Up one semitone" : "Down one semitone";
    const to = keyLabel(row.keyPc! + Math.round(value) + d, row.keyMode!);
    return `${dir > 0 ? "Up" : "Down"} to ${to} (${d > 0 ? "+" : "−"}${Math.abs(d)} st), in ${scaleName}`;
  };
  return (
    <div className="flex items-center gap-1.5" title={locked ? "In repitch mode the tempo sets the pitch" : scaled ? `Scale lock: steps through ${scaleName}` : undefined}>
      <button type="button" disabled={locked} onClick={() => stepPitch(row, -1)} aria-label={hint(-1)} title={hint(-1)} className="grid h-6 w-6 place-items-center rounded-md border border-line2 text-text2 hover:bg-raised disabled:opacity-40">
        <Minus size={12} strokeWidth={2.25} />
      </button>
      {/* The value says where the pitch comes from (the project key, or you) and resets your part; double-click still resets. */}
      <Popover
        side="above"
        align="center"
        trigger={({ open, toggle }) => (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`Pitch ${label}. Where it comes from, and reset`}
            onClick={toggle}
            onDoubleClick={reset}
            title="Where the pitch comes from (double-click to reset)"
            className={cx("h-6 rounded-md text-center font-mono text-body tabular hover:bg-raised", compact ? "w-12" : "w-14", Math.abs(value) > 0.004 && "text-accent-ink")}
          >
            {label}
          </button>
        )}
      >
        {(close) => (
          <div className="flex w-60 flex-col gap-2.5 p-3 text-left">
            {locked ? (
              <p className="m-0 text-ui text-text2">In repitch mode the tempo sets the pitch, like speeding up tape.</p>
            ) : (
              <dl className="m-0 flex flex-col gap-1 text-ui">
                {processing.keyShift !== 0 && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-text2">To match {project.key ? projectKeyLabel(project.key) : "the project key"}</dt>
                    <dd className="m-0 font-mono tabular">{fmtSt(processing.keyShift)}</dd>
                  </div>
                )}
                <div className="flex justify-between gap-3">
                  <dt className="text-text2">Set by you</dt>
                  <dd className="m-0 font-mono tabular">{fmtSt(yours)}</dd>
                </div>
              </dl>
            )}
            <button
              type="button"
              disabled={locked || Math.abs(yours) < 0.004}
              onClick={() => {
                reset();
                close();
              }}
              className="h-7 rounded-md border border-line2 text-ui text-text2 hover:bg-raised hover:text-text disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {processing.keyShift !== 0 ? "Reset to the key match" : "Reset to the original pitch"}
            </button>
          </div>
        )}
      </Popover>
      <button type="button" disabled={locked} onClick={() => stepPitch(row, 1)} aria-label={hint(1)} title={hint(1)} className="grid h-6 w-6 place-items-center rounded-md border border-line2 text-text2 hover:bg-raised disabled:opacity-40">
        <Plus size={12} strokeWidth={2.25} />
      </button>
    </div>
  );
}

/** The preview volume: a slider when the panel has room, a button that opens one above it when it doesn't. */
function VolumeControl() {
  const volume = usePrefs((s) => s.volume);
  const slider = (className: string) => (
    <input
      type="range"
      min={0}
      max={1}
      step={0.01}
      value={volume}
      aria-label="Preview volume"
      onChange={(e) => {
        const v = Number(e.target.value);
        usePrefs.getState().set({ volume: v });
        void api.setVolume(v);
      }}
      className={className}
    />
  );
  return (
    <>
      <label className="flex items-center gap-2 text-text3 @max-[1100px]/preview:hidden" title="Preview volume">
        <Volume2 size={16} strokeWidth={1.75} aria-hidden="true" />
        {slider("w-20")}
      </label>
      <div className="hidden @max-[1100px]/preview:block">
        <Popover
          side="above"
          align="right"
          className="flex items-center px-3 py-2.5"
          trigger={({ open, toggle }) => (
            <IconButton label="Preview volume" size={30} active={open} aria-expanded={open} onClick={toggle}>
              <Volume2 size={16} strokeWidth={1.75} />
            </IconButton>
          )}
        >
          {() => slider("w-32")}
        </Popover>
      </div>
    </>
  );
}

/**
 * How many tags fit beside the file name at a panel width. Everything else in the panel steps down
 * with container queries on `/preview`; tags need a count for their "+N" button, so they use the measured width.
 */
const tagLimit = (width: number) => (width === 0 || width >= 960 ? 3 : width >= 600 ? 1 : 0);

/** Below this height of the list area (a small window or a large interface size), the panel goes compact. */
const SHORT_AREA = 560;

export function PreviewPanel() {
  const row = useBrowse((s) => s.selected);
  const { state, processing, retry } = useRender(row);
  const [panel, width] = useElementWidth<HTMLElement>();
  const [short, setShort] = useState(false);
  const ready = row != null && processing != null;

  useEffect(() => {
    const area = panel.current?.parentElement;
    if (!area) return;
    const ro = new ResizeObserver(([e]) => setShort(e.contentRect.height < SHORT_AREA));
    ro.observe(area);
    return () => ro.disconnect();
  }, [panel]);

  // One section for both states, so the width measurement survives selecting and clearing a sample. Its height is
  // what the content needs (264px in a roomy window), capped at half the list area so the list keeps its rows; the
  // waveform gives way first. When even a compact panel doesn't fit, it scrolls rather than cutting controls off.
  return (
    <section
      ref={panel}
      aria-label="Preview"
      className={cx(
        "@container/preview flex max-h-[50%] min-h-0 shrink-0 flex-col border-t border-line bg-panel",
        !ready ? "h-[264px] items-center justify-center gap-2 px-4 text-center" : short ? "gap-2 overflow-y-auto px-4 pt-3 pb-2.5" : "gap-3 px-4 pt-4 pb-3.5",
      )}
    >
      {ready ? (
        <PreviewBody row={row} state={state} processing={processing} retry={retry} tags={tagLimit(width)} short={short} />
      ) : (
        <>
          <span className="text-title font-medium">Select a sample to preview it</span>
          <span className="text-ui text-text3">↑ ↓ to browse · Space to play · F to favorite · drag any row into your DAW</span>
        </>
      )}
    </section>
  );
}

function PreviewBody({ row, state, processing, retry, tags, short }: { row: SampleRow; state: RenderState; processing: Processing; retry: () => void; tags: number; short: boolean }) {
  const selectedIndex = useBrowse((s) => s.selectedIndex);
  const toggleFavorite = useBrowse((s) => s.toggleFavorite);
  const status = usePlayer((s) => (s.id === row.id ? s.status : "idle"));
  const playNext = usePrefs((s) => s.playNext);
  const project = useProject();
  const edit = useEdit(row.id);
  const update = useEdits((s) => s.update);
  const reset = useEdits((s) => s.reset);
  const openEditor = useEditor((s) => s.open);

  const playing = status === "playing" || status === "loading";
  const loopOn = shouldLoop(row);
  const segments = row.dir.split("/").filter(Boolean);
  // Counted at the tempo the ruler and beat grid use, so half time reads the same in both places.
  const bars = barsCount(row.duration, processing.sourceBpm);
  const edited = edit !== DEFAULT_EDIT;
  // Length and loudness come before the format details, so a cut-off line loses the least useful part, and the
  // format details are hidden first when the panel narrows.
  const meta = [
    { text: row.ext.toUpperCase() },
    { text: bars ? `${bars} ${bars === 1 ? "bar" : "bars"}` : "" },
    { text: fmtDb(row.loudness, "LUFS") || fmtDb(row.peakDb, "dB peak") },
    { text: fmtRate(row.sampleRate), detail: true },
    { text: row.bitDepth ? `${row.bitDepth}-bit` : "", detail: true },
    { text: fmtChannels(row.channels), detail: true },
  ].filter((m) => m.text);
  const action = "flex h-8 shrink-0 items-center gap-2 rounded-lg border border-line2 px-3 text-ui text-text2 hover:bg-raised hover:text-text";
  // The tempo, pitch and key labels and dividers, which come back when that group has a line to itself (see below).
  const fitLabel = "@max-[1000px]/preview:hidden @max-[820px]/preview:block @max-[560px]/preview:hidden";
  // Below these widths a labelled button keeps only its icon; the label stays for screen readers.
  const iconOnly = "@max-[860px]/preview:w-8 @max-[860px]/preview:justify-center @max-[860px]/preview:px-0";

  return (
    <>
      {/* The name and its details take the line; when the actions no longer fit beside a 20rem name, they wrap below it. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-2.5">
        <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="min-w-0 truncate text-title font-semibold tracking-[-0.01em]">
              {row.name}
              <span className="font-normal text-text3">.{row.ext}</span>
            </span>
            <button
              type="button"
              aria-label={row.favorite ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={row.favorite}
              onClick={() => toggleFavorite(row)}
              className={cx("grid h-6 w-6 shrink-0 place-items-center rounded-md", row.favorite ? "text-accent-ink" : "text-text3 hover:text-text")}
            >
              <Star size={15} strokeWidth={1.75} fill={row.favorite ? "currentColor" : "none"} />
            </button>
            <TagEditor row={row} limit={tags} />
          </div>
          <div className="flex min-w-0 gap-3.5 text-small whitespace-nowrap text-text3">
            {!row.online && <span className="shrink-0 rounded bg-raised2 px-1.5 text-text2">Drive not connected</span>}
            <span className="min-w-[6ch] truncate">{segments.length ? segments.join("  ›  ") : row.pack}</span>
            <span className="min-w-0 truncate font-mono">
              {meta.map((m, i) => (
                <span key={i} className={cx(m.detail && "@max-[980px]/preview:hidden")}>
                  {i > 0 && " · "}
                  {m.text}
                </span>
              ))}
            </span>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {edited && (
            <button type="button" onClick={() => reset(row.id)} className="h-8 shrink-0 rounded-lg px-2.5 text-ui text-text3 hover:bg-raised hover:text-text">
              Revert edits
            </button>
          )}
          <button type="button" onClick={() => findSimilar(row)} title="Find samples that sound like this one (G)" className={cx(action, "@max-[980px]/preview:w-8 @max-[980px]/preview:justify-center @max-[980px]/preview:px-0")}>
            <SimilarIcon />
            <span className="@max-[980px]/preview:sr-only">Find similar</span>
          </button>
          <button type="button" onClick={() => openEditor(row.id)} title="Edit and sync (E)" className={cx(action, iconOnly)}>
            <SlidersHorizontal size={15} strokeWidth={1.75} />
            <span className="@max-[860px]/preview:sr-only">Edit</span>
          </button>
          <button
            type="button"
            title="Add to a collection"
            onClick={async (e) => {
              const el = e.currentTarget;
              try {
                const member = await api.sampleCollections(row.id);
                openMenuBelow(el, collectionSubmenu([row.id], member), "right");
              } catch (err) {
                toast(`Couldn't load your collections: ${errorMessage(err)}`);
              }
            }}
            className={cx(action, iconOnly)}
          >
            <FolderPlus size={15} strokeWidth={1.75} />
            <span className="@max-[860px]/preview:sr-only">Collect</span>
          </button>
          <IconButton label={`${revealLabel()} (${modKey}⇧R)`} onClick={() => void reveal(row.path)} className="border border-line2">
            <FolderSearch size={15} strokeWidth={1.75} />
          </IconButton>
          <DragTile row={row} state={state} processing={processing} onRetry={retry} />
        </div>
      </div>

      <BigWaveform row={row} processing={processing} state={state} ruler={!short} />

      {/* Steps down as the panel narrows: the volume slider becomes a button below 1100px, the section labels and
          the speed go below 1000px, and below 820px tempo, pitch and key move to a line of their own, where the
          labels fit again until 560px. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2.5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label={playing ? "Pause (Space)" : "Play (Space)"}
            title={playing ? "Pause (Space)" : "Play (Space)"}
            onClick={() => {
              if (selectedIndex >= 0) useBrowse.getState().selectRow(row, selectedIndex, { play: false });
              usePlayer.getState().toggle(row);
            }}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-on-accent"
          >
            {playing ? <Pause size={14} fill="currentColor" strokeWidth={0} /> : <Play size={14} fill="currentColor" strokeWidth={0} className="translate-x-px" />}
          </button>
          <div className="flex gap-1">
            <IconButton label="Loop (L)" active={loopOn} aria-pressed={loopOn} onClick={() => toggleLoop(row)}>
              <Repeat size={16} strokeWidth={1.75} />
            </IconButton>
            <IconButton label={PLAY_NEXT_LABEL} active={playNext} aria-pressed={playNext} onClick={() => setPlayNext(!playNext)}>
              <ListEnd size={16} strokeWidth={1.75} />
            </IconButton>
            <IconButton label="Reverse (R)" active={edit.reverse} aria-pressed={edit.reverse} onClick={() => update(row.id, { reverse: !edit.reverse })}>
              <ReverseIcon />
            </IconButton>
          </div>
        </div>
        <Divider className="@max-[820px]/preview:hidden" />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 @max-[820px]/preview:order-last @max-[820px]/preview:basis-full">
          <div className="flex items-center gap-1.5">
            <SectionLabel className={fitLabel}>Tempo</SectionLabel>
            <TempoReadout row={row} processing={processing} />
          </div>
          <Divider className={fitLabel} />
          <div className="flex items-center gap-2">
            <SectionLabel className={fitLabel}>Pitch</SectionLabel>
            <PitchStepper row={row} processing={processing} compact />
          </div>
          <Divider className={fitLabel} />
          <div className="flex items-center gap-2.5">
            <SectionLabel className={fitLabel}>Key</SectionLabel>
            <button
              type="button"
              onClick={(e) => openMenuBelow(e.currentTarget, keySubmenu([row.id], [row]))}
              className="flex h-7 items-center rounded-md px-1.5 font-mono text-body whitespace-nowrap hover:bg-raised"
              title={[sourceHint("Key", row.keySource), "Click to set the key yourself"].filter(Boolean).join(". ")}
            >
              {processing.keyFrom
                ? `${row.keySource === "audio" ? ESTIMATE : ""}${processing.keyTo && processing.keyTo !== processing.keyFrom ? `${processing.keyFrom} → ${processing.keyTo}` : processing.keyFrom}`
                : "—"}
            </button>
            <span title={project.key ? "Transpose pitched samples to the project key (K)" : "Pick a project key to match"}>
              <Switch
                size="sm"
                checked={project.matchKey && project.key != null}
                onChange={(v) => (project.key ? project.set({ matchKey: v }) : askProjectKey())}
                label={<span className="text-small whitespace-nowrap">Match</span>}
              />
            </span>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-end gap-3">
          <Clock row={row} />
          <IconButton label="Metronome click" size={30} active={project.click} aria-pressed={project.click} onClick={() => project.set({ click: !project.click })}>
            <MetronomeIcon />
          </IconButton>
          <VolumeControl />
        </div>
      </div>
    </>
  );
}
