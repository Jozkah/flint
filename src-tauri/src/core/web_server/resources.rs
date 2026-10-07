//! Shared browser state beyond threads: projects, assistants and hardware.
//!
//! Projects are one JSON file and assistants are `assistants/<id>/assistant.json`,
//! the layout the desktop assistant extension already uses, so a browser and the
//! desktop app see the same records.

use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::core::threads::utils::validate_thread_id;

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
