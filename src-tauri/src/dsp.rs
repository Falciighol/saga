//! Sample processing shared by preview and render, so what you hear is what you drag:
//! shaping (loop region, reverse, fades, gain), repitching and time-stretching.
//! All buffers are stereo, interleaved.

use rubato::{FftFixedIn, Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use serde::{Deserialize, Serialize};
use signalsmith_stretch::Stretch;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Change tempo and pitch independently.
    #[default]
    Stretch,
    /// Tape-style: speed and pitch move together.
    Repitch,
}

/// How a sample should sound. Computed by the frontend from the project tempo/key and the
/// sample's edits; the backend only applies it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProcessParams {
    /// Source seconds per output second (1.25 = 25% faster).
    pub rate: f64,
    /// Pitch shift in stretch mode.
    pub semitones: f64,
    pub mode: Mode,
    /// Keep vocal formants in place when shifting pitch.
    pub formants: bool,
    pub reverse: bool,
    /// Loop region in seconds of the original file.
    pub region_start: Option<f64>,
    pub region_end: Option<f64>,
    pub fade_in: f64,
    pub fade_out: f64,
    pub gain_db: f64,
    /// Scale so the loudest peak sits at -1 dBFS.
    pub normalize: bool,
    /// Loop-point crossfade in seconds, applied when a partial region is set.
    pub crossfade: f64,
    /// Seconds of the original per beat, for the metronome click.
    pub beat: Option<f64>,
}

impl Default for ProcessParams {
    fn default() -> Self {
        ProcessParams {
            rate: 1.0,
            semitones: 0.0,
            mode: Mode::Stretch,
            formants: false,
            reverse: false,
            region_start: None,
            region_end: None,
            fade_in: 0.0,
            fade_out: 0.0,
            gain_db: 0.0,
            normalize: false,
            crossfade: 0.01,
            beat: None,
        }
    }
}

pub const MIN_RATE: f64 = 0.25;
pub const MAX_RATE: f64 = 4.0;

impl ProcessParams {
    pub fn rate(&self) -> f64 {
        if self.rate.is_finite() { self.rate.clamp(MIN_RATE, MAX_RATE) } else { 1.0 }
    }

    pub fn needs_stretch(&self) -> bool {
        self.mode == Mode::Stretch && ((self.rate() - 1.0).abs() > 1e-4 || self.semitones.abs() > 1e-3)
    }

    pub fn needs_repitch(&self) -> bool {
        self.mode == Mode::Repitch && (self.rate() - 1.0).abs() > 1e-4
    }

    /// True when both describe the same shaped audio (region, direction, fades, gain).
    pub fn same_shape(&self, o: &ProcessParams) -> bool {
        self.reverse == o.reverse
            && self.region_start == o.region_start
            && self.region_end == o.region_end
            && self.fade_in == o.fade_in
            && self.fade_out == o.fade_out
            && self.gain_db == o.gain_db
            && self.normalize == o.normalize
            && self.crossfade == o.crossfade
    }

    /// True when these parameters leave the file exactly as it is.
    pub fn is_identity(&self) -> bool {
        !self.needs_stretch() && !self.needs_repitch() && self.same_shape(&ProcessParams { crossfade: self.crossfade, ..Default::default() })
    }
}

/// A region of a sample after reverse/fades/gain, ready to play or process.
#[derive(Debug, Clone)]
pub struct Shaped {
    pub data: Vec<f32>,
    pub frames: usize,
    pub rate: u32,
    /// Region bounds in frames of the original.
    pub start: usize,
    pub end: usize,
    pub reverse: bool,
}

impl Shaped {
    /// Seconds in the original file for a frame position in this shaped buffer.
    pub fn original_time(&self, q: f64) -> f64 {
        let f = if self.reverse { self.end as f64 - q } else { self.start as f64 + q };
        f / self.rate as f64
    }

    /// Shaped-buffer frame for a time in the original file.
    pub fn frame_for(&self, seconds: f64) -> f64 {
        let f = seconds * self.rate as f64;
        let q = if self.reverse { self.end as f64 - f } else { f - self.start as f64 };
        q.clamp(0.0, self.frames.saturating_sub(1) as f64)
    }

