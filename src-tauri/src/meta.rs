//! Metadata that can be read from a sample's name and folders, and the rules for
//! combining it with embedded chunk data and the decoded duration.

use crate::chunks::ChunkMeta;
use crate::keys::{find_key, Key, Mode};
use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    OneShot = 0,
    Loop = 1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    None = 0,
    Name = 1,
    Metadata = 2,
    /// Detected from the audio.
    Audio = 3,
    /// Set by hand in Saga, so it beats everything else.
    User = 4,
}

/// Tempo and key set by hand, which win over the name, the loop data and detection.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct UserValues {
    /// `Some(None)` means "no tempo".
    pub bpm: Option<Option<f64>>,
    /// `Some(None)` means "no key".
    pub key: Option<Option<Key>>,
}

impl UserValues {
    /// From the stored columns: a tempo of 0 or a key pitch class of -1 means "none".
    pub fn from_db(bpm: Option<f64>, key_pc: Option<i64>, key_mode: Option<i64>) -> UserValues {
        UserValues {
            bpm: bpm.map(|b| (b > 0.0).then_some(b)),
            key: key_pc.map(|pc| if pc < 0 { None } else { Key::from_db(Some(pc), key_mode) }),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.bpm.is_none() && self.key.is_none()
    }

    pub fn apply(&self, r: &mut Resolved) {
        if let Some(bpm) = self.bpm {
            r.bpm = bpm;
            r.bpm_source = Source::User;
        }
        if let Some(key) = self.key {
            r.key = key;
            r.key_source = Source::User;
        }
    }
}

/// Everything derivable from the file name and its folders, before decoding.
#[derive(Debug, Clone, Default)]
pub struct NameMeta {
    /// Tempo written explicitly next to "bpm".
    pub bpm_explicit: Option<f64>,
    /// A bare number in the tempo range; trusted only if the duration agrees.
    pub bpm_candidates: Vec<f64>,
    pub key: Option<Key>,
    pub kind_hint: Option<Kind>,
    pub category: Option<&'static str>,
    pub tags: Vec<&'static str>,
    /// Lowercased words for full-text search.
    pub words: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub bpm: Option<f64>,
    pub bpm_source: Source,
    pub key: Option<Key>,
    pub key_source: Source,
    pub kind: Kind,
    pub category: Option<&'static str>,
    pub tags: Vec<&'static str>,
}

/// Categories in the order used for chips and for breaking ties when a name
/// mentions several instruments ("808_Kick" is a kick, "Piano_Chords" is keys).
pub const CATEGORIES: &[(&str, &[&str])] = &[
    ("Kick", &["kick", "kicks", "kik", "kck", "bd", "bassdrum"]),
    ("Snare", &["snare", "snares", "snr", "sd", "rim", "rims", "rimshot"]),
    ("Clap", &["clap", "claps", "clp", "snap", "snaps"]),
    (
        "Hat",
        &[
            "hat", "hats", "hihat", "hihats", "hh", "ohh", "chh", "openhat", "closedhat", "cymbal", "cymbals", "cym",
            "ride", "rides", "crash", "crashes", "splash",
        ],
    ),
    (
        "Perc",
        &[
            "perc", "percs", "percussion", "shaker", "shakers", "tamb", "tambourine", "conga", "congas", "bongo",
            "bongos", "tom", "toms", "cowbell", "clave", "claves", "woodblock", "triangle", "rumble", "timbale",
            "guiro", "cabasa",
        ],
    ),
    (
        "Vocal",
        &[
            "vocal", "vocals", "vox", "voice", "voices", "acapella", "acappella", "adlib", "adlibs", "chant", "chants",
            "choir", "spoken", "shout", "shouts",
        ],
    ),
    ("Bass", &["bass", "basses", "sub", "subs", "808", "808s", "reese", "bassline", "basslines"]),
    ("Guitar", &["guitar", "guitars", "gtr", "strum", "strums"]),
    (
        "Keys",
        &[
            "keys", "piano", "pianos", "rhodes", "organ", "organs", "epiano", "ep", "wurli", "wurlitzer", "clav",
            "clavinet", "keyboard",
        ],
    ),
    (
        "Synth",
        &[
            "synth", "synths", "lead", "leads", "arp", "arps", "pluck", "plucks", "stab", "stabs", "seq", "sequence",
            "chord", "chords", "bell", "bells",
        ],
    ),
    (
        "Pad",
        &[
            "pad", "pads", "drone", "drones", "atmos", "athmo", "athmos", "atmosphere", "atmospheres", "ambience",
            "texture", "textures", "soundscape",
        ],
    ),
    (
        "Strings",
        &[
            "strings", "string", "violin", "violins", "viola", "cello", "cellos", "orchestral", "pizz", "harp", "harps",
            "sitar", "koto", "oud", "erhu", "banjo", "mandolin",
        ],
    ),
    (
        "Brass",
        &[
            "brass", "horn", "horns", "trumpet", "trumpets", "trombone", "sax", "saxophone", "flute", "flutes", "woodwind",
            "duduk", "clarinet", "oboe", "bassoon", "shakuhachi",
        ],
    ),
    // Melodic loops that don't say which instrument plays them.
    ("Melody", &["melody", "melodies", "melodic", "hook", "hooks", "motif"]),
    (
        "Drums",
        &[
            "drum", "drums", "beat", "beats", "break", "breaks", "breakbeat", "groove", "grooves", "top", "tops",
            "fill", "fills", "kit",
        ],
    ),
    (
        "FX",
        &[
            "fx", "sfx", "vfx", "riser", "risers", "rise", "uplifter", "uplifters", "downlifter", "downlifters", "sweep",
            "sweeps", "upsweep", "upsweeps", "downsweep", "downsweeps", "impact", "impacts", "whoosh", "whooshes", "noise",
            "foley", "transition", "transitions", "glitch", "zap", "laser", "crackle", "rain", "thunder", "wind", "field",
        ],
    ),
];

/// Descriptive words worth surfacing as tags, with their canonical spelling.
const TAG_WORDS: &[(&str, &str)] = &[
    ("analog", "analog"), ("analogue", "analog"), ("digital", "digital"), ("dark", "dark"), ("bright", "bright"),
    ("warm", "warm"), ("cold", "cold"), ("tape", "tape"), ("vinyl", "vinyl"), ("dusty", "dusty"), ("lofi", "lofi"),
    ("808", "808"), ("909", "909"), ("707", "707"), ("acoustic", "acoustic"), ("electric", "electric"),
    ("wet", "wet"), ("dry", "dry"), ("processed", "processed"), ("distorted", "distorted"), ("dist", "distorted"),
    ("saturated", "saturated"), ("clean", "clean"), ("punchy", "punchy"), ("soft", "soft"), ("hard", "hard"),
    ("deep", "deep"), ("tight", "tight"), ("wide", "wide"), ("female", "female"), ("male", "male"),
    ("chopped", "chopped"), ("chop", "chopped"), ("chops", "chopped"), ("reversed", "reversed"), ("reverse", "reversed"),
    ("filtered", "filtered"), ("crunchy", "crunchy"), ("gritty", "gritty"), ("airy", "airy"), ("lush", "lush"),
    ("dirty", "dirty"), ("vintage", "vintage"), ("retro", "retro"), ("organic", "organic"), ("glitchy", "glitch"),
    ("trap", "trap"), ("house", "house"), ("techno", "techno"), ("dnb", "dnb"), ("jungle", "jungle"),
    ("hiphop", "hiphop"), ("boombap", "boombap"), ("garage", "garage"), ("ukg", "garage"), ("dubstep", "dubstep"),
    ("ambient", "ambient"), ("cinematic", "cinematic"), ("jazz", "jazz"), ("jazzy", "jazz"), ("funk", "funk"),
    ("funky", "funk"), ("soul", "soul"), ("soulful", "soul"), ("rnb", "rnb"), ("pop", "pop"), ("edm", "edm"),
    ("trance", "trance"), ("minimal", "minimal"), ("afro", "afro"), ("latin", "latin"), ("reggaeton", "reggaeton"),
    ("drill", "drill"), ("phonk", "phonk"), ("synthwave", "synthwave"), ("disco", "disco"), ("dub", "dub"),
    ("rock", "rock"), ("metal", "metal"), ("orchestral", "orchestral"), ("cinematic", "cinematic"),
    ("granular", "granular"), ("modular", "modular"), ("fm", "fm"), ("stereo", "stereo"),
];

/// Two-word spellings joined before matching ("lo fi", "hip hop", "boom bap", "bass drum").
const JOINS: &[(&str, &str, &str)] = &[
    ("lo", "fi", "lofi"),
    ("hip", "hop", "hiphop"),
    ("boom", "bap", "boombap"),
    ("bass", "drum", "bassdrum"),
    ("hi", "hat", "hihat"),
    ("hi", "hats", "hihats"),
    ("open", "hat", "openhat"),
    ("closed", "hat", "closedhat"),
    ("one", "shot", "oneshot"),
    ("one", "shots", "oneshots"),
    ("r", "b", "rnb"),
    ("drum", "n", "dnb"),
    ("e", "piano", "epiano"),
];

static BPM_EXPLICIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[^0-9.])(\d{2,3}(?:[.,]\d{1,2})?)\s*[-_ ]?\s*bpm|bpm\s*[-_ ]?\s*(\d{2,3}(?:[.,]\d{1,2})?)(?:[^0-9]|$)")
        .unwrap()
});

