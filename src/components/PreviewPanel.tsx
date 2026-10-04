import { FolderPlus, FolderSearch, Minus, Pause, Play, Plus, Repeat, SlidersHorizontal, Star, Volume2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePalette } from "../hooks/useTheme";
import { collectionSubmenu, dragOut, dragSample, findSimilar, keySubmenu, reveal, tempoSubmenu } from "../lib/actions";
import { api, errorMessage } from "../lib/api";
import { barsCount, ESTIMATE, fmtBpm, fmtChannels, fmtClock, fmtDb, fmtRate, hasTempo, sourceHint } from "../lib/format";
import { revealLabel } from "../lib/platform";
import { projectKeyLabel } from "../lib/keys";
import { DEFAULT_EDIT, keyLabel, type Processing } from "../lib/processing";
import { useRender, type RenderState } from "../lib/renders";
import { usePixelRatio } from "../lib/scale";
import type { SampleRow } from "../lib/types";
import { decodePeaks, setupCanvas, toBars } from "../lib/waveform";
import { useBrowse } from "../store/browse";
import { useEditor } from "../store/editor";
import { playerPosition, shouldLoop, timelinePosition, usePlayer } from "../store/player";
import { usePrefs } from "../store/prefs";
import { pitchStep, stepPitch, useEdit, useEdits, useProject } from "../store/project";
import { toast } from "../store/toasts";
import { openMenuBelow, type MenuItem } from "./Menu";
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

