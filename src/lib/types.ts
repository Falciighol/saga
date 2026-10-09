// Mirrors src-tauri/src/model.rs.

export interface SourceInfo {
  id: number;
  path: string;
  name: string;
  online: boolean;
  count: number;
  /** Subfolders left out of the library, relative to `path` and `/`-separated. */
  excluded: string[];
}

/** A folder inside one that's about to be added. */
export interface Subfolder {
  name: string;
  hasChildren: boolean;
}

/** A folder that can be added to the library, with the folders directly inside it. */
export interface FolderCandidate {
  path: string;
  name: string;
  subfolders: Subfolder[];
}

export interface DirNode {
  name: string;
  dir: string;
  count: number;
  hasChildren: boolean;
}

export type Kind = "loop" | "oneshot";

/** "user": set by hand in Saga, which beats everything else. */
export type ValueSource = "name" | "metadata" | "audio" | "user";

export interface SampleRow {
  id: number;
  sourceId: number;
  path: string;
  name: string;
  ext: string;
  dir: string;
  pack: string;
  duration: number | null;
  sampleRate: number | null;
  channels: number | null;
  bitDepth: number | null;
  bpm: number | null;
  /** "audio" means detected from the sound, so an estimate. */
  bpmSource: ValueSource | null;
  key: string | null;
  keySource: ValueSource | null;
  keyPc: number | null;
  keyMode: number | null;
  camelot: string | null;
  kind: Kind;
  category: string | null;
  tags: string[];
  userTags: string[];
  peakDb: number | null;
  loudness: number | null;
  /** Base64 of the 512-byte waveform envelope. */
  peaks: string | null;
  /** 0 pending analysis, 1 analyzed, 2 failed. */
  status: number;
  favorite: boolean;
  online: boolean;
  playCount: number;
  /** When the file was created, in seconds since 1970 (its last change where the drive doesn't
   *  keep a created time); null until a scan has read it. */
  created: number | null;
  /** When Saga first indexed it, in seconds since 1970. */
  added: number;
}

/** A tempo set by hand, or back to what Saga found. Mirrors `TempoChange` in model.rs. */
export type TempoChange = { to: "bpm"; bpm: number } | { to: "noTempo" } | { to: "detected" };

/** A key set by hand (mode 0 major, 1 minor, 2 a single note), or back to what Saga found. Mirrors `KeyChange` in model.rs. */
export type KeyChange = { to: "key"; pc: number; mode: 0 | 1 | 2 } | { to: "noKey" } | { to: "detected" };

export interface FileDates {
  id: number;
  /** Seconds since 1970 (the modified time where the drive keeps no created time). */
  created: number | null;
  modified: number | null;
}

export interface RenameOutcome {
  id: number;
  /** The name before, to undo with. */
  from: string;
  to: string;
  /** Why it wasn't renamed; null when it was. */
  error: string | null;
}

export interface KeyFilter {
  pc: number;
  /** 0 major, 1 minor. */
  mode: 0 | 1;
  compatible: boolean;
  includeUnpitched: boolean;
  rootInScale: boolean;
  /** A Lab scale as semitones above `pc`: compatible keys become keys that share its notes, and one-shot roots are checked against it. */
  scale?: number[] | null;
  /** Samples with no key pass when the notes in their stored pitch profile fit the scale (moot while `includeUnpitched` keeps them all). */
  byNotes?: boolean;
}

export interface Filters {
  text?: string;
  kind?: Kind | null;
  categories?: string[];
  bpmMin?: number | null;
  bpmMax?: number | null;
  halfDouble?: boolean;
  key?: KeyFilter | null;
  durMin?: number | null;
  durMax?: number | null;
  formats?: string[];
  channels?: 1 | 2 | null;
  sampleRates?: number[];
  tags?: string[];
  excludeTags?: string[];
  /** Files created at or after this time, in seconds since 1970. */
  createdFrom?: number | null;
  /** Files created before this time (the end of the range, not included). */
  createdTo?: number | null;
  favorites?: boolean;
  collectionId?: number | null;
  sourceId?: number | null;
  dir?: string | null;
  recent?: "added" | "played" | null;
}

/** "fit": how well each sample's notes fit the key filter's scale, best first (see `scaleFit`). */
export type SortKey = "relevance" | "name" | "added" | "created" | "played" | "duration" | "bpm" | "key" | "fit" | "random";

