//! Tauri commands for the owner's side of guest links. Thin: every one builds
//! its arguments into the JSON `guest::call` takes, the same call `flint
//! serve`'s RPC makes, so the desktop app and a browser behave alike.

use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use crate::core::app::commands::get_jan_data_folder_path;

async fn run<R: Runtime>(app: AppHandle<R>, command: &'static str, args: Value) -> Result<Value, String> {
    let root = get_jan_data_folder_path(app);
    tauri::async_runtime::spawn_blocking(move || super::call(&root, command, &args))
        .await
        .map_err(|e| format!("guest task failed: {e}"))?
}

#[tauri::command]
pub async fn guest_share_settings_get<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    run(app, "guest_share_settings_get", json!({})).await
}

#[tauri::command]
pub async fn guest_share_settings_set<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<Value, String> {
    run(app, "guest_share_settings_set", json!({ "enabled": enabled })).await
}

#[tauri::command]
pub async fn guest_share_create<R: Runtime>(
    app: AppHandle<R>,
    thread_id: String,
    ttl_hours: Option<u64>,
    include_reasoning: Option<bool>,
) -> Result<Value, String> {
    run(
        app,
        "guest_share_create",
        json!({ "threadId": thread_id, "ttlHours": ttl_hours, "includeReasoning": include_reasoning }),
    )
    .await
}

#[tauri::command]
pub async fn guest_share_list<R: Runtime>(app: AppHandle<R>, thread_id: Option<String>) -> Result<Value, String> {
    run(app, "guest_share_list", json!({ "threadId": thread_id })).await
}

#[tauri::command]
pub async fn guest_share_stop<R: Runtime>(app: AppHandle<R>, share_id: String) -> Result<Value, String> {
    run(app, "guest_share_stop", json!({ "shareId": share_id })).await
}

#[tauri::command]
pub async fn guest_share_extend<R: Runtime>(app: AppHandle<R>, share_id: String, ttl_hours: u64) -> Result<Value, String> {
    run(app, "guest_share_extend", json!({ "shareId": share_id, "ttlHours": ttl_hours })).await
}

#[tauri::command]
pub async fn guest_share_pending<R: Runtime>(app: AppHandle<R>, thread_id: String) -> Result<Value, String> {
    run(app, "guest_share_pending", json!({ "threadId": thread_id })).await
}

#[tauri::command]
pub async fn guest_share_resolve<R: Runtime>(
    app: AppHandle<R>,
    share_id: String,
    pending_id: String,
    action: String,
) -> Result<Value, String> {
    run(
        app,
        "guest_share_resolve",
        json!({ "shareId": share_id, "pendingId": pending_id, "action": action }),
    )
    .await
}
