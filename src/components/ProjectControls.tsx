import { useRef, useState } from "react";
import { dragOut, OPEN_PROJECT_KEY } from "../lib/actions";
import { api, errorMessage } from "../lib/api";
import { fmtBpm } from "../lib/format";
import { keyClip } from "../lib/keyMidi";
import { camelot, keyLongName, projectKeyLabel } from "../lib/keys";
import type { ProjectKey } from "../lib/processing";
import { isPlain, scaleById } from "../lib/theory";
import { usePrefs } from "../store/prefs";
import { useUi } from "../store/ui";
import { useProject } from "../store/project";
import { toast } from "../store/toasts";
import { KeyWheel } from "./KeyWheel";
import { Popover } from "./Popover";
import { GripIcon } from "./PreviewPanel";
import { cx, Kbd, Switch } from "./ui";

const MIN_BPM = 30;
const MAX_BPM = 300;

export function clampBpm(v: number): number {
  return Math.round(Math.min(MAX_BPM, Math.max(MIN_BPM, v)) * 100) / 100;
}

/** Tap tempo: averages the last few intervals, restarting after a 2-second pause. */
export function useTapTempo(onTempo: (bpm: number) => void) {
  const taps = useRef<number[]>([]);
  return () => {
    const now = performance.now();
    const last = taps.current[taps.current.length - 1];
    if (last && now - last > 2000) taps.current = [];
    taps.current = [...taps.current.slice(-7), now];
    if (taps.current.length >= 3) {
      const t = taps.current;
      const avg = (t[t.length - 1] - t[0]) / (t.length - 1);
      onTempo(clampBpm(Math.round((60000 / avg) * 10) / 10));
    }
  };
}

export function TempoControl({ compact }: { compact?: boolean }) {
  const bpm = useProject((s) => s.bpm);
  const set = useProject((s) => s.set);
  const [draft, setDraft] = useState<string | null>(null);
  const tap = useTapTempo((b) => set({ bpm: b }));

  const commit = () => {
    if (draft == null) return;
    const v = Number(draft.replace(",", "."));
    if (Number.isFinite(v) && v > 0) set({ bpm: clampBpm(v) });
    setDraft(null);
  };

  return (
    <div className="flex items-center gap-1.5">
      <label className="flex h-8 items-center gap-1.5 rounded-lg border border-line2 pr-2.5 pl-2 focus-within:border-accent hover:bg-raised">
        <input
          aria-label="Project tempo in BPM"
          value={draft ?? bpm.toFixed(2)}
          onFocus={(e) => {
            setDraft(bpm.toFixed(2));
            requestAnimationFrame(() => e.target.select());
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setDraft(null);
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const step = (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
              const v = clampBpm(Math.round(bpm) + step);
              set({ bpm: v });
              setDraft(v.toFixed(2));
            }
          }}
          className={cx("bg-transparent text-right font-mono font-medium tabular text-text outline-none", compact ? "w-[44px] text-ui" : "w-[52px] text-body")}
        />
        <span className="text-micro text-text3">BPM</span>
      </label>
      {!compact && (
      <button type="button" onClick={tap} title="Tap along to set the tempo (T)" className="h-8 rounded-lg border border-line2 px-2.5 text-small text-text2 hover:bg-raised hover:text-text active:bg-raised2">
        Tap
      </button>
      )}
    </div>
  );
}

/** Drags the project key's scale into a DAW as a MIDI clip: a bar up the scale, then a bar for each related key if asked. */
function KeyMidi({ projectKey }: { projectKey: ProjectKey | null }) {
  const bpm = useProject((s) => s.bpm);
  const related = usePrefs((s) => s.keyMidiRelated);
  const setPrefs = usePrefs((s) => s.set);
  const clip = projectKey ? keyClip(projectKey, related) : null;
  const label = `${fmtBpm(bpm)} BPM`;
  const file = clip ? `${clip.name} (${label}).mid` : "Pick a key first";
  return (
    <div className={cx("flex flex-col gap-1.5 self-stretch", !clip && "pointer-events-none opacity-45")}>
      <div
        draggable={!!clip}
        role="button"
        tabIndex={-1}
        aria-label={`Drag into your DAW as MIDI: ${file}`}
        title={clip ? `One bar up the scale${clip.related.length ? `, then ${clip.related.join(", ")}` : ""}. The clip is saved in Music › Saga › Renders.` : undefined}
        onDragStart={(e) => {
          e.preventDefault();
          if (!clip) return;
          api
            .saveMidi(clip.notes, clip.beats, bpm, clip.name, label)
            .then((path) => dragOut([path]))
            .catch((err) => toast(`Couldn't write the MIDI clip: ${errorMessage(err)}`));
        }}
        className="flex h-11 cursor-grab items-center gap-2 rounded-lg border border-dashed border-accent-wave bg-accent-soft pr-3 pl-2 active:cursor-grabbing"
      >
        <GripIcon className="shrink-0 fill-accent-ink" />
        <span className="flex min-w-0 flex-col gap-px">
          <span className="text-ui font-semibold">Drag scale as MIDI</span>
          <span className="truncate font-mono text-[10.5px] text-text3">{file}</span>
        </span>
      </div>
      <Switch checked={related} onChange={(v) => setPrefs({ keyMidiRelated: v })} label="Include related keys" className="h-6" />
    </div>
  );
}

