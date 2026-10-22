use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn data_directory() -> std::io::Result<PathBuf> {
    let executable = std::env::current_exe()?;
    let directory = executable.parent().ok_or_else(|| std::io::Error::other("Executable directory is unavailable"))?;
    Ok(directory.join("Data"))
}

#[derive(serde::Serialize)]
pub struct RecordingDestination {
    pub id: String,
    pub path: String,
}

struct ActiveRecording {
    id: String,
    file: BufWriter<File>,
}

#[derive(Default)]
pub struct RecordingManager {
    active: Mutex<Option<ActiveRecording>>,
}

impl RecordingManager {
    pub fn is_active(&self) -> bool {
        self.active.lock().map(|r| r.is_some()).unwrap_or(true)
    }

    pub fn start(&self, directory: &Path, header: &str) -> Result<RecordingDestination, String> {
        if header.len() > 8192 || header.contains('\0') {
            return Err("Invalid CSV header".into());
        }
        let mut guard = self.active.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("Previous recording must finish before starting another".into());
        }
        fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        let id = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos().to_string();
        let path = directory.join(format!("FlyingMoo_{id}.csv"));
        let mut file = BufWriter::new(OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| e.to_string())?);
        file.write_all(header.as_bytes()).and_then(|_| file.flush()).map_err(|e| e.to_string())?;
        *guard = Some(ActiveRecording { id: id.clone(), file });
        Ok(RecordingDestination { id, path: path.to_string_lossy().into_owned() })
    }

    pub fn append(&self, id: &str, rows: &str) -> Result<(), String> {
        if rows.len() > 1_048_576 { return Err("CSV batch exceeds size limit".into()); }
        let mut guard = self.active.lock().map_err(|e| e.to_string())?;
        let active = guard.as_mut().filter(|r| r.id == id).ok_or("Recording session mismatch")?;
        active.file.write_all(rows.as_bytes()).and_then(|_| active.file.flush()).map_err(|e| e.to_string())
    }

    pub fn finish(&self, id: &str) -> Result<(), String> {
        let mut guard = self.active.lock().map_err(|e| e.to_string())?;
        let active = guard.as_mut().filter(|r| r.id == id).ok_or("Recording session mismatch")?;
        active.file.flush().and_then(|_| active.file.get_ref().sync_data()).map_err(|e| e.to_string())?;
        guard.take();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_batches_remain_ordered_and_sessions_are_isolated() {
        let directory = std::env::temp_dir().join(format!("flyingmoo-recording-{}", std::process::id()));
        let manager = RecordingManager::default();
        let destination = manager.start(&directory, "sequence,valid\r\n").unwrap();
        assert!(manager.start(&directory, "header").is_err());
        assert!(manager.append("../other", "bad").is_err());
        manager.append(&destination.id, "1,true\r\n").unwrap();
        manager.append(&destination.id, "2,false\r\n").unwrap();
        assert!(manager.finish("wrong").is_err());
        manager.finish(&destination.id).unwrap();
        assert_eq!(fs::read_to_string(&destination.path).unwrap(), "sequence,valid\r\n1,true\r\n2,false\r\n");
        assert!(manager.append(&destination.id, "3,true").is_err());
        fs::remove_file(&destination.path).unwrap();
        fs::remove_dir(&directory).unwrap();
    }
}
