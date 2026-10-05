//! Streaming decode of any supported audio file to interleaved f32 frames.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;

pub const AUDIO_EXTENSIONS: &[&str] = &["wav", "wave", "aif", "aiff", "aifc", "flac", "mp3", "ogg", "oga", "m4a", "caf"];

pub fn is_audio_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

#[derive(Debug, Clone)]
pub struct StreamInfo {
    pub sample_rate: u32,
    pub channels: usize,
    pub bit_depth: Option<u32>,
    /// Total frames according to the container, when it says.
    pub frames_hint: Option<u64>,
}

/// AIFF chunks that Symphonia 0.6 allows only once but that carry no audio, so a repeat can be
/// hidden. COMM and SSND are left alone: two of those means the file really is broken.
const AIFF_ONCE_ONLY_METADATA: [[u8; 4]; 2] = [*b"COMT", *b"MARK"];
/// A tag Symphonia doesn't know, so it skips the chunk, as the RIFF spec says readers should.
const HIDDEN_TAG: [u8; 4] = *b"SAGA";

/// A RIFF or AIFF file seen through a few patched bytes. The file itself is never written.
///
/// The top-level (RIFF/FORM) length is set to cover every chunk that fits in the file, leaving
/// out a chunk that runs past the end and all after it. In an AIFF, repeats of a metadata chunk
/// that may appear only once get a tag Symphonia skips.
struct Patched {
    file: File,
    pos: u64,
    len: u64,
    /// Bytes laid over the file at these offsets.
    patches: Vec<(u64, [u8; 4])>,
}

impl Patched {
    /// `None` when `path` isn't a RIFF or AIFF file, or when nothing in it needs patching.
    fn open(path: &Path) -> io::Result<Option<Self>> {
        let mut file = File::open(path)?;
        let len = file.metadata()?.len();
        let mut head = [0u8; 12];
        if len < 12 {
            return Ok(None);
        }
        file.read_exact(&mut head)?;
        let big_endian = match &head[..4] {
            b"RIFF" => false,
            b"FORM" => true,
            _ => return Ok(None),
        };
        let u32_at = |b: &[u8]| {
            let b = [b[0], b[1], b[2], b[3]];
            if big_endian { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) }
        };
        let declared = u32_at(&head[4..8]);
        let mut patches = Vec::new();
        let mut seen = Vec::new();
        // Chunks start after the 12-byte header: tag, length, form type.
        let mut end = 12u64;
        let mut chunk = [0u8; 8];
        while end + 8 <= len {
            file.seek(SeekFrom::Start(end))?;
            file.read_exact(&mut chunk)?;
            let tag = [chunk[0], chunk[1], chunk[2], chunk[3]];
            let chunk_len = u64::from(u32_at(&chunk[4..]));
            if end + 8 + chunk_len > len {
                break;
            }
            if big_endian && AIFF_ONCE_ONLY_METADATA.contains(&tag) {
                if seen.contains(&tag) {
                    patches.push((end, HIDDEN_TAG));
                } else {
                    seen.push(tag);
                }
            }
            // Chunks are padded to an even length.
            end = (end + 8 + chunk_len + (chunk_len & 1)).min(len);
        }
        let fits = u32::try_from(end - 8).unwrap_or(u32::MAX);
        // A WAV length of u32::MAX means "unknown" (ffmpeg writing to a pipe), which Symphonia
        // already handles.
        if declared != fits && !(declared == u32::MAX && !big_endian) {
            patches.push((4, if big_endian { fits.to_be_bytes() } else { fits.to_le_bytes() }));
        }
        if patches.is_empty() {
            return Ok(None);
        }
        file.rewind()?;
        Ok(Some(Self { file, pos: 0, len, patches }))
    }
}

impl Read for Patched {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.file.read(buf)?;
        let (from, to) = (self.pos, self.pos + n as u64);
        for (at, bytes) in &self.patches {
            for i in (*at).max(from)..(at + 4).min(to) {
                buf[(i - from) as usize] = bytes[(i - at) as usize];
            }
        }
        self.pos = to;
        Ok(n)
    }
}

impl Seek for Patched {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.pos = self.file.seek(pos)?;
        Ok(self.pos)
    }
}

impl MediaSource for Patched {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }
}

