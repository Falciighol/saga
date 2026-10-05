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

/// The error Symphonia gives when a RIFF or AIFF header length is smaller than its chunks.
const PARENT_LEN_ERROR: &str = "riff: chunk length exceeds parent (list) chunk length";

/// A RIFF or AIFF file read with its top-level (RIFF/FORM) length set to cover every chunk
/// that fits in the file. A chunk that runs past the end of the file, and all after it, are
/// left out.
struct FixedLength {
    file: File,
    head: [u8; 8],
    len: u64,
}

impl FixedLength {
    fn open(path: &Path) -> io::Result<Self> {
        let mut file = File::open(path)?;
        let len = file.metadata()?.len();
        let mut head = [0u8; 8];
        file.read_exact(&mut head)?;
        let big_endian = &head[..4] == b"FORM";
        // Chunks start after the 12-byte header: tag, length, form type.
        let mut end = 12u64;
        let mut chunk = [0u8; 8];
        while end + 8 <= len {
            file.seek(SeekFrom::Start(end))?;
            file.read_exact(&mut chunk)?;
            let chunk_len = [chunk[4], chunk[5], chunk[6], chunk[7]];
            let chunk_len = u64::from(if big_endian { u32::from_be_bytes(chunk_len) } else { u32::from_le_bytes(chunk_len) });
            if end + 8 + chunk_len > len {
                break;
            }
            // Chunks are padded to an even length.
            end = (end + 8 + chunk_len + (chunk_len & 1)).min(len);
        }
        file.rewind()?;
        let size = u32::try_from(end - 8).unwrap_or(u32::MAX);
        head[4..].copy_from_slice(&if big_endian { size.to_be_bytes() } else { size.to_le_bytes() });
        Ok(Self { file, head, len })
    }
}

impl Read for FixedLength {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let pos = self.file.stream_position()? as usize;
        if pos >= self.head.len() {
            return self.file.read(buf);
        }
        let n = buf.len().min(self.head.len() - pos);
        buf[..n].copy_from_slice(&self.head[pos..pos + n]);
        self.file.seek(SeekFrom::Current(n as i64))?;
        Ok(n)
    }
}

impl Seek for FixedLength {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.file.seek(pos)
    }
}

impl MediaSource for FixedLength {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }
}

/// Opens a format reader for `path`.
///
/// Some writers leave the 4-byte form type ("WAVE"/"AIFF") out of the RIFF/FORM length, or
/// add a broken chunk after the audio. Symphonia 0.5 accepted both, 0.6 rejects them. Only for
/// that error, the file is read again with the length fixed, so that files which open today
/// never take this path.
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
        Err(SymError::DecodeError(msg)) if msg == PARENT_LEN_ERROR => {
            probe(Box::new(FixedLength::open(path).map_err(|e| e.to_string())?))
        }
        result => result,
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

    #[test]
    fn decodes_wav_whose_riff_length_misses_the_form_type() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("short-riff.wav");
        let spec = hound::WavSpec { channels: 1, sample_rate: 44100, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(&p, spec).unwrap();
        for i in 0..1000 {
            w.write_sample((i % 100) as i16).unwrap();
        }
        w.finalize().unwrap();
        let mut bytes = std::fs::read(&p).unwrap();
        let riff_len = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) - 4;
        bytes[4..8].copy_from_slice(&riff_len.to_le_bytes());
        std::fs::write(&p, bytes).unwrap();

        let (info, frames) = decode(&p, None, |_, _| {}).unwrap();
        assert_eq!(frames, 1000);
        assert_eq!(info.sample_rate, 44100);
    }
}
