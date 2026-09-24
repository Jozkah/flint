//! Backend-owned settings store for webview Zustand stores.
//!
//! Persists non-secret settings to `<jan_data_folder>/settings.json` as a flat
//! JSON object (`{ "<namespace>": "<serialized-store-blob>" }`). The webview
//! reaches this via the async `StateStorage` adapter; an out-of-process consumer
//! (jan CLI) can read the same file without an `AppHandle`. Secrets never land
//! here -- they go to the OS keyring via the provider-config path.
//!
//! The map is held in memory and mutated in place; disk writes are coalesced by
//! a background thread on a short debounce so a burst of `settings_set` calls
//! (each carrying the whole Zustand store blob) collapses into a single
//! whole-file rewrite instead of one O(total-size) rewrite per call. A
//! synchronous [`flush_settings`] drains the debounce on app exit so jan CLI
//! never reads a stale file.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::commands::resolve_jan_data_folder;
use crate::core::app::constants::CONFIGURATION_FILE_NAME;

/// How long to wait after the last mutation before flushing to disk. Bursts of
/// writes within this window coalesce into one rewrite.
const FLUSH_DEBOUNCE: Duration = Duration::from_millis(500);
/// The longest a write may wait for disk however often the settings keep
/// changing. Without a cap a key rewritten faster than the debounce -- the
/// in-flight turn's checkpoint while a reply streams -- never flushes until
/// the writes stop, so a crash mid-stream loses the whole turn.
const FLUSH_MAX_DELAY: Duration = Duration::from_secs(2);

/// In-memory settings map plus flush bookkeeping.
struct SettingsMap {
    map: BTreeMap<String, String>,
    /// Set on mutation, cleared once the current contents reach disk.
    dirty: bool,
    /// Earliest instant at which the background thread may flush; pushed
    /// forward on each write so rapid successive writes keep coalescing, but
    /// never past `dirty_since + FLUSH_MAX_DELAY`.
    flush_at: Option<Instant>,
    /// When the oldest write not yet on disk was made.
    dirty_since: Option<Instant>,
    /// Keys changed since the last flush, for the dev-build write log. Only
    /// populated under `debug_assertions`.
    pending_keys: BTreeSet<String>,
    /// Every key this process set (`Some`) or removed (`None`) since the last
    /// flush. A flush applies only these onto the file as it is on disk, so a
    /// key another writer (the agent's `apply_settings`) changed in between is
    /// not overwritten with this process's stale copy (#240).
    changes: BTreeMap<String, Option<String>>,
}

impl SettingsMap {
    /// Returns true if the value changed (i.e. a flush is warranted).
    fn set(&mut self, key: String, value: String) -> bool {
        if self.map.get(&key).is_some_and(|v| *v == value) {
            return false;
        }
        #[cfg(debug_assertions)]
        self.pending_keys.insert(key.clone());
        self.changes.insert(key.clone(), Some(value.clone()));
        self.map.insert(key, value);
        true
    }

    /// Returns true if a key was actually removed.
    fn remove(&mut self, key: &str) -> bool {
        if self.map.remove(key).is_none() {
            return false;
        }
        #[cfg(debug_assertions)]
        self.pending_keys.insert(key.to_string());
        self.changes.insert(key.to_string(), None);
        true
    }

    fn mark_dirty(&mut self) {
        self.mark_dirty_at(Instant::now());
    }

    fn mark_dirty_at(&mut self, now: Instant) {
        self.dirty = true;
        let since = *self.dirty_since.get_or_insert(now);
        self.flush_at = Some((now + FLUSH_DEBOUNCE).min(since + FLUSH_MAX_DELAY));
    }

    /// Snapshot the contents for disk and clear the dirty/pending state.
    fn take_flush_batch(&mut self) -> (BTreeMap<String, String>, Vec<String>) {
        let snapshot = self.map.clone();
        let keys = std::mem::take(&mut self.pending_keys).into_iter().collect();
        self.dirty = false;
        self.flush_at = None;
        self.dirty_since = None;
        (snapshot, keys)
    }

    /// Like [`Self::take_flush_batch`], plus the changes to apply onto disk.
    fn take_flush_batch_with_changes(
        &mut self,
    ) -> (FlushBatch, Vec<String>) {
        let changes = std::mem::take(&mut self.changes);
        let (snapshot, keys) = self.take_flush_batch();
        (FlushBatch { snapshot, changes }, keys)
    }