pub const MIN_BPM: f64 = 50.0;
pub const MAX_BPM: f64 = 220.0;

/// Splits a name into tokens on separators and letter/digit boundaries, keeping
/// `#` so keys like `F#m` survive ("124BPM_F#m" → ["124", "BPM", "F#m"]).
pub fn raw_tokens(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut prev: Option<char> = None;
    for c in s.chars() {
        let is_word = c.is_alphanumeric() || c == '#' || c == '♯' || c == '♭';
        if !is_word {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            prev = None;
            continue;
        }
        if let Some(p) = prev {
            let boundary = (p.is_ascii_digit() && c.is_alphabetic()) || (p.is_alphabetic() && c.is_ascii_digit());
            // "808s", "909" and "Am7" stay whole enough; only split letters from multi-digit runs.
            if boundary && !cur.is_empty() {
                let keep = (p.is_ascii_digit() && (c == 's' || c == 'S') && cur.len() >= 3)
                    || (p.is_alphabetic() && cur.len() <= 3 && cur.chars().next().is_some_and(|f| "ABCDEFG".contains(f)) && c.is_ascii_digit() && cur.len() >= 2);
                if !keep {
                    out.push(std::mem::take(&mut cur));
                }
            }
        }
        cur.push(c);
        prev = Some(c);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Lowercased search words, additionally splitting camelCase ("LoFiKeys" → lofikeys, lo, fi, keys).
pub fn search_words(s: &str) -> Vec<String> {
    let mut words = Vec::new();
    for tok in raw_tokens(s) {
        let lower = tok.to_lowercase();
        let mut parts = Vec::new();
        let mut cur = String::new();
        let chars: Vec<char> = tok.chars().collect();
        for (i, &c) in chars.iter().enumerate() {
            if i > 0 && c.is_uppercase() && chars[i - 1].is_lowercase() && !cur.is_empty() {
                parts.push(std::mem::take(&mut cur));
            }
            if c.is_alphanumeric() {
                cur.push(c);
            }
        }
        if !cur.is_empty() {
            parts.push(cur);
        }
        let clean: String = lower.chars().filter(|c| c.is_alphanumeric()).collect();
        if !clean.is_empty() {
            words.push(clean);
        }
        if parts.len() > 1 {
            words.extend(parts.into_iter().map(|p| p.to_lowercase()));
        }
    }
    words
}

fn joined_words(words: &[String]) -> Vec<String> {
    let mut out: Vec<String> = words.to_vec();
    for w in words.windows(2) {
        for (a, b, joined) in JOINS {
            if w[0] == *a && w[1] == *b {
                out.push((*joined).to_string());
            }
        }
    }
    out
}

fn category_of(words: &[String]) -> Option<&'static str> {
    let words = joined_words(words);
    CATEGORIES
        .iter()
        .find(|(_, keys)| words.iter().any(|w| keys.contains(&w.as_str())))
        .map(|(name, _)| *name)
}

fn kind_of(words: &[String]) -> Option<Kind> {
    let words = joined_words(words);
    let mut hint = None;
    for w in &words {
        match w.as_str() {
            "loop" | "loops" | "looped" | "lp" => return Some(Kind::Loop),
            "oneshot" | "oneshots" | "shot" | "shots" | "hit" | "hits" | "single" => hint = Some(Kind::OneShot),
            _ => {}
        }
    }
    hint
}

fn tags_of(words: &[String]) -> Vec<&'static str> {
    let mut tags: Vec<&'static str> = Vec::new();
    for w in joined_words(words) {
        if let Some((_, tag)) = TAG_WORDS.iter().find(|(k, _)| *k == w) {
            if !tags.contains(tag) {
                tags.push(tag);
            }
        }
    }
    tags
}

