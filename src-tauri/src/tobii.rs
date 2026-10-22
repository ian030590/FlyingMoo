use libloading::Library;
use serde::{Deserialize, Serialize};
use std::{
    ffi::{c_char, c_void, CStr, CString},
    path::PathBuf,
    ptr,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

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

struct Worker {
    session_id: u32,
    stopped: Arc<AtomicBool>,
    snapshot: Arc<Mutex<Snapshot>>,
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
        let snapshot = Arc::new(Mutex::new(initial.clone()));
        let stopped = Arc::new(AtomicBool::new(false));
        let thread_snapshot = Arc::clone(&snapshot);
        let thread_stopped = Arc::clone(&stopped);
        let origin = self.start_instant;
        let handle = thread::Builder::new().name("tobii-head-pose".into()).spawn(move || {
            if let Err((code, message)) = run_stream(origin, session_id, &thread_snapshot, &thread_stopped) {
                if let Ok(mut latest) = thread_snapshot.lock() {
                    *latest = Snapshot::status(session_id, "error", Some(code), Some(message));
                }
            }
        }).map_err(|e| e.to_string())?;
        *worker = Some(Worker { session_id, stopped, snapshot, handle });
        Ok(initial)
    }

    pub fn read_snapshot(&self, session_id: u32) -> Snapshot {
        if let Ok(worker) = self.worker.lock() {
            if let Some(worker) = worker.as_ref().filter(|w| w.session_id == session_id) {
                if let Ok(latest) = worker.snapshot.lock() {
                    let mut snapshot = latest.clone();
                    snapshot.expire(self.get_monotonic_clock_us());
                    return snapshot;
                }
            }
        }
        Snapshot::status(session_id, "stopped", Some("TOBII_SESSION_STOPPED"), None)
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

// ABI checked against the installed official Stream Engine 4.25.0.3 .NET wrapper.
#[repr(C)]
struct NativePose {
    timestamp_us: i64,
    position_validity: i32,
    position_xyz: [f32; 3],
    rotation_validity_xyz: [i32; 3],
    rotation_xyz: [f32; 3],
}

struct Sdk {
    api_create: unsafe extern "C" fn(*mut Handle, Handle, Handle) -> i32,
    api_destroy: unsafe extern "C" fn(Handle) -> i32,
    enumerate: unsafe extern "C" fn(Handle, UrlCallback, Handle) -> i32,
    device_create: unsafe extern "C" fn(Handle, *const c_char, i32, *mut Handle) -> i32,
    device_destroy: unsafe extern "C" fn(Handle) -> i32,
    supported: unsafe extern "C" fn(Handle, i32, *mut i32) -> i32,
    subscribe: unsafe extern "C" fn(Handle, PoseCallback, Handle) -> i32,
    unsubscribe: unsafe extern "C" fn(Handle) -> i32,
    process: unsafe extern "C" fn(Handle) -> i32,
    clock: unsafe extern "C" fn(Handle, *mut i64) -> i32,
    timesync: unsafe extern "C" fn(Handle) -> i32,
    error_message: unsafe extern "C" fn(i32) -> *const c_char,
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
        Ok(Self {
            api_create: symbol!("tobii_api_create"), api_destroy: symbol!("tobii_api_destroy"),
            enumerate: symbol!("tobii_enumerate_local_device_urls"), device_create: symbol!("tobii_device_create"),
            device_destroy: symbol!("tobii_device_destroy"), supported: symbol!("tobii_stream_supported"),
            subscribe: symbol!("tobii_head_pose_subscribe"), unsubscribe: symbol!("tobii_head_pose_unsubscribe"),
            process: symbol!("tobii_device_process_callbacks"), clock: symbol!("tobii_system_clock"),
            timesync: symbol!("tobii_update_timesync"), error_message: symbol!("tobii_error_message"), _library: library,
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
}

struct Connection {
    sdk: Sdk,
    api: Handle,
    device: Handle,
    subscribed: bool,
}

impl Drop for Connection {
    fn drop(&mut self) {
        unsafe {
            if self.subscribed { (self.sdk.unsubscribe)(self.device); }
            if !self.device.is_null() { (self.sdk.device_destroy)(self.device); }
            if !self.api.is_null() { (self.sdk.api_destroy)(self.api); }
        }
    }
}

struct CallbackContext {
    snapshot: Arc<Mutex<Snapshot>>,
    session_id: u32,
    clock_offset_us: i64,
    last_timestamp_us: i64,
}

impl CallbackContext {
    fn receive(&mut self, pose: &NativePose) {
        if pose.timestamp_us <= 0 || pose.timestamp_us <= self.last_timestamp_us { return; }
        let Some(timestamp_us) = pose.timestamp_us.checked_add(self.clock_offset_us) else { return; };
        self.last_timestamp_us = pose.timestamp_us;
        let valid = pose.rotation_validity_xyz.iter().all(|v| *v == 1)
            && pose.rotation_xyz.iter().all(|v| v.is_finite() && v.to_degrees().is_finite());
        let position_valid = pose.position_validity == 1 && pose.position_xyz.iter().all(|v| v.is_finite());
        if let Ok(mut latest) = self.snapshot.lock() {
            *latest = Snapshot {
                valid, session_id: self.session_id, timestamp_us,
                // Stream Engine radians: X=pitch, Y=yaw (positive left), Z=roll.
                yaw_deg: if valid { -pose.rotation_xyz[1].to_degrees() } else { 0.0 },
                pitch_deg: if valid { pose.rotation_xyz[0].to_degrees() } else { 0.0 },
                roll_deg: if valid { pose.rotation_xyz[2].to_degrees() } else { 0.0 },
                head_x: position_valid.then_some(pose.position_xyz[0]),
                head_y: position_valid.then_some(pose.position_xyz[1]),
                head_z: position_valid.then_some(pose.position_xyz[2]),
                status: (!valid).then(|| "tracking-lost".into()),
                code: (!valid).then(|| "TOBII_INVALID_POSE".into()), message: None,
            };
        }
    }
}

unsafe extern "C" fn receive_pose(pose: *const NativePose, context: Handle) {
    if let (Some(pose), Some(context)) = (pose.as_ref(), (context as *mut CallbackContext).as_mut()) {
        context.receive(pose);
    }
}

unsafe extern "C" fn receive_url(url: *const c_char, context: Handle) {
    if !url.is_null() {
        if let Some(urls) = (context as *mut Vec<CString>).as_mut() { urls.push(CStr::from_ptr(url).to_owned()); }
    }
}

fn run_stream(origin: Instant, session_id: u32, snapshot: &Arc<Mutex<Snapshot>>, stopped: &AtomicBool) -> NativeResult<()> {
    // Declared before the connection so callbacks remain alive through unsubscribe/destruction.
    let mut context = Box::new(CallbackContext { snapshot: Arc::clone(snapshot), session_id,
        clock_offset_us: 0, last_timestamp_us: -1 });
    unsafe {
        let mut connection = Connection { sdk: Sdk::load()?, api: ptr::null_mut(), device: ptr::null_mut(), subscribed: false };
        let sdk = &connection.sdk;
        sdk.check((sdk.api_create)(&mut connection.api, ptr::null_mut(), ptr::null_mut()), "api_create")?;
        let mut urls = Vec::<CString>::new();
        sdk.check((sdk.enumerate)(connection.api, receive_url, &mut urls as *mut _ as Handle), "enumerate")?;
        let url = urls.first().ok_or(("TOBII_DEVICE_ABSENT", "找不到 Eye Tracker 5，請確認 USB 連接與 Tobii 服務。".into()))?;
        // Official field-of-use value 1: do not store or transfer tracking data.
        sdk.check((sdk.device_create)(connection.api, url.as_ptr(), 1, &mut connection.device), "device_create")?;
        let mut supported = 0;
        sdk.check((sdk.supported)(connection.device, 4, &mut supported), "head_pose_supported")?;
        if supported == 0 { return Err(("HEAD_POSE_UNAVAILABLE", "此裝置未提供頭部姿態串流。".into())); }
        sdk.check((sdk.timesync)(connection.device), "timesync")?;
        let before = origin.elapsed().as_micros() as i64;
        let mut sdk_clock = 0;
        sdk.check((sdk.clock)(connection.api, &mut sdk_clock), "system_clock")?;
        let after = origin.elapsed().as_micros() as i64;
        context.clock_offset_us = before + (after - before) / 2 - sdk_clock;
        sdk.check((sdk.subscribe)(connection.device, receive_pose, &mut *context as *mut _ as Handle), "head_pose_subscribe")?;
        connection.subscribed = true;
        if let Ok(mut latest) = snapshot.lock() { *latest = Snapshot::status(session_id, "connected", None, None); }
        let mut synced_at = Instant::now();
        while !stopped.load(Ordering::Acquire) {
            sdk.check((sdk.process)(connection.device), "process_callbacks")?;
            if synced_at.elapsed() >= Duration::from_secs(5) {
                sdk.check((sdk.timesync)(connection.device), "timesync")?;
                synced_at = Instant::now();
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (CallbackContext, NativePose) {
        let context = CallbackContext { snapshot: Arc::new(Mutex::new(Snapshot::status(7, "starting", None, None))),
            session_id: 7, clock_offset_us: -9_000_000, last_timestamp_us: -1 };
        let pose = NativePose { timestamp_us: 10_000_000, position_validity: 1, position_xyz: [1.0, 2.0, 600.0],
            rotation_validity_xyz: [1; 3], rotation_xyz: [10_f32.to_radians(), -20_f32.to_radians(), 5_f32.to_radians()] };
        (context, pose)
    }

    #[test]
    fn pose_abi_axes_clock_and_expiration() {
        assert_eq!(std::mem::size_of::<NativePose>(), 48);
        let (mut context, mut pose) = fixture();
        context.receive(&pose);
        let mut snapshot = context.snapshot.lock().unwrap().clone();
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
        assert!((context.snapshot.lock().unwrap().yaw_deg - 20.0).abs() < 0.001);
    }

    #[test]
    fn invalid_rotation_is_not_a_centered_pose_and_position_is_independent() {
        let (mut context, mut pose) = fixture();
        pose.rotation_validity_xyz[1] = 0;
        context.receive(&pose);
        assert!(!context.snapshot.lock().unwrap().valid);
        pose.timestamp_us += 1;
        pose.rotation_validity_xyz = [1; 3];
        pose.rotation_xyz[0] = f32::NAN;
        context.receive(&pose);
        assert!(!context.snapshot.lock().unwrap().valid);
        pose.timestamp_us += 1;
        pose.rotation_xyz[0] = 0.0;
        pose.position_xyz[0] = f32::INFINITY;
        context.receive(&pose);
        let snapshot = context.snapshot.lock().unwrap();
        assert!(snapshot.valid);
        assert_eq!(snapshot.head_x, None);
        assert!(serde_json::to_string(&*snapshot).is_ok());
    }

    #[test]
    fn stopped_or_unknown_session_never_returns_valid_pose() {
        let manager = TobiiManager::new();
        assert!(manager.start(0).is_err());
        manager.stop(99);
        assert!(!manager.read_snapshot(99).valid);
        assert_eq!(manager.read_snapshot(99).status.as_deref(), Some("stopped"));
    }
}
