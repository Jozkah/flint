//! Saving files the user attaches by dragging them onto the chat.
//!
//! The webview's drop event hands the frontend file contents but no path on
//! disk, while document attachments are read (parsed, ingested) from a path.
//! This writes a dropped file into the data folder so it can be attached the
//! same way as a file picked with the dialog. It only ever writes under
//! `<data folder>/attachments/<random id>/`, and refuses oversized payloads.
use crate::core::app::commands::get_jan_data_folder_path;
use base64::Engine;
use std::fs;
use tauri::Runtime;

/// Folder, relative to the data folder, that holds saved attachments.
pub const ATTACHMENTS_DIR: &str = "attachments";

/// Largest dropped file accepted, in bytes. Matches the 200MB the document
/// parsers refuse beyond, so nothing is saved that could not be read back.
pub const MAX_ATTACHMENT_BYTES: usize = 200 * 1024 * 1024;

/// Longest file name kept, in characters; the extension is preserved.
const MAX_NAME_CHARS: usize = 150;

/// Device names Windows reserves, with or without an extension.
const WINDOWS_RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// The file name to save `raw` under: directories are dropped so the file can
/// only land in its own attachment folder, characters Windows forbids are
/// replaced, and names Windows would treat as devices or trim are made plain.
pub fn attachment_file_name(raw: &str) -> Result<String, String> {
    let name = raw.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    if name.is_empty() || name.chars().all(|c| c == '.') {
        return Err(format!(
            "save_attachment_file error: no file name in {raw:?}"
        ));
    }
    let mut name: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    // Windows silently drops trailing dots and spaces, which would alias names.
    name = name.trim_end_matches(['.', ' ']).to_string();
    if name.is_empty() {
        return Err(format!(
            "save_attachment_file error: no file name in {raw:?}"
        ));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        let ext = name
            .rfind('.')
            .map(|i| name[i..].to_string())
            .filter(|e| e.chars().count() <= 20)
            .unwrap_or_default();
        let keep = MAX_NAME_CHARS - ext.chars().count();
        name = name.chars().take(keep).collect::<String>() + &ext;
    }
    let stem = name.split('.').next().unwrap_or_default().to_uppercase();
    if WINDOWS_RESERVED.contains(&stem.as_str()) {
        name = format!("_{name}");
    }
    Ok(name)
}

/// Writes a dropped file (base64-encoded) into its own folder under the
/// attachments folder and returns the saved file's path. Async, with the
/// decode and write on a blocking thread: a sync command runs on the main
/// thread, and decoding a 200MB payload there froze the window.
#[tauri::command]
pub async fn save_attachment_file<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    file_name: String,
    data_base64: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_attachment_file_blocking(app_handle, file_name, data_base64)
    })
    .await
    .map_err(|e| format!("save_attachment_file error: {e}"))?
}

pub(crate) fn save_attachment_file_blocking<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    file_name: String,
    data_base64: String,
) -> Result<String, String> {
    let name = attachment_file_name(&file_name)?;
    // Reject on the encoded length first so an oversized payload is never decoded.
    if data_base64.len() / 4 * 3 > MAX_ATTACHMENT_BYTES + 3 {
        return Err("save_attachment_file error: file too large (max 200MB)".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("save_attachment_file error: invalid data: {e}"))?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err("save_attachment_file error: file too large (max 200MB)".to_string());
    }

    let folder = get_jan_data_folder_path(app_handle)
        .join(ATTACHMENTS_DIR)
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&folder).map_err(|e| format!("save_attachment_file error: {e}"))?;

    let path = folder.join(name);
    // The name was reduced to a bare file name above; confirm it did not end up
    // anywhere but directly inside the attachment folder.
    if path.parent() != Some(folder.as_path()) {
        let _ = fs::remove_dir_all(&folder);
        return Err("save_attachment_file error: invalid file name".to_string());
    }
    if let Err(e) = fs::write(&path, bytes) {
        let _ = fs::remove_dir_all(&folder);
        return Err(format!("save_attachment_file error: {e}"));
    }
    Ok(path.to_string_lossy().into_owned())
}
