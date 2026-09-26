//! Every described sample's features in memory, for Find similar and the sound map.
//! Features are standardized across the library so no single descriptor dominates, and
//! compared per aspect: overall, timbre, pitch or envelope.

use crate::db::FeatureRow;
use crate::features::{BRIGHTNESS, DIM, ENVELOPE, LEVEL, PITCH, TIMBRE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ops::Range;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Aspect {
    #[default]
    Overall,
    Timbre,
    Pitch,
    Envelope,
}

impl Aspect {
    pub const ALL: [Aspect; 4] = [Aspect::Overall, Aspect::Timbre, Aspect::Pitch, Aspect::Envelope];

    pub fn name(self) -> &'static str {
        match self {
            Aspect::Overall => "overall",
            Aspect::Timbre => "timbre",
            Aspect::Pitch => "pitch",
            Aspect::Envelope => "envelope",
        }
    }

    /// Weight of each dimension in the squared distance; each group sums to its share.
    pub fn weights(self) -> [f32; DIM] {
        let mut w = [0f32; DIM];
        let mut set = |r: Range<usize>, share: f32| {
            let n = r.len() as f32;
            for i in r {
                w[i] = share / n;
            }
        };
        let mut timbre = |share: f32| {
            set(TIMBRE.start..TIMBRE.start + 13, share * 0.45);
            set(TIMBRE.start + 13..TIMBRE.start + 26, share * 0.25);
            set(TIMBRE.start + 26..TIMBRE.end, share * 0.3);
        };
        match self {
            Aspect::Overall => timbre(0.55),
            Aspect::Timbre => timbre(1.0),
            _ => {}
        }
        // Pitch: which notes (chroma), how high (fundamental), how clearly pitched.
        let mut pitch = |share: f32| {
            set(PITCH.start..PITCH.start + 12, share * 0.5);
            set(PITCH.start + 12..PITCH.start + 13, share * 0.3);
            set(PITCH.start + 13..PITCH.end, share * 0.2);
        };
        match self {
            Aspect::Overall => pitch(0.2),
            Aspect::Pitch => pitch(1.0),
            _ => {}
        }
        // Envelope: attack, decay and length; the shape after the peak; how busy it is.
        let mut envelope = |share: f32| {
            set(ENVELOPE.start..ENVELOPE.start + 5, share * 0.4);
            set(ENVELOPE.start + 5..ENVELOPE.start + 13, share * 0.45);
            set(ENVELOPE.start + 13..ENVELOPE.end, share * 0.15);
        };
        match self {
            Aspect::Overall => envelope(0.25),
            Aspect::Envelope => envelope(1.0),
            _ => {}
        }
        w
    }
}

/// Color groups on the map, by category. Mirrored in src/lib/soundmap.ts.
pub fn group_of(category: Option<&str>) -> u8 {
    match category {
        Some("Kick") => 0,
        Some("Snare" | "Clap") => 1,
        Some("Hat") => 2,
        Some("Perc" | "Drums") => 3,
        Some("Bass") => 4,
        Some("Synth" | "Keys" | "Pad" | "Melody" | "Guitar" | "Strings" | "Brass") => 5,
        Some("Vocal") => 6,
        Some("FX") => 7,
        _ => 8,
    }
}

pub const OTHER_GROUP: u8 = 8;

/// Z-scores beyond this are clipped so one odd file can't stretch a dimension.
const MAX_Z: f32 = 6.0;

pub struct SoundIndex {
    /// `Db::changes()` when this was built.
    pub version: u64,
    pub built: Instant,
    pub ids: Vec<i64>,
    /// 0 one-shot, 1 loop.
    pub kinds: Vec<u8>,
    pub sources: Vec<i64>,
    pub groups: Vec<u8>,
    /// Spectral centroid, Hz.
    pub brightness: Vec<f32>,
    /// Loudest moment, dBFS.
    pub level: Vec<f32>,
    /// `len × DIM` standardized features, with missing values at the library mean.
    data: Vec<f32>,
    mean: Vec<f32>,
    std: Vec<f32>,
    pos: HashMap<i64, usize>,
    /// Median distance between two unrelated samples, per aspect (for scores).
    reference: [f32; 4],
}

