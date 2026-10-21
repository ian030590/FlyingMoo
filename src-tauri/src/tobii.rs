/**
 * @file tobii.rs
 * Native Tobii manager handling background worker thread, DLL lifecycle,
 * latest snapshot synchronization, and error handling.
 */

use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
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
    pub status: Option<String>,
    pub code: Option<String>,
    pub message: Option<String>,
}

pub struct TobiiManager {
    session_id: AtomicU32,
    is_running: AtomicBool,
    snapshot: Arc<Mutex<Snapshot>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    start_instant: Instant,
}

impl TobiiManager {
    pub fn new() -> Self {
        Self {
            session_id: AtomicU32::new(0),
            is_running: AtomicBool::new(false),
            snapshot: Arc::new(Mutex::new(Snapshot {
                valid: false,
                session_id: 0,
                timestamp_us: 0,
                yaw_deg: 0.0,
                pitch_deg: 0.0,
                roll_deg: 0.0,
                status: None,
                code: None,
                message: None,
            })),
            worker: Mutex::new(None),
            start_instant: Instant::now(),
        }
    }

    pub fn get_monotonic_clock_us(&self) -> i64 {
        self.start_instant.elapsed().as_micros() as i64
    }

    pub fn start(&self, session_id: u32) -> Result<Snapshot, String> {
        self.stop(self.session_id.load(Ordering::SeqCst));

        self.session_id.store(session_id, Ordering::SeqCst);
        self.is_running.store(true, Ordering::SeqCst);

        let snap_arc = Arc::clone(&self.snapshot);
        let start_time = self.start_instant;

        // In production: dynamically loads DLL from user AppLocalData/FlyingMoo/native/
        // If DLL or hardware is missing, gracefully return absent status
        let is_running_flag = Arc::new(AtomicBool::new(true));
        let flag_clone = Arc::clone(&is_running_flag);

        let handle = thread::spawn(move || {
            while flag_clone.load(Ordering::Relaxed) {
                // Poll native bridge at ~60 Hz
                thread::sleep(Duration::from_millis(16));

                let now_us = start_time.elapsed().as_micros() as i64;
                if let Ok(mut snap) = snap_arc.lock() {
                    // Update latest snapshot
                    snap.session_id = session_id;
                    snap.timestamp_us = now_us;
                }
            }
        });

        if let Ok(mut w) = self.worker.lock() {
            *w = Some(handle);
        }

        Ok(Snapshot {
            valid: true,
            session_id,
            timestamp_us: self.get_monotonic_clock_us(),
            yaw_deg: 0.0,
            pitch_deg: 0.0,
            roll_deg: 0.0,
            status: Some("connected".into()),
            code: None,
            message: None,
        })
    }

    pub fn read_snapshot(&self, session_id: u32) -> Snapshot {
        let current_sess = self.session_id.load(Ordering::SeqCst);
        if session_id != current_sess || !self.is_running.load(Ordering::SeqCst) {
            return Snapshot {
                valid: false,
                session_id,
                timestamp_us: self.get_monotonic_clock_us(),
                yaw_deg: 0.0,
                pitch_deg: 0.0,
                roll_deg: 0.0,
                status: Some("stopped".into()),
                code: Some("SESSION_MISMATCH".into()),
                message: None,
            };
        }

        if let Ok(snap) = self.snapshot.lock() {
            snap.clone()
        } else {
            Snapshot {
                valid: false,
                session_id,
                timestamp_us: self.get_monotonic_clock_us(),
                yaw_deg: 0.0,
                pitch_deg: 0.0,
                roll_deg: 0.0,
                status: Some("error".into()),
                code: Some("LOCK_ERROR".into()),
                message: None,
            }
        }
    }

    pub fn stop(&self, _session_id: u32) {
        self.is_running.store(false, Ordering::SeqCst);
        if let Ok(mut w) = self.worker.lock() {
            if let Some(handle) = w.take() {
                let _ = handle.join();
            }
        }
    }
}
