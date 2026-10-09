//! Windows: records one app, or everything you hear except Saga, through WASAPI process loopback
//! (Windows 10 version 2004 and later), and lists the apps that are playing with their names and icons.

use crate::capture::{AppSource, Lost, Opened, Problem, Sink};
use base64::Engine as _;
use crossbeam_channel::{bounded, Sender};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use windows::core::{implement, Interface, Ref, HRESULT, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, E_FAIL, HANDLE, S_OK};
use windows::Win32::Graphics::Gdi::{DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ};
use windows::Win32::Media::Audio::{
    eConsole, eRender, ActivateAudioInterfaceAsync, AudioSessionStateActive, AudioSessionStateExpired, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient, IAudioSessionControl2,
    IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, DEVICE_STATE_ACTIVE,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, BLOB, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows::Win32::System::Threading::{
    CreateEventW, GetCurrentProcessId, GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::Variant::VT_BLOB;
use windows::Win32::UI::Shell::ExtractIconExW;
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

/// `GetExitCodeProcess` while the process runs.
const STILL_ACTIVE: u32 = 259;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;

/// Process loopback arrived in Windows 10 version 2004 (build 19041).
pub fn process_loopback_supported() -> bool {
    let mut info = OSVERSIONINFOW { dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32, ..Default::default() };
    // SAFETY: fills the struct it's given, whose size is set as the call requires.
    let _ = unsafe { windows::Wdk::System::SystemServices::RtlGetVersion(&mut info) };
    info.dwBuildNumber >= 19041
}

/// COM for the calling thread, released when dropped. A thread that already chose another model keeps it.
struct Com(bool);

impl Com {
    fn init() -> Com {
        // SAFETY: paired with CoUninitialize in Drop, only when this call succeeded.
        Com(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: balances the successful CoInitializeEx above, on the same thread.
            unsafe { CoUninitialize() };
        }
    }
}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Activated(Sender<()>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
    fn ActivateCompleted(&self, _op: Ref<'_, IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
        let _ = self.0.send(());
        Ok(())
    }
}

/// An audio client that hears one process tree (`include`), or everything but it.
unsafe fn activate(pid: u32, include: bool) -> windows::core::Result<IAudioClient> {
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: if include { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE } else { PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE },
            },
        },
    };
    // A blob pointing at `params`, which outlives the call. Never dropped: PROPVARIANT's Drop would
    // hand the blob (on the stack) to PropVariantClear and corrupt the heap.
    let mut pv = std::mem::ManuallyDrop::new(PROPVARIANT::default());
    {
        let inner = &mut *pv.Anonymous.Anonymous;
        inner.vt = VT_BLOB;
        inner.Anonymous.blob = BLOB { cbSize: std::mem::size_of_val(&params) as u32, pBlobData: &params as *const _ as *mut u8 };
    }
    let (tx, rx) = bounded(1);
    let handler: IActivateAudioInterfaceCompletionHandler = Activated(tx).into();
    let op = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&*pv), &handler)?;
    rx.recv_timeout(Duration::from_secs(5)).map_err(|_| windows::core::Error::from(E_FAIL))?;
    let mut hr = HRESULT(0);
    let mut unknown = None;
    op.GetActivateResult(&mut hr, &mut unknown)?;
    hr.ok()?;
    unknown.ok_or_else(|| windows::core::Error::from(E_FAIL))?.cast()
}

/// The rate the system mixes at, so the take isn't resampled on its way in.
unsafe fn mix_rate() -> windows::core::Result<u32> {
    let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let device = devices.GetDefaultAudioEndpoint(eRender, eConsole)?;
    let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
    let format = client.GetMixFormat()?;
    let rate = (*format).nSamplesPerSec;
    CoTaskMemFree(Some(format as *const _));
    Ok(rate)
}

fn process_running(pid: u32) -> bool {
    // SAFETY: the handle is closed before returning; failures read as "not running" only when the
    // process is really gone.
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code).is_ok();
        let _ = CloseHandle(h);
        !ok || code == STILL_ACTIVE
    }
}

