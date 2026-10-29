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
//!
//! A flush normally re-reads the file and applies only this process's changes
//! onto it, so a key another writer (the agent's `apply_settings`) changed is
//! kept. To avoid re-reading a file nobody else touched, each write records the
//! file's length and mtime; the next flush skips the read and writes the
//! in-memory map when the file still has exactly that stamp and the stamp is at
//! least [`UNCHANGED_MIN_AGE`] old (so a coarse filesystem clock cannot hide a
//! second writer). Any doubt falls back to the read-and-merge.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

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
    /// Set once a factory reset has deleted `settings.json`. From then on the
    /// store refuses writes and never flushes, so neither a debounced write
    /// nor the exit flush can bring the file back before the restart.
    discarded: bool,
}

impl SettingsMap {
    /// Returns true if the value changed (i.e. a flush is warranted).
    fn set(&mut self, key: String, value: String) -> bool {
        if self.discarded || self.map.get(&key).is_some_and(|v| *v == value) {
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
        if self.discarded || self.map.remove(key).is_none() {
            return false;
        }
        #[cfg(debug_assertions)]
        self.pending_keys.insert(key.to_string());
        self.changes.insert(key.to_string(), None);
        true
    }

    /// Drop everything, pending writes included, and refuse further changes.
    fn discard(&mut self) {
        self.map.clear();
        self.pending_keys.clear();
        self.changes.clear();
        self.dirty = false;
        self.flush_at = None;
        self.dirty_since = None;
        self.discarded = true;
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
    #[cfg(test)]
    MERGE_READS.lock().unwrap_or_else(|e| e.into_inner()).push(path.clone());
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

/// Length and modification time of the settings file as this process last
/// wrote it.
type Stamp = (u64, SystemTime);

/// The stamp of each settings file this process last wrote, by path.
static LAST_WRITTEN: Mutex<BTreeMap<PathBuf, Stamp>> = Mutex::new(BTreeMap::new());

/// Test-only: every path [`read_map_for_merge`] was asked to read.
#[cfg(test)]
static MERGE_READS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// How old the recorded stamp must be before it proves nobody else wrote. Inside
/// this window a second write could land in the same mtime tick with the same
/// length, so the file is read and merged as before.
const UNCHANGED_MIN_AGE: Duration = Duration::from_secs(2);

/// True when the file is exactly as this process last wrote it and that write
/// is at least `min_age` old.
fn unchanged_since_our_write(path: &PathBuf, min_age: Duration) -> bool {
    let last = LAST_WRITTEN
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(path)
        .copied();
    let Some(last) = last else {
        return false;
    };
    let Some(now) = fs::metadata(path)
        .ok()
        .and_then(|m| Some((m.len(), m.modified().ok()?)))
    else {
        return false;
    };
    now == last
        && SystemTime::now()
            .duration_since(now.1)
            .unwrap_or(Duration::ZERO)
            >= min_age
}

/// Write one flush batch to `path`. Returns the map that was written.
fn write_batch(path: &PathBuf, batch: &FlushBatch) -> Result<BTreeMap<String, String>, String> {
    write_batch_aged(path, batch, UNCHANGED_MIN_AGE)
}

fn write_batch_aged(
    path: &PathBuf,
    batch: &FlushBatch,
    min_age: Duration,
) -> Result<BTreeMap<String, String>, String> {
    // Nothing of ours to put on disk.
    if batch.changes.is_empty() {
        return Ok(batch.snapshot.clone());
    }
    let to_write = if unchanged_since_our_write(path, min_age) {
        // No other writer touched the file: the in-memory map is the file plus
        // our changes, so there is nothing to read or merge.
        batch.snapshot.clone()
    } else {
        match read_map_for_merge(path) {
            Some(disk) => merge_changes(disk, &batch.changes),
            None => {
                backup_unreadable(path);
                batch.snapshot.clone()
            }
        }
    };
    let stamp = write_map_atomic(path, &to_write);
    let mut last = LAST_WRITTEN.lock().unwrap_or_else(|e| e.into_inner());
    match stamp {
        Ok(Some(stamp)) => {
            last.insert(path.clone(), stamp);
        }
        Ok(None) => {
            last.remove(path);
        }
        Err(e) => {
            last.remove(path);
            return Err(e);
        }
    }
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

/// The startup map. Non-string values are kept as their JSON text (the same
/// reading the flush merge uses): parsing as strings only turned one number
/// into an empty map, and the webview then wrote its defaults over the real
/// settings. A file that cannot be parsed at all is copied aside first, since
/// the next flush will replace it.
fn read_map(path: &PathBuf) -> BTreeMap<String, String> {
    // An empty file at startup lost every setting just as a corrupt one did
    // (an interrupted write, a sync tool): keep it and say so, the same way.
    if fs::read_to_string(path).is_ok_and(|c| c.trim().is_empty()) {
        backup_unreadable(path);
        return BTreeMap::new();
    }
    match read_map_for_merge(path) {
        Some(map) => map,
        None => {
            backup_unreadable(path);
            BTreeMap::new()
        }
    }
}

/// Set when the settings file was unreadable and copied aside, until the
/// webview collects it (see [`take_settings_recovery_notice`]). Without it the
/// app started with defaults and the user never learned why.
static RECOVERY_NOTICE: Mutex<Option<SettingsRecovery>> = Mutex::new(None);

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SettingsRecovery {
    /// The settings file that could not be read.
    pub file: String,
    /// Where its contents were kept; `None` when the copy failed too.
    pub backup: Option<String>,
}

pub(crate) fn backup_unreadable(path: &PathBuf) {
    if path.is_file() {
        let aside = path.with_extension(format!("json.corrupt-{}", std::process::id()));
        let backup = match fs::copy(path, &aside) {
            Ok(_) => {
                log::warn!("settings: unreadable {}; kept a copy at {}", path.display(), aside.display());
                Some(aside.display().to_string())
            }
            Err(e) => {
                log::warn!("settings: unreadable {} and could not copy it: {e}", path.display());
                None
            }
        };
        *RECOVERY_NOTICE.lock().unwrap_or_else(|e| e.into_inner()) = Some(SettingsRecovery {
            file: path.display().to_string(),
            backup,
        });
    }
}

/// The one-shot notice that the settings file was corrupt and a fresh one
/// started, for the webview to show once. Cleared by reading it.
#[tauri::command]
pub fn take_settings_recovery_notice() -> Option<SettingsRecovery> {
    // Make sure the startup read has happened, so a notice recorded there exists.
    let _ = store();
    RECOVERY_NOTICE.lock().unwrap_or_else(|e| e.into_inner()).take()
}

/// Write the map through a temp file and rename. Returns the new file's stamp,
/// taken from the temp file before the rename so a writer that replaces the
/// file right after cannot be mistaken for this write.
fn write_map_atomic(path: &PathBuf, map: &BTreeMap<String, String>) -> Result<Option<Stamp>, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let serialized = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    // A name per write: the flush thread and the exit flush may both write.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}-{seq}.tmp", std::process::id()));
    fs::write(&tmp, serialized).map_err(|e| e.to_string())?;
    let stamp = fs::metadata(&tmp)
        .ok()
        .and_then(|m| Some((m.len(), m.modified().ok()?)));
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(stamp)
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
            discarded: false,
        };
        std::thread::Builder::new()
            .name("settings-flush".into())
            .spawn(flush_loop)
            .ok();
        (Mutex::new(initial), Condvar::new())
    })
}