fn parse_bpm_number(s: &str) -> Option<f64> {
    let v: f64 = s.replace(',', ".").parse().ok()?;
    (MIN_BPM..=MAX_BPM).contains(&v).then_some(v)
}

/// Reads tempo, key, kind, category and tags from a file stem and its folder path
/// (folders relative to the library root, outermost first).
pub fn parse_name(stem: &str, dirs: &[&str]) -> NameMeta {
    let tokens = raw_tokens(stem);
    let stem_words = search_words(stem);

    let bpm_explicit = BPM_EXPLICIT
        .captures_iter(stem)
        .filter_map(|c| c.get(1).or_else(|| c.get(2)).and_then(|m| parse_bpm_number(m.as_str())))
        .next()
        .or_else(|| {
            // A folder called "124 BPM" applies to everything inside it.
            dirs.iter().rev().find_map(|d| {
                BPM_EXPLICIT.captures(d).and_then(|c| c.get(1).or_else(|| c.get(2))).and_then(|m| parse_bpm_number(m.as_str()))
            })
        });

    let bpm_candidates: Vec<f64> = tokens
        .iter()
        .enumerate()
        .filter(|(i, t)| {
            let prev = if *i > 0 { tokens[i - 1].to_ascii_lowercase() } else { String::new() };
            t.chars().all(|c| c.is_ascii_digit())
                && !t.starts_with('0')
                && !matches!(prev.as_str(), "vol" | "volume" | "v" | "no" | "take" | "part" | "pt" | "kit" | "track")
        })
        .filter_map(|(_, t)| parse_bpm_number(t))
        .rev()
        .collect();

    let key = find_key(&tokens).or_else(|| {
        dirs.iter().rev().find_map(|d| {
            let k = find_key(&raw_tokens(d))?;
            // Folder names like "A" or "Bank B" are rarely keys; require an explicit form.
            (k.mode != Mode::Note).then_some(k)
        })
    });

    let dir_words: Vec<Vec<String>> = dirs.iter().rev().map(|d| search_words(d)).collect();

    let kind_hint = kind_of(&stem_words).or_else(|| dir_words.iter().find_map(|w| kind_of(w)));
    let category = category_of(&stem_words).or_else(|| dir_words.iter().find_map(|w| category_of(w)));

    let mut tags = tags_of(&stem_words);
    for w in &dir_words {
        for t in tags_of(w) {
            if !tags.contains(&t) {
                tags.push(t);
            }
        }
    }

    let mut words = stem_words;
    for w in dir_words.into_iter().flatten() {
        if !words.contains(&w) {
            words.push(w);
        }
    }

    NameMeta { bpm_explicit, bpm_candidates, key, kind_hint, category, tags, words }
}

