import { save } from "@tauri-apps/plugin-dialog";
import { ChevronLeft, Download, Minus, Pause, Play, Plus, Repeat, RotateCcw, Square, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePalette } from "../hooks/useTheme";
import { toggleLoop } from "../lib/actions";
import { api, errorMessage } from "../lib/api";
import { ESTIMATE, fmtBpm, fmtChannels, fmtClock, fmtDb, fmtRate } from "../lib/format";
import { DEFAULT_EDIT, type Processing } from "../lib/processing";
import { useRender } from "../lib/renders";
import { usePixelRatio } from "../lib/scale";
import type { SampleRow } from "../lib/types";
import { setupCanvas } from "../lib/waveform";
import { useBrowse } from "../store/browse";
import { useEditor, type Snap } from "../store/editor";
import { playerPosition, useLoopOn, usePlayer } from "../store/player";
import { useEdit, useEdits, useProject } from "../store/project";
import { toast } from "../store/toasts";
import { Clock, DragTile, MetronomeIcon, PitchStepper, useElementWidth } from "./PreviewPanel";
import { cx, Divider, IconButton, Segmented, Switch } from "./ui";

const LANE_GAP = 10;

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function gridFor(processing: Processing): number | null {
  return processing.sourceBpm ? 60 / processing.sourceBpm : null;
}

function snapTime(t: number, snap: Snap, beat: number | null, duration: number): number {
  if (!beat || snap === "off") return Math.max(0, Math.min(duration, t));
  const unit = snap === "bar" ? beat * 4 : beat;
  return Math.max(0, Math.min(duration, Math.round(t / unit) * unit));
}

/** "3.2.1": bar, beat and sixteenth for a time on the sample's own grid. */
function barPosition(t: number, beat: number): string {
  const beats = t / beat;
  const b = Math.floor(beats + 1e-6);
  return `${Math.floor(b / 4) + 1}.${(b % 4) + 1}.${Math.floor((beats - b) * 4 + 1e-6) + 1}`;
}