    /// Copies `n` frames starting at `from` into `out`, wrapping when looping and padding with
    /// silence past the end otherwise. Returns the position after the read.
    pub fn read(&self, from: usize, n: usize, looping: bool, out: &mut [f32]) -> usize {
        let mut pos = from;
        for i in 0..n {
            if pos >= self.frames {
                if looping && self.frames > 0 {
                    pos %= self.frames;
                } else {
                    out[i * 2] = 0.0;
                    out[i * 2 + 1] = 0.0;
                    pos += 1;
                    continue;
                }
            }
            out[i * 2] = self.data[pos * 2];
            out[i * 2 + 1] = self.data[pos * 2 + 1];
            pos += 1;
        }
        pos
    }
}

/// Applies region, loop crossfade, reverse, gain/normalize and fades.
pub fn shape(src: &[f32], rate: u32, p: &ProcessParams) -> Shaped {
    let total = src.len() / 2;
    let to_frame = |s: f64| ((s.max(0.0) * rate as f64).round() as usize).min(total);
    let start = p.region_start.map(to_frame).unwrap_or(0).min(total.saturating_sub(1));
    let end = p.region_end.map(to_frame).unwrap_or(total).clamp(start + 1, total.max(start + 1)).min(total);
    let mut data = src[start * 2..end * 2].to_vec();
    let len = end - start;

    // Blend the loop point with the audio just outside the region so the wrap is seamless.
    let partial = start > 0 || end < total;
    let x = ((p.crossfade.max(0.0) * rate as f64) as usize).min(len / 2);
    if partial && x > 1 {
        if start >= x {
            for i in 0..x {
                let w = (i + 1) as f32 / x as f32;
                let (g_out, g_in) = ((w * std::f32::consts::FRAC_PI_2).cos(), (w * std::f32::consts::FRAC_PI_2).sin());
                for c in 0..2 {
                    let tail = (len - x + i) * 2 + c;
                    let pre = (start - x + i) * 2 + c;
                    data[tail] = data[tail] * g_out + src[pre] * g_in;
                }
            }
        } else if total - end >= x {
            for i in 0..x {
                let w = i as f32 / x as f32;
                let (g_in, g_out) = ((w * std::f32::consts::FRAC_PI_2).sin(), (w * std::f32::consts::FRAC_PI_2).cos());
                for c in 0..2 {
                    let head = i * 2 + c;
                    let post = (end + i) * 2 + c;
                    data[head] = data[head] * g_in + src[post] * g_out;
                }
            }
        }
    }

    if p.reverse {
        for i in 0..len / 2 {
            let j = len - 1 - i;
            data.swap(i * 2, j * 2);
            data.swap(i * 2 + 1, j * 2 + 1);
        }
    }

    let mut gain = 10f32.powf(p.gain_db as f32 / 20.0);
    if p.normalize {
        let peak = data.iter().fold(0f32, |a, &s| a.max(s.abs()));
        if peak > 1e-6 {
            gain *= 10f32.powf(-1.0 / 20.0) / peak;
        }
    }
    if (gain - 1.0).abs() > 1e-6 {
        data.iter_mut().for_each(|s| *s *= gain);
    }

    let fi = ((p.fade_in.max(0.0) * rate as f64) as usize).min(len);
    for i in 0..fi {
        let g = i as f32 / fi as f32;
        data[i * 2] *= g;
        data[i * 2 + 1] *= g;
    }
    let fo = ((p.fade_out.max(0.0) * rate as f64) as usize).min(len);
    for i in 0..fo {
        let g = i as f32 / fo as f32;
        let k = len - 1 - i;
        data[k * 2] *= g;
        data[k * 2 + 1] *= g;
    }

    Shaped { data, frames: len, rate, start, end, reverse: p.reverse }
}

/// A stretcher configured for these parameters.
pub fn make_stretcher(rate: u32, p: &ProcessParams) -> Stretch {
    let mut st = Stretch::preset_default(2, rate);
    st.set_transpose_factor_semitones(p.semitones as f32, None);
    if p.formants {
        st.set_formant_factor(1.0, true);
    }
    st
}