/** The waveform as you hear it: reversed when reversing, with the loop region highlighted. */
function BigWaveform({ row, processing }: { row: SampleRow; processing: Processing }) {
  const [box, width] = useElementWidth<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef<HTMLDivElement>(null);
  const hoverLabel = useRef<HTMLSpanElement>(null);
  const colors = usePalette();
  const ratio = usePixelRatio();
  const status = usePlayer((s) => (s.id === row.id ? s.status : "idle"));
  const looping = usePrefs((p) => (row.kind === "loop" ? p.loopLoops : p.loopShots));
  const height = 96;
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
    if (!c || !width) return;
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
  }, [values, width, colors, ratio, status, bars, row.id, regionLeft, regionRight, reverse]);

  const timeAt = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return (reverse ? 1 - f : f) * duration;
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="relative h-4 shrink-0">
        {ruler.map((m) => (
          <span key={m.label} className="absolute top-0 h-3.5 border-l border-line2 pl-1 font-mono text-[10.5px] leading-[14px] text-text3" style={{ left: `${m.x * 100}%` }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="relative mt-1 h-[3px] shrink-0">
        {looping && (
          <div className="absolute top-0 h-[3px] rounded-full bg-accent-wave" style={{ left: `${regionLeft * 100}%`, width: `${(regionRight - regionLeft) * 100}%` }} />
        )}
      </div>
      <div
        ref={box}
        className="relative mt-1.5 flex-1"
        role="slider"
        tabIndex={-1}
        aria-label={`Waveform of ${row.name}. Click to play from a position.`}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration * 100) / 100}
        onMouseMove={(e) => {
          const t = timeAt(e.clientX);
          if (hoverRef.current) {
            hoverRef.current.style.opacity = "1";
            hoverRef.current.style.left = `${toX(t) * 100}%`;
          }
          if (hoverLabel.current) hoverLabel.current.textContent = fmtClock(t);
        }}
        onMouseLeave={() => {
          if (hoverRef.current) hoverRef.current.style.opacity = "0";
        }}
        onMouseDown={(e) => {
          if (!duration) return;
          usePlayer.getState().seek(row, timeAt(e.clientX));
        }}
      >
        {partial && (
          <div className="pointer-events-none absolute top-0 bottom-0 bg-accent-soft" style={{ left: `${regionLeft * 100}%`, width: `${(regionRight - regionLeft) * 100}%` }} />
        )}
        <canvas ref={canvas} style={{ width: width || "100%", height }} className="relative block" />
        <div ref={hoverRef} className="pointer-events-none absolute top-0 bottom-0 w-px bg-text3 opacity-0" style={{ left: 0 }}>
          <span ref={hoverLabel} className="absolute -top-5 left-1.5 rounded bg-raised2 px-1 font-mono text-[10.5px] whitespace-nowrap text-text2" />
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

function TagEditor({ row }: { row: SampleRow }) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const patchRow = useBrowse((s) => s.patchRow);

  const save = async (tags: string[]) => {
    try {
      const updated = await api.setUserTags(row.id, tags);
      if (updated) patchRow(row.id, { tags: updated.tags, userTags: updated.userTags });
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-1">
      {row.tags.slice(0, 5).map((t) => {
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
      {adding ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setAdding(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) {
              void save([...row.userTags, value.trim()]);
              setValue("");
              setAdding(false);
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setAdding(false);
            }
          }}
          placeholder="tag"
          aria-label="New tag"
          className="h-[22px] w-24 rounded border border-accent bg-raised px-1.5 text-micro text-text outline-none"
        />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="flex h-[22px] items-center gap-0.5 rounded border border-dashed border-line2 px-2 text-micro text-text3 hover:text-text">
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

/** Drags what you hear. With sync, key matching or edits it hands over a render. */
export function DragTile({ row, state, processing, tall }: { row: SampleRow; state: RenderState; processing: Processing | null; tall?: boolean }) {
  const detail =
    state.kind === "original"
      ? "Original file"
      : state.kind === "rendering"
        ? "Rendering…"
        : state.kind === "error"
          ? "Couldn't render"
          : processing?.label || "Rendered";
  return (
    <div
      draggable={row.online && state.kind !== "error"}
      role="button"
      tabIndex={-1}
      aria-label={`Drag into your DAW: ${detail}`}
      title={state.kind === "error" ? state.message : state.kind === "ready" ? "Saved in the Renders folder of your saved sounds when you drag it out" : undefined}
      onDragStart={(e) => {
        e.preventDefault();
        if (state.kind === "original") dragOut([state.path]);
        else dragSample(row);
      }}
      className={cx(
        "flex shrink-0 cursor-grab items-center gap-2.5 rounded-lg border pr-3.5 pl-2.5 active:cursor-grabbing",
        tall ? "h-[76px] border-dashed border-accent-wave bg-accent-soft" : "h-10 border-line2 bg-raised",
        state.kind === "rendering" && "cursor-progress",
      )}
    >
      <GripIcon className={tall ? "fill-accent-ink" : "fill-text3"} />
      <span className="flex min-w-0 flex-col gap-px">
        <span className="text-ui font-semibold">{tall && processing?.processed ? "Drag processed clip" : "Drag to DAW"}</span>
        <span className={cx("max-w-[190px] truncate font-mono text-[10.5px]", state.kind === "rendering" ? "animate-soft-pulse text-text3" : "text-text3")}>{detail}</span>
      </span>
    </div>
  );
}

function TempoReadout({ row, processing }: { row: SampleRow; processing: Processing }) {
  const edit = useEdit(row.id);
  const update = useEdits((s) => s.update);
  const project = useProject();
  const fixed = usePrefs((s) => s.bpmFixed);
  // Setting the tempo by hand is in the same menu as the ways of playing it.
  const byHand: MenuItem = { label: "The sample's tempo", submenu: tempoSubmenu([row.id], [row]) };
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
      { label: "Half or double time automatically", checked: edit.multiplier === "auto", onSelect: () => update(row.id, { multiplier: "auto" }) },
      { label: `Half time (${fmtBpm(row.bpm! / 2)})`, checked: edit.multiplier === 0.5, onSelect: () => update(row.id, { multiplier: 0.5 }) },
      { label: `As tagged (${fmtBpm(row.bpm!)})`, checked: edit.multiplier === 1, onSelect: () => update(row.id, { multiplier: 1 }) },
      { label: `Double time (${fmtBpm(row.bpm! * 2)})`, checked: edit.multiplier === 2, onSelect: () => update(row.id, { multiplier: 2 }) },
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
  return (
    <button
      type="button"
      onClick={(e) => menu(e.currentTarget)}
      className="flex h-7 items-center gap-2 rounded-md px-1.5 hover:bg-raised"
      title={row.bpmSource === "audio" ? `${sourceHint("Tempo", "audio")}. Half and double time, and setting it yourself, are in this menu.` : row.bpmSource === "user" ? `${sourceHint("Tempo", "user")}. Tempo options` : "Tempo options"}
    >
      <span className="font-mono text-body tabular">
        {changed ? `${est}${fmtBpm(processing.sourceBpm!, fixed)} → ${fmtBpm(Math.round(processing.targetBpm! * 100) / 100, fixed)}` : `${est}${fmtBpm(processing.sourceBpm!, fixed)} BPM`}
      </span>
      <span className="font-mono text-small text-text3 tabular">
        {changed ? `×${processing.rate.toFixed(3)}${processing.mode === "repitch" ? " tape" : ""}` : project.sync ? "in sync" : "original"}
      </span>
    </button>
  );
}

export function PitchStepper({ row, processing, compact }: { row: SampleRow; processing: Processing; compact?: boolean }) {
  const update = useEdits((s) => s.update);
  const project = useProject();
  const locked = processing.mode === "repitch" && processing.synced;
  const value = processing.semitones;
  const label = `${value > 0.004 ? "+" : value < -0.004 ? "−" : "±"}${Math.abs(value).toFixed(Math.abs(value % 1) > 0.004 ? 1 : 0)} st`;
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
      <button
        type="button"
        onDoubleClick={() => update(row.id, { semitones: 0, cents: 0 })}
        title="Double-click to reset"
        className={cx("text-center font-mono text-body tabular", compact ? "w-12" : "w-14", Math.abs(value) > 0.004 && "text-accent-ink")}
      >
        {label}
      </button>
      <button type="button" disabled={locked} onClick={() => stepPitch(row, 1)} aria-label={hint(1)} title={hint(1)} className="grid h-6 w-6 place-items-center rounded-md border border-line2 text-text2 hover:bg-raised disabled:opacity-40">
        <Plus size={12} strokeWidth={2.25} />
      </button>
    </div>
  );
}

export function PreviewPanel() {
  const row = useBrowse((s) => s.selected);
  const selectedIndex = useBrowse((s) => s.selectedIndex);
  const toggleFavorite = useBrowse((s) => s.toggleFavorite);
  const status = usePlayer((s) => (row && s.id === row.id ? s.status : "idle"));
  const prefs = usePrefs();
  const project = useProject();
  const edit = useEdit(row?.id);
  const update = useEdits((s) => s.update);
  const reset = useEdits((s) => s.reset);
  const { state, processing } = useRender(row);
  const openEditor = useEditor((s) => s.open);

  if (!row || !processing) {
    return (
      <section aria-label="Preview" className="flex h-[264px] shrink-0 flex-col items-center justify-center gap-2 border-t border-line bg-panel text-center">
        <span className="text-[14px] font-medium">Select a sample to preview it</span>
        <span className="text-ui text-text3">↑ ↓ to browse · Space to play · F to favorite · drag any row into your DAW</span>
      </section>
    );
  }

  const playing = status === "playing" || status === "loading";
  const loopOn = shouldLoop(row);
  const segments = row.dir.split("/").filter(Boolean);
  const bars = barsCount(row.duration, hasTempo(row) ? row.bpm : null);
  const edited = edit !== DEFAULT_EDIT;
  const meta = [
    row.ext.toUpperCase(),
    fmtRate(row.sampleRate),
    row.bitDepth ? `${row.bitDepth}-bit` : "",
    fmtChannels(row.channels),
    fmtDb(row.loudness, "LUFS") || fmtDb(row.peakDb, "dB peak"),
    bars ? `${bars} ${bars === 1 ? "bar" : "bars"}` : "",
  ].filter(Boolean);

  const toggleLoop = () => {
    const next = !loopOn;
    prefs.set(row.kind === "loop" ? { loopLoops: next } : { loopShots: next });
    if (usePlayer.getState().id === row.id) usePlayer.getState().setLooping(next);
  };

  return (
    <section aria-label="Preview" className="@container/preview flex h-[264px] shrink-0 flex-col gap-3 border-t border-line bg-panel px-4 pt-4 pb-3.5">
      <div className="flex h-10 shrink-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="truncate text-title font-semibold tracking-[-0.01em]">
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
            <TagEditor row={row} />
          </div>
          <div className="flex min-w-0 gap-3.5 text-small whitespace-nowrap text-text3">
            <span className="truncate">{segments.length ? segments.join("  ›  ") : row.pack}</span>
            <span className="font-mono text-[11.5px]">{meta.join(" · ")}</span>
          </div>
        </div>
        {edited && (
          <button type="button" onClick={() => reset(row.id)} className="h-8 shrink-0 rounded-lg px-2.5 text-ui text-text3 hover:bg-raised hover:text-text">
            Revert edits
          </button>
        )}
 <button
          type="button"
          onClick={() => findSimilar(row)}
          title="Find samples that sound like this one (G)"
          className="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-line2 px-3 text-ui text-text2 hover:bg-raised hover:text-text"
        >
          <SimilarIcon />
          <span className="@max-[980px]/preview:hidden">Find similar</span>
        </button>
        <button type="button" onClick={() => openEditor(row.id)} title="Edit and sync (E)" className="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-line2 px-3 text-ui text-text2 hover:bg-raised hover:text-text">
          <SlidersHorizontal size={15} strokeWidth={1.75} />
          <span>Edit</span>
        </button>
        <button
          type="button"
          onClick={async (e) => {
            const el = e.currentTarget;
            const member = await api.sampleCollections(row.id).catch(() => [] as number[]);
            openMenuBelow(el, collectionSubmenu([row.id], member), "right");
          }}
          className="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-line2 px-3 text-ui text-text2 hover:bg-raised hover:text-text"
        >
          <FolderPlus size={15} strokeWidth={1.75} />
          <span>Collect</span>
        </button>
        <IconButton label={revealLabel()} onClick={() => void reveal(row.path)} className="border border-line2">
          <FolderSearch size={15} strokeWidth={1.75} />
        </IconButton>
        <DragTile row={row} state={state} processing={processing} />
      </div>

      <BigWaveform row={row} processing={processing} />

      <div className="flex h-9 shrink-0 items-center gap-3">
        <button
          type="button"
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => {
            if (selectedIndex >= 0) useBrowse.getState().selectRow(row, selectedIndex, { play: false });
            usePlayer.getState().toggle(row);
          }}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-on-accent"
        >
          {playing ? <Pause size={14} fill="currentColor" strokeWidth={0} /> : <Play size={14} fill="currentColor" strokeWidth={0} className="translate-x-px" />}
        </button>
        <div className="flex gap-1">
          <IconButton label={row.kind === "loop" ? "Loop loops (L)" : "Loop one-shots (L)"} active={loopOn} aria-pressed={loopOn} onClick={toggleLoop}>
            <Repeat size={16} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Reverse (R)" active={edit.reverse} aria-pressed={edit.reverse} onClick={() => update(row.id, { reverse: !edit.reverse })}>
            <ReverseIcon />
          </IconButton>
        </div>
        <Divider />
        <div className="flex items-center gap-1.5">
          <SectionLabel>Tempo</SectionLabel>
          <TempoReadout row={row} processing={processing} />
        </div>
        <Divider />
        <div className="flex items-center gap-2">
          <SectionLabel>Pitch</SectionLabel>
          <PitchStepper row={row} processing={processing} compact />
        </div>
        <Divider />
        <div className="flex items-center gap-2.5">
          <SectionLabel>Key</SectionLabel>
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
          <span title={project.key ? "Transpose pitched samples to the project key (K)" : "Set a project key in the title bar first"}>
            <Switch
              size="sm"
              checked={project.matchKey && project.key != null}
              onChange={(v) => project.key && project.set({ matchKey: v })}
              label={<span className={cx("text-small whitespace-nowrap", !project.key && "opacity-50")}>Match</span>}
            />
          </span>
        </div>
        <div className="flex-1" />
        <span className="@max-[980px]/preview:hidden">
          <Clock row={row} />
        </span>
        <IconButton label="Metronome click" size={30} active={project.click} aria-pressed={project.click} onClick={() => project.set({ click: !project.click })}>
          <MetronomeIcon />
        </IconButton>
        <label className="flex items-center gap-2 text-text3 @max-[1080px]/preview:hidden" title="Preview volume">
          <Volume2 size={16} strokeWidth={1.75} aria-hidden="true" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={prefs.volume}
            aria-label="Preview volume"
            onChange={(e) => {
              const v = Number(e.target.value);
              prefs.set({ volume: v });
              void api.setVolume(v);
            }}
            className="w-20"
          />
        </label>
      </div>
    </section>
  );
}
