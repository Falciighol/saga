//! Types exchanged with the frontend.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub online: bool,
    pub count: i64,
    /// Subfolders left out of the library, relative to `path` and `/`-separated.
    pub excluded: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirNode {
    pub name: String,
    /// Path relative to the source root, `/`-separated.
    pub dir: String,
    pub count: i64,
    pub has_children: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleRow {
    pub id: i64,
    pub source_id: i64,
    pub path: String,
    pub name: String,
    pub ext: String,
    pub dir: String,
    pub pack: String,
    pub duration: Option<f64>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
    pub bit_depth: Option<i64>,
    pub bpm: Option<f64>,
    /// "name", "metadata", "audio" (detected, so an estimate), "user" (set by hand) or null.
    pub bpm_source: Option<&'static str>,
    pub key: Option<String>,
    /// Like `bpm_source`.
    pub key_source: Option<&'static str>,
    pub key_pc: Option<i64>,
    pub key_mode: Option<i64>,
    pub camelot: Option<String>,
    pub kind: &'static str,
    pub category: Option<String>,
    pub tags: Vec<String>,
    pub user_tags: Vec<String>,
    pub peak_db: Option<f64>,
    pub loudness: Option<f64>,
    /// Base64 of the 512-byte waveform envelope, or null until analyzed.
    pub peaks: Option<String>,
    /// 0 pending analysis, 1 analyzed, 2 failed.
    pub status: i64,
    pub favorite: bool,
    pub online: bool,
    pub play_count: i64,
}

/// A tempo set by hand: `{ "to": "bpm", "bpm": 124 }`, `{ "to": "noTempo" }`, or back to what
/// Saga found with `{ "to": "detected" }`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "to")]
pub enum TempoChange {
    Bpm { bpm: f64 },
    NoTempo,
    Detected,
}

/// A key set by hand: `{ "to": "key", "pc": 9, "mode": 1 }` (mode 0 major, 1 minor, 2 a single
/// note), `{ "to": "noKey" }`, or back to what Saga found with `{ "to": "detected" }`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "to")]
pub enum KeyChange {
    Key { pc: u8, mode: u8 },
    NoKey,
    Detected,
}

/// What renaming needs to know about a sample's file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDates {
    pub id: i64,
    /// Seconds since 1970; the modified time where the file system doesn't keep a created time.
    pub created: Option<i64>,
    pub modified: Option<i64>,
}

/// A new name (without the extension) for a sample's file.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameRequest {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOutcome {
    pub id: i64,
    /// The name before, to undo with.
    pub from: String,
    pub to: String,
    /// Why it wasn't renamed; null when it was.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Filters {
    pub text: String,
    /// "loop" or "oneshot".
    pub kind: Option<String>,
    pub categories: Vec<String>,
    pub bpm_min: Option<f64>,
    pub bpm_max: Option<f64>,
    /// Also match half and double the tempo range.
    pub half_double: bool,
    pub key: Option<KeyFilter>,
    pub dur_min: Option<f64>,
    pub dur_max: Option<f64>,
    pub formats: Vec<String>,
    /// 1 = mono, 2 = stereo.
    pub channels: Option<i64>,
    pub sample_rates: Vec<i64>,
    pub tags: Vec<String>,
    pub exclude_tags: Vec<String>,
    pub favorites: bool,
    pub collection_id: Option<i64>,
    pub source_id: Option<i64>,
    pub dir: Option<String>,
    /// "added" or "played".
    pub recent: Option<String>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyFilter {
    pub pc: u8,
    /// 0 major, 1 minor.
    pub mode: u8,
    #[serde(default = "yes")]
    pub compatible: bool,
    #[serde(default = "yes")]
    pub include_unpitched: bool,
    #[serde(default = "yes")]
    pub root_in_scale: bool,
    /// A scale from the Lab, as semitones above `pc` (Dorian is `[0, 2, 3, 5, 7, 9, 10]`).
    /// "Compatible" then means keys that share the scale's notes, and one-shot roots are
    /// checked against the scale instead of the plain major or minor one.
    #[serde(default)]
    pub scale: Option<Vec<u8>>,
    /// Samples with no key pass when the notes in their stored pitch profile fit the scale
    /// (see `keys::scale_fit`). Moot while `include_unpitched` lets every one of them through.
    #[serde(default)]
    pub by_notes: bool,
}

/// What a sample's stored description says about its notes, for the Lab's key finder and tuning.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchProfile {
    /// Share of the pitched energy on each note, C first; all zero when nothing tonal was found.
    pub chroma: [f32; 12],
    /// 0 for an even spread over the twelve notes, 1 for a single note.
    pub tonality: f32,
    /// The fundamental of a clearly pitched sound, in Hz.
    pub hz: Option<f32>,
    /// 0–1: how clearly periodic the sound is.
    pub clarity: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    #[serde(default)]
    pub filters: Filters,
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    pub desc: bool,
    #[serde(default)]
    pub offset: i64,
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub seed: i64,
}

fn default_limit() -> i64 {
    100
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub total: i64,
    pub offset: i64,
    pub rows: Vec<SampleRow>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Facets {
    pub total: i64,
    pub loops: i64,
    pub oneshots: i64,
    pub categories: Vec<(String, i64)>,
    /// Counts per 2.5 BPM bin from `BPM_HIST_MIN`.
    pub bpm_hist: Vec<i64>,
    /// Counts per logarithmic duration bin between `DUR_HIST_MIN` and `DUR_HIST_MAX`.
    pub dur_hist: Vec<i64>,
    /// Counts per key, indexed `pc * 2 + mode`.
    pub keys: Vec<i64>,
    pub tags: Vec<(String, i64)>,
}

pub const BPM_HIST_MIN: f64 = 40.0;
pub const BPM_HIST_STEP: f64 = 2.5;
pub const BPM_HIST_BINS: usize = 72;
pub const DUR_HIST_MIN: f64 = 0.05;
pub const DUR_HIST_MAX: f64 = 120.0;
pub const DUR_HIST_BINS: usize = 48;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub total: i64,
    pub favorites: i64,
    pub loops: i64,
    pub oneshots: i64,
    pub recently_added: i64,
    pub played: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub scanning: bool,
    /// Files discovered by the scan in progress.
    pub found: u64,
    /// Files analyzed in the current batch.
    pub done: u64,
    /// Files queued for analysis in the current batch.
    pub total: u64,
    pub watching: usize,
    /// Everything left in the batch was analyzed before and is being described again
    /// for Find similar and the sound map.
    pub refreshing: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarItem {
    pub row: SampleRow,
    /// 1 for an identical sound, 0 for a typical unrelated pair.
    pub score: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarResult {
    pub target: Option<SampleRow>,
    pub items: Vec<SimilarItem>,
    /// Samples with a sound description.
    pub described: i64,
    /// Samples still waiting to be described.
    pub pending: i64,
    /// Why there are no results, when it isn't simply that nothing is close.
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapLabel {
    pub group: u8,
    pub x: f32,
    pub y: f32,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapLayout {
    /// Identifies this arrangement; pass it back to `map_matches`.
    pub key: String,
    pub count: usize,
    /// Base64, 12 bytes per point: id (i32 LE), x and y (u16 LE, 0–65535), color group,
    /// brightness and level (u8 each), and a spare byte.
    pub points: String,
    pub labels: Vec<MapLabel>,
    pub described: i64,
    pub pending: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapMatches {
    /// Base64 bitset over the layout's points, or null when every point matches.
    pub bits: Option<String>,
    pub matched: usize,
}