    /// A flush failed: put its changes back unless a newer change superseded them.
    fn restore_changes(&mut self, changes: BTreeMap<String, Option<String>>) {
        for (key, change) in changes {
            self.changes.entry(key).or_insert(change);
        }
    }

    /// A flush wrote `merged`: adopt keys other writers changed on disk,
    /// keeping any change this process made while the flush ran.
    fn adopt_disk(&mut self, merged: BTreeMap<String, String>) {
        let mut next = merged;
        for (key, change) in &self.changes {
            match change {
                Some(value) => {
                    next.insert(key.clone(), value.clone());
                }
                None => {
                    next.remove(key);
                }
            }
        }
        self.map = next;
    }
}

/// What a flush writes: the in-memory snapshot (used only when the file on
/// disk cannot be read as a settings map) and the changes since the last flush.
struct FlushBatch {
    snapshot: BTreeMap<String, String>,
    changes: BTreeMap<String, Option<String>>,
}

/// The map to write: the file as it is on disk with this process's changes
/// applied, so keys only another writer touched keep that writer's value.
fn merge_changes(
    disk: BTreeMap<String, String>,
    changes: &BTreeMap<String, Option<String>>,
) -> BTreeMap<String, String> {
    let mut merged = disk;
    for (key, change) in changes {
        match change {
            Some(value) => {
                merged.insert(key.clone(), value.clone());
            }
            None => {
                merged.remove(key);
            }
        }
    }
    merged
}

/// The file's map, `Some(empty)` when missing or blank, `None` when it exists
/// but is not a JSON object (then the flush keeps the old whole-snapshot
/// behaviour rather than merging into nothing).
fn read_map_for_merge(path: &PathBuf) -> Option<BTreeMap<String, String>> {
    match fs::read_to_string(path) {
        Ok(content) if !content.trim().is_empty() => {
            // The agent's apply_settings may write non-string JSON values;
            // keep them as their JSON text rather than failing the whole map.
            let object: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(&content).ok()?;
            Some(
                object
                    .into_iter()
                    .map(|(k, v)| match v {
                        serde_json::Value::String(s) => (k, s),
                        other => (k, other.to_string()),
                    })
                    .collect(),
            )
        }
        Ok(_) => Some(BTreeMap::new()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(BTreeMap::new()),
        Err(_) => None,
    }
}

/// Write one flush batch to `path`. Returns the map that was written.
fn write_batch(path: &PathBuf, batch: &FlushBatch) -> Result<BTreeMap<String, String>, String> {
    let to_write = match read_map_for_merge(path) {
        Some(disk) => merge_changes(disk, &batch.changes),
        None => batch.snapshot.clone(),
    };
    write_map_atomic(path, &to_write)?;
    Ok(to_write)
}

/// Dev-only: report which settings keys just hit disk. Compiled out of release
/// builds (`make dev` / `yarn dev:tauri` build with `debug_assertions`).
fn log_flushed_keys(keys: &[String]) {
    #[cfg(debug_assertions)]
    if !keys.is_empty() {
        log::debug!(
            "settings: flushed {} key(s) to disk: {}",
            keys.len(),
            keys.join(", ")
        );
    }
    #[cfg(not(debug_assertions))]
    let _ = keys;
}

type Store = (Mutex<SettingsMap>, Condvar);

static STORE: OnceLock<Store> = OnceLock::new();

fn settings_file_path() -> PathBuf {
    resolve_jan_data_folder().join(CONFIGURATION_FILE_NAME)
}

fn read_map(path: &PathBuf) -> BTreeMap<String, String> {
    match fs::read_to_string(path) {
        Ok(content) if !content.trim().is_empty() => {
            serde_json::from_str(&content).unwrap_or_default()
        }
        _ => BTreeMap::new(),
    }
}

fn write_map_atomic(path: &PathBuf, map: &BTreeMap<String, String>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let serialized = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serialized).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn store() -> &'static Store {
    STORE.get_or_init(|| {
        let initial = SettingsMap {
            map: read_map(&settings_file_path()),
            dirty: false,
            flush_at: None,
            dirty_since: None,
            pending_keys: BTreeSet::new(),
            changes: BTreeMap::new(),
        };
        std::thread::Builder::new()
            .name("settings-flush".into())
            .spawn(flush_loop)
            .ok();
        (Mutex::new(initial), Condvar::new())
    })
}

