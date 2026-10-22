#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod tobii;
mod recording;

use std::sync::Arc;
use tauri::{Emitter, Manager, State, WebviewWindow};
use tobii::{Snapshot, TobiiManager};
use recording::{RecordingDestination, RecordingManager};

#[tauri::command]
async fn start_recording(window: WebviewWindow, manager: State<'_, Arc<RecordingManager>>, header: String) -> Result<RecordingDestination, String> {
    if window.label() != "main" { return Err("Unauthorized window".into()); }
    let directory = recording::data_directory().map_err(|e| e.to_string())?;
    let manager = Arc::clone(&manager);
    tauri::async_runtime::spawn_blocking(move || manager.start(&directory, &header)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn append_recording(window: WebviewWindow, manager: State<'_, Arc<RecordingManager>>, id: String, rows: String) -> Result<(), String> {
    if window.label() != "main" { return Err("Unauthorized window".into()); }
    let manager = Arc::clone(&manager);
    tauri::async_runtime::spawn_blocking(move || manager.append(&id, &rows)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn finish_recording(window: WebviewWindow, manager: State<'_, Arc<RecordingManager>>, id: String) -> Result<(), String> {
    if window.label() != "main" { return Err("Unauthorized window".into()); }
    let manager = Arc::clone(&manager);
    tauri::async_runtime::spawn_blocking(move || manager.finish(&id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn close_application(window: WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("Unauthorized window".into()); }
    window.destroy().map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClockResponse {
    timestamp_us: i64,
}

#[tauri::command]
async fn get_native_clock(manager: State<'_, Arc<TobiiManager>>) -> Result<ClockResponse, String> {
    Ok(ClockResponse {
        timestamp_us: manager.get_monotonic_clock_us(),
    })
}

#[tauri::command]
async fn start_tobii(
    window: WebviewWindow,
    session_id: u32,
    manager: State<'_, Arc<TobiiManager>>,
) -> Result<Snapshot, String> {
    if window.label() != "main" {
        return Err("Unauthorized window".into());
    }
    manager.start(session_id)
}

#[tauri::command]
async fn read_tobii_snapshot(
    window: WebviewWindow,
    session_id: u32,
    manager: State<'_, Arc<TobiiManager>>,
) -> Result<Snapshot, String> {
    if window.label() != "main" {
        return Err("Unauthorized window".into());
    }
    Ok(manager.read_snapshot(session_id))
}

#[tauri::command]
async fn stop_tobii(
    window: WebviewWindow,
    session_id: u32,
    manager: State<'_, Arc<TobiiManager>>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Unauthorized window".into());
    }
    manager.stop(session_id);
    Ok(())
}

#[tauri::command]
async fn set_fullscreen(window: WebviewWindow, fullscreen: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Unauthorized window".into());
    }
    window.set_fullscreen(fullscreen).map_err(|e| e.to_string())
}

fn main() {
    let tobii_manager = Arc::new(TobiiManager::new());
    let tobii_clone = Arc::clone(&tobii_manager);

    let app = tauri::Builder::default()
        .setup(|_app| {
            std::fs::create_dir_all(recording::data_directory()?)?;
            Ok(())
        })
        .on_permission_request(|webview, kind| {
            use tauri::webview::{PermissionKind, PermissionResponse};
            let local = webview
                .url()
                .is_ok_and(|url| url.host_str() == Some("tauri.localhost"));
            if webview.label() == "main" && local && matches!(kind, PermissionKind::Camera) {
                PermissionResponse::Allow
            } else {
                PermissionResponse::Default
            }
        })
        .manage(tobii_manager)
        .manage(Arc::new(RecordingManager::default()))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<Arc<RecordingManager>>().is_active() {
                    api.prevent_close();
                    let _ = window.emit("finish-recording", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_native_clock,
            start_tobii,
            read_tobii_snapshot,
            stop_tobii,
            set_fullscreen,
            start_recording, append_recording, finish_recording, close_application
        ])
        .build(tauri::generate_context!())
        .expect("Failed to initialize FlyingMoo desktop application");

    app.run(move |_app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            tobii_clone.stop(0);
        }
    });
}