/// True when `duration` is close to a whole number of bars (or half bars) at `bpm`.
pub fn fits_bars(bpm: f64, duration: f64) -> bool {
    let beats = duration * bpm / 60.0;
    if beats < 1.8 {
        return false;
    }
    let unit = if beats < 8.0 { 2.0 } else { 4.0 };
    let nearest = (beats / unit).round() * unit;
    nearest > 0.0 && ((beats - nearest).abs() / nearest < 0.02 || (beats - nearest).abs() < 0.06)
}

/// Combines name, embedded metadata and duration into the values stored for a sample.
pub fn resolve(name: &NameMeta, chunk: &ChunkMeta, duration: Option<f64>) -> Resolved {
    // Loop or one-shot: embedded flags beat words, words beat heuristics.
    let chunk_kind = chunk.one_shot.map(|one| if one { Kind::OneShot } else { Kind::Loop });

    let chunk_tempo = chunk.tempo.or_else(|| {
        let beats = chunk.beats? as f64;
        let d = duration?;
        (beats > 0.0 && d > 0.0).then(|| beats / d * 60.0)
    });
    let chunk_tempo = chunk_tempo.filter(|t| (MIN_BPM..=MAX_BPM).contains(t)).map(|t| (t * 100.0).round() / 100.0);

    let said_loop = name.kind_hint == Some(Kind::Loop);
    let candidate = name.bpm_candidates.iter().copied().find(|&b| duration.is_some_and(|d| fits_bars(b, d))).or_else(|| {
        // A file that calls itself a loop gets the benefit of the doubt (tails, pickups),
        // as long as it lasts at least a couple of beats at that tempo.
        said_loop
            .then(|| name.bpm_candidates.first().copied())
            .flatten()
            .filter(|&b| duration.is_none_or(|d| d * b / 60.0 >= 1.8))
    });

    let (mut bpm, mut bpm_source) = if let Some(b) = name.bpm_explicit {
        (Some(b), Source::Name)
    } else if let Some(t) = chunk_tempo.filter(|_| chunk_kind != Some(Kind::OneShot)) {
        (Some(t), Source::Metadata)
    } else if let Some(b) = candidate {
        (Some(b), Source::Name)
    } else {
        (None, Source::None)
    };

    let guessed = match (bpm, duration) {
        (Some(_), _) => Kind::Loop,
        (None, Some(d)) if d >= 3.0 => Kind::Loop,
        _ => Kind::OneShot,
    };
    let kind = chunk_kind.or(name.kind_hint).unwrap_or(guessed);

    if kind == Kind::OneShot && bpm_source != Source::Metadata && name.bpm_explicit.is_none() {
        bpm = None;
        bpm_source = Source::None;
    }

    let (mut key, key_source) = if let Some(k) = name.key {
        (Some(k), Source::Name)
    } else if let Some(root) = chunk.root_note {
        let mode = chunk.scale.unwrap_or(Mode::Note);
        (Some(Key::new(root as i32, mode)), Source::Metadata)
    } else {
        (None, Source::None)
    };
    // "Loop_128_C" means C major; a lone note on a one-shot is its root.
    if kind == Kind::Loop {
        if let Some(k) = key.as_mut() {
            if k.mode == Mode::Note {
                k.mode = Mode::Major;
            }
        }
    }

    let category = name.category.or(if kind == Kind::Loop && is_drum_break(name) { Some("Drums") } else { None });

    Resolved { bpm, bpm_source, key, key_source, kind, category, tags: name.tags.clone() }
}

