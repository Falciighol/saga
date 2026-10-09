import { ChevronDown, FileAudio, Mic, Pause, Play, Square } from "lucide-react";
import { useEffect, useRef } from "react";
import { dragSample, sampleMenu } from "../lib/actions";
import { fmtCount, soundSummary } from "../lib/format";
import type { Aspect, SampleRow, SimilarItem } from "../lib/types";
import { useLibrary } from "../store/library";
import { usePlayer } from "../store/player";
import { usePrefs } from "../store/prefs";
import { useSimilar } from "../store/similar";
import { useSoundMap } from "../store/soundmap";
import { openContextMenu, openMenuBelow } from "./Menu";
import { cx, SectionLabel, Segmented } from "./ui";
import { SimilarIcon } from "./ViewToggle";
import { MiniWave } from "./Waveforms";

/** Room for a waveform inside the panel's padding. */
const WAVE_WIDTH = 288;

function GripIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" className="fill-current">
      <circle cx="9" cy="6" r="1.8" />
      <circle cx="15" cy="6" r="1.8" />
      <circle cx="9" cy="12" r="1.8" />
      <circle cx="15" cy="12" r="1.8" />
      <circle cx="9" cy="18" r="1.8" />
      <circle cx="15" cy="18" r="1.8" />
    </svg>
  );
}

function where(row: SampleRow): string {
  const segs = row.dir.split("/").filter(Boolean);
  return segs.length > 1 ? `${segs[0]}  ›  ${segs[segs.length - 1]}` : row.pack;
}

function Target() {
  const target = useSimilar((s) => s.target);
  const status = usePlayer((s) => (target?.kind === "sample" && s.id === target.row.id ? s.status : "idle"));
  if (!target) {
    return <p className="m-0 text-ui leading-snug text-text3">Click a sound on the map, choose Find similar on any sample, or hum, beatbox or play something into the mic.</p>;
  }
  if (target.kind !== "sample") {
    const recording = target.kind === "recording";
    return (
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-raised2 text-text2">{recording ? <Mic size={15} /> : <FileAudio size={15} />}</span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-body font-semibold">{recording ? "Your recording" : target.name}</span>
          <span className="truncate text-small text-text3">{recording ? "From the microphone" : (target.what ?? "Dropped file")}</span>
        </div>
      </div>
    );
  }
  const row = target.row;
  const playing = status === "playing" || status === "loading";
  return (
    <div
      className="flex flex-col gap-2.5"
      draggable={row.online}
      onDragStart={(e) => {
        e.preventDefault();
        dragSample(row);
      }}
      onContextMenu={(e) => openContextMenu(e, sampleMenu(row, -1))}
    >
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          aria-label={`${playing ? "Pause" : "Play"} ${row.name}`}
          onClick={() => usePlayer.getState().toggle(row)}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-on-accent"
        >
          {playing ? <Pause size={12} fill="currentColor" strokeWidth={0} /> : <Play size={12} fill="currentColor" strokeWidth={0} className="translate-x-px" />}
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-body font-semibold" title={row.name}>
            {row.name}
          </span>
          <span className="truncate text-small text-text3">{where(row)}</span>
        </div>
        <span title="Drag into your DAW" className="grid h-8 w-6 shrink-0 cursor-grab place-items-center text-text3">
          <GripIcon />
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <MiniWave peaks={row.peaks} width={WAVE_WIDTH} height={26} sampleId={row.id} emphasized />
        <span className="truncate font-mono text-micro text-text3">{soundSummary(row)}</span>
      </div>
    </div>
  );
}

/**
 * The sound under the pointer on the map. It sits over the foot of the list rather than
 * beside the pointer, so it never covers the sounds around the one being looked at.
 */
function Hovered() {
  const hovered = useSoundMap((s) => s.hovered);
  if (!hovered) return null;
  const { row, color } = hovered;
  return (
    <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex flex-col gap-2 rounded-[10px] border border-line2 bg-raised p-3 shadow-pop">
      <div className="flex flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-ui font-semibold">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
          <span className="truncate">
            {row.name}
            <span className="font-normal text-text3">.{row.ext}</span>
          </span>
        </span>
        <span className="truncate text-small text-text3">{where(row)}</span>
      </div>
      <MiniWave peaks={row.peaks} width={WAVE_WIDTH - 10} height={26} sampleId={row.id} emphasized />
      <span className="truncate font-mono text-micro text-text3">{soundSummary(row)}</span>
    </div>
  );
}

function Result({ item, index, active }: { item: SimilarItem; index: number; active: boolean }) {
  const row = item.row;
  const status = usePlayer((s) => (s.id === row.id ? s.status : "idle"));
  const playing = status === "playing" || status === "loading";
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div
      ref={ref}
      role="option"
      aria-selected={active}
      draggable={row.online}
      onDragStart={(e) => {
        e.preventDefault();
        useSimilar.getState().select(index, { play: false });
        dragSample(row);
      }}
      onContextMenu={(e) => {
        useSimilar.getState().select(index, { play: false });
        openContextMenu(e, sampleMenu(row, -1));
      }}
      onClick={() => useSimilar.getState().select(index, { play: true })}
      className={cx("group flex h-12 items-center gap-2 pr-3 pl-2.5", active ? "bg-raised" : "hover:bg-raised/60", !row.online && "opacity-45")}
    >
      <button
        type="button"
        aria-label={`${playing ? "Pause" : "Play"} ${row.name}`}
        onClick={(e) => {
          e.stopPropagation();
          useSimilar.getState().select(index, { play: false });
          usePlayer.getState().toggle(row);
        }}
        className={cx("grid h-7 w-7 shrink-0 place-items-center rounded-full", playing || active ? "text-accent-ink" : "text-text3 hover:text-text")}
      >
        {playing ? <Pause size={12} fill="currentColor" strokeWidth={0} /> : <Play size={12} fill="currentColor" strokeWidth={0} />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-ui" title={row.name}>
          {row.name}
        </span>
        <span className="truncate text-micro text-text3">{where(row)}</span>
      </div>
      <button
        type="button"
        aria-label={`Find sounds similar to ${row.name}`}
        title="Find sounds like this one"
        onClick={(e) => {
          e.stopPropagation();
          useSimilar.getState().find(row);
        }}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text3 opacity-0 group-hover:opacity-100 hover:bg-raised2 hover:text-text focus-visible:opacity-100"
      >
        <SimilarIcon size={14} />
      </button>
      <div className="h-1 w-11 shrink-0 overflow-hidden rounded-full bg-raised2" aria-hidden="true">
        <div className="h-1 bg-accent-wave" style={{ width: `${Math.round(item.score * 100)}%` }} />
      </div>
      <span className="w-[30px] shrink-0 text-right font-mono text-small text-text2 tabular" title="Similarity: 1 is identical, 0 is as different as two random samples">
        {item.score.toFixed(2)}
      </span>
    </div>
  );
}