/// Renders the whole shaped buffer through the tempo/pitch stage.
pub fn process_offline(shaped: &Shaped, p: &ProcessParams) -> Result<Vec<f32>, String> {
    if p.needs_stretch() {
        Ok(stretch_offline(shaped, p))
    } else if p.needs_repitch() {
        let (l, r) = split(&shaped.data);
        let (l, r) = resample_ratio(&l, &r, 1.0 / p.rate())?;
        Ok(join(&l, &r))
    } else {
        Ok(shaped.data.clone())
    }
}

fn stretch_offline(shaped: &Shaped, p: &ProcessParams) -> Vec<f32> {
    let rate = p.rate();
    let out_frames = ((shaped.frames as f64) / rate).round().max(1.0) as usize;
    let mut st = make_stretcher(shaped.rate, p);
    let min_out = 2 * st.output_latency() + 16;
    if out_frames >= min_out {
        let mut out = vec![0f32; out_frames * 2];
        if st.exact(&shaped.data, &mut out) {
            return out;
        }
    }
    // Too short for an exact render: pad with silence, render, then trim.
    let in_frames = (((min_out as f64) * rate).ceil() as usize).max(shaped.frames);
    let mut input = shaped.data.clone();
    input.resize(in_frames * 2, 0.0);
    let padded_out = ((in_frames as f64) / rate).round() as usize;
    let mut out = vec![0f32; padded_out * 2];
    st.reset();
    st.exact(&input, &mut out);
    out.truncate(out_frames * 2);
    out
}

pub fn split(data: &[f32]) -> (Vec<f32>, Vec<f32>) {
    let n = data.len() / 2;
    let mut l = Vec::with_capacity(n);
    let mut r = Vec::with_capacity(n);
    for f in data.chunks_exact(2) {
        l.push(f[0]);
        r.push(f[1]);
    }
    (l, r)
}

pub fn join(l: &[f32], r: &[f32]) -> Vec<f32> {
    let n = l.len().min(r.len());
    let mut out = Vec::with_capacity(n * 2);
    for i in 0..n {
        out.push(l[i]);
        out.push(r[i]);
    }
    out
}

fn run_resampler<R: Resampler<f32>>(mut rs: R, left: &[f32], right: &[f32], expected: usize) -> Result<(Vec<f32>, Vec<f32>), String> {
    let delay = rs.output_delay();
    let mut out_l = Vec::with_capacity(expected + delay + 4096);
    let mut out_r = Vec::with_capacity(expected + delay + 4096);
    let mut pos = 0;
    loop {
        let need = rs.input_frames_next();
        if pos + need > left.len() {
            break;
        }
        let out = rs.process(&[&left[pos..pos + need], &right[pos..pos + need]], None).map_err(|e| e.to_string())?;
        out_l.extend_from_slice(&out[0]);
        out_r.extend_from_slice(&out[1]);
        pos += need;
    }
    if pos < left.len() {
        let out = rs.process_partial(Some(&[&left[pos..], &right[pos..]]), None).map_err(|e| e.to_string())?;
        out_l.extend_from_slice(&out[0]);
        out_r.extend_from_slice(&out[1]);
    }
    while out_l.len() < expected + delay {
        let out = rs.process_partial::<&[f32]>(None, None).map_err(|e| e.to_string())?;
        if out[0].is_empty() {
            break;
        }
        out_l.extend_from_slice(&out[0]);
        out_r.extend_from_slice(&out[1]);
    }
    let end_l = (delay + expected).min(out_l.len());
    let end_r = (delay + expected).min(out_r.len());
    Ok((out_l[delay.min(end_l)..end_l].to_vec(), out_r[delay.min(end_r)..end_r].to_vec()))
}

/// Sample-rate conversion between two fixed rates.
pub fn resample_rates(left: &[f32], right: &[f32], in_rate: u32, out_rate: u32) -> Result<(Vec<f32>, Vec<f32>), String> {
    let rs = FftFixedIn::<f32>::new(in_rate as usize, out_rate as usize, 1024, 2, 2).map_err(|e| e.to_string())?;
    let expected = (left.len() as f64 * out_rate as f64 / in_rate as f64).round() as usize;
    run_resampler(rs, left, right, expected)
}

