use serde::{Deserialize, Serialize};
use std::time::Instant;

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
    start_instant: Instant,
}

impl TobiiManager {
    pub fn new() -> Self {
        Self {
            start_instant: Instant::now(),
        }
    }

    pub fn get_monotonic_clock_us(&self) -> i64 {
        self.start_instant.elapsed().as_micros() as i64
    }

    pub fn start(&self, _session_id: u32) -> Result<Snapshot, String> {
        Err("此版本尚未支援 Tobii Eye Tracker 5，請選擇鍵盤或攝影機。".into())
    }

    pub fn read_snapshot(&self, session_id: u32) -> Snapshot {
        Snapshot {
            valid: false,
            session_id,
            timestamp_us: self.get_monotonic_clock_us(),
            yaw_deg: 0.0,
            pitch_deg: 0.0,
            roll_deg: 0.0,
            status: Some("error".into()),
            code: Some("TOBII_NOT_IMPLEMENTED".into()),
            message: Some("此版本尚未支援 Tobii Eye Tracker 5。".into()),
        }
    }

    pub fn stop(&self, _session_id: u32) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_tobii_never_reports_connected_or_valid_pose() {
        let manager = TobiiManager::new();
        for session in 1..=3 {
            assert!(manager.start(session).is_err());
            let snapshot = manager.read_snapshot(session);
            assert!(!snapshot.valid);
            assert_eq!(snapshot.code.as_deref(), Some("TOBII_NOT_IMPLEMENTED"));
            manager.stop(session);
        }
    }
}