function Stage({ row, processing }: { row: SampleRow; processing: Processing }) {
  const duration = row.duration ?? 0;
  const [box, width] = useElementWidth<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const hover = useRef<HTMLDivElement>(null);
  const hoverLabel = useRef<HTMLSpanElement>(null);
  const colors = usePalette();
  const ratio = usePixelRatio();
  const view = useEditor((s) => s.view) ?? { start: 0, end: duration };
  const setView = useEditor((s) => s.setView);
  const snap = useEditor((s) => s.snap);
  const update = useEdits((s) => s.update);
  const status = usePlayer((s) => (s.id === row.id ? s.status : "idle"));
  const [peaks, setPeaks] = useState<Uint8Array[] | null>(null);
  const [height, setHeight] = useState(240);
  const beat = gridFor(processing);
  const span = Math.max(1e-6, view.end - view.start);
  const xOf = (t: number) => ((t - view.start) / span) * width;
  const tOf = (x: number) => view.start + (x / Math.max(1, width)) * span;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setHeight(Math.max(120, Math.floor(e.contentRect.height))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [box]);

  useEffect(() => {
    if (!width || !duration) return;
    let live = true;
    const t = window.setTimeout(() => {
      api
        .waveformDetail(row.id, view.start, view.end, Math.floor(width / 2))
        .then((d) => live && setPeaks(d.channels.map(decode)))
        .catch((e) => toast(errorMessage(e)));
    }, 40);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [row.id, view.start, view.end, width, duration]);

  const rs = processing.regionStart;
  const re = processing.regionEnd;
  const partial = processing.params.regionStart != null;

  useEffect(() => {
    const c = canvas.current;
    if (!c || !width) return;
    const draw = () => {
      const ctx = setupCanvas(c, width, height);
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      // Beat grid.
      if (beat) {
        const first = Math.ceil(view.start / beat);
        const pxPerBeat = (beat / span) * width;
        for (let b = first; b * beat <= view.end; b++) {
          if (b % 4 !== 0 && pxPerBeat < 8) continue;
          ctx.fillStyle = b % 4 === 0 ? colors.line2 : colors.line;
          ctx.fillRect(Math.round(xOf(b * beat)) + 0.5, 0, 1, height);
        }
      }
      const lanes = peaks?.length ?? 1;
      const laneH = (height - LANE_GAP * (lanes - 1)) / lanes;
      const s = usePlayer.getState();
      const active = s.id === row.id && s.status !== "idle";
      const pos = active ? playerPosition(s) : null;
      const x0 = xOf(rs);
      const x1 = xOf(re);
      for (let l = 0; l < lanes; l++) {
        const top = l * (laneH + LANE_GAP);
        const mid = top + laneH / 2;
        ctx.fillStyle = colors.line;
        ctx.fillRect(0, Math.round(mid), width, 1);
        const p = peaks?.[l];
        if (!p) continue;
        const step = width / p.length;
        ctx.lineCap = "round";
        ctx.lineWidth = Math.max(1, Math.min(2, step * 0.7));
        // Three passes: outside the region, the played part, the rest of the region.
        const played = pos == null ? null : xOf(pos);
        const bucket = (color: string, test: (x: number) => boolean) => {
          ctx.strokeStyle = color;
          ctx.beginPath();
          for (let i = 0; i < p.length; i++) {
            const x = i * step + step / 2;
            if (!test(x)) continue;
            const a = Math.max(0.5, Math.pow(p[i] / 255, 0.85) * (laneH / 2 - 2));
            ctx.moveTo(x, mid - a);
            ctx.lineTo(x, mid + a);
          }
          ctx.stroke();
        };
        bucket(colors.wave, (x) => x < x0 || x > x1);
        if (played != null) {
          const reverse = processing.params.reverse;
          bucket(colors.accentWave, (x) => x >= x0 && x <= x1 && (reverse ? x >= played : x <= played));
          bucket(colors.wave2, (x) => x >= x0 && x <= x1 && (reverse ? x < played : x > played));
        } else {
          bucket(colors.wave2, (x) => x >= x0 && x <= x1);
        }
      }
      if (pos != null) {
        ctx.fillStyle = colors.text;
        ctx.fillRect(Math.round(xOf(pos)) - 1, 0, 2, height);
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
    // xOf depends on view/width, both listed.
  }, [peaks, width, height, colors, ratio, status, view.start, view.end, rs, re, beat, row.id, processing.params.reverse]);

  // Zoom with ⌘/Ctrl + wheel (or pinch), pan with horizontal scroll.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const cur = useEditor.getState().view ?? { start: 0, end: duration };
      const len = cur.end - cur.start;
      if (e.ctrlKey || e.metaKey) {
        const at = cur.start + ((e.clientX - r.left) / r.width) * len;
        const factor = Math.exp(e.deltaY * 0.01);
        const next = Math.max(Math.min(duration, 0.02), Math.min(duration, len * factor));
        let start = at - ((at - cur.start) / len) * next;
        start = Math.max(0, Math.min(duration - next, start));
        setView(next >= duration ? null : { start, end: start + next });
      } else {
        const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0) / r.width;
        if (!d || len >= duration) return;
        const start = Math.max(0, Math.min(duration - len, cur.start + d * len));
        setView({ start, end: start + len });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [box, duration, setView]);

  const onMouseDown = (e: React.MouseEvent) => {
    const r = box.current!.getBoundingClientRect();
    const x0 = e.clientX - r.left;
    const t0 = tOf(x0);
    let dragged = false;
    const move = (ev: MouseEvent) => {
      const x = ev.clientX - r.left;
      if (!dragged && Math.abs(x - x0) < 4) return;
      dragged = true;
      const a = snapTime(t0, snap, beat, duration);
      const b = snapTime(tOf(x), snap, beat, duration);
      if (Math.abs(b - a) > 0.005) update(row.id, { regionStart: Math.min(a, b), regionEnd: Math.max(a, b) });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (!dragged) usePlayer.getState().seek(row, Math.max(0, Math.min(duration, t0)));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /** Dragging the region brace: a handle resizes, the middle moves it. */
  const dragRegion = (which: "start" | "end" | "move") => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = box.current!.getBoundingClientRect();
    const tStart = tOf(e.clientX - r.left);
    const [a0, b0] = [rs, re];
    const move = (ev: MouseEvent) => {
      const t = tOf(ev.clientX - r.left);
      if (which === "move") {
        const len = b0 - a0;
        const a = snapTime(Math.max(0, Math.min(duration - len, a0 + (t - tStart))), snap, beat, duration);
        update(row.id, { regionStart: a, regionEnd: Math.min(duration, a + len) });
      } else if (which === "start") {
        update(row.id, { regionStart: Math.min(snapTime(t, snap, beat, duration), b0 - 0.01), regionEnd: b0 });
      } else {
        update(row.id, { regionStart: a0, regionEnd: Math.max(snapTime(t, snap, beat, duration), a0 + 0.01) });
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const ruler = useMemo(() => {
    if (!width || !duration) return [];
    const marks: { x: number; label: string }[] = [];
    if (beat) {
      const bar = beat * 4;
      const pxPerBar = (bar / span) * width;
      const every = pxPerBar > 60 ? 1 : pxPerBar > 30 ? 2 : pxPerBar > 12 ? 4 : 8;
      const showBeats = (beat / span) * width > 48;
      for (let b = Math.ceil(view.start / beat); b * beat <= view.end; b++) {
        const isBar = b % 4 === 0;
        if (isBar ? (b / 4) % every !== 0 : !showBeats) continue;
        marks.push({ x: xOf(b * beat), label: isBar ? String(b / 4 + 1) : `${Math.floor(b / 4) + 1}.${(b % 4) + 1}` });
      }
    } else {
      const target = span / Math.max(1, width / 90);
      const unit = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60].find((u) => u >= target) ?? 60;
      for (let t = Math.ceil(view.start / unit) * unit; t <= view.end; t += unit) {
        marks.push({ x: xOf(t), label: unit < 1 ? `${t.toFixed(unit < 0.01 ? 3 : 2)} s` : fmtClock(t) });
      }
    }
    return marks;
    // xOf depends on view/width, both listed.
  }, [width, duration, beat, view.start, view.end, span]);

  const looping = useLoopOn(row);
  const braceLeft = Math.max(0, xOf(rs));
  const braceRight = Math.min(width, xOf(re));

  return (
    <div className="flex min-h-0 flex-1 flex-col px-8 pt-4">
      <div className="relative h-5 shrink-0">
        {ruler.map((m) => (
          <span key={`${m.label}-${m.x}`} className="absolute top-0 h-4 border-l border-line2 pl-1 font-mono text-[10.5px] leading-3 whitespace-nowrap text-text2" style={{ left: m.x }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="relative mt-1 h-3.5 shrink-0" title="Loop region: drag the ends to resize, the middle to move">
        {braceRight > braceLeft && (
          <>
            <div
              onMouseDown={dragRegion("move")}
              className={cx("absolute top-1 h-1.5 cursor-grab rounded-full", looping ? "bg-accent-wave" : "bg-line2")}
              style={{ left: braceLeft, width: braceRight - braceLeft }}
            />
            <span onMouseDown={dragRegion("start")} className="absolute -top-px h-4 w-2 -translate-x-1 cursor-ew-resize rounded-sm bg-accent-wave" style={{ left: braceLeft }} />
            <span onMouseDown={dragRegion("end")} className="absolute -top-px h-4 w-2 -translate-x-1 cursor-ew-resize rounded-sm bg-accent-wave" style={{ left: braceRight }} />
          </>
        )}
      </div>
      <div
        ref={box}
        className="relative mt-2 min-h-[120px] flex-1"
        onMouseDown={onMouseDown}
        onMouseMove={(e) => {
          const r = box.current!.getBoundingClientRect();
          const t = tOf(e.clientX - r.left);
          if (hover.current) {
            hover.current.style.opacity = "1";
            hover.current.style.left = `${e.clientX - r.left}px`;
          }
          if (hoverLabel.current) hoverLabel.current.textContent = beat ? `${barPosition(t, beat)} · ${fmtClock(t)}` : fmtClock(t);
        }}
        onMouseLeave={() => {
          if (hover.current) hover.current.style.opacity = "0";
        }}
        role="slider"
        tabIndex={-1}
        aria-label="Waveform. Click to play from a position, drag to set the loop region."
        aria-valuemin={0}
        aria-valuemax={duration}
      >
        {partial && (
          <div
            className="pointer-events-none absolute top-0 bottom-0 border-x border-accent-wave bg-accent-soft"
            style={{ left: braceLeft, width: Math.max(0, braceRight - braceLeft) }}
          />
        )}
        <canvas ref={canvas} style={{ width: width || "100%", height }} className="absolute inset-0 block" />
        <div ref={hover} className="pointer-events-none absolute top-0 bottom-0 w-px bg-text3 opacity-0">
          <span ref={hoverLabel} className="absolute -top-5 left-1.5 rounded bg-raised2 px-1 font-mono text-[10.5px] whitespace-nowrap text-text2" />
        </div>
        {processing.params.reverse && (
          <span className="pointer-events-none absolute top-2 right-2 rounded bg-raised2 px-1.5 py-0.5 text-micro text-text2">Plays reversed</span>
        )}
      </div>
    </div>
  );
}

function Card({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-panel p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="m-0 text-micro font-semibold tracking-[0.06em] text-text3 uppercase">{title}</h2>
        {aside && <span className="truncate font-mono text-micro text-text3">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Big({ from, to, unit }: { from: string; to?: string | null; unit?: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 font-mono whitespace-nowrap">
      {to && to !== from ? (
        <>
          <span className="text-[20px] text-text2">{from}</span>
          <span className="text-[15px] text-text3">→</span>
          <span className="text-[20px] font-medium">{to}</span>
        </>
      ) : (
        <span className="text-[20px] font-medium">{from}</span>
      )}
      {unit && <span className="text-micro text-text3">{unit}</span>}
    </div>
  );
}

function TempoCard({ row, processing }: { row: SampleRow; processing: Processing }) {
  const project = useProject();
  const edit = useEdit(row.id);
  const update = useEdits((s) => s.update);
  const hasTempo = row.kind === "loop" && row.bpm != null;
  const changed = Math.abs(processing.rate - 1) > 1e-4;
  const source =
    row.bpmSource === "metadata"
      ? "Tempo from the file's loop data."
      : row.bpmSource === "name"
        ? "Tempo from the file name."
        : row.bpmSource === "audio"
          ? "Tempo detected from the audio. If it reads half or double, pick ½× or 2×."
          : "No tempo in the name, tags or audio.";
  const est = row.bpmSource === "audio" ? ESTIMATE : "";
  return (
    <Card title="Tempo" aside={changed ? `×${processing.rate.toFixed(3)}` : undefined}>
      {hasTempo ? (
        <Big from={`${est}${fmtBpm(processing.sourceBpm!)}`} to={changed && processing.targetBpm ? fmtBpm(Math.round(processing.targetBpm * 100) / 100) : null} unit="BPM" />
      ) : (
        <Big from={row.kind === "oneshot" ? "One-shot" : "No tempo"} />
      )}
      <Switch checked={project.sync} onChange={(v) => project.set({ sync: v })} label={`Sync to ${fmtBpm(project.bpm)} BPM`} />
      <Segmented
        label="Stretch mode"
        value={processing.mode}
        onChange={(mode) => update(row.id, { mode })}
        options={[
          { value: "stretch", label: "Stretch", title: "Change tempo and pitch independently" },
          { value: "repitch", label: "Repitch", title: "Speed and pitch move together, like tape" },
        ]}
        className="self-stretch [&>button]:flex-1"
      />
      {hasTempo && (
        <div role="group" aria-label="Half or double time" className="flex gap-1">
          {(["auto", 0.5, 1, 2] as const).map((m) => (
            <button
              key={String(m)}
              type="button"
              aria-pressed={edit.multiplier === m}
              onClick={() => update(row.id, { multiplier: m })}
              className={cx(
                "h-[26px] flex-1 rounded-md border font-mono text-[11.5px]",
                edit.multiplier === m ? "border-text2 text-text" : "border-line2 text-text2 hover:bg-raised",
              )}
            >
              {m === "auto" ? "Auto" : m === 0.5 ? "½×" : `${m}×`}
            </button>
          ))}
        </div>
      )}
      <p className="m-0 text-small leading-snug text-text3">{source}</p>
    </Card>
  );
}

function KeyCard({ row, processing }: { row: SampleRow; processing: Processing }) {
  const project = useProject();
  const edit = useEdit(row.id);
  const update = useEdits((s) => s.update);
  return (
    <Card title="Pitch & key" aside={processing.keyShift ? `${processing.keyShift > 0 ? "+" : "−"}${Math.abs(processing.keyShift)} st to match` : undefined}>
      <Big
        from={processing.keyFrom ? `${row.keySource === "audio" ? ESTIMATE : ""}${processing.keyFrom}` : "No key"}
        to={processing.keyTo !== processing.keyFrom ? processing.keyTo : null}
      />
      {row.keySource === "audio" && <p className="m-0 -mt-1 text-small leading-snug text-text3">Key detected from the audio — worth checking by ear.</p>}
      <Switch
        checked={project.matchKey && project.key != null}
        onChange={(v) => (project.key ? project.set({ matchKey: v }) : toast("Set a project key in the title bar first", "info"))}
        label="Match project key"
      />
      <PitchStepper row={row} processing={processing} />
      <label className="flex min-w-0 items-center gap-2 font-mono text-small text-text3" title="Fine tune in cents (double-click to reset)">
        <span className="shrink-0 font-sans text-ui text-text2">Fine</span>
        <input
          type="range"
          min={-50}
          max={50}
          step={1}
          value={edit.cents}
          disabled={processing.mode === "repitch" && processing.synced}
          onChange={(e) => update(row.id, { cents: Number(e.target.value) })}
          onDoubleClick={() => update(row.id, { cents: 0 })}
          aria-label="Fine tune in cents"
          className="w-0 min-w-0 flex-1"
        />
        <span className="w-11 shrink-0 text-right tabular">{edit.cents > 0 ? "+" : ""}{edit.cents} ct</span>
      </label>
      <label className={cx("flex items-center gap-2 text-ui text-text2", processing.mode === "repitch" && "opacity-45")}>
        <input
          type="checkbox"
          checked={edit.formants ?? project.formants}
          disabled={processing.mode === "repitch"}
          onChange={(e) => update(row.id, { formants: e.target.checked })}
          className="m-0 h-3.5 w-3.5"
        />
        <span>Preserve formants (vocals)</span>
      </label>
    </Card>
  );
}

function RegionCard({ row, processing }: { row: SampleRow; processing: Processing }) {
  const edit = useEdit(row.id);
  const update = useEdits((s) => s.update);
  const snap = useEditor((s) => s.snap);
  const setSnap = useEditor((s) => s.setSnap);
  const beat = gridFor(processing);
  const partial = processing.params.regionStart != null;
  const label = partial
    ? beat
      ? `${barPosition(processing.regionStart, beat).replace(/\.1$/, "")} – ${barPosition(processing.regionEnd, beat).replace(/\.1$/, "")}`
      : `${processing.regionStart.toFixed(2)} – ${processing.regionEnd.toFixed(2)} s`
    : "Whole sample";
  const bars = beat ? (processing.regionEnd - processing.regionStart) / (beat * 4) : null;
  return (
    <Card title="Loop region" aside={`${fmtClock(processing.outputDuration)}`}>
      <div className="flex items-baseline gap-2 font-mono">
        <span className="text-[20px] font-medium whitespace-nowrap">{label}</span>
        {bars != null && partial && <span className="text-micro text-text3">{Number(bars.toFixed(2))} bars</span>}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui text-text2">Snap</span>
        <Segmented
          size="sm"
          label="Snap"
          value={beat ? snap : "off"}
          onChange={setSnap}
          options={[
            { value: "off", label: "Off" },
            { value: "beat", label: "Beat" },
            { value: "bar", label: "Bar" },
          ]}
        />
      </div>
      <label className="flex flex-col gap-1.5 text-ui text-text2">
        <span className="flex justify-between">
          <span>Crossfade at the loop point</span>
          <span className="font-mono text-small text-text3">{Math.round(edit.crossfade * 1000)} ms</span>
        </span>
        <input type="range" min={0} max={100} step={1} value={Math.round(edit.crossfade * 1000)} onChange={(e) => update(row.id, { crossfade: Number(e.target.value) / 1000 })} aria-label="Loop crossfade" />
      </label>
      <button
        type="button"
        disabled={!partial}
        onClick={() => update(row.id, { regionStart: null, regionEnd: null })}
        className="h-7 rounded-md border border-line2 text-small text-text2 hover:bg-raised disabled:opacity-40"
      >
        {partial ? "Loop the whole sample" : "Drag across the waveform to set a region"}
      </button>
    </Card>
  );
}

function MsInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="flex flex-col gap-1 text-small text-text3">
      <span>{label}</span>
      <span className="flex h-7 items-center rounded-md border border-line2 bg-raised pr-2 focus-within:border-accent">
        <input
          value={draft ?? String(Math.round(value * 1000))}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const v = Number(draft);
            if (draft != null && Number.isFinite(v)) onChange(Math.max(0, Math.min(10_000, v)) / 1000);
            setDraft(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="w-full min-w-0 bg-transparent px-2 font-mono text-small text-text outline-none"
          aria-label={`${label} in milliseconds`}
        />
        <span className="font-mono text-micro">ms</span>
      </span>
    </label>
  );
}

function ShapeCard({ row }: { row: SampleRow }) {
  const edit = useEdit(row.id);
  const update = useEdits((s) => s.update);
  return (
    <Card title="Shape">
      <Switch checked={edit.reverse} onChange={(v) => update(row.id, { reverse: v })} label="Reverse" />
      <div className="grid grid-cols-2 gap-2">
        <MsInput label="Fade in" value={edit.fadeIn} onChange={(v) => update(row.id, { fadeIn: v })} />
        <MsInput label="Fade out" value={edit.fadeOut} onChange={(v) => update(row.id, { fadeOut: v })} />
      </div>
      <label className="flex flex-col gap-1.5 text-ui text-text2">
        <span className="flex justify-between">
          <span>Gain</span>
          <span className="font-mono text-small text-text3">{fmtDb(edit.gainDb, "dB") || "0.0 dB"}</span>
        </span>
        <input
          type="range"
          min={-24}
          max={12}
          step={0.5}
          value={edit.gainDb}
          onChange={(e) => update(row.id, { gainDb: Number(e.target.value) })}
          onDoubleClick={() => update(row.id, { gainDb: 0 })}
          aria-label="Gain"
        />
      </label>
      <Switch checked={edit.normalize} onChange={(v) => update(row.id, { normalize: v })} label="Normalize to −1 dBFS" />
    </Card>
  );
}

function OutputCard({ row }: { row: SampleRow }) {
  const { state, processing } = useRender(row);
  const [busy, setBusy] = useState(false);
  const exportFile = async () => {
    if (!processing) return;
    const dest = await save({
      title: "Export sample",
      defaultPath: `${row.name}${processing.label ? ` (${processing.label})` : ""}.wav`,
      filters: [{ name: "WAV audio", extensions: ["wav"] }],
    });
    if (!dest) return;
    try {
      await api.exportSample(row.id, processing.params, dest);
      toast("Exported", "info");
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  const variation = async () => {
    if (!processing) return;
    setBusy(true);
    try {
      await api.saveVariation(row.id, processing.params, processing.label || "variation");
      toast("Saved to Variations in your library", "info");
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Output">
      <DragTile row={row} state={state} processing={processing} tall />
      <div className="grid grid-cols-2 gap-2">
        <button type="button" disabled={busy || !processing?.processed} onClick={variation} className="h-[30px] rounded-md border border-line2 text-small text-text2 hover:bg-raised disabled:opacity-40" title="Render into the Variations folder of your saved sounds (see Settings) and add it to your library">
          Save variation
        </button>
        <button type="button" onClick={exportFile} className="flex h-[30px] items-center justify-center gap-1.5 rounded-md border border-line2 text-small text-text2 hover:bg-raised">
          <Download size={13} /> Export…
        </button>
      </div>
      <p className="m-0 text-small leading-snug text-text3">Your original file is never changed. Renders are kept in Music › Saga so DAW projects that use them keep working.</p>
    </Card>
  );
}

function Position({ row, processing }: { row: SampleRow; processing: Processing }) {
  const ref = useRef<HTMLSpanElement>(null);
  const status = usePlayer((s) => (s.id === row.id ? s.status : "idle"));
  const beat = gridFor(processing);
  useEffect(() => {
    const set = () => {
      const s = usePlayer.getState();
      const t = s.id === row.id && s.status !== "idle" ? playerPosition(s) : processing.regionStart;
      if (ref.current) ref.current.textContent = beat ? barPosition(t, beat) : fmtClock(t);
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
  }, [status, row.id, beat, processing.regionStart]);
  return <span ref={ref} className="w-16 font-mono text-body tabular" />;
}

function Transport({ row, processing }: { row: SampleRow; processing: Processing }) {
  const status = usePlayer((s) => (s.id === row.id ? s.status : "idle"));
  const project = useProject();
  const view = useEditor((s) => s.view);
  const setView = useEditor((s) => s.setView);
  const duration = row.duration ?? 0;
  const loopOn = useLoopOn(row);
  const playing = status === "playing" || status === "loading";
  const zoom = (factor: number) => {
    const cur = view ?? { start: 0, end: duration };
    const s = usePlayer.getState();
    const center = s.id === row.id && s.status !== "idle" ? playerPosition(s) : (cur.start + cur.end) / 2;
    const len = Math.max(Math.min(duration, 0.02), Math.min(duration, (cur.end - cur.start) * factor));
    if (len >= duration) return setView(null);
    const start = Math.max(0, Math.min(duration - len, center - len / 2));
    setView({ start, end: start + len });
  };
  return (
    <footer className="flex h-14 shrink-0 items-center gap-3 border-t border-line bg-panel px-8">
      <button type="button" aria-label={playing ? "Pause" : "Play"} onClick={() => usePlayer.getState().toggle(row)} className="grid h-9 w-9 place-items-center rounded-full bg-accent text-on-accent">
        {playing ? <Pause size={14} fill="currentColor" strokeWidth={0} /> : <Play size={14} fill="currentColor" strokeWidth={0} className="translate-x-px" />}
      </button>
      <IconButton label="Stop" onClick={() => usePlayer.getState().stop()}>
        <Square size={12} fill="currentColor" strokeWidth={0} />
      </IconButton>
      <IconButton
        label="Loop (L)"
        active={loopOn}
        aria-pressed={loopOn}
        onClick={() => toggleLoop(row)}
      >
        <Repeat size={16} strokeWidth={1.75} />
      </IconButton>
      <button
        type="button"
        aria-pressed={project.click}
        onClick={() => project.set({ click: !project.click })}
        disabled={!gridFor(processing)}
        title={gridFor(processing) ? "Metronome click on the sample's beat" : "Needs a loop with a tempo"}
        className={cx("flex h-8 items-center gap-2 rounded-lg px-2.5 text-ui disabled:opacity-40", project.click ? "bg-raised2 text-accent-ink" : "text-text2 hover:bg-raised")}
      >
        <MetronomeIcon />
        <span>Click</span>
      </button>
      <Divider />
      <Position row={row} processing={processing} />
      <Clock row={row} />
      <div className="flex-1" />
      <IconButton label="Zoom out" onClick={() => zoom(1.6)}>
        <Minus size={15} />
      </IconButton>
      <button type="button" onClick={() => setView(null)} className="h-8 rounded-md px-2.5 text-small text-text2 hover:bg-raised">
        Fit
      </button>
      <IconButton label="Zoom in" onClick={() => zoom(1 / 1.6)}>
        <Plus size={15} />
      </IconButton>
    </footer>
  );
}

export function Editor() {
  const row = useBrowse((s) => s.selected);
  const openId = useEditor((s) => s.openId);
  const close = useEditor((s) => s.close);
  const toggleFavorite = useBrowse((s) => s.toggleFavorite);
  const edit = useEdit(row?.id);
  const reset = useEdits((s) => s.reset);
  const { processing } = useRender(row);

  if (!row || row.id !== openId || !processing) {
    return (
      <div className="grid flex-1 place-items-center">
        <button type="button" onClick={close} className="text-ui text-text2 underline">
          Back to the browser
        </button>
      </div>
    );
  }

  const meta = [row.ext.toUpperCase(), fmtRate(row.sampleRate), row.bitDepth ? `${row.bitDepth}-bit` : "", fmtChannels(row.channels), fmtDb(row.loudness, "LUFS"), row.duration ? fmtClock(row.duration) : ""].filter(Boolean);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-3 px-8 pt-5">
        <button type="button" onClick={close} title="Back to the browser (Esc)" className="mt-0.5 flex h-8 items-center gap-1 rounded-lg pr-2.5 pl-1.5 text-ui text-text2 hover:bg-raised hover:text-text">
          <ChevronLeft size={16} /> Browser
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="m-0 truncate text-[20px] font-semibold tracking-[-0.02em]">
              {row.name}
              <span className="font-normal text-text3">.{row.ext}</span>
            </h1>
            <button
              type="button"
              aria-label={row.favorite ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={row.favorite}
              onClick={() => toggleFavorite(row)}
              className={cx("grid h-7 w-7 shrink-0 place-items-center rounded-md", row.favorite ? "text-accent-ink" : "text-text3 hover:text-text")}
            >
              <Star size={16} strokeWidth={1.75} fill={row.favorite ? "currentColor" : "none"} />
            </button>
          </div>
          <span className="font-mono text-small text-text3">{meta.join(" · ")}</span>
        </div>
        <button
          type="button"
          disabled={edit === DEFAULT_EDIT}
          onClick={() => reset(row.id)}
          className="flex h-8 items-center gap-2 rounded-lg px-3 text-ui text-text3 hover:bg-raised hover:text-text disabled:opacity-40"
        >
          <RotateCcw size={14} /> Revert edits
        </button>
      </div>

      <Stage row={row} processing={processing} />

      <div className="grid shrink-0 grid-cols-5 gap-3.5 px-8 pt-4 pb-5 @max-[1100px]:grid-cols-3">
        <TempoCard row={row} processing={processing} />
        <KeyCard row={row} processing={processing} />
        <RegionCard row={row} processing={processing} />
        <ShapeCard row={row} />
        <OutputCard row={row} />
      </div>

      <Transport row={row} processing={processing} />
    </div>
  );
}
