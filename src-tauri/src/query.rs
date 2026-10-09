//! Turns filters and search-box syntax into SQL.
//!
//! Besides free words, the search box understands:
//! `bpm:120-128`, `bpm:>140`, `key:Am`, `key:Am+` (with compatible keys), `key:8A`,
//! `is:loop`, `is:oneshot`, `is:fav`, `is:mono`, `is:stereo`, `cat:kick`, `tag:warm`,
//! `-tag:808`, `len:<2s`, `len:1-4s`, `ext:wav` and `-word` to exclude a word.

use crate::keys::{fitting_keys, parse_user_key, pc_mask, scale_notes, Key, Mode, MIN_SCALE_FIT};
use crate::meta::CATEGORIES;
use crate::model::{Filters, KeyFilter};
use rusqlite::types::Value;

#[derive(Debug, Clone, Default)]
pub struct ParsedSearch {
    /// FTS5 expression for the words that must match.
    pub fts: Option<String>,
    /// FTS5 expression for words that must not match.
    pub exclude_fts: Option<String>,
    /// UI filters with the search-box tokens applied on top.
    pub filters: Filters,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Omit {
    Nothing,
    Kind,
    Categories,
    Bpm,
    Duration,
    Key,
}

pub struct Where {
    pub join: String,
    pub clause: String,
    pub params: Vec<Value>,
    pub has_text: bool,
}

pub const RECENT_DAYS: i64 = 7;

fn parse_range(s: &str, unit_scale: impl Fn(&str) -> Option<f64>) -> Option<(Option<f64>, Option<f64>)> {
    let s = s.trim();
    if let Some(v) = s.strip_prefix(">=").or_else(|| s.strip_prefix('>')) {
        return Some((Some(unit_scale(v)?), None));
    }
    if let Some(v) = s.strip_prefix("<=").or_else(|| s.strip_prefix('<')) {
        return Some((None, Some(unit_scale(v)?)));
    }
    if let Some(v) = s.strip_suffix('+') {
        return Some((Some(unit_scale(v)?), None));
    }
    if let Some((a, b)) = s.split_once('-').or_else(|| s.split_once("..")) {
        let b = b.trim_start_matches('.');
        return Some((Some(unit_scale(a)?), Some(unit_scale(b)?)));
    }
    let v = unit_scale(s)?;
    Some((Some(v), Some(v)))
}

fn seconds(s: &str) -> Option<f64> {
    let s = s.trim().to_ascii_lowercase();
    if let Some(ms) = s.strip_suffix("ms") {
        return ms.parse::<f64>().ok().map(|v| v / 1000.0);
    }
    if let Some(m) = s.strip_suffix('m') {
        return m.parse::<f64>().ok().map(|v| v * 60.0);
    }
    s.trim_end_matches('s').parse().ok()
}

fn number(s: &str) -> Option<f64> {
    s.trim().parse().ok()
}

fn normalize_tag(t: &str) -> String {
    t.trim().to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect::<String>().trim_matches('-').to_string()
}

pub fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let n = normalize_tag(t);
        if !n.is_empty() && !out.contains(&n) {
            out.push(n);
        }
    }
    out
}

/// One FTS5 term per typed word; "lo-fi" matches both "lo fi" and "lofi".
fn fts_word(word: &str) -> Option<String> {
    let parts: Vec<String> = word
        .split(|c: char| !c.is_alphanumeric())
        .filter(|p| !p.is_empty())
        .map(|p| p.to_lowercase())
        .collect();
    let quote = |p: &str| format!("\"{}\"*", p.replace('"', ""));
    match parts.len() {
        0 => None,
        1 => Some(quote(&parts[0])),
        _ => Some(format!(
            "(({}) OR {})",
            parts.iter().map(|p| quote(p)).collect::<Vec<_>>().join(" AND "),
            quote(&parts.concat())
        )),
    }
}