fn lock(store: &Store) -> std::sync::MutexGuard<'_, SettingsMap> {
    lock_map(&store.0)
}

fn lock_map(map: &Mutex<SettingsMap>) -> std::sync::MutexGuard<'_, SettingsMap> {
    map.lock().unwrap_or_else(|e| e.into_inner())
}

/// Serializes disk writes against [`discard_settings`]. Writers drop the map
/// lock during I/O so `settings_set` never waits on the disk; this lock lets a
/// discard wait out a write already in flight.
static WRITE: Mutex<()> = Mutex::new(());

/// Write a flush batch unless the store was discarded after the batch was
/// taken, then adopt the result (or re-arm on failure). Returns whether it
/// wrote.
fn persist(state: &Mutex<SettingsMap>, path: &PathBuf, batch: FlushBatch) -> Result<bool, String> {
    let _write = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    if lock_map(state).discarded {
        return Ok(false);
    }
    match write_batch(path, &batch) {
        Err(e) => {
            // Re-arm so a later write (or exit flush) retries.
            let mut guard = lock_map(state);
            if !guard.discarded {
                guard.restore_changes(batch.changes);
                guard.dirty = true;
            }
            Err(e)
        }
        Ok(written) => {
            lock_map(state).adopt_disk(written);
            Ok(true)
        }
    }
}

