use std::fs;
use tauri::Runtime;

#[cfg(any(target_os = "android", target_os = "ios"))]
use super::db;
use super::helpers::{
    should_use_sqlite, update_thread_metadata,
};
use super::{
    constants::THREADS_FILE,
    utils::{
        ensure_data_dirs, get_data_dir, get_thread_metadata_path, validate_thread_id,
    },
};
use crate::core::app::commands::get_jan_data_folder_path;

/// Lists all threads by reading their metadata from the threads directory or database.
/// Returns a vector of thread metadata as JSON values.
#[tauri::command]
pub async fn list_threads<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<serde_json::Value>, String> {
    if should_use_sqlite() {
        // Use SQLite on mobile platforms
        #[cfg(any(target_os = "android", target_os = "ios"))]
        return db::db_list_threads(app_handle).await;
    }

    // Use file-based storage on desktop. Reading every thread.json is file
    // IO: keep it off the async runtime's worker threads.
    let data_folder = get_jan_data_folder_path(app_handle);
    tokio::task::spawn_blocking(move || list_threads_in(&data_folder))
        .await
        .map_err(|e| e.to_string())?
}

/// The thread list for a sidebar: like `list_threads`, but each assistant is
/// cut to `{id, name, model}`, so instructions, tool lists and other heavy
/// fields stay on disk (PERF-012). Fetch the full assistant with
/// `get_thread_assistant` when a thread is opened. `list_threads` is unchanged.
#[tauri::command]
pub async fn list_thread_summaries<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<serde_json::Value>, String> {
    let threads = list_threads(app_handle).await?;
    Ok(threads.into_iter().map(thread_summary).collect())
}

fn thread_summary(mut thread: serde_json::Value) -> serde_json::Value {
    if let Some(list) = thread.get_mut("assistants").and_then(|a| a.as_array_mut()) {
        for a in list.iter_mut() {
            if let Some(obj) = a.as_object() {
                let mut slim = serde_json::Map::new();
                for key in ["id", "name", "model"] {
                    if let Some(v) = obj.get(key) {
                        slim.insert(key.to_string(), v.clone());
                    }
                }
                // Marks the entry as cut: a write that carries it back is
                // restored from disk (`restore_summary_assistants`).
                slim.insert(super::helpers::SUMMARY_MARKER.to_string(), serde_json::Value::Bool(true));
                *a = serde_json::Value::Object(slim);
            }
        }
    }
    thread
}

fn list_threads_in(data_folder: &std::path::Path) -> Result<Vec<serde_json::Value>, String> {
    ensure_data_dirs(data_folder)?;
    let data_dir = get_data_dir(data_folder);
    let mut threads = Vec::new();

    if !data_dir.exists() {
        return Ok(threads);
    }

    let mut cache = thread_file_cache().lock().unwrap_or_else(|p| p.into_inner());
    let mut seen = std::collections::HashSet::new();
    for entry in fs::read_dir(&data_dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else {
            continue;
        };
        // `file_type` comes with the directory listing on Windows and most
        // Unix filesystems, so no extra stat per entry.
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let thread_metadata_path = entry.path().join(THREADS_FILE);
        // One thread that cannot be read (deleted between the listing and
        // the read, locked, permission denied) must not hide every other
        // thread: skip it like an unparsable one.
        let Ok(meta) = fs::metadata(&thread_metadata_path) else {
            continue;
        };
        let stamp = (meta.modified().ok(), meta.len());
        seen.insert(thread_metadata_path.clone());
        // Unchanged since the last list (same mtime and length): reuse the
        // parsed value instead of reading and parsing the file again.
        if let Some((cached_stamp, value)) = cache.get(&thread_metadata_path) {
            if *cached_stamp == stamp && stamp.0.is_some() {
                threads.push(value.clone());
                continue;
            }
        }
        let data = match fs::read_to_string(&thread_metadata_path) {
            Ok(data) => data,
            Err(e) => {
                log::warn!(
                    "Skipping unreadable thread file {}: {e}",
                    thread_metadata_path.display()
                );
                continue;
            }
        };
        match parse_thread_file(&data) {
            Ok(thread) => {
                cache.insert(thread_metadata_path, (stamp, thread.clone()));
                threads.push(thread);
            }
            Err(e) => {
                log::warn!(
                    "Skipping thread file {}: {e}",
                    thread_metadata_path.display()
                );
                cache.remove(&thread_metadata_path);
            }
        }
    }
    // Threads deleted since the last list leave the cache with them.
    cache.retain(|path, _| seen.contains(path));

    Ok(threads)
}

