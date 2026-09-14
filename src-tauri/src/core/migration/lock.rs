//! A profile lock file to keep two JAN/Flint processes from writing the same
//! reused or target profile at once.
//!
//! The lock is a small JSON file (`.flint-profile.lock`) holding the owning pid
//! and a timestamp. This is advisory (cooperative) locking: it protects against
//! the app's own second instance, not against arbitrary external writers.
//!
//! Staleness: a lock whose timestamp is older than [`STALE_AFTER_MS`] is treated
//! as abandoned (the owning process crashed without releasing) and may be
//! stolen. This is time-based rather than pid-liveness based because querying
//! whether an arbitrary pid is alive is not portable without extra
//! dependencies; the TTL is the conservative, dependency-free equivalent.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::fsutil;

/// Lock filename placed inside the locked profile directory.
pub const LOCK_FILE_NAME: &str = ".flint-profile.lock";

/// A lock older than this (ms) is considered stale and may be stolen.
/// 6 hours: comfortably longer than any real migration, short enough that a
/// crashed process does not wedge the profile indefinitely.
pub const STALE_AFTER_MS: u64 = 6 * 60 * 60 * 1000;

/// The on-disk lock contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockInfo {
    pub pid: u32,
    pub timestamp_ms: u64,
    /// Free-form label (e.g. "flint-migration") for diagnostics.
    pub holder: String,
}

/// Errors from lock acquisition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockError {
    /// Held by another, non-stale process.
    Held(LockInfo),
    /// Filesystem error (message).
    Io(String),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::Held(info) => write!(
                f,
                "profile locked by pid {} since {}ms",
                info.pid, info.timestamp_ms
            ),
            LockError::Io(m) => write!(f, "profile lock io error: {m}"),
        }
    }
}

impl std::error::Error for LockError {}

/// An acquired lock. Releasing removes the file; dropping does NOT auto-remove
/// (callers release explicitly so a moved-out guard cannot silently unlock).
#[derive(Debug)]
pub struct ProfileLock {
    path: PathBuf,
    info: LockInfo,
}

impl ProfileLock {
    /// The locked file path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The recorded lock info.
    pub fn info(&self) -> &LockInfo {
        &self.info
    }

    /// Release the lock (remove the file). Idempotent.
    pub fn release(self) -> Result<(), LockError> {
        if self.path.exists() {
            std::fs::remove_file(&self.path).map_err(|e| LockError::Io(e.to_string()))?;
        }
        Ok(())
    }
}

fn lock_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join(LOCK_FILE_NAME)
}

/// Read the current lock, if any and parseable.
pub fn read_lock(profile_dir: &Path) -> Option<LockInfo> {
    let path = lock_path(profile_dir);
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Whether the lock is stale (older than [`STALE_AFTER_MS`] relative to now).
pub fn is_stale(info: &LockInfo) -> bool {
    let now = fsutil::now_ms();
    now.saturating_sub(info.timestamp_ms) > STALE_AFTER_MS
}

/// Whether a live lock is held by a *different* process than this one.
///
/// A stale lock returns false (it is abandoned and may be taken). A lock owned
/// by the current pid returns false (re-entrant for this process).
pub fn is_held_by_other(profile_dir: &Path) -> bool {
    match read_lock(profile_dir) {
        Some(info) => info.pid != std::process::id() && !is_stale(info_ref(&info)),
        None => false,
    }
}

// Tiny helper so `is_stale` can take a reference without a clone above.
fn info_ref(info: &LockInfo) -> &LockInfo {
    info
}

/// Acquire the profile lock.
///
/// Succeeds when the profile is unlocked, already locked by this process, or
/// locked by a stale (abandoned) process. Fails with [`LockError::Held`] when a
/// live, foreign process holds it.
pub fn acquire(profile_dir: &Path, holder: &str) -> Result<ProfileLock, LockError> {
    std::fs::create_dir_all(profile_dir).map_err(|e| LockError::Io(e.to_string()))?;
    let path = lock_path(profile_dir);

    if let Some(existing) = read_lock(profile_dir) {
        let mine = existing.pid == std::process::id();
        if !mine && !is_stale(&existing) {
            return Err(LockError::Held(existing));
        }
        // Stale or ours: fall through and (re)claim.
    }

    let info = LockInfo {
        pid: std::process::id(),
        timestamp_ms: fsutil::now_ms(),
        holder: holder.to_string(),
    };
    // Write atomically via temp + rename so a reader never sees a half-written
    // lock and cannot momentarily see the profile as unlocked.
    let tmp = path.with_extension("lock.tmp");
    let text = serde_json::to_string(&info).map_err(|e| LockError::Io(e.to_string()))?;
    std::fs::write(&tmp, text).map_err(|e| LockError::Io(e.to_string()))?;
    std::fs::rename(&tmp, &path).map_err(|e| LockError::Io(e.to_string()))?;

    Ok(ProfileLock { path, info })
}

/// Force-remove a lock regardless of owner (used only when the user explicitly
/// overrides a stale/foreign lock). Idempotent.
pub fn force_release(profile_dir: &Path) -> Result<(), LockError> {
    let path = lock_path(profile_dir);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| LockError::Io(e.to_string()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_and_release() {
        let td = tempfile::tempdir().unwrap();
        let lock = acquire(td.path(), "test").unwrap();
        assert!(lock_path(td.path()).exists());
        assert_eq!(lock.info().pid, std::process::id());
        lock.release().unwrap();
        assert!(!lock_path(td.path()).exists());
    }

    #[test]
    fn reentrant_for_same_pid() {
        let td = tempfile::tempdir().unwrap();
        let _a = acquire(td.path(), "one").unwrap();
        // Same process can re-acquire (e.g. nested code path) without error.
        let b = acquire(td.path(), "two").unwrap();
        assert_eq!(b.info().holder, "two");
        assert!(!is_held_by_other(td.path())); // ours, not foreign
    }

    #[test]
    fn foreign_live_lock_refuses() {
        let td = tempfile::tempdir().unwrap();
        // Simulate another live process by writing a lock with a foreign pid
        // and a fresh timestamp.
        let foreign = LockInfo {
            pid: std::process::id().wrapping_add(1),
            timestamp_ms: fsutil::now_ms(),
            holder: "other-process".to_string(),
        };
        std::fs::write(
            lock_path(td.path()),
            serde_json::to_string(&foreign).unwrap(),
        )
        .unwrap();

        assert!(is_held_by_other(td.path()));
        match acquire(td.path(), "me") {
            Err(LockError::Held(info)) => assert_eq!(info.holder, "other-process"),
            other => panic!("expected Held, got {other:?}"),
        }
    }

    #[test]
    fn stale_foreign_lock_can_be_stolen() {
        let td = tempfile::tempdir().unwrap();
        let stale = LockInfo {
            pid: std::process::id().wrapping_add(2),
            timestamp_ms: fsutil::now_ms().saturating_sub(STALE_AFTER_MS + 1000),
            holder: "crashed".to_string(),
        };
        std::fs::write(lock_path(td.path()), serde_json::to_string(&stale).unwrap())
            .unwrap();

        assert!(is_stale(&stale));
        assert!(!is_held_by_other(td.path())); // stale = not held
        let lock = acquire(td.path(), "me").unwrap(); // steal succeeds
        assert_eq!(lock.info().pid, std::process::id());
    }
}
