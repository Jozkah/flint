//! Read-only domain access to Flint's durable desktop conversations.
//!
//! The browser receives JSON values from the same thread store as the CLI.
//! IDs are validated before joining them to the data directory.

use std::path::Path;

use serde_json::Value;

use crate::core::cli::{cli_get_thread_in, cli_list_messages_in, list_threads_in};
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