type ThreadStamp = (Option<std::time::SystemTime>, u64);

/// Parsed `thread.json` files by path, with the (mtime, length) they were
/// parsed at.
fn thread_file_cache(
) -> &'static std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, (ThreadStamp, serde_json::Value)>> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, (ThreadStamp, serde_json::Value)>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

#[cfg(test)]
mod list_threads_cache_tests {
    use super::*;

    #[test]
    fn a_summary_keeps_thread_fields_and_cuts_assistants_to_id_name_model() {
        let t = serde_json::json!({
            "id": "t1", "title": "one", "updated": 5,
            "metadata": {"is_favorite": true, "project": {"id": "p"}},
            "assistants": [{"id": "a", "name": "A", "model": {"id": "m"}, "instructions": "long", "tools": [1, 2]}]
        });
        let s = thread_summary(t.clone());
        assert_eq!(s["title"], "one");
        assert_eq!(s["metadata"], t["metadata"]);
        assert_eq!(s["assistants"], serde_json::json!([{"id": "a", "name": "A", "model": {"id": "m"}, "summary": true}]));
    }

    #[test]
    fn an_unchanged_thread_file_is_served_from_the_cache_and_a_changed_one_is_reread() {
        let root = std::env::temp_dir().join(format!("jan_list_cache_{}", uuid::Uuid::new_v4()));
        let dir = get_data_dir(&root).join("t1");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(THREADS_FILE);
        fs::write(&file, r#"{"id":"t1","title":"one"}"#).unwrap();
        // A stray file beside the thread folders is not a thread.
        fs::write(get_data_dir(&root).join("stray.txt"), "x").unwrap();
        let first = list_threads_in(&root).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["title"], "one");
        assert!(thread_file_cache().lock().unwrap().contains_key(&file));

        // Same length and mtime: the cached value is what comes back, which
        // the poisoned cache entry proves.
        {
            let mut cache = thread_file_cache().lock().unwrap();
            let entry = cache.get_mut(&file).unwrap();
            entry.1["title"] = serde_json::json!("cached");
        }
        assert_eq!(list_threads_in(&root).unwrap()[0]["title"], "cached");

        // A real change (new length) is read again.
        fs::write(&file, r#"{"id":"t1","title":"renamed"}"#).unwrap();
        assert_eq!(list_threads_in(&root).unwrap()[0]["title"], "renamed");

        // A deleted thread drops out of the list and the cache.
        fs::remove_dir_all(&dir).unwrap();
        assert!(list_threads_in(&root).unwrap().is_empty());
        assert!(!thread_file_cache().lock().unwrap().contains_key(&file));
        let _ = fs::remove_dir_all(&root);
    }
}

/// Parses a thread.json, tolerating a UTF-8 BOM and rejecting anything that is
/// not a JSON object so one odd file cannot break the list.
fn parse_thread_file(data: &str) -> Result<serde_json::Value, String> {
    let value: serde_json::Value =
        serde_json::from_str(data.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())?;
    if value.is_object() {
        Ok(value)
    } else {
        Err("thread.json is not a JSON object".to_string())
    }
}

#[cfg(test)]
mod parse_thread_file_tests {
    use super::parse_thread_file;

    #[test]
    fn accepts_bom_and_rejects_non_objects() {
        assert!(parse_thread_file("\u{feff}{\"id\":\"a\"}").is_ok());
        assert!(parse_thread_file("null").is_err());
        assert!(parse_thread_file("[1]").is_err());
        assert!(parse_thread_file("{bad").is_err());
    }
}

/// Creates a new thread, assigns it a unique ID, and persists its metadata.
/// Ensures the thread directory exists and writes thread.json.
#[tauri::command]
pub async fn create_thread<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    thread: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if should_use_sqlite() {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        return db::db_create_thread(app_handle, thread).await;
    }

    // Use file-based storage on desktop
    let data_folder = get_jan_data_folder_path(app_handle);
    tokio::task::spawn_blocking(move || super::storage::create_thread_in(&data_folder, thread))
        .await
        .map_err(|e| e.to_string())?
}