/// Forget the in-memory settings and stop persisting them for the rest of
/// this process. Factory reset calls this before deleting `settings.json`;
/// without it a pending debounced write or the exit flush would write the
/// pre-reset settings straight back.
pub fn discard_settings() {
    let store = store();
    // Wait out a write already in flight; any later one sees `discarded`.
    let _write = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    lock(store).discard();
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
        match persist(&store.0, &settings_file_path(), batch) {
            Ok(true) => log_flushed_keys(&keys),
            Ok(false) => {}
            Err(e) => log::warn!("settings flush failed: {}", e),
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
    match persist(&store.0, &settings_file_path(), batch) {
        Ok(true) => log_flushed_keys(&keys),
        Ok(false) => {}
        Err(e) => log::warn!("settings exit flush failed: {}", e),
    }
}

/// Every entry whose key is one of `prefixes` or starts with `<prefix>:`.
pub fn entries_with_prefixes(prefixes: &[&str]) -> Vec<(String, String)> {
    let store = store();
    lock(store)
        .map
        .iter()
        .filter(|(key, _)| {
            prefixes.iter().any(|p| {
                key.as_str() == *p
                    || key
                        .strip_prefix(p)
                        .is_some_and(|rest| rest.starts_with(':'))
            })
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
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
            discarded: false,
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
    fn discard_empties_the_map_and_ignores_later_writes() {
        let mut m = new_map();
        m.set("a".into(), "1".into());
        m.mark_dirty();
        m.discard();
        assert!(m.map.is_empty());
        assert!(!m.dirty);
        assert!(m.flush_at.is_none());
        assert!(m.changes.is_empty());
        // A webview write racing the factory-reset restart must not bring a
        // wiped settings.json back.
        assert!(!m.set("b".into(), "2".into()));
        assert!(!m.remove("a"));
        assert!(m.map.is_empty());
    }

    #[test]
    fn a_flush_taken_before_discard_does_not_recreate_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let state = Mutex::new(new_map());
        {
            let mut m = state.lock().unwrap();
            m.set("theme".into(), "\"dark\"".into());
            m.mark_dirty();
        }
        let (batch, _) = state.lock().unwrap().take_flush_batch_with_changes();
        assert_eq!(persist(&state, &path, batch), Ok(true));
        assert!(path.is_file());

        // Reset deletes the file, then a flush that snapshotted earlier runs.
        {
            let mut m = state.lock().unwrap();
            m.set("theme".into(), "\"light\"".into());
            m.mark_dirty();
        }
        let (batch, _) = state.lock().unwrap().take_flush_batch_with_changes();
        fs::remove_file(&path).unwrap();
        state.lock().unwrap().discard();
        assert_eq!(persist(&state, &path, batch), Ok(false));
        assert!(!path.exists());
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

    #[test]
    fn one_non_string_value_keeps_every_other_setting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"theme":"dark","fontSize":14}"#).unwrap();
        let map = read_map(&path);
        assert_eq!(map.get("theme").map(String::as_str), Some("dark"));
        assert_eq!(map.get("fontSize").map(String::as_str), Some("14"));
    }

    #[test]
    fn an_unparseable_file_is_copied_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{ not json").unwrap();
        assert!(read_map(&path).is_empty());
        let kept = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().contains("corrupt"));
        assert!(kept);
    }

    #[test]
    fn an_unparseable_file_records_a_notice_naming_the_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{ not json").unwrap();
        RECOVERY_NOTICE.lock().unwrap().take();
        let _ = read_map(&path);
        let notice = RECOVERY_NOTICE.lock().unwrap().take().expect("notice recorded");
        assert!(notice.file.ends_with("settings.json"));
        let backup = notice.backup.expect("backup path");
        assert!(backup.contains("settings.json.corrupt-"));
        assert_eq!(fs::read_to_string(&backup).unwrap(), "{ not json");
    }

    #[test]
    fn an_empty_or_non_object_file_is_treated_as_corrupt() {
        for content in ["", "  \n\t", "[]", "42", "\"x\"", "null"] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("settings.json");
            fs::write(&path, content).unwrap();
            RECOVERY_NOTICE.lock().unwrap().take();
            assert!(read_map(&path).is_empty(), "{content:?}");
            let notice = RECOVERY_NOTICE.lock().unwrap().take();
            let backup = notice.and_then(|n| n.backup).unwrap_or_else(|| panic!("no notice for {content:?}"));
            assert_eq!(fs::read_to_string(&backup).unwrap(), content);
        }
    }

    #[test]
    fn a_missing_file_is_a_fresh_start_not_a_recovery() {
        let dir = tempfile::tempdir().unwrap();
        RECOVERY_NOTICE.lock().unwrap().take();
        assert!(read_map(&dir.path().join("settings.json")).is_empty());
        assert!(RECOVERY_NOTICE.lock().unwrap().take().is_none());
    }

    fn reads_of(path: &PathBuf) -> usize {
        MERGE_READS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|p| *p == path)
            .count()
    }

    fn batch_of(snapshot: &BTreeMap<String, String>, key: &str, value: &str) -> FlushBatch {
        let mut snapshot = snapshot.clone();
        snapshot.insert(key.to_string(), value.to_string());
        let mut changes = BTreeMap::new();
        changes.insert(key.to_string(), Some(value.to_string()));
        FlushBatch { snapshot, changes }
    }

    #[test]
    fn second_flush_does_not_reread_unchanged_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let first = batch_of(&BTreeMap::new(), "a", "1");
        // The first write has no stamp to trust, so it reads once.
        let written = write_batch_aged(&path, &first, Duration::ZERO).unwrap();
        assert_eq!(reads_of(&path), 1);
        let second = batch_of(&written, "b", "2");
        let written = write_batch_aged(&path, &second, Duration::ZERO).unwrap();
        assert_eq!(reads_of(&path), 1, "the unchanged file was read again");
        assert_eq!(read_map(&path), written);
        assert_eq!(written.get("a").map(String::as_str), Some("1"));
        assert_eq!(written.get("b").map(String::as_str), Some("2"));
    }

    #[test]
    fn external_writer_change_is_merged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let written =
            write_batch_aged(&path, &batch_of(&BTreeMap::new(), "a", "1"), Duration::ZERO).unwrap();
        // Another writer adds a key; the file's length changes.
        let mut external = written.clone();
        external.insert("agent.key".to_string(), "from-the-agent".to_string());
        write_map_atomic(&path, &external).unwrap();
        let reads = reads_of(&path);
        let after =
            write_batch_aged(&path, &batch_of(&written, "b", "2"), Duration::ZERO).unwrap();
        assert_eq!(reads_of(&path), reads + 1, "the changed file was not read");
        assert_eq!(after.get("agent.key").map(String::as_str), Some("from-the-agent"));
        assert_eq!(read_map(&path).get("b").map(String::as_str), Some("2"));
    }

    #[test]
    fn mtime_resolution_race_falls_back_to_merge() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let written =
            write_batch_aged(&path, &batch_of(&BTreeMap::new(), "a", "1"), Duration::ZERO).unwrap();
        let reads = reads_of(&path);
        // The stamp is fresh, so with the real minimum age it is not trusted.
        write_batch_aged(&path, &batch_of(&written, "b", "2"), UNCHANGED_MIN_AGE).unwrap();
        assert_eq!(reads_of(&path), reads + 1, "a fresh stamp was trusted");
    }

    #[test]
    fn a_flush_with_no_changes_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let batch = FlushBatch { snapshot: BTreeMap::new(), changes: BTreeMap::new() };
        write_batch_aged(&path, &batch, Duration::ZERO).unwrap();
        assert!(!path.exists());
    }
}
