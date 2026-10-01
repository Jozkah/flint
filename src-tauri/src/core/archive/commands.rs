//! Tauri commands over `store`. File work runs on the blocking pool.

use serde_json::Value;
use tauri::{AppHandle, Runtime};

use super::purge_cleanup;
use super::store::{self, ArchiveSettings, ArchivedItem, Kind, PurgeReport, Restored};
use crate::core::app::commands::get_jan_data_folder_path;

async fn blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("archive task failed: {e}"))?
}

#[tauri::command]
pub async fn archive_list<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<Vec<ArchivedItem>, String> {
    let data = get_jan_data_folder_path(app_handle);
    blocking(move || Ok(store::list(&data))).await
}

#[tauri::command]
pub async fn archive_disk_usage<R: Runtime>(app_handle: AppHandle<R>) -> Result<u64, String> {
    let data = get_jan_data_folder_path(app_handle);
    blocking(move || Ok(store::disk_usage(&data))).await
}

/// Keep a Cowork session or project (no directory of its own) in the archive.
#[tauri::command]
pub async fn archive_put<R: Runtime>(
    app_handle: AppHandle<R>,
    kind: String,
    id: String,
    title: String,
    payload: Value,
    extra: Option<Value>,
) -> Result<String, String> {
    let data = get_jan_data_folder_path(app_handle);
    let kind = Kind::parse(&kind)?;
    blocking(move || store::archive_payload(&data, kind, &id, &title, &payload, extra)).await
}

#[tauri::command]
pub async fn archive_restore<R: Runtime>(
    app_handle: AppHandle<R>,
    kind: String,
    archive_id: String,
) -> Result<Restored, String> {
    let data = get_jan_data_folder_path(app_handle);
    let kind = Kind::parse(&kind)?;
    blocking(move || store::restore(&data, kind, &archive_id)).await
}

/// Delete one archived item for good.
#[tauri::command]
pub async fn archive_purge<R: Runtime>(
    app_handle: AppHandle<R>,
    kind: String,
    archive_id: String,
) -> Result<(), String> {
    let data = get_jan_data_folder_path(app_handle);
    let kind = Kind::parse(&kind)?;
    blocking(move || {
        let mut hook = |m: &store::ArchiveMeta, d: &std::path::Path| purge_cleanup(&data, m, d);
        store::purge_with(&data, kind, &archive_id, &mut hook)
    })
    .await
}

/// Delete everything in the archive (or one kind). Items a guard refuses stay
/// and come back in the report.
#[tauri::command]
pub async fn archive_empty<R: Runtime>(
    app_handle: AppHandle<R>,
    kind: Option<String>,
) -> Result<PurgeReport, String> {
    let data = get_jan_data_folder_path(app_handle);
    let kind = kind.as_deref().map(Kind::parse).transpose()?;
    blocking(move || {
        let mut hook = |m: &store::ArchiveMeta, d: &std::path::Path| purge_cleanup(&data, m, d);
        Ok(store::purge_matching(&data, kind, None, &mut hook))
    })
    .await
}

#[tauri::command]
pub async fn archive_get_settings<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<ArchiveSettings, String> {
    let data = get_jan_data_folder_path(app_handle);
    blocking(move || Ok(store::read_settings(&data))).await
}

#[tauri::command]
pub async fn archive_set_settings<R: Runtime>(
    app_handle: AppHandle<R>,
    settings: ArchiveSettings,
) -> Result<ArchiveSettings, String> {
    let data = get_jan_data_folder_path(app_handle);
    blocking(move || {
        store::write_settings(&data, &settings)?;
        Ok(settings)
    })
    .await
}
