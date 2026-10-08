//! The app's small string-to-string settings store, kept on the server.
//!
//! Extensions record one-off migration markers and similar facts here through
//! `settings_get`, `settings_set` and `settings_remove`. The browser's own
//! storage would lose them with the next cleared profile, and each browser
//! would redo the work.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

const MAX_KEY: usize = 256;
const MAX_VALUE: usize = 1024 * 1024;
const MAX_ENTRIES: usize = 4096;

pub struct Store {
    file: PathBuf,
    lock: Mutex<()>,
}

impl Store {
    pub fn new(data_folder: &Path) -> Self {
        Self {
            file: data_folder.join("web-server").join("settings.json"),
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> BTreeMap<String, String> {
        std::fs::read(&self.file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn write(&self, map: &BTreeMap<String, String>) -> Result<(), String> {
        let parent = self.file.parent().ok_or("no parent")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let temporary = self.file.with_extension("tmp");
        std::fs::write(&temporary, serde_json::to_vec(map).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        std::fs::rename(temporary, &self.file).map_err(|e| e.to_string())
    }
}

pub fn handles(command: &str) -> bool {
    matches!(command, "settings_get" | "settings_set" | "settings_remove")
}

pub fn call(store: &Store, command: &str, args: &Value) -> Result<Value, String> {
    let key = args
        .get("key")
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty() && k.len() <= MAX_KEY)
        .ok_or("a key is required")?;
    let _guard = store.lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = store.read();
    match command {
        "settings_get" => Ok(map.get(key).map_or(Value::Null, |v| json!(v))),
        "settings_set" => {
            let value = args.get("value").and_then(Value::as_str).ok_or("a value is required")?;
            if value.len() > MAX_VALUE {
                return Err("value too large".into());
            }
            if !map.contains_key(key) && map.len() >= MAX_ENTRIES {
                return Err("too many settings".into());
            }
            if map.get(key).map(String::as_str) != Some(value) {
                map.insert(key.to_owned(), value.to_owned());
                store.write(&map)?;
            }
            Ok(Value::Null)
        }
        "settings_remove" => {
            if map.remove(key).is_some() {
                store.write(&map)?;
            }
            Ok(Value::Null)
        }
        other => Err(format!("unsupported command {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_persist_and_validate() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        assert_eq!(call(&store, "settings_get", &json!({"key": "a"})).unwrap(), Value::Null);
        call(&store, "settings_set", &json!({"key": "a", "value": "1"})).unwrap();
        assert_eq!(call(&store, "settings_get", &json!({"key": "a"})).unwrap(), json!("1"));
        let reopened = Store::new(dir.path());
        assert_eq!(call(&reopened, "settings_get", &json!({"key": "a"})).unwrap(), json!("1"));
        call(&reopened, "settings_remove", &json!({"key": "a"})).unwrap();
        assert_eq!(call(&reopened, "settings_get", &json!({"key": "a"})).unwrap(), Value::Null);
        assert!(call(&store, "settings_get", &json!({})).is_err());
        assert!(call(&store, "settings_get", &json!({"key": "k".repeat(300)})).is_err());
        assert!(call(&store, "settings_set", &json!({"key": "a"})).is_err());
        assert!(call(&store, "settings_set", &json!({"key": "a", "value": "x".repeat(MAX_VALUE + 1)})).is_err());
    }
}
