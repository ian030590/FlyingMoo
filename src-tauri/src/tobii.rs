use libloading::Library;
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    ffi::{c_char, c_void, CStr, CString},
    path::PathBuf,
    ptr,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

/// About five minutes of head and gaze samples at the ET5 output rate (33 Hz each).
const SAMPLE_QUEUE_CAPACITY: usize = 20_000;
/// Stream Engine `TOBII_FIELD_OF_USE_STORE_OR_TRANSFER_TRUE`: samples are written to disk.
const FIELD_OF_USE_STORE_OR_TRANSFER: i32 = 2;
const STREAM_GAZE_POINT: i32 = 0;
const STREAM_GAZE_ORIGIN: i32 = 1;
/// Parts of one gaze frame; each arrives through its own callback, possibly in a later process pass.
const GAZE_POINT_PART: u8 = 1;
const GAZE_ORIGIN_PART: u8 = 2;
/// A gaze frame still missing a part is written anyway after this wait.
const GAZE_FRAME_WAIT: Duration = Duration::from_millis(100);
const STREAM_HEAD_POSE: i32 = 4;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub valid: bool,
    pub session_id: u32,
    pub timestamp_us: i64,
    pub yaw_deg: f32,
    pub pitch_deg: f32,
    pub roll_deg: f32,
    pub head_x: Option<f32>,
    pub head_y: Option<f32>,
    pub head_z: Option<f32>,
    pub status: Option<String>,
    pub code: Option<String>,
    pub message: Option<String>,
}

impl Snapshot {
    fn status(session_id: u32, status: &str, code: Option<&str>, message: Option<String>) -> Self {
        Self { valid: false, session_id, timestamp_us: 0, yaw_deg: 0.0, pitch_deg: 0.0,
            roll_deg: 0.0, head_x: None, head_y: None, head_z: None,
            status: Some(status.into()), code: code.map(str::to_owned), message }
    }