impl SoundIndex {
    pub fn build(version: u64, rows: Vec<FeatureRow>) -> SoundIndex {
        let n = rows.len();
        let mut mean = vec![0f32; DIM];
        let mut std = vec![1f32; DIM];
        for d in 0..DIM {
            let (mut sum, mut sq, mut count) = (0f64, 0f64, 0usize);
            for r in &rows {
                let v = r.features[d];
                if v.is_finite() {
                    sum += v as f64;
                    sq += (v as f64) * (v as f64);
                    count += 1;
                }
            }
            if count > 0 {
                let m = sum / count as f64;
                mean[d] = m as f32;
                let s = (sq / count as f64 - m * m).max(0.0).sqrt() as f32;
                std[d] = if s > 1e-6 { s } else { 1.0 };
            }
        }
        let mut data = Vec::with_capacity(n * DIM);
        for r in &rows {
            data.extend(standardize_with(&r.features, &mean, &std));
        }
        let mut ix = SoundIndex {
            version,
            built: Instant::now(),
            pos: rows.iter().enumerate().map(|(i, r)| (r.id, i)).collect(),
            ids: rows.iter().map(|r| r.id).collect(),
            kinds: rows.iter().map(|r| r.kind as u8).collect(),
            sources: rows.iter().map(|r| r.source_id).collect(),
            groups: rows.iter().map(|r| group_of(r.category.as_deref())).collect(),
            brightness: rows.iter().map(|r| r.features[BRIGHTNESS]).collect(),
            level: rows.iter().map(|r| r.features[LEVEL]).collect(),
            data,
            mean,
            std,
            reference: [1.0; 4],
        };
        for (a, aspect) in Aspect::ALL.iter().enumerate() {
            ix.reference[a] = ix.typical_distance(*aspect);
        }
        ix
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn position(&self, id: i64) -> Option<usize> {
        self.pos.get(&id).copied()
    }

    pub fn vector(&self, i: usize) -> &[f32] {
        &self.data[i * DIM..(i + 1) * DIM]
    }

    /// Standardizes features computed outside the library (a recording, a dropped file).
    pub fn standardize(&self, raw: &[f32]) -> Vec<f32> {
        standardize_with(raw, &self.mean, &self.std)
    }

    fn typical_distance(&self, aspect: Aspect) -> f32 {
        let n = self.len();
        if n < 2 {
            return 1.0;
        }
        let w = aspect.weights();
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % n as u64) as usize
        };
        let mut d: Vec<f32> = (0..2000.min(n * n))
            .filter_map(|_| {
                let (a, b) = (next(), next());
                (a != b).then(|| distance(self.vector(a), self.vector(b), &w))
            })
            .collect();
        if d.is_empty() {
            return 1.0;
        }
        let mid = d.len() / 2;
        let (_, m, _) = d.select_nth_unstable_by(mid, |a, b| a.total_cmp(b));
        m.max(1e-3)
    }

    /// The `k` closest samples that pass `keep`, with scores from 1 (identical) down to 0.
    pub fn nearest(&self, query: &[f32], aspect: Aspect, k: usize, keep: impl Fn(usize) -> bool) -> Vec<(usize, f32)> {
        let w = aspect.weights();
        let mut hits: Vec<(usize, f32)> = (0..self.len()).filter(|&i| keep(i)).map(|i| (i, distance(query, self.vector(i), &w))).collect();
        if hits.len() > k && k > 0 {
            hits.select_nth_unstable_by(k - 1, |a, b| a.1.total_cmp(&b.1));
            hits.truncate(k);
        }
        hits.sort_by(|a, b| a.1.total_cmp(&b.1));
        let reference = self.reference[Aspect::ALL.iter().position(|a| *a == aspect).unwrap_or(0)];
        hits.into_iter().map(|(i, d)| (i, (1.0 - d / reference).clamp(0.0, 1.0))).collect()
    }

    /// Standardized features scaled by the aspect's weights, keeping only the weighted
    /// dimensions: plain Euclidean distance between these is the aspect's distance.
    pub fn weighted(&self, i: usize, aspect: Aspect) -> Vec<f32> {
        let w = aspect.weights();
        self.vector(i).iter().zip(w.iter()).filter(|(_, w)| **w > 0.0).map(|(v, w)| v * w.sqrt()).collect()
    }
}

fn standardize_with(raw: &[f32], mean: &[f32], std: &[f32]) -> Vec<f32> {
    (0..DIM)
        .map(|d| {
            let v = raw.get(d).copied().unwrap_or(f32::NAN);
            if v.is_finite() { ((v - mean[d]) / std[d]).clamp(-MAX_Z, MAX_Z) } else { 0.0 }
        })
        .collect()
}

