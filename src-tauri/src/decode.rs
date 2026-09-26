//! Streaming decode of any supported audio file to interleaved f32 frames.

use std::fs::File;
use std::path::Path;
use symphonia::core::audio::{SampleBuffer, SignalSpec};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

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

/// Decodes `path`, handing each block of interleaved samples to `sink`.
/// Stops early (without error) after `max_seconds` of audio.
/// Returns the stream info and the number of frames decoded.
pub fn decode<F>(path: &Path, max_seconds: Option<f64>, mut sink: F) -> Result<(StreamInfo, u64), String>
where
    F: FnMut(&StreamInfo, &[f32]),
{
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions { enable_gapless: true, ..Default::default() }, &MetadataOptions::default())
        .map_err(|e| format!("unsupported file: {e}"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("no audio track")?;
    let track_id = track.id;
    let params = track.codec_params.clone();
    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(|e| format!("unsupported codec: {e}"))?;

    let mut info = StreamInfo {
        sample_rate: params.sample_rate.ok_or("unknown sample rate")?,
        channels: params.channels.map(|c| c.count()).unwrap_or(0),
        bit_depth: params.bits_per_sample.or(params.bits_per_coded_sample),
        frames_hint: params.n_frames,
    };
    let mut buf: Option<(SampleBuffer<f32>, SignalSpec)> = None;
    let mut frames: u64 = 0;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(_)) | Err(SymError::ResetRequired) => break,
            Err(e) if frames > 0 => {
                // A damaged tail shouldn't throw away what already decoded fine.
                let _ = e;
                break;
            }
            Err(e) => return Err(e.to_string()),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue,
            Err(SymError::IoError(_)) => break,
            Err(e) => return Err(e.to_string()),
        };
        let spec = *decoded.spec();
        let needed = decoded.capacity() as u64;
        let reuse = buf.as_ref().is_some_and(|(b, s)| *s == spec && b.capacity() as u64 >= needed);
        if !reuse {
            buf = Some((SampleBuffer::new(needed, spec), spec));
        }
        let (b, _) = buf.as_mut().expect("buffer just ensured");
        b.copy_interleaved_ref(decoded);
        let ch = spec.channels.count().max(1);
        info.channels = ch;
        info.sample_rate = spec.rate;
        let samples = b.samples();
        let mut n = (samples.len() / ch) as u64;
        let max_frames = max_seconds.map(|s| (s * spec.rate as f64) as u64);
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
