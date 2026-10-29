//! Whole-data backup: threads (metadata and messages), assistants and the
//! settings backup in ONE versioned JSON file, and a merge-only restore.
//!
//! Like `settings_backup`, the renderer never supplies a path: these commands
//! open the native dialogs themselves. The settings part is built by the
//! renderer (`lib/settings-backup.ts`, secrets already stripped); this side
//! adds threads and assistants, scrubs credential-looking fields from thread
//! metadata and assistants, and never overwrites or deletes on import.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::Runtime;

use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::threads::helpers::{read_messages_from_file, write_file_atomically, write_messages_to_file};
use crate::core::threads::utils::{
    get_data_dir, get_messages_path, get_thread_dir, get_thread_metadata_path, validate_thread_id,
};

pub const DATA_BACKUP_FORMAT: &str = "flint-data-backup";
pub const DATA_BACKUP_VERSION: u64 = 1;
/// Largest data backup read back. Threads are text; this is far above normal.
pub const MAX_DATA_BACKUP_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(serde::Serialize, Debug, Default, PartialEq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct DataBackupCounts {
    pub threads: usize,
    pub messages: usize,
    pub assistants: usize,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DataBackupSaveReport {
    pub path: String,
    pub counts: DataBackupCounts,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DataBackupPreview {
    pub app_version: String,
    pub created_at: String,
    pub counts: DataBackupCounts,
    /// Threads in the file whose id is already here (they are skipped).
    pub existing_threads: usize,
    /// Assistants in the file whose id is already here (they are skipped).
    pub existing_assistants: usize,
    /// The embedded settings backup, applied by the renderer if asked.
    pub settings: Value,
}

#[derive(serde::Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DataBackupImportReport {
    pub threads_added: usize,
    pub threads_skipped: usize,
    pub assistants_added: usize,
    pub assistants_skipped: usize,
}

/// A parsed, validated backup waiting for the user to confirm the preview.
static PENDING: Mutex<Option<Value>> = Mutex::new(None);

fn snake(key: &str) -> String {
    let mut out = String::new();
    let mut prev_lower = false;
    for c in key.chars() {
        if c.is_ascii_uppercase() && prev_lower {
            out.push('_');
        }
        prev_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
        out.push(c.to_ascii_lowercase());
    }
    out
}

/// Same rule as `SECRET_NAME` in `lib/settings-backup.ts`.
fn is_secret_name(key: &str) -> bool {
    let k = snake(key);
    if ["apikey", "api_key", "api-key", "secret", "password", "passwd", "authorization"]
        .iter()
        .any(|s| k.contains(s))
    {
        return true;
    }
    let base = k.strip_suffix('s').unwrap_or(&k);
    base == "token" || base.ends_with("_token") || base.ends_with("-token")
}

/// Drop credential-looking fields (booleans and numbers are kept: a token
/// count or a flag is not a credential).
pub fn strip_secret_fields(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(strip_secret_fields).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(k, v)| !(is_secret_name(k) && !v.is_boolean() && !v.is_number()))
                .map(|(k, v)| (k.clone(), strip_secret_fields(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// An assistant id names one directory entry under `assistants/`.
fn valid_assistant_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id != "."
        && !id.contains("..")
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn assistant_path(root: &Path, id: &str) -> PathBuf {
    root.join("assistants").join(id).join("assistant.json")
}

fn read_json(path: &Path) -> Option<Value> {
    fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

fn sorted_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// Build the backup document from the data folder plus the renderer's
/// (already secret-free) settings backup.
pub fn build_data_backup(root: &Path, settings: Value, app_version: &str, created_at: &str) -> Value {
    let mut threads = Vec::new();
    let mut messages_total = 0;
    for dir in sorted_dirs(&get_data_dir(root)) {
        let Some(id) = dir.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };
        if validate_thread_id(&id).is_err() {
            continue;
        }
        let Some(mut thread) = read_json(&get_thread_metadata_path(root, &id)) else {
            continue;
        };
        if !thread.is_object() {
            continue;
        }
        thread["id"] = Value::String(id.clone());
        // A thread whose messages cannot be read is still worth its metadata.
        let messages = read_messages_from_file(root, &id).unwrap_or_default();
        messages_total += messages.len();
        threads.push(json!({ "thread": strip_secret_fields(&thread), "messages": messages }));
    }
    let mut assistants = Vec::new();
    for dir in sorted_dirs(&root.join("assistants")) {
        let Some(id) = dir.file_name().and_then(|n| n.to_str()) else { continue };
        if !valid_assistant_id(id) {
            continue;
        }
        if let Some(mut a) = read_json(&dir.join("assistant.json")).filter(Value::is_object) {
            a["id"] = Value::String(id.to_owned());
            assistants.push(strip_secret_fields(&a));
        }
    }
    json!({
        "format": DATA_BACKUP_FORMAT,
        "version": DATA_BACKUP_VERSION,
        "appVersion": app_version,
        "createdAt": created_at,
        "counts": {
            "threads": threads.len(),
            "messages": messages_total,
            "assistants": assistants.len(),
        },
        "settings": settings,
        "assistants": assistants,
        "threads": threads,
    })
}

/// Parse and validate a backup file's text.
pub fn parse_data_backup(text: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(text).map_err(|_| "This file is not valid JSON.".to_string())?;
    if v.get("format").and_then(Value::as_str) != Some(DATA_BACKUP_FORMAT) {
        return Err("This is not a Flint data backup.".into());
    }
    match v.get("version").and_then(Value::as_u64) {
        Some(n) if n >= 1 && n <= DATA_BACKUP_VERSION => {}
        Some(n) if n > DATA_BACKUP_VERSION => {
            return Err("This backup was made by a newer version of Flint. Update Flint to import it.".into())
        }
        _ => return Err("The backup has no valid version.".into()),
    }
    for key in ["threads", "assistants"] {
        if !v.get(key).map_or(true, Value::is_array) {
            return Err(format!("The backup's {key} list is malformed."));
        }
    }
    Ok(v)
}

fn backup_threads(b: &Value) -> impl Iterator<Item = (String, &Value, Vec<Value>)> {
    b.get("threads").and_then(Value::as_array).into_iter().flatten().filter_map(|e| {
        let thread = e.get("thread").filter(|t| t.is_object())?;
        let id = thread.get("id").and_then(Value::as_str)?.to_owned();
        validate_thread_id(&id).ok()?;
        let messages = e
            .get("messages")
            .and_then(Value::as_array)
            .map(|m| m.iter().filter(|x| x.is_object()).cloned().collect())
            .unwrap_or_default();
        Some((id, thread, messages))
    })
}

fn backup_assistants(b: &Value) -> impl Iterator<Item = (String, &Value)> {
    b.get("assistants").and_then(Value::as_array).into_iter().flatten().filter_map(|a| {
        let id = a.get("id").and_then(Value::as_str)?.to_owned();
        (a.is_object() && valid_assistant_id(&id)).then_some((id, a))
    })
}

pub fn preview_data_backup(root: &Path, b: &Value) -> DataBackupPreview {
    let mut counts = DataBackupCounts::default();
    let mut existing_threads = 0;
    let mut existing_assistants = 0;
    for (id, _, messages) in backup_threads(b) {
        counts.threads += 1;
        counts.messages += messages.len();
        if get_thread_dir(root, &id).exists() {
            existing_threads += 1;
        }
    }
    for (id, _) in backup_assistants(b) {
        counts.assistants += 1;
        if root.join("assistants").join(&id).exists() {
            existing_assistants += 1;
        }
    }
    let s = |k: &str| b.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    DataBackupPreview {
        app_version: s("appVersion"),
        created_at: s("createdAt"),
        counts,
        existing_threads,
        existing_assistants,
        settings: b.get("settings").cloned().unwrap_or(Value::Null),
    }
}

/// Add every thread and assistant whose id is not already here. Nothing that
/// exists is overwritten and nothing is deleted.
pub fn apply_data_backup(root: &Path, b: &Value) -> Result<DataBackupImportReport, String> {
    let mut report = DataBackupImportReport::default();
    for (id, thread, messages) in backup_threads(b) {
        let dir = get_thread_dir(root, &id);
        if dir.exists() {
            report.threads_skipped += 1;
            continue;
        }
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let data = serde_json::to_vec_pretty(&strip_secret_fields(thread)).map_err(|e| e.to_string())?;
        write_file_atomically(&get_thread_metadata_path(root, &id), &data)?;
        write_messages_to_file(&messages, &get_messages_path(root, &id))?;
        report.threads_added += 1;
    }
    for (id, a) in backup_assistants(b) {
        let path = assistant_path(root, &id);
        if root.join("assistants").join(&id).exists() {
            report.assistants_skipped += 1;
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let data = serde_json::to_vec_pretty(&strip_secret_fields(a)).map_err(|e| e.to_string())?;
        write_file_atomically(&path, &data)?;
        report.assistants_added += 1;
    }
    Ok(report)
}

fn counts_of(b: &Value) -> DataBackupCounts {
    let n = |k: &str| b["counts"][k].as_u64().unwrap_or(0) as usize;
    DataBackupCounts { threads: n("threads"), messages: n("messages"), assistants: n("assistants") }
}

/// Save a data backup to a file the user picks. `None` means cancelled.
#[tauri::command]
pub async fn data_backup_save<R: Runtime>(
    app: tauri::AppHandle<R>,
    suggested_name: String,
    settings: Value,
) -> Result<Option<DataBackupSaveReport>, String> {
    let root = get_jan_data_folder_path(app.clone());
    let version = app.package_info().version.to_string();
    let created = chrono::Utc::now().to_rfc3339();
    let backup = tauri::async_runtime::spawn_blocking(move || {
        build_data_backup(&root, settings, &version, &created)
    })
    .await
    .map_err(|e| e.to_string())?;
    let name = super::export_file::sanitize_file_name(&suggested_name, "json");
    let Some(file) = super::picker::AsyncFileDialog::new()
        .add_filter("JSON", &["json"])
        .set_file_name(&name)
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let mut path = file.path().to_path_buf();
    if path.extension().is_none() {
        path.set_extension("json");
    }
    let text = serde_json::to_vec_pretty(&backup).map_err(|e| e.to_string())?;
    super::export_file::write_atomically(&path, &text)?;
    Ok(Some(DataBackupSaveReport {
        path: path.to_string_lossy().to_string(),
        counts: counts_of(&backup),
    }))
}

fn read_data_backup(path: &Path) -> Result<Value, String> {
    let len = fs::metadata(path)
        .map_err(|e| format!("could not read the backup: {e}"))?
        .len();
    if len > MAX_DATA_BACKUP_BYTES {
        return Err("the file is larger than 1 GB, so it is not a data backup".into());
    }
    let text = fs::read_to_string(path).map_err(|e| format!("could not read the backup: {e}"))?;
    parse_data_backup(&text)
}

/// Pick a backup file, validate it and return what importing it would do.
/// The parsed file is held until `data_backup_apply`. `None` means cancelled.
#[tauri::command]
pub async fn data_backup_load<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<DataBackupPreview>, String> {
    let Some(file) = super::picker::AsyncFileDialog::new()
        .add_filter("JSON", &["json"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let path = file.path().to_path_buf();
    let root = get_jan_data_folder_path(app);
    let (backup, preview) = tauri::async_runtime::spawn_blocking(move || {
        let b = read_data_backup(&path)?;
        let p = preview_data_backup(&root, &b);
        Ok::<_, String>((b, p))
    })
    .await
    .map_err(|e| e.to_string())??;
    *PENDING.lock().unwrap_or_else(|p| p.into_inner()) = Some(backup);
    Ok(Some(preview))
}

/// Merge the backup chosen by `data_backup_load` into the data folder.
#[tauri::command]
pub async fn data_backup_apply<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<DataBackupImportReport, String> {
    let backup = PENDING
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
        .ok_or("no backup is waiting to be imported")?;
    let root = get_jan_data_folder_path(app);
    tauri::async_runtime::spawn_blocking(move || apply_data_backup(&root, &backup))
        .await
        .map_err(|e| e.to_string())?
}

/// Forget a backup the user chose not to import.
#[tauri::command]
pub async fn data_backup_discard() -> Result<(), String> {
    PENDING.lock().unwrap_or_else(|p| p.into_inner()).take();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(root: &Path) {
        let t = get_thread_dir(root, "t1");
        fs::create_dir_all(&t).unwrap();
        fs::write(
            t.join("thread.json"),
            r#"{"id":"t1","title":"Hello","metadata":{"api_key":"sk-thread","tokens":5}}"#,
        )
        .unwrap();
        write_messages_to_file(
            &[json!({"id":"m1","thread_id":"t1","content":[{"text":"hi"}]}), json!({"id":"m2","thread_id":"t1"})],
            &get_messages_path(root, "t1"),
        )
        .unwrap();
        let a = root.join("assistants").join("a1");
        fs::create_dir_all(&a).unwrap();
        fs::write(
            a.join("assistant.json"),
            r#"{"id":"a1","name":"Helper","instructions":"be nice","apiKey":"sk-assistant","accessToken":"tok"}"#,
        )
        .unwrap();
    }

    #[test]
    fn export_then_import_into_an_empty_folder_round_trips() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        seed(src.path());
        let b = build_data_backup(src.path(), json!({"format":"flint-settings-backup"}), "1.0.0", "now");
        let text = serde_json::to_string(&b).unwrap();
        assert!(!text.contains("sk-"), "secrets leaked: {text}");
        assert!(!text.contains("\"tok\""));
        assert_eq!(counts_of(&b), DataBackupCounts { threads: 1, messages: 2, assistants: 1 });

        let parsed = parse_data_backup(&text).unwrap();
        let p = preview_data_backup(dst.path(), &parsed);
        assert_eq!((p.existing_threads, p.existing_assistants), (0, 0));
        assert_eq!(p.counts, counts_of(&b));
        let r = apply_data_backup(dst.path(), &parsed).unwrap();
        assert_eq!(r.threads_added, 1);
        assert_eq!(r.assistants_added, 1);

        let again = build_data_backup(dst.path(), json!({"format":"flint-settings-backup"}), "1.0.0", "now");
        assert_eq!(again, b);
        assert_eq!(read_messages_from_file(dst.path(), "t1").unwrap().len(), 2);
    }

    #[test]
    fn existing_items_are_never_overwritten() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        seed(src.path());
        let b = build_data_backup(src.path(), Value::Null, "1", "now");
        let t = get_thread_dir(dst.path(), "t1");
        fs::create_dir_all(&t).unwrap();
        fs::write(t.join("thread.json"), r#"{"id":"t1","title":"Mine"}"#).unwrap();
        let a = dst.path().join("assistants").join("a1");
        fs::create_dir_all(&a).unwrap();
        fs::write(a.join("assistant.json"), r#"{"id":"a1","name":"Mine"}"#).unwrap();

        let p = preview_data_backup(dst.path(), &b);
        assert_eq!((p.existing_threads, p.existing_assistants), (1, 1));
        let r = apply_data_backup(dst.path(), &b).unwrap();
        assert_eq!(r, DataBackupImportReport { threads_added: 0, threads_skipped: 1, assistants_added: 0, assistants_skipped: 1 });
        assert_eq!(read_json(&t.join("thread.json")).unwrap()["title"], "Mine");
        assert_eq!(read_json(&a.join("assistant.json")).unwrap()["name"], "Mine");
        assert!(!get_messages_path(dst.path(), "t1").exists());
    }

    #[test]
    fn hostile_ids_are_skipped() {
        let dst = tempfile::tempdir().unwrap();
        let b = json!({
            "format": DATA_BACKUP_FORMAT, "version": 1,
            "threads": [{"thread": {"id": "../evil"}, "messages": []}, {"thread": {"id": "C:x"}}],
            "assistants": [{"id": "../a"}, {"id": "a/b"}],
        });
        let r = apply_data_backup(dst.path(), &b).unwrap();
        assert_eq!(r, DataBackupImportReport::default());
    }

    #[test]
    fn wrong_format_or_newer_version_is_refused() {
        assert!(parse_data_backup("nope").is_err());
        assert!(parse_data_backup(r#"{"format":"flint-settings-backup","version":1}"#).is_err());
        assert!(parse_data_backup(r#"{"format":"flint-data-backup","version":2}"#)
            .unwrap_err()
            .contains("newer"));
        assert!(parse_data_backup(r#"{"format":"flint-data-backup","version":1,"threads":{}}"#).is_err());
        assert!(parse_data_backup(r#"{"format":"flint-data-backup","version":1}"#).is_ok());
    }

    #[test]
    fn secret_names_match_the_web_rule() {
        for k in ["api_key", "apiKey", "apiKeys", "client_secret", "password", "accessToken", "token", "refresh_tokens", "Authorization"] {
            assert!(is_secret_name(k), "{k}");
        }
        for k in ["title", "max_tokens_hint", "model", "id"] {
            assert!(!is_secret_name(k), "{k}");
        }
        // numbers and booleans are kept even with a secret-looking name
        assert_eq!(strip_secret_fields(&json!({"tokens": 5, "token": "x"})), json!({"tokens": 5}));
    }
}
