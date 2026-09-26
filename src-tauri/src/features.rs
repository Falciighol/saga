//! Describes how a sample sounds, from one pass over its audio: a feature vector for
//! Find similar and the sound map, plus the onset envelope, chroma and pitch that tempo
//! and key detection work from.

use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};
use std::cell::RefCell;
use std::ops::Range;
use std::sync::Arc;

/// Only the start of long files is described.
pub const MAX_SECONDS: f64 = 45.0;

/// Layout of the feature vector. Similarity compares these groups separately.
pub const TIMBRE: Range<usize> = 0..30;
pub const PITCH: Range<usize> = 30..45;
pub const ENVELOPE: Range<usize> = 45..59;
/// Dimensions used for similarity.
pub const DIM: usize = 59;
/// Spectral centroid in Hz (for coloring the map, not compared).
pub const BRIGHTNESS: usize = 59;
/// Loudest frame's RMS level in dBFS (for coloring the map, not compared).
pub const LEVEL: usize = 60;
pub const LEN: usize = 61;

const MEL_BANDS: usize = 40;
const MFCCS: usize = 13;
/// Pitch histogram resolution: 10 bins per semitone.
pub const PC_BINS: usize = 120;
/// Envelope blocks per second (2.5 ms).
const ENV_RATE: f32 = 400.0;
/// Times after the peak at which the envelope shape is sampled, in seconds.
const ENV_TIMES: [f32; 8] = [0.01, 0.025, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6];

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pitch {
    pub hz: f32,
    /// 0–1: how clearly periodic the sound is.
    pub clarity: f32,
}

#[derive(Debug, Clone)]
pub struct Sound {
    /// `LEN` values; NaN where a descriptor doesn't apply.
    pub features: Vec<f32>,
    /// Spectral flux per analysis frame, for tempo detection.
    pub onset: Vec<f32>,
    /// Onset frames per second.
    pub frame_rate: f32,
    /// Tuning-corrected pitch-class profile, summing to 1 (all zero if nothing tonal was found).
    pub chroma: [f32; 12],
    /// 0–1: how much the chroma is dominated by a few pitch classes.
    pub tonality: f32,
    pub pitch: Option<Pitch>,
    /// Pitch-class histograms at 10 bins per semitone (bin 0 = C), for key detection:
    /// every spectral peak, and with overtones of lower notes played down.
    pub hist: [f32; PC_BINS],
    pub fund: [f32; PC_BINS],
}

/// Collects a mono copy of the audio as it's decoded.
pub struct Collector {
    rate: u32,
    decimate: bool,
    pending: Option<f32>,
    mono: Vec<f32>,
    max: usize,
}

impl Collector {
    pub fn new(rate: u32) -> Collector {
        // 88.2/96 kHz and up are halved: nothing above 22 kHz matters here.
        let decimate = rate >= 88_000;
        let rate = if decimate { rate / 2 } else { rate };
        let max = (MAX_SECONDS * rate as f64) as usize;
        Collector { rate, decimate, pending: None, mono: Vec::with_capacity(max.min(rate as usize * 8)), max }
    }

    pub fn push(&mut self, interleaved: &[f32], channels: usize) {
        let ch = channels.max(1);
        let scale = 1.0 / ch as f32;
        for frame in interleaved.chunks_exact(ch) {
            if self.mono.len() >= self.max {
                return;
            }
            let v = frame.iter().sum::<f32>() * scale;
            if self.decimate {
                match self.pending.take() {
                    Some(p) => self.mono.push((p + v) * 0.5),
                    None => self.pending = Some(v),
                }
            } else {
                self.mono.push(v);
            }
        }
    }

    pub fn finish(self) -> Option<Sound> {
        describe(&self.mono, self.rate)
    }
}

thread_local! {
    static PLANNER: RefCell<RealFftPlanner<f32>> = RefCell::new(RealFftPlanner::new());
}

