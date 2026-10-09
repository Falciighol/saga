import { AppWindow, AudioLines, Mic, RotateCcw } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { usePalette } from "../../hooks/useTheme";
import { fmtTake } from "../../lib/format";
import { usePixelRatio } from "../../lib/scale";
import { setupCanvas } from "../../lib/waveform";
import { usePrefs } from "../../store/prefs";
import { live, LIVE_BARS, openPrivacySettings, useRecord } from "../../store/record";
import { useElementWidth } from "../PreviewPanel";
import { cx } from "../ui";
import { openSourceMenu } from "./controls";

/** The quietest level the stage shows; its height is in decibels, so the start line moves like a fader. */
const FLOOR_DB = -60;
/** How far the start line can be dragged. */
const MIN_DB = -60;
const MAX_DB = -6;
/** Takes stop at 15 minutes; the timer warns a minute before. */
const WARN_AT = 14 * 60;

const toDb = (v: number) => 20 * Math.log10(Math.max(v, 1e-6));
/** 0 at the floor, 1 at full scale. */
const heightOf = (v: number) => Math.min(1, Math.max(0, (toDb(v) - FLOOR_DB) / -FLOOR_DB));

/**
 * The live waveform: Saga's bars scrolling in from the right, grey while armed and in the accent once a take records
 * (its pre-roll included). The pair of lines is where a sound starts a take; drag them, or use ↑ ↓ on the handle.
 */
