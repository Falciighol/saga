import { AppWindow, AudioLines, ChevronDown, ChevronRight, Eye, EyeOff, Mic, RefreshCw } from "lucide-react";
import { useState } from "react";
import { fmtRate } from "../../lib/format";
import type { AppSource, InputDevice, RecordSource, RecordSources } from "../../lib/types";
import { usePrefs } from "../../store/prefs";
import { setThresholdDb, THRESHOLD_MAX_DB, THRESHOLD_MIN_DB, useRecord, useThreshold } from "../../store/record";
import { openMenuBelow, useMenu, type MenuItem } from "../Menu";
import { cx, Segmented, Switch } from "../ui";

/** "In 3+4" for channels 2 and 3 of a device with more than two. */
function channelsLabel(channels: number[]): string {
  return `In ${channels.map((c) => c + 1).join("+")}`;
}

/** Pairs first (In 1+2, In 3+4…), then each channel on its own, which makes a mono take. */
function channelChoices(device: InputDevice, current: RecordSource | null): MenuItem[] {
  const picked = current?.kind === "input" && current.device === device.name ? current.channels : null;
  const choice = (channels: number[]): MenuItem => ({
    label: channelsLabel(channels),
    checked: picked != null && (picked.length ? picked.join() === channels.join() : channels.join() === "0,1"),
    onSelect: () => useRecord.getState().setSource({ kind: "input", device: device.name, channels }),
  });
  const pairs: MenuItem[] = [];
  for (let c = 0; c + 1 < device.channels; c += 2) pairs.push(choice([c, c + 1]));
  const singles: MenuItem[] = Array.from({ length: device.channels }, (_, c) => choice([c]));
  return [{ label: "Stereo", heading: true }, ...pairs, "separator", { label: "Mono", heading: true }, ...singles];
}

function appIcon(app: AppSource, size = 14) {
  return app.icon ? <img src={app.icon} alt="" width={size} height={size} className="block rounded-[3px]" /> : <AppWindow size={size} />;
}

export type SourceKind = RecordSource["kind"];

/** The apps under Hidden show in the source menu. It folds again each time the menu opens. */
let showHidden = false;

/** Moves an app under Hidden in the source menu, or back. Apps are kept by name, since their process changes each launch. */
function setAppHidden(name: string, hidden: boolean) {
  const rest = usePrefs.getState().recordHiddenApps.filter((n) => n !== name);
  usePrefs.getState().set({ recordHiddenApps: hidden ? [...rest, name] : rest });
}

/** The grouped menu of everything that can be recorded, or one kind of it. */
function sourceItems(sources: RecordSources | null, only?: SourceKind): MenuItem[] {
  const current = usePrefs.getState().recordSource;
  const set = (s: RecordSource) => () => useRecord.getState().setSource(s);
  if (!sources) return [{ label: "Looking for inputs and apps…", disabled: true }];
  const items: MenuItem[] = [];
  if (!only || only === "input") {
    items.push({ label: "Inputs", heading: true });
    if (!sources.inputs.length) items.push({ label: "No inputs found", disabled: true });
    for (const d of sources.inputs) {
      const checked = current?.kind === "input" && current.device === d.name;
      items.push(
        d.channels > 2
          ? { label: d.name, icon: <Mic size={14} />, checked, submenu: channelChoices(d, current) }
          : { label: d.name, icon: <Mic size={14} />, hint: d.isDefault ? "Default" : undefined, checked, onSelect: set({ kind: "input", device: d.name, channels: [] }) },
      );
    }
  }
  if (!only || only === "app") {
    if (items.length) items.push("separator");
    items.push({ label: "Apps", heading: true });
    if (!sources.appsSupported) items.push({ label: sources.unsupported ?? "Saga can't record one app here.", disabled: true });
    else if (!sources.apps.length) items.push({ label: "No apps are playing sound", disabled: true });
    const hiddenNames = new Set(usePrefs.getState().recordHiddenApps);
    const app = (a: AppSource, hidden: boolean): MenuItem => ({
      label: a.name,
      icon: appIcon(a),
      hint: a.playing ? "Playing" : undefined,
      checked: current?.kind === "app" && current.pid === a.pid,
      muted: hidden,
      onSelect: set({ kind: "app", pid: a.pid, name: a.name }),
      aside: hidden
        ? { label: `Show ${a.name} again`, icon: <Eye size={14} />, onSelect: () => setAppHidden(a.name, false) }
        : { label: `Hide ${a.name}`, icon: <EyeOff size={14} />, onSelect: () => setAppHidden(a.name, true) },
    });
    const hidden = sources.apps.filter((a) => hiddenNames.has(a.name));
    for (const a of sources.apps) if (!hiddenNames.has(a.name)) items.push(app(a, false));
    // Apps that never make a sound worth keeping wait at the end, folded, so the ones that do stay in reach.
    if (hidden.length) {
      items.push({
        label: "Hidden",
        icon: showHidden ? <ChevronDown size={14} /> : <ChevronRight size={14} />,
        hint: String(hidden.length),
        muted: true,
        expanded: showHidden,
        keepOpen: true,
        onSelect: () => {
          showHidden = !showHidden;
        },
      });
      if (showHidden) for (const a of hidden) items.push(app(a, true));
    }
  }
  if (!only || only === "system") {
    if (items.length) items.push("separator");
    items.push({
      label: "Everything you hear",
      icon: <AudioLines size={14} />,
      hint: sources.systemIncludesSaga ? "Saga too" : undefined,
      checked: current?.kind === "system",
      disabled: !sources.systemSupported,
      onSelect: set({ kind: "system" }),
    });
    if (!sources.systemSupported && sources.unsupported) items.push({ label: sources.unsupported, disabled: true });
  }
  if (only !== "system") {
    items.push("separator", {
      label: "Look again",
      icon: <RefreshCw size={14} />,
      keepOpen: true,
      onSelect: () => void useRecord.getState().loadSources().then(() => useMenu.getState().refresh()),
    });
  }
  return items;
}

