import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Aspect,
  Collection,
  DirNode,
  Facets,
  Filters,
  IndexProgress,
  InstalledFont,
  Kind,
  LibraryStats,
  MapLayout,
  MapMatches,
  PitchProfile,
  PlaybackEvent,
  QueryRequest,
  QueryResult,
  RecordLevel,
  SampleRow,
  SimilarResult,
  SourceInfo,
  SuggestedFolder,
  WaveformDetail,
} from "./types";
import type { ProcessParams } from "./processing";

export type SynthPreset = "keys" | "pad" | "pluck";

/** Mirrors `NoteEvent` in src-tauri/src/synth.rs. */
export interface NoteEvent {
  /** MIDI note, 60 = middle C. */
  note: number;
  /** Seconds from now. */
  at?: number;
  /** Seconds held. */
  length: number;
  velocity?: number;
}

/** Mirrors `TransportEvent` in src-tauri/src/sequence.rs. */
export interface TransportEvent {
  playing: boolean;
  /** Beats since the progression started; negative while it waits for a loop's next bar. */
  beat: number;
  bpm: number;
}

/** Mirrors `Sequence` in src-tauri/src/sequence.rs; notes are timed in beats. */
export interface Sequence {
  notes: { note: number; start: number; length: number; velocity: number }[];
  beats: number;
  bpm: number;
  preset: SynthPreset;
}

