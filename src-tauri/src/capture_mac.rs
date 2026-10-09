//! macOS: records one app, or everything you hear except Saga, through Core Audio process taps
//! (macOS 14.2 and later), and lists the apps that are playing with their names and icons. The
//! first tap asks for the "System Audio Recording" permission (`NSAudioCaptureUsageDescription`).

use crate::capture::{AppSource, Lost, Opened, Problem, Sink};
use base64::Engine as _;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AllocAnyThread;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSRunningApplication};
use objc2_core_audio::{
    kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceIsStackedKey, kAudioAggregateDeviceMainSubDeviceKey, kAudioAggregateDeviceNameKey,
    kAudioAggregateDeviceSubDeviceListKey, kAudioAggregateDeviceTapAutoStartKey, kAudioAggregateDeviceTapListKey, kAudioAggregateDeviceUIDKey,
    kAudioDevicePropertyDeviceUID, kAudioHardwarePropertyDefaultSystemOutputDevice, kAudioHardwarePropertyProcessObjectList,
    kAudioHardwarePropertyTranslatePIDToProcessObject, kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    kAudioProcessPropertyIsRunningOutput, kAudioProcessPropertyPID, kAudioSubDeviceUIDKey, kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey,
    kAudioTapPropertyFormat, AudioDeviceCreateIOProcID, AudioDeviceDestroyIOProcID, AudioDeviceIOProcID, AudioDeviceStart, AudioDeviceStop,
    AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap, AudioHardwareDestroyAggregateDevice, AudioHardwareDestroyProcessTap,
    AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectID, AudioObjectPropertyAddress, CATapDescription, CATapMuteBehavior,
};
use objc2_core_audio_types::{kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved, AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp};
use objc2_core_foundation::CFDictionary;
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSOperatingSystemVersion, NSProcessInfo, NSString, NSUUID};
use std::collections::HashMap;
use std::ffi::{c_void, CStr};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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

/// Every process Core Audio knows, with its pid and whether it's making sound.
unsafe fn processes() -> Vec<(AudioObjectID, i32, bool)> {
    get_list(SYSTEM, kAudioHardwarePropertyProcessObjectList)
        .into_iter()
        .filter_map(|object| {
            let pid: i32 = get(object, kAudioProcessPropertyPID, None)?;
            let playing = get::<u32>(object, kAudioProcessPropertyIsRunningOutput, None).unwrap_or(0) != 0;
            Some((object, pid, playing))
        })
        .collect()
}

/// The app a process belongs to: itself, or for a helper ("com.google.Chrome.helper.renderer"),
/// the running app whose bundle identifier it extends.
fn owning_app(pid: i32) -> Option<Retained<NSRunningApplication>> {
    let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
    let Some(id) = app.bundleIdentifier().map(|s| s.to_string()) else { return Some(app) };
    let parts: Vec<&str> = id.split('.').collect();
    for n in (2..parts.len()).rev() {
        let prefix = NSString::from_str(&parts[..n].join("."));
        if let Some(owner) = NSRunningApplication::runningApplicationsWithBundleIdentifier(&prefix).firstObject() {
            return Some(owner);
        }
    }
    Some(app)
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

/// Apps with sound sessions, the ones making sound first. Helpers count as their app; Saga is left out.
pub fn apps() -> Vec<AppSource> {
    let own = std::process::id() as i32;
    let mut by_app: HashMap<i32, AppSource> = HashMap::new();
    // SAFETY: plain property reads on Core Audio objects.
    for (_, pid, playing) in unsafe { processes() } {
        if pid <= 0 || pid == own {
            continue;
        }
        let Some(app) = owning_app(pid) else { continue };
        let app_pid = app.processIdentifier();
        if app_pid == own {
            continue;
        }
        match by_app.get_mut(&app_pid) {
            Some(a) => a.playing |= playing,
            None => {
                let name = app.localizedName().map(|n| n.to_string()).unwrap_or_else(|| format!("Process {app_pid}"));
                by_app.insert(app_pid, AppSource { pid: app_pid as u32, name, icon: icon_png(&app), playing });
            }
        }
    }
    let mut apps: Vec<AppSource> = by_app.into_values().collect();
    apps.sort_by(|a, b| b.playing.cmp(&a.playing).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    apps
}

/// What the IO callback needs.
struct Io {
    sink: Sink,
    interleaved: bool,
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
    let buffers = std::slice::from_raw_parts(list.mBuffers.as_ptr(), list.mNumberBuffers as usize);
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
    stop: Arc<AtomicBool>,
    watcher: Option<JoinHandle<()>>,
}

impl Drop for Tap {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
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
        if let Some(w) = self.watcher.take() {
            let _ = w.join();
        }
    }
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
        let all = processes();
        let objects: Vec<AudioObjectID> = match target {
            Some(app_pid) => all.iter().filter(|(_, pid, _)| owning_app(*pid).is_some_and(|a| a.processIdentifier() as u32 == app_pid)).map(|(o, ..)| *o).collect(),
            None => get::<AudioObjectID>(SYSTEM, kAudioHardwarePropertyTranslatePIDToProcessObject, Some(&own.to_ne_bytes())).filter(|&o| o != 0).into_iter().collect(),
        };
        if target.is_some() && objects.is_empty() {
            return Err(Problem::msg(format!("{name} hasn't played any sound yet. Play something in it, then try again.")));
        }
        let numbers: Vec<Retained<NSNumber>> = objects.iter().map(|&o| NSNumber::new_u32(o)).collect();
        let list = NSArray::from_retained_slice(&numbers);
        let description = match target {
            Some(_) => CATapDescription::initStereoMixdownOfProcesses(CATapDescription::alloc(), &list),
            None => CATapDescription::initStereoGlobalTapButExcludeProcesses(CATapDescription::alloc(), &list),
        };
        description.setPrivate(true);
        description.setMuteBehavior(CATapMuteBehavior::Unmuted);
        description.setName(&NSString::from_str("Saga"));

        let mut state = Tap { tap: 0, device: 0, proc_id: None, io: std::ptr::null_mut(), stop: Arc::new(AtomicBool::new(false)), watcher: None };
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
        state.io = Box::into_raw(Box::new(Io { sink, interleaved }));
        if AudioDeviceCreateIOProcID(state.device, Some(io_proc), state.io as *mut c_void, NonNull::from(&mut state.proc_id)) != 0 {
            return Err(Problem::msg(format!("Couldn't record {name}.")));
        }
        if AudioDeviceStart(state.device, state.proc_id) != 0 {
            return Err(permission());
        }
        // Core Audio says nothing when the app quits; look every second.
        if let Some(pid) = target {
            let stop = state.stop.clone();
            state.watcher = std::thread::Builder::new()
                .name("saga-tap-watch".into())
                .spawn(move || {
                    while !stop.load(Ordering::Acquire) {
                        std::thread::sleep(Duration::from_millis(500));
                        if NSRunningApplication::runningApplicationWithProcessIdentifier(pid as i32).is_none_or(|a| a.isTerminated()) {
                            lost.set("stopped");
                            break;
                        }
                    }
                })
                .ok();
        }
        Ok(Opened { rate: format.mSampleRate.round() as u32, channels: 2, name: name.to_string(), _open: Box::new(state) })
    }
}