/** Opens the source menu under `el`. The list shown is refreshed while it's open, since apps come and go. */
export function openSourceMenu(el: HTMLElement, only?: SourceKind) {
  const record = useRecord.getState();
  // "Everything you hear" needs no choosing beyond itself.
  if (only === "system" && record.sources?.systemSupported) {
    record.setSource({ kind: "system" });
    return;
  }
  // Hidden starts open when the app being recorded is one of them, so its tick shows.
  const current = usePrefs.getState().recordSource;
  showHidden = current?.kind === "app" && usePrefs.getState().recordHiddenApps.includes(current.name);
  openMenuBelow(el, () => sourceItems(useRecord.getState().sources, only));
  void record.loadSources().then((sources) => {
    if (only === "system" && sources?.systemSupported) {
      useMenu.getState().close();
      useRecord.getState().setSource({ kind: "system" });
    } else {
      useMenu.getState().refresh();
    }
  });
}

/** The source's second line: channels and rate, whether an app is playing, what everything means. */
function sourceDetail(source: RecordSource, sources: RecordSources | null): string {
  if (source.kind === "system") return sources?.systemIncludesSaga ? "Everything, Saga's sounds too" : "Everything except Saga";
  if (source.kind === "app") {
    const app = sources?.apps.find((a) => a.pid === source.pid);
    return app ? (app.playing ? "Playing now" : "Quiet right now") : "Not open";
  }
  const d = sources?.inputs.find((i) => i.name === source.device);
  if (!d) return sources ? "Not connected" : "";
  const channels = source.channels.length ? source.channels : d.channels === 1 ? [0] : [0, 1];
  const parts = [d.channels > 2 ? channelsLabel(channels) : channels.length === 1 ? "Mono" : "Stereo", fmtRate(d.sampleRate)];
  return parts.filter(Boolean).join(" · ");
}

export function SourceIcon({ source, size = 16 }: { source: RecordSource | null; size?: number }) {
  const sources = useRecord((s) => s.sources);
  if (source?.kind === "app") {
    const app = sources?.apps.find((a) => a.pid === source.pid);
    if (app) return appIcon(app, size);
    return <AppWindow size={size} strokeWidth={1.75} />;
  }
  if (source?.kind === "system") return <AudioLines size={size} strokeWidth={1.75} />;
  return <Mic size={size} strokeWidth={1.75} />;
}