export function KeyControl({ compact }: { compact?: boolean }) {
  const key = useProject((s) => s.key);
  const scaleLock = useProject((s) => s.scaleLock);
  const set = useProject((s) => s.set);
  const scale = scaleById(key?.scale);
  const labScale = scale && !isPlain(scale) ? scale : null;
  return (
    <Popover
      align="right"
      openOn={OPEN_PROJECT_KEY}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-expanded={open}
          aria-label={key ? `Project key, ${labScale ? projectKeyLabel(key) : keyLongName(key.pc, key.mode)}` : "Set the project key"}
          onClick={toggle}
          className={cx("flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 whitespace-nowrap hover:bg-raised", open ? "border-accent" : "border-line2")}
        >
          {key ? (
            <>
              <span className={cx("font-medium", compact ? "text-ui" : "text-body")}>{projectKeyLabel(key)}</span>
              {!compact && <span className="font-mono text-micro text-text3">{camelot(key.pc, key.mode)}</span>}
            </>
          ) : (
            <span className="text-body text-text2">Key</span>
          )}
        </button>
      )}
    >
      {(close) => (
        <div className="flex w-[272px] flex-col items-center gap-3 p-4">
          <span className="self-start text-small text-text3">
            {labScale ? `${projectKeyLabel(key!)}, from the Lab. Samples in the keys marked below fit it; picking a key replaces it.` : "Project key — used to match and highlight compatible samples"}
          </span>
          <KeyWheel
            value={key ? { pc: key.pc, mode: key.mode, compatible: true, includeUnpitched: true, rootInScale: true, scale: labScale?.steps } : null}
            counts={undefined}
            onPick={(pc, mode) => {
              // Stays open so Scale lock and the MIDI clip are within reach of the key just picked.
              set({ key: key && key.pc === pc && key.mode === mode ? null : { pc, mode } });
            }}
          />
          <div className={cx("flex flex-col gap-0.5 self-stretch", !key && "pointer-events-none opacity-45")}>
            <Switch checked={scaleLock} onChange={(v) => set({ scaleLock: v })} label="Scale lock" className="h-6" />
            <span className="text-micro leading-snug text-text3">
              <Kbd>[</Kbd> <Kbd>]</Kbd> and the pitch buttons step a sample through {key ? projectKeyLabel(key) : "the key"} instead of by semitones.
            </span>
          </div>
          <KeyMidi projectKey={key} />
          <div className="flex gap-1 self-stretch">
            <button type="button" onClick={() => { set({ key: null }); close(); }} className="h-7 flex-1 rounded-md text-small text-text2 hover:bg-raised">
              No project key
            </button>
            <button type="button" onClick={() => { useUi.getState().setView("lab"); close(); }} title="Scales, modes and chords (H)" className="h-7 flex-1 rounded-md text-small text-text2 hover:bg-raised">
              Open the Lab
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}

export function SyncSwitch() {
  const sync = useProject((s) => s.sync);
  const set = useProject((s) => s.set);
  const bpm = useProject((s) => s.bpm);
  return (
    <div
      title={sync ? `Loops play at ${fmtBpm(bpm)} BPM (S)` : "Play loops at the project tempo (S)"}
      className="flex h-8 items-center rounded-lg border border-line2 pr-2 pl-3"
    >
      <Switch checked={sync} onChange={(v) => set({ sync: v })} label={<span className="text-small">Sync</span>} />
    </div>
  );
}

export function ProjectControls() {
  return (
    <div className="flex items-center gap-1.5">
      <TempoControl />
      <KeyControl />
      <SyncSwitch />
    </div>
  );
}