fn lock(store: &Store) -> std::sync::MutexGuard<'_, SettingsMap> {
    store.0.lock().unwrap_or_else(|e| e.into_inner())
}

/// Background thread: waits for dirty state, honors the debounce deadline
/// (re-waiting if a newer write pushed it forward), then flushes a snapshot
/// with the lock released during disk I/O.
fn flush_loop() {
    let store = store();
    let cvar = &store.1;
    loop {
        let mut guard = lock(store);
        while !guard.dirty {
            guard = cvar.wait(guard).unwrap_or_else(|e| e.into_inner());
        }
        while let Some(deadline) = guard.flush_at {
            match deadline.checked_duration_since(Instant::now()) {
                Some(remaining) if !remaining.is_zero() => {
                    let (g, _) = cvar
                        .wait_timeout(guard, remaining)
                        .unwrap_or_else(|e| e.into_inner());
                    guard = g;
                }
                _ => break,
            }
        }
        let (batch, keys) = guard.take_flush_batch_with_changes();
        drop(guard);
        match write_batch(&settings_file_path(), &batch) {
            Err(e) => {
                log::warn!("settings flush failed: {}", e);
                // Re-arm so a later write (or exit flush) retries.
                let mut guard = lock(store);
                guard.restore_changes(batch.changes);
                guard.dirty = true;
            }
            Ok(written) => {
                lock(store).adopt_disk(written);
                log_flushed_keys(&keys);
            }
        }
    }
}

/// Synchronously write pending changes to disk. Call on app exit so the
/// debounce window can't drop the last writes or strand jan CLI with a stale
/// file. No-op when nothing is dirty.
pub fn flush_settings() {
    let store = store();
    let mut guard = lock(store);
    if !guard.dirty {
        return;
    }
    let (batch, keys) = guard.take_flush_batch_with_changes();
    drop(guard);
    match write_batch(&settings_file_path(), &batch) {
        Err(e) => {
            log::warn!("settings exit flush failed: {}", e);
            let mut guard = lock(store);
            guard.restore_changes(batch.changes);
            guard.dirty = true;
        }
        Ok(written) => {
            lock(store).adopt_disk(written);
            log_flushed_keys(&keys);
        }
    }
}

#[tauri::command]
pub fn settings_get(key: String) -> Option<String> {
    let store = store();
    lock(store).map.get(&key).cloned()
}

#[tauri::command]
pub fn settings_set(key: String, value: String) -> Result<(), String> {
    let store = store();
    let mut guard = lock(store);
    if guard.set(key, value) {
        guard.mark_dirty();
        store.1.notify_one();
    }
    Ok(())
}

