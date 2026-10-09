//! macOS: records one app, or everything you hear except Saga, through Core Audio process taps
//! (macOS 14.2 and later), and lists the apps that are playing with their names and icons. The
//! first tap asks for the "System Audio Recording" permission (`NSAudioCaptureUsageDescription`).

use crate::capture::{AppSource, Lost, Opened, Problem, Sink};
use base64::Engine as _;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AllocAnyThread;
use crossbeam_channel::{bounded, RecvTimeoutError, Sender};
use objc2_app_kit::{NSApplicationActivationPolicy, NSBitmapImageFileType, NSBitmapImageRep, NSRunningApplication};
use objc2_core_audio::{
    kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceIsStackedKey, kAudioAggregateDeviceMainSubDeviceKey, kAudioAggregateDeviceNameKey,
    kAudioAggregateDeviceSubDeviceListKey, kAudioAggregateDeviceTapAutoStartKey, kAudioAggregateDeviceTapListKey, kAudioAggregateDeviceUIDKey,
    kAudioDevicePropertyDeviceUID, kAudioHardwarePropertyDefaultSystemOutputDevice, kAudioHardwarePropertyProcessObjectList,
    kAudioHardwarePropertyTranslatePIDToProcessObject, kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    kAudioProcessPropertyBundleID, kAudioProcessPropertyIsRunningOutput, kAudioProcessPropertyPID, kAudioSubDeviceUIDKey, kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey,
    kAudioTapPropertyDescription, kAudioTapPropertyFormat, AudioDeviceCreateIOProcID, AudioDeviceDestroyIOProcID, AudioDeviceIOProcID, AudioDeviceStart, AudioDeviceStop,
    AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap, AudioHardwareDestroyAggregateDevice, AudioHardwareDestroyProcessTap,
    AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectID, AudioObjectSetPropertyData, AudioObjectPropertyAddress, CATapDescription, CATapMuteBehavior,
};
use objc2_core_audio_types::{kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved, AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp};
use objc2_core_foundation::CFDictionary;
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSOperatingSystemVersion, NSProcessInfo, NSString, NSUUID};
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr};
use std::ptr::NonNull;
use std::sync::{Arc, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;

/// Process taps arrived in macOS 14.2.
pub fn taps_supported() -> bool {
    NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(NSOperatingSystemVersion { majorVersion: 14, minorVersion: 2, patchVersion: 0 })
}

fn address(selector: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress { mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain }
}

const SYSTEM: AudioObjectID = kAudioObjectSystemObject as AudioObjectID;

/// Reads a fixed-size property, with an optional qualifier.
unsafe fn get<T: Copy>(object: AudioObjectID, selector: u32, qualifier: Option<&[u8]>) -> Option<T> {
    let mut addr = address(selector);
    let mut value = std::mem::MaybeUninit::<T>::zeroed();
    let mut size = std::mem::size_of::<T>() as u32;
    let (qualifier_size, qualifier) = qualifier.map_or((0, std::ptr::null()), |q| (q.len() as u32, q.as_ptr() as *const c_void));
    let status = AudioObjectGetPropertyData(
        object,
        NonNull::from(&mut addr),
        qualifier_size,
        qualifier,
        NonNull::from(&mut size),
        NonNull::new_unchecked(value.as_mut_ptr() as *mut c_void),
    );
    (status == 0).then(|| value.assume_init())
}

/// Reads a list of object ids.
unsafe fn get_list(object: AudioObjectID, selector: u32) -> Vec<AudioObjectID> {
    let mut addr = address(selector);
    let mut size = 0u32;
    if AudioObjectGetPropertyDataSize(object, NonNull::from(&mut addr), 0, std::ptr::null(), NonNull::from(&mut size)) != 0 || size == 0 {
        return Vec::new();
    }
    let mut ids = vec![0 as AudioObjectID; size as usize / std::mem::size_of::<AudioObjectID>()];
    let status = AudioObjectGetPropertyData(
        object,
        NonNull::from(&mut addr),
        0,
        std::ptr::null(),
        NonNull::from(&mut size),
        NonNull::new_unchecked(ids.as_mut_ptr() as *mut c_void),
    );
    if status != 0 {
        return Vec::new();
    }
    ids.truncate(size as usize / std::mem::size_of::<AudioObjectID>());
    ids
}

/// Reads a string property, which Core Audio hands over retained.
unsafe fn get_string(object: AudioObjectID, selector: u32) -> Option<Retained<NSString>> {
    let raw: *mut NSString = get(object, selector, None)?;
    Retained::from_raw(raw)
}

/// A process connected to Core Audio. Most never play anything: system services and apps that only
/// looked at the devices are listed too.
struct Client {
    object: AudioObjectID,
    pid: i32,
    /// Core Audio knows it even for helpers that aren't apps of their own.
    bundle: Option<String>,
    /// Sending sound to an output right now.
    playing: bool,
}

/// Every process Core Audio knows.
unsafe fn clients() -> Vec<Client> {
    get_list(SYSTEM, kAudioHardwarePropertyProcessObjectList)
        .into_iter()
        .filter_map(|object| {
            let pid: i32 = get(object, kAudioProcessPropertyPID, None)?;
            let bundle = get_string(object, kAudioProcessPropertyBundleID).map(|s| s.to_string()).filter(|s| !s.is_empty());
            let playing = get::<u32>(object, kAudioProcessPropertyIsRunningOutput, None).unwrap_or(0) != 0;
            Some(Client { object, pid, bundle, playing })
        })
        .collect()
}

/// The process macOS holds responsible for `pid`: the app that started a helper or an XPC service,
/// such as a browser's audio process or WebKit's media process. Activity Monitor groups processes
/// the same way. The function is private, so it's looked up at run time, and without it helpers are
/// matched by bundle identifier alone.
fn responsible_pid(pid: i32) -> Option<i32> {
    type Responsible = unsafe extern "C" fn(i32) -> i32;
    extern "C" {
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }
    const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;
    static FUNCTION: OnceLock<Option<Responsible>> = OnceLock::new();
    let function = FUNCTION.get_or_init(|| {
        // SAFETY: dlsym with RTLD_DEFAULT only reads the loaded images; a found symbol has this signature.
        let symbol = unsafe { dlsym(RTLD_DEFAULT, c"responsibility_get_pid_responsible_for_pid".as_ptr()) };
        (!symbol.is_null()).then(|| unsafe { std::mem::transmute::<*mut c_void, Responsible>(symbol) })
    });
    // SAFETY: takes any pid and returns -1 for one it doesn't know.
    let responsible = unsafe { (*function)?(pid) };
    (responsible > 0).then_some(responsible)
}

fn running_app(pid: i32) -> Option<Retained<NSRunningApplication>> {
    NSRunningApplication::runningApplicationWithProcessIdentifier(pid).filter(|a| !a.isTerminated())
}

/// The app a process plays for. A helper counts as the app responsible for it or, failing that, as
/// the running app whose bundle identifier its own extends ("com.google.Chrome.helper" →
/// "com.google.Chrome"). Helpers are often not apps themselves, so they're never required to be one.
fn owner(client: &Client) -> Option<Retained<NSRunningApplication>> {
    if let Some(app) = responsible_pid(client.pid).filter(|&pid| pid != client.pid).and_then(running_app) {
        return Some(app);
    }
    let own = running_app(client.pid);
    if own.as_ref().is_some_and(|a| a.activationPolicy() == NSApplicationActivationPolicy::Regular) {
        return own;
    }
    if let Some(id) = client.bundle.clone().or_else(|| own.as_ref().and_then(|a| a.bundleIdentifier()).map(|s| s.to_string())) {
        let parts: Vec<&str> = id.split('.').collect();
        for n in (2..parts.len()).rev() {
            let prefix = NSString::from_str(&parts[..n].join("."));
            let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&prefix);
            if let Some(app) = apps.iter().find(|a| !a.isTerminated()) {
                return Some(app);
            }
        }
    }
    own
}

