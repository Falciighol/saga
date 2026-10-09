// Dev-only stand-in for recording (capture.rs, takes.rs), so the Record panel can be worked on in a plain browser.
// A pretend source plays a loop (apps and everything you hear) or hits (inputs) a second after arming, so start on
// sound, stop after silence and keep going all have something to react to. Never bundled into the app.

import { emit } from "@tauri-apps/api/event";
import type { AppSource, InputDevice, RecordSettings, RecordSource, SampleRow, TakeOptions, TakeStatus } from "../lib/types";

/** Samples from this source are unsaved takes. */
export const TAKES_SOURCE = 99;
/** Unsaved takes, newest first. */
export const TAKES: SampleRow[] = [];
let nextId = 100_000;

const INPUTS: InputDevice[] = [
  { name: "MacBook Pro Microphone", channels: 1, sampleRate: 48_000, isDefault: true },
  { name: "Scarlett 18i8 USB", channels: 8, sampleRate: 48_000, isDefault: false },
];

function icon(color: string, letter: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="${color}"/><text x="16" y="22" font-family="sans-serif" font-size="17" font-weight="700" text-anchor="middle" fill="white">${letter}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const APPS: AppSource[] = [
  { pid: 4120, name: "Google Chrome", icon: icon("#3B78E7", "C"), playing: true },
  { pid: 512, name: "Spotify", icon: icon("#1AA34A", "S"), playing: false },
  // Picking it shows what the panel says when an app hasn't played anything yet.
  { pid: 733, name: "Serum", icon: icon("#5B47D6", "S"), playing: false },
  // Apps that hold an audio connection without ever playing, as macOS lists them: enough to need hiding and scrolling.
  { pid: 901, name: "Messages", icon: icon("#34C759", "M"), playing: false },
  { pid: 902, name: "Slack", icon: icon("#4A154B", "S"), playing: false },
  { pid: 903, name: "Discord", icon: icon("#5865F2", "D"), playing: false },
  { pid: 904, name: "zoom.us", icon: icon("#2D8CFF", "Z"), playing: false },
  { pid: 905, name: "Safari", icon: icon("#1E88E5", "S"), playing: false },
  { pid: 906, name: "Mail", icon: icon("#3C8CE7", "M"), playing: false },
  { pid: 907, name: "FaceTime", icon: icon("#30B94D", "F"), playing: false },
  { pid: 908, name: "Notion", icon: icon("#37352F", "N"), playing: false },
  { pid: 909, name: "Ableton Live 12 Suite", icon: icon("#111111", "A"), playing: false },
  { pid: 910, name: "Splice", icon: icon("#2F2F2F", "S"), playing: false },
];

let settings: RecordSettings = { format: "24", retention: "keep", shortcut: null, recordings: "/Users/me/Music/Saga/Recordings" };

const BAR = 0.025;
const MAX_SECONDS = 15 * 60;

interface Session {
  source: RecordSource;
  name: string;
  options: TakeOptions;
  armedAt: number;
  /** Seconds since arming already turned into bars. */
  done: number;
  recording: boolean;
  takeBars: number[];
  silentFor: number;
  floor: number;
  recent: number[];
  takes: number;
  timer: number;
}

let session: Session | null = null;

/** What the pretend source plays, `t` seconds after arming. */
function level(s: Session, t: number): number {
  const noise = 0.0025 + Math.random() * 0.0025;
  const at = t - 1.1;
  if (at < 0) return noise;
  if (s.source.kind === "input") {
    // A hit every 1.6 s, five of them.
    const hit = Math.floor(at / 1.6);
    const into = at - hit * 1.6;
    return hit < 5 && into < 0.7 ? Math.max(noise, 0.75 * Math.exp(-into * 7) * (0.8 + Math.random() * 0.2)) : noise;
  }
  // A 124 BPM loop for four seconds: kicks on the beat over a pad.
  if (at > 3.87) return noise;
  const beat = (at % (60 / 124)) / (60 / 124);
  return Math.min(1, 0.18 + 0.05 * Math.sin(at * 9) + 0.6 * Math.exp(-beat * 9) + Math.random() * 0.04);
}

function threshold(s: Session): number {
  if (s.options.thresholdDb != null) return 10 ** (s.options.thresholdDb / 20);
  return Math.min(0.25, Math.max(0.001, s.floor * 4));
}

function sourceName(source: RecordSource): string {
  if (source.kind === "app") return source.name;
  if (source.kind === "system") return "Desktop audio";
  const short = source.device.replace(/ USB$/, "");
  return source.channels.length && source.device.startsWith("Scarlett") ? `${short} In ${source.channels.map((c) => c + 1).join("+")}` : short;
}

function status(s: Session | null, bars: number[], state: TakeStatus["state"]): TakeStatus {
  return {
    state,
    source: s?.name ?? "",
    seconds: s && s.recording ? s.takeBars.length * BAR : 0,
    level: bars.length ? bars[bars.length - 1] : 0,
    bars,
    threshold: s ? threshold(s) : 0.004,
    floor: s?.floor ?? 0,
    silentFor: s?.silentFor ?? 0,
    clipped: false,
    takes: s?.takes ?? 0,
    nothingYet: false,
  };
}

/** 512 envelope bytes from the take's bars, like the analysis stores. */
function peaksOf(bars: number[]): string {
  const out = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    const a = Math.floor((i * bars.length) / 512);
    const b = Math.max(a + 1, Math.floor(((i + 1) * bars.length) / 512));
    let m = 0;
    for (let j = a; j < b && j < bars.length; j++) m = Math.max(m, bars[j]);
    out[i] = Math.round(Math.min(1, m) * 255);
  }
  let str = "";
  for (const x of out) str += String.fromCharCode(x);
  return btoa(str);
}