fn is_drum_break(name: &NameMeta) -> bool {
    name.words.iter().any(|w| w == "amen" || w == "breakbeat")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve_name(stem: &str, dirs: &[&str], dur: Option<f64>) -> Resolved {
        resolve(&parse_name(stem, dirs), &ChunkMeta::default(), dur)
    }

    #[test]
    fn tokens_keep_keys_and_split_numbers() {
        assert_eq!(raw_tokens("124BPM_F#m"), vec!["124", "BPM", "F#m"]);
        assert_eq!(raw_tokens("Kick 808s-Long"), vec!["Kick", "808s", "Long"]);
        assert_eq!(raw_tokens("Loop120Am"), vec!["Loop", "120", "Am"]);
        assert_eq!(raw_tokens("Cmaj7 chord"), vec!["Cmaj", "7", "chord"]);
    }

    #[test]
    fn search_words_split_camel_case() {
        let w = search_words("LoFi_Keys");
        assert!(w.contains(&"lofi".to_string()));
        assert!(w.contains(&"lo".to_string()));
        assert!(w.contains(&"fi".to_string()));
        assert!(w.contains(&"keys".to_string()));
    }

    #[test]
    fn loops_with_tempo_and_key() {
        let r = resolve_name("Nightdrive_Bass_Loop_124_Am", &["Nightdrive Synthwave", "Loops"], Some(7.742));
        assert_eq!(r.bpm, Some(124.0));
        assert_eq!(r.key.unwrap().name(), "Am");
        assert_eq!(r.kind, Kind::Loop);
        assert_eq!(r.category, Some("Bass"));
    }

    #[test]
    fn explicit_bpm_forms() {
        assert_eq!(parse_name("groove 92bpm dusty", &[]).bpm_explicit, Some(92.0));
        assert_eq!(parse_name("groove_bpm128", &[]).bpm_explicit, Some(128.0));
        assert_eq!(parse_name("Perc Loop 123.5 BPM", &[]).bpm_explicit, Some(123.5));
        assert_eq!(parse_name("Top", &["Drums", "124 BPM"]).bpm_explicit, Some(124.0));
    }

    #[test]
    fn bare_numbers_need_a_matching_duration() {
        // 101 is a sample number here: 0.5 s is nowhere near whole bars at 101 BPM.
        let r = resolve_name("Snare_101", &[], Some(0.5));
        assert_eq!(r.bpm, None);
        assert_eq!(r.kind, Kind::OneShot);
        assert_eq!(r.category, Some("Snare"));
        // Two bars at 90 BPM.
        let r = resolve_name("Boombap_Drums_90", &[], Some(5.333));
        assert_eq!(r.bpm, Some(90.0));
        assert_eq!(r.kind, Kind::Loop);
        assert_eq!(r.category, Some("Drums"));
    }

    #[test]
    fn one_shots_and_root_notes() {
        let r = resolve_name("Bass_Shot_Reese_A", &["One Shots"], Some(2.1));
        assert_eq!(r.kind, Kind::OneShot);
        assert_eq!(r.key.unwrap().mode, Mode::Note);
        assert_eq!(r.key.unwrap().name(), "A");
        let r = resolve_name("Chord_Stabs_128_C", &["Loops"], Some(7.5));
        assert_eq!(r.key.unwrap().name(), "C");
        assert_eq!(r.key.unwrap().mode, Mode::Major);
    }

    #[test]
    fn categories_prefer_specific_parts() {
        assert_eq!(resolve_name("808_Kick_Long", &[], Some(1.0)).category, Some("Kick"));
        assert_eq!(resolve_name("Piano_Chords_Loop", &[], Some(8.0)).category, Some("Keys"));
        assert_eq!(resolve_name("Hat_Loop_125", &[], Some(7.68)).category, Some("Hat"));
        assert_eq!(resolve_name("Bass Drum 03", &[], Some(0.4)).category, Some("Kick"));
        assert_eq!(resolve_name("Take 3", &["Vocals", "Chops"], Some(3.0)).category, Some("Vocal"));
    }

    #[test]
    fn tags_from_name_and_folders() {
        let m = parse_name("Lo-Fi_Dusty_Keys_Loop", &["Hip Hop Essentials"]);
        assert!(m.tags.contains(&"lofi"));
        assert!(m.tags.contains(&"dusty"));
        assert!(m.tags.contains(&"hiphop"));
    }

    #[test]
    fn embedded_metadata_fills_gaps() {
        let chunk = ChunkMeta { tempo: Some(97.0), one_shot: Some(false), root_note: Some(2), scale: Some(Mode::Minor), ..Default::default() };
        let r = resolve(&parse_name("Recording 12", &[]), &chunk, Some(9.9));
        assert_eq!(r.bpm, Some(97.0));
        assert_eq!(r.bpm_source, Source::Metadata);
        assert_eq!(r.key.unwrap().name(), "Dm");
        assert_eq!(r.kind, Kind::Loop);
    }
}