fn forward(n: usize) -> Arc<dyn RealToComplex<f32>> {
    PLANNER.with(|p| p.borrow_mut().plan_fft_forward(n))
}

fn hann(n: usize) -> Vec<f32> {
    (0..n).map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / n as f32).cos()).collect()
}

fn db(power: f32) -> f32 {
    10.0 * (power + 1e-12).log10()
}

/// Triangular mel filters over FFT bins: (first bin, weights).
fn mel_bank(n: usize, sr: f32) -> Vec<(usize, Vec<f32>)> {
    let to_mel = |f: f32| 2595.0 * (1.0 + f / 700.0).log10();
    let from_mel = |m: f32| 700.0 * (10f32.powf(m / 2595.0) - 1.0);
    let (lo, hi) = (to_mel(30.0), to_mel((sr / 2.0).min(16_000.0)));
    let edges: Vec<f32> = (0..MEL_BANDS + 2).map(|i| from_mel(lo + (hi - lo) * i as f32 / (MEL_BANDS + 1) as f32)).collect();
    let bin_hz = sr / n as f32;
    (0..MEL_BANDS)
        .map(|b| {
            let (a, c, e) = (edges[b], edges[b + 1], edges[b + 2]);
            let first = (a / bin_hz).ceil() as usize;
            let last = ((e / bin_hz).floor() as usize).min(n / 2);
            let mut w: Vec<f32> = (first..=last.max(first))
                .map(|k| {
                    let f = k as f32 * bin_hz;
                    if f <= c { ((f - a) / (c - a)).max(0.0) } else { ((e - f) / (e - c)).max(0.0) }
                })
                .collect();
            // Narrow low bands can fall between bins; give them the nearest one.
            if w.iter().all(|&x| x == 0.0) {
                w = vec![1.0];
                return (((c / bin_hz).round() as usize).min(n / 2), w);
            }
            (first, w)
        })
        .collect()
}