    fn expire(&mut self, now_us: i64) {
        if self.valid && !(0..=250_000).contains(&(now_us - self.timestamp_us)) {
            self.valid = false;
            self.status = Some("tracking-lost".into());
            self.code = Some("TOBII_STALE_SAMPLE".into());
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SampleKind { Head, Gaze }

/// One Stream Engine sample kept for recording. Gaze rows merge the gaze point and
/// both eye origins that share a device timestamp; head rows come from the head pose stream.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TobiiSample {
    pub kind: SampleKind,
    pub device_timestamp_us: i64,
    pub timestamp_us: i64,
    pub valid: bool,
    pub yaw_deg: Option<f32>,
    pub pitch_deg: Option<f32>,
    pub roll_deg: Option<f32>,
    pub head_x: Option<f32>,
    pub head_y: Option<f32>,
    pub head_z: Option<f32>,
    pub gaze_x: Option<f32>,
    pub gaze_y: Option<f32>,
    pub left_eye_mm: Option<[f32; 3]>,
    pub right_eye_mm: Option<[f32; 3]>,
}

impl TobiiSample {
    fn empty(kind: SampleKind, device_timestamp_us: i64, timestamp_us: i64) -> Self {
        Self { kind, device_timestamp_us, timestamp_us, valid: false, yaw_deg: None, pitch_deg: None,
            roll_deg: None, head_x: None, head_y: None, head_z: None, gaze_x: None, gaze_y: None,
            left_eye_mm: None, right_eye_mm: None }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayArea {
    pub top_left_mm: [f32; 3],
    pub top_right_mm: [f32; 3],
    pub bottom_left_mm: [f32; 3],
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceMeta {
    pub model: String,
    pub generation: String,
    pub firmware_version: String,
    pub serial_number: String,
    pub output_frequency_hz: Option<f32>,
    pub display_area: Option<DisplayArea>,
    pub gaze_point: bool,
    pub gaze_origin: bool,
    pub field_of_use: &'static str,
}

/// Latest head pose for control, plus every queued sample since the previous read.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TobiiRead {
    #[serde(flatten)]
    pub snapshot: Snapshot,
    pub samples: Vec<TobiiSample>,
    pub dropped_samples: u64,
}

struct Shared {
    latest: Snapshot,
    samples: VecDeque<TobiiSample>,
    dropped: u64,
    device: Option<DeviceMeta>,
}

impl Shared {
    fn new(latest: Snapshot) -> Self {
        Self { latest, samples: VecDeque::new(), dropped: 0, device: None }
    }

    fn push(&mut self, sample: TobiiSample) {
        if self.samples.len() >= SAMPLE_QUEUE_CAPACITY {
            self.samples.pop_front();
            self.dropped += 1;
        }
        self.samples.push_back(sample);
    }
}

struct Worker {
    session_id: u32,
    stopped: Arc<AtomicBool>,
    shared: Arc<Mutex<Shared>>,
    handle: JoinHandle<()>,
}

impl Worker {
    fn stop(self) {
        self.stopped.store(true, Ordering::Release);
        let _ = self.handle.join();
    }
}

pub struct TobiiManager {
    start_instant: Instant,
    worker: Mutex<Option<Worker>>,
}

impl TobiiManager {
    pub fn new() -> Self {
        Self { start_instant: Instant::now(), worker: Mutex::new(None) }
    }

    pub fn get_monotonic_clock_us(&self) -> i64 {
        self.start_instant.elapsed().as_micros() as i64
    }

    pub fn start(&self, session_id: u32) -> Result<Snapshot, String> {
        if session_id == 0 { return Err("Invalid Tobii session".into()); }
        let mut worker = self.worker.lock().map_err(|e| e.to_string())?;
        if let Some(previous) = worker.take() { previous.stop(); }
        let initial = Snapshot::status(session_id, "starting", None, None);
        let shared = Arc::new(Mutex::new(Shared::new(initial.clone())));
        let stopped = Arc::new(AtomicBool::new(false));
        let thread_shared = Arc::clone(&shared);
        let thread_stopped = Arc::clone(&stopped);
        let origin = self.start_instant;
        let handle = thread::Builder::new().name("tobii-stream".into()).spawn(move || {
            if let Err((code, message)) = run_stream(origin, session_id, &thread_shared, &thread_stopped) {
                if let Ok(mut state) = thread_shared.lock() {
                    state.latest = Snapshot::status(session_id, "error", Some(code), Some(message));
                }
            }
        }).map_err(|e| e.to_string())?;
        *worker = Some(Worker { session_id, stopped, shared, handle });
        Ok(initial)
    }

    /// Returns the latest pose and drains the queued samples of this session.
    pub fn read(&self, session_id: u32) -> TobiiRead {
        if let Ok(worker) = self.worker.lock() {
            if let Some(worker) = worker.as_ref().filter(|w| w.session_id == session_id) {
                if let Ok(mut state) = worker.shared.lock() {
                    let mut snapshot = state.latest.clone();
                    snapshot.expire(self.get_monotonic_clock_us());
                    let samples = state.samples.drain(..).collect();
                    return TobiiRead { snapshot, samples, dropped_samples: state.dropped };
                }
            }
        }
        TobiiRead { snapshot: Snapshot::status(session_id, "stopped", Some("TOBII_SESSION_STOPPED"), None),
            samples: Vec::new(), dropped_samples: 0 }
    }

    pub fn device(&self, session_id: u32) -> Option<DeviceMeta> {
        let worker = self.worker.lock().ok()?;
        let worker = worker.as_ref().filter(|w| w.session_id == session_id)?;
        let state = worker.shared.lock().ok()?;
        state.device.clone()
    }

    pub fn stop(&self, session_id: u32) {
        if let Ok(mut worker) = self.worker.lock() {
            if worker.as_ref().is_some_and(|w| session_id == 0 || w.session_id == session_id) {
                if let Some(worker) = worker.take() { worker.stop(); }
            }
        }
    }
}

impl Drop for TobiiManager {
    fn drop(&mut self) { self.stop(0); }
}

type Handle = *mut c_void;
type NativeResult<T> = Result<T, (&'static str, String)>;
type UrlCallback = unsafe extern "C" fn(*const c_char, Handle);
type PoseCallback = unsafe extern "C" fn(*const NativePose, Handle);
type GazePointCallback = unsafe extern "C" fn(*const NativeGazePoint, Handle);
type GazeOriginCallback = unsafe extern "C" fn(*const NativeGazeOrigin, Handle);
type Unsubscribe = unsafe extern "C" fn(Handle) -> i32;

// ABI checked against the installed official Stream Engine 4.25.0.3 .NET wrapper.
#[repr(C)]
struct NativePose {
    timestamp_us: i64,
    position_validity: i32,
    position_xyz: [f32; 3],
    rotation_validity_xyz: [i32; 3],
    rotation_xyz: [f32; 3],
}

/// Normalized display coordinates: (0, 0) top-left, (1, 1) bottom-right of the configured display.
#[repr(C)]
struct NativeGazePoint {
    timestamp_us: i64,
    validity: i32,
    position_xy: [f32; 2],
}

/// Eye positions in mm, tracker coordinate system.
#[repr(C)]
struct NativeGazeOrigin {
    timestamp_us: i64,
    left_validity: i32,
    left_xyz: [f32; 3],
    right_validity: i32,
    right_xyz: [f32; 3],
}

#[repr(C)]
struct NativeDisplayArea {
    top_left_mm_xyz: [f32; 3],
    top_right_mm_xyz: [f32; 3],
    bottom_left_mm_xyz: [f32; 3],
}

#[repr(C)]
struct NativeDeviceInfo {
    serial_number: [c_char; 256],
    model: [c_char; 256],
    generation: [c_char; 256],
    firmware_version: [c_char; 256],
    integration_id: [c_char; 128],
    hw_calibration_version: [c_char; 128],
    hw_calibration_date: [c_char; 128],
    lot_id: [c_char; 128],
    integration_type: [c_char; 256],
    runtime_build_version: [c_char; 256],
}

fn text(field: &[c_char]) -> String {
    let bytes: Vec<u8> = field.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
    String::from_utf8_lossy(&bytes).trim().to_owned()
}

struct Sdk {
    api_create: unsafe extern "C" fn(*mut Handle, Handle, Handle) -> i32,
    api_destroy: unsafe extern "C" fn(Handle) -> i32,
    enumerate: unsafe extern "C" fn(Handle, UrlCallback, Handle) -> i32,
    device_create: unsafe extern "C" fn(Handle, *const c_char, i32, *mut Handle) -> i32,
    device_destroy: unsafe extern "C" fn(Handle) -> i32,
    supported: unsafe extern "C" fn(Handle, i32, *mut i32) -> i32,
    subscribe: unsafe extern "C" fn(Handle, PoseCallback, Handle) -> i32,
    unsubscribe: Unsubscribe,
    process: unsafe extern "C" fn(Handle) -> i32,
    clock: unsafe extern "C" fn(Handle, *mut i64) -> i32,
    timesync: unsafe extern "C" fn(Handle) -> i32,
    error_message: unsafe extern "C" fn(i32) -> *const c_char,
    gaze_point_subscribe: Option<unsafe extern "C" fn(Handle, GazePointCallback, Handle) -> i32>,
    gaze_point_unsubscribe: Option<Unsubscribe>,
    gaze_origin_subscribe: Option<unsafe extern "C" fn(Handle, GazeOriginCallback, Handle) -> i32>,
    gaze_origin_unsubscribe: Option<Unsubscribe>,
    display_area: Option<unsafe extern "C" fn(Handle, *mut NativeDisplayArea) -> i32>,
    device_info: Option<unsafe extern "C" fn(Handle, *mut NativeDeviceInfo) -> i32>,
    output_frequency: Option<unsafe extern "C" fn(Handle, *mut f32) -> i32>,
    _library: Library,
}

impl Sdk {
    unsafe fn load() -> NativeResult<Self> {
        let program_files = std::env::var_os("ProgramW6432").or_else(|| std::env::var_os("ProgramFiles"))
            .ok_or(("TOBII_RUNTIME_UNAVAILABLE", "請先安裝 Tobii Experience 與官方驅動。".into()))?;
        let path = PathBuf::from(program_files).join("Tobii/Tobii EyeX/tobii_stream_engine.dll");
        #[cfg(windows)]
        let library: Library = libloading::os::windows::Library::load_with_flags(&path, 0x1100)
            .map_err(|e| ("TOBII_RUNTIME_UNAVAILABLE", format!("無法載入 Tobii 官方元件：{e}")))?.into();
        #[cfg(not(windows))]
        let library = Library::new(&path)
            .map_err(|e| ("TOBII_RUNTIME_UNAVAILABLE", e.to_string()))?;
        let version: libloading::Symbol<unsafe extern "C" fn(*mut [i32; 4]) -> i32> = library.get(b"tobii_get_api_version\0")
            .map_err(|e| ("TOBII_RUNTIME_UNAVAILABLE", e.to_string()))?;
        let mut api_version = [0; 4];
        if version(&mut api_version) != 0 || api_version[0] != 4 {
            return Err(("TOBII_SDK_UNSUPPORTED", "需要 Tobii Stream Engine 4.x，請更新 Tobii Experience。".into()));
        }
        macro_rules! symbol {
            ($name:literal) => { *library.get(concat!($name, "\0").as_bytes())
                .map_err(|e| ("TOBII_SDK_UNSUPPORTED", e.to_string()))? };
        }
        // Gaze and metadata symbols are optional: head control still works without them.
        macro_rules! optional {
            ($name:literal) => { library.get(concat!($name, "\0").as_bytes()).ok().map(|s| *s) };
        }
        Ok(Self {
            api_create: symbol!("tobii_api_create"), api_destroy: symbol!("tobii_api_destroy"),
            enumerate: symbol!("tobii_enumerate_local_device_urls"), device_create: symbol!("tobii_device_create"),
            device_destroy: symbol!("tobii_device_destroy"), supported: symbol!("tobii_stream_supported"),
            subscribe: symbol!("tobii_head_pose_subscribe"), unsubscribe: symbol!("tobii_head_pose_unsubscribe"),
            process: symbol!("tobii_device_process_callbacks"), clock: symbol!("tobii_system_clock"),
            timesync: symbol!("tobii_update_timesync"), error_message: symbol!("tobii_error_message"),
            gaze_point_subscribe: optional!("tobii_gaze_point_subscribe"),
            gaze_point_unsubscribe: optional!("tobii_gaze_point_unsubscribe"),
            gaze_origin_subscribe: optional!("tobii_gaze_origin_subscribe"),
            gaze_origin_unsubscribe: optional!("tobii_gaze_origin_unsubscribe"),
            display_area: optional!("tobii_get_display_area"), device_info: optional!("tobii_get_device_info"),
            output_frequency: optional!("tobii_get_output_frequency"), _library: library,
        })
    }

    fn check(&self, code: i32, operation: &str) -> NativeResult<()> {
        if code == 0 { return Ok(()); }
        let reason = unsafe { CStr::from_ptr((self.error_message)(code)) }.to_string_lossy();
        let name = match code {
            2 | 19 => "TOBII_ACCESS_DENIED", 3 => "HEAD_POSE_UNAVAILABLE",
            5 | 18 => "TOBII_CONNECTION_FAILED", _ => "TOBII_ERROR",
        };
        Err((name, format!("Tobii {operation}: {reason} ({code})")))
    }

    unsafe fn stream_supported(&self, device: Handle, stream: i32) -> bool {
        let mut supported = 0;
        (self.supported)(device, stream, &mut supported) == 0 && supported != 0
    }

    unsafe fn describe(&self, device: Handle) -> DeviceMeta {
        let mut meta = DeviceMeta { field_of_use: "STORE_OR_TRANSFER_TRUE", ..DeviceMeta::default() };
        if let Some(read) = self.device_info {
            let mut info: Box<NativeDeviceInfo> = Box::new(std::mem::zeroed());
            if read(device, &mut *info) == 0 {
                meta.serial_number = text(&info.serial_number);
                meta.model = text(&info.model);
                meta.generation = text(&info.generation);
                meta.firmware_version = text(&info.firmware_version);
            }
        }
        if let Some(read) = self.display_area {
            let mut area: NativeDisplayArea = std::mem::zeroed();
            let corners = |a: &NativeDisplayArea| [a.top_left_mm_xyz, a.top_right_mm_xyz, a.bottom_left_mm_xyz];
            if read(device, &mut area) == 0 && corners(&area).iter().flatten().all(|v| v.is_finite()) {
                meta.display_area = Some(DisplayArea { top_left_mm: area.top_left_mm_xyz,
                    top_right_mm: area.top_right_mm_xyz, bottom_left_mm: area.bottom_left_mm_xyz });
            }
        }
        if let Some(read) = self.output_frequency {
            let mut hz = 0.0_f32;
            if read(device, &mut hz) == 0 && hz.is_finite() && hz > 0.0 { meta.output_frequency_hz = Some(hz); }
        }
        meta
    }
}

struct Connection {
    sdk: Sdk,
    api: Handle,
    device: Handle,
    unsubscribe: Vec<Unsubscribe>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        unsafe {
            for unsubscribe in self.unsubscribe.drain(..).rev() { unsubscribe(self.device); }
            if !self.device.is_null() { (self.sdk.device_destroy)(self.device); }
            if !self.api.is_null() { (self.sdk.api_destroy)(self.api); }
        }
    }
}

struct CallbackContext {
    shared: Arc<Mutex<Shared>>,
    session_id: u32,
    clock_offset_us: i64,
    last_head_us: i64,
    last_gaze_us: i64,
    last_origin_us: i64,
    /// Parts the subscribed gaze streams deliver for every frame.
    gaze_parts: u8,
    pending_gaze: Option<TobiiSample>,
    pending_parts: u8,
    pending_since: Option<Instant>,
}

impl CallbackContext {
    fn new(shared: Arc<Mutex<Shared>>, session_id: u32) -> Self {
        Self { shared, session_id, clock_offset_us: 0, last_head_us: -1, last_gaze_us: -1,
            last_origin_us: -1, gaze_parts: 0, pending_gaze: None, pending_parts: 0, pending_since: None }
    }

    fn receive(&mut self, pose: &NativePose) {
        if pose.timestamp_us <= 0 || pose.timestamp_us <= self.last_head_us { return; }
        let Some(timestamp_us) = pose.timestamp_us.checked_add(self.clock_offset_us) else { return; };
        self.last_head_us = pose.timestamp_us;
        // Stream Engine radians: X=pitch, Y=yaw (positive left), Z=roll.
        let axis = |index: usize, sign: f32| {
            let radians = pose.rotation_xyz[index];
            (pose.rotation_validity_xyz[index] == 1 && radians.is_finite() && radians.to_degrees().is_finite())
                .then(|| sign * radians.to_degrees())
        };
        let (pitch, yaw, roll) = (axis(0, 1.0), axis(1, -1.0), axis(2, 1.0));
        let valid = pitch.is_some() && yaw.is_some() && roll.is_some();
        let position_valid = pose.position_validity == 1 && pose.position_xyz.iter().all(|v| v.is_finite());
        let position = |index: usize| position_valid.then_some(pose.position_xyz[index]);
        let mut sample = TobiiSample::empty(SampleKind::Head, pose.timestamp_us, timestamp_us);
        sample.valid = valid;
        (sample.yaw_deg, sample.pitch_deg, sample.roll_deg) = (yaw, pitch, roll);
        (sample.head_x, sample.head_y, sample.head_z) = (position(0), position(1), position(2));
        if let Ok(mut state) = self.shared.lock() {
            state.latest = Snapshot {
                valid, session_id: self.session_id, timestamp_us,
                yaw_deg: if valid { yaw.unwrap_or(0.0) } else { 0.0 },
                pitch_deg: if valid { pitch.unwrap_or(0.0) } else { 0.0 },
                roll_deg: if valid { roll.unwrap_or(0.0) } else { 0.0 },
                head_x: sample.head_x, head_y: sample.head_y, head_z: sample.head_z,
                status: (!valid).then(|| "tracking-lost".into()),
                code: (!valid).then(|| "TOBII_INVALID_POSE".into()), message: None,
            };
            state.push(sample);
        }
    }

    /// Gaze point and gaze origin of one frame share a timestamp; both fill the same row.
    fn gaze_slot(&mut self, device_timestamp_us: i64) -> Option<&mut TobiiSample> {
        let timestamp_us = device_timestamp_us.checked_add(self.clock_offset_us)?;
        if self.pending_gaze.as_ref().is_some_and(|s| s.device_timestamp_us != device_timestamp_us) {
            self.flush_gaze();
        }
        if self.pending_gaze.is_none() { self.pending_since = Some(Instant::now()); }
        Some(self.pending_gaze.get_or_insert_with(||
            TobiiSample::empty(SampleKind::Gaze, device_timestamp_us, timestamp_us)))
    }

    /// Writes the frame as soon as every subscribed gaze stream has filled it.
    fn complete_gaze_part(&mut self, part: u8) {
        self.pending_parts |= part;
        if self.gaze_parts != 0 && self.pending_parts & self.gaze_parts == self.gaze_parts { self.flush_gaze(); }
    }

    /// Called after each process pass: a frame whose other part never came is still written.
    fn flush_stale_gaze(&mut self) {
        if self.pending_since.is_some_and(|since| since.elapsed() >= GAZE_FRAME_WAIT) { self.flush_gaze(); }
    }

    fn receive_gaze_point(&mut self, gaze: &NativeGazePoint) {
        if gaze.timestamp_us <= 0 || gaze.timestamp_us <= self.last_gaze_us { return; }
        self.last_gaze_us = gaze.timestamp_us;
        let valid = gaze.validity == 1 && gaze.position_xy.iter().all(|v| v.is_finite());
        if let Some(sample) = self.gaze_slot(gaze.timestamp_us) {
            sample.valid = valid;
            sample.gaze_x = valid.then_some(gaze.position_xy[0]);
            sample.gaze_y = valid.then_some(gaze.position_xy[1]);
            self.complete_gaze_part(GAZE_POINT_PART);
        }
    }

    fn receive_gaze_origin(&mut self, origin: &NativeGazeOrigin) {
        if origin.timestamp_us <= 0 || origin.timestamp_us <= self.last_origin_us { return; }
        self.last_origin_us = origin.timestamp_us;
        let eye = |validity: i32, xyz: [f32; 3]| (validity == 1 && xyz.iter().all(|v| v.is_finite())).then_some(xyz);
        if let Some(sample) = self.gaze_slot(origin.timestamp_us) {
            sample.left_eye_mm = eye(origin.left_validity, origin.left_xyz);
            sample.right_eye_mm = eye(origin.right_validity, origin.right_xyz);
            self.complete_gaze_part(GAZE_ORIGIN_PART);
        }
    }

    fn flush_gaze(&mut self) {
        self.pending_parts = 0;
        self.pending_since = None;
        if let Some(sample) = self.pending_gaze.take() {
            if let Ok(mut state) = self.shared.lock() { state.push(sample); }
        }
    }
}

unsafe extern "C" fn receive_pose(pose: *const NativePose, context: Handle) {
    if let (Some(pose), Some(context)) = (pose.as_ref(), (context as *mut CallbackContext).as_mut()) {
        context.receive(pose);
    }
}

unsafe extern "C" fn receive_gaze_point(gaze: *const NativeGazePoint, context: Handle) {
    if let (Some(gaze), Some(context)) = (gaze.as_ref(), (context as *mut CallbackContext).as_mut()) {
        context.receive_gaze_point(gaze);
    }
}

unsafe extern "C" fn receive_gaze_origin(origin: *const NativeGazeOrigin, context: Handle) {
    if let (Some(origin), Some(context)) = (origin.as_ref(), (context as *mut CallbackContext).as_mut()) {
        context.receive_gaze_origin(origin);
    }
}

unsafe extern "C" fn receive_url(url: *const c_char, context: Handle) {
    if !url.is_null() {
        if let Some(urls) = (context as *mut Vec<CString>).as_mut() { urls.push(CStr::from_ptr(url).to_owned()); }
    }
}

/// Owns the callback context through one raw pointer shared by all subscriptions.
struct ContextGuard(*mut CallbackContext);

impl Drop for ContextGuard {
    fn drop(&mut self) { unsafe { drop(Box::from_raw(self.0)); } }
}

fn run_stream(origin: Instant, session_id: u32, shared: &Arc<Mutex<Shared>>, stopped: &AtomicBool) -> NativeResult<()> {
    // Declared before the connection so callbacks remain alive through unsubscribe/destruction.
    let context = ContextGuard(Box::into_raw(Box::new(CallbackContext::new(Arc::clone(shared), session_id))));
    let user_data = context.0 as Handle;
    unsafe {
        let mut connection = Connection { sdk: Sdk::load()?, api: ptr::null_mut(), device: ptr::null_mut(), unsubscribe: Vec::new() };
        let sdk = &connection.sdk;
        sdk.check((sdk.api_create)(&mut connection.api, ptr::null_mut(), ptr::null_mut()), "api_create")?;
        let mut urls = Vec::<CString>::new();
        sdk.check((sdk.enumerate)(connection.api, receive_url, &mut urls as *mut _ as Handle), "enumerate")?;
        let url = urls.first().ok_or(("TOBII_DEVICE_ABSENT", "找不到 Eye Tracker 5，請確認 USB 連接與 Tobii 服務。".into()))?;
        // Head pose and gaze are written to the session CSV, so the data is declared as stored.
        sdk.check((sdk.device_create)(connection.api, url.as_ptr(), FIELD_OF_USE_STORE_OR_TRANSFER, &mut connection.device), "device_create")?;
        let device = connection.device;
        if !sdk.stream_supported(device, STREAM_HEAD_POSE) {
            return Err(("HEAD_POSE_UNAVAILABLE", "此裝置未提供頭部姿態串流。".into()));
        }
        let mut meta = sdk.describe(device);
        sdk.check((sdk.timesync)(device), "timesync")?;
        let before = origin.elapsed().as_micros() as i64;
        let mut sdk_clock = 0;
        sdk.check((sdk.clock)(connection.api, &mut sdk_clock), "system_clock")?;
        let after = origin.elapsed().as_micros() as i64;
        (*context.0).clock_offset_us = before + (after - before) / 2 - sdk_clock;

        sdk.check((sdk.subscribe)(device, receive_pose, user_data), "head_pose_subscribe")?;
        connection.unsubscribe.push(sdk.unsubscribe);
        if let (Some(subscribe), Some(unsubscribe)) = (sdk.gaze_point_subscribe, sdk.gaze_point_unsubscribe) {
            if sdk.stream_supported(device, STREAM_GAZE_POINT) && subscribe(device, receive_gaze_point, user_data) == 0 {
                connection.unsubscribe.push(unsubscribe);
                meta.gaze_point = true;
            }
        }
        if let (Some(subscribe), Some(unsubscribe)) = (sdk.gaze_origin_subscribe, sdk.gaze_origin_unsubscribe) {
            if sdk.stream_supported(device, STREAM_GAZE_ORIGIN) && subscribe(device, receive_gaze_origin, user_data) == 0 {
                connection.unsubscribe.push(unsubscribe);
                meta.gaze_origin = true;
            }
        }
        // Callbacks only run inside process_callbacks, so this is set before the first gaze part arrives.
        (*context.0).gaze_parts = (if meta.gaze_point { GAZE_POINT_PART } else { 0 })
            | (if meta.gaze_origin { GAZE_ORIGIN_PART } else { 0 });
        if let Ok(mut state) = shared.lock() {
            state.device = Some(meta);
            state.latest = Snapshot::status(session_id, "connected", None, None);
        }
        let mut synced_at = Instant::now();
        while !stopped.load(Ordering::Acquire) {
            let processed = (connection.sdk.process)(device);
            (*context.0).flush_stale_gaze();
            connection.sdk.check(processed, "process_callbacks")?;
            if synced_at.elapsed() >= Duration::from_secs(5) {
                connection.sdk.check((connection.sdk.timesync)(device), "timesync")?;
                synced_at = Instant::now();
            }
            thread::sleep(Duration::from_millis(5));
        }
        (*context.0).flush_gaze();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (CallbackContext, NativePose) {
        let shared = Arc::new(Mutex::new(Shared::new(Snapshot::status(7, "starting", None, None))));
        let mut context = CallbackContext::new(shared, 7);
        context.clock_offset_us = -9_000_000;
        let pose = NativePose { timestamp_us: 10_000_000, position_validity: 1, position_xyz: [1.0, 2.0, 600.0],
            rotation_validity_xyz: [1; 3], rotation_xyz: [10_f32.to_radians(), -20_f32.to_radians(), 5_f32.to_radians()] };
        (context, pose)
    }

    fn latest(context: &CallbackContext) -> Snapshot { context.shared.lock().unwrap().latest.clone() }

    fn queued(context: &CallbackContext) -> Vec<TobiiSample> {
        context.shared.lock().unwrap().samples.iter().cloned().collect()
    }

    #[test]
    fn pose_abi_axes_clock_and_expiration() {
        assert_eq!(std::mem::size_of::<NativePose>(), 48);
        assert_eq!(std::mem::size_of::<NativeGazePoint>(), 24);
        assert_eq!(std::mem::size_of::<NativeGazeOrigin>(), 40);
        assert_eq!(std::mem::size_of::<NativeDisplayArea>(), 36);
        assert_eq!(std::mem::size_of::<NativeDeviceInfo>(), 2048);
        let (mut context, mut pose) = fixture();
        context.receive(&pose);
        let mut snapshot = latest(&context);
        assert!(snapshot.valid);
        assert_eq!(snapshot.timestamp_us, 1_000_000);
        assert!((snapshot.yaw_deg - 20.0).abs() < 0.001);
        assert!((snapshot.pitch_deg - 10.0).abs() < 0.001);
        assert!((snapshot.roll_deg - 5.0).abs() < 0.001);
        assert_eq!(snapshot.head_z, Some(600.0));
        snapshot.expire(1_250_000);
        assert!(snapshot.valid);
        snapshot.expire(1_250_001);
        assert!(!snapshot.valid);
        assert_eq!(snapshot.timestamp_us, 1_000_000);
        pose.rotation_xyz = [0.0; 3];
        context.receive(&pose);
        pose.timestamp_us -= 1;
        context.receive(&pose);
        assert!((latest(&context).yaw_deg - 20.0).abs() < 0.001);
        let samples = queued(&context);
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].kind, SampleKind::Head);
        assert_eq!(samples[0].device_timestamp_us, 10_000_000);
        assert_eq!(samples[0].timestamp_us, 1_000_000);
    }

    #[test]
    fn invalid_rotation_is_not_a_centered_pose_and_position_is_independent() {
        let (mut context, mut pose) = fixture();
        pose.rotation_validity_xyz[1] = 0;
        context.receive(&pose);
        assert!(!latest(&context).valid);
        let partial = queued(&context).pop().unwrap();
        assert!(!partial.valid);
        assert_eq!(partial.yaw_deg, None);
        assert!((partial.pitch_deg.unwrap() - 10.0).abs() < 0.001);
        pose.timestamp_us += 1;
        pose.rotation_validity_xyz = [1; 3];
        pose.rotation_xyz[0] = f32::NAN;
        context.receive(&pose);
        assert!(!latest(&context).valid);
        pose.timestamp_us += 1;
        pose.rotation_xyz[0] = 0.0;
        pose.position_xyz[0] = f32::INFINITY;
        context.receive(&pose);
        let snapshot = latest(&context);
        assert!(snapshot.valid);
        assert_eq!(snapshot.head_x, None);
        assert!(serde_json::to_string(&snapshot).is_ok());
        assert_eq!(queued(&context).len(), 3);
    }

    #[test]
    fn gaze_point_and_eye_origin_of_one_frame_share_a_row() {
        let (mut context, _) = fixture();
        let origin = |timestamp_us| NativeGazeOrigin { timestamp_us, left_validity: 1, left_xyz: [-30.0, 190.0, 600.0],
            right_validity: 0, right_xyz: [f32::NAN; 3] };
        context.receive_gaze_point(&NativeGazePoint { timestamp_us: 10_000_100, validity: 1, position_xy: [0.5, 0.25] });
        context.receive_gaze_origin(&origin(10_000_100));
        context.flush_gaze();
        // Origin first, then an invalid gaze point of a later frame.
        context.receive_gaze_origin(&origin(10_030_100));
        context.receive_gaze_point(&NativeGazePoint { timestamp_us: 10_030_100, validity: 0, position_xy: [0.1, 0.1] });
        // A different frame flushes the pending one even without an explicit flush.
        context.receive_gaze_point(&NativeGazePoint { timestamp_us: 10_060_100, validity: 1, position_xy: [f32::NAN, 0.1] });
        context.flush_gaze();
        let rows = queued(&context);
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|r| r.kind == SampleKind::Gaze));
        assert!(rows[0].valid);
        assert_eq!((rows[0].gaze_x, rows[0].gaze_y), (Some(0.5), Some(0.25)));
        assert_eq!(rows[0].left_eye_mm, Some([-30.0, 190.0, 600.0]));
        assert_eq!(rows[0].right_eye_mm, None);
        assert_eq!(rows[0].timestamp_us, 1_000_100);
        assert!(!rows[1].valid);
        assert_eq!(rows[1].gaze_x, None);
        assert_eq!(rows[1].left_eye_mm, Some([-30.0, 190.0, 600.0]));
        assert!(!rows[2].valid);
        // Repeated or older gaze timestamps are ignored.
        context.receive_gaze_point(&NativeGazePoint { timestamp_us: 10_060_100, validity: 1, position_xy: [0.5, 0.5] });
        context.flush_gaze();
        assert_eq!(queued(&context).len(), 3);
    }

    #[test]
    fn a_gaze_frame_split_across_process_passes_stays_one_row() {
        let (mut context, _) = fixture();
        context.gaze_parts = GAZE_POINT_PART | GAZE_ORIGIN_PART;
        let origin = |timestamp_us| NativeGazeOrigin { timestamp_us, left_validity: 0, left_xyz: [0.0; 3],
            right_validity: 1, right_xyz: [30.0, 190.0, 610.0] };
        context.receive_gaze_point(&NativeGazePoint { timestamp_us: 10_000_100, validity: 0, position_xy: [0.0; 2] });
        // End of one process pass: the frame waits for its origin.
        context.flush_stale_gaze();
        assert!(queued(&context).is_empty());
        context.receive_gaze_origin(&origin(10_000_100));
        let rows = queued(&context);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].right_eye_mm, Some([30.0, 190.0, 610.0]));
        // A frame whose origin never arrives is written after the wait.
        context.receive_gaze_point(&NativeGazePoint { timestamp_us: 10_030_100, validity: 1, position_xy: [0.4, 0.6] });
        context.flush_stale_gaze();
        assert_eq!(queued(&context).len(), 1);
        context.pending_since = Instant::now().checked_sub(GAZE_FRAME_WAIT);
        context.flush_stale_gaze();
        let rows = queued(&context);
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[1].gaze_x, rows[1].left_eye_mm), (Some(0.4), None));
    }

    #[test]
    fn queue_overflow_is_counted_and_reads_drain_once() {
        let mut state = Shared::new(Snapshot::status(7, "connected", None, None));
        for i in 0..(SAMPLE_QUEUE_CAPACITY as i64 + 5) {
            state.push(TobiiSample::empty(SampleKind::Head, i + 1, i + 1));
        }
        assert_eq!(state.samples.len(), SAMPLE_QUEUE_CAPACITY);
        assert_eq!(state.dropped, 5);
        assert_eq!(state.samples.front().unwrap().device_timestamp_us, 6);
        let read = TobiiRead { snapshot: state.latest.clone(), samples: state.samples.drain(..).take(1).collect(), dropped_samples: state.dropped };
        let json = serde_json::to_value(&read).unwrap();
        assert_eq!(json["status"], "connected");
        assert_eq!(json["droppedSamples"], 5);
        assert_eq!(json["samples"][0]["kind"], "head");
        assert_eq!(json["samples"][0]["deviceTimestampUs"], 6);
        assert!(json["samples"][0]["leftEyeMm"].is_null());
        assert!(state.samples.is_empty());
    }

    #[test]
    fn stopped_or_unknown_session_never_returns_valid_pose() {
        let manager = TobiiManager::new();
        assert!(manager.start(0).is_err());
        manager.stop(99);
        let read = manager.read(99);
        assert!(!read.snapshot.valid);
        assert_eq!(read.snapshot.status.as_deref(), Some("stopped"));
        assert!(read.samples.is_empty());
        assert!(manager.device(99).is_none());
    }
}
