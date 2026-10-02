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

export type ValueSource = "name" | "metadata" | "audio";

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
  favorites?: boolean;
  collectionId?: number | null;
  sourceId?: number | null;
  dir?: string | null;
  recent?: "added" | "played" | null;
}

/** "fit": how well each sample's notes fit the key filter's scale, best first (see `scaleFit`). */
export type SortKey = "relevance" | "name" | "added" | "played" | "duration" | "bpm" | "key" | "fit" | "random";

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