/// Describes mono audio at `sr`. None for silence.
pub fn describe(x: &[f32], sr: u32) -> Option<Sound> {
    if x.is_empty() || sr < 4000 {
        return None;
    }
    let srf = sr as f32;
    let n = if sr >= 32_000 { 2048 } else { 1024 };
    let hop = n / 4;
    let nc = n * 4;
    let frames = x.len().div_ceil(hop).max(1);

    // Frame levels first, so quiet frames can be left out of the averages.
    let frame_db: Vec<f32> = (0..frames)
        .map(|f| {
            let s = &x[f * hop..(f * hop + n).min(x.len())];
            db(s.iter().map(|v| v * v).sum::<f32>() / n as f32)
        })
        .collect();
    let max_db = frame_db.iter().copied().fold(f32::MIN, f32::max);
    if max_db < -100.0 {
        return None;
    }
    let active = |f: usize| frame_db[f] >= max_db - 50.0;

    let fft = forward(n);
    let fftc = forward(nc);
    let window = hann(n);
    let window_c = hann(nc);
    let mut input = fft.make_input_vec();
    let mut spectrum = fft.make_output_vec();
    let mut input_c = fftc.make_input_vec();
    let mut spectrum_c = fftc.make_output_vec();
    let mel = mel_bank(n, srf);
    let bin_hz = srf / n as f32;
    let flat_lo = (100.0 / bin_hz).ceil() as usize;
    let flat_hi = ((16_000.0f32.min(srf / 2.0)) / bin_hz) as usize;
    let dct: Vec<Vec<f32>> = (1..=MFCCS)
        .map(|i| {
            (0..MEL_BANDS)
                .map(|b| (std::f32::consts::PI * i as f32 * (b as f32 + 0.5) / MEL_BANDS as f32).cos() * (2.0 / MEL_BANDS as f32).sqrt())
                .collect()
        })
        .collect();

    let mut mag = vec![0f32; n / 2 + 1];
    let mut mel_db = [0f32; MEL_BANDS];
    let mut prev_mel: Option<[f32; MEL_BANDS]> = None;
    let mut onset = Vec::with_capacity(frames);
    let mut mfcc_sum = [0f64; MFCCS];
    let mut mfcc_sq = [0f64; MFCCS];
    let (mut centroid_sum, mut rolloff_sum, mut flat_sum, mut bw_sum) = (0f64, 0f64, 0f64, 0f64);
    let mut counted = 0usize;
    let mut hist = Histograms::default();
    let mut peaks: Vec<(f32, f32)> = Vec::new();

    for f in 0..frames {
        let start = f * hop;
        for i in 0..n {
            input[i] = x.get(start + i).copied().unwrap_or(0.0) * window[i];
        }
        if fft.process(&mut input, &mut spectrum).is_err() {
            return None;
        }
        for (m, c) in mag.iter_mut().zip(&spectrum) {
            *m = c.norm();
        }
        for (b, (first, w)) in mel.iter().enumerate() {
            let e: f32 = w.iter().enumerate().map(|(j, wj)| mag.get(first + j).map_or(0.0, |m| m * m) * wj).sum();
            mel_db[b] = db(e).max(-80.0);
        }
        let flux = match &prev_mel {
            Some(p) => mel_db.iter().zip(p).map(|(a, b)| (a - b).max(0.0)).sum::<f32>() / MEL_BANDS as f32,
            None => 0.0,
        };
        onset.push(flux);
        prev_mel = Some(mel_db);

        if !active(f) {
            continue;
        }
        counted += 1;
        for (i, row) in dct.iter().enumerate() {
            let c: f32 = row.iter().zip(&mel_db).map(|(a, b)| a * b).sum();
            mfcc_sum[i] += c as f64;
            mfcc_sq[i] += (c * c) as f64;
        }
        let lo_bin = (20.0 / bin_hz).ceil() as usize;
        let total: f32 = mag[lo_bin..].iter().sum::<f32>() + 1e-12;
        let centroid: f32 = mag[lo_bin..].iter().enumerate().map(|(j, m)| (lo_bin + j) as f32 * bin_hz * m).sum::<f32>() / total;
        let bw = (mag[lo_bin..].iter().enumerate().map(|(j, m)| ((lo_bin + j) as f32 * bin_hz - centroid).powi(2) * m).sum::<f32>() / total).sqrt();
        let power_total: f32 = mag[lo_bin..].iter().map(|m| m * m).sum();
        let mut acc = 0f32;
        let mut rolloff = srf / 2.0;
        for (j, m) in mag[lo_bin..].iter().enumerate() {
            acc += m * m;
            if acc >= 0.85 * power_total {
                rolloff = (lo_bin + j) as f32 * bin_hz;
                break;
            }
        }
        let band = &mag[flat_lo.min(mag.len() - 1)..flat_hi.clamp(flat_lo + 1, mag.len())];
        let log_mean = band.iter().map(|m| (m * m + 1e-12).ln()).sum::<f32>() / band.len() as f32;
        let mean = band.iter().map(|m| m * m).sum::<f32>() / band.len() as f32 + 1e-12;
        let flatness = (log_mean.exp() / mean).clamp(1e-6, 1.0);
        centroid_sum += (centroid.max(20.0) as f64).log10();
        bw_sum += (bw.max(1.0) as f64).log10();
        rolloff_sum += (rolloff.max(20.0) as f64).log10();
        flat_sum += 10.0 * (flatness as f64).log10();

        // Pitch content from a longer window every fourth frame.
        if f % 4 == 0 {
            for i in 0..nc {
                input_c[i] = x.get(start + i).copied().unwrap_or(0.0) * window_c[i];
            }
            if fftc.process(&mut input_c, &mut spectrum_c).is_ok() {
                spectral_peaks(&spectrum_c, srf / nc as f32, &mut peaks);
                hist.add(&peaks);
            }
        }
    }
    if counted == 0 {
        return None;
    }

    let mut features = vec![f32::NAN; LEN];
    let cnt = counted as f64;
    for i in 0..MFCCS {
        let mean = mfcc_sum[i] / cnt;
        features[i] = mean as f32;
        features[MFCCS + i] = (mfcc_sq[i] / cnt - mean * mean).max(0.0).sqrt() as f32;
    }
    features[26] = (centroid_sum / cnt) as f32;
    features[27] = (rolloff_sum / cnt) as f32;
    features[28] = (flat_sum / cnt) as f32;
    features[29] = (bw_sum / cnt) as f32;

    let norm = |h: &[f64; PC_BINS]| {
        let sum: f64 = h.iter().sum();
        let mut out = [0f32; PC_BINS];
        if sum > 0.0 {
            out.iter_mut().zip(h).for_each(|(o, v)| *o = (v / sum) as f32);
        }
        out
    };
    let (all, fund) = (norm(&hist.all), norm(&hist.fund));
    let chroma = fold(&all, tuning(&all));
    let tonality = tonality(&chroma);
    features[30..42].copy_from_slice(&chroma);
    let pitch = detect_pitch(x, sr);
    if let Some(p) = pitch {
        features[42] = p.hz.log2();
        features[43] = p.clarity;
    } else {
        features[43] = 0.0;
    }
    features[44] = tonality;

    envelope_features(x, srf, &onset, srf / hop as f32, &mut features[ENVELOPE]);
    features[BRIGHTNESS] = 10f32.powf(features[26]);
    features[LEVEL] = max_db;

    Some(Sound { features, onset, frame_rate: srf / hop as f32, chroma, tonality, pitch, hist: all, fund })
}

