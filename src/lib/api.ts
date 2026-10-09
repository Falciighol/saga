import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Aspect,
  Collection,
  DirNode,
  Facets,
  FileDates,
  FolderCandidate,
  Filters,
  IndexProgress,
  InstalledFont,
  KeyChange,
  Kind,
  LibraryStats,
  MapLayout,
  MapMatches,
  PitchProfile,
  PlaybackEvent,
  QueryRequest,
  QueryResult,
  ClearedRenders,
  RecordLevel,
  RecordProblem,
  RecordSettings,
  RecordSource,
  RecordSources,
  RendersUsage,
  RenameOutcome,
  SampleRow,
  SavedSounds,
  SimilarResult,
  SortKey,
  SourceInfo,
  Subfolder,
  SuggestedFolder,
  TakeLanded,
  TakeList,
  TakeNotice,
  TakeOptions,
  TakeStatus,
  TakeFormat,
  TakesRetention,
  TempoChange,
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
  /** `exclude`: subfolders to leave out, by the path they belong to (relative to it, `/`-separated). */
  addSources: (paths: string[], exclude: Record<string, string[]> = {}) => invoke<number[]>("add_sources", { paths, exclude }),
  /** The paths that are folders not yet in the library, each with its subfolders. */
  folderCandidates: (paths: string[]) => invoke<FolderCandidate[]>("folder_candidates", { paths }),
  listSubfolders: (path: string) => invoke<Subfolder[]>("list_subfolders", { path }),
  setDirExcluded: (sourceId: number, dir: string, excluded: boolean) => invoke<void>("set_dir_excluded", { sourceId, dir, excluded }),
  removeSource: (id: number) => invoke<void>("remove_source", { id }),
  rescanSource: (id: number) => invoke<void>("rescan_source", { id }),
  listDirs: (sourceId: number, dir: string) => invoke<DirNode[]>("list_dirs", { sourceId, dir }),

  query: (request: QueryRequest) => invoke<QueryResult>("query_samples", { request }),
  facets: (filters: Filters) => invoke<Facets>("get_facets", { filters }),
  sample: (id: number) => invoke<SampleRow | null>("get_sample", { id }),
  /** Rows for these ids, in the same order; ones no longer in the library are left out. */
  samples: (ids: number[]) => invoke<SampleRow[]>("get_samples", { ids }),
  /** Ids of every sample the filters match. */
  /** Ids of every sample the filters match; given the list's sort, in the order the list shows them. */
  queryIds: (filters: Filters, order?: { sort: SortKey; desc: boolean; seed: number }) => invoke<number[]>("query_ids", { filters, ...order }),
  stats: () => invoke<LibraryStats>("library_stats"),
  progress: () => invoke<IndexProgress>("index_progress"),

  setFavorite: (ids: number[], favorite: boolean) => invoke<void>("set_favorite", { ids, favorite }),
  setUserTags: (id: number, tags: string[]) => invoke<SampleRow | null>("set_user_tags", { id, tags }),
  /** Sets tempo and/or key by hand (or back to what Saga found); returns the samples as they are now. */
  setSampleValues: (ids: number[], change: { tempo?: TempoChange; key?: KeyChange }) =>
    invoke<SampleRow[]>("set_sample_values", { ids, tempo: change.tempo ?? null, key: change.key ?? null }),
  /** Folder names left out of every library folder. */
  excludedNames: () => invoke<string[]>("excluded_names"),
  setExcludedNames: (names: string[]) => invoke<string[]>("set_excluded_names", { names }),
  fileDates: (ids: number[]) => invoke<FileDates[]>("file_dates", { ids }),
  /** Renames sample files where they are; `name` has no extension. */
  renameSamples: (renames: { id: number; name: string }[]) => invoke<RenameOutcome[]>("rename_samples", { renames }),

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
  /** A render of the processed sample. Made ahead of time it waits in Saga's cache; `keep` puts it in the saved sounds folder. */
  renderSample: (id: number, params: ProcessParams, label: string, keep: boolean) => invoke<string>("render_sample", { id, params, label, keep }),
  rendersUsage: () => invoke<RendersUsage>("renders_usage"),
  /** Moves renders older than this many days (all of them for null) to the Trash. */
  clearRenders: (olderThanDays: number | null) => invoke<ClearedRenders>("clear_renders", { olderThanDays }),
  /** Asks where to save in a native dialog (fileName is its suggestion), then writes the WAV there. Null when cancelled. */
  exportSample: (id: number, params: ProcessParams, fileName: string) => invoke<string | null>("export_sample", { id, params, fileName }),
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
  savedSounds: () => invoke<SavedSounds>("saved_sounds_dir"),
  /** Asks for a new saved sounds folder in a native picker and moves there; null when cancelled. Files already saved stay put. */
  pickSavedSoundsDir: () => invoke<SavedSounds | null>("pick_saved_sounds_dir"),
  /** Saves new renders and variations in the default folder again. */
  resetSavedSoundsDir: () => invoke<SavedSounds>("reset_saved_sounds_dir"),
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

  /** The inputs, the apps with sound and whether everything you hear can be recorded here. */
  recordSources: () => invoke<RecordSources>("record_sources"),
  /** Opens a source and arms a take (or starts one at once without start on sound). Resolves to what's in the
   *  way when it can't open, or null once it's armed. Arming the open source again only changes its options. */
  armTake: (source: RecordSource, options: TakeOptions) => invoke<RecordProblem | null>("arm_take", { source, options }),
  setTakeOptions: (options: TakeOptions) => invoke<void>("set_take_options", { options }),
  /** Starts recording now, without waiting for a sound. */
  recordTakeNow: () => invoke<void>("record_take_now"),
  /** Keeps the take being recorded, if any, and closes the source. */
  stopTake: () => invoke<void>("stop_take"),
  listTakes: () => invoke<TakeList>("list_takes"),
  /** Moves a take into the saved sounds folder's Recordings, which is in the library; returns it as it is now. */
  saveTake: (id: number) => invoke<SampleRow>("save_take", { id }),
  /** Moves takes (unsaved, or saved and still in Recordings) to the Trash; returns how many went. */
  trashTakes: (ids: number[]) => invoke<number>("trash_takes", { ids }),
  clearUnsavedTakes: () => invoke<number>("clear_unsaved_takes"),
  recordSettings: () => invoke<RecordSettings>("record_settings"),
  setRecordSettings: (patch: { format?: TakeFormat; retention?: TakesRetention }) =>
    invoke<RecordSettings>("set_record_settings", { format: patch.format ?? null, retention: patch.retention ?? null }),
  /** Keys as Tauri spells them ("CommandOrControl+Shift+R"), or null to clear. Fails when another app holds them. */
  setRecordShortcut: (shortcut: string | null) => invoke<RecordSettings>("set_record_shortcut", { shortcut }),
  openPrivacySettings: (what: "microphone" | "systemAudio") => invoke<void>("open_privacy_settings", { what }),
  /** Quits after asking about unsaved takes; with `trashTakes`, they go to the Trash first. */
  quitApp: (trashTakes: boolean) => invoke<void>("quit_app", { trashTakes }),

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
  onTakeStatus: (cb: (e: TakeStatus) => void): Promise<UnlistenFn> => listen<TakeStatus>("take-status", (e) => cb(e.payload)),
  onTakeLanded: (cb: (e: TakeLanded) => void): Promise<UnlistenFn> => listen<TakeLanded>("take-landed", (e) => cb(e.payload)),
  onTakeNotice: (cb: (e: TakeNotice) => void): Promise<UnlistenFn> => listen<TakeNotice>("take-notice", (e) => cb(e.payload)),
  /** The global record shortcut was pressed, wherever focus was. */
  onRecordShortcut: (cb: () => void): Promise<UnlistenFn> => listen("record-shortcut", () => cb()),
  /** The window is closing with unsaved takes that go to the Trash on quit: ask first. The payload is how many. */
  onQuitRequested: (cb: (unsaved: number) => void): Promise<UnlistenFn> => listen<number>("quit-requested", (e) => cb(e.payload)),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}
