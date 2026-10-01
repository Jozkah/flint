use std::fs;
use tauri::Runtime;
use uuid::Uuid;

#[cfg(any(target_os = "android", target_os = "ios"))]
use super::db;
use super::helpers::{
    append_message_line_if_new, get_lock_for_thread, read_messages_from_file, should_use_sqlite,
    update_thread_metadata, write_file_atomically, write_messages_to_file,
};
use super::{
    constants::THREADS_FILE,
    utils::{
        ensure_data_dirs, ensure_thread_dir_exists, get_data_dir, get_messages_path,
        get_thread_dir, get_thread_metadata_path, validate_thread_id,
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

    // Use file-based storage on desktop
    let data_folder = get_jan_data_folder_path(app_handle);
    ensure_data_dirs(&data_folder)?;
    let data_dir = get_data_dir(&data_folder);
    let mut threads = Vec::new();

    if !data_dir.exists() {
        return Ok(threads);
    }

    for entry in fs::read_dir(&data_dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if path.is_dir() {
            let thread_metadata_path = path.join(THREADS_FILE);
            if thread_metadata_path.exists() {
                // One thread that cannot be read (deleted between the check
                // and the read, locked, permission denied) must not hide
                // every other thread: skip it like an unparsable one.
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
                match serde_json::from_str(&data) {
                    Ok(thread) => threads.push(thread),
                    Err(e) => {
                        println!("Failed to parse thread file: {e}");
                        continue; // skip invalid thread files
                    }
                }
            }
        }
    }

    Ok(threads)
}

/// Creates a new thread, assigns it a unique ID, and persists its metadata.
/// Ensures the thread directory exists and writes thread.json.
#[tauri::command]
pub async fn create_thread<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    mut thread: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if should_use_sqlite() {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        return db::db_create_thread(app_handle, thread).await;
    }

    // Use file-based storage on desktop
    let data_folder = get_jan_data_folder_path(app_handle);
    ensure_data_dirs(&data_folder)?;
    let uuid = Uuid::new_v4().to_string();
    thread["id"] = serde_json::Value::String(uuid.clone());
    let thread_dir = get_thread_dir(&data_folder, &uuid);
    if !thread_dir.exists() {
        fs::create_dir_all(&thread_dir).map_err(|e| e.to_string())?;
    }
    let path = get_thread_metadata_path(&data_folder, &uuid);
    let data = serde_json::to_string_pretty(&thread).map_err(|e| e.to_string())?;
    write_file_atomically(&path, data.as_bytes())?;
    Ok(thread)
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
    let thread_id = thread
        .get("id")
        .and_then(|id| id.as_str())
        .ok_or("Missing thread id")?;
    validate_thread_id(thread_id)?;
    let thread_dir = get_thread_dir(&data_folder, thread_id);
    if !thread_dir.exists() {
        return Err("Thread directory does not exist".to_string());
    }
    let path = get_thread_metadata_path(&data_folder, thread_id);
    let data = serde_json::to_string_pretty(&thread).map_err(|e| e.to_string())?;
    write_file_atomically(&path, data.as_bytes())?;
    Ok(())
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
    if crate::core::archive::store::read_settings(&data_folder).enabled {
        return archive_thread_files(&data_folder, &thread_id).await;
    }
    remove_thread_files(&data_folder, &thread_id).await
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
    remove_thread_files(&data_folder, &thread_id).await
}

/// Move a thread directory into the archive. A thread that is already gone is
/// not an error (a delete of nothing has always been fine); a thread that
/// cannot be archived is, so a failed attempt to keep it never destroys it. The
/// per-thread lock keeps a message append from landing mid-move.
async fn archive_thread_files(
    data_folder: &std::path::Path,
    thread_id: &str,
) -> Result<(), String> {
    let lock = get_lock_for_thread(thread_id).await;
    let _guard = lock.lock().await;
    if !get_thread_dir(data_folder, thread_id).exists() {
        return Ok(());
    }
    let title = fs::read(get_thread_metadata_path(data_folder, thread_id))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|v| v.get("title").and_then(|t| t.as_str()).map(str::to_owned))
        .unwrap_or_default();
    let data = data_folder.to_path_buf();
    let id = thread_id.to_string();
    tokio::task::spawn_blocking(move || {
        crate::core::archive::store::archive_dir(
            &data,
            crate::core::archive::store::Kind::Thread,
            &id,
            &title,
            None,
        )
        .map(|_| ())
    })
    .await
    .map_err(|e| format!("archive task failed: {e}"))?
}

