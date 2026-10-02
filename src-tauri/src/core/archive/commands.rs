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
    let data = get_jan_data_folder_path(app_handle.clone());
    #[allow(unused_mut)]
    let mut items = blocking(move || Ok(store::list(&data))).await?;
    // On the phone, deleted threads live in SQLite with a `deleted_at` stamp.
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        use crate::core::threads::db;
        for (id, thread, at, bytes) in db::db_list_deleted_threads(app_handle).await? {
            items.push(ArchivedItem {
                archive_id: format!("{SQLITE_PREFIX}{id}"),
                size_bytes: bytes,
                meta: store::ArchiveMeta {
                    kind: Kind::Thread,
                    title: thread.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                    id,
                    archived_at: (at.max(0) as u64) * 1000,
                    origin: "database".to_string(),
                    storage: store::Storage::Dir,
                    extra: None,
                },
            });
        }
        items.sort_by(|a, b| b.meta.archived_at.cmp(&a.meta.archived_at));
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let _ = app_handle;
    Ok(items)
}

/// Archive ids of phone-local SQLite rows start with this; no file-backed
/// archive name can (its ids may not contain a colon).
#[cfg(any(target_os = "android", target_os = "ios"))]
const SQLITE_PREFIX: &str = "sqlite:";

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

/// A bounded, read-only look inside an archived item (its first messages, a
/// recipe, a name list), without restoring it. Never writes.
#[tauri::command]
pub async fn archive_preview<R: Runtime>(
    app_handle: AppHandle<R>,
    kind: String,
    archive_id: String,
) -> Result<super::preview::ArchivePreview, String> {
    let data = get_jan_data_folder_path(app_handle);
    let kind = Kind::parse(&kind)?;
    blocking(move || super::preview::preview(&data, kind, &archive_id)).await
}

#[tauri::command]
pub async fn archive_restore<R: Runtime>(
    app_handle: AppHandle<R>,
    kind: String,
    archive_id: String,
) -> Result<Restored, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    if let Some(id) = archive_id.strip_prefix(SQLITE_PREFIX) {
        crate::core::threads::utils::validate_thread_id(id)?;
        crate::core::threads::db::db_restore_thread(app_handle, id).await?;
        return Ok(Restored {
            kind: Kind::parse(&kind)?,
            id: id.to_string(),
            title: String::new(),
            payload: None,
            extra: None,
        });
    }
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
    #[cfg(any(target_os = "android", target_os = "ios"))]
    if let Some(id) = archive_id.strip_prefix(SQLITE_PREFIX) {
        crate::core::threads::utils::validate_thread_id(id)?;
        return crate::core::threads::db::db_purge_thread(app_handle, id).await;
    }
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
    let data = get_jan_data_folder_path(app_handle.clone());
    let kind = kind.as_deref().map(Kind::parse).transpose()?;
    #[allow(unused_mut)]
    let mut report = blocking(move || {
        let mut hook = |m: &store::ArchiveMeta, d: &std::path::Path| purge_cleanup(&data, m, d);
        Ok(store::purge_matching(&data, kind, None, &mut hook))
    })
    .await?;
    #[cfg(any(target_os = "android", target_os = "ios"))]
    if kind.is_none() || kind == Some(Kind::Thread) {
        report.purged +=
            crate::core::threads::db::db_purge_deleted_threads(app_handle, None).await? as usize;
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let _ = app_handle;
    Ok(report)
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
