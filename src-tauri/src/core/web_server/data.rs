//! Read-only domain access to Flint's durable desktop conversations.
//!
//! The browser receives JSON values from the same thread store as the CLI.
//! IDs are validated before joining them to the data directory.

use std::path::Path;

use serde_json::Value;

use crate::core::cli::{cli_get_thread_in, cli_list_messages_in, list_threads_in};
use crate::core::threads::storage;
use crate::core::threads::utils::validate_thread_id;

pub fn threads(root: &Path) -> Result<Vec<Value>, String> {
    list_threads_in(root)
}

pub fn thread(root: &Path, id: &str) -> Result<Value, String> {
    validate_thread_id(id)?;
    cli_get_thread_in(root, id)
}

pub fn messages(root: &Path, id: &str) -> Result<Vec<Value>, String> {
    validate_thread_id(id)?;
    cli_list_messages_in(root, id)
}

pub fn create_thread(root: &Path, thread: Value) -> Result<Value, String> {
    storage::create_thread_in(root, thread)
}

pub fn update_thread(root: &Path, id: &str, thread: Value) -> Result<(), String> {
    validate_thread_id(id)?;
    if thread.get("id").and_then(Value::as_str) != Some(id) {
        return Err("Thread id does not match URL".into());
    }
    storage::modify_thread_in(root, thread)
}

pub async fn delete_thread(root: &Path, id: &str, permanent: bool) -> Result<(), String> {
    storage::delete_thread_in(root, id, permanent).await
}

pub async fn create_message(root: &Path, id: &str, message: Value) -> Result<Value, String> {
    validate_thread_id(id)?;
    thread(root, id)?;
    if message.get("thread_id").and_then(Value::as_str) != Some(id) {
        return Err("Message thread id does not match URL".into());
    }
    storage::create_message_in(root, message).await
}

pub async fn update_message(root: &Path, thread_id: &str, message_id: &str, message: Value) -> Result<Value, String> {
    validate_thread_id(thread_id)?;
    validate_thread_id(message_id)?;
    thread(root, thread_id)?;
    if message.get("thread_id").and_then(Value::as_str) != Some(thread_id)
        || message.get("id").and_then(Value::as_str) != Some(message_id)
    {
        return Err("Message id does not match URL".into());
    }
    storage::modify_message_in(root, message).await
}

pub async fn delete_message(root: &Path, thread_id: &str, message_id: &str) -> Result<(), String> {
    validate_thread_id(thread_id)?;
    validate_thread_id(message_id)?;
    thread(root, thread_id)?;
    storage::delete_message_in(root, thread_id, message_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_desktop_threads_without_crossing_data_root() {
        let dir = tempfile::tempdir().unwrap();
        let thread_dir = dir.path().join("threads").join("one");
        std::fs::create_dir_all(&thread_dir).unwrap();
        std::fs::write(
            thread_dir.join("thread.json"),
            r#"{"id":"one","title":"Hello"}"#,
        )
        .unwrap();
        std::fs::write(
            thread_dir.join("messages.jsonl"),
            "{\"id\":\"m1\",\"thread_id\":\"one\"}\n",
        )
        .unwrap();

        assert_eq!(threads(dir.path()).unwrap().len(), 1);
        assert_eq!(thread(dir.path(), "one").unwrap()["title"], "Hello");
        assert_eq!(messages(dir.path(), "one").unwrap().len(), 1);
        assert!(thread(dir.path(), "../outside").is_err());
        assert!(messages(dir.path(), "../outside").is_err());
    }

    #[tokio::test]
    async fn browser_mutations_share_desktop_thread_store() {
        let dir = tempfile::tempdir().unwrap();
        let created = create_thread(dir.path(), json!({"title":"First"})).unwrap();
        let id = created["id"].as_str().unwrap();
        assert_eq!(threads(dir.path()).unwrap().len(), 1);
        assert_eq!(thread(dir.path(), id).unwrap()["title"], "First");

        assert!(update_thread(dir.path(), id, json!({"id":"another","title":"Wrong"})).is_err());
        update_thread(dir.path(), id, json!({"id":id,"title":"Updated"})).unwrap();
        assert_eq!(thread(dir.path(), id).unwrap()["title"], "Updated");

        assert!(create_message(dir.path(), id, json!({"thread_id":"another"})).await.is_err());
        let message = create_message(dir.path(), id, json!({"thread_id":id,"role":"user","content":"hi"})).await.unwrap();
        let message_id = message["id"].as_str().unwrap();
        assert_eq!(messages(dir.path(), id).unwrap().len(), 1);
        update_message(dir.path(), id, message_id, json!({"thread_id":id,"id":message_id,"role":"user","content":"hello"})).await.unwrap();
        assert_eq!(messages(dir.path(), id).unwrap()[0]["content"], "hello");
        delete_message(dir.path(), id, message_id).await.unwrap();
        assert!(messages(dir.path(), id).unwrap().is_empty());
        delete_thread(dir.path(), id, true).await.unwrap();
        assert!(threads(dir.path()).unwrap().is_empty());
    }
}