export const api = {
  listSources: () => invoke<SourceInfo[]>("list_sources"),
  addSources: (paths: string[]) => invoke<number[]>("add_sources", { paths }),
  removeSource: (id: number) => invoke<void>("remove_source", { id }),
  rescanSource: (id: number) => invoke<void>("rescan_source", { id }),
  listDirs: (sourceId: number, dir: string) => invoke<DirNode[]>("list_dirs", { sourceId, dir }),

  query: (request: QueryRequest) => invoke<QueryResult>("query_samples", { request }),
  facets: (filters: Filters) => invoke<Facets>("get_facets", { filters }),
  sample: (id: number) => invoke<SampleRow | null>("get_sample", { id }),
  stats: () => invoke<LibraryStats>("library_stats"),
  progress: () => invoke<IndexProgress>("index_progress"),

  setFavorite: (ids: number[], favorite: boolean) => invoke<void>("set_favorite", { ids, favorite }),
  setUserTags: (id: number, tags: string[]) => invoke<SampleRow | null>("set_user_tags", { id, tags }),

  collections: () => invoke<Collection[]>("list_collections"),
  createCollection: (name: string, color: string) => invoke<number>("create_collection", { name, color }),
  updateCollection: (id: number, patch: { name?: string; color?: string }) =>
    invoke<void>("update_collection", { id, name: patch.name ?? null, color: patch.color ?? null }),
  deleteCollection: (id: number) => invoke<void>("delete_collection", { id }),
  addToCollection: (collectionId: number, ids: number[]) => invoke<void>("add_to_collection", { collectionId, ids }),
  removeFromCollection: (collectionId: number, ids: number[]) =>
    invoke<void>("remove_from_collection", { collectionId, ids }),
  sampleCollections: (id: number) => invoke<number[]>("sample_collections", { id }),
  idsForPaths: (paths: string[]) => invoke<number[]>("ids_for_paths", { paths }),

  /** `start`: seconds in the original file, or null for the start of the (possibly reversed) region. */
  play: (id: number, start: number | null, looping: boolean, params: ProcessParams) =>
    invoke<void>("play", { id, start, looping, params }),
  setParams: (params: ProcessParams) => invoke<void>("set_params", { params }),
  setClick: (on: boolean) => invoke<void>("set_click", { on }),
  /** Lab notes, mixed over the preview on the chosen output device. */
  playNotes: (notes: NoteEvent[], preset: SynthPreset) => invoke<void>("play_notes", { notes, preset }),
  stopNotes: () => invoke<void>("stop_notes"),
  /** Loops a Lab progression, or updates the playing one in place. */
  playSequence: (sequence: Sequence) => invoke<void>("play_sequence", { sequence }),
  stopSequence: () => invoke<void>("stop_sequence"),
  /** Writes a progression as a MIDI clip for dragging out; returns its path. */
  saveMidi: (notes: Sequence["notes"], beats: number, bpm: number, name: string, label: string) =>
    invoke<string>("save_midi", { notes, beats, bpm, name, label }),
  renderSample: (id: number, params: ProcessParams, label: string) => invoke<string>("render_sample", { id, params, label }),
  exportSample: (id: number, params: ProcessParams, dest: string) => invoke<void>("export_sample", { id, params, dest }),
  saveVariation: (id: number, params: ProcessParams, label: string) => invoke<string>("save_variation", { id, params, label }),
  waveformDetail: (id: number, start: number, end: number, buckets: number) =>
    invoke<WaveformDetail>("waveform_detail", { id, start, end, buckets }),
  pause: () => invoke<void>("pause"),
  resume: () => invoke<void>("resume"),
  stop: () => invoke<void>("stop"),
  seek: (position: number) => invoke<void>("seek", { position }),
  setLoop: (looping: boolean) => invoke<void>("set_loop", { looping }),
  setVolume: (volume: number) => invoke<void>("set_volume", { volume }),
  outputDevices: () => invoke<{ devices: string[]; current: string | null }>("list_output_devices"),
  installedFonts: () => invoke<InstalledFont[]>("list_installed_fonts"),
  setOutputDevice: (name: string | null) => invoke<void>("set_output_device", { name }),

  dragIcon: () => invoke<string>("drag_icon"),
  suggestedFolders: () => invoke<SuggestedFolder[]>("suggested_folders"),

  /** The notes in a sample's stored description; null until it has one. */
  pitchProfile: (id: number) => invoke<PitchProfile | null>("pitch_profile", { id }),
  findSimilar: (id: number, aspect: Aspect, sourceId: number | null, limit = 40) =>
    invoke<SimilarResult>("find_similar", { id, aspect, sourceId, limit }),
  similarToFile: (path: string, aspect: Aspect, sourceId: number | null, limit = 40) =>
    invoke<SimilarResult>("similar_to_file", { path, aspect, sourceId, limit }),
  startRecording: () => invoke<void>("start_recording"),
  stopRecording: (aspect: Aspect, sourceId: number | null, limit = 40) =>
    invoke<SimilarResult>("stop_recording", { aspect, sourceId, limit }),
  cancelRecording: () => invoke<void>("cancel_recording"),
  similarToRecording: (aspect: Aspect, sourceId: number | null, limit = 40) =>
    invoke<SimilarResult>("similar_to_recording", { aspect, sourceId, limit }),
  soundMap: (kind: Kind | null, aspect: Aspect) => invoke<MapLayout>("sound_map", { kind, aspect }),
  mapMatches: (key: string, filters: Filters) => invoke<MapMatches>("map_matches", { key, filters }),
  setWindowMode: (mini: boolean, onTop: boolean) => invoke<void>("set_window_mode", { mini, onTop }),
  setUiScale: (scale: number) => invoke<void>("set_ui_scale", { scale }),
};

export const events = {
  onProgress: (cb: (p: IndexProgress) => void): Promise<UnlistenFn> =>
    listen<IndexProgress>("index-progress", (e) => cb(e.payload)),
  onLibraryChanged: (cb: () => void): Promise<UnlistenFn> => listen("library-changed", () => cb()),
  onPlayback: (cb: (e: PlaybackEvent) => void): Promise<UnlistenFn> =>
    listen<PlaybackEvent>("playback", (e) => cb(e.payload)),
  onRecordLevel: (cb: (e: RecordLevel) => void): Promise<UnlistenFn> =>
    listen<RecordLevel>("record-level", (e) => cb(e.payload)),
  onTransport: (cb: (e: TransportEvent) => void): Promise<UnlistenFn> =>
    listen<TransportEvent>("lab-transport", (e) => cb(e.payload)),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}