/// Modifies an existing thread's metadata by overwriting its thread.json file.
/// Returns an error if the thread directory does not exist.
#[tauri::command]
pub async fn modify_thread<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    thread: serde_json::Value,
) -> Result<(), String> {
    if should_use_sqlite() {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        return db::db_modify_thread(app_handle, thread).await;
    }

    // Use file-based storage on desktop
    let data_folder = get_jan_data_folder_path(app_handle);
    super::storage::modify_thread_in(&data_folder, thread).await
}

/// Deletes a thread. With the archive on (the default) the thread is moved to
/// the archive instead of destroyed, and everything recorded about it stays
/// until it is purged; with it off this is `delete_thread_permanently`.
#[tauri::command]
pub async fn delete_thread<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    thread_id: String,
) -> Result<(), String> {
    validate_thread_id(&thread_id)?;
    if should_use_sqlite() {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        return db::db_delete_thread(app_handle, &thread_id, true).await;
    }

    let data_folder = get_jan_data_folder_path(app_handle);
    super::storage::delete_thread_in(&data_folder, &thread_id, false).await
}

/// Deletes a thread and all its associated files by removing its directory,
/// skipping the archive.
#[tauri::command]
pub async fn delete_thread_permanently<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    thread_id: String,
) -> Result<(), String> {
    validate_thread_id(&thread_id)?;
    if should_use_sqlite() {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        return db::db_delete_thread(app_handle, &thread_id, false).await;
    }

    let data_folder = get_jan_data_folder_path(app_handle);
    super::storage::delete_thread_in(&data_folder, &thread_id, true).await
}

