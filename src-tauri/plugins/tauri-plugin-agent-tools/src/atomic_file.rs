//! Crash-safe file replacement shared by every writer that must never leave a
//! user's file half-written.
//!
//! [`write_atomic`] writes the new bytes to a unique sibling temp file, flushes
//! them to disk, gives the temp file the mode the replaced file had, and only
//! then renames it over the target. A crash at any point leaves the target
//! holding either its old content or the full new content, never a prefix of
//! either, and an edit never silently turns an executable script into a plain
//! file (Jozkah/jan#39, #36).

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// A temp path next to `path`, unique within this process and across
/// processes, so two concurrent writers of the same file never share (and
/// clobber) one temp file.
fn temp_sibling(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let temp = format!(".{name}.tmp-{}-{seq}", std::process::id());
    match path.parent() {
        Some(parent) => parent.join(temp),
        None => PathBuf::from(temp),
    }
}

/// Replace `path` with `bytes` atomically, keeping the permission bits of the
/// file being replaced. A file that does not exist yet gets the platform
/// default mode.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_atomic_with_mode(path, bytes, None)
}

/// [`write_atomic`], with `new_mode` (Unix permission bits) applied when the
/// target does not exist yet. On other platforms `new_mode` is ignored.
pub fn write_atomic_with_mode(
    path: &Path,
    bytes: &[u8],
    new_mode: Option<u32>,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let existing = std::fs::metadata(path).ok().map(|m| m.permissions());
    let temp = temp_sibling(path);
    let result = (|| -> std::io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // Create the temp file already restricted, so a private file is
            // never briefly readable by others under a looser mode.
            let mode = match (&existing, new_mode) {
                (Some(perms), _) => {
                    use std::os::unix::fs::PermissionsExt;
                    perms.mode() & 0o7777
                }
                (None, Some(mode)) => mode,
                (None, None) => 0o666,
            };
            options.mode(mode & 0o777);
        }
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        #[cfg(unix)]
        {
            // `mode()` above is filtered by the umask; set the exact bits the
            // replaced file had (including setuid/setgid/sticky), or the
            // requested private mode for a new file.
            use std::os::unix::fs::PermissionsExt;
            let exact = match (&existing, new_mode) {
                (Some(perms), _) => Some(perms.mode() & 0o7777),
                (None, Some(mode)) => Some(mode),
                (None, None) => None,
            };
            if let Some(mode) = exact {
                std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(mode))?;
            }
        }
        #[cfg(not(unix))]
        let _ = (&existing, new_mode);
        std::fs::rename(&temp, path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(e.to_string());
    }
    Ok(())
}

/// [`write_atomic`] for files holding secrets (API keys, tokens): on Unix the
/// result is always mode `0600`, whatever the replaced file had, and the bytes
/// never sit at any path under a looser mode.
pub fn write_atomic_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        // Tighten an existing loose file first, so its mode is what the
        // replacement inherits.
        use std::os::unix::fs::PermissionsExt;
        if path.exists() {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }
    write_atomic_with_mode(path, bytes, Some(0o600))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh directory under the system temp dir, removed on drop.
    struct TempDir(PathBuf);
    impl TempDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tempdir() -> TempDir {
        let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "atomic-file-test-{}-{seq}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-"))
            .collect()
    }

    #[test]
    fn replaces_content_and_leaves_no_temp_file() {
        let dir = tempdir();
        let target = dir.path().join("a.txt");
        std::fs::write(&target, b"old content that is longer").unwrap();
        write_atomic(&target, b"new").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn creates_missing_file_and_parents() {
        let dir = tempdir();
        let target = dir.path().join("sub/dir/b.txt");
        write_atomic(&target, b"hi").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"hi");
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_executable_bit_of_the_replaced_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir();
        let target = dir.path().join("build.sh");
        std::fs::write(&target, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        write_atomic(&target, b"#!/bin/sh\necho hi\n").unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode, 0o755);
    }

    #[cfg(unix)]
    #[test]
    fn private_write_is_0600_for_new_and_existing_files() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir();
        let fresh = dir.path().join("config.toml");
        write_atomic_private(&fresh, b"k = 1\n").unwrap();
        assert_eq!(
            std::fs::metadata(&fresh).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let loose = dir.path().join("loose.toml");
        std::fs::write(&loose, b"x").unwrap();
        std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_atomic_private(&loose, b"y").unwrap();
        assert_eq!(
            std::fs::metadata(&loose).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn concurrent_writers_do_not_share_a_temp_file() {
        let dir = tempdir();
        let target = dir.path().join("race.txt");
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let target = target.clone();
                std::thread::spawn(move || {
                    let body = vec![b'a' + i as u8; 4096];
                    // A rename can lose to a concurrent one on Windows; only
                    // the content check below matters.
                    let _ = write_atomic(&target, &body);
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let body = std::fs::read(&target).unwrap();
        assert_eq!(body.len(), 4096);
        assert!(body.iter().all(|b| *b == body[0]), "content was interleaved");
    }
}