/// Stops the capture thread when the session closes.
struct Stopper {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Stopper {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Opens a loopback of one app (`Some(pid)`), or of everything except Saga (`None`).
pub fn open(target: Option<u32>, name: &str, sink: Sink, lost: Arc<Lost>) -> Result<Opened, Problem> {
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = bounded(1);
    let (stop2, label) = (stop.clone(), name.to_string());
    let thread = std::thread::Builder::new()
        .name("saga-loopback".into())
        .spawn(move || capture(target, &label, sink, lost, stop2, ready_tx))
        .map_err(|e| Problem::msg(e.to_string()))?;
    let stopper = Stopper { stop, thread: Some(thread) };
    let rate = match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(rate)) => rate,
        Ok(Err(p)) => return Err(p),
        Err(_) => return Err(Problem::msg(format!("{name} didn't respond."))),
    };
    Ok(Opened { rate, channels: 2, name: name.to_string(), _open: Box::new(stopper) })
}

fn capture(target: Option<u32>, name: &str, sink: Sink, lost: Arc<Lost>, stop: Arc<AtomicBool>, ready: Sender<Result<u32, Problem>>) {
    let _com = Com::init();
    // SAFETY: COM is initialized on this thread; every interface used here is created and dropped on it.
    let opened = unsafe {
        (|| -> windows::core::Result<(IAudioClient, IAudioCaptureClient, HANDLE, u32)> {
            let rate = mix_rate().unwrap_or(48_000);
            let (pid, include) = match target {
                Some(pid) => (pid, true),
                None => (GetCurrentProcessId(), false),
            };
            let client = activate(pid, include)?;
            let format = WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
                nChannels: 2,
                nSamplesPerSec: rate,
                nAvgBytesPerSec: rate * 8,
                nBlockAlign: 8,
                wBitsPerSample: 32,
                cbSize: 0,
            };
            let flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
            // 200 ms of buffer, in 100 ns units.
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2_000_000, 0, &format, None)?;
            let event = CreateEventW(None, false, false, None)?;
            client.SetEventHandle(event)?;
            let capture: IAudioCaptureClient = client.GetService()?;
            client.Start()?;
            Ok((client, capture, event, rate))
        })()
    };
    let (client, capture, event, rate) = match opened {
        Ok(x) => x,
        Err(e) => {
            let _ = ready.send(Err(Problem::msg(format!("Couldn't record {name}: {}", e.message()))));
            return;
        }
    };
    let _ = ready.send(Ok(rate));

    let started = Instant::now();
    let mut delivered: u64 = 0;
    let mut checked = Instant::now();
    'run: while !stop.load(Ordering::Acquire) {
        // Woken by a packet or after 100 ms; either way, take whatever is waiting.
        // SAFETY: the event belongs to this thread's client and stays open until the loop ends.
        let _ = unsafe { WaitForSingleObject(event, 100) };
        {
            loop {
                // SAFETY: GetBuffer and ReleaseBuffer are paired, and the buffer is read only in between.
                match unsafe { capture.GetNextPacketSize() } {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(_) => {
                        lost.set("stopped");
                        break 'run;
                    }
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let (mut frames, mut flags) = (0u32, 0u32);
                // SAFETY: as above.
                if unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }.is_err() {
                    lost.set("stopped");
                    break 'run;
                }
                let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null();
                let n = frames as usize * 2;
                sink.send(|out| {
                    if silent {
                        out.resize(n, 0.0);
                    } else {
                        // SAFETY: WASAPI hands over `frames` frames of the float stereo format asked for.
                        out.extend_from_slice(unsafe { std::slice::from_raw_parts(data as *const f32, n) });
                    }
                });
                // SAFETY: releases exactly what GetBuffer returned.
                let _ = unsafe { capture.ReleaseBuffer(frames) };
                delivered += frames as u64;
            }
        }
        // Loopback hands over nothing while nothing plays, so silence is filled in by the clock and
        // the take keeps time through pauses.
        let expected = (started.elapsed().as_secs_f64() * rate as f64) as u64;
        let slack = rate as u64 / 10;
        if expected > delivered + slack {
            let mut missing = expected - delivered - slack / 2;
            delivered += missing;
            while missing > 0 {
                let chunk = missing.min(8192);
                sink.send(|out| out.resize(chunk as usize * 2, 0.0));
                missing -= chunk;
            }
        }
        if let Some(pid) = target {
            if checked.elapsed() >= Duration::from_secs(1) {
                checked = Instant::now();
                if !process_running(pid) {
                    lost.set("stopped");
                    break;
                }
            }
        }
    }
    // SAFETY: the client and event were made on this thread and are released once.
    unsafe {
        let _ = client.Stop();
        let _ = CloseHandle(event);
    }
}

