//! Records a few seconds from the microphone, to search the library by imitating a sound.
//! The input device is only opened while recording.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{bounded, Receiver, RecvTimeoutError, Sender};
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const MAX_SECONDS: f32 = 8.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordLevel {
    /// RMS of the last ~50 ms, 0–1.
    pub level: f32,
    pub seconds: f32,
    /// Stopped by itself at `MAX_SECONDS`.
    pub done: bool,
}

pub type EmitLevel = Arc<dyn Fn(RecordLevel) + Send + Sync>;

pub struct Recording {
    pub samples: Vec<f32>,
    pub rate: u32,
}

struct Active {
    stop: Sender<()>,
    done: Receiver<Result<Recording, String>>,
}

#[derive(Default)]
pub struct Recorder {
    active: Mutex<Option<Active>>,
}

impl Recorder {
    pub fn start(&self, emit: EmitLevel) -> Result<(), String> {
        let mut active = self.active.lock();
        // Still listening; a recording that stopped by itself is replaced.
        if active.as_ref().is_some_and(|a| a.done.is_empty()) {
            return Ok(());
        }
        let (stop_tx, stop_rx) = bounded(1);
        let (done_tx, done_rx) = bounded(1);
        let (ready_tx, ready_rx) = bounded(1);
        std::thread::Builder::new()
            .name("saga-record".into())
            .spawn(move || {
                let _ = done_tx.send(record(stop_rx, ready_tx, emit));
            })
            .map_err(|e| e.to_string())?;
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => {
                *active = Some(Active { stop: stop_tx, done: done_rx });
                Ok(())
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err("The microphone didn't respond".into()),
        }
    }

    /// Stops (if still running) and returns what was heard.
    pub fn stop(&self) -> Result<Recording, String> {
        let active = self.active.lock().take().ok_or("Nothing is being recorded")?;
        let _ = active.stop.send(());
        active.done.recv_timeout(Duration::from_secs(5)).map_err(|_| "The recording didn't finish".to_string())?
    }

    pub fn cancel(&self) {
        if let Some(a) = self.active.lock().take() {
            let _ = a.stop.send(());
        }
    }
}

fn build<T>(device: &cpal::Device, config: &cpal::StreamConfig, buf: Arc<Mutex<Vec<f32>>>, cap: usize) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let channels = config.channels.max(1) as usize;
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let mut b = buf.lock();
                for frame in data.chunks(channels) {
                    if b.len() >= cap {
                        return;
                    }
                    let sum: f32 = frame.iter().map(|s| <f32 as cpal::FromSample<T>>::from_sample_(*s)).sum();
                    b.push(sum / frame.len() as f32);
                }
            },
            |e| eprintln!("saga: microphone error: {e}"),
            None,
        )
        .map_err(|e| e.to_string())
}

fn record(stop: Receiver<()>, ready: Sender<Result<(), String>>, emit: EmitLevel) -> Result<Recording, String> {
    let fail = |msg: String| {
        let _ = ready.send(Err(msg.clone()));
        Err(msg)
    };
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else { return fail("No microphone found".into()) };
    let supported = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => return fail(format!("The microphone isn't available: {e}")),
    };
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let rate = config.sample_rate.0;
    let cap = (rate as f32 * (MAX_SECONDS + 0.5)) as usize;
    let buf = Arc::new(Mutex::new(Vec::with_capacity(cap)));
    let stream = match format {
        cpal::SampleFormat::F32 => build::<f32>(&device, &config, buf.clone(), cap),
        cpal::SampleFormat::I16 => build::<i16>(&device, &config, buf.clone(), cap),
        cpal::SampleFormat::U16 => build::<u16>(&device, &config, buf.clone(), cap),
        cpal::SampleFormat::I32 => build::<i32>(&device, &config, buf.clone(), cap),
        other => Err(format!("unsupported sample format {other:?}")),
    };
    let stream = match stream.and_then(|s| s.play().map(|_| s).map_err(|e| e.to_string())) {
        Ok(s) => s,
        Err(e) => return fail(format!("Couldn't open the microphone: {e}")),
    };
    let _ = ready.send(Ok(()));

    let started = Instant::now();
    let mut seen = 0;
    loop {
        match stop.recv_timeout(Duration::from_millis(50)) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
        let level = {
            let b = buf.lock();
            let new = &b[seen.min(b.len())..];
            let rms = if new.is_empty() { 0.0 } else { (new.iter().map(|v| v * v).sum::<f32>() / new.len() as f32).sqrt() };
            seen = b.len();
            rms
        };
        let seconds = started.elapsed().as_secs_f32();
        let done = seconds >= MAX_SECONDS;
        emit(RecordLevel { level, seconds, done });
        if done {
            break;
        }
    }
    drop(stream);
    let samples = std::mem::take(&mut *buf.lock());
    Ok(Recording { samples, rate })
}

/// The part of a recording with sound in it, or an error if it's (nearly) silent.
pub fn trim(r: &Recording) -> Result<&[f32], String> {
    let peak = r.samples.iter().fold(0f32, |a, v| a.max(v.abs()));
    if peak < 1e-3 {
        return Err("Saga couldn't hear anything. Check that it may use the microphone in System Settings › Privacy & Security › Microphone.".into());
    }
    let threshold = peak * 0.05;
    let first = r.samples.iter().position(|v| v.abs() >= threshold).unwrap_or(0);
    let last = r.samples.iter().rposition(|v| v.abs() >= threshold).unwrap_or(r.samples.len() - 1);
    let pad = r.rate as usize / 20;
    Ok(&r.samples[first.saturating_sub(pad / 5)..(last + pad).min(r.samples.len())])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_to_the_sound() {
        let mut samples = vec![0.0001; 10_000];
        samples.extend((0..4410).map(|i| (i as f32 * 0.1).sin() * 0.5));
        samples.extend(vec![0.0001; 10_000]);
        let r = Recording { samples, rate: 44_100 };
        let t = trim(&r).unwrap();
        // The sound, 10 ms before it and 50 ms after.
        assert!(t.len() >= 4410 && t.len() <= 4410 + 441 + 2205 + 10, "{}", t.len());
        assert!(trim(&Recording { samples: vec![0.0; 1000], rate: 44_100 }).is_err());
    }
}
