//! Loop metadata embedded in audio containers: ACID and `smpl` chunks in WAV,
//! Apple Loops `basc`/`INST` chunks in AIFF, and the `info` chunk in CAF.

use crate::keys::Mode;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChunkMeta {
    pub tempo: Option<f64>,
    /// Number of beats in the file, when the container stores beats instead of tempo.
    pub beats: Option<u32>,
    pub one_shot: Option<bool>,
    /// Root pitch class (0 = C).
    pub root_note: Option<u8>,
    pub scale: Option<Mode>,
}

const MAX_CHUNKS: usize = 64;
const MAX_META_CHUNK: u64 = 64 * 1024;

pub fn read_chunk_meta(path: &Path) -> ChunkMeta {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let Ok(file) = File::open(path) else { return ChunkMeta::default() };
    let mut r = BufReader::new(file);
    let result = match ext.as_str() {
        "wav" | "wave" => read_wav(&mut r),
        "aif" | "aiff" | "aifc" => read_aiff(&mut r),
        "caf" => read_caf(&mut r),
        _ => None,
    };
    result.unwrap_or_default()
}

fn u16_le(b: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(o..o + 2)?.try_into().ok()?))
}
fn u32_le(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?))
}
fn f32_le(b: &[u8], o: usize) -> Option<f32> {
    Some(f32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?))
}
fn u16_be(b: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_be_bytes(b.get(o..o + 2)?.try_into().ok()?))
}
fn u32_be(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(o..o + 4)?.try_into().ok()?))
}

fn read_chunk<R: Read + Seek>(r: &mut R, size: u64) -> Option<Vec<u8>> {
    if size > MAX_META_CHUNK {
        r.seek(SeekFrom::Current(size as i64)).ok()?;
        return Some(Vec::new());
    }
    let mut buf = vec![0u8; size as usize];
    r.read_exact(&mut buf).ok()?;
    Some(buf)
}

fn read_wav<R: Read + Seek>(r: &mut R) -> Option<ChunkMeta> {
    let mut header = [0u8; 12];
    r.read_exact(&mut header).ok()?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return None;
    }
    let mut meta = ChunkMeta::default();
    let mut smpl_root: Option<u8> = None;
    for _ in 0..MAX_CHUNKS {
        let mut ch = [0u8; 8];
        if r.read_exact(&mut ch).is_err() {
            break;
        }
        let id = &ch[0..4];
        let size = u32::from_le_bytes(ch[4..8].try_into().ok()?) as u64;
        let padded = size + (size & 1);
        match id {
            b"acid" => {
                let b = read_chunk(r, padded)?;
                let flags = u32_le(&b, 0)?;
                let root = u16_le(&b, 4)?;
                let beats = u32_le(&b, 12)?;
                let tempo = f32_le(&b, 20)?;
                meta.one_shot = Some(flags & 0x01 != 0);
                if flags & 0x02 != 0 && (1..=127).contains(&root) {
                    meta.root_note = Some((root % 12) as u8);
                }
                if tempo.is_finite() && tempo > 0.0 {
                    meta.tempo = Some(tempo as f64);
                }
                if beats > 0 {
                    meta.beats = Some(beats);
                }
            }
            b"smpl" => {
                let b = read_chunk(r, padded)?;
                // MIDI unity note 60 is the default most tools write, so it says nothing.
                if let Some(note) = u32_le(&b, 12) {
                    if note != 60 && note < 128 {
                        smpl_root = Some((note % 12) as u8);
                    }
                }
            }
            _ => {
                r.seek(SeekFrom::Current(padded as i64)).ok()?;
            }
        }
    }
    if meta.root_note.is_none() {
        meta.root_note = smpl_root;
    }
    Some(meta)
}

fn read_aiff<R: Read + Seek>(r: &mut R) -> Option<ChunkMeta> {
    let mut header = [0u8; 12];
    r.read_exact(&mut header).ok()?;
    if &header[0..4] != b"FORM" || (&header[8..12] != b"AIFF" && &header[8..12] != b"AIFC") {
        return None;
    }
    let mut meta = ChunkMeta::default();
    let mut inst_root: Option<u8> = None;
    for _ in 0..MAX_CHUNKS {
        let mut ch = [0u8; 8];
        if r.read_exact(&mut ch).is_err() {
            break;
        }
        let id = &ch[0..4];
        let size = u32::from_be_bytes(ch[4..8].try_into().ok()?) as u64;
        let padded = size + (size & 1);
        match id {
            b"basc" => {
                let b = read_chunk(r, padded)?;
                // version, beats, root note, scale type, sig num, sig denom, loop type
                let beats = u32_be(&b, 4)?;
                let root = u16_be(&b, 8)?;
                let scale = u16_be(&b, 10)?;
                let loop_type = u16_be(&b, 16).unwrap_or(0);
                if beats > 0 {
                    meta.beats = Some(beats);
                }
                if (1..=127).contains(&root) {
                    meta.root_note = Some((root % 12) as u8);
                }
                meta.scale = match scale {
                    1 => Some(Mode::Minor),
                    2 => Some(Mode::Major),
                    _ => None,
                };
                meta.one_shot = match loop_type {
                    1 => Some(false),
                    2 => Some(true),
                    _ => None,
                };
            }
            b"INST" => {
                let b = read_chunk(r, padded)?;
                if let Some(&note) = b.first() {
                    if note != 60 && note < 128 {
                        inst_root = Some(note % 12);
                    }
                }
            }
            _ => {
                r.seek(SeekFrom::Current(padded as i64)).ok()?;
            }
        }
    }
    if meta.root_note.is_none() {
        meta.root_note = inst_root;
    }
    Some(meta)
}

