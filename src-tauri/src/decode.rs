//! Streaming decode of any supported audio file to interleaved f32 frames.

use std::fs::File;
use std::path::Path;
use symphonia::core::audio::{SampleBuffer, SignalSpec};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_AAC, CODEC_TYPE_NULL};
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

/// Splits one MPEG-4 descriptor off the front of `buf`: (tag, body, rest).
fn split_descriptor(buf: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, mut rest) = buf.split_first()?;
    let mut len = 0usize;
    // The size takes 1-4 bytes, 7 bits each, high bit set while more follow.
    for _ in 0..4 {
        let (&b, r) = rest.split_first()?;
        rest = r;
        len = (len << 7) | (b & 0x7f) as usize;
        if b & 0x80 == 0 {
            break;
        }
    }
    (rest.len() >= len).then(|| (tag, &rest[..len], &rest[len..]))
}

/// CAF files (Apple Loops among them) store the AAC magic cookie as a full MP4 `esds`
/// descriptor, but Symphonia's AAC decoder wants the bare AudioSpecificConfig inside it and
/// otherwise fails with "aac too complex". Returns that inner config, if `cookie` is an `esds`.
///
/// Symphonia 0.6.0 does this unwrap in its own CAF reader ("caf: Support AAC in CAF").
/// After Saga upgrades to Symphonia 0.6+, remove this function, `split_descriptor`, their
/// tests, and the `CODEC_TYPE_AAC` block in `decode()`.
fn aac_config_from_esds(cookie: &[u8]) -> Option<&[u8]> {
    const ES_DESCRIPTOR: u8 = 0x03;
    const DECODER_CONFIG: u8 = 0x04;
    const DECODER_SPECIFIC_INFO: u8 = 0x05;
    // objectTypeIndication, streamType, bufferSizeDB, maxBitrate, avgBitrate.
    const DECODER_CONFIG_FIXED_LEN: usize = 13;

    let (tag, es, _) = split_descriptor(cookie)?;
    if tag != ES_DESCRIPTOR {
        return None;
    }
    // ES_ID, then flags that announce optional fields.
    let flags = *es.get(2)?;
    let mut skip = 3;
    if flags & 0x80 != 0 {
        skip += 2;
    }
    if flags & 0x40 != 0 {
        skip += 1 + *es.get(skip)? as usize;
    }
    if flags & 0x20 != 0 {
        skip += 2;
    }
    let (tag, dec, _) = split_descriptor(es.get(skip..)?)?;
    if tag != DECODER_CONFIG {
        return None;
    }
    let (tag, config, _) = split_descriptor(dec.get(DECODER_CONFIG_FIXED_LEN..)?)?;
    (tag == DECODER_SPECIFIC_INFO).then_some(config)
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
    let mut params = track.codec_params.clone();
    if params.codec == CODEC_TYPE_AAC {
        if let Some(config) = params.extra_data.as_deref().and_then(aac_config_from_esds).map(Box::from) {
            params.extra_data = Some(config);
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwraps_aac_config_from_esds_cookie() {
        // Magic cookie of an Apple Loop ("Shuffling Vintage Break.caf"): AAC-LC, 44.1 kHz, mono.
        let cookie = [
            0x03, 0x80, 0x80, 0x80, 0x22, 0x00, 0x00, 0x00, 0x04, 0x80, 0x80, 0x80, 0x14, 0x40, 0x14, 0x00, 0x18, 0x00,
            0x00, 0x03, 0x71, 0xf0, 0x00, 0x03, 0xe8, 0x00, 0x05, 0x80, 0x80, 0x80, 0x02, 0x12, 0x08, 0x06, 0x80, 0x80,
            0x80, 0x01, 0x02,
        ];
        assert_eq!(aac_config_from_esds(&cookie), Some(&[0x12, 0x08][..]));
    }

    #[test]
    fn leaves_bare_aac_config_alone() {
        assert_eq!(aac_config_from_esds(&[0x12, 0x08]), None);
        assert_eq!(aac_config_from_esds(&[]), None);
    }
}
