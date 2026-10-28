//! What a permanently deleted thread leaves behind besides its own folder:
//! the files attached to it and its document index.
//!
//! Only the folder and database named after the thread id are touched.
//! Attachments saved without a thread id live in `attachments/<random id>/`
//! and are never removed here, and project indexes (`project_<id>`) are not
//! a thread's to delete.
use super::commands::ATTACHMENTS_DIR;
use crate::core::threads::utils::validate_thread_id;
use std::fs;
use std::path::Path;

/// Remove `attachments/<thread id>/` under the data folder.
pub fn remove_thread_attachments(data: &Path, thread_id: &str) -> Result<(), String> {
    validate_thread_id(thread_id)?;
    match fs::remove_dir_all(data.join(ATTACHMENTS_DIR).join(thread_id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Remove the thread's `attachments_<thread id>` document index from the
/// vector-db folder `base`.
pub fn remove_thread_rag_db_in(base: &Path, thread_id: &str) -> Result<(), String> {
    validate_thread_id(thread_id)?;
    tauri_plugin_vector_db::db::delete_collection_files(base, &format!("attachments_{thread_id}"))
        .map_err(|e| e.to_string())
}

/// Both removals, warning instead of failing: the thread itself is already
/// gone and a locked file must not turn that into an error.
pub fn remove_thread_data(data: &Path, thread_id: &str) {
    if let Err(e) = remove_thread_attachments(data, thread_id) {
        log::warn!("could not remove attachments of deleted thread {thread_id}: {e}");
    }
    let base = tauri_plugin_vector_db::db::default_base_dir();
    if let Err(e) = remove_thread_rag_db_in(&base, thread_id) {
        log::warn!("could not remove document index of deleted thread {thread_id}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_only_the_thread_attachment_folder() {
        let dir = tempfile::tempdir().unwrap();
        let att = dir.path().join(ATTACHMENTS_DIR);
        fs::create_dir_all(att.join("t1").join("u1")).unwrap();
        fs::write(att.join("t1").join("u1").join("a.txt"), "x").unwrap();
        fs::create_dir_all(att.join("t2")).unwrap();
        fs::create_dir_all(att.join("legacy-uuid")).unwrap();

        remove_thread_attachments(dir.path(), "t1").unwrap();

        assert!(!att.join("t1").exists());
        assert!(att.join("t2").exists());
        assert!(att.join("legacy-uuid").exists());
        // Already gone is fine, a traversal id is refused.
        remove_thread_attachments(dir.path(), "t1").unwrap();
        assert!(remove_thread_attachments(dir.path(), "..").is_err());
    }

    #[test]
    fn removes_the_thread_rag_db_but_not_a_project_db() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "attachments_t1.db",
            "attachments_t1.db-wal",
            "attachments_t1.db-shm",
            "attachments_t2.db",
            "project_t1.db",
        ] {
            fs::write(dir.path().join(name), "x").unwrap();
        }

        remove_thread_rag_db_in(dir.path(), "t1").unwrap();

        assert!(!dir.path().join("attachments_t1.db").exists());
        assert!(!dir.path().join("attachments_t1.db-wal").exists());
        assert!(!dir.path().join("attachments_t1.db-shm").exists());
        assert!(dir.path().join("attachments_t2.db").exists());
        assert!(dir.path().join("project_t1.db").exists());
    }
}
