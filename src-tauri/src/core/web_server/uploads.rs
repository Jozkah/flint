//! Files a browser session attaches: stored on the server, parsed on demand.
//!
//! A browser has no file path the server can read, so a picked file is
//! uploaded first and the server path it comes back with is what the rest of
//! the app uses, exactly as it uses a desktop path.

use std::fs;
use std::path::{Path, PathBuf};

use rand::RngCore;
use serde_json::{json, Value};

pub const MAX_UPLOAD_BYTES: usize = 100 * 1024 * 1024;
const MAX_NAME_LEN: usize = 128;

pub fn root(data_folder: &Path) -> PathBuf {
    data_folder.join("web-server").join("uploads")
}

/// The file name kept from what the browser sent: no directories, no control
/// characters, never empty and never a dot name.
pub fn clean_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let kept: String = base
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ' | '(' | ')') {
                c
            } else {
                '_'
            }
        })
        .take(MAX_NAME_LEN)
        .collect();
    let kept = kept
        .trim()
        .trim_start_matches('.')
        .trim_end_matches(['.', ' '])
        .to_string();
    if kept.is_empty() {
        "upload".to_string()
    } else {
        avoid_device_name(kept)
    }
}

/// Windows opens these names as devices whatever the extension (`CON.txt`), and
/// reading one blocks on console input. Such a name gets a leading underscore.
fn avoid_device_name(name: String) -> String {
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        format!("_{name}")
    } else {
        name
    }
}

fn is_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|c| c.is_ascii_hexdigit())
}

/// Uploads older than this are removed: a closed tab never asks for its files
/// to be deleted, so nothing else would.
const UPLOAD_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Most bytes all uploads together may take; a store past it is refused.
pub const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum StoreError {
    TooLarge,
    OverQuota,
    Io(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::TooLarge => f.write_str("file too large"),
            StoreError::OverQuota => f.write_str("upload storage is full"),
            StoreError::Io(message) => f.write_str(message),
        }
    }
}

/// When an upload was last used: the newest time among its files (a use
/// refreshes the file, see [`resolve`]), or the folder's own time when empty.
fn last_used(dir: &Path) -> Option<std::time::SystemTime> {
    let newest = fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|file| file.metadata().and_then(|m| m.modified()).ok())
        .max();
    newest.or_else(|| fs::metadata(dir).and_then(|m| m.modified()).ok())
}

/// Removes the uploads nobody has used for [`UPLOAD_MAX_AGE`].
pub fn sweep(data_folder: &Path) {
    sweep_older_than(data_folder, UPLOAD_MAX_AGE);
}

fn sweep_older_than(data_folder: &Path, max_age: std::time::Duration) {
    let Ok(entries) = fs::read_dir(root(data_folder)) else {
        return;
    };
    for entry in entries.flatten() {
        let old = last_used(&entry.path())
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > max_age);
        if old && entry.file_name().to_str().is_some_and(is_id) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Bytes held by every stored upload.
fn total_bytes(data_folder: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(root(data_folder)) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        if let Ok(files) = fs::read_dir(entry.path()) {
            for file in files.flatten() {
                total = total.saturating_add(file.metadata().map(|m| m.len()).unwrap_or(0));
            }
        }
    }
    total
}

pub fn store(data_folder: &Path, name: &str, bytes: &[u8]) -> Result<Value, StoreError> {
    store_with_quota(data_folder, name, bytes, MAX_TOTAL_BYTES)
}

fn store_with_quota(
    data_folder: &Path,
    name: &str,
    bytes: &[u8],
    quota: u64,
) -> Result<Value, StoreError> {
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(StoreError::TooLarge);
    }
    sweep(data_folder);
    if total_bytes(data_folder).saturating_add(bytes.len() as u64) > quota {
        return Err(StoreError::OverQuota);
    }
    let mut id = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut id);
    let id = hex::encode(id);
    let name = clean_name(name);
    let dir = root(data_folder).join(&id);
    fs::create_dir_all(&dir).map_err(|e| StoreError::Io(e.to_string()))?;
    let path = dir.join(&name);
    fs::write(&path, bytes).map_err(|e| StoreError::Io(e.to_string()))?;
    Ok(json!({
        "id": id,
        "name": name,
        "size": bytes.len(),
        "path": path.to_string_lossy(),
    }))
}

