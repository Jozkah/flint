//! A profile lock file to keep two JAN/Flint processes from writing the same
//! reused or target profile at once.
//!
//! The lock is a small JSON file (`.flint-profile.lock`) holding the owning pid
//! and a timestamp. This is advisory (cooperative) locking: it protects against
//! the app's own second instance, not against arbitrary external writers.
//!
//! Staleness: a lock is abandoned when its owning pid is no longer running
//! (checked with a small per-OS liveness probe) or when its timestamp is older
//! than [`STALE_AFTER_MS`]. A process that holds a lock for the whole session
//! refreshes the timestamp periodically so the TTL never steals a live lock.
//! Acquisition is atomic (`create_new`), so two processes cannot both win.

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

    /// Rewrite the lock file with a fresh timestamp. A failure is logged: the
    /// lock stays valid while this pid lives, the timestamp only guards the TTL.
    fn refresh(&mut self) {
        self.info.timestamp_ms = fsutil::now_ms();
        if let Err(e) = write_lock_file(&self.path, &self.info) {
            log::warn!("could not refresh profile lock {}: {e}", self.path.display());
        }
    }

    /// Release the lock (remove the file). Idempotent.
    pub fn release(self) -> Result<(), LockError> {
        if self.path.exists() {
            std::fs::remove_file(&self.path).map_err(|e| LockError::Io(e.to_string()))?;
        }
        Ok(())
    }
}

/// Locks this process holds until it exits: the profile a Reuse migration
/// wired in (#168). Held here rather than by a caller because nothing above
/// the migration command lives as long as the session.
static SESSION_LOCKS: std::sync::Mutex<Vec<ProfileLock>> = std::sync::Mutex::new(Vec::new());

/// Keep `lock` until [`release_session_locks`]. A lock already held on the
/// same file is replaced, not duplicated.
pub fn hold_for_session(mut lock: ProfileLock) {
    lock.refresh();
    {
        let mut held = SESSION_LOCKS.lock().unwrap_or_else(|p| p.into_inner());
        held.retain(|l| l.path != lock.path);
        held.push(lock);
    }
    start_refresher();
}

/// Re-stamp every session lock so the TTL never reads a live holder as stale.
fn refresh_session_locks() {
    let mut held = SESSION_LOCKS.lock().unwrap_or_else(|p| p.into_inner());
    for lock in held.iter_mut() {
        lock.refresh();
    }
}

fn start_refresher() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        let _ = std::thread::Builder::new()
            .name("profile-lock-refresh".into())
            .spawn(|| loop {
                std::thread::sleep(std::time::Duration::from_millis(STALE_AFTER_MS / 12));
                refresh_session_locks();
            });
    });
}

/// Release every lock taken with [`hold_for_session`]; called on app exit so
/// the next launch does not find its own profile locked by a dead pid.
pub fn release_session_locks() {
    let held = std::mem::take(&mut *SESSION_LOCKS.lock().unwrap_or_else(|p| p.into_inner()));
    for lock in held {
        if let Err(e) = lock.release() {
            log::warn!("could not release a profile lock on exit: {e}");
        }
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
        Some(info) => info.pid != std::process::id() && !is_abandoned(&info),
        None => false,
    }
}

/// Stale by age, or owned by a pid that is no longer running.
pub fn is_abandoned(info: &LockInfo) -> bool {
    is_stale(info) || !pid_alive(info.pid)
}

/// Whether a process with this pid exists. Errs toward "alive" when the OS
/// will not say, so a lock is never stolen on a guess.
pub fn pid_alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks existence and permission.
        let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
        if rc == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        const STILL_ACTIVE: u32 = 259;
        // SAFETY: plain handle open/query/close on a pid.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return GetLastError() != ERROR_INVALID_PARAMETER;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok == 0 || code == STILL_ACTIVE
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        true
    }
}