/// Stretches the signal by `ratio` in length (and pitch, inversely), e.g. for repitching.
pub fn resample_ratio(left: &[f32], right: &[f32], ratio: f64) -> Result<(Vec<f32>, Vec<f32>), String> {
    let params = SincInterpolationParameters {
        sinc_len: 128,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Cubic,
        oversampling_factor: 128,
        window: WindowFunction::BlackmanHarris2,
    };
    let rs = SincFixedIn::<f32>::new(ratio, 1.0, params, 1024, 2).map_err(|e| e.to_string())?;
    let expected = (left.len() as f64 * ratio).round() as usize;
    run_resampler(rs, left, right, expected)
}

/// Cubic (Hermite) interpolation of one channel at a fractional frame.
#[inline]
pub fn hermite(data: &[f32], frames: usize, pos: f64, channel: usize, looping: bool) -> f32 {
    let i = pos.floor() as isize;
    let t = (pos - i as f64) as f32;
    let at = |k: isize| -> f32 {
        let idx = if looping && frames > 0 {
            k.rem_euclid(frames as isize) as usize
        } else if k < 0 || k as usize >= frames {
            return 0.0;
        } else {
            k as usize
        };
        data[idx * 2 + channel]
    };
    let (y0, y1, y2, y3) = (at(i - 1), at(i), at(i + 1), at(i + 2));
    let c1 = 0.5 * (y2 - y0);
    let c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    let c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    ((c3 * t + c2) * t + c1) * t + y1
}