/// The old delete: remove the directory, then what was recorded about it.
async fn remove_thread_files(
    data_folder: &std::path::Path,
    thread_id: &str,
) -> Result<(), String> {
    let thread_dir = get_thread_dir(data_folder, thread_id);
    if thread_dir.exists() {
        let _ = fs::remove_dir_all(thread_dir);
    }
    // The sanitized copies of what this conversation sent, and the provider's
    // counts for them, go with it. Best effort, like the directory removal
    // above: a log that cannot be rewritten right now must not stop the thread
    // being deleted, and startup compaction still bounds what is left.
    if let Err(e) = tauri_plugin_agent_tools::retention::delete_session(data_folder, thread_id) {
        log::warn!("could not remove request records for a deleted thread: {e}");
    }
    // The thread's agent scratch dir in the OS temp folder is ours to remove
    // too (workspace::ensure_scratch_dir assigns its teardown to thread
    // deletion on the desktop); without this it leaked until a restart sweep
    // (Jozkah/jan#186).
    if let Some(scratch) = super::utils::thread_scratch_dir(thread_id) {
        if let Err(e) = tokio::fs::remove_dir_all(&scratch).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("could not remove a deleted thread's scratch dir: {e}");
            }
        }
    }
    Ok(())
}

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
    read_messages_from_file(&data_folder, &thread_id)
}

/// Appends a new message to a thread's messages.jsonl file.
/// Uses a per-thread async lock to prevent race conditions and ensure file consistency.
#[tauri::command]
pub async fn create_message<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    mut message: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if should_use_sqlite() {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        return db::db_create_message(app_handle, message).await;
    }

    // Use file-based storage on desktop
    let data_folder = get_jan_data_folder_path(app_handle);
    let thread_id = {
        let id = message
            .get("thread_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing thread_id")?;
        id.to_string()
    };
    validate_thread_id(&thread_id)?;
    let path = get_messages_path(&data_folder, &thread_id);

    if message.get("id").is_none() {
        let uuid = Uuid::new_v4().to_string();
        message["id"] = serde_json::Value::String(uuid);
    }

    // Acquire per-thread lock before writing
    {
        let lock = get_lock_for_thread(&thread_id).await;
        let _guard = lock.lock().await;

        // Ensure directory exists right before file operations to handle race conditions
        ensure_thread_dir_exists(&data_folder, &thread_id)?;

        // Dedupe against a modify_message upsert that landed first, and settle
        // a torn tail an earlier interrupted write left so this message is not
        // glued onto it (janhq/jan#8019) - from one read of the file.
        let message_id = message
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        append_message_line_if_new(&path, &message, message_id.as_deref())?;
    }

    Ok(message)
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
    let thread_id = message
        .get("thread_id")
        .and_then(|v| v.as_str())
        .ok_or("Missing thread_id")?;
    validate_thread_id(thread_id)?;
    let message_id = message
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("Missing message id")?;

    // Acquire per-thread lock before modifying
    {
        let lock = get_lock_for_thread(thread_id).await;
        let _guard = lock.lock().await;

        let mut messages = read_messages_from_file(&data_folder, thread_id)?;
        match messages
            .iter()
            .position(|m| m.get("id").and_then(|v| v.as_str()) == Some(message_id))
        {
            Some(index) => {
                messages[index] = message.clone();
            }
            // Upsert when create_message lost the lock race; its dedupe path
            // reconciles a subsequent late create.
            None => {
                ensure_thread_dir_exists(&data_folder, thread_id)?;
                messages.push(message.clone());
            }
        }

        let path = get_messages_path(&data_folder, thread_id);
        write_messages_to_file(&messages, &path)?;
    }
    Ok(message)
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
    // Acquire per-thread lock before modifying
    {
        let lock = get_lock_for_thread(&thread_id).await;
        let _guard = lock.lock().await;

        // Out of the tree without cutting off what hangs below it (the TS
        // `removeFromTree`): children move up to the deleted message's parent.
        let messages = read_messages_from_file(&data_folder, &thread_id)?;
        // A deleted root that the thread had selected hands the selection to
        // the root that replaces it.
        let meta_path = get_thread_metadata_path(&data_folder, &thread_id);
        if let Ok(raw) = fs::read_to_string(&meta_path) {
            if let Ok(mut thread) = serde_json::from_str::<serde_json::Value>(&raw) {
                let change = super::branching::active_root_after_delete(
                    &messages,
                    &message_id,
                    super::branching::thread_active_root(&thread).as_deref(),
                );
                if super::branching::apply_active_root(&mut thread, change) {
                    update_thread_metadata(&data_folder, &thread_id, &thread)?;
                }
            }
        }
        let messages = super::branching::remove_message(messages, &message_id);

        // Rewrite remaining messages
        let path = get_messages_path(&data_folder, &thread_id);
        write_messages_to_file(&messages, &path)?;
    }

    Ok(())
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
    if !path.exists() {
        return Err("Thread not found".to_string());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
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