fn read_caf<R: Read + Seek>(r: &mut R) -> Option<ChunkMeta> {
    let mut header = [0u8; 8];
    r.read_exact(&mut header).ok()?;
    if &header[0..4] != b"caff" {
        return None;
    }
    let mut meta = ChunkMeta::default();
    for _ in 0..MAX_CHUNKS {
        let mut ch = [0u8; 12];
        if r.read_exact(&mut ch).is_err() {
            break;
        }
        let id = &ch[0..4];
        let size = i64::from_be_bytes(ch[4..12].try_into().ok()?);
        if size < 0 {
            // -1 marks an audio chunk that runs to the end of the file.
            break;
        }
        if id == b"info" {
            let b = read_chunk(r, size as u64)?;
            let mut strings = b.get(4..)?.split(|&c| c == 0).map(|s| String::from_utf8_lossy(s).to_string());
            while let (Some(k), Some(v)) = (strings.next(), strings.next()) {
                match k.as_str() {
                    "tempo" => meta.tempo = v.trim().parse::<f64>().ok().filter(|t| *t > 0.0),
                    "key signature" => {
                        if let Some(key) = crate::keys::parse_user_key(&v) {
                            meta.root_note = Some(key.pc);
                            meta.scale = Some(key.mode);
                        }
                    }
                    _ => {}
                }
            }
        } else {
            r.seek(SeekFrom::Current(size)).ok()?;
        }
    }
    Some(meta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn wav_with_acid(flags: u32, root: u16, tempo: f32) -> Vec<u8> {
        let mut fmt = Vec::new();
        fmt.extend_from_slice(&1u16.to_le_bytes()); // PCM
        fmt.extend_from_slice(&1u16.to_le_bytes()); // mono
        fmt.extend_from_slice(&44100u32.to_le_bytes());
        fmt.extend_from_slice(&88200u32.to_le_bytes());
        fmt.extend_from_slice(&2u16.to_le_bytes());
        fmt.extend_from_slice(&16u16.to_le_bytes());
        let mut acid = Vec::new();
        acid.extend_from_slice(&flags.to_le_bytes());
        acid.extend_from_slice(&root.to_le_bytes());
        acid.extend_from_slice(&0x8000u16.to_le_bytes());
        acid.extend_from_slice(&0f32.to_le_bytes());
        acid.extend_from_slice(&8u32.to_le_bytes());
        acid.extend_from_slice(&4u16.to_le_bytes());
        acid.extend_from_slice(&4u16.to_le_bytes());
        acid.extend_from_slice(&tempo.to_le_bytes());
        let data = vec![0u8; 400];
        let mut body = Vec::new();
        body.extend_from_slice(b"WAVE");
        for (id, chunk) in [(b"fmt ", &fmt), (b"data", &data), (b"acid", &acid)] {
            body.extend_from_slice(id);
            body.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
            body.extend_from_slice(chunk);
        }
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn reads_acid_loop_info() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("loop.wav");
        std::fs::File::create(&p).unwrap().write_all(&wav_with_acid(0x02, 57, 128.0)).unwrap();
        let m = read_chunk_meta(&p);
        assert_eq!(m.tempo, Some(128.0));
        assert_eq!(m.one_shot, Some(false));
        assert_eq!(m.root_note, Some(9));
        assert_eq!(m.beats, Some(8));
    }

    #[test]
    fn reads_acid_one_shot_flag() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("hit.wav");
        std::fs::File::create(&p).unwrap().write_all(&wav_with_acid(0x01, 60, 0.0)).unwrap();
        let m = read_chunk_meta(&p);
        assert_eq!(m.one_shot, Some(true));
        assert_eq!(m.tempo, None);
        assert_eq!(m.root_note, None);
    }

    #[test]
    fn reads_apple_loops_basc() {
        let mut basc = Vec::new();
        basc.extend_from_slice(&1u32.to_be_bytes());
        basc.extend_from_slice(&16u32.to_be_bytes());
        basc.extend_from_slice(&62u16.to_be_bytes()); // D
        basc.extend_from_slice(&1u16.to_be_bytes()); // minor
        basc.extend_from_slice(&4u16.to_be_bytes());
        basc.extend_from_slice(&4u16.to_be_bytes());
        basc.extend_from_slice(&1u16.to_be_bytes()); // loop
        let mut body = Vec::new();
        body.extend_from_slice(b"AIFF");
        body.extend_from_slice(b"basc");
        body.extend_from_slice(&(basc.len() as u32).to_be_bytes());
        body.extend_from_slice(&basc);
        let mut out = Vec::new();
        out.extend_from_slice(b"FORM");
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(&body);
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("loop.aif");
        std::fs::write(&p, out).unwrap();
        let m = read_chunk_meta(&p);
        assert_eq!(m.beats, Some(16));
        assert_eq!(m.root_note, Some(2));
        assert_eq!(m.scale, Some(Mode::Minor));
        assert_eq!(m.one_shot, Some(false));
    }
}