/// Parser report over a real library, names only (no decoding):
/// `SAGA_SCAN_DIR=/path cargo test --lib meta::report -- --ignored --nocapture`
#[cfg(test)]
mod report {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    #[ignore]
    fn name_parser_report() {
        let Ok(root) = std::env::var("SAGA_SCAN_DIR") else { return };
        let root = std::path::PathBuf::from(root);
        let mut total = 0usize;
        let mut kinds = BTreeMap::new();
        let mut cats: BTreeMap<&str, usize> = BTreeMap::new();
        let (mut with_bpm, mut with_key, mut loops) = (0usize, 0usize, 0usize);
        let mut shown = Vec::new();
        for e in walkdir::WalkDir::new(&root).into_iter().filter_map(Result::ok) {
            let p = e.path();
            if !e.file_type().is_file() || !crate::decode::is_audio_path(p) {
                continue;
            }
            total += 1;
            let stem = p.file_stem().unwrap().to_string_lossy().to_string();
            let rel = p.parent().unwrap().strip_prefix(&root).unwrap().to_string_lossy().to_string();
            let dirs: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
            let r = resolve(&parse_name(&stem, &dirs), &ChunkMeta::default(), None);
            *kinds.entry(format!("{:?}", r.kind)).or_insert(0usize) += 1;
            *cats.entry(r.category.unwrap_or("(none)")).or_default() += 1;
            if r.kind == Kind::Loop {
                loops += 1;
                if r.bpm.is_some() {
                    with_bpm += 1;
                }
            }
            if r.key.is_some() {
                with_key += 1;
            }
            if total.is_multiple_of(97) && shown.len() < 70 {
                shown.push(format!(
                    "{:<58} | {:<7?} {:>5} {:<4} {:<7} {:?} | {}",
                    stem.chars().take(58).collect::<String>(),
                    r.kind,
                    r.bpm.map(|b| b.to_string()).unwrap_or_default(),
                    r.key.map(|k| k.name().to_string()).unwrap_or_default(),
                    r.category.unwrap_or("-"),
                    r.tags,
                    dirs.last().unwrap_or(&"")
                ));
            }
        }
        // Most common words among uncategorized files, and loops that got no tempo.
        let mut words: BTreeMap<String, usize> = BTreeMap::new();
        let mut no_bpm = Vec::new();
        for e in walkdir::WalkDir::new(&root).into_iter().filter_map(Result::ok) {
            let p = e.path();
            if !e.file_type().is_file() || !crate::decode::is_audio_path(p) {
                continue;
            }
            let stem = p.file_stem().unwrap().to_string_lossy().to_string();
            let rel = p.parent().unwrap().strip_prefix(&root).unwrap().to_string_lossy().to_string();
            let dirs: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
            let m = parse_name(&stem, &dirs);
            let r = resolve(&m, &ChunkMeta::default(), None);
            if r.category.is_none() {
                for w in search_words(&stem) {
                    if w.chars().any(|c| c.is_alphabetic()) && w.len() > 2 {
                        *words.entry(w).or_default() += 1;
                    }
                }
            }
            if r.kind == Kind::Loop && r.bpm.is_none() && no_bpm.len() < 25 {
                no_bpm.push(format!("{stem}  [{}]", dirs.join("/")));
            }
        }
        let mut top: Vec<_> = words.into_iter().collect();
        top.sort_by(|a, b| b.1.cmp(&a.1));
        println!("uncategorized words: {:?}", &top[..top.len().min(60)]);
        println!("loops without tempo:");
        for l in no_bpm {
            println!("  {l}");
        }
        println!("files: {total}  kinds: {kinds:?}");
        println!("loops with tempo: {with_bpm}/{loops}   files with key: {with_key}");
        println!("categories: {cats:?}");
        for s in shown {
            println!("{s}");
        }
    }
}
