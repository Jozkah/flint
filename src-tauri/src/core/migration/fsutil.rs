//! Small, dependency-free filesystem helpers shared by the migration modules.
//!
//! Everything here is pure `std`: recursive size/count, a verbatim recursive
//! copy that preserves modification times, and a mtime reader. No external
//! crate (walkdir/filetime) is pulled in — `File::set_modified` (stable since
//! Rust 1.75) covers timestamp preservation.

use std::fs;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Whether `path` is a symbolic link (or, on Windows, a junction) to a
/// directory. The walks below never descend into one: a link back to an
/// ancestor would recurse until the stack overflows (#173), and a link out of
/// the tree would pull in data that is not the user's legacy install.
pub fn is_linked_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) && path.is_dir()
}

/// Total size in bytes of a file or directory tree. Missing paths are 0.
/// Unreadable entries are skipped rather than aborting the walk.
pub fn size_of(path: &Path) -> u64 {
    if path.is_file() {
        return fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    if !path.is_dir() {
        return 0;
    }
    let mut total = 0u64;
    if let Ok(rd) = fs::read_dir(path) {
        for entry in rd.flatten() {
            let child = entry.path();
            if is_linked_dir(&child) {
                continue;
            }
            total = total.saturating_add(size_of(&child));
        }
    }
    total
}

/// Number of regular files under a file or directory tree (a file counts as 1).
pub fn count_files(path: &Path) -> usize {
    if path.is_file() {
        return 1;
    }
    if !path.is_dir() {
        return 0;
    }
    let mut n = 0usize;
    if let Ok(rd) = fs::read_dir(path) {
        for entry in rd.flatten() {
            let child = entry.path();
            if is_linked_dir(&child) {
                continue;
            }
            n += count_files(&child);
        }
    }
    n
}

/// Collect every regular file path under `root` (recursively). `root` itself is
/// included when it is a file. Order is directory-traversal order.
pub fn list_files(root: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    collect_files(root, &mut out);
    out
}

fn collect_files(path: &Path, out: &mut Vec<std::path::PathBuf>) {
    if path.is_file() {
        out.push(path.to_path_buf());
        return;
    }
    if let Ok(rd) = fs::read_dir(path) {
        for entry in rd.flatten() {
            let child = entry.path();
            if is_linked_dir(&child) {
                continue;
            }
            collect_files(&child, out);
        }
    }
}

/// Read a path's modification time, if available.
pub fn mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Modification time as epoch milliseconds (for cross-platform comparison and
/// serialisation). `None` when unavailable.
pub fn mtime_ms(path: &Path) -> Option<u64> {
    mtime(path).and_then(|t| {
        t.duration_since(UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis() as u64)
    })
}

/// Copy a single file verbatim (byte-for-byte), preserving its modification
/// time. Parent directories are created as needed. The destination is
/// overwritten if it exists.
pub fn copy_file_preserving_mtime(src: &Path, dst: &Path) -> io::Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    // Read the source mtime *before* the copy so a slow copy cannot change it.
    let src_mtime = mtime(src);
    fs::copy(src, dst)?;
    if let Some(t) = src_mtime {
        // Best-effort: a filesystem that refuses timestamp writes must not fail
        // the migration. The bytes are already copied.
        if let Ok(f) = fs::File::options().write(true).open(dst) {
            let _ = f.set_modified(t);
        }
    }
    Ok(())
}

/// Recursively copy a file or directory tree verbatim, preserving modification
/// times on every file. Directories are created as needed. Existing destination
/// files are overwritten (callers decide conflict policy before calling this).
pub fn copy_tree_preserving_mtime(src: &Path, dst: &Path) -> io::Result<()> {
    if src.is_file() {
        return copy_file_preserving_mtime(src, dst);
    }
    if !src.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("source not found: {}", src.display()),
        ));
    }
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let child_src = entry.path();
        let child_dst = dst.join(entry.file_name());
        if is_linked_dir(&child_src) {
            continue;
        }
        if child_src.is_dir() {
            copy_tree_preserving_mtime(&child_src, &child_dst)?;
        } else {
            copy_file_preserving_mtime(&child_src, &child_dst)?;
        }
    }
    Ok(())
}

/// Epoch-millisecond wall clock (used for manifest/lock timestamps).
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        f.write_all(bytes).unwrap();
    }

    /// A directory symlink back to the root. `None` where the platform will
    /// not let this process create one (Windows without developer mode).
    fn loop_link(root: &Path) -> Option<std::path::PathBuf> {
        let link = root.join("sub/loop");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(root, &link);
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(root, &link);
        made.ok().map(|_| link)
    }

    #[test]
    fn walks_do_not_follow_a_directory_link_back_to_an_ancestor() {
        let td = tempfile::tempdir().unwrap();
        let root = td.path();
        write(&root.join("a.txt"), b"1234");
        write(&root.join("sub/b.txt"), b"56789");
        let Some(link) = loop_link(root) else {
            return;
        };
        assert!(is_linked_dir(&link));
        assert_eq!(size_of(root), 9);
        assert_eq!(count_files(root), 2);
        assert_eq!(list_files(root).len(), 2);

        let out = tempfile::tempdir().unwrap();
        copy_tree_preserving_mtime(root, &out.path().join("copy")).unwrap();
        assert_eq!(count_files(&out.path().join("copy")), 2);
    }

    #[test]
    fn size_and_count_walk_tree() {
        let td = tempfile::tempdir().unwrap();
        let root = td.path();
        write(&root.join("a.txt"), b"1234");
        write(&root.join("sub/b.txt"), b"56789");
        assert_eq!(size_of(root), 9);
        assert_eq!(count_files(root), 2);
        assert_eq!(list_files(root).len(), 2);
    }

    #[test]
    fn copy_tree_is_verbatim_and_preserves_mtime() {
        let td = tempfile::tempdir().unwrap();
        let src = td.path().join("src");
        let dst = td.path().join("dst");
        write(&src.join("nested/data.bin"), b"\x00\x01\x02payload");
        // Age the source file well into the past.
        let past = UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        fs::File::options()
            .write(true)
            .open(src.join("nested/data.bin"))
            .unwrap()
            .set_modified(past)
            .unwrap();

        copy_tree_preserving_mtime(&src, &dst).unwrap();

        let copied = fs::read(dst.join("nested/data.bin")).unwrap();
        assert_eq!(copied, b"\x00\x01\x02payload");
        let got = mtime(&dst.join("nested/data.bin")).unwrap();
        // Allow a small tolerance for filesystem timestamp granularity.
        let delta = got.duration_since(past).unwrap_or_default().as_secs();
        assert!(delta < 2, "mtime not preserved (delta {delta}s)");
    }
}
