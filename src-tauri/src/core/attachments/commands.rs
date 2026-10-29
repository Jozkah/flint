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
        name = name.chars().take(keep).collect::<String>() + ext.as_str();
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
///
/// With `thread_id` the file is saved under `attachments/<thread id>/<random
/// id>/` so deleting that thread can remove it; without one it keeps the
/// legacy `attachments/<random id>/` location.
#[tauri::command]
pub async fn save_attachment_file<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    file_name: String,
    data_base64: String,
    thread_id: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_attachment_in(app_handle, file_name, data_base64, thread_id)
    })
    .await
    .map_err(|e| format!("save_attachment_file error: {e}"))?
}

/// Header carrying the percent-encoded file name of a raw-body save.
pub const NAME_HEADER: &str = "x-flint-file-name";
/// Header carrying the thread id of a raw-body save (optional).
pub const THREAD_HEADER: &str = "x-flint-thread-id";

/// [`save_attachment_file`] with the file's bytes as the raw IPC body instead
/// of a base64 string, so a 200MB drop is not inflated by a third and copied
/// through JSON. The name (percent-encoded) and thread id ride in headers.
#[tauri::command]
pub async fn save_attachment_bytes<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_attachment_bytes error: expected the file as a raw body".to_string());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let file_name = header(NAME_HEADER)
        .map(|raw| percent_decode(&raw))
        .ok_or_else(|| "save_attachment_bytes error: missing file name".to_string())?;
    let thread_id = header(THREAD_HEADER).filter(|t| !t.is_empty());
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err("save_attachment_file error: file too large (max 200MB)".to_string());
    }
    let bytes = bytes.clone();
    let base = get_jan_data_folder_path(app_handle).join(ATTACHMENTS_DIR);
    tauri::async_runtime::spawn_blocking(move || {
        store_attachment(&base, &file_name, &bytes, thread_id.as_deref())
    })
    .await
    .map_err(|e| format!("save_attachment_file error: {e}"))?
}

/// `%XX` escapes decoded (what `encodeURIComponent` produces); an invalid
/// escape is kept as typed, and bytes that are not UTF-8 become U+FFFD.
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let Some(b) = raw.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod percent_decode_tests {
    #[test]
    fn decodes_what_encode_uri_component_makes_and_keeps_bad_escapes() {
        assert_eq!(super::percent_decode("rapport%20%C3%A9t%C3%A9.pdf"), "rapport été.pdf");
        assert_eq!(super::percent_decode("100%.txt"), "100%.txt");
        assert_eq!(super::percent_decode("a%zz%4"), "a%zz%4");
    }
}

#[cfg(test)]
pub(crate) fn save_attachment_file_blocking<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    file_name: String,
    data_base64: String,
) -> Result<String, String> {
    save_attachment_in(app_handle, file_name, data_base64, None)
}

pub(crate) fn save_attachment_in<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    file_name: String,
    data_base64: String,
    thread_id: Option<String>,
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

    let base = get_jan_data_folder_path(app_handle).join(ATTACHMENTS_DIR);
    store_attachment(&base, &name, &bytes, thread_id.as_deref())
}

/// Write `bytes` as `file_name` under `attachments` dir `base` and return the
/// saved path. The folder is named by the content's hash, so dropping the
/// same file again reuses the copy already saved instead of storing it
/// twice. The bytes go to `<name>.part` first and are renamed into place, so
/// a crash mid-write never leaves a truncated file under the real name.
pub(crate) fn store_attachment(
    base: &std::path::Path,
    file_name: &str,
    bytes: &[u8],
    thread_id: Option<&str>,
) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let name = attachment_file_name(file_name)?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err("save_attachment_file error: file too large (max 200MB)".to_string());
    }
    let mut base = base.to_path_buf();
    if let Some(thread_id) = thread_id {
        crate::core::threads::utils::validate_thread_id(thread_id)
            .map_err(|e| format!("save_attachment_file error: {e}"))?;
        base = base.join(thread_id);
    }
    let digest = hex::encode(Sha256::digest(bytes));
    let folder = base.join(&digest[..32]);
    let path = folder.join(&name);
    // The name was reduced to a bare file name above; confirm it did not end up
    // anywhere but directly inside the attachment folder.
    if path.parent() != Some(folder.as_path()) {
        return Err("save_attachment_file error: invalid file name".to_string());
    }
    // Same bytes under the same name: already saved.
    if fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() == bytes.len() as u64) {
        return Ok(path.to_string_lossy().into_owned());
    }
    fs::create_dir_all(&folder).map_err(|e| format!("save_attachment_file error: {e}"))?;
    let part = folder.join(format!("{name}.{}.part", uuid::Uuid::new_v4().simple()));
    let written = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = fs::File::create(&part)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&part, &path)
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&part);
        return Err(format!("save_attachment_file error: {e}"));
    }
    Ok(path.to_string_lossy().into_owned())
}