#[tauri::command]
pub fn settings_remove(key: String) -> Result<(), String> {
    let store = store();
    let mut guard = lock(store);
    if guard.remove(&key) {
        guard.mark_dirty();
        store.1.notify_one();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_map() -> SettingsMap {
        SettingsMap {
            map: BTreeMap::new(),
            dirty: false,
            flush_at: None,
            dirty_since: None,
            pending_keys: BTreeSet::new(),
            changes: BTreeMap::new(),
        }
    }

    /// #240: the agent's apply_settings writes settings.json directly. A flush
    /// of the webview store made right after must keep that key instead of
    /// writing back the store's stale copy of the whole file.
    #[test]
    fn a_flush_keeps_a_key_another_writer_just_wrote() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let mut initial = BTreeMap::new();
        initial.insert("editor.fontSize".to_string(), "12".to_string());
        initial.insert("theme".to_string(), "\"light\"".to_string());
        write_map_atomic(&path, &initial).unwrap();

        let mut m = new_map();
        m.map = initial.clone();
        m.set("theme".into(), "\"dark\"".into());
        m.mark_dirty();

        // The other writer changes a key the store did not touch.
        let mut external = initial.clone();
        external.insert("editor.fontSize".to_string(), "16".to_string());
        write_map_atomic(&path, &external).unwrap();

        let (batch, _) = m.take_flush_batch_with_changes();
        let written = write_batch(&path, &batch).unwrap();
        m.adopt_disk(written);

        let on_disk = read_map(&path);
        assert_eq!(on_disk.get("editor.fontSize"), Some(&"16".to_string()));
        assert_eq!(on_disk.get("theme"), Some(&"\"dark\"".to_string()));
        // The store now serves the other writer's value too.
        assert_eq!(m.map.get("editor.fontSize"), Some(&"16".to_string()));
    }

    #[test]
    fn a_flush_applies_removals_onto_disk() {
        let mut disk = BTreeMap::new();
        disk.insert("a".to_string(), "1".to_string());
        disk.insert("b".to_string(), "2".to_string());
        let mut changes = BTreeMap::new();
        changes.insert("a".to_string(), None);
        let merged = merge_changes(disk, &changes);
        assert!(!merged.contains_key("a"));
        assert_eq!(merged.get("b"), Some(&"2".to_string()));
    }

    #[test]
    fn set_reports_change_and_ignores_noop() {
        let mut m = new_map();
        assert!(m.set("a".into(), "1".into()));
        assert!(!m.set("a".into(), "1".into())); // unchanged -> no flush
        assert!(m.set("a".into(), "2".into()));
        assert_eq!(m.map.get("a"), Some(&"2".to_string()));
    }

    #[test]
    fn remove_reports_whether_present() {
        let mut m = new_map();
        m.set("a".into(), "1".into());
        assert!(m.remove("a"));
        assert!(!m.remove("a"));
        assert!(!m.remove("missing"));
    }

    #[test]
    fn mark_dirty_arms_flush() {
        let mut m = new_map();
        assert!(!m.dirty);
        assert!(m.flush_at.is_none());
        m.mark_dirty();
        assert!(m.dirty);
        assert!(m.flush_at.is_some());
    }

    /// A key rewritten more often than the debounce -- the in-flight turn's
    /// checkpoint while a reply streams -- must still reach disk: the flush is
    /// deferred at most FLUSH_MAX_DELAY after the first unflushed write, or a
    /// crash mid-stream loses the whole turn.
    #[test]
    fn a_steady_stream_of_writes_still_flushes_within_the_max_delay() {
        let mut m = new_map();
        let t0 = Instant::now();
        let mut now = t0;
        while now < t0 + Duration::from_secs(10) {
            m.mark_dirty_at(now);
            now += Duration::from_millis(200);
        }
        let deadline = m.flush_at.expect("armed");
        assert!(
            deadline <= t0 + FLUSH_MAX_DELAY,
            "flush deferred {:?} past the first write",
            deadline - t0
        );
        // A lone write still waits out the ordinary debounce.
        let (_, _) = m.take_flush_batch();
        let later = t0 + Duration::from_secs(60);
        m.mark_dirty_at(later);
        assert_eq!(m.flush_at, Some(later + FLUSH_DEBOUNCE));
    }

    #[test]
    fn take_flush_batch_snapshots_and_clears() {
        let mut m = new_map();
        m.set("a".into(), "1".into());
        m.set("b".into(), "2".into());
        m.mark_dirty();
        let (snapshot, keys) = m.take_flush_batch();
        assert_eq!(snapshot.len(), 2);
        assert!(!m.dirty);
        assert!(m.flush_at.is_none());
        assert!(m.pending_keys.is_empty());
        // pending_keys only tracked under debug_assertions (tests run debug).
        assert_eq!(keys, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn set_preserves_other_keys() {
        let mut m = new_map();
        m.set("a".into(), "1".into());
        m.set("b".into(), "2".into());
        m.set("a".into(), "3".into());
        assert_eq!(m.map.get("a"), Some(&"3".to_string()));
        assert_eq!(m.map.get("b"), Some(&"2".to_string()));
    }

    #[test]
    fn write_then_read_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let mut map = BTreeMap::new();
        map.insert("model-provider".to_string(), "{\"a\":1}".to_string());
        map.insert("theme".to_string(), "\"dark\"".to_string());
        write_map_atomic(&path, &map).unwrap();
        assert_eq!(read_map(&path), map);
    }

    #[test]
    fn read_missing_or_empty_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.json");
        assert!(read_map(&missing).is_empty());
        let empty = dir.path().join("empty.json");
        fs::write(&empty, "   ").unwrap();
        assert!(read_map(&empty).is_empty());
    }
}
