//! Commands the app uses to ask about and change which project folders are
//! trusted to run their own hooks and subagent definitions. The rules live in
//! `tauri_plugin_agent_tools::folder_trust`; this is only the doorway.

use std::path::Path;

use serde::Serialize;
use tauri_plugin_agent_tools::folder_trust::{self, Carries};

/// What the app needs to know to decide whether to ask about a folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTrust {
    /// The folder as asked about.
    pub folder: String,
    /// Whether it may run its own code: trusted, or trust is not enforced.
    pub trusted: bool,
    /// What the folder carries that trust would turn on.
    pub carries: Carries,
}

fn status_of(folder: &str) -> Result<FolderTrust, String> {
    if folder.trim().is_empty() {
        return Err("no folder given".to_string());
    }
    let path = Path::new(folder);
    Ok(FolderTrust {
        folder: folder.to_string(),
        trusted: folder_trust::is_trusted(path),
        carries: folder_trust::carries(path),
    })
}

/// Whether `folder` is trusted, and what it carries.
#[tauri::command]
pub async fn folder_trust_status(folder: String) -> Result<FolderTrust, String> {
    tauri::async_runtime::spawn_blocking(move || status_of(&folder))
        .await
        .map_err(|e| e.to_string())?
}

/// Trust `folder` for good. Only the user's own action in the app calls this;
/// nothing the model writes can reach it.
#[tauri::command]
pub async fn folder_trust_grant(folder: String) -> Result<FolderTrust, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if folder.trim().is_empty() {
            return Err("no folder given".to_string());
        }
        if !Path::new(&folder).is_dir() {
            return Err(format!("{folder} is not a folder"));
        }
        folder_trust::trust(Path::new(&folder))?;
        status_of(&folder)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stop trusting `folder`.
#[tauri::command]
pub async fn folder_trust_revoke(folder: String) -> Result<FolderTrust, String> {
    tauri::async_runtime::spawn_blocking(move || {
        folder_trust::revoke(Path::new(&folder))?;
        status_of(&folder)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The first-run migration: trust the folders the app's own history shows the
/// user already works in, once. The renderer supplies them from the user's
/// sessions and chats, never from a repository. Returns the folders trusted.
#[tauri::command]
pub async fn folder_trust_grandfather(folders: Vec<String>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        folder_trust::grandfather(folders.into_iter().map(std::path::PathBuf::from))
    })
    .await
    .unwrap_or_default()
}

/// Every trusted folder.
#[tauri::command]
pub async fn folder_trust_list() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(folder_trust::list)
        .await
        .unwrap_or_default()
}