pub fn distance(a: &[f32], b: &[f32], w: &[f32; DIM]) -> f32 {
    let mut s = 0f32;
    for d in 0..DIM {
        let x = a[d] - b[d];
        s += w[d] * x * x;
    }
    s.sqrt()
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::features::describe;
    use crate::features::tests::{noise_burst, tone, SR};

    /// A small library: kicks (low decaying tones), hats (short noise) and pads (slow chords).
    pub fn library() -> Vec<FeatureRow> {
        let mut rows = Vec::new();
        let mut id = 1;
        for i in 0..8 {
            let kick = tone(&[48.0 + i as f32 * 3.0], 0.4, 12.0 + i as f32);
            let hat = noise_burst(0.12 + i as f32 * 0.01, 40.0, i + 1);
            let pad = tone(&[220.0 + i as f32 * 20.0, 277.0 + i as f32 * 25.0], 3.0, 0.2);
            for (x, category, kind) in [(kick, "Kick", 0), (hat, "Hat", 0), (pad, "Pad", 1)] {
                let s = describe(&x, SR).unwrap();
                rows.push(FeatureRow { id, kind, source_id: 1, category: Some(category.into()), features: s.features });
                id += 1;
            }
        }
        rows
    }

    #[test]
    fn similar_sounds_are_closest() {
        let rows = library();
        let categories: HashMap<i64, String> = rows.iter().map(|r| (r.id, r.category.clone().unwrap())).collect();
        let ix = SoundIndex::build(1, rows);
        assert_eq!(ix.len(), 24);
        for aspect in [Aspect::Overall, Aspect::Timbre, Aspect::Envelope] {
            for i in 0..ix.len() {
                let hits = ix.nearest(ix.vector(i), aspect, 3, |j| j != i);
                let want = &categories[&ix.ids[i]];
                let same = hits.iter().filter(|(j, _)| &categories[&ix.ids[*j]] == want).count();
                assert!(same >= 2, "{aspect:?}: neighbours of a {want} were {:?}", hits.iter().map(|(j, _)| &categories[&ix.ids[*j]]).collect::<Vec<_>>());
                assert!(hits.windows(2).all(|w| w[0].1 >= w[1].1));
            }
        }
    }

    #[test]
    fn pitch_and_timbre_are_compared_separately() {
        let mut rows = library();
        let a2 = describe(&tone(&[110.0], 1.5, 1.5), SR).unwrap();
        let a2_rich = describe(&tone(&[110.0, 220.0, 330.0, 440.0], 1.5, 1.5), SR).unwrap();
        let ds3 = describe(&tone(&[155.6], 1.5, 1.5), SR).unwrap();
        for (id, s) in [(101, a2), (102, a2_rich), (103, ds3)] {
            rows.push(FeatureRow { id, kind: 0, source_id: 1, category: Some("Synth".into()), features: s.features });
        }
        let ix = SoundIndex::build(1, rows);
        let i = ix.position(101).unwrap();
        let among = |j: usize| [102, 103].contains(&ix.ids[j]);
        // Same note, different sound; different note, same sound.
        assert_eq!(ix.ids[ix.nearest(ix.vector(i), Aspect::Pitch, 1, among)[0].0], 102);
        assert_eq!(ix.ids[ix.nearest(ix.vector(i), Aspect::Timbre, 1, among)[0].0], 103);
    }

    #[test]
    fn identical_features_score_one_and_filters_apply() {
        let mut rows = library();
        let copy = FeatureRow { id: 999, kind: 0, source_id: 2, category: rows[0].category.clone(), features: rows[0].features.clone() };
        rows.push(copy);
        let ix = SoundIndex::build(1, rows);
        let i = ix.position(1).unwrap();
        let hits = ix.nearest(ix.vector(i), Aspect::Overall, 1, |j| j != i);
        assert_eq!(ix.ids[hits[0].0], 999);
        assert!(hits[0].1 > 0.99);
        let only_source_1 = ix.nearest(ix.vector(i), Aspect::Overall, 30, |j| j != i && ix.sources[j] == 1);
        assert!(only_source_1.iter().all(|(j, _)| ix.ids[*j] != 999));
        assert_eq!(group_of(Some("Clap")), 1);
        assert_eq!(group_of(None), OTHER_GROUP);
    }
}