/** The source, as one button that opens the menu of everything that can be recorded. */
export function SourceButton({ compact }: { compact?: boolean }) {
  const source = usePrefs((s) => s.recordSource);
  const sources = useRecord((s) => s.sources);
  // Changing the source would reopen the device under a take that is being recorded.
  const recording = useRecord((s) => s.phase === "recording");
  const name = source ? (source.kind === "app" ? source.name : source.kind === "system" ? "Everything you hear" : source.device || "Default input") : "Choose what to record";
  const detail = source ? sourceDetail(source, sources) : "";
  if (compact) {
    return (
      <button
        type="button"
        aria-label={`Recording from ${name}. Change`}
        title={recording ? "The source can change after this take" : detail ? `${name} · ${detail}` : name}
        disabled={recording}
        onClick={(e) => openSourceMenu(e.currentTarget)}
        className="flex h-7 max-w-[150px] min-w-0 items-center gap-1.5 rounded-md border border-line2 bg-raised pr-1.5 pl-2 text-small text-text2 hover:bg-raised2 hover:text-text disabled:opacity-45 disabled:hover:bg-raised disabled:hover:text-text2"
      >
        <span className="grid shrink-0 place-items-center text-text2">
          <SourceIcon source={source} size={13} />
        </span>
        <span className="min-w-0 truncate">{name}</span>
        <ChevronDown size={12} className="shrink-0 text-text3" />
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-label={`Recording from ${name}${detail ? `, ${detail}` : ""}. Change`}
      title={recording ? "The source can change after this take" : undefined}
      disabled={recording}
      onClick={(e) => openSourceMenu(e.currentTarget)}
      className="flex h-12 w-full min-w-0 items-center gap-3 rounded-xl border border-line2 bg-raised pr-2.5 pl-2.5 text-left hover:bg-raised2 disabled:opacity-45 disabled:hover:bg-raised"
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-panel text-text2">
        <SourceIcon source={source} size={source?.kind === "app" ? 20 : 16} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-ui font-medium">{name}</span>
        {detail && <span className="truncate font-mono text-micro text-text3">{detail}</span>}
      </span>
      <ChevronDown size={14} className="shrink-0 text-text3" />
    </button>
  );
}

/**
 * The round Record button: a dot in a ring to arm, a breathing red ring while a take waits for its first sound, and a
 * solid red dot (with a stop square) while it records.
 */
export function RecordButton({ size = 48 }: { size?: number }) {
  const phase = useRecord((s) => s.phase);
  const startOnSound = usePrefs((s) => s.recordStartOnSound);
  const hasSource = usePrefs((s) => s.recordSource != null);
  const label =
    phase === "recording" ? "Stop and keep the take (R)" : phase === "armed" ? "Record now, without waiting (R)" : startOnSound ? "Arm: record from the first sound (R)" : "Record (R)";
  const press = () => {
    const r = useRecord.getState();
    if (phase === "recording") void r.stop();
    else if (phase === "armed") r.recordNow();
    else if (phase === "idle") void r.arm();
  };
  const dot = Math.round(size * 0.36);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={phase === "opening" || !hasSource}
      onClick={press}
      className={cx(
        // Switches at once, like a DAW's record button: the state has to be readable at a glance.
        "grid shrink-0 place-items-center rounded-full disabled:opacity-45",
        phase === "recording" ? "bg-rec" : phase === "armed" ? "animate-rec-breathe border-2 border-rec bg-rec-soft" : "border-2 border-line2 bg-raised hover:border-text3",
      )}
      style={{ width: size, height: size }}
    >
      {phase === "recording" ? (
        <span className="block rounded-[3px] bg-on-rec" style={{ width: dot * 0.8, height: dot * 0.8 }} />
      ) : (
        <span className={cx("block rounded-full", phase === "armed" ? "border-2 border-rec" : "bg-rec")} style={{ width: dot, height: dot }} />
      )}
    </button>
  );
}

const STOP_AFTER: { value: string; label: string; title: string }[] = [
  { value: "off", label: "Off", title: "Takes keep recording until you stop them" },
  { value: "1", label: "1 s", title: "A second of silence ends a take" },
  { value: "2", label: "2 s", title: "Two seconds of silence end a take" },
  { value: "4", label: "4 s", title: "Four seconds of silence end a take" },
];