/// Spectral peaks between 50 Hz and 5 kHz as (frequency, amplitude relative to the loudest).
fn spectral_peaks(spec: &[Complex<f32>], bin_hz: f32, out: &mut Vec<(f32, f32)>) {
    out.clear();
    let lo = ((50.0 / bin_hz) as usize).max(2);
    let hi = ((5000.0 / bin_hz) as usize).min(spec.len() - 2);
    let max = spec[lo..hi].iter().map(|c| c.norm()).fold(0f32, f32::max);
    if max <= 1e-9 {
        return;
    }
    for k in lo..hi {
        let (a, b, c) = (spec[k - 1].norm(), spec[k].norm(), spec[k + 1].norm());
        if !(b > a && b >= c) || b < max * 0.01 {
            continue;
        }
        let (la, lb, lc) = (a.max(1e-12).ln(), b.ln(), c.max(1e-12).ln());
        let denom = la - 2.0 * lb + lc;
        let p = if denom.abs() > 1e-9 { (0.5 * (la - lc) / denom).clamp(-0.5, 0.5) } else { 0.0 };
        out.push(((k as f32 + p) * bin_hz, b / max));
    }
}

fn pc_bin(freq: f32) -> usize {
    let midi = 69.0 + 12.0 * (freq / 440.0).log2();
    ((midi.rem_euclid(12.0) * 10.0).round() as usize) % PC_BINS
}

/// Pitch-class histograms summed over frames, each frame normalized.
struct Histograms {
    all: [f64; PC_BINS],
    fund: [f64; PC_BINS],
}

impl Default for Histograms {
    fn default() -> Self {
        Histograms { all: [0.0; PC_BINS], fund: [0.0; PC_BINS] }
    }
}

impl Histograms {
    fn add(&mut self, peaks: &[(f32, f32)]) {
        let mut all = [0f64; PC_BINS];
        let mut fund = [0f64; PC_BINS];
        for (i, &(f, a)) in peaks.iter().enumerate() {
            let w = (a as f64).sqrt();
            let bin = pc_bin(f);
            all[bin] += w;
            // Third, fifth and sixth harmonics of a lower note would read as its fifth or third.
            let overtone = peaks[..i].iter().any(|&(g, b)| {
                let r = f / g;
                let h = r.round();
                (h == 3.0 || h == 5.0 || h == 6.0) && (r - h).abs() / h < 0.015 && b >= 0.5 * a
            });
            fund[bin] += if overtone { w * 0.2 } else { w };
        }
        for (acc, frame) in [(&mut self.all, all), (&mut self.fund, fund)] {
            let sum: f64 = frame.iter().sum();
            if sum > 0.0 {
                acc.iter_mut().zip(frame).for_each(|(a, v)| *a += v / sum);
            }
        }
    }
}

