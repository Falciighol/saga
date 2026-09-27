//! Musical keys: parsing from file name tokens, display names, Camelot codes
//! and harmonic compatibility.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Mode {
    Major = 0,
    Minor = 1,
    /// A single root note with no scale (typical for pitched one-shots).
    Note = 2,
}

impl Mode {
    pub fn from_i64(v: i64) -> Option<Mode> {
        match v {
            0 => Some(Mode::Major),
            1 => Some(Mode::Minor),
            2 => Some(Mode::Note),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Key {
    /// Pitch class, 0 = C … 11 = B.
    pub pc: u8,
    pub mode: Mode,
}

const MAJOR_NAMES: [&str; 12] = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_NAMES: [&str; 12] = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"];
const NOTE_NAMES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

impl Key {
    pub fn new(pc: i32, mode: Mode) -> Key {
        Key { pc: pc.rem_euclid(12) as u8, mode }
    }

    pub fn from_db(pc: Option<i64>, mode: Option<i64>) -> Option<Key> {
        Some(Key::new(pc? as i32, Mode::from_i64(mode?)?))
    }

    pub fn name(&self) -> &'static str {
        let i = self.pc as usize;
        match self.mode {
            Mode::Major => MAJOR_NAMES[i],
            Mode::Minor => MINOR_NAMES[i],
            Mode::Note => NOTE_NAMES[i],
        }
    }

    /// Camelot wheel position (1–12) and letter (A = minor, B = major).
    pub fn camelot(&self) -> Option<(u8, char)> {
        let minor_pc = match self.mode {
            Mode::Minor => self.pc as i32,
            Mode::Major => self.pc as i32 - 3,
            Mode::Note => return None,
        };
        // A minor is 8A; each step round the wheel is a fifth (7 semitones), and 7 is its own inverse mod 12.
        let steps = ((minor_pc - 9).rem_euclid(12) * 7).rem_euclid(12);
        let number = ((7 + steps) % 12 + 1) as u8;
        Some((number, if self.mode == Mode::Minor { 'A' } else { 'B' }))
    }

    /// Keys that mix harmonically with this one: itself, its neighbours a fifth
    /// either side, and its relative major/minor (the Camelot "±1 or swap letter" rule).
    pub fn compatible(&self) -> Vec<Key> {
        let pc = self.pc as i32;
        match self.mode {
            Mode::Minor => vec![
                Key::new(pc, Mode::Minor),
                Key::new(pc + 7, Mode::Minor),
                Key::new(pc + 5, Mode::Minor),
                Key::new(pc + 3, Mode::Major),
            ],
            Mode::Major => vec![
                Key::new(pc, Mode::Major),
                Key::new(pc + 7, Mode::Major),
                Key::new(pc + 5, Mode::Major),
                Key::new(pc + 9, Mode::Minor),
            ],
            Mode::Note => vec![*self],
        }
    }

    /// Pitch classes of the key's diatonic scale.
    pub fn scale(&self) -> Vec<u8> {
        let steps: &[i32] = match self.mode {
            Mode::Minor => &[0, 2, 3, 5, 7, 8, 10],
            Mode::Major => &[0, 2, 4, 5, 7, 9, 11],
            Mode::Note => &[0],
        };
        steps.iter().map(|s| (self.pc as i32 + s).rem_euclid(12) as u8).collect()
    }
}

/// Pitch classes of a scale given as semitones above `pc`, without repeats.
pub fn scale_notes(pc: u8, intervals: &[u8]) -> Vec<u8> {
    let mut notes: Vec<u8> = Vec::with_capacity(intervals.len());
    for i in intervals {
        let n = ((pc as i32 + *i as i32).rem_euclid(12)) as u8;
        if !notes.contains(&n) {
            notes.push(n);
        }
    }
    notes
}

/// Pitch classes as a 12-bit mask, bit 0 = C.
pub fn pc_mask(notes: &[u8]) -> u16 {
    notes.iter().fold(0, |m, n| m | 1 << (n % 12))
}

/// Least `scale_fit` for a sample with no key to count as fitting a scale by its notes.
/// On ~450 loops from real packs whose names state a key, 65% fit their own key this well,
/// against 3% for the key a tritone away and 2% of ~340 drum and effect sounds (see
/// `detect::report::scale_fit_report`). Stored profiles count every spectral peak, overtones
/// included, so even a loop squarely in its key keeps a fair share of energy outside it.
pub const MIN_SCALE_FIT: f32 = 0.2;

/// How well a pitch profile sits inside a set of notes: 0 when no more of its energy falls on
/// them than would on any notes of the same count (a noise burst), 1 when all of it does.
/// None for a silent profile. Mirrors `scaleFit` in src/lib/theory.ts.
pub fn scale_fit(chroma: &[f32; 12], mask: u16) -> Option<f32> {
    let total: f32 = chroma.iter().sum();
    let n = (mask & 0xFFF).count_ones() as f32;
    if !(total > 0.0) || n == 0.0 {
        return None;
    }
    if n >= 12.0 {
        return Some(1.0);
    }
    let inside = (0..12).filter(|i| mask & 1 << i != 0).map(|i| chroma[i]).sum::<f32>() / total;
    let chance = n / 12.0;
    Some(((inside - chance) / (1.0 - chance)).clamp(0.0, 1.0))
}

/// Major and minor keys whose notes hold the scale: every note of a scale of five notes or
/// fewer, all but one of a longer one. For a mode that's its parent key and relative, plus the
/// keys a fifth either side (A Dorian: G, Em, C, Am, D, Bm).
pub fn fitting_keys(pc: u8, intervals: &[u8]) -> Vec<Key> {
    let notes = scale_notes(pc, intervals);
    let need = if notes.len() <= 5 { notes.len() } else { (notes.len() - 1).min(7) };
    (0..12)
        .flat_map(|p| [Key::new(p, Mode::Major), Key::new(p, Mode::Minor)])
        .filter(|k| {
            let s = k.scale();
            notes.iter().filter(|n| s.contains(n)).count() >= need
        })
        .collect()
}

fn letter_pc(c: char) -> Option<i32> {
    Some(match c.to_ascii_uppercase() {
        'C' => 0,
        'D' => 2,
        'E' => 4,
        'F' => 5,
        'G' => 7,
        'A' => 9,
        'B' => 11,
        _ => return None,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Quality {
    None,
    Minor,
    Major,
}

fn parse_quality(s: &str) -> Option<Quality> {
    if s.is_empty() {
        return Some(Quality::None);
    }
    // Only a lowercase "m" means minor: "FM"/"AM" are far more often synthesis or radio than keys.
    if s == "m" {
        return Some(Quality::Minor);
    }
    if s == "M" {
        return None;
    }
    let lower = s.to_ascii_lowercase();
    let trimmed = lower.trim_end_matches(|c: char| c.is_ascii_digit());
    match trimmed {
        "m" | "min" | "minor" | "mi" | "moll" => Some(Quality::Minor),
        "maj" | "major" | "ma" | "dur" => Some(Quality::Major),
        _ => None,
    }
}

/// Parses a single token such as `Am`, `F#min`, `Bb`, `Cmaj7`, `c#m`.
/// Returns the key and whether it was written with an explicit quality or accidental
/// (which makes it much less likely to be an ordinary word or a variation letter).
fn parse_key_token(token: &str) -> Option<(i32, Quality, bool)> {
    let mut chars = token.chars().peekable();
    let first = chars.next()?;
    let mut pc = letter_pc(first)?;
    let rest: String = chars.collect();
    let (accidental, after) = if let Some(r) = rest.strip_prefix('#').or_else(|| rest.strip_prefix('♯')) {
        (1, r)
    } else if let Some(r) = rest.strip_prefix("sharp") {
        (1, r)
    } else if let Some(r) = rest.strip_prefix('♭') {
        (-1, r)
    } else if let Some(r) = rest.strip_prefix("flat") {
        (-1, r)
    } else if rest.starts_with('b') && parse_quality(&rest[1..]).is_some() {
        (-1, &rest[1..])
    } else {
        (0, rest.as_str())
    };
    pc += accidental;
    let quality = parse_quality(after)?;
    let explicit = accidental != 0 || quality != Quality::None;
    // A lowercase note letter is only trusted with an accidental or an explicit quality ("f#m", "amin").
    if first.is_ascii_lowercase() && !explicit {
        return None;
    }
    // Lowercase bare "am"/"bm" are too often words or abbreviations.
    if first.is_ascii_lowercase() && accidental == 0 && after == "m" {
        return None;
    }
    Some((pc, quality, explicit))
}

const VARIATION_WORDS: &[&str] = &[
    "take", "var", "variation", "version", "v", "alt", "part", "pt", "mix", "side", "section", "ver", "no",
    "vol", "volume", "kit", "bank", "layer", "group", "round", "rr", "velocity", "vel",
];

fn is_number(t: &str) -> bool {
    !t.is_empty() && t.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// Finds the most plausible key in a list of tokens (already split on separators).
/// Scans from the end because packs conventionally put tempo and key last.
pub fn find_key(tokens: &[String]) -> Option<Key> {
    let n = tokens.len();
    for i in (0..n).rev() {
        let tok = tokens[i].as_str();
        let Some((pc, mut quality, explicit)) = parse_key_token(tok) else { continue };
        // "A minor", "C maj" written as two tokens.
        let mut explicit = explicit;
        if quality == Quality::None && i + 1 < n {
            if let Some(q) = parse_quality(&tokens[i + 1]) {
                if q != Quality::None && tokens[i + 1].len() > 1 {
                    quality = q;
                    explicit = true;
                }
            }
        }
        let prev = if i > 0 { tokens[i - 1].to_ascii_lowercase() } else { String::new() };
        if !explicit {
            // A bare letter ("Kick_A") is only a key when it closes the name, sits next to a
            // tempo, and is not a variation marker ("Take_A", "Vol_B").
            let next_is_bpm = i + 1 < n && (is_number(&tokens[i + 1]) || tokens[i + 1].eq_ignore_ascii_case("bpm"));
            let prev_is_number = is_number(&prev);
            let last = i == n - 1;
            if VARIATION_WORDS.contains(&prev.as_str()) || n < 2 {
                continue;
            }
            if !(last || next_is_bpm || prev_is_number) {
                continue;
            }
        } else if quality == Quality::Minor && tok.len() == 2 && prev == "i" {
            // "I_Am_Free" — a lyric, not a key.
            continue;
        }
        let mode = match quality {
            Quality::Minor => Mode::Minor,
            Quality::Major => Mode::Major,
            Quality::None => Mode::Note,
        };
        return Some(Key::new(pc, mode));
    }
    None
}

/// Parses user input from the search box (`Am`, `F#m`, `8A`, `C`, `Ebmaj`).
pub fn parse_user_key(s: &str) -> Option<Key> {
    let s = s.trim();
    if let Some(key) = parse_camelot(s) {
        return Some(key);
    }
    let (pc, quality, _) = parse_key_token(s).or_else(|| {
        let mut c = s.chars();
        let first = c.next()?.to_ascii_uppercase();
        parse_key_token(&format!("{first}{}", c.as_str()))
    })?;
    Some(Key::new(
        pc,
        match quality {
            Quality::Minor => Mode::Minor,
            // A bare letter typed as a filter means the major key.
            Quality::Major | Quality::None => Mode::Major,
        },
    ))
}

fn parse_camelot(s: &str) -> Option<Key> {
    let s = s.to_ascii_uppercase();
    let letter = s.chars().last()?;
    if letter != 'A' && letter != 'B' {
        return None;
    }
    let number: i32 = s[..s.len() - 1].parse().ok()?;
    if !(1..=12).contains(&number) {
        return None;
    }
    // Invert Key::camelot: minor pc = 9 + 7 * (number - 8).
    let minor_pc = 9 + 7 * (number - 8);
    Some(if letter == 'A' { Key::new(minor_pc, Mode::Minor) } else { Key::new(minor_pc + 3, Mode::Major) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toks(s: &str) -> Vec<String> {
        s.split(['_', ' ', '-']).filter(|t| !t.is_empty()).map(String::from).collect()
    }

    #[test]
    fn camelot_codes() {
        assert_eq!(Key::new(9, Mode::Minor).camelot(), Some((8, 'A')));
        assert_eq!(Key::new(4, Mode::Minor).camelot(), Some((9, 'A')));
        assert_eq!(Key::new(2, Mode::Minor).camelot(), Some((7, 'A')));
        assert_eq!(Key::new(0, Mode::Major).camelot(), Some((8, 'B')));
        assert_eq!(Key::new(1, Mode::Minor).camelot(), Some((12, 'A')));
        assert_eq!(Key::new(8, Mode::Minor).camelot(), Some((1, 'A')));
        for n in 1..=12 {
            for l in ['A', 'B'] {
                let k = parse_camelot(&format!("{n}{l}")).unwrap();
                assert_eq!(k.camelot(), Some((n as u8, l)));
            }
        }
    }

    #[test]
    fn compatible_keys_of_a_minor() {
        let names: Vec<_> = Key::new(9, Mode::Minor).compatible().iter().map(|k| k.name()).collect();
        assert_eq!(names, vec!["Am", "Em", "Dm", "C"]);
    }

    #[test]
    fn keys_that_fit_a_scale() {
        let names = |pc, s: &[u8]| {
            let mut v: Vec<_> = fitting_keys(pc, s).iter().map(|k| k.name()).collect();
            v.sort();
            v
        };
        // A Dorian has the notes of G major.
        assert_eq!(names(9, &[0, 2, 3, 5, 7, 9, 10]), vec!["Am", "Bm", "C", "D", "Em", "G"]);
        // A minor pentatonic fits inside three relative pairs.
        assert_eq!(names(9, &[0, 3, 5, 7, 10]), vec!["Am", "C", "Dm", "Em", "F", "G"]);
        // Plain A minor: the keys that share at least six of its notes.
        assert_eq!(names(9, &[0, 2, 3, 5, 7, 8, 10]), vec!["Am", "C", "Dm", "Em", "F", "G"]);
        assert_eq!(scale_notes(11, &[0, 12, 1]), vec![11, 0]);
    }

    #[test]
    fn scale_fit_measures_energy_inside_the_notes_against_chance() {
        let a_minor = pc_mask(&scale_notes(9, &[0, 2, 3, 5, 7, 8, 10]));
        assert_eq!(a_minor, 0b1010_1011_0101);
        // A sound entirely on A, C and E fits A minor perfectly.
        let mut chord = [0f32; 12];
        chord[9] = 0.5;
        chord[0] = 0.3;
        chord[4] = 0.2;
        assert_eq!(scale_fit(&chord, a_minor), Some(1.0));
        // Spread evenly over all twelve notes, nothing fits better than chance.
        assert!(scale_fit(&[1.0 / 12.0; 12], a_minor).unwrap() < 1e-6);
        // Mostly outside: F♯ major (F♯, A♯, C♯) has nothing in A minor.
        let mut fs = [0.02f32; 12];
        fs[6] = 0.4;
        fs[10] = 0.2;
        fs[1] = 0.2;
        assert_eq!(scale_fit(&fs, a_minor), Some(0.0));
        // Half in, half out: a little better than chance for a five-note scale, worse than
        // chance for a seven-note one (which covers more of the twelve notes).
        let mut half = [0f32; 12];
        half[9] = 0.5;
        half[1] = 0.5;
        let pent = pc_mask(&scale_notes(9, &[0, 3, 5, 7, 10]));
        assert!((scale_fit(&half, pent).unwrap() - (0.5 - 5.0 / 12.0) / (7.0 / 12.0)).abs() < 1e-6);
        assert_eq!(scale_fit(&half, a_minor), Some(0.0));
        assert_eq!(scale_fit(&[0.0; 12], a_minor), None);
        assert_eq!(scale_fit(&chord, 0), None);
    }

    #[test]
    fn finds_keys_in_names() {
        let cases = [
            ("Nightdrive_Bass_Loop_124_Am", Some("Am")),
            ("LoFi_Keys_Rhodes_Loop_120_Em", Some("Em")),
            ("Pad_Ambient_Swell_118_F#m", Some("F#m")),
            ("Lead_Loop_124_Bbm", Some("Bbm")),
            ("Chord_Stabs_128_C", Some("C")),
            ("Bass_Shot_Reese_A", Some("A")),
            ("Loop 90 bpm A minor", Some("Am")),
            ("Piano_Cmaj7_Chord", Some("C")),
            ("synth_loop_f#min_128", Some("F#m")),
            ("Vocal_I_Am_Free", None),
            ("Kick_Take_A", None),
            ("DT2_Kick_Dusty_03", None),
            ("Snare_B", Some("B")),
            ("Amber_Vox_Chop", None),
            ("Break_Jungle_Chop_174", None),
        ];
        for (name, want) in cases {
            let got = find_key(&toks(name)).map(|k| k.name());
            assert_eq!(got, want, "{name}");
        }
        assert_eq!(find_key(&toks("Loop_128_C")).unwrap().mode, Mode::Note);
        assert_eq!(find_key(&toks("Loop_128_Cmaj")).unwrap().mode, Mode::Major);
    }

    #[test]
    fn parses_user_keys() {
        assert_eq!(parse_user_key("am"), Some(Key::new(9, Mode::Minor)));
        assert_eq!(parse_user_key("8A"), Some(Key::new(9, Mode::Minor)));
        assert_eq!(parse_user_key("C"), Some(Key::new(0, Mode::Major)));
        assert_eq!(parse_user_key("f#m"), Some(Key::new(6, Mode::Minor)));
        assert_eq!(parse_user_key("Eb"), Some(Key::new(3, Mode::Major)));
    }
}
