//! The app's small string-to-string settings store, kept on the server.
//!
//! Extensions record one-off migration markers and similar facts here through
//! `settings_get`, `settings_set` and `settings_remove`. The browser's own
//! storage would lose them with the next cleared profile, and each browser
//! would redo the work.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

const MAX_KEY: usize = 256;
const MAX_VALUE: usize = 1024 * 1024;
const MAX_ENTRIES: usize = 4096;
/// Keys plus values together. Checked on writes only, so a store that is
/// already over it still loads and can shrink.
const MAX_TOTAL: usize = 8 * 1024 * 1024;

type Map = BTreeMap<String, String>;

/// Cloning shares the same cache, so a clone can move into `spawn_blocking`.
#[derive(Clone)]
pub struct Store {
    file: PathBuf,
    /// `None` until first use, then the whole store. The file is read once; this
    /// process is its only writer.
    cache: Arc<Mutex<Option<Map>>>,
}

impl Store {
    pub fn new(data_folder: &Path) -> Self {
        Self {
            file: data_folder.join("web-server").join("settings.json"),
            cache: Arc::new(Mutex::new(None)),
        }
    }

    /// The file the store keeps its values in.
    pub fn file(&self) -> &Path {
        &self.file
    }

    /// A missing file is an empty store. A file that does not parse is moved to
    /// `settings.json.bad` and reported, never read as empty and overwritten.
    fn load(&self) -> Result<Map, String> {
        match std::fs::read(&self.file) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
                let bad = self.file.with_extension("json.bad");
                match std::fs::rename(&self.file, &bad) {
                    Ok(()) => format!(
                        "the settings file could not be read ({e}); it was kept as {}",
                        bad.display()
                    ),
                    Err(_) => format!("the settings file could not be read ({e}) and was left as it is"),
                }
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
            Err(e) => Err(format!("the settings file could not be read: {e}")),
        }
    }

    fn write(&self, map: &Map) -> Result<(), String> {
        use std::io::Write as _;
        let parent = self.file.parent().ok_or("no parent")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let unique = uuid::Uuid::new_v4().simple().to_string();
        let temporary = self.file.with_extension(format!("{}.tmp", &unique[..8]));
        let bytes = serde_json::to_vec(map).map_err(|e| e.to_string())?;
        let written = std::fs::File::create(&temporary).and_then(|mut f| {
            f.write_all(&bytes)?;
            f.sync_all()
        });
        if let Err(e) = written {
            let _ = std::fs::remove_file(&temporary);
            return Err(e.to_string());
        }
        if let Err(e) = std::fs::rename(&temporary, &self.file) {
            let _ = std::fs::remove_file(&temporary);
            return Err(e.to_string());
        }
        #[cfg(unix)]
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
        Ok(())
    }
}

fn total_size(map: &Map) -> usize {
    map.iter().map(|(k, v)| k.len() + v.len()).sum()
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
    let mut guard = store.cache.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(store.load()?);
    }
    let map = guard.as_mut().ok_or("settings are not loaded")?;
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
                let previous = map.insert(key.to_owned(), value.to_owned());
                let grew = total_size(map) > MAX_TOTAL
                    && value.len() > previous.as_deref().map_or(0, str::len);
                let saved = if grew {
                    Err("the settings store is full".to_string())
                } else {
                    store.write(map)
                };
                if let Err(e) = saved {
                    // Keep the cache what the file holds.
                    match previous {
                        Some(old) => map.insert(key.to_owned(), old),
                        None => map.remove(key),
                    };
                    return Err(e);
                }
            }
            Ok(Value::Null)
        }
        "settings_remove" => {
            if let Some(old) = map.remove(key) {
                if let Err(e) = store.write(map) {
                    map.insert(key.to_owned(), old);
                    return Err(e);
                }
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

    #[test]
    fn settings_corrupt_file_kept_as_bad_and_error_returned() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        std::fs::create_dir_all(store.file().parent().unwrap()).unwrap();
        std::fs::write(store.file(), b"{not json").unwrap();
        let err = call(&store, "settings_get", &json!({"key": "a"})).unwrap_err();
        assert!(err.contains("settings.json.bad"), "{err}");
        let bad = store.file().with_extension("json.bad");
        assert_eq!(std::fs::read(&bad).unwrap(), b"{not json");
        // A later write starts a fresh store and never touches the kept file.
        call(&store, "settings_set", &json!({"key": "a", "value": "1"})).unwrap();
        assert_eq!(std::fs::read(&bad).unwrap(), b"{not json");
    }

    #[test]
    fn settings_total_cap_rejects_oversize_set() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let chunk = "x".repeat(MAX_VALUE);
        for i in 0..8 {
            let key = format!("k{i}");
            let _ = call(&store, "settings_set", &json!({"key": key, "value": chunk}));
        }
        // Eight full values plus their keys exceed the cap, so the last is refused
        // and the others stay readable.
        let err = call(&store, "settings_set", &json!({"key": "k8", "value": chunk})).unwrap_err();
        assert!(err.contains("full"), "{err}");
        assert_eq!(call(&store, "settings_get", &json!({"key": "k8"})).unwrap(), Value::Null);
        assert_eq!(call(&store, "settings_get", &json!({"key": "k0"})).unwrap(), json!(chunk));
        // Removing still works at the cap.
        call(&store, "settings_remove", &json!({"key": "k0"})).unwrap();
    }

    #[test]
    fn settings_get_uses_cache_no_disk_read() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        call(&store, "settings_set", &json!({"key": "a", "value": "1"})).unwrap();
        std::fs::remove_file(store.file()).unwrap();
        assert_eq!(call(&store, "settings_get", &json!({"key": "a"})).unwrap(), json!("1"));
    }

    #[test]
    fn settings_write_roundtrip_after_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        call(&store, "settings_set", &json!({"key": "a", "value": "1"})).unwrap();
        call(&store, "settings_set", &json!({"key": "b", "value": "2"})).unwrap();
        call(&store, "settings_remove", &json!({"key": "a"})).unwrap();
        let reopened = Store::new(dir.path());
        assert_eq!(call(&reopened, "settings_get", &json!({"key": "a"})).unwrap(), Value::Null);
        assert_eq!(call(&reopened, "settings_get", &json!({"key": "b"})).unwrap(), json!("2"));
        let leftovers = std::fs::read_dir(store.file().parent().unwrap())
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
    }
}
