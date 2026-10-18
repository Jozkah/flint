//! Thin Tauri commands over `store::RoomStore`. File work runs on the blocking
//! pool so the async runtime is never held by disk IO or the write lock.
//!
//! `room` and `record` arrive as untyped JSON and are parsed in the store, so a
//! malformed payload rejects with `{ code: "invalid_room", message }` rather
//! than Tauri's plain-string argument error.

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Runtime};

use super::store::{
    parse_record, parse_room, Room, RoomError, RoomErrorCode, RoomJournalRecord, RoomStore,
    RoomSummary, RoomWithJournal,
};
use crate::core::app::commands::get_jan_data_folder_path;

fn store<R: Runtime>(app_handle: AppHandle<R>) -> RoomStore {
    RoomStore::for_data_folder(&get_jan_data_folder_path(app_handle))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

async fn run_blocking<T, F>(task: F) -> Result<T, RoomError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, RoomError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| RoomError::new(RoomErrorCode::Unknown, format!("room task failed: {e}")))?
}

#[tauri::command]
pub async fn rooms_list<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<Vec<RoomSummary>, RoomError> {
    let store = store(app_handle);
    run_blocking(move || store.list()).await
}

#[tauri::command]
pub async fn room_get<R: Runtime>(
    app_handle: AppHandle<R>,
    room_id: String,
) -> Result<RoomWithJournal, RoomError> {
    let store = store(app_handle);
    run_blocking(move || store.get(&room_id)).await
}

#[tauri::command]
pub async fn room_save<R: Runtime>(
    app_handle: AppHandle<R>,
    room: serde_json::Value,
) -> Result<Room, RoomError> {
    let store = store(app_handle);
    run_blocking(move || store.save(parse_room(room)?, now_ms())).await
}

#[tauri::command]
pub async fn room_append<R: Runtime>(
    app_handle: AppHandle<R>,
    room_id: String,
    record: serde_json::Value,
) -> Result<RoomJournalRecord, RoomError> {
    let store = store(app_handle);
    run_blocking(move || store.append(&room_id, parse_record(record)?)).await
}

#[tauri::command]
pub async fn room_clear_journal<R: Runtime>(
    app_handle: AppHandle<R>,
    room_id: String,
) -> Result<(), RoomError> {
    let store = store(app_handle);
    run_blocking(move || store.clear_journal(&room_id)).await
}

/// Delete a room. With the archive on (the default) it moves to the archive
/// and can be restored; with it off this is `room_delete_permanently`.
#[tauri::command]
pub async fn room_delete<R: Runtime>(
    app_handle: AppHandle<R>,
    room_id: String,
) -> Result<(), RoomError> {
    let data = get_jan_data_folder_path(app_handle);
    let store = RoomStore::for_data_folder(&data);
    run_blocking(move || {
        if crate::core::archive::store::read_settings(&data).enabled {
            store.archive(&data, &room_id)
        } else {
            store.delete(&room_id)
        }
    })
    .await
}

/// Delete a room and everything in it, skipping the archive.
#[tauri::command]
pub async fn room_delete_permanently<R: Runtime>(
    app_handle: AppHandle<R>,
    room_id: String,
) -> Result<(), RoomError> {
    let store = store(app_handle);
    run_blocking(move || store.delete(&room_id)).await
}

/// The participant's isolated workspace in a compare room, made on first use
/// under the room's own directory. Refused for an untrusted folder.
#[tauri::command]
pub async fn room_workspace_ensure<R: Runtime>(
    app_handle: AppHandle<R>,
    room_id: String,
    participant_id: String,
    folder: String,
) -> Result<super::workspace::WorkspaceInfo, RoomError> {
    let root = store(app_handle).root().to_path_buf();
    run_blocking(move || {
        let path = std::path::Path::new(&folder);
        let trusted = tauri_plugin_agent_tools::folder_trust::is_trusted(path);
        super::workspace::ensure(&root, &room_id, &participant_id, path, trusted)
    })
    .await
}

#[tauri::command]
pub async fn room_workspace_changes<R: Runtime>(
    app_handle: AppHandle<R>,
    room_id: String,
    participant_id: String,
    scope: Option<super::workspace::ChangeScope>,
) -> Result<super::workspace::WorkspaceChanges, RoomError> {
    let root = store(app_handle).root().to_path_buf();
    let scope = scope.unwrap_or(super::workspace::ChangeScope::All);
    run_blocking(move || super::workspace::changes(&root, &room_id, &participant_id, scope)).await
}

/// Remember the participant's workspace as it is at the start of a turn, so
/// the turn's change card shows that turn's change alone.
#[tauri::command]
pub async fn room_workspace_mark_turn<R: Runtime>(
    app_handle: AppHandle<R>,
    room_id: String,
    participant_id: String,
) -> Result<(), RoomError> {
    let root = store(app_handle).root().to_path_buf();
    run_blocking(move || super::workspace::mark_turn(&root, &room_id, &participant_id)).await
}

#[tauri::command]
pub async fn room_workspace_patch<R: Runtime>(
    app_handle: AppHandle<R>,
    room_id: String,
    participant_id: String,
) -> Result<String, RoomError> {
    let root = store(app_handle).root().to_path_buf();
    run_blocking(move || super::workspace::patch(&root, &room_id, &participant_id)).await
}

#[tauri::command]
pub async fn room_workspace_reset<R: Runtime>(
    app_handle: AppHandle<R>,
    room_id: String,
    participant_id: String,
) -> Result<(), RoomError> {
    let root = store(app_handle).root().to_path_buf();
    run_blocking(move || super::workspace::reset(&root, &room_id, &participant_id)).await
}

/// Apply a participant's change to the user's folder. Called only from the
/// user's "Apply to my folder" action, after the patch preview.
#[tauri::command]
pub async fn room_workspace_apply<R: Runtime>(
    app_handle: AppHandle<R>,
    room_id: String,
    participant_id: String,
    paths: Option<Vec<String>>,
) -> Result<u32, RoomError> {
    let root = store(app_handle).root().to_path_buf();
    run_blocking(move || {
        super::workspace::apply(&root, &room_id, &participant_id, paths.as_deref())
    })
    .await
}

/// The review before applying: patch, target folder, a dry-run check per file,
/// and the user's uncommitted edits to the same files. Writes nothing.
#[tauri::command]
pub async fn room_workspace_apply_preview<R: Runtime>(
    app_handle: AppHandle<R>,
    room_id: String,
    participant_id: String,
) -> Result<super::workspace::ApplyPreview, RoomError> {
    let root = store(app_handle).root().to_path_buf();
    run_blocking(move || super::workspace::preview(&root, &room_id, &participant_id)).await
}

/// Reverse the last apply in the user's folder (the toast's Undo).
#[tauri::command]
pub async fn room_workspace_undo_apply<R: Runtime>(
    app_handle: AppHandle<R>,
    room_id: String,
    participant_id: String,
) -> Result<(), RoomError> {
    let root = store(app_handle).root().to_path_buf();
    run_blocking(move || super::workspace::undo_apply(&root, &room_id, &participant_id)).await
}

#[tauri::command]
pub async fn room_workspace_remove<R: Runtime>(
    app_handle: AppHandle<R>,
    room_id: String,
) -> Result<(), RoomError> {
    let root = store(app_handle).root().to_path_buf();
    run_blocking(move || super::workspace::remove_all(&root, &room_id)).await
}
