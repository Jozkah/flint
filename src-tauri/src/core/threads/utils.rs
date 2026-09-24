use std::fs;
use std::path::{Path, PathBuf};

use super::constants::{MESSAGES_FILE, THREADS_DIR, THREADS_FILE};

pub fn get_data_dir(data_folder: &Path) -> PathBuf {
    data_folder.join(THREADS_DIR)
}

/// Refuse a thread id that is not one plain path component.
///
/// Every thread and message command joins the caller's id onto the threads
/// directory, and `delete_thread` then removes what it names recursively. An
/// id is only ever a name `create_thread` (or the CLI) chose, so anything that
/// could step out of that directory -- `..`, a separator, a drive or an
/// absolute path -- is refused before the filesystem is touched
/// (Jozkah/jan#35).
pub fn validate_thread_id(thread_id: &str) -> Result<(), String> {
    use std::path::Component;
    let plain = !thread_id.is_empty()
        && !thread_id.contains(['/', '\\', ':', '\0'])
        && matches!(
            Path::new(thread_id).components().collect::<Vec<_>>().as_slice(),
            [Component::Normal(name)] if *name == std::ffi::OsStr::new(thread_id)
        );
    if plain {
        Ok(())
    } else {
        Err(format!("invalid thread id {thread_id:?}"))
    }
}

pub fn get_thread_dir(data_folder: &Path, thread_id: &str) -> PathBuf {
    get_data_dir(data_folder).join(thread_id)
}

pub fn get_thread_metadata_path(data_folder: &Path, thread_id: &str) -> PathBuf {
    get_thread_dir(data_folder, thread_id).join(THREADS_FILE)
}

pub fn get_messages_path(data_folder: &Path, thread_id: &str) -> PathBuf {
    get_thread_dir(data_folder, thread_id).join(MESSAGES_FILE)
}

pub fn ensure_data_dirs(data_folder: &Path) -> Result<(), String> {
    let data_dir = get_data_dir(data_folder);
    if !data_dir.exists() {
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn ensure_thread_dir_exists(data_folder: &Path, thread_id: &str) -> Result<(), String> {
    ensure_data_dirs(data_folder)?;
    let thread_dir = get_thread_dir(data_folder, thread_id);
    if !thread_dir.exists() {
        fs::create_dir_all(&thread_dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