pub fn delete(data_folder: &Path, id: &str) -> Result<(), String> {
    if !is_id(id) {
        return Err("invalid upload id".into());
    }
    match fs::remove_dir_all(root(data_folder).join(id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Resolve a path the browser names to a file inside the uploads folder, or
/// refuse. Canonicalised, so `..` and links cannot leave it.
pub fn resolve(data_folder: &Path, path: &str) -> Result<PathBuf, String> {
    let base = fs::canonicalize(root(data_folder)).map_err(|_| "no uploads".to_string())?;
    let file = fs::canonicalize(path).map_err(|_| "file not found".to_string())?;
    if file.starts_with(&base) && file.is_file() {
        // A use keeps the upload alive: refresh the time the sweep reads.
        if let Ok(handle) = fs::OpenOptions::new().write(true).open(&file) {
            let _ = handle.set_modified(std::time::SystemTime::now());
        }
        Ok(file)
    } else {
        Err("path is not an uploaded file".into())
    }
}

/// The text of an uploaded document, by the same parser the desktop uses.
pub fn parse(data_folder: &Path, path: &str, file_type: &str) -> Result<String, String> {
    let file = resolve(data_folder, path)?;
    let file = file.to_string_lossy().into_owned();
    let kind = if file_type.is_empty() {
        file.rsplit('.').next().unwrap_or("").to_string()
    } else {
        file_type.to_string()
    };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        tauri_plugin_rag::parser::parse_document(&file, &kind)
    }));
    match outcome {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("the parser failed on this file".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_lose_directories_and_odd_characters() {
        assert_eq!(clean_name("../../etc/passwd"), "passwd");
        assert_eq!(clean_name("C:\\Users\\me\\report.pdf"), "report.pdf");
        assert_eq!(clean_name("a<b>:c.txt"), "a_b__c.txt");
        assert_eq!(clean_name(".hidden"), "hidden");
        assert_eq!(clean_name(""), "upload");
        assert_eq!(clean_name("..."), "upload");
        // Device names are not file names on Windows, with or without an extension.
        assert_eq!(clean_name("CON"), "_CON");
        assert_eq!(clean_name("nul.txt"), "_nul.txt");
        assert_eq!(clean_name("com1.log"), "_com1.log");
        assert_eq!(clean_name("console.txt"), "console.txt");
        assert_eq!(clean_name("report."), "report");
        assert!(clean_name(&"x".repeat(500)).len() <= MAX_NAME_LEN);
    }

    #[test]
    fn uploads_round_trip_and_parse_text() {
        let dir = tempfile::tempdir().unwrap();
        let stored = store(dir.path(), "notes.txt", b"hello upload").unwrap();
        let path = stored["path"].as_str().unwrap();
        assert!(is_id(stored["id"].as_str().unwrap()));
        assert_eq!(parse(dir.path(), path, "txt").unwrap(), "hello upload");
        delete(dir.path(), stored["id"].as_str().unwrap()).unwrap();
        assert!(parse(dir.path(), path, "txt").is_err());
    }

    #[test]
    fn upload_over_quota_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        store_with_quota(dir.path(), "a.txt", &[0u8; 10], 15).unwrap();
        assert_eq!(
            store_with_quota(dir.path(), "b.txt", &[0u8; 10], 15),
            Err(StoreError::OverQuota)
        );
        store_with_quota(dir.path(), "c.txt", &[0u8; 5], 15).unwrap();
    }

    #[test]
    fn resolve_refreshes_last_used_so_sweep_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3 * 24 * 60 * 60);
        // Store both first: every store sweeps, so aging comes after.
        let paths: Vec<String> = ["used.txt", "idle.txt"]
            .iter()
            .map(|name| store(dir.path(), name, b"x").unwrap()["path"].as_str().unwrap().to_string())
            .collect();
        for path in &paths {
            let file = fs::OpenOptions::new().write(true).open(path).unwrap();
            file.set_modified(old).unwrap();
        }
        // Using one upload makes it recent again; the idle one stays old.
        resolve(dir.path(), &paths[0]).unwrap();
        sweep(dir.path());
        assert!(Path::new(&paths[0]).exists());
        assert!(!Path::new(&paths[1]).exists());
    }

    #[test]
    fn only_uploaded_files_can_be_parsed_or_deleted() {
        let dir = tempfile::tempdir().unwrap();
        store(dir.path(), "a.txt", b"x").unwrap();
        let outside = dir.path().join("secret.txt");
        fs::write(&outside, "secret").unwrap();
        assert!(parse(dir.path(), outside.to_str().unwrap(), "txt").is_err());
        let traversal = root(dir.path()).join("..").join("..").join("secret.txt");
        assert!(parse(dir.path(), traversal.to_str().unwrap(), "txt").is_err());
        assert!(delete(dir.path(), "../..").is_err());
        assert!(store(dir.path(), "big", &vec![0u8; MAX_UPLOAD_BYTES + 1]).is_err());
    }
}