/// Writes stereo audio as a 24-bit WAV (mono if `mono`).
pub fn write_wav(path: &std::path::Path, data: &[f32], rate: u32, mono: bool) -> Result<(), String> {
    let spec = hound::WavSpec { channels: if mono { 1 } else { 2 }, sample_rate: rate, bits_per_sample: 24, sample_format: hound::SampleFormat::Int };
    let tmp = path.with_extension("wav.part");
    let mut w = hound::WavWriter::create(&tmp, spec).map_err(|e| e.to_string())?;
    let scale = 8_388_607.0f32;
    for f in data.chunks_exact(2) {
        if mono {
            w.write_sample((((f[0] + f[1]) * 0.5).clamp(-1.0, 1.0) * scale) as i32).map_err(|e| e.to_string())?;
        } else {
            w.write_sample((f[0].clamp(-1.0, 1.0) * scale) as i32).map_err(|e| e.to_string())?;
            w.write_sample((f[1].clamp(-1.0, 1.0) * scale) as i32).map_err(|e| e.to_string())?;
        }
    }
    w.finalize().map_err(|e| e.to_string())?;
    // Rename into place so a half-written file is never dragged or indexed.
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, rate: u32, seconds: f32) -> Vec<f32> {
        let n = (rate as f32 * seconds) as usize;
        let mut v = Vec::with_capacity(n * 2);
        for i in 0..n {
            let s = (i as f32 / rate as f32 * freq * std::f32::consts::TAU).sin() * 0.5;
            v.push(s);
            v.push(s);
        }
        v
    }

    /// Frequency from zero crossings over the middle half of a stereo buffer.
    fn pitch(data: &[f32], rate: u32) -> f32 {
        let (l, _) = split(data);
        let mid = &l[l.len() / 4..l.len() * 3 / 4];
        let crossings = mid.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        crossings as f32 / (mid.len() as f32 / rate as f32)
    }

    #[test]
    fn shaping_region_reverse_and_fades() {
        let ramp: Vec<f32> = (0..1000).flat_map(|i| [i as f32 / 1000.0, i as f32 / 1000.0]).collect();
        let p = ProcessParams { region_start: Some(0.1), region_end: Some(0.5), reverse: true, crossfade: 0.0, ..Default::default() };
        let s = shape(&ramp, 1000, &p);
        assert_eq!((s.start, s.end, s.frames), (100, 500, 400));
        assert!((s.data[0] - 0.499).abs() < 1e-6, "reversed: starts at the region end");
        assert!((s.original_time(0.0) - 0.5).abs() < 1e-9);
        assert!((s.frame_for(0.3) - 200.0).abs() < 1e-9);

        let p = ProcessParams { fade_in: 0.1, fade_out: 0.1, ..Default::default() };
        let s = shape(&vec![1.0; 2000], 1000, &p);
        assert_eq!(s.data[0], 0.0);
        assert!(s.data[1998] < 0.02);
        assert_eq!(s.data[1000], 1.0);

        let p = ProcessParams { normalize: true, ..Default::default() };
        let s = shape(&vec![0.25; 200], 1000, &p);
        assert!((s.data[0] - 0.891).abs() < 0.001, "{}", s.data[0]);
    }

    #[test]
    fn loop_crossfade_makes_the_wrap_continuous() {
        let src = sine(100.0, 1000, 2.0);
        // A region whose end doesn't line up with a zero crossing.
        let p = ProcessParams { region_start: Some(0.5), region_end: Some(1.2371), crossfade: 0.05, ..Default::default() };
        let s = shape(&src, 1000, &p);
        let last = s.data[(s.frames - 1) * 2];
        let first = s.data[0];
        // Without the crossfade the jump would be up to 1.0 (a full swing); now it's one sample step.
        assert!((last - first).abs() < 0.35, "{last} -> {first}");
    }

    #[test]
    fn stretch_changes_length_but_not_pitch() {
        let rate = 48000;
        let src = sine(440.0, rate, 2.0);
        let s = shape(&src, rate, &ProcessParams::default());
        let p = ProcessParams { rate: 1.25, ..Default::default() };
        let out = process_offline(&s, &p).unwrap();
        assert_eq!(out.len() / 2, (96000.0 / 1.25) as usize);
        assert!((pitch(&out, rate) - 440.0).abs() < 8.0, "{}", pitch(&out, rate));
    }

    #[test]
    fn transpose_shifts_pitch_but_not_length() {
        let rate = 48000;
        let s = shape(&sine(440.0, rate, 2.0), rate, &ProcessParams::default());
        let p = ProcessParams { semitones: 12.0, ..Default::default() };
        let out = process_offline(&s, &p).unwrap();
        assert_eq!(out.len() / 2, 96000);
        assert!((pitch(&out, rate) - 880.0).abs() < 15.0, "{}", pitch(&out, rate));
    }

    #[test]
    fn repitch_moves_speed_and_pitch_together() {
        let rate = 48000;
        let s = shape(&sine(440.0, rate, 1.0), rate, &ProcessParams::default());
        let p = ProcessParams { rate: 2.0, mode: Mode::Repitch, ..Default::default() };
        let out = process_offline(&s, &p).unwrap();
        assert!((out.len() as i64 / 2 - 24000).abs() <= 2, "{}", out.len() / 2);
        assert!((pitch(&out, rate) - 880.0).abs() < 10.0, "{}", pitch(&out, rate));
    }

    #[test]
    fn short_hits_can_still_be_pitched() {
        let rate = 44100;
        let s = shape(&sine(200.0, rate, 0.05), rate, &ProcessParams::default());
        let out = process_offline(&s, &ProcessParams { semitones: -5.0, ..Default::default() }).unwrap();
        assert_eq!(out.len() / 2, s.frames);
    }

    #[test]
    fn identity_is_detected() {
        assert!(ProcessParams::default().is_identity());
        assert!(!ProcessParams { reverse: true, ..Default::default() }.is_identity());
        assert!(!ProcessParams { rate: 1.1, ..Default::default() }.is_identity());
        assert!(ProcessParams { rate: 1.1, mode: Mode::Repitch, ..Default::default() }.needs_repitch());
    }

    #[test]
    fn hermite_interpolates_and_wraps() {
        let d: Vec<f32> = (0..8).flat_map(|i| [i as f32, i as f32]).collect();
        assert!((hermite(&d, 8, 2.5, 0, false) - 2.5).abs() < 1e-5);
        assert_eq!(hermite(&d, 8, 9.0, 0, true), 1.0);
    }
}
