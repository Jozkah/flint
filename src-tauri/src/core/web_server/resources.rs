//! Shared browser state beyond threads: projects, assistants and hardware.
//!
//! Projects are one JSON file and assistants are `assistants/<id>/assistant.json`,
//! the layout the desktop assistant extension already uses, so a browser and the
//! desktop app see the same records.

use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::core::threads::utils::validate_thread_id;

const MAX_KEYS: usize = 32;
const MAX_KEY_LEN: usize = 4096;

fn provider_name(name: &str) -> Result<(), String> {
    let plain = !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
        && !name.starts_with('.');
    if plain {
        Ok(())
    } else {
        Err("invalid provider name".into())
    }
}

/// A provider's stored key chain, from the same keyring/encrypted-file store
/// the desktop app uses, so one set of keys serves both.
pub fn provider_keys(name: &str) -> Result<Vec<String>, String> {
    provider_name(name)?;
    Ok(crate::core::server::provider_secrets::load_provider_keys(name))
}

pub fn set_provider_keys(name: &str, value: &Value) -> Result<(), String> {
    provider_name(name)?;
    let list = value
        .get("keys")
        .and_then(Value::as_array)
        .ok_or("expected {\"keys\": [...]}")?;
    if list.len() > MAX_KEYS {
        return Err("too many keys".into());
    }
    let mut keys: Vec<String> = Vec::new();
    for entry in list {
        let key = entry.as_str().ok_or("keys must be strings")?.trim();
        if key.len() > MAX_KEY_LEN {
            return Err("key too long".into());
        }
        if !key.is_empty() && !keys.iter().any(|k| k == key) {
            keys.push(key.to_owned());
        }
    }
    for key in &keys {
        crate::core::secret_values::register(key);
    }
    crate::core::server::provider_secrets::store_provider_keys(name, &keys)
}

pub fn delete_provider_keys(name: &str) -> Result<(), String> {
    provider_name(name)?;
    crate::core::server::provider_secrets::delete_provider_keys(name)
}

/// Values the user marked secret, redacted from every log from now on.
pub fn register_secret_values(value: &Value) -> Result<(), String> {
    let list = value
        .get("values")
        .and_then(Value::as_array)
        .ok_or("expected {\"values\": [...]}")?;
    for entry in list.iter().take(256) {
        if let Some(text) = entry.as_str() {
            crate::core::secret_values::register(text);
        }
    }
    Ok(())
}

const PROJECTS_FILE: &str = "projects.json";

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("path has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    fs::rename(&temporary, path).map_err(|e| e.to_string())
}

pub fn projects(root: &Path) -> Result<Vec<Value>, String> {
    match fs::read(root.join(PROJECTS_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn set_projects(root: &Path, value: Value) -> Result<(), String> {
    let list = value.as_array().ok_or("expected a JSON array")?;
    for project in list {
        let valid = project.get("id").and_then(Value::as_str).is_some()
            && project.get("name").and_then(Value::as_str).is_some();
        if !valid {
            return Err("each project needs string id and name".into());
        }
    }
    let bytes = serde_json::to_vec(list).map_err(|e| e.to_string())?;
    write_atomic(&root.join(PROJECTS_FILE), &bytes)
}

pub fn assistants(root: &Path) -> Result<Vec<Value>, String> {
    let dir = root.join("assistants");
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if let Ok(bytes) = fs::read(entry.path().join("assistant.json")) {
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                out.push(value);
            }
        }
    }
    out.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    Ok(out)
}

pub fn create_assistant(root: &Path, assistant: Value) -> Result<(), String> {
    let id = assistant
        .get("id")
        .and_then(Value::as_str)
        .ok_or("assistant id missing")?;
    validate_thread_id(id)?;
    let bytes = serde_json::to_vec_pretty(&assistant).map_err(|e| e.to_string())?;
    write_atomic(&root.join("assistants").join(id).join("assistant.json"), &bytes)
}

pub fn delete_assistant(root: &Path, id: &str) -> Result<(), String> {
    validate_thread_id(id)?;
    match fs::remove_dir_all(root.join("assistants").join(id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn projects_round_trip_and_reject_bad_shapes() {
        let dir = tempfile::tempdir().unwrap();
        assert!(projects(dir.path()).unwrap().is_empty());
        set_projects(dir.path(), json!([{"id":"p1","name":"One"}])).unwrap();
        assert_eq!(projects(dir.path()).unwrap()[0]["name"], "One");
        assert!(set_projects(dir.path(), json!({"id":"p1"})).is_err());
        assert!(set_projects(dir.path(), json!([{"id":"p1"}])).is_err());
        assert_eq!(projects(dir.path()).unwrap().len(), 1);
    }

    #[test]
    fn key_requests_are_validated_before_touching_the_store() {
        assert!(provider_keys("../x").is_err());
        assert!(provider_keys("..%5Cx").is_err());
        assert!(provider_keys("open ai").is_err());
        assert!(provider_keys(&"a".repeat(200)).is_err());
        assert!(set_provider_keys("openai", &json!({"keys": "nope"})).is_err());
        assert!(set_provider_keys("openai", &json!({"keys": [1]})).is_err());
        let many: Vec<String> = (0..40).map(|i| format!("k{i}")).collect();
        assert!(set_provider_keys("openai", &json!({ "keys": many })).is_err());
        assert!(set_provider_keys("openai", &json!({"keys": ["a".repeat(5000)]})).is_err());
        assert!(register_secret_values(&json!({"values": 3})).is_err());
        assert!(delete_provider_keys("a/b").is_err());
    }

    #[test]
    fn assistants_use_desktop_layout_and_reject_traversal() {
        let dir = tempfile::tempdir().unwrap();
        create_assistant(dir.path(), json!({"id":"jan","name":"Jan"})).unwrap();
        assert!(dir.path().join("assistants/jan/assistant.json").is_file());
        assert_eq!(assistants(dir.path()).unwrap().len(), 1);
        assert!(create_assistant(dir.path(), json!({"id":"../x"})).is_err());
        assert!(delete_assistant(dir.path(), "../x").is_err());
        delete_assistant(dir.path(), "jan").unwrap();
        assert!(assistants(dir.path()).unwrap().is_empty());
    }
}