// ---- apps that are playing ----

fn exe_path(pid: u32) -> Option<String> {
    // SAFETY: the handle is closed before returning; the buffer's length is passed with it.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The name an app gives itself ("Google Chrome"), from its version information.
fn file_description(path: &str) -> Option<String> {
    let w = wide(path);
    // SAFETY: the version block is sized by the first call and only read inside it.
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(w.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(w.as_ptr()), None, size, data.as_mut_ptr() as *mut _).ok()?;
        let mut ptr: *mut core::ffi::c_void = std::ptr::null_mut();
        let mut len = 0u32;
        let translation = wide("\\VarFileInfo\\Translation");
        if !VerQueryValueW(data.as_ptr() as *const _, PCWSTR(translation.as_ptr()), &mut ptr, &mut len).as_bool() || len < 4 {
            return None;
        }
        let pair = ptr as *const u16;
        let key = wide(&format!("\\StringFileInfo\\{:04x}{:04x}\\FileDescription", *pair, *pair.add(1)));
        if !VerQueryValueW(data.as_ptr() as *const _, PCWSTR(key.as_ptr()), &mut ptr, &mut len).as_bool() || len == 0 {
            return None;
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr as *const u16, len as usize));
        let text = text.trim_end_matches('\0').trim().to_string();
        (!text.is_empty()).then_some(text)
    }
}

/// "chrome.exe" → "Chrome", when an app has no description.
fn name_from_exe(path: &str) -> String {
    let stem = std::path::Path::new(path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let mut c = stem.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => stem,
    }
}

/// The app's icon as a PNG data URL.
fn icon_png(path: &str) -> Option<String> {
    let w = wide(path);
    let mut icon = HICON::default();
    // SAFETY: asks for one large icon into `icon`, destroyed below.
    let n = unsafe { ExtractIconExW(PCWSTR(w.as_ptr()), 0, Some(&mut icon), None, 1) };
    if n == 0 || icon.is_invalid() {
        return None;
    }
    // SAFETY: the icon came from ExtractIconExW and is destroyed once.
    let png = unsafe { hicon_png(icon) };
    unsafe {
        let _ = DestroyIcon(icon);
    }
    png
}

unsafe fn hicon_png(icon: HICON) -> Option<String> {
    let mut info = ICONINFO::default();
    GetIconInfo(icon, &mut info).ok()?;
    let (color, mask) = (info.hbmColor, info.hbmMask);
    let free = || {
        let _ = DeleteObject(HGDIOBJ(color.0));
        let _ = DeleteObject(HGDIOBJ(mask.0));
    };
    if color.is_invalid() {
        free();
        return None;
    }
    let mut bm = BITMAP::default();
    GetObjectW(HGDIOBJ(color.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _));
    let (w, h) = (bm.bmWidth, bm.bmHeight);
    if w <= 0 || h <= 0 || w > 256 || h > 256 {
        free();
        return None;
    }
    let mut bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            // Negative: rows from the top.
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut px = vec![0u8; (w * h * 4) as usize];
    let dc = GetDC(None);
    let lines = GetDIBits(dc, color, 0, h as u32, Some(px.as_mut_ptr() as *mut _), &mut bmi, DIB_RGB_COLORS);
    ReleaseDC(None, dc);
    free();
    if lines == 0 {
        return None;
    }
    // Old icons keep transparency in the mask, not the alpha channel; show those opaque.
    let has_alpha = px.chunks_exact(4).any(|p| p[3] != 0);
    for p in px.chunks_exact_mut(4) {
        p.swap(0, 2);
        if !has_alpha {
            p[3] = 255;
        }
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(&px).ok()?;
    }
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(out)))
}

