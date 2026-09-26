import { useRef, useState } from "react";
import { fmtBpm } from "../lib/format";
import { camelot, keyLongName } from "../lib/keys";
import { useProject } from "../store/project";
import { KeyWheel } from "./KeyWheel";
import { Popover } from "./Popover";
import { cx, Switch } from "./ui";

const MIN_BPM = 30;
const MAX_BPM = 300;

function clampBpm(v: number): number {
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

export function KeyControl({ compact }: { compact?: boolean }) {
  const key = useProject((s) => s.key);
  const set = useProject((s) => s.set);
  return (
    <Popover
      align="right"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-expanded={open}
          aria-label={key ? `Project key, ${keyLongName(key.pc, key.mode)}` : "Set the project key"}
          onClick={toggle}
          className={cx("flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 whitespace-nowrap hover:bg-raised", open ? "border-accent" : "border-line2")}
        >
          {key ? (
            <>
              <span className={cx("font-medium", compact ? "text-ui" : "text-body")}>{keyLongName(key.pc, key.mode).replace(" minor", " min").replace(" major", " maj")}</span>
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
          <span className="self-start text-small text-text3">Project key — used to match and highlight compatible samples</span>
          <KeyWheel
            value={key ? { ...key, compatible: true, includeUnpitched: true, rootInScale: true } : null}
            counts={undefined}
            onPick={(pc, mode) => {
              set({ key: key && key.pc === pc && key.mode === mode ? null : { pc, mode } });
              close();
            }}
          />
          <button type="button" onClick={() => { set({ key: null }); close(); }} className="h-7 self-stretch rounded-md text-small text-text2 hover:bg-raised">
            No project key
          </button>
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