/// How far the audio sits from A440, in histogram bins (10 cents each), from where energy
/// falls within the semitone.
pub fn tuning(hist: &[f32; PC_BINS]) -> i64 {
    let (mut s, mut c) = (0f64, 0f64);
    for (i, v) in hist.iter().enumerate() {
        let a = std::f64::consts::TAU * (i % 10) as f64 / 10.0;
        s += *v as f64 * a.sin();
        c += *v as f64 * a.cos();
    }
    (s.atan2(c) / std::f64::consts::TAU * 10.0).round() as i64
}

/// Folds a fine histogram into 12 pitch classes summing to 1 (all zero when empty).
pub fn fold(hist: &[f32; PC_BINS], shift: i64) -> [f32; 12] {
    let mut chroma = [0f32; 12];
    for (pc, out) in chroma.iter_mut().enumerate() {
        let center = pc as i64 * 10 + shift;
        *out = (-5..5).map(|j| hist[(center + j).rem_euclid(PC_BINS as i64) as usize]).sum();
    }
    let sum: f32 = chroma.iter().sum();
    if sum > 0.0 {
        chroma.iter_mut().for_each(|v| *v /= sum);
    }
    chroma
}

/// 0 for a flat pitch profile, 1 for a single pitch class.
fn tonality(chroma: &[f32; 12]) -> f32 {
    let max = chroma.iter().copied().fold(0f32, f32::max);
    if max <= 0.0 { 0.0 } else { ((max - 1.0 / 12.0) / (11.0 / 12.0)).clamp(0.0, 1.0) }
}

impl Sound {
    /// Pitch classes for key detection: overtones played down, corrected for tuning.
    pub fn key_chroma(&self) -> [f32; 12] {
        fold(&self.fund, tuning(&self.hist))
    }
}