export interface QueryRequest {
  filters: Filters;
  sort: SortKey;
  desc: boolean;
  offset: number;
  limit: number;
  seed: number;
}

export interface QueryResult {
  total: number;
  offset: number;
  rows: SampleRow[];
}

export interface Facets {
  total: number;
  loops: number;
  oneshots: number;
  categories: [string, number][];
  bpmHist: number[];
  durHist: number[];
  keys: number[];
  tags: [string, number][];
}

export const BPM_HIST_MIN = 40;
export const BPM_HIST_STEP = 2.5;
export const BPM_HIST_BINS = 72;
export const DUR_HIST_MIN = 0.05;
export const DUR_HIST_MAX = 120;
export const DUR_HIST_BINS = 48;

export interface LibraryStats {
  total: number;
  favorites: number;
  loops: number;
  oneshots: number;
  recentlyAdded: number;
  played: number;
}

export interface Collection {
  id: number;
  name: string;
  color: string;
  count: number;
}

export interface IndexProgress {
  scanning: boolean;
  found: number;
  done: number;
  total: number;
  watching: number;
  /** Everything left is already-indexed files being described for Find similar. */
  refreshing: boolean;
}

export interface PlaybackEvent {
  id: number | null;
  state: "playing" | "paused" | "stopped" | "ended" | "error";
  /** Seconds along the playback timeline (the region, reversed when reversing). */
  timeline: number;
  /** Length of the timeline in seconds of the original. */
  length: number;
  /** Seconds of the original per second heard. */
  rate: number;
  reverse: boolean;
  regionStart: number;
  regionEnd: number;
  looping: boolean;
  message: string | null;
}

export interface WaveformDetail {
  /** Base64 peaks per channel. */
  channels: string[];
  duration: number;
}

/** Where renders, Lab clips and saved variations go. */
export interface SavedSounds {
  path: string;
  /** Still the default, ~/Music/Saga. */
  isDefault: boolean;
}

export interface FileCount {
  files: number;
  bytes: number;
}

/** How much space renders take. */
export interface RendersUsage {
  /** The Renders folder in the saved sounds folder. */
  path: string;
  all: FileCount;
  olderThanWeek: FileCount;
  olderThanMonth: FileCount;
  /** Renders made ahead of time, which Saga clears on its own. */
  scratch: FileCount;
}

export interface ClearedRenders {
  cleared: FileCount;
  /** Files the Trash wouldn't take. */
  failed: number;
  usage: RendersUsage;
}

export interface SuggestedFolder {
  path: string;
  label: string;
}

/** What Find similar compares. */
export type Aspect = "overall" | "timbre" | "pitch" | "envelope";

export interface SimilarItem {
  row: SampleRow;
  /** 1 for an identical sound, 0 for a typical unrelated pair. */
  score: number;
}

export interface SimilarResult {
  target: SampleRow | null;
  items: SimilarItem[];
  /** Samples with a sound description. */
  described: number;
  /** Samples still waiting for one. */
  pending: number;
  message: string | null;
}

export interface MapLabel {
  group: number;
  x: number;
  y: number;
  count: number;
}

export interface MapLayout {
  key: string;
  count: number;
  /** Base64, 12 bytes per point: id (i32), x and y (u16), group, brightness, level (u8), spare. */
  points: string;
  labels: MapLabel[];
  described: number;
  pending: number;
}

export interface MapMatches {
  /** Base64 bitset over the layout's points, or null when every point matches. */
  bits: string | null;
  matched: number;
}

/** What a sample's stored description says about its notes. Mirrors `PitchProfile` in model.rs. */
export interface PitchProfile {
  /** Share of the pitched energy on each note, C first; all zero when nothing tonal was found. */
  chroma: number[];
  /** 0 for an even spread over the twelve notes, 1 for a single note. */
  tonality: number;
  /** The fundamental of a clearly pitched sound, in Hz. */
  hz: number | null;
  /** 0–1: how clearly periodic the sound is. */
  clarity: number;
}

export interface RecordLevel {
  level: number;
  seconds: number;
  done: boolean;
}

export interface InstalledFont {
  family: string;
  /** Every face in the family is fixed-width. */
  mono: boolean;
}

// ---- the Record panel. Mirrors capture.rs, takes.rs and RecordSettings in commands.rs. ----

