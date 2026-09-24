//! In-flight `.partial` working directories, shared by bundle import and
//! worktree export.
//!
//! Both operations assemble their output under a `*.partial` name and sweep
//! such directories left behind by a process that stopped part-way. Nothing
//! serializes two imports (or two exports) against each other, so a sweep must
//! not delete a directory another call in this process is still writing
//! (Jozkah/jan#202). Each operation claims its directory here before creating
//! it, and [`sweep`] skips every claimed one.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

fn claimed() -> &'static Mutex<HashSet<PathBuf>> {
    static CLAIMED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    CLAIMED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Marks a `.partial` directory as in use until dropped.
pub(crate) struct Claim(PathBuf);

impl Drop for Claim {
    fn drop(&mut self) {
        claimed()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

/// Claim `path` for the calling operation. Call before creating it.
pub(crate) fn claim(path: &Path) -> Claim {
    claimed()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path.to_path_buf());
    Claim(path.to_path_buf())
}

/// Remove every `*.partial` directory directly under `dir` that no operation
/// in this process has claimed: those are leftovers of a stopped process or an
/// operation that ended without cleaning up.
pub(crate) fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let claimed = claimed().lock().unwrap_or_else(|e| e.into_inner());
    for e in entries.flatten() {
        if !e.file_name().to_string_lossy().ends_with(".partial") {
            continue;
        }
        let path = e.path();
        if claimed.contains(&path) {
            continue;
        }
        let _ = std::fs::remove_dir_all(&path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Jozkah/jan#202: a sweep started by a second operation leaves the first
    /// operation's in-flight directory alone, and still removes a leftover.
    #[test]
    fn sweep_skips_a_claimed_partial_and_removes_a_leftover() {
        let dir = std::env::temp_dir().join(format!(
            "partial-dirs-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let live = dir.join("live.partial");
        let dead = dir.join("dead.partial");
        let guard = claim(&live);
        std::fs::create_dir_all(&live).unwrap();
        std::fs::create_dir_all(&dead).unwrap();

        sweep(&dir);
        assert!(live.exists(), "swept a directory still in use");
        assert!(!dead.exists(), "left a stale partial behind");

        drop(guard);
        sweep(&dir);
        assert!(!live.exists(), "a released partial must be sweepable");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