pub fn parse_search(base: &Filters) -> ParsedSearch {
    let mut f = base.clone();
    let mut include: Vec<String> = Vec::new();
    let mut exclude: Vec<String> = Vec::new();

    for raw in base.text.split_whitespace() {
        let token = raw.trim_matches('"');
        let (neg, token) = match token.strip_prefix('-') {
            Some(t) if !t.is_empty() => (true, t),
            _ => (false, token),
        };
        let Some((field, value)) = token.split_once(':').filter(|(k, v)| !k.is_empty() && !v.is_empty()) else {
            if let Some(expr) = fts_word(token) {
                if neg { exclude.push(expr) } else { include.push(expr) }
            }
            continue;
        };
        let field = field.to_ascii_lowercase();
        let handled = match field.as_str() {
            "bpm" | "tempo" => parse_range(value, number).map(|(lo, hi)| {
                // A single value means "about this tempo".
                let (lo, hi) = if lo == hi { (lo.map(|v| v - 0.5), hi.map(|v| v + 0.5)) } else { (lo, hi) };
                f.bpm_min = lo;
                f.bpm_max = hi;
            }),
            "key" => {
                let compatible = value.ends_with('+');
                parse_user_key(value.trim_end_matches('+')).map(|k: Key| {
                    f.key = Some(KeyFilter {
                        pc: k.pc,
                        mode: if k.mode == Mode::Minor { 1 } else { 0 },
                        compatible,
                        include_unpitched: false,
                        root_in_scale: true,
                        scale: None,
                        by_notes: false,
                    });
                })
            }
            "is" | "type" => {
                let mut known = true;
                match value.to_ascii_lowercase().as_str() {
                    "loop" | "loops" => f.kind = Some("loop".into()),
                    "oneshot" | "oneshots" | "one-shot" | "shot" | "hit" => f.kind = Some("oneshot".into()),
                    "fav" | "favs" | "favorite" | "favourite" | "starred" => f.favorites = true,
                    "mono" => f.channels = Some(1),
                    "stereo" => f.channels = Some(2),
                    _ => known = false,
                }
                known.then_some(())
            }
            "cat" | "category" => CATEGORIES
                .iter()
                .find(|(name, words)| name.eq_ignore_ascii_case(value) || words.contains(&value.to_lowercase().as_str()))
                .map(|(name, _)| {
                    if !f.categories.iter().any(|c| c == name) {
                        f.categories.push(name.to_string());
                    }
                }),
            "tag" => {
                let t = normalize_tag(value);
                (!t.is_empty()).then(|| if neg { f.exclude_tags.push(t) } else { f.tags.push(t) })
            }
            "len" | "length" | "dur" | "duration" => parse_range(value, seconds).map(|(lo, hi)| {
                f.dur_min = lo;
                f.dur_max = if lo == hi { hi.map(|v| v + 0.05) } else { hi };
            }),
            "ext" | "format" => {
                f.formats.push(value.to_ascii_lowercase());
                Some(())
            }
            _ => None,
        };
        if handled.is_none() {
            if let Some(expr) = fts_word(token) {
                if neg { exclude.push(expr) } else { include.push(expr) }
            }
        }
    }

    ParsedSearch {
        fts: (!include.is_empty()).then(|| include.join(" AND ")),
        exclude_fts: (!exclude.is_empty()).then(|| exclude.join(" OR ")),
        filters: f,
    }
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(", ")
}

/// The notes of a key filter's scale: the Lab scale if it has one, else the plain major or minor.
fn key_mask(k: &KeyFilter) -> u16 {
    match k.scale.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => pc_mask(&scale_notes(k.pc, s)),
        None => pc_mask(&Key::new(k.pc as i32, if k.mode == 1 { Mode::Minor } else { Mode::Major }).scale()),
    }
}

/// What the "fit" sort measures against: the key filter's scale, if there is one.
pub fn fit_mask(f: &Filters) -> Option<u16> {
    f.key.as_ref().map(key_mask)
}

