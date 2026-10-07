//! File-backed thread and message writes shared by desktop commands and headless server.

use std::{fs, path::Path};

use serde_json::Value;
use uuid::Uuid;

use super::helpers::{
    append_message_line_if_new, get_lock_for_thread, read_messages_from_file,
    update_thread_metadata, write_file_atomically, write_messages_to_file,
};
use super::utils::{
    ensure_data_dirs, ensure_thread_dir_exists, get_messages_path, get_thread_dir,
    get_thread_metadata_path, validate_thread_id,
};

pub fn create_thread_in(root: &Path, mut thread: Value) -> Result<Value, String> {
    ensure_data_dirs(root)?;
    let id = Uuid::new_v4().to_string();
    thread["id"] = Value::String(id.clone());
    fs::create_dir_all(get_thread_dir(root, &id)).map_err(|e| e.to_string())?;
    let data = serde_json::to_vec_pretty(&thread).map_err(|e| e.to_string())?;
    write_file_atomically(&get_thread_metadata_path(root, &id), &data)?;
    Ok(thread)
}

pub fn modify_thread_in(root: &Path, thread: Value) -> Result<(), String> {
    let id = thread.get("id").and_then(Value::as_str).ok_or("Missing thread id")?;
    validate_thread_id(id)?;
    if !get_thread_dir(root, id).exists() {
        return Err("Thread directory does not exist".into());
    }
    let data = serde_json::to_vec_pretty(&thread).map_err(|e| e.to_string())?;
    write_file_atomically(&get_thread_metadata_path(root, id), &data)
}

pub async fn delete_thread_in(root: &Path, id: &str, permanent: bool) -> Result<(), String> {
    validate_thread_id(id)?;
    if !permanent && crate::core::archive::store::read_settings(root).enabled {
        let lock = get_lock_for_thread(id).await;
        let _guard = lock.lock().await;
        if !get_thread_dir(root, id).exists() {
            return Ok(());
        }
        let title = fs::read(get_thread_metadata_path(root, id))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.get("title").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_default();
        let root = root.to_path_buf();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || {
            crate::core::archive::store::archive_dir(
                &root, crate::core::archive::store::Kind::Thread, &id, &title, None,
            ).map(|_| ())
        }).await.map_err(|e| format!("archive task failed: {e}"))?
    } else {
        let thread_dir = get_thread_dir(root, id);
        if thread_dir.exists() {
            let _ = fs::remove_dir_all(thread_dir);
        }
        if let Err(e) = tauri_plugin_agent_tools::retention::delete_session(root, id) {
            log::warn!("could not remove request records for a deleted thread: {e}");
        }
        if let Some(scratch) = super::utils::thread_scratch_dir(id) {
            if let Err(e) = tokio::fs::remove_dir_all(&scratch).await {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("could not remove a deleted thread's scratch dir: {e}");
                }
            }
        }
        Ok(())
    }
}

pub async fn create_message_in(root: &Path, mut message: Value) -> Result<Value, String> {
    let id = message.get("thread_id").and_then(Value::as_str)
        .ok_or("Missing thread_id")?.to_owned();
    validate_thread_id(&id)?;
    if message.get("id").is_none() {
        message["id"] = Value::String(Uuid::new_v4().to_string());
    }
    let lock = get_lock_for_thread(&id).await;
    let _guard = lock.lock().await;
    ensure_thread_dir_exists(root, &id)?;
    let message_id = message.get("id").and_then(Value::as_str);
    append_message_line_if_new(&get_messages_path(root, &id), &message, message_id)?;
    Ok(message)
}

pub async fn modify_message_in(root: &Path, message: Value) -> Result<Value, String> {
    let thread_id = message.get("thread_id").and_then(Value::as_str)
        .ok_or("Missing thread_id")?;
    validate_thread_id(thread_id)?;
    let message_id = message.get("id").and_then(Value::as_str)
        .ok_or("Missing message id")?;
    let lock = get_lock_for_thread(thread_id).await;
    let _guard = lock.lock().await;
    let mut messages = read_messages_from_file(root, thread_id)?;
    if let Some(index) = messages.iter().position(|item| item.get("id").and_then(Value::as_str) == Some(message_id)) {
        messages[index] = message.clone();
    } else {
        ensure_thread_dir_exists(root, thread_id)?;
        messages.push(message.clone());
    }
    write_messages_to_file(&messages, &get_messages_path(root, thread_id))?;
    Ok(message)
}

pub async fn delete_message_in(root: &Path, thread_id: &str, message_id: &str) -> Result<(), String> {
    validate_thread_id(thread_id)?;
    let lock = get_lock_for_thread(thread_id).await;
    let _guard = lock.lock().await;
    let messages = read_messages_from_file(root, thread_id)?;
    let meta_path = get_thread_metadata_path(root, thread_id);
    if let Ok(raw) = fs::read_to_string(&meta_path) {
        if let Ok(mut thread) = serde_json::from_str::<Value>(&raw) {
            let change = super::branching::active_root_after_delete(
                &messages, message_id, super::branching::thread_active_root(&thread).as_deref(),
            );
            if super::branching::apply_active_root(&mut thread, change) {
                update_thread_metadata(root, thread_id, &thread)?;
            }
        }
    }
    let messages = super::branching::remove_message(messages, message_id);
    write_messages_to_file(&messages, &get_messages_path(root, thread_id))
}