/// The Core Audio objects of an app and every helper that plays for it.
unsafe fn objects_of(app_pid: i32) -> Vec<AudioObjectID> {
    clients().into_iter().filter(|c| c.pid == app_pid || owner(c).is_some_and(|a| a.processIdentifier() == app_pid)).map(|c| c.object).collect()
}

/// The app's icon as a PNG data URL, from the representation nearest 32 pixels wide.
fn icon_png(app: &NSRunningApplication) -> Option<String> {
    let tiff = app.icon()?.TIFFRepresentation()?;
    let mut best: Option<(isize, Retained<NSBitmapImageRep>)> = None;
    for rep in NSBitmapImageRep::imageRepsWithData(&tiff).to_vec() {
        let Ok(bitmap) = rep.downcast::<NSBitmapImageRep>() else { continue };
        let w = bitmap.pixelsWide();
        let score = if w >= 32 { w - 32 } else { 1000 + 32 - w };
        if best.as_ref().is_none_or(|(s, _)| score < *s) {
            best = Some((score, bitmap));
        }
    }
    let (_, bitmap) = best?;
    // SAFETY: an empty properties dictionary is valid for PNG.
    let png = unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png.to_vec())))
}

/// Apps connected to Core Audio, the ones making sound first. Helpers count as their app. Apps in
/// the Dock are always listed and menu bar apps only while they play. Saga, background services and
/// system agents (Control Center, universalaccessd) never are.
pub fn apps() -> Vec<AppSource> {
    let own = std::process::id() as i32;
    let mut by_app: HashMap<i32, (Retained<NSRunningApplication>, bool)> = HashMap::new();
    // SAFETY: plain property reads on Core Audio objects.
    for client in unsafe { clients() } {
        if client.pid <= 0 || client.pid == own {
            continue;
        }
        let Some(app) = owner(&client) else { continue };
        let app_pid = app.processIdentifier();
        if app_pid != own {
            by_app.entry(app_pid).or_insert((app, false)).1 |= client.playing;
        }
    }
    let mut apps: Vec<AppSource> = by_app
        .into_iter()
        .filter(|(_, (app, playing))| match app.activationPolicy() {
            NSApplicationActivationPolicy::Regular => true,
            NSApplicationActivationPolicy::Accessory => *playing,
            _ => false,
        })
        .map(|(pid, (app, playing))| {
            let name = app.localizedName().map(|n| n.to_string()).unwrap_or_else(|| format!("Process {pid}"));
            AppSource { pid: pid as u32, name, icon: icon_png(&app), playing }
        })
        .collect();
    apps.sort_by(|a, b| b.playing.cmp(&a.playing).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    apps
}

/// What the IO callback needs.
struct Io {
    sink: Sink,
    interleaved: bool,
    /// How many of the input buffers are the tap's: one when interleaved, else one per channel.
    tap_buffers: usize,
}

unsafe extern "C-unwind" fn io_proc(
    _device: AudioObjectID,
    _now: NonNull<AudioTimeStamp>,
    input: NonNull<AudioBufferList>,
    _input_time: NonNull<AudioTimeStamp>,
    _output: NonNull<AudioBufferList>,
    _output_time: NonNull<AudioTimeStamp>,
    client: *mut c_void,
) -> i32 {
    let io = &*(client as *const Io);
    let list = input.as_ref();
    let all = std::slice::from_raw_parts(list.mBuffers.as_ptr(), list.mNumberBuffers as usize);
    // The aggregate's inputs are the output device's own inputs first, then the tap's. An audio
    // interface brings its mic and line inputs, and a virtual device its copy of everything playing
    // at the device's volume, so only the last buffers are the app.
    let buffers = &all[all.len().saturating_sub(io.tap_buffers)..];
    let Some(first) = buffers.first() else { return 0 };
    if first.mData.is_null() {
        return 0;
    }
    if io.interleaved || buffers.len() == 1 {
        let ch = first.mNumberChannels.max(1) as usize;
        let samples = std::slice::from_raw_parts(first.mData as *const f32, first.mDataByteSize as usize / 4);
        io.sink.send(|out| {
            for frame in samples.chunks_exact(ch) {
                out.push(frame[0]);
                out.push(frame[ch.min(2) - 1]);
            }
        });
    } else {
        let left = std::slice::from_raw_parts(first.mData as *const f32, first.mDataByteSize as usize / 4);
        let right = match buffers.get(1).filter(|b| !b.mData.is_null()) {
            Some(b) => std::slice::from_raw_parts(b.mData as *const f32, b.mDataByteSize as usize / 4),
            None => left,
        };
        io.sink.send(|out| {
            for (l, r) in left.iter().zip(right) {
                out.push(*l);
                out.push(*r);
            }
        });
    }
    0
}

/// The tap, the private aggregate device that reads it, and the callback, torn down in order.
struct Tap {
    tap: AudioObjectID,
    device: AudioObjectID,
    proc_id: AudioDeviceIOProcID,
    io: *mut Io,
    /// Dropping it wakes the watcher, which ends.
    stop: Option<Sender<()>>,
    watcher: Option<JoinHandle<()>>,
}

impl Drop for Tap {
    fn drop(&mut self) {
        // The watcher may be changing the tap, so it ends first.
        self.stop.take();
        if let Some(w) = self.watcher.take() {
            let _ = w.join();
        }
        // SAFETY: each object was created by `open` and is released once; the callback is stopped
        // and removed before the state it reads is freed.
        unsafe {
            if self.proc_id.is_some() {
                AudioDeviceStop(self.device, self.proc_id);
                AudioDeviceDestroyIOProcID(self.device, self.proc_id);
            }
            if self.device != 0 {
                AudioHardwareDestroyAggregateDevice(self.device);
            }
            if self.tap != 0 {
                AudioHardwareDestroyProcessTap(self.tap);
            }
            if !self.io.is_null() {
                drop(Box::from_raw(self.io));
            }
        }
    }
}

fn numbers(objects: &[AudioObjectID]) -> Retained<NSArray<NSNumber>> {
    let numbers: Vec<Retained<NSNumber>> = objects.iter().map(|&o| NSNumber::new_u32(o)).collect();
    NSArray::from_retained_slice(&numbers)
}

/// Points an open tap at another set of processes, keeping everything else about it.
unsafe fn retarget(tap: AudioObjectID, objects: &[AudioObjectID]) -> bool {
    let Some(raw) = get::<*mut CATapDescription>(tap, kAudioTapPropertyDescription, None) else { return false };
    let Some(description) = Retained::from_raw(raw) else { return false };
    description.setProcesses(&numbers(objects));
    let pointer = Retained::as_ptr(&description);
    let status = AudioObjectSetPropertyData(
        tap,
        NonNull::from(&address(kAudioTapPropertyDescription)),
        0,
        std::ptr::null(),
        std::mem::size_of_val(&pointer) as u32,
        NonNull::from(&pointer).cast(),
    );
    status == 0
}

fn key(k: &CStr) -> Retained<NSString> {
    NSString::from_str(&k.to_string_lossy())
}

fn dict(entries: Vec<(&CStr, Retained<AnyObject>)>) -> Retained<NSDictionary<NSString, AnyObject>> {
    let keys: Vec<Retained<NSString>> = entries.iter().map(|(k, _)| key(k)).collect();
    let key_refs: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
    let values: Vec<Retained<AnyObject>> = entries.into_iter().map(|(_, v)| v).collect();
    NSDictionary::from_retained_objects(&key_refs, &values)
}

fn any<T: objc2::Message>(o: Retained<T>) -> Retained<AnyObject> {
    // SAFETY: every Objective-C object is an AnyObject.
    unsafe { Retained::cast_unchecked(o) }
}

fn permission() -> Problem {
    Problem {
        message: "Saga needs permission to record other apps' sound. Turn Saga on under System Audio Recording, then try again.".into(),
        settings: Some("systemAudio"),
    }
}

/// Opens a tap of one app and its helpers (`Some(pid)`), or of everything except Saga (`None`).
pub fn open(target: Option<u32>, name: &str, sink: Sink, lost: Arc<Lost>) -> Result<Opened, Problem> {
    let own = std::process::id() as i32;
    // SAFETY: Core Audio objects are created here and owned by the returned `Tap`, which releases them.
    unsafe {
        // Everything except Saga leaves out its web view's helpers too.
        let mut objects = objects_of(target.map_or(own, |pid| pid as i32));
        if target.is_none() {
            let saga = get::<AudioObjectID>(SYSTEM, kAudioHardwarePropertyTranslatePIDToProcessObject, Some(&own.to_ne_bytes())).filter(|&o| o != 0);
            objects.extend(saga.filter(|o| !objects.contains(o)));
        }
        if target.is_some() && objects.is_empty() {
            return Err(Problem::msg(format!("{name} hasn't played any sound yet. Play something in it, then try again.")));
        }
        let list = numbers(&objects);
        let description = match target {
            Some(_) => CATapDescription::initStereoMixdownOfProcesses(CATapDescription::alloc(), &list),
            None => CATapDescription::initStereoGlobalTapButExcludeProcesses(CATapDescription::alloc(), &list),
        };
        description.setPrivate(true);
        description.setMuteBehavior(CATapMuteBehavior::Unmuted);
        description.setName(&NSString::from_str("Saga"));

        let mut state = Tap { tap: 0, device: 0, proc_id: None, io: std::ptr::null_mut(), stop: None, watcher: None };
        if AudioHardwareCreateProcessTap(Some(&description), &mut state.tap) != 0 || state.tap == 0 {
            return Err(permission());
        }
        let format: AudioStreamBasicDescription = get(state.tap, kAudioTapPropertyFormat, None).ok_or_else(permission)?;
        if format.mFormatFlags & kAudioFormatFlagIsFloat == 0 || format.mBitsPerChannel != 32 {
            return Err(Problem::msg("The system sends sound in a format Saga can't record."));
        }
        let output: AudioObjectID = get(SYSTEM, kAudioHardwarePropertyDefaultSystemOutputDevice, None).ok_or_else(|| Problem::msg("No audio output found."))?;
        let output_uid = get_string(output, kAudioDevicePropertyDeviceUID).ok_or_else(|| Problem::msg("No audio output found."))?;
        let tap_uid = description.UUID().UUIDString();
        let sub_device = dict(vec![(kAudioSubDeviceUIDKey, any(output_uid.clone()))]);
        let sub_tap = dict(vec![(kAudioSubTapUIDKey, any(tap_uid)), (kAudioSubTapDriftCompensationKey, any(NSNumber::new_bool(true)))]);
        let aggregate = dict(vec![
            (kAudioAggregateDeviceNameKey, any(NSString::from_str("Saga take"))),
            (kAudioAggregateDeviceUIDKey, any(NSUUID::new().UUIDString())),
            (kAudioAggregateDeviceMainSubDeviceKey, any(output_uid)),
            (kAudioAggregateDeviceIsPrivateKey, any(NSNumber::new_bool(true))),
            (kAudioAggregateDeviceIsStackedKey, any(NSNumber::new_bool(false))),
            (kAudioAggregateDeviceTapAutoStartKey, any(NSNumber::new_bool(true))),
            (kAudioAggregateDeviceSubDeviceListKey, any(NSArray::from_retained_slice(&[sub_device]))),
            (kAudioAggregateDeviceTapListKey, any(NSArray::from_retained_slice(&[sub_tap]))),
        ]);
        // NSDictionary and CFDictionary are the same object (toll-free bridged).
        let cf = &*(Retained::as_ptr(&aggregate) as *const CFDictionary);
        if AudioHardwareCreateAggregateDevice(cf, NonNull::from(&mut state.device)) != 0 || state.device == 0 {
            return Err(permission());
        }
        let interleaved = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0;
        let tap_buffers = if interleaved { 1 } else { format.mChannelsPerFrame.max(1) as usize };
        state.io = Box::into_raw(Box::new(Io { sink, interleaved, tap_buffers }));
        if AudioDeviceCreateIOProcID(state.device, Some(io_proc), state.io as *mut c_void, NonNull::from(&mut state.proc_id)) != 0 {
            return Err(Problem::msg(format!("Couldn't record {name}.")));
        }
        if AudioDeviceStart(state.device, state.proc_id) != 0 {
            return Err(permission());
        }
        // Core Audio says nothing when the app quits, and a tap only hears the processes it was made
        // with, while a browser starts its audio process when it first plays and may start it again
        // later. So look twice a second, and add the app's new processes to the tap as they come.
        if let Some(pid) = target {
            let (stop, stopped) = bounded::<()>(0);
            let (tap, mut known) = (state.tap, objects);
            state.stop = Some(stop);
            state.watcher = std::thread::Builder::new()
                .name("saga-tap-watch".into())
                .spawn(move || {
                    while let Err(RecvTimeoutError::Timeout) = stopped.recv_timeout(Duration::from_millis(500)) {
                        if running_app(pid as i32).is_none() {
                            lost.set("stopped");
                            break;
                        }
                        let now = objects_of(pid as i32);
                        if now.iter().any(|o| !known.contains(o)) && retarget(tap, &now) {
                            known = now;
                        }
                    }
                })
                .ok();
        }
        Ok(Opened { rate: format.mSampleRate.round() as u32, channels: 2, name: name.to_string(), _open: Box::new(state) })
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    /// Lists this machine's apps; only meaningful by hand: `cargo test --lib lists_apps -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn lists_apps() {
        for a in apps() {
            println!("{} {} playing={} icon={}", a.pid, a.name, a.playing, a.icon.is_some());
        }
    }
}
