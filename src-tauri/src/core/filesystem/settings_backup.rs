//! Save and load a settings backup file where the user chooses.
//!
//! Like `export_file`, the renderer never supplies a path: it sends the content
//! (or asks for it) and this module opens the native dialog itself, so neither
//! command is a read- or write-anywhere primitive. Unlike `export_file`, the
//! content is NOT credential-redacted: the user may have ticked "include API
//! keys", and redaction would silently corrupt the backup. The renderer decides
//! what goes in; this side only moves bytes.

use std::path::PathBuf;

/// Largest backup accepted either way. Settings blobs are kilobytes.
pub const MAX_BACKUP_BYTES: usize = 10 * 1024 * 1024;

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BackupSaveReport {
    pub path: String,
}

async fn pick_save_path(file_name: &str) -> Option<PathBuf> {
    rfd::AsyncFileDialog::new()
        .add_filter("JSON", &["json"])
        .set_file_name(file_name)
        .save_file()
        .await
        .map(|f| f.path().to_path_buf())
}

async fn pick_open_path() -> Option<PathBuf> {
    rfd::AsyncFileDialog::new()
        .add_filter("JSON", &["json"])
        .pick_file()
        .await
        .map(|f| f.path().to_path_buf())
}

/// Save a settings backup to a file the user picks. `None` means cancelled.
#[tauri::command]
pub async fn settings_backup_save(
    suggested_name: String,
    text: String,
) -> Result<Option<BackupSaveReport>, String> {
    if text.len() > MAX_BACKUP_BYTES {
        return Err("the settings backup is larger than 10 MB".to_string());
    }
    let name = super::export_file::sanitize_file_name(&suggested_name, "json");
    let Some(mut path) = pick_save_path(&name).await else {
        return Ok(None);
    };
    if path.extension().is_none() {
        path.set_extension("json");
    }
    super::export_file::write_atomically(&path, text.as_bytes())?;
    Ok(Some(BackupSaveReport {
        path: path.to_string_lossy().to_string(),
    }))
}

/// Read a settings backup from a file the user picks. `None` means cancelled.
#[tauri::command]
pub async fn settings_backup_load() -> Result<Option<String>, String> {
    let Some(path) = pick_open_path().await else {
        return Ok(None);
    };
    read_backup(&path).map(Some)
}

fn read_backup(path: &std::path::Path) -> Result<String, String> {
    let len = std::fs::metadata(path)
        .map_err(|e| format!("could not read the backup: {e}"))?
        .len();
    if len > MAX_BACKUP_BYTES as u64 {
        return Err("the file is larger than 10 MB, so it is not a settings backup".to_string());
    }
    std::fs::read_to_string(path).map_err(|e| format!("could not read the backup: {e}"))
}

/// Write a provider's API key chain to the OS keyring (encrypted-file fallback).
/// Used when importing a backup that carries keys; an empty list deletes.
#[tauri::command]
pub async fn settings_backup_store_provider_keys(
    provider: String,
    keys: Vec<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::core::server::provider_secrets::store_provider_keys(&provider, &keys)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_normal_file_is_read_back_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.json");
        std::fs::write(&path, "{\"a\":1}").unwrap();
        assert_eq!(read_backup(&path).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn an_oversized_file_is_refused_before_reading() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.json");
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(MAX_BACKUP_BYTES as u64 + 1).unwrap();
        assert!(read_backup(&path).unwrap_err().contains("10 MB"));
    }

    #[test]
    fn a_missing_file_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_backup(&dir.path().join("nope.json")).is_err());
    }
}