/// Move a thread directory into the archive. A thread that is already gone is
/// not an error (a delete of nothing has always been fine); a thread that
/// cannot be archived is, so a failed attempt to keep it never destroys it. The
/// per-thread lock keeps a message append from landing mid-move.
/// The old delete: remove the directory, then what was recorded about it.
/// Lists all messages for a given thread by reading and parsing its messages.jsonl file.
/// Returns a vector of message JSON values.
#[tauri::command]
pub async fn list_messages<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    thread_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    validate_thread_id(&thread_id)?;
    if should_use_sqlite() {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        return db::db_list_messages(app_handle, &thread_id).await;
    }

    // Use file-based storage on desktop
    let data_folder = get_jan_data_folder_path(app_handle);
    tokio::task::spawn_blocking(move || {
        super::helpers::read_messages_lossy(&data_folder, &thread_id).map(|r| r.messages)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Finds a phrase in the text of every conversation: where it was said, with a
/// snippet. Desktop file storage only; the mobile database returns nothing.
#[tauri::command]
pub async fn search_messages<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<super::search::MessageHit>, String> {
    if should_use_sqlite() {
        return Ok(Vec::new());
    }
    let data_folder = get_jan_data_folder_path(app_handle);
    let limit = limit.unwrap_or(30);
    // A scan reads every chat's file; keep it off the async runtime's threads.
    tokio::task::spawn_blocking(move || {
        super::search::search_messages_latest(&data_folder, &query, limit)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Appends a new message to a thread's messages.jsonl file.
/// Uses a per-thread async lock to prevent race conditions and ensure file consistency.
#[tauri::command]
pub async fn create_message<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    message: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if should_use_sqlite() {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        return db::db_create_message(app_handle, message).await;
    }

    // Use file-based storage on desktop
    let data_folder = get_jan_data_folder_path(app_handle);
    super::storage::create_message_in(&data_folder, message).await
}

/// Modifies an existing message in a thread's messages.jsonl file.
/// Uses a per-thread async lock to prevent race conditions and ensure file consistency.
/// Rewrites the entire messages.jsonl file for the thread.
#[tauri::command]
pub async fn modify_message<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    message: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if should_use_sqlite() {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        return db::db_modify_message(app_handle, message).await;
    }

    // Use file-based storage on desktop
    let data_folder = get_jan_data_folder_path(app_handle);
    super::storage::modify_message_in(&data_folder, message).await
}

/// Deletes a message from a thread's messages.jsonl file by message ID.
/// Rewrites the entire messages.jsonl file for the thread.
/// Uses a per-thread async lock to prevent race conditions and ensure file consistency.
#[tauri::command]
pub async fn delete_message<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    thread_id: String,
    message_id: String,
) -> Result<(), String> {
    validate_thread_id(&thread_id)?;
    if should_use_sqlite() {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        return db::db_delete_message(app_handle, &thread_id, &message_id).await;
    }

    // Use file-based storage on desktop
    let data_folder = get_jan_data_folder_path(app_handle);
    super::storage::delete_message_in(&data_folder, &thread_id, &message_id).await
}

/// Retrieves the first assistant associated with a thread.
/// Returns an error if the thread or assistant is not found.
#[tauri::command]
pub async fn get_thread_assistant<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    thread_id: String,
) -> Result<serde_json::Value, String> {
    validate_thread_id(&thread_id)?;
    if should_use_sqlite() {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        return db::db_get_thread_assistant(app_handle, &thread_id).await;
    }

    // Use file-based storage on desktop
    let data_folder = get_jan_data_folder_path(app_handle);
    let path = get_thread_metadata_path(&data_folder, &thread_id);
    let data = tokio::task::spawn_blocking(move || {
        if !path.exists() {
            return Err("Thread not found".to_string());
        }
        fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let thread: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    if let Some(assistants) = thread.get("assistants").and_then(|a| a.as_array()) {
        if let Some(first) = assistants.first() {
            Ok(first.clone())
        } else {
            Err("Assistant not found".to_string())
        }
    } else {
        Err("Assistant not found".to_string())
    }
}

/// Adds a new assistant to a thread's metadata.
/// Updates thread.json with the new assistant information.
#[tauri::command]
pub async fn create_thread_assistant<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    thread_id: String,
    assistant: serde_json::Value,
) -> Result<serde_json::Value, String> {
    validate_thread_id(&thread_id)?;
    if should_use_sqlite() {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        return db::db_create_thread_assistant(app_handle, &thread_id, assistant).await;
    }

    // Use file-based storage on desktop
    let data_folder = get_jan_data_folder_path(app_handle);
    let path = get_thread_metadata_path(&data_folder, &thread_id);
    // Read-modify-write of thread.json, under the thread's lock so a
    // concurrent update is not lost.
    let lock = super::helpers::get_lock_for_thread(&thread_id).await;
    let _guard = lock.lock().await;
    if !path.exists() {
        return Err("Thread not found".to_string());
    }
    let mut thread: serde_json::Value = {
        let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&data).map_err(|e| e.to_string())?
    };
    if let Some(assistants) = thread.get_mut("assistants").and_then(|a| a.as_array_mut()) {
        assistants.push(assistant.clone());
    } else {
        thread["assistants"] = serde_json::Value::Array(vec![assistant.clone()]);
    }
    update_thread_metadata(&data_folder, &thread_id, &thread)?;
    Ok(assistant)
}

/// Modifies an existing assistant's information in a thread's metadata.
/// Updates thread.json with the modified assistant data.
#[tauri::command]
pub async fn modify_thread_assistant<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    thread_id: String,
    assistant: serde_json::Value,
) -> Result<serde_json::Value, String> {
    validate_thread_id(&thread_id)?;
    if should_use_sqlite() {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        return db::db_modify_thread_assistant(app_handle, &thread_id, assistant).await;
    }

    // Use file-based storage on desktop
    let data_folder = get_jan_data_folder_path(app_handle);
    let path = get_thread_metadata_path(&data_folder, &thread_id);
    let lock = super::helpers::get_lock_for_thread(&thread_id).await;
    let _guard = lock.lock().await;
    if !path.exists() {
        return Err("Thread not found".to_string());
    }
    let mut thread: serde_json::Value = {
        let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&data).map_err(|e| e.to_string())?
    };
    let assistant_id = assistant
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("Missing id")?;
    if let Some(assistants) = thread
        .get_mut("assistants")
        .and_then(|a: &mut serde_json::Value| a.as_array_mut())
    {
        if let Some(index) = assistants
            .iter()
            .position(|a| a.get("id").and_then(|v| v.as_str()) == Some(assistant_id))
        {
            assistants[index] = assistant.clone();
            update_thread_metadata(&data_folder, &thread_id, &thread)?;
        }
    }
    Ok(assistant)
}
