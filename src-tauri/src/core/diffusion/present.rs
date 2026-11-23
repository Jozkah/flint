//! Whether a model file is already where Studio expects it.
//!
//! A file whose size differs from the catalog's is not necessarily wrong: a
//! person who copies a model in by hand may have the right bytes, and sizes can
//! differ in how they were recorded. Only the catalog's sha256 pin settles it.
//! A file that fails that check is moved aside, never deleted.

use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

/// What was found at a model file's path.
#[derive(Debug, PartialEq, Eq)]
pub enum Settled {
    /// Usable as it is (right size, or its sha256 matches the pin).
    Ready,
    /// Nothing there: download it.
    Missing,
    /// A different file was there; it now lives at this path.
    MovedAside(PathBuf),
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

/// Beside the file: records that this exact file (by size) was checked against
/// the pin, so the catalog's size not matching is not asked again.
fn marker_path(path: &Path) -> PathBuf {
    with_suffix(path, ".sha256-ok")
}

fn marker_text(sha256: &str, len: u64) -> String {
    format!("{} {}", sha256.to_ascii_lowercase(), len)
}

/// Present at the catalog's size, or verified by hash at the size it has.
pub fn file_ready(path: &Path, size: u64, sha256: &str) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if meta.len() == size {
        return true;
    }
    !sha256.is_empty()
        && std::fs::read_to_string(marker_path(path))
            .map(|t| t.trim() == marker_text(sha256, meta.len()))
            .unwrap_or(false)
}

/// Streaming sha256 of a file; `progress(done, total)` is called as it goes.
pub fn sha256_of(path: &Path, mut progress: impl FnMut(u64, u64)) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let total = file.metadata()?.len();
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut done = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        done += n as u64;
        progress(done, total);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// First free `<name>.mismatch`, `<name>.mismatch.1`, ...
fn mismatch_path(path: &Path) -> PathBuf {
    let first = with_suffix(path, ".mismatch");
    if !first.exists() {
        return first;
    }
    (1u32..)
        .map(|i| with_suffix(path, &format!(".mismatch.{i}")))
        .find(|p| !p.exists())
        .expect("an unused name exists")
}

/// Decide what to do about whatever is at `path`. Blocking: hashes the file.
/// `allow_move` is false for a file the person pointed Studio at in place.
pub fn settle_existing(
    path: &Path,
    size: u64,
    sha256: &str,
    allow_move: bool,
    progress: impl FnMut(u64, u64),
) -> Result<Settled, String> {
    let Ok(meta) = std::fs::metadata(path) else { return Ok(Settled::Missing) };
    if !meta.is_file() {
        return Ok(Settled::Missing);
    }
    if file_ready(path, size, sha256) {
        return Ok(Settled::Ready);
    }
    if !sha256.is_empty() {
        let actual = sha256_of(path, progress)
            .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
        if actual.eq_ignore_ascii_case(sha256) {
            let _ = std::fs::write(marker_path(path), marker_text(sha256, meta.len()));
            return Ok(Settled::Ready);
        }
    }
    if !allow_move {
        return Ok(Settled::Missing);
    }
    let to = mismatch_path(path);
    std::fs::rename(path, &to)
        .map_err(|e| format!("Could not move {} aside: {e}", path.display()))?;
    let _ = std::fs::remove_file(marker_path(path));
    Ok(Settled::MovedAside(to))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BYTES: &[u8] = b"studio model bytes";

    fn sha() -> String {
        hex::encode(Sha256::digest(BYTES))
    }

    fn put(dir: &Path, bytes: &[u8]) -> PathBuf {
        let p = dir.join("m.gguf");
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn a_missing_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let r = settle_existing(&dir.path().join("m.gguf"), 5, &sha(), true, |_, _| {});
        assert_eq!(r.unwrap(), Settled::Missing);
    }

    #[test]
    fn the_catalog_size_is_ready_without_hashing() {
        let dir = tempfile::tempdir().unwrap();
        let p = put(dir.path(), BYTES);
        let r = settle_existing(&p, BYTES.len() as u64, "", true, |_, _| panic!("hashed"));
        assert_eq!(r.unwrap(), Settled::Ready);
    }

    #[test]
    fn a_different_size_with_the_pinned_hash_is_accepted_once() {
        let dir = tempfile::tempdir().unwrap();
        let p = put(dir.path(), BYTES);
        assert!(!file_ready(&p, 999, &sha()));
        let mut seen = 0;
        let r = settle_existing(&p, 999, &sha(), true, |done, total| {
            seen = done;
            assert_eq!(total, BYTES.len() as u64);
        });
        assert_eq!(r.unwrap(), Settled::Ready);
        assert_eq!(seen, BYTES.len() as u64);
        assert!(p.exists());
        // Remembered: no second hash, and the model counts as installed.
        assert!(file_ready(&p, 999, &sha()));
        let again = settle_existing(&p, 999, &sha(), true, |_, _| panic!("hashed twice"));
        assert_eq!(again.unwrap(), Settled::Ready);
    }

    #[test]
    fn the_accepted_mark_does_not_survive_the_file_changing() {
        let dir = tempfile::tempdir().unwrap();
        let p = put(dir.path(), BYTES);
        settle_existing(&p, 999, &sha(), true, |_, _| {}).unwrap();
        std::fs::write(&p, b"other bytes, other length").unwrap();
        assert!(!file_ready(&p, 999, &sha()));
    }

    #[test]
    fn a_different_file_is_moved_aside_not_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let p = put(dir.path(), b"somebody's own file");
        let Settled::MovedAside(to) = settle_existing(&p, 999, &sha(), true, |_, _| {}).unwrap() else {
            panic!("expected the file to be moved aside");
        };
        assert!(!p.exists());
        assert_eq!(to.file_name().unwrap(), "m.gguf.mismatch");
        assert_eq!(std::fs::read(&to).unwrap(), b"somebody's own file");
    }

    #[test]
    fn an_earlier_mismatch_copy_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let p = put(dir.path(), b"first");
        settle_existing(&p, 999, &sha(), true, |_, _| {}).unwrap();
        put(dir.path(), b"second");
        let Settled::MovedAside(to) = settle_existing(&p, 999, &sha(), true, |_, _| {}).unwrap() else {
            panic!("expected the file to be moved aside");
        };
        assert_eq!(to.file_name().unwrap(), "m.gguf.mismatch.1");
        assert_eq!(std::fs::read(dir.path().join("m.gguf.mismatch")).unwrap(), b"first");
        assert_eq!(std::fs::read(&to).unwrap(), b"second");
    }

    #[test]
    fn a_file_in_place_is_never_moved() {
        let dir = tempfile::tempdir().unwrap();
        let p = put(dir.path(), b"mine");
        let r = settle_existing(&p, 999, &sha(), false, |_, _| {});
        assert_eq!(r.unwrap(), Settled::Missing);
        assert!(p.exists());
    }
}