/** How takes start and end: on the first sound, after silence, and one after another. */
export function TakeOptionsControls() {
  const startOnSound = usePrefs((s) => s.recordStartOnSound);
  const stopAfter = usePrefs((s) => s.recordStopAfter);
  const keepGoing = usePrefs((s) => s.recordKeepGoing);
  // Start on sound only decides how a take begins. Stop after, Threshold and Keep going also shape the take that is
  // running, so they stay live.
  const recording = useRecord((s) => s.phase === "recording");
  const set = (patch: Parameters<ReturnType<typeof usePrefs.getState>["set"]>[0]) => {
    usePrefs.getState().set(patch);
    useRecord.getState().optionsChanged();
  };
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <ThresholdField />
      <Switch
        size="sm"
        label="Start on sound"
        checked={startOnSound}
        disabled={recording}
        title={recording ? "This take has already started" : undefined}
        onChange={(v) => set({ recordStartOnSound: v })}
        className="w-full"
      />
      <div className="flex items-center justify-between gap-2" title="Seconds of silence that end a take">
        <span className="text-ui text-text2">Stop after</span>
        <Segmented
          size="sm"
          label="Stop after silence"
          value={stopAfter == null ? "off" : String(stopAfter)}
          options={STOP_AFTER}
          onChange={(v) => set({ recordStopAfter: v === "off" ? null : Number(v) })}
        />
      </div>
      <span title="After each take, Saga arms again, so every sound becomes its own take" className="block">
        <Switch size="sm" label="Keep going" checked={keepGoing} onChange={(v) => set({ recordKeepGoing: v })} className="w-full" />
      </span>
    </div>
  );
}

/**
 * The level that starts a take (and that silence falls below), as a number: Auto follows the source's noise floor and
 * shows where that is, and typing a level, or ↑ ↓ (⇧ for 6 dB), sets it by hand. It moves with the stage's line.
 */
function ThresholdField() {
  const { level, manual } = useThreshold();
  const open = useRecord((s) => s.phase !== "idle");
  // It only does something while a take waits for a sound or ends on silence.
  const listening = usePrefs((s) => s.recordStartOnSound || s.recordStopAfter != null);
  const [draft, setDraft] = useState<string | null>(null);
  const db = Math.round(20 * Math.log10(Math.max(level, 1e-6)));
  // Auto's level is only known while a source is open.
  const shown = manual || open ? String(db) : "";
  const commit = () => {
    if (draft == null) return;
    const text = draft.trim().replace("−", "-").replace(",", ".");
    setDraft(null);
    if (!text || /^auto$/i.test(text)) return setThresholdDb(null);
    const v = Number(text);
    // Levels are always below full scale, so "40" means -40 dB.
    if (Number.isFinite(v)) setThresholdDb(-Math.abs(v));
  };
  const segment = "flex h-[22px] items-center rounded-md text-small transition-colors";
  return (
    <div
      className={cx("flex items-center justify-between gap-2", !listening && "opacity-45")}
      title={
        listening
          ? "A sound louder than this starts a take, and quieter than this counts as silence"
          : "Turn on Start on sound or Stop after to use a threshold"
      }
    >
      <span className="text-ui text-text2">Threshold</span>
      <div role="group" aria-label="Threshold" className="flex shrink-0 gap-0.5 rounded-lg bg-raised p-[3px]">
        <button
          type="button"
          aria-pressed={!manual}
          title="Follow the source's noise floor"
          onClick={() => setThresholdDb(manual ? null : db)}
          className={cx(segment, "px-2 font-medium", manual ? "text-text2 hover:text-text" : "bg-seg text-text shadow-[0_1px_2px_rgba(0,0,0,0.12)]")}
        >
          Auto
        </button>
        <label
          className={cx(
            segment,
            "gap-1 pr-2 pl-1.5 focus-within:ring-1 focus-within:ring-accent",
            manual ? "bg-seg shadow-[0_1px_2px_rgba(0,0,0,0.12)]" : "hover:bg-raised2",
          )}
        >
          <input
            aria-label="Threshold in dB"
            inputMode="decimal"
            spellCheck={false}
            placeholder="–"
            value={draft ?? shown}
            onFocus={(e) => {
              setDraft(shown);
              requestAnimationFrame(() => e.target.select());
            }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                e.stopPropagation();
                setDraft(null);
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                const by = (e.shiftKey ? 6 : 1) * (e.key === "ArrowUp" ? 1 : -1);
                const typed = Number((draft ?? "").replace("−", "-"));
                const from = draft != null && draft.trim() && Number.isFinite(typed) ? -Math.abs(typed) : db;
                setThresholdDb(from + by);
                setDraft(String(Math.round(Math.min(THRESHOLD_MAX_DB, Math.max(THRESHOLD_MIN_DB, from + by)))));
              }
            }}
            className={cx(
              "w-[26px] bg-transparent text-right font-mono tabular outline-none placeholder:text-text3",
              manual ? "text-text" : "text-text3",
            )}
          />
          <span className={cx("font-mono text-micro", manual ? "text-text2" : "text-text3")}>dB</span>
        </label>
      </div>
    </div>
  );
}