/** What to record. Mirrors `SourceSpec` in capture.rs. */
export type RecordSource =
  /** An input device; `channels` picks one channel or a pair (0-based). Empty means the first one or two. */
  | { kind: "input"; device: string; channels: number[] }
  /** One app's sound, with whatever it starts. */
  | { kind: "app"; pid: number; name: string }
  /** Everything the computer plays, except Saga. */
  | { kind: "system" };

/** Mirrors `TakeOptions` in capture.rs. */
export interface TakeOptions {
  /** Wait for the first sound; otherwise the take starts at once. */
  startOnSound: boolean;
  /** Seconds of silence that end a take; null never ends one. */
  stopAfter: number | null;
  /** Arm again after each take, so every sound becomes its own take. */
  keepGoing: boolean;
  /** The level that starts a take, in dBFS; null follows the noise floor. */
  thresholdDb: number | null;
  /** Minutes to add to UTC for the local time in take names (minus `getTimezoneOffset`). */
  utcOffset: number;
}

export type CaptureState = "idle" | "armed" | "recording";

/** The live state, about 30 times a second while armed or recording. Mirrors `TakeStatus` in capture.rs. */
export interface TakeStatus {
  state: CaptureState;
  /** The source's name, as the panel shows it. */
  source: string;
  /** Seconds recorded in this take so far. */
  seconds: number;
  /** Peak of the newest audio, 0–1. */
  level: number;
  /** Waveform bars (peaks, 0–1) since the last status, one per 25 ms. */
  bars: number[];
  /** The level that starts a take, 0–1. */
  threshold: number;
  /** The source's noise floor, 0–1. */
  floor: number;
  /** Seconds of silence at the end of the take so far. */
  silentFor: number;
  /** Something in this take reached full scale. */
  clipped: boolean;
  /** Takes made since arming. */
  takes: number;
  /** An app source has been completely silent since it was armed. */
  nothingYet: boolean;
}

/** What's in the way of recording. Mirrors `Problem` in capture.rs. */
export interface RecordProblem {
  message: string;
  /** The privacy setting that would let Saga record, when that's what's in the way. */
  settings: "microphone" | "systemAudio" | null;
}

/** Mirrors `TakeNotice` in capture.rs. */
export interface TakeNotice {
  message: string;
  tone: "info" | "error";
  settings: "microphone" | "systemAudio" | null;
}

/** A take was stored and is being analyzed. Mirrors `TakeLanded` in capture.rs. */
export interface TakeLanded {
  id: number;
  recovered: boolean;
}

/** Mirrors `InputDevice` in capture.rs. */
export interface InputDevice {
  name: string;
  channels: number;
  sampleRate: number;
  isDefault: boolean;
}

/** Mirrors `AppSource` in capture.rs. */
export interface AppSource {
  pid: number;
  name: string;
  /** The app's icon as a PNG data URL. */
  icon: string | null;
  /** Making sound right now. */
  playing: boolean;
}

/** Everything that can be recorded on this computer. Mirrors `RecordSources` in capture.rs. */
export interface RecordSources {
  inputs: InputDevice[];
  apps: AppSource[];
  /** One app can be recorded on its own. */
  appsSupported: boolean;
  /** Everything you hear can be recorded. */
  systemSupported: boolean;
  /** Everything you hear includes Saga's own sounds here (Windows before version 2004). */
  systemIncludesSaga: boolean;
  /** Why apps or everything you hear can't be recorded on this computer, when they can't. */
  unsupported: string | null;
}

/** Mirrors `TakeList` in takes.rs. */
export interface TakeList {
  /** Samples from this source are unsaved takes. */
  sourceId: number;
  /** Unsaved takes, newest first. */
  rows: SampleRow[];
  /** Space they take on disk. */
  bytes: number;
}

export type TakeFormat = "24" | "float";
export type TakesRetention = "keep" | "week" | "quit";

/** Settings › Recording. Mirrors `RecordSettings` in commands.rs. */
export interface RecordSettings {
  format: TakeFormat;
  /** What happens to unsaved takes. */
  retention: TakesRetention;
  /** The shortcut that arms, records and stops from anywhere, as Tauri spells it; null when unset. */
  shortcut: string | null;
  /** Where saved takes go. */
  recordings: string;
}