pub fn build_where(p: &ParsedSearch, omit: Omit, now: i64) -> Where {
    let f = &p.filters;
    let mut params: Vec<Value> = Vec::new();
    let mut join = String::new();
    // Unsaved takes are reached through the takes tray, never by browsing.
    let mut w: Vec<String> = vec![crate::db::VISIBLE.into()];

    if let Some(fts) = &p.fts {
        join = "JOIN (SELECT rowid AS rid, bm25(samples_fts) AS rank FROM samples_fts WHERE samples_fts MATCH ?) f ON f.rid = s.id".into();
        params.push(Value::Text(fts.clone()));
    }
    if let Some(ex) = &p.exclude_fts {
        w.push("s.id NOT IN (SELECT rowid FROM samples_fts WHERE samples_fts MATCH ?)".into());
        params.push(Value::Text(ex.clone()));
    }

    if omit != Omit::Kind {
        match f.kind.as_deref() {
            Some("loop") => w.push("s.kind = 1".into()),
            Some("oneshot") => w.push("s.kind = 0".into()),
            _ => {}
        }
    }
    if omit != Omit::Categories && !f.categories.is_empty() {
        w.push(format!("s.category IN ({})", placeholders(f.categories.len())));
        params.extend(f.categories.iter().map(|c| Value::Text(c.clone())));
    }
    if omit != Omit::Bpm && (f.bpm_min.is_some() || f.bpm_max.is_some()) {
        let lo = f.bpm_min.unwrap_or(0.0);
        let hi = f.bpm_max.unwrap_or(10_000.0);
        let mut ranges = vec![(lo, hi)];
        if f.half_double {
            ranges.push((lo / 2.0, hi / 2.0));
            ranges.push((lo * 2.0, hi * 2.0));
        }
        let parts: Vec<String> = ranges.iter().map(|_| "s.bpm BETWEEN ? AND ?".to_string()).collect();
        w.push(format!("(s.bpm IS NOT NULL AND ({}))", parts.join(" OR ")));
        for (a, b) in ranges {
            params.push(Value::Real(a));
            params.push(Value::Real(b));
        }
    }
    if omit != Omit::Key {
        if let Some(k) = &f.key {
            let key = Key::new(k.pc as i32, if k.mode == 1 { Mode::Minor } else { Mode::Major });
            let scale = k.scale.as_deref().filter(|s| !s.is_empty());
            let keys = match (k.compatible, scale) {
                (true, Some(s)) => fitting_keys(k.pc, s),
                (true, None) => key.compatible(),
                (false, _) => vec![key],
            };
            let codes: Vec<String> = keys.iter().map(|k| (k.pc as i64 * 2 + k.mode as i64).to_string()).collect();
            let roots = match (k.root_in_scale, scale) {
                (true, Some(s)) => scale_notes(k.pc, s),
                (true, None) => key.scale(),
                (false, _) => vec![key.pc],
            };
            let notes: Vec<String> = roots.iter().map(|n| n.to_string()).collect();
            let mut any = vec![
                format!("(s.key_mode IN (0, 1) AND s.key_pc * 2 + s.key_mode IN ({}))", codes.join(", ")),
                format!("(s.key_mode = 2 AND s.key_pc IN ({}))", notes.join(", ")),
            ];
            if k.include_unpitched {
                any.push("s.key_pc IS NULL".into());
            } else if k.by_notes {
                any.push(format!("(s.key_pc IS NULL AND scale_fit(s.features, {}) >= {MIN_SCALE_FIT})", key_mask(k)));
            }
            w.push(format!("({})", any.join(" OR ")));
        }
    }
    if omit != Omit::Duration {
        if let Some(lo) = f.dur_min {
            w.push("s.duration >= ?".into());
            params.push(Value::Real(lo));
        }
        if let Some(hi) = f.dur_max {
            w.push("s.duration <= ?".into());
            params.push(Value::Real(hi));
        }
    }
    if let Some(from) = f.created_from {
        w.push("s.created >= ?".into());
        params.push(Value::Integer(from));
    }
    if let Some(to) = f.created_to {
        w.push("s.created < ?".into());
        params.push(Value::Integer(to));
    }
    if !f.formats.is_empty() {
        let mut exts: Vec<String> = Vec::new();
        for fmt in &f.formats {
            match fmt.as_str() {
                "aiff" | "aif" => exts.extend(["aif", "aiff", "aifc"].map(String::from)),
                "wav" => exts.extend(["wav", "wave"].map(String::from)),
                "ogg" => exts.extend(["ogg", "oga"].map(String::from)),
                other => exts.push(other.to_string()),
            }
        }
        w.push(format!("s.ext IN ({})", placeholders(exts.len())));
        params.extend(exts.into_iter().map(Value::Text));
    }
    match f.channels {
        Some(1) => w.push("s.channels = 1".into()),
        Some(2) => w.push("s.channels >= 2".into()),
        _ => {}
    }
    if !f.sample_rates.is_empty() {
        w.push(format!("s.sample_rate IN ({})", placeholders(f.sample_rates.len())));
        params.extend(f.sample_rates.iter().map(|r| Value::Integer(*r)));
    }
    for t in &f.tags {
        w.push("(s.auto_tags LIKE ? OR s.user_tags LIKE ?)".into());
        let pat = format!("%,{},%", normalize_tag(t));
        params.push(Value::Text(pat.clone()));
        params.push(Value::Text(pat));
    }
    for t in &f.exclude_tags {
        w.push("NOT (s.auto_tags LIKE ? OR s.user_tags LIKE ?)".into());
        let pat = format!("%,{},%", normalize_tag(t));
        params.push(Value::Text(pat.clone()));
        params.push(Value::Text(pat));
    }
    if f.favorites {
        w.push("s.favorite = 1".into());
    }
    if let Some(c) = f.collection_id {
        w.push("s.id IN (SELECT sample_id FROM collection_items WHERE collection_id = ?)".into());
        params.push(Value::Integer(c));
    }
    if let Some(src) = f.source_id {
        w.push("s.source_id = ?".into());
        params.push(Value::Integer(src));
        if let Some(dir) = f.dir.as_deref().filter(|d| !d.is_empty()) {
            w.push("(s.dir = ? OR substr(s.dir, 1, ?) = ?)".into());
            params.push(Value::Text(dir.to_string()));
            params.push(Value::Integer(dir.chars().count() as i64 + 1));
            params.push(Value::Text(format!("{dir}/")));
        }
    }
    match f.recent.as_deref() {
        Some("added") => {
            w.push("s.added_at >= ?".into());
            params.push(Value::Integer(now - RECENT_DAYS * 86_400));
        }
        Some("played") => w.push("s.last_played IS NOT NULL".into()),
        _ => {}
    }

    Where { join, clause: w.join(" AND "), params, has_text: p.fts.is_some() }
}