export function Stage({ height, compact }: { height: number; compact?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [box, width] = useElementWidth<HTMLDivElement>();
  const colors = usePalette();
  const ratio = usePixelRatio();
  const phase = useRecord((s) => s.phase);
  const status = useRecord((s) => s.status);
  const startOnSound = usePrefs((s) => s.recordStartOnSound);
  const stopAfter = usePrefs((s) => s.recordStopAfter);
  const manualDb = usePrefs((s) => s.recordThresholdDb);
  const keepGoing = usePrefs((s) => s.recordKeepGoing);
  const open = phase !== "idle";
  const recording = phase === "recording";
  // The start line matters while something is listened for: a take to start, or silence to end one.
  const showLine = startOnSound || stopAfter != null;
  const threshold = manualDb != null ? 10 ** (manualDb / 20) : (status?.threshold ?? 10 ** (-48 / 20));
  const thresholdRef = useRef(threshold);
  thresholdRef.current = threshold;
  const showLineRef = useRef(showLine);
  showLineRef.current = showLine;
  const manualRef = useRef(manualDb != null);
  manualRef.current = manualDb != null;

  useEffect(() => {
    const el = canvas.current;
    if (!el || width <= 0) return;
    const step = compact ? 3 : 4;
    const barWidth = compact ? 1.6 : 2;
    const draw = () => {
      const ctx = setupCanvas(el, width, height);
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      const mid = height / 2;
      const maxAmp = mid - barWidth / 2 - 1;
      const count = Math.floor(width / step);
      const shown = Math.min(count, live.count);
      const line = heightOf(thresholdRef.current) * maxAmp;
      // Not listening yet, or nothing has come through: a quiet dotted baseline.
      ctx.fillStyle = colors.wave;
      for (let i = 0; i < count - shown; i += 2) ctx.fillRect(i * step, mid - 0.5, barWidth, 1);
      ctx.lineCap = "round";
      ctx.lineWidth = barWidth;
      const firstTotal = live.total - shown;
      for (let i = 0; i < shown; i++) {
        const v = live.bars[LIVE_BARS - shown + i];
        const a = Math.max(0.5, heightOf(v) * maxAmp);
        const inTake = live.takeStart >= 0 && firstTotal + i >= live.takeStart;
        ctx.strokeStyle = inTake ? colors.accentWave : a > line && showLineRef.current ? colors.wave2 : colors.wave;
        const x = (count - shown + i) * step + step / 2;
        ctx.beginPath();
        ctx.moveTo(x, mid - a);
        ctx.lineTo(x, mid + a);
        ctx.stroke();
      }
      if (showLineRef.current) {
        ctx.strokeStyle = manualRef.current ? colors.accentInk : colors.text3;
        ctx.globalAlpha = manualRef.current ? 0.9 : 0.6;
        ctx.lineWidth = 1;
        ctx.setLineDash(manualRef.current ? [] : [3, 3]);
        for (const y of [mid - line, mid + line]) {
          ctx.beginPath();
          ctx.moveTo(0, Math.round(y) + 0.5);
          ctx.lineTo(width, Math.round(y) + 0.5);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    };
    draw();
    if (!open) return;
    let raf = 0;
    let last = -1;
    const loop = () => {
      if (live.total !== last) {
        last = live.total;
        draw();
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [width, height, compact, colors, ratio, open, threshold, showLine, manualDb]);

  // Dragging the line: its distance from the middle sets the level, snapped to whole decibels.
  const dbAt = (clientY: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return null;
    const maxAmp = r.height / 2 - 2;
    const off = Math.min(maxAmp, Math.abs(clientY - (r.top + r.height / 2)));
    return Math.round(Math.min(MAX_DB, Math.max(MIN_DB, FLOOR_DB + (off / maxAmp) * -FLOOR_DB)));
  };
  const setDb = (db: number | null) => {
    usePrefs.getState().set({ recordThresholdDb: db });
    useRecord.getState().optionsChanged();
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!showLine || e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const lineOff = (heightOf(threshold) * (r.height / 2 - 2));
    const off = Math.abs(e.clientY - (r.top + r.height / 2));
    // Grab the line when the press is near it, so clicks elsewhere on the stage don't move it.
    if (Math.abs(off - lineOff) > 8) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const db = dbAt(e.clientY);
    if (db != null) setDb(db);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const db = dbAt(e.clientY);
    if (db != null) setDb(db);
  };
  const lineDb = Math.round(toDb(threshold));
  const onHandleKey = (e: ReactKeyboardEvent) => {
    const by = e.shiftKey ? 6 : 1;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      setDb(Math.min(MAX_DB, Math.max(MIN_DB, lineDb + (e.key === "ArrowUp" ? by : -by))));
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      e.stopPropagation();
      setDb(null);
    }
  };

  const seconds = status?.seconds ?? 0;
  const late = recording && seconds >= WARN_AT;
  const stopping = recording && stopAfter != null && (status?.silentFor ?? 0) > 0.3;
  const lineTop = `calc(50% - ${heightOf(threshold) * 50}% + ${heightOf(threshold) * 2}px)`;

  return (
    <div
      ref={box}
      className={cx("relative overflow-hidden rounded-xl bg-bg", showLine && open && "touch-none")}
      style={{ height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
    >
      <canvas ref={canvas} aria-hidden="true" className="absolute inset-0 block" style={{ width, height }} />
      {/* The readouts sit over the waveform's quiet edges; a compact stage is too short for them, so its owner
          shows the state beside it. */}
      <div className={cx("pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between", compact ? "px-2 pt-1" : "px-3 pt-2.5")}>
        {!compact && <StateLabel late={late} />}
        <div className="flex items-center gap-1.5">
          {status?.clipped && recording && (
            <span className="rounded bg-rec-soft px-1.5 font-mono text-micro font-medium text-rec" title="Part of this take reached full scale and may sound distorted">
              CLIP
            </span>
          )}
          {keepGoing && open && (status?.takes ?? 0) > 0 && !compact && (
            <span className="font-mono text-micro text-text3 tabular">{status!.takes} kept</span>
          )}
        </div>
      </div>
      {!compact && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 px-3 pb-2 text-small">
          <span className={cx("min-w-0 truncate", late ? "text-rec" : "text-text3")}>
            {late
              ? "Takes stop at 15:00"
              : status?.nothingYet && phase === "armed"
                ? "Nothing is coming through yet. Some apps block recording."
                : stopping
                  ? `Stopping in ${Math.max(0, stopAfter! - status!.silentFor).toFixed(1)} s`
                  : null}
          </span>
        </div>
      )}
      {showLine && open && !compact && (
        <div
          role="slider"
          tabIndex={0}
          aria-label="Level that starts a take"
          aria-valuemin={MIN_DB}
          aria-valuemax={MAX_DB}
          aria-valuenow={lineDb}
          aria-valuetext={manualDb == null ? `${lineDb} dB, following the noise floor` : `${lineDb} dB`}
          title={
            manualDb == null
              ? "A sound louder than this starts a take. It follows the source's noise floor; drag the line to set it yourself."
              : "A sound louder than this starts a take. Double-click to follow the noise floor again."
          }
          onKeyDown={onHandleKey}
          onDoubleClick={() => setDb(null)}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.currentTarget.parentElement?.setPointerCapture(e.pointerId);
          }}
          className={cx(
            "absolute right-2 -translate-y-1/2 cursor-ns-resize rounded-md border px-1.5 font-mono text-micro tabular whitespace-nowrap",
            manualDb == null ? "border-line2 bg-panel text-text3" : "border-accent-wave bg-panel text-accent-ink",
          )}
          style={{ top: lineTop }}
        >
          {manualDb == null ? `Auto ${lineDb} dB` : `${lineDb} dB`}
        </div>
      )}
      {showLine && open && manualDb != null && !compact && (
        <button
          type="button"
          aria-label="Follow the noise floor again"
          title="Follow the noise floor again"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setDb(null)}
          className="absolute bottom-1.5 right-2 grid h-6 w-6 place-items-center rounded-md text-text3 hover:bg-raised hover:text-text"
        >
          <RotateCcw size={13} />
        </button>
      )}
    </div>
  );
}

/** "Waiting for sound", or the REC dot and the take's length. */
export function StateLabel({ compact, late = false }: { compact?: boolean; late?: boolean }) {
  const phase = useRecord((s) => s.phase);
  const seconds = useRecord((s) => s.status?.seconds ?? 0);
  const startOnSound = usePrefs((s) => s.recordStartOnSound);
  if (phase === "recording") {
    return (
      <span className={cx("flex items-center gap-1.5", compact && "justify-end")}>
        <span className="animate-rec-blink block h-2 w-2 rounded-full bg-rec" aria-hidden="true" />
        <span className={cx("font-mono font-medium tabular", compact ? "text-ui" : "text-[19px] leading-none tracking-[-0.01em]", late ? "text-rec" : "text-text")}>
          {fmtTake(seconds)}
        </span>
      </span>
    );
  }
  const text =
    phase === "opening" ? "Opening…" : phase === "armed" ? (compact ? "Armed" : "Waiting for sound") : compact ? "Ready" : startOnSound ? "R arms · a take starts on the first sound" : "R records";
  return (
    <span className={cx("flex items-center gap-1.5 text-small", compact && "justify-end", phase === "armed" ? "text-text2" : "text-text3")}>
      {phase === "armed" && <span className="animate-rec-blink block h-1.5 w-1.5 rounded-full border border-rec" aria-hidden="true" />}
      {text}
    </span>
  );
}

/** Before anything was chosen: the three kinds of source, so the panel explains itself. */
export function FirstRun() {
  const choice = "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-raised focus-visible:bg-raised";
  return (
    <div role="group" aria-label="Choose what to record" className="flex flex-col gap-0.5">
      <p className="m-0 px-3 pb-1.5 text-ui text-text2">What do you want to record?</p>
      <button type="button" className={choice} onClick={(e) => openSourceMenu(e.currentTarget, "input")}>
        <Mic size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-text2" />
        <span className="flex flex-col gap-0.5">
          <span className="text-ui font-medium">An input</span>
          <span className="text-small text-text3">A mic, or an instrument on your interface</span>
        </span>
      </button>
      <button type="button" className={choice} onClick={(e) => openSourceMenu(e.currentTarget, "app")}>
        <AppWindow size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-text2" />
        <span className="flex flex-col gap-0.5">
          <span className="text-ui font-medium">One app</span>
          <span className="text-small text-text3">A browser tab, a player, a plugin's standalone</span>
        </span>
      </button>
      <button type="button" className={choice} onClick={(e) => openSourceMenu(e.currentTarget, "system")}>
        <AudioLines size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-text2" />
        <span className="flex flex-col gap-0.5">
          <span className="text-ui font-medium">Everything you hear</span>
          <span className="text-small text-text3">Whatever the computer plays, except Saga</span>
        </span>
      </button>
    </div>
  );
}

/** What kept the source from opening, with the way out when there is one. */
export function StageProblem() {
  const problem = useRecord((s) => s.problem);
  if (!problem) return null;
  const settings = problem.settings;
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-xl border border-line2 px-3 py-2.5">
      <p className="m-0 text-ui leading-snug text-pretty text-text">{problem.message}</p>
      <div className="flex gap-2">
        {settings && (
          <button type="button" onClick={() => void openPrivacySettings(settings)} className="h-7 rounded-md border border-line2 bg-raised px-2.5 text-small hover:bg-raised2">
            Open settings
          </button>
        )}
        <button type="button" onClick={() => void useRecord.getState().arm()} className="h-7 rounded-md px-2.5 text-small text-text2 hover:bg-raised hover:text-text">
          Try again
        </button>
      </div>
    </div>
  );
}