fn envelope_features(x: &[f32], sr: f32, onset: &[f32], onset_rate: f32, out: &mut [f32]) {
    let block = ((sr / ENV_RATE) as usize).max(1);
    let env: Vec<f32> = x.chunks(block).map(|c| (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32).sqrt()).collect();
    let dt = block as f32 / sr;
    let (peak_i, peak) = env.iter().copied().enumerate().fold((0, 0f32), |a, (i, v)| if v > a.1 { (i, v) } else { a });
    if peak <= 0.0 {
        return;
    }
    let t10 = env.iter().position(|&v| v >= 0.1 * peak).unwrap_or(0);
    let t90 = env.iter().position(|&v| v >= 0.9 * peak).unwrap_or(peak_i);
    let attack = ((t90.saturating_sub(t10)).max(1)) as f32 * dt;
    let decay_end = env[peak_i..].iter().position(|&v| v < 0.1 * peak).map(|i| peak_i + i).unwrap_or(env.len());
    let decay = ((decay_end - peak_i).max(1)) as f32 * dt;
    let sum: f32 = env.iter().sum();
    let centroid = env.iter().enumerate().map(|(i, v)| i as f32 * dt * v).sum::<f32>() / sum;
    let first = env.iter().position(|&v| v >= 0.01 * peak).unwrap_or(0);
    let last = env.iter().rposition(|&v| v >= 0.01 * peak).unwrap_or(env.len() - 1);
    let active = (last + 1 - first) as f32 * dt;
    let rms = (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt();
    let max_abs = x.iter().fold(0f32, |a, v| a.max(v.abs()));

    out[0] = attack.log10();
    out[1] = decay.log10();
    out[2] = (centroid + 0.001).log10();
    out[3] = (active + 0.005).log10();
    out[4] = 20.0 * (max_abs / rms.max(1e-9)).log10();
    for (k, t) in ENV_TIMES.iter().enumerate() {
        let i = peak_i + (t / dt).round() as usize;
        out[5 + k] = env.get(i).map_or(-60.0, |&v| (20.0 * (v / peak).max(1e-6).log10()).max(-60.0));
    }
    out[13] = count_onsets(onset) as f32 / (onset.len() as f32 / onset_rate).max(0.05);
}

/// Local maxima of the onset envelope that stand out from its typical level.
pub fn count_onsets(onset: &[f32]) -> usize {
    if onset.len() < 3 {
        return 1;
    }
    let mut sorted = onset.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let median = sorted[sorted.len() / 2];
    let max = sorted[sorted.len() - 1];
    let threshold = median + 0.25 * (max - median);
    let mut n = 0;
    let mut last = usize::MAX;
    for i in 1..onset.len() - 1 {
        if onset[i] > threshold && onset[i] >= onset[i - 1] && onset[i] > onset[i + 1] && (last == usize::MAX || i - last > 3) {
            n += 1;
            last = i;
        }
    }
    n.max(1)
}

/// YIN pitch estimate over the sustained part after the loudest moment in the first second.
fn detect_pitch(x: &[f32], sr: u32) -> Option<Pitch> {
    // Work at ~22–24 kHz: plenty for fundamentals up to 1.6 kHz.
    let (y, ysr): (Vec<f32>, f32) = if sr >= 32_000 {
        (x.chunks_exact(2).take(sr as usize * 3 / 2).map(|p| (p[0] + p[1]) * 0.5).collect(), sr as f32 / 2.0)
    } else {
        (x.iter().take(sr as usize * 3).copied().collect(), sr as f32)
    };
    let w = if ysr > 16_000.0 { 1024 } else { 512 };
    let tau_min = (ysr / 1600.0) as usize;
    let tau_max = (ysr / 28.0) as usize;
    let seg = w + tau_max;
    if y.len() < seg + 1 {
        return None;
    }
    let block = (ysr * 0.005) as usize;
    let levels: Vec<f32> = y.chunks(block.max(1)).map(|c| c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32).collect();
    let search = levels.len().min((ysr * 1.0 / block as f32) as usize).max(1);
    let (peak_block, peak_level) = levels[..search].iter().copied().enumerate().fold((0, 0f32), |a, (i, v)| if v > a.1 { (i, v) } else { a });
    if peak_level <= 1e-10 {
        return None;
    }

    let m = (seg + w).next_power_of_two();
    let fft = forward(m);
    let ifft = PLANNER.with(|p| p.borrow_mut().plan_fft_inverse(m));
    let mut a_in = fft.make_input_vec();
    let mut b_in = fft.make_input_vec();
    let mut a_spec = fft.make_output_vec();
    let mut b_spec = fft.make_output_vec();
    let mut corr = ifft.make_output_vec();
    let mut d = vec![0f32; tau_max + 1];
    let mut cmnd = vec![1f32; tau_max + 1];

    let hop = w / 2;
    let mut start = peak_block * block + (ysr * 0.015) as usize;
    let mut estimates: Vec<(f32, f32)> = Vec::new();
    let mut tried = 0;
    while start + seg <= y.len() && tried < 16 {
        let s = &y[start..start + seg];
        let energy = s[..w].iter().map(|v| v * v).sum::<f32>() / w as f32;
        if energy < peak_level * 10f32.powf(-3.5) {
            break;
        }
        tried += 1;
        a_in.fill(0.0);
        b_in.fill(0.0);
        a_in[..w].copy_from_slice(&s[..w]);
        b_in[..seg].copy_from_slice(s);
        if fft.process(&mut a_in, &mut a_spec).is_err() || fft.process(&mut b_in, &mut b_spec).is_err() {
            return None;
        }
        for (a, b) in a_spec.iter_mut().zip(&b_spec) {
            *a = a.conj() * b;
        }
        a_spec[0].im = 0.0;
        if let Some(last) = a_spec.last_mut() {
            last.im = 0.0;
        }
        let _ = ifft.process(&mut a_spec, &mut corr);
        let scale = 1.0 / m as f32;
        // Energy of each lagged window from prefix sums.
        let mut prefix = vec![0f32; seg + 1];
        for i in 0..seg {
            prefix[i + 1] = prefix[i] + s[i] * s[i];
        }
        let e0 = prefix[w];
        for tau in 0..=tau_max {
            let et = prefix[tau + w] - prefix[tau];
            d[tau] = (e0 + et - 2.0 * corr[tau] * scale).max(0.0);
        }
        let mut running = 0f32;
        for tau in 1..=tau_max {
            running += d[tau];
            cmnd[tau] = if running > 0.0 { d[tau] * tau as f32 / running } else { 1.0 };
        }
        let mut best: Option<usize> = None;
        let mut tau = tau_min.max(2);
        while tau < tau_max {
            if cmnd[tau] < 0.15 {
                while tau + 1 < tau_max && cmnd[tau + 1] < cmnd[tau] {
                    tau += 1;
                }
                best = Some(tau);
                break;
            }
            tau += 1;
        }
        let tau = best.unwrap_or_else(|| (tau_min.max(2)..tau_max).min_by(|&a, &b| cmnd[a].total_cmp(&cmnd[b])).unwrap_or(tau_min));
        let (l, c, r) = (cmnd[tau - 1], cmnd[tau], cmnd[(tau + 1).min(tau_max)]);
        let denom = l - 2.0 * c + r;
        let shift = if denom.abs() > 1e-9 { (0.5 * (l - r) / denom).clamp(-0.5, 0.5) } else { 0.0 };
        estimates.push((ysr / (tau as f32 + shift), c));
        start += hop;
    }
    let voiced: Vec<f32> = estimates.iter().filter(|e| e.1 < 0.2).map(|e| 69.0 + 12.0 * (e.0 / 440.0).log2()).collect();
    if voiced.len() < 3 || voiced.len() * 2 < estimates.len() {
        return None;
    }
    let mut sorted = voiced.clone();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let median = sorted[sorted.len() / 2];
    let stable = voiced.iter().filter(|m| (*m - median).abs() < 0.6).count();
    if stable * 10 < voiced.len() * 6 {
        return None;
    }
    let ap = estimates.iter().filter(|e| e.1 < 0.2).map(|e| e.1).sum::<f32>() / voiced.len() as f32;
    let clarity = (1.0 - ap) * stable as f32 / estimates.len() as f32;
    Some(Pitch { hz: 440.0 * 2f32.powf((median - 69.0) / 12.0), clarity })
}

/// Serializes a feature vector for storage.
pub fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

pub fn from_blob(b: &[u8]) -> Option<Vec<f32>> {
    if b.len() != LEN * 4 {
        return None;
    }
    Some(b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub const SR: u32 = 44_100;

    pub fn tone(freqs: &[f32], seconds: f32, decay: f32) -> Vec<f32> {
        (0..(SR as f32 * seconds) as usize)
            .map(|i| {
                let t = i as f32 / SR as f32;
                let env = (-t * decay).exp() * (t * 400.0).min(1.0);
                freqs.iter().map(|f| (t * f * std::f32::consts::TAU).sin()).sum::<f32>() / freqs.len() as f32 * env * 0.5
            })
            .collect()
    }

    pub fn noise_burst(seconds: f32, decay: f32, seed: u32) -> Vec<f32> {
        let mut s = seed.wrapping_mul(2654435761).max(1);
        (0..(SR as f32 * seconds) as usize)
            .map(|i| {
                s ^= s << 13;
                s ^= s >> 17;
                s ^= s << 5;
                let t = i as f32 / SR as f32;
                ((s as f32 / u32::MAX as f32) * 2.0 - 1.0) * (-t * decay).exp() * 0.5
            })
            .collect()
    }

    #[test]
    fn a_sine_has_a_pitch_and_a_tonal_chroma() {
        let s = describe(&tone(&[220.0], 1.0, 1.0), SR).unwrap();
        let p = s.pitch.unwrap();
        assert!((p.hz - 220.0).abs() < 2.0, "{p:?}");
        let top = s.chroma.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
        assert_eq!(top, 9, "A: {:?}", s.chroma);
        assert!(s.tonality > 0.5);
        assert_eq!(s.features.len(), LEN);
        assert!(s.features[..DIM].iter().filter(|v| v.is_nan()).count() == 0);
    }

    #[test]
    fn low_808_pitch_is_found() {
        // An 808 at A1 (55 Hz) with a short pitch drop at the start.
        let x: Vec<f32> = (0..SR as usize)
            .map(|i| {
                let t = i as f32 / SR as f32;
                // The integral of 55 + 40·e^(−60t) Hz.
                let phase = 55.0 * t + 40.0 / 60.0 * (1.0 - (-t * 60.0).exp());
                (phase * std::f32::consts::TAU).sin() * (-t * 2.0).exp() * 0.8
            })
            .collect();
        let s = describe(&x, SR).unwrap();
        let p = s.pitch.expect("pitch");
        assert!((p.hz - 55.0).abs() < 2.0, "{p:?}");
    }

    #[test]
    fn noise_has_no_pitch_and_is_bright_and_flat() {
        let hat = describe(&noise_burst(0.3, 25.0, 1), SR).unwrap();
        let kick = describe(&tone(&[50.0], 0.4, 12.0), SR).unwrap();
        assert!(hat.pitch.is_none());
        assert!(hat.features[BRIGHTNESS] > 5.0 * kick.features[BRIGHTNESS]);
        assert!(hat.features[28] > kick.features[28] + 10.0, "flatness {} vs {}", hat.features[28], kick.features[28]);
        assert!(hat.tonality < 0.3, "{}", hat.tonality);
    }

    #[test]
    fn envelope_tells_hits_from_swells() {
        let hit = describe(&tone(&[300.0], 1.0, 20.0), SR).unwrap();
        let swell: Vec<f32> = (0..SR as usize).map(|i| {
            let t = i as f32 / SR as f32;
            (t * 300.0 * std::f32::consts::TAU).sin() * t * 0.5
        }).collect();
        let swell = describe(&swell, SR).unwrap();
        let (a_hit, a_swell) = (hit.features[ENVELOPE.start], swell.features[ENVELOPE.start]);
        assert!(a_swell > a_hit + 1.0, "attack {a_hit} vs {a_swell}");
        // 200 ms after the peak the hit has decayed, the swell has ended.
        assert!(hit.features[ENVELOPE.start + 9] < -15.0);
    }

    #[test]
    fn silence_is_not_described() {
        assert!(describe(&vec![0.0; 44_100], SR).is_none());
        assert!(describe(&[], SR).is_none());
    }

    #[test]
    fn collector_downmixes_and_decimates() {
        let mut c = Collector::new(96_000);
        let stereo: Vec<f32> = (0..96_000).flat_map(|i| {
            let v = (i as f32 / 96_000.0 * 440.0 * std::f32::consts::TAU).sin() * 0.5;
            [v, v]
        }).collect();
        c.push(&stereo, 2);
        assert_eq!(c.rate, 48_000);
        assert_eq!(c.mono.len(), 48_000);
        let s = c.finish().unwrap();
        assert!((s.pitch.unwrap().hz - 440.0).abs() < 3.0);
    }

    #[test]
    fn blobs_round_trip() {
        let v: Vec<f32> = (0..LEN).map(|i| i as f32 * 0.5).collect();
        assert_eq!(from_blob(&to_blob(&v)).unwrap(), v);
        assert!(from_blob(&[0; 12]).is_none());
    }
}
