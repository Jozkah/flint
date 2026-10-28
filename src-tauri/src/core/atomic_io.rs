//! Durable atomic file replacement shared by the thread and archive stores.

use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

/// Replace `path` with `contents` so that a reader, or the next launch after a
/// crash, sees either the old file or the new one and never a torn mixture:
/// write a staging file beside it, flush it to disk, rename it over.
///
/// Used for every thread file and the archive store. `thread.json` had the same truncate-then-write
/// shape as `messages.jsonl`, and a torn one is skipped by `list_threads` --
/// the conversation simply vanishes from the sidebar.
pub fn write_atomic_durable(path: &Path, contents: &[u8]) -> Result<(), String> {
    // A name of its own for every write: two writers sharing one staging file
    // (two browsers editing a chat, or the desktop app and the server) would
    // truncate each other's content and fail each other's rename.
    static STAGING_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut staging_name = path
        .file_name()
        .ok_or_else(|| format!("not a file path: {}", path.display()))?
        .to_os_string();
    staging_name.push(format!(
        ".{}-{}.tmp",
        std::process::id(),
        STAGING_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let staging = path.with_file_name(staging_name);
    let result = (|| {
        let mut file = File::create(&staging).map_err(|e| e.to_string())?;
        file.write_all(contents).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        rename_over(&staging, path)?;
        sync_parent_dir(path);
        Ok(())
    })();
    if result.is_err() && staging.is_file() {
        let _ = fs::remove_file(&staging);
    }
    result
}

/// Rename `from` over `to`. On Windows the rename fails while another process
/// or thread has the destination open for an instant, so a few short retries
/// turn a transient sharing violation into a success.
fn rename_over(from: &Path, to: &Path) -> Result<(), String> {
    let mut last = String::new();
    for attempt in 0..8u64 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => last = error.to_string(),
        }
        std::thread::sleep(std::time::Duration::from_millis(5 * (attempt + 1)));
    }
    Err(last)
}

/// Flush the directory entry so the rename survives a power loss. Only unix
/// can open a directory; elsewhere this is a no-op.
fn sync_parent_dir(path: &Path) {
    #[cfg(unix)]
    if let Some(dir) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        if let Ok(d) = File::open(dir) {
            let _ = d.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_whole_file() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("f.json");
        write_atomic_durable(&p, b"a long first version").unwrap();
        write_atomic_durable(&p, b"short").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"short");
    }

    #[test]
    fn leaves_no_staging_file_on_failure() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("target");
        fs::create_dir(&p).unwrap();
        fs::write(p.join("keep"), b"x").unwrap();
        // Renaming a file over a non-empty directory fails.
        assert!(write_atomic_durable(&p, b"data").is_err());
        let names: Vec<_> = fs::read_dir(d.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names.len(), 1, "{names:?}");
    }

    #[test]
    fn concurrent_writers_do_not_share_staging() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("f.json");
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let p = p.clone();
                std::thread::spawn(move || {
                    for _ in 0..20 {
                        write_atomic_durable(&p, format!("writer-{i}").repeat(500).as_bytes()).unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let s = String::from_utf8(fs::read(&p).unwrap()).unwrap();
        assert!(s.starts_with("writer-") && s.len() % 8 == 0);
        let first = &s[..8];
        assert!(s.as_bytes().chunks(8).all(|c| c == first.as_bytes()), "torn file");
        assert_eq!(fs::read_dir(d.path()).unwrap().count(), 1);
    }
}
