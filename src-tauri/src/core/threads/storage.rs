//! File-backed thread and message writes shared by desktop commands and headless server.

use std::{fs, path::Path};

use serde_json::Value;
use uuid::Uuid;

use super::helpers::{
    append_message_line_if_new, append_message_revision, get_lock_for_thread, preserve_bad_lines,
    read_messages_lossy, update_thread_metadata, write_file_atomically, write_messages_to_file,
    MAX_REVISIONS,
};
use super::utils::{
    ensure_data_dirs, ensure_thread_dir_exists, get_messages_path, get_thread_dir,
    get_thread_metadata_path, validate_thread_id,
};

pub fn create_thread_in(root: &Path, mut thread: Value) -> Result<Value, String> {
    // Indexing a non-object `Value` by key panics; a body of `"x"` or `[1]`
    // is a bad request, not a crash.
    if !thread.is_object() {
        return Err("a thread must be a JSON object".to_string());
    }
    ensure_data_dirs(root)?;
    let id = Uuid::new_v4().to_string();
    thread["id"] = Value::String(id.clone());
    let data = serde_json::to_vec_pretty(&thread).map_err(|e| e.to_string())?;
    let dir = get_thread_dir(root, &id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // A failed write must not leave an empty thread folder behind, which the
    // thread list would then show as a broken entry. The id is fresh, so the
    // folder holds nothing else.
    if let Err(e) = write_file_atomically(&get_thread_metadata_path(root, &id), &data) {
        let _ = fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(thread)
}

/// Write a thread's `thread.json` under its lock, so it cannot interleave with
/// the assistant commands that read-modify-write the same file.
pub async fn modify_thread_in(root: &Path, thread: Value) -> Result<(), String> {
    let id = thread.get("id").and_then(Value::as_str).ok_or("Missing thread id")?.to_owned();
    validate_thread_id(&id)?;
    let lock = get_lock_for_thread(&id).await;
    let _guard = lock.lock().await;
    modify_thread_unlocked(root, thread)
}

/// `modify_thread_in` without the in-process lock, for callers with no async
/// runtime (the CLI). The backend-owned `metadata.activeRootId` is taken from
/// disk, not from the caller's possibly stale copy.
pub fn modify_thread_unlocked(root: &Path, mut thread: Value) -> Result<(), String> {
    let id = thread.get("id").and_then(Value::as_str).ok_or("Missing thread id")?.to_owned();
    let id = id.as_str();
    validate_thread_id(id)?;
    if !get_thread_dir(root, id).exists() {
        return Err("Thread directory does not exist".into());
    }
    let on_disk = fs::read(get_thread_metadata_path(root, id))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    super::helpers::restore_summary_assistants(&mut thread, on_disk.as_ref());
    if let Some(disk) = on_disk {
        match super::branching::thread_active_root(&disk) {
            Some(root_id) if thread.get("metadata").map_or(true, |m| m.is_object() || m.is_null()) => {
                thread["metadata"]["activeRootId"] = Value::String(root_id);
            }
            Some(_) => {}
            None => {
                if let Some(meta) = thread.get_mut("metadata").and_then(Value::as_object_mut) {
                    meta.remove("activeRootId");
                }
            }
        }
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
        // Under the thread's lock: a message write in flight would otherwise
        // recreate the folder right after it is removed, leaving an orphan.
        let lock = get_lock_for_thread(id).await;
        let _guard = lock.lock().await;
        super::helpers::invalidate_append_cache(&get_messages_path(root, id));
        let thread_dir = get_thread_dir(root, id);
        // Unlist the thread first: with thread.json gone `list_threads` skips
        // the folder, so a removal that fails below cannot leave a thread that
        // looks alive.
        match fs::remove_file(get_thread_metadata_path(root, id)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("could not delete thread {id}: {e}")),
        }
        let dir_result = if thread_dir.exists() {
            tokio::task::spawn_blocking(move || remove_dir_all_retry(&thread_dir))
                .await
                .map_err(|e| format!("delete task failed: {e}"))?
        } else {
            Ok(())
        };
        // The attachments module is desktop-only (not in the CLI build).
        #[cfg(not(feature = "cli"))]
        crate::core::attachments::cleanup::remove_thread_data(root, id);
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
        dir_result.map_err(|e| format!("could not delete thread {id} folder: {e}"))
    }
}

/// `remove_dir_all` retried a few times: on Windows a file another process is
/// still closing (an indexer, antivirus) fails the first attempt.
fn remove_dir_all_retry(dir: &Path) -> std::io::Result<()> {
    let mut last = None;
    for attempt in 0..5 {
        match fs::remove_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => last = Some(e),
        }
        if attempt < 4 {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
    Err(last.expect("loop ran at least once"))
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
    ensure_thread_dir_exists(root, thread_id)?;
    let path = get_messages_path(root, thread_id);
    // An update is one appended revision line, not a rewrite of the whole
    // file: readers fold it onto the message (or add it, for a new id).
    let revisions = append_message_revision(&path, &message, message_id)?;
    // Compact once enough revisions piled up, or when this process does not
    // know how many there are (another writer touched the file).
    if revisions.is_none_or(|n| n >= MAX_REVISIONS) {
        compact_messages_unlocked(root, thread_id)?;
    }
    Ok(message)
}

/// Rewrite a thread's messages file with its revisions folded in, if it
/// carries any. Callers hold the thread's lock.
pub fn compact_messages_unlocked(root: &Path, thread_id: &str) -> Result<(), String> {
    let read = read_messages_lossy(root, thread_id)?;
    let path = get_messages_path(root, thread_id);
    if read.revisions == 0 {
        super::helpers::remember_compacted(&path, &read.messages);
        return Ok(());
    }
    preserve_bad_lines(root, thread_id, &read.bad_lines)?;
    write_messages_to_file(&read.messages, &path)?;
    super::helpers::remember_compacted(&path, &read.messages);
    Ok(())
}

pub async fn delete_message_in(root: &Path, thread_id: &str, message_id: &str) -> Result<(), String> {
    validate_thread_id(thread_id)?;
    let lock = get_lock_for_thread(thread_id).await;
    let _guard = lock.lock().await;
    let read = read_messages_lossy(root, thread_id)?;
    let messages = read.messages;
    preserve_bad_lines(root, thread_id, &read.bad_lines)?;
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

#[cfg(test)]
mod create_tests {
    use super::*;

    #[test]
    fn a_thread_that_is_not_an_object_is_refused_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        for body in [serde_json::json!("x"), serde_json::json!([1]), Value::Null] {
            assert!(create_thread_in(dir.path(), body).is_err());
        }
        let made = create_thread_in(dir.path(), serde_json::json!({"title": "t"})).unwrap();
        assert!(made["id"].is_string());
    }
}

#[cfg(test)]
mod revision_tests {
    use super::*;
    use serde_json::json;

    fn root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("jan_revisions_{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn lines(root: &Path, thread: &str) -> usize {
        fs::read_to_string(get_messages_path(root, thread)).unwrap().lines().count()
    }

    #[tokio::test]
    async fn updates_append_revisions_that_fold_and_compact_once() {
        let root = root();
        let thread = "t-revisions";
        let msg = |id: &str, text: &str| json!({"id": id, "thread_id": thread, "role": "assistant", "content": text});
        create_message_in(&root, msg("a", "first")).await.unwrap();
        create_message_in(&root, msg("b", "second")).await.unwrap();
        // The first update after the process learned the file appends one line.
        for i in 0..(MAX_REVISIONS - 1) {
            modify_message_in(&root, msg("a", &format!("rev {i}"))).await.unwrap();
        }
        assert_eq!(lines(&root, thread), 2 + MAX_REVISIONS - 1, "updates append, never rewrite");
        let read = read_messages_lossy(&root, thread).unwrap();
        assert_eq!(read.revisions, MAX_REVISIONS - 1);
        assert_eq!(read.messages.len(), 2);
        assert_eq!(read.messages[0]["content"], format!("rev {}", MAX_REVISIONS - 2));
        assert_eq!(read.messages[1]["content"], "second", "order is where a message first appeared");

        // One more reaches the bound: exactly one compaction.
        modify_message_in(&root, msg("a", "final")).await.unwrap();
        assert_eq!(lines(&root, thread), 2);
        let folded = super::super::helpers::read_messages_from_file(&root, thread).unwrap();
        assert_eq!(folded[0]["content"], "final");

        // A new id through modify is added, and a delete still works.
        modify_message_in(&root, msg("c", "new")).await.unwrap();
        delete_message_in(&root, thread, "a").await.unwrap();
        let after = read_messages_lossy(&root, thread).unwrap();
        let ids: Vec<&str> = after.messages.iter().map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["b", "c"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_file_changed_by_another_writer_is_compacted_on_update() {
        let root = root();
        let thread = "t-foreign";
        let msg = |id: &str, text: &str| json!({"id": id, "thread_id": thread, "role": "user", "content": text});
        create_message_in(&root, msg("a", "one")).await.unwrap();
        // Another process appends a revision this one never saw.
        let path = get_messages_path(&root, thread);
        let mut raw = fs::read_to_string(&path).unwrap();
        raw.push_str(&format!("{}\n", msg("a", "two")));
        fs::write(&path, raw).unwrap();
        modify_message_in(&root, msg("a", "three")).await.unwrap();
        assert_eq!(lines(&root, thread), 1);
        assert_eq!(read_messages_lossy(&root, thread).unwrap().messages[0]["content"], "three");
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod summary_write_tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn a_write_with_a_summary_assistant_keeps_the_stored_instructions() {
        let dir = tempfile::tempdir().unwrap();
        let made = create_thread_in(dir.path(), json!({"title": "t", "assistants": [
            {"id": "a", "name": "A", "model": {"id": "m1"}, "instructions": "be brief", "parameters": {"temperature": 0.2}}
        ]})).unwrap();
        let id = made["id"].as_str().unwrap().to_owned();
        modify_thread_in(dir.path(), json!({"id": id, "title": "renamed", "assistants": [
            {"id": "a", "name": "A", "model": {"id": "m2"}, "summary": true}
        ]})).await.unwrap();
        let disk: Value = serde_json::from_slice(&fs::read(get_thread_metadata_path(dir.path(), &id)).unwrap()).unwrap();
        let a = &disk["assistants"][0];
        assert_eq!(disk["title"], "renamed");
        assert_eq!(a["instructions"], "be brief");
        assert_eq!(a["parameters"]["temperature"], 0.2);
        assert_eq!(a["model"]["id"], "m2");
        assert!(a.get("summary").is_none());
    }

    #[tokio::test]
    async fn a_full_assistant_write_replaces_the_stored_one() {
        let dir = tempfile::tempdir().unwrap();
        let made = create_thread_in(dir.path(), json!({"assistants": [{"id": "a", "instructions": "old"}]})).unwrap();
        let id = made["id"].as_str().unwrap().to_owned();
        modify_thread_in(dir.path(), json!({"id": id, "assistants": [{"id": "a", "instructions": "new"}]})).await.unwrap();
        let disk: Value = serde_json::from_slice(&fs::read(get_thread_metadata_path(dir.path(), &id)).unwrap()).unwrap();
        assert_eq!(disk["assistants"][0]["instructions"], "new");
    }
}