/// How often a sample's closest matches share its category, on a real library (read-only):
/// `SAGA_SCAN_DIR=/path cargo test --release --lib sounds::report -- --ignored --nocapture`
#[cfg(test)]
mod report {
    use super::*;
    use crate::chunks::ChunkMeta;
    use crate::meta::{parse_name, resolve, Kind};
    use std::collections::BTreeMap;

    #[test]
    #[ignore]
    fn similarity_report() {
        let Ok(root) = std::env::var("SAGA_SCAN_DIR") else { return };
        let root = std::path::PathBuf::from(root);
        let per_kind: usize = std::env::var("SAGA_REPORT_FILES").ok().and_then(|v| v.parse().ok()).unwrap_or(800);
        let files: Vec<_> = walkdir::WalkDir::new(&root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file() && crate::decode::is_audio_path(e.path()))
            .map(|e| e.into_path())
            .collect();
        let labelled: Vec<(std::path::PathBuf, &'static str, Kind)> = files
            .iter()
            .filter_map(|p| {
                let stem = p.file_stem()?.to_string_lossy().to_string();
                let rel = p.parent()?.strip_prefix(&root).ok()?.to_string_lossy().to_string();
                let dirs: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
                let m = parse_name(&stem, &dirs);
                let r = resolve(&m, &ChunkMeta::default(), None);
                Some((p.clone(), r.category?, m.kind_hint?))
            })
            .collect();
        let mut rows = Vec::new();
        for kind in [Kind::OneShot, Kind::Loop] {
            let of_kind: Vec<_> = labelled.iter().filter(|l| l.2 == kind).collect();
            for (p, category, _) in of_kind.iter().step_by((of_kind.len() / per_kind).max(1)) {
                let Ok(info) = crate::analysis::analyze(p) else { continue };
                let Some(s) = info.sound else { continue };
                rows.push(FeatureRow { id: rows.len() as i64 + 1, kind: kind as i64, source_id: 1, category: Some(category.to_string()), features: s.features });
            }
        }
        let cats: Vec<String> = rows.iter().map(|r| r.category.clone().unwrap()).collect();
        let kinds: Vec<i64> = rows.iter().map(|r| r.kind).collect();
        if let Ok(out) = std::env::var("SAGA_DUMP") {
            let dump: Vec<_> = rows.iter().map(|r| serde_json::json!({ "kind": r.kind, "category": r.category, "features": r.features.iter().map(|v| if v.is_finite() { *v as f64 } else { f64::NAN }).collect::<Vec<_>>() })).collect();
            std::fs::write(out, serde_json::to_string(&dump).unwrap().replace("NaN", "null")).unwrap();
        }
        let ix = SoundIndex::build(1, rows);
        for kind in [0u8, 1] {
            let members: Vec<usize> = (0..ix.len()).filter(|&i| ix.kinds[i] == kind).collect();
            let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
            for &i in &members {
                *counts.entry(cats[i].as_str()).or_default() += 1;
            }
            let chance: f64 = counts.values().map(|&c| (c as f64 / members.len() as f64).powi(2)).sum();
            println!("\n{} {}: chance a random neighbour shares the category {:.0}%", members.len(), if kind == 0 { "one-shots" } else { "loops" }, chance * 100.0);
            for aspect in Aspect::ALL {
                let mut per_cat: BTreeMap<&str, (f64, usize)> = BTreeMap::new();
                let mut total = 0f64;
                for &i in &members {
                    let hits = ix.nearest(ix.vector(i), aspect, 10, |j| j != i && ix.kinds[j] == kind);
                    let same = hits.iter().filter(|(j, _)| cats[*j] == cats[i]).count() as f64 / hits.len().max(1) as f64;
                    total += same;
                    let e = per_cat.entry(cats[i].as_str()).or_default();
                    e.0 += same;
                    e.1 += 1;
                }
                println!("  {:<9} top-10 neighbours share the category {:.0}%", aspect.name(), total / members.len() as f64 * 100.0);
                if aspect == Aspect::Overall {
                    let line: Vec<String> = per_cat.iter().filter(|(_, v)| v.1 >= 10).map(|(c, v)| format!("{c} {:.0}%", v.0 / v.1 as f64 * 100.0)).collect();
                    println!("            {}", line.join(", "));
                }
            }
            let _ = &kinds;
        }
        let t = std::time::Instant::now();
        let layout = crate::map::arrange(&ix, Some(0), Aspect::Timbre, None, 1);
        println!("\narranged {} one-shots in {:.2?}", layout.ids.len(), t.elapsed());
    }
}
