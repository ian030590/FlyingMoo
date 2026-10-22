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
    path: PathBuf,
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
        *guard = Some(ActiveRecording { id: id.clone(), path: path.clone(), file });
        Ok(RecordingDestination { id, path: path.to_string_lossy().into_owned() })
    }

    pub fn append(&self, id: &str, rows: &str) -> Result<(), String> {
        if rows.len() > 1_048_576 { return Err("CSV batch exceeds size limit".into()); }
        let mut guard = self.active.lock().map_err(|e| e.to_string())?;
        let active = guard.as_mut().filter(|r| r.id == id).ok_or("Recording session mismatch")?;
        active.file.write_all(rows.as_bytes()).and_then(|_| active.file.flush()).map_err(|e| e.to_string())
    }

    /// Completes the CSV, then writes the optional session summary next to it.
    /// Returns the summary path when one was written.
    pub fn finish(&self, id: &str, metadata: Option<&str>) -> Result<Option<String>, String> {
        let path = {
            let mut guard = self.active.lock().map_err(|e| e.to_string())?;
            let active = guard.as_mut().filter(|r| r.id == id).ok_or("Recording session mismatch")?;
            active.file.flush().and_then(|_| active.file.get_ref().sync_data()).map_err(|e| e.to_string())?;
            guard.take().map(|r| r.path).ok_or("Recording session mismatch")?
        };
        match metadata {
            Some(metadata) => write_session_summary(&path, metadata)
                .map(|summary| Some(summary.to_string_lossy().into_owned()))
                .map_err(|e| format!("CSV 已儲存，但場次摘要寫入失敗：{e}")),
            None => Ok(None),
        }
    }
}

fn write_session_summary(csv: &Path, metadata: &str) -> Result<PathBuf, String> {
    if metadata.len() > 262_144 { return Err("Session summary exceeds size limit".into()); }
    let mut summary: serde_json::Value = serde_json::from_str(metadata).map_err(|e| e.to_string())?;
    let fields = summary.as_object_mut().ok_or("Session summary must be a JSON object")?;
    let stem = csv.file_stem().ok_or("Recording path has no file name")?.to_string_lossy().into_owned();
    let csv_name = csv.file_name().ok_or("Recording path has no file name")?.to_string_lossy().into_owned();
    fields.insert("appVersion".into(), env!("CARGO_PKG_VERSION").into());
    fields.insert("csvFile".into(), csv_name.into());
    let target = csv.with_file_name(format!("{stem}_session.json"));
    let file = OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| e.to_string())?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer_pretty(&mut writer, &summary).map_err(|e| e.to_string())?;
    writer.flush().and_then(|_| writer.get_ref().sync_data()).map_err(|e| e.to_string())?;
    Ok(target)
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
        assert!(manager.finish("wrong", None).is_err());
        assert_eq!(manager.finish(&destination.id, None).unwrap(), None);
        assert_eq!(fs::read_to_string(&destination.path).unwrap(), "sequence,valid\r\n1,true\r\n2,false\r\n");
        assert!(manager.append(&destination.id, "3,true").is_err());
        fs::remove_file(&destination.path).unwrap();
        fs::remove_dir(&directory).unwrap();
    }

    #[test]
    fn session_summary_is_written_beside_the_csv() {
        let directory = std::env::temp_dir().join(format!("flyingmoo-summary-{}", std::process::id()));
        let manager = RecordingManager::default();
        let destination = manager.start(&directory, "event\r\n").unwrap();
        let summary = manager.finish(&destination.id, Some(r#"{"source":"tobii","fixation":{"onTargetRatio":0.9}}"#)).unwrap().unwrap();
        let csv = PathBuf::from(&destination.path);
        assert_eq!(PathBuf::from(&summary).parent(), csv.parent());
        let value: serde_json::Value = serde_json::from_str(&fs::read_to_string(&summary).unwrap()).unwrap();
        assert_eq!(value["source"], "tobii");
        assert_eq!(value["appVersion"], env!("CARGO_PKG_VERSION"));
        assert_eq!(value["csvFile"], csv.file_name().unwrap().to_string_lossy().as_ref());

        let second = manager.start(&directory, "event\r\n").unwrap();
        let error = manager.finish(&second.id, Some("[1, 2]")).unwrap_err();
        assert!(error.contains("CSV 已儲存"));
        assert!(manager.append(&second.id, "late").is_err());
        for path in [&destination.path, &second.path, &summary] { fs::remove_file(path).unwrap(); }
        fs::remove_dir(&directory).unwrap();
    }
}