function RecordButton() {
  const recording = useSimilar((s) => s.recording);
  if (recording) {
    return (
      <button
        type="button"
        onClick={() => void useSimilar.getState().stopRecording()}
        title="Stop and search"
        className="flex h-8 min-w-0 flex-1 items-center justify-center gap-2 rounded-lg border border-accent px-2.5 text-ui text-text"
      >
        <Square size={11} fill="currentColor" strokeWidth={0} className="shrink-0 text-accent-ink" />
        <span className="whitespace-nowrap">Listening… {recording.seconds.toFixed(1)} s</span>
        <span className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-raised2" aria-hidden="true">
          <span className="block h-1 bg-accent" style={{ width: `${Math.min(100, Math.sqrt(recording.level) * 180)}%` }} />
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void useSimilar.getState().startRecording()}
      title="Hum, beatbox or play a sound, then click again to find samples like it"
      className="flex h-8 min-w-0 flex-1 items-center justify-center gap-2 rounded-lg border border-line2 px-2.5 text-ui text-text2 hover:bg-raised hover:text-text"
    >
      <Mic size={15} strokeWidth={1.75} className="shrink-0" />
      <span className="truncate">Find by recording</span>
    </button>
  );
}

function ScopeButton() {
  const sourceId = useSimilar((s) => s.sourceId);
  const sources = useLibrary((s) => s.sources);
  const current = sources.find((s) => s.id === sourceId);
  return (
    <button
      type="button"
      onClick={(e) =>
        openMenuBelow(
          e.currentTarget,
          [
            { label: "All sources", checked: sourceId == null, onSelect: () => useSimilar.getState().setScope(null) },
            "separator",
            ...sources.map((s) => ({ label: s.name, checked: s.id === sourceId, onSelect: () => useSimilar.getState().setScope(s.id) })),
          ],
          "right",
        )
      }
      className="flex h-8 max-w-[132px] shrink-0 items-center gap-1.5 rounded-lg border border-line2 px-2.5 text-ui text-text2 hover:bg-raised hover:text-text"
    >
      <span className="truncate">{current?.name ?? "All sources"}</span>
      <ChevronDown size={12} strokeWidth={2.25} className="shrink-0" />
    </button>
  );
}

/** Samples that sound like the selected one, a recording, or a dropped file. */
export function SimilarPanel() {
  const target = useSimilar((s) => s.target);
  const items = useSimilar((s) => s.items);
  const loading = useSimilar((s) => s.loading);
  const message = useSimilar((s) => s.message);
  const pending = useSimilar((s) => s.pending);
  const index = useSimilar((s) => s.index);
  const aspect = usePrefs((s) => s.similarAspect);

  return (
    <aside aria-label="Similar sounds" data-similar-drop="true" className="flex w-[320px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex flex-col gap-3 border-b border-line px-4 pt-4 pb-3">
        <SectionLabel>Similar to</SectionLabel>
        <Target />
        <Segmented<Aspect>
          label="Compare by"
          size="sm"
          value={aspect}
          onChange={(a) => useSimilar.getState().setAspect(a)}
          className="self-stretch [&>button]:flex-1"
          options={[
            { value: "overall", label: "Overall" },
            { value: "timbre", label: "Timbre", title: "Tone color: dark or bright, clean or noisy" },
            { value: "pitch", label: "Pitch", title: "Which notes, and how high" },
            { value: "envelope", label: "Envelope", title: "Attack, length and decay" },
          ]}
        />
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <Hovered />
        <div role="listbox" aria-label="Similar sounds" className={cx("min-h-0 flex-1 overflow-y-auto py-1.5", loading && items.length > 0 && "opacity-60")}>
          {items.map((item, i) => (
            <Result key={item.row.id} item={item} index={i} active={i === index} />
          ))}
          {!items.length && target && (
            <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
              {loading ? (
                <span className="animate-soft-pulse text-ui text-text3">Finding similar sounds…</span>
              ) : (
                <span className="text-ui text-text3">{message ?? "Nothing sounds much like this yet."}</span>
              )}
            </div>
          )}
          {!target && (
            <div className="flex flex-col items-center gap-1 px-6 py-10 text-center text-ui text-text3">
              <span>You can also drop any audio file here to find samples that sound like it.</span>
            </div>
          )}
          {items.length > 0 && pending > 0 && (
            <p className="m-0 px-4 pt-2 pb-3 text-small text-text3">Saga is still listening to {fmtCount(pending)} samples; results get better as it goes.</p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 gap-2 border-t border-line px-4 py-3">
        <RecordButton />
        <ScopeButton />
      </div>
    </aside>
  );
}