/// Opens a format reader for `path`.
///
/// Symphonia 0.6 rejects some RIFF and AIFF files that 0.5 opened: a RIFF/FORM length that
/// leaves out the 4-byte form type ("WAVE"/"AIFF"), a broken chunk after the audio, or an AIFF
/// with two comment or marker chunks. When a file fails to open, Saga walks its chunks itself
/// and, if it finds one of these, opens it again through `Patched`. Files that open today never
/// take this path, and the check doesn't depend on Symphonia's error messages.
fn open_format(path: &Path) -> Result<Box<dyn FormatReader>, String> {
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probe = |source: Box<dyn MediaSource>| {
        symphonia::default::get_probe().probe(
            &hint,
            MediaSourceStream::new(source, Default::default()),
            FormatOptions::default(),
            MetadataOptions::default(),
        )
    };
    let file = File::open(path).map_err(|e| e.to_string())?;
    match probe(Box::new(file)) {
        Ok(reader) => Ok(reader),
        // The first error describes the file as it is, so it's the one reported.
        Err(first) => match Patched::open(path) {
            Ok(Some(patched)) => probe(Box::new(patched)).map_err(|_| first),
            _ => Err(first),
        },
    }
    .map_err(|e| format!("unsupported file: {e}"))
}

/// Decodes `path`, handing each block of interleaved samples to `sink`.
/// Stops early (without error) after `max_seconds` of audio.
/// Returns the stream info and the number of frames decoded.
pub fn decode<F>(path: &Path, max_seconds: Option<f64>, mut sink: F) -> Result<(StreamInfo, u64), String>
where
    F: FnMut(&StreamInfo, &[f32]),
{
    let mut format = open_format(path)?;
    let (track_id, frames_hint, params) = format
        .tracks()
        .iter()
        .find_map(|t| match &t.codec_params {
            Some(CodecParameters::Audio(p)) => Some((t.id, t.num_frames, p.clone())),
            _ => None,
        })
        .ok_or("no audio track")?;
    // Gapless is on by default: encoder delay and padding are trimmed.
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .map_err(|e| format!("unsupported codec: {e}"))?;

    let mut info = StreamInfo {
        sample_rate: params.sample_rate.ok_or("unknown sample rate")?,
        channels: params.channels.as_ref().map(|c| c.count()).unwrap_or(0),
        bit_depth: params.bits_per_sample.or(params.bits_per_coded_sample),
        frames_hint,
    };
    let mut samples: Vec<f32> = Vec::new();
    let mut frames: u64 = 0;

    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) | Err(SymError::IoError(_)) | Err(SymError::ResetRequired) => break,
            Err(e) if frames > 0 => {
                // A damaged tail shouldn't throw away what already decoded fine.
                let _ = e;
                break;
            }
            Err(e) => return Err(e.to_string()),
        };
        if packet.track_id != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue,
            Err(SymError::IoError(_)) => break,
            Err(e) => return Err(e.to_string()),
        };
        let ch = decoded.spec().channels().count().max(1);
        info.channels = ch;
        info.sample_rate = decoded.spec().rate();
        decoded.copy_to_vec_interleaved(&mut samples);
        let mut n = (samples.len() / ch) as u64;
        let max_frames = max_seconds.map(|s| (s * info.sample_rate as f64) as u64);
        if let Some(max) = max_frames {
            n = n.min(max.saturating_sub(frames));
        }
        if n > 0 {
            sink(&info, &samples[..(n as usize) * ch]);
            frames += n;
        }
        if max_frames.is_some_and(|m| frames >= m) {
            break;
        }
    }
    if frames == 0 {
        return Err("no audio frames".into());
    }
    Ok((info, frames))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAMES: u32 = 1000;

    fn wav_bytes(dir: &Path) -> Vec<u8> {
        let p = dir.join("source.wav");
        let spec = hound::WavSpec { channels: 1, sample_rate: 44100, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(&p, spec).unwrap();
        for i in 0..FRAMES {
            w.write_sample((i % 100) as i16).unwrap();
        }
        w.finalize().unwrap();
        std::fs::read(&p).unwrap()
    }

    /// One AIFF chunk: tag, big-endian length, body, and a pad byte when the body is odd.
    fn chunk(tag: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut c = tag.to_vec();
        c.extend_from_slice(&(body.len() as u32).to_be_bytes());
        c.extend_from_slice(body);
        if body.len() % 2 == 1 {
            c.push(0);
        }
        c
    }

    /// A mono 16-bit 44.1 kHz AIFF with `extra` chunks after the audio, its FORM length
    /// covering everything.
    fn aiff_bytes(extra: &[Vec<u8>]) -> Vec<u8> {
        let mut comm = 1u16.to_be_bytes().to_vec();
        comm.extend_from_slice(&FRAMES.to_be_bytes());
        comm.extend_from_slice(&16u16.to_be_bytes());
        // 44100 as an 80-bit extended float: exponent 16383 + 15, then the mantissa.
        comm.extend_from_slice(&[0x40, 0x0E, 0xAC, 0x44, 0, 0, 0, 0, 0, 0]);
        let mut ssnd = vec![0u8; 8];
        for i in 0..FRAMES {
            ssnd.extend_from_slice(&((i % 100) as i16).to_be_bytes());
        }
        let mut body = b"AIFF".to_vec();
        body.extend(chunk(b"COMM", &comm));
        body.extend(chunk(b"SSND", &ssnd));
        for c in extra {
            body.extend_from_slice(c);
        }
        let mut file = b"FORM".to_vec();
        file.extend_from_slice(&(body.len() as u32).to_be_bytes());
        file.extend(body);
        file
    }

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    /// Lowers the top-level length by 4, the way some writers leave out the form type.
    fn shorten_header(bytes: &mut [u8], big_endian: bool) {
        let b = [bytes[4], bytes[5], bytes[6], bytes[7]];
        let len = if big_endian { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) } - 4;
        bytes[4..8].copy_from_slice(&if big_endian { len.to_be_bytes() } else { len.to_le_bytes() });
    }

    fn decodes_fully(p: &Path) {
        let (info, frames) = decode(p, None, |_, _| {}).unwrap();
        assert_eq!((frames, info.sample_rate), (u64::from(FRAMES), 44100));
    }

    #[test]
    fn decodes_wav_whose_riff_length_misses_the_form_type() {
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = wav_bytes(dir.path());
        shorten_header(&mut bytes, false);
        decodes_fully(&write(dir.path(), "short-riff.wav", &bytes));
    }

    #[test]
    fn decodes_aiff_whose_form_length_misses_the_form_type() {
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = aiff_bytes(&[]);
        shorten_header(&mut bytes, true);
        decodes_fully(&write(dir.path(), "short-form.aif", &bytes));
    }

    #[test]
    fn decodes_aiff_with_a_broken_chunk_after_the_audio() {
        let dir = tempfile::tempdir().unwrap();
        // An APPL chunk that says it's 1000 bytes long but stops after 4.
        let mut broken = b"APPL".to_vec();
        broken.extend_from_slice(&1000u32.to_be_bytes());
        broken.extend_from_slice(b"abcd");
        decodes_fully(&write(dir.path(), "broken-tail.aif", &aiff_bytes(&[broken])));
    }

    #[test]
    fn decodes_aiff_with_two_comment_and_marker_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let comt = chunk(b"COMT", &0u16.to_be_bytes());
        let mark = chunk(b"MARK", &0u16.to_be_bytes());
        let bytes = aiff_bytes(&[comt.clone(), mark.clone(), comt, mark]);
        decodes_fully(&write(dir.path(), "two-comments.aif", &bytes));
    }

    #[test]
    fn healthy_files_are_not_patched() {
        let dir = tempfile::tempdir().unwrap();
        let wav = write(dir.path(), "ok.wav", &wav_bytes(dir.path()));
        let aif = write(dir.path(), "ok.aif", &aiff_bytes(&[chunk(b"COMT", &0u16.to_be_bytes())]));
        assert!(Patched::open(&wav).unwrap().is_none());
        assert!(Patched::open(&aif).unwrap().is_none());
    }

    #[test]
    fn a_broken_info_list_is_not_opened_twice() {
        let dir = tempfile::tempdir().unwrap();
        let wav = wav_bytes(dir.path());
        // A LIST/INFO chunk before the audio whose INAM entry claims more than the list holds.
        // Its top-level length is right, so there's nothing for `Patched` to fix.
        let mut list = b"LIST".to_vec();
        list.extend_from_slice(&16u32.to_le_bytes());
        list.extend_from_slice(b"INFOINAM");
        list.extend_from_slice(&100u32.to_le_bytes());
        list.extend_from_slice(b"abcd");
        // hound writes RIFF, WAVE, then fmt (8 + 16 bytes) before data.
        let at = 12 + 8 + 16;
        let mut bytes = wav[..at].to_vec();
        bytes.extend(list);
        bytes.extend_from_slice(&wav[at..]);
        let riff_len = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&riff_len.to_le_bytes());
        let p = write(dir.path(), "broken-info.wav", &bytes);
        assert!(decode(&p, None, |_, _| {}).is_err());
        assert!(Patched::open(&p).unwrap().is_none());
    }
}