function timeName(offset: number): string {
  const now = Math.floor(Date.now() / 1000) + offset * 60;
  const d = ((now % 86_400) + 86_400) % 86_400;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(d / 3600))}.${p(Math.floor(d / 60) % 60)}.${p(d % 60)}`;
}

function startTake(s: Session) {
  s.recording = true;
  s.silentFor = 0;
  // The half second held while armed begins the take.
  s.takeBars = s.recent.slice(-20);
}

function finishTake(s: Session, rearm: boolean) {
  if (!s.recording) return;
  s.recording = false;
  // Trimmed to the sound, as the real thing does.
  const t = threshold(s);
  const first = Math.max(0, s.takeBars.findIndex((b) => b > t) - 1);
  let last = s.takeBars.length - 1;
  while (last > first && s.takeBars[last] <= t / 2) last--;
  const bars = s.takeBars.slice(first, last + 2);
  s.takeBars = [];
  if (!bars.some((b) => b > t)) {
    void emit("take-notice", { message: `Only silence came through from ${s.name}. Some apps block recording.`, tone: "error", settings: null });
    return;
  }
  s.takes++;
  const id = nextId++;
  const name = `${s.name} ${timeName(s.options.utcOffset)}`;
  const duration = bars.length * BAR;
  const loop = s.source.kind !== "input" && duration > 2;
  const now = Math.floor(Date.now() / 1000);
  const row: SampleRow = {
    id,
    sourceId: TAKES_SOURCE,
    path: `/Users/me/Library/Application Support/saga/Takes/${name}.wav`,
    name,
    ext: "wav",
    dir: "",
    pack: "Takes",
    duration,
    sampleRate: 48_000,
    channels: s.source.kind === "input" && s.source.channels.length !== 2 ? 1 : 2,
    bitDepth: settings.format === "float" ? 32 : 24,
    bpm: null,
    bpmSource: null,
    key: null,
    keySource: null,
    keyPc: null,
    keyMode: null,
    camelot: null,
    kind: loop ? "loop" : "oneshot",
    category: null,
    tags: [],
    userTags: [],
    peakDb: -1.2,
    loudness: -11,
    peaks: peaksOf(bars),
    status: 0,
    favorite: false,
    online: true,
    playCount: 0,
    created: now,
    added: now,
  };
  TAKES.unshift(row);
  void emit("take-landed", { id, recovered: false });
  // Analysis ahead of the queue takes a moment.
  setTimeout(() => {
    Object.assign(row, loop
      ? { status: 1, bpm: 123.9, bpmSource: "audio", key: "Am", keySource: "audio", keyPc: 9, keyMode: 1, camelot: "8A", category: "Synth" }
      : { status: 1, key: "F#", keySource: "audio", keyPc: 6, keyMode: 2, category: "Perc" });
    void emit("library-changed");
  }, 1100);
  if (!rearm) closeSession();
}

function tick() {
  const s = session;
  if (!s) return;
  const now = (performance.now() - s.armedAt) / 1000;
  const bars: number[] = [];
  while (s.done + BAR <= now) {
    s.done += BAR;
    const v = level(s, s.done);
    bars.push(v);
    if (!s.recording) {
      s.recent.push(v);
      if (s.recent.length > 80) s.recent.shift();
      const sorted = [...s.recent].sort((a, b) => a - b);
      s.floor = sorted[Math.floor(sorted.length / 5)] ?? 0;
      if (s.options.startOnSound && s.recent.length > 8 && v > threshold(s)) startTake(s);
    } else {
      s.takeBars.push(v);
      s.silentFor = v > threshold(s) ? 0 : s.silentFor + BAR;
      if (s.options.stopAfter != null && s.silentFor >= s.options.stopAfter) {
        finishTake(s, s.options.keepGoing);
        if (!session) break;
      } else if (s.takeBars.length * BAR >= MAX_SECONDS) {
        finishTake(s, false);
        break;
      }
    }
  }
  if (session) void emit("take-status", status(session, bars, session.recording ? "recording" : "armed"));
}

function closeSession() {
  if (!session) return;
  window.clearInterval(session.timer);
  const s = session;
  session = null;
  void emit("take-status", status(s, [], "idle"));
}

function unsavedBytes(): number {
  return TAKES.reduce((a, r) => a + Math.round((r.duration ?? 0) * 48_000 * (r.channels ?? 2) * 3), 0);
}

/** Answers the recording commands; `undefined` for anything else. `toLibrary` puts a saved take in Recordings. */
export function mockRecord(cmd: string, args: Record<string, unknown>, toLibrary: (row: SampleRow) => void, fromLibrary: (ids: number[]) => number): unknown {
  switch (cmd) {
    case "record_sources":
      return { inputs: INPUTS, apps: APPS, appsSupported: true, systemSupported: true, systemIncludesSaga: false, unsupported: null };
    case "arm_take": {
      const source = args.source as RecordSource;
      const options = args.options as TakeOptions;
      if (session && JSON.stringify(session.source) === JSON.stringify(source)) {
        session.options = options;
        return null;
      }
      if (session) {
        finishTake(session, false);
        closeSession();
      }
      if (source.kind === "app" && source.pid === 733) return { message: "Serum hasn't played any sound yet. Play something in it, then try again.", settings: null };
      if (source.kind === "input" && !INPUTS.some((d) => d.name === source.device)) return { message: `${source.device} isn't connected.`, settings: null };
      const s: Session = { source, name: sourceName(source), options, armedAt: performance.now(), done: 0, recording: false, takeBars: [], silentFor: 0, floor: 0.004, recent: [], takes: 0, timer: 0 };
      session = s;
      s.timer = window.setInterval(tick, 33);
      if (!options.startOnSound) startTake(s);
      return null;
    }
    case "set_take_options":
      if (session) {
        const was = session.options.startOnSound;
        session.options = args.options as TakeOptions;
        if (was && !session.options.startOnSound && !session.recording) startTake(session);
      }
      return null;
    case "record_take_now":
      if (session && !session.recording) startTake(session);
      return null;
    case "stop_take":
      if (session) {
        finishTake(session, false);
        closeSession();
      }
      return null;
    case "list_takes":
      return { sourceId: TAKES_SOURCE, rows: TAKES.map((r) => ({ ...r })), bytes: unsavedBytes() };
    case "save_take": {
      const i = TAKES.findIndex((r) => r.id === args.id);
      if (i < 0) return undefined;
      const [row] = TAKES.splice(i, 1);
      Object.assign(row, { sourceId: 3, pack: "Recordings", path: `/Users/me/Music/Saga/Recordings/${row.name}.wav` });
      toLibrary(row);
      return { ...row };
    }
    case "trash_takes": {
      const ids = args.ids as number[];
      const before = TAKES.length;
      for (const id of ids) {
        const i = TAKES.findIndex((r) => r.id === id);
        if (i >= 0) TAKES.splice(i, 1);
      }
      return before - TAKES.length + fromLibrary(ids.filter((id) => id >= 100_000));
    }
    case "clear_unsaved_takes": {
      const n = TAKES.length;
      TAKES.length = 0;
      return n;
    }
    case "record_settings":
      return settings;
    case "set_record_settings":
      settings = { ...settings, ...(args.format ? { format: args.format as RecordSettings["format"] } : {}), ...(args.retention ? { retention: args.retention as RecordSettings["retention"] } : {}) };
      return settings;
    case "set_record_shortcut":
      settings = { ...settings, shortcut: (args.shortcut as string | null) ?? null };
      return settings;
    case "open_privacy_settings":
    case "quit_app":
      return null;
    default:
      return undefined;
  }
}