/// Write the lock via temp + rename so a reader never sees a half-written file.
fn write_lock_file(path: &Path, info: &LockInfo) -> Result<(), String> {
    let tmp = path.with_extension("lock.tmp");
    let text = serde_json::to_string(info).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Acquire the profile lock.
///
/// Succeeds when the profile is unlocked, already locked by this process, or
/// locked by a stale (abandoned) process. Fails with [`LockError::Held`] when a
/// live, foreign process holds it.
pub fn acquire(profile_dir: &Path, holder: &str) -> Result<ProfileLock, LockError> {
    std::fs::create_dir_all(profile_dir).map_err(|e| LockError::Io(e.to_string()))?;
    let path = lock_path(profile_dir);

    let info = LockInfo {
        pid: std::process::id(),
        timestamp_ms: fsutil::now_ms(),
        holder: holder.to_string(),
    };
    let text = serde_json::to_string(&info).map_err(|e| LockError::Io(e.to_string()))?;

    for attempt in 0..5 {
        // Atomic claim: exactly one process can create the file.
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(text.as_bytes())
                    .map_err(|e| LockError::Io(e.to_string()))?;
                return Ok(ProfileLock { path, info });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(LockError::Io(e.to_string())),
        }

        match read_lock(profile_dir) {
            Some(existing) if existing.pid == std::process::id() => {
                // Ours (re-entrant): refresh in place.
                write_lock_file(&path, &info).map_err(LockError::Io)?;
                return Ok(ProfileLock { path, info });
            }
            Some(existing) if !is_abandoned(&existing) => return Err(LockError::Held(existing)),
            Some(_) => {
                // Abandoned: remove and race again through create_new.
                match std::fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(LockError::Io(e.to_string())),
                }
            }
            None => {
                // Unreadable: maybe a racer mid-write. Give it a moment, then
                // treat a persistently corrupt file as abandoned.
                std::thread::sleep(std::time::Duration::from_millis(40));
                if attempt >= 2 && read_lock(profile_dir).is_none() {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
    match read_lock(profile_dir) {
        Some(existing) => Err(LockError::Held(existing)),
        None => Err(LockError::Io("could not acquire the profile lock".into())),
    }
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

    /// A long-ish running child, standing in for another live process.
    fn live_child() -> std::process::Child {
        #[cfg(windows)]
        let mut c = std::process::Command::new("ping");
        #[cfg(windows)]
        c.args(["-n", "30", "127.0.0.1"]);
        #[cfg(not(windows))]
        let mut c = std::process::Command::new("sleep");
        #[cfg(not(windows))]
        c.arg("30");
        c.stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn helper child")
    }

    #[test]
    fn dead_pid_lock_is_stolen_even_when_fresh() {
        let td = tempfile::tempdir().unwrap();
        let mut child = live_child();
        let pid = child.id();
        child.kill().unwrap();
        child.wait().unwrap();
        let dead = LockInfo {
            pid,
            timestamp_ms: fsutil::now_ms(),
            holder: "gone".to_string(),
        };
        std::fs::write(lock_path(td.path()), serde_json::to_string(&dead).unwrap()).unwrap();
        assert!(!is_held_by_other(td.path()));
        let lock = acquire(td.path(), "me").unwrap();
        assert_eq!(lock.info().pid, std::process::id());
    }

    #[test]
    fn hold_for_session_refreshes_the_timestamp() {
        let td = tempfile::tempdir().unwrap();
        let mut lock = acquire(td.path(), "me").unwrap();
        lock.info.timestamp_ms = 1;
        hold_for_session(lock);
        let on_disk = read_lock(td.path()).unwrap();
        assert!(on_disk.timestamp_ms > 1);
        release_session_locks();
    }

    #[test]
    fn foreign_live_lock_refuses() {
        let td = tempfile::tempdir().unwrap();
        let mut child = live_child();
        // Simulate another live process with a lock owned by a running pid.
        let foreign = LockInfo {
            pid: child.id(),
            timestamp_ms: fsutil::now_ms(),
            holder: "other-process".to_string(),
        };
        std::fs::write(
            lock_path(td.path()),
            serde_json::to_string(&foreign).unwrap(),
        )
        .unwrap();

        assert!(is_held_by_other(td.path()));
        let result = acquire(td.path(), "me");
        let _ = child.kill();
        let _ = child.wait();
        match result {
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