/// `fit`: the scale the "fit" sort ranks by (samples whose notes fit it best first).
pub fn order_by(sort: &str, desc: bool, has_text: bool, seed: i64, fit: Option<u16>) -> String {
    let dir = if desc { "DESC" } else { "ASC" };
    let flip = if desc { "ASC" } else { "DESC" };
    match sort {
        "fit" if fit.is_some() => format!("scale_fit(s.features, {}) DESC NULLS LAST, s.name COLLATE NATSORT", fit.unwrap()),
        "name" => format!("s.name COLLATE NATSORT {dir}, s.id"),
        // Dates read newest first when descending, like the other columns.
        "added" => format!("s.added_at {dir}, s.id {dir}"),
        "created" => format!("s.created {dir} NULLS LAST, s.name COLLATE NATSORT"),
        "played" => format!("s.last_played {flip} NULLS LAST, s.play_count DESC"),
        "duration" => format!("s.duration {dir} NULLS LAST, s.name COLLATE NATSORT"),
        "bpm" => format!("s.bpm {dir} NULLS LAST, s.name COLLATE NATSORT"),
        "key" => format!(
            "CASE WHEN s.key_mode IN (0, 1) THEN \
               ((7 + ((((CASE s.key_mode WHEN 1 THEN s.key_pc ELSE s.key_pc - 3 END) - 9) % 12 + 12) % 12) * 7 % 12) % 12) * 2 + (1 - s.key_mode) \
             WHEN s.key_mode = 2 THEN 100 + s.key_pc ELSE 1000 END {dir}, s.name COLLATE NATSORT"
        ),
        "random" => format!("((s.id * 2654435761 + {}) % 4294967291)", seed.rem_euclid(1 << 31)),
        _ if has_text => "f.rank, s.favorite DESC, s.name COLLATE NATSORT".into(),
        _ => "s.dir COLLATE NATSORT, s.name COLLATE NATSORT".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> ParsedSearch {
        parse_search(&Filters { text: text.into(), ..Default::default() })
    }

    #[test]
    fn plain_words_become_prefix_terms() {
        let p = parse("dusty Kick");
        assert_eq!(p.fts.as_deref(), Some("\"dusty\"* AND \"kick\"*"));
        assert!(p.exclude_fts.is_none());
    }

    #[test]
    fn hyphenated_words_match_joined_spelling() {
        assert_eq!(parse("lo-fi").fts.as_deref(), Some("((\"lo\"* AND \"fi\"*) OR \"lofi\"*)"));
    }

    #[test]
    fn field_tokens_set_filters() {
        let p = parse("bass bpm:120-128 key:Am+ is:loop len:<16s -tag:808 tag:warm -dirty cat:kick");
        assert_eq!(p.fts.as_deref(), Some("\"bass\"*"));
        assert_eq!(p.exclude_fts.as_deref(), Some("\"dirty\"*"));
        let f = p.filters;
        assert_eq!((f.bpm_min, f.bpm_max), (Some(120.0), Some(128.0)));
        let k = f.key.unwrap();
        assert_eq!((k.pc, k.mode, k.compatible), (9, 1, true));
        assert_eq!(f.kind.as_deref(), Some("loop"));
        assert_eq!(f.dur_max, Some(16.0));
        assert_eq!(f.tags, vec!["warm"]);
        assert_eq!(f.exclude_tags, vec!["808"]);
        assert_eq!(f.categories, vec!["Kick"]);
    }

    #[test]
    fn single_bpm_means_about_that_tempo() {
        let f = parse("bpm:124").filters;
        assert_eq!((f.bpm_min, f.bpm_max), (Some(123.5), Some(124.5)));
        let f = parse("bpm:>140").filters;
        assert_eq!((f.bpm_min, f.bpm_max), (Some(140.0), None));
    }

    #[test]
    fn unknown_fields_are_searched_as_words() {
        assert_eq!(parse("foo:bar").fts.as_deref(), Some("((\"foo\"* AND \"bar\"*) OR \"foobar\"*)"));
    }

    #[test]
    fn durations_understand_units() {
        let f = parse("len:200ms-1.5s").filters;
        assert_eq!((f.dur_min, f.dur_max), (Some(0.2), Some(1.5)));
    }
}