/// Apps with audio sessions on any output, the ones making sound first. Saga itself and Windows'
/// system sounds are left out.
pub fn apps() -> Result<Vec<AppSource>, String> {
    let _com = Com::init();
    // SAFETY: COM is initialized on this thread; interfaces are used and dropped here.
    let sessions = unsafe { sessions() }.map_err(|e| e.message())?;
    let mut by_exe: HashMap<String, AppSource> = HashMap::new();
    for (pid, playing) in sessions {
        let Some(exe) = exe_path(pid) else { continue };
        let key = exe.to_lowercase();
        match by_exe.get_mut(&key) {
            Some(app) => {
                // The process actually making sound is the one to record (browsers play from a helper).
                if playing && !app.playing {
                    app.pid = pid;
                    app.playing = true;
                }
            }
            None => {
                let name = file_description(&exe).unwrap_or_else(|| name_from_exe(&exe));
                by_exe.insert(key, AppSource { pid, name, icon: icon_png(&exe), playing });
            }
        }
    }
    let mut apps: Vec<AppSource> = by_exe.into_values().collect();
    apps.sort_by(|a, b| b.playing.cmp(&a.playing).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(apps)
}

/// Every audio session's process, and whether it's making sound.
unsafe fn sessions() -> windows::core::Result<Vec<(u32, bool)>> {
    let own = GetCurrentProcessId();
    let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let outputs = devices.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
    let mut out = Vec::new();
    for i in 0..outputs.GetCount()? {
        let Ok(device) = outputs.Item(i) else { continue };
        let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
        let Ok(list) = manager.GetSessionEnumerator() else { continue };
        for j in 0..list.GetCount().unwrap_or(0) {
            let Ok(session) = list.GetSession(j) else { continue };
            let Ok(control) = session.cast::<IAudioSessionControl2>() else { continue };
            if control.IsSystemSoundsSession() == S_OK {
                continue;
            }
            let Ok(pid) = control.GetProcessId() else { continue };
            let state = session.GetState().unwrap_or(AudioSessionStateExpired);
            if pid == 0 || pid == own || state == AudioSessionStateExpired {
                continue;
            }
            out.push((pid, state == AudioSessionStateActive));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_apps_without_a_description_after_their_file() {
        assert_eq!(name_from_exe(r"C:\Program Files\Foo\spotify.exe"), "Spotify");
    }

    /// Opens everything-but-Saga for a second on this machine's real output and counts what came
    /// through (silence included): `cargo test --lib hears_the_system -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn hears_the_system() {
        let (free_tx, free_rx) = bounded(64);
        let (full_tx, full_rx) = bounded(64);
        for _ in 0..64 {
            free_tx.send(Vec::with_capacity(1 << 15)).unwrap();
        }
        let sink = Sink::for_test(free_rx, full_tx);
        let opened = open(None, "Desktop audio", sink, Arc::new(Lost::default())).unwrap();
        let start = Instant::now();
        let (mut samples, mut peak) = (0usize, 0f32);
        while start.elapsed() < Duration::from_millis(1200) {
            if let Ok(buf) = full_rx.recv_timeout(Duration::from_millis(50)) {
                samples += buf.len();
                peak = buf.iter().fold(peak, |a, s| a.max(s.abs()));
                let _ = free_tx.send(buf);
            }
        }
        println!("rate {} · {:.2} s heard · peak {peak:.3}", opened.rate, samples as f32 / 2.0 / opened.rate as f32);
        assert!(samples as f32 / 2.0 / opened.rate as f32 > 0.9);
    }

    /// Lists this machine's apps; only meaningful by hand: `cargo test --lib lists_apps -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn lists_apps() {
        for a in apps().unwrap() {
            println!("{} {} playing={} icon={}", a.pid, a.name, a.playing, a.icon.is_some());
        }
    }
}
