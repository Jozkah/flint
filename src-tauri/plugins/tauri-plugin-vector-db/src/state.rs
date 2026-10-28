use std::path::{Path, PathBuf};

pub struct VectorDBState {
    pub base_dir: PathBuf,
}

impl Default for VectorDBState {
    fn default() -> Self {
        Self::new()
    }
}

impl VectorDBState {
    /// State at the legacy per-user location ([`crate::db::default_base_dir`]).
    pub fn new() -> Self {
        Self::at(crate::db::default_base_dir())
    }

    /// State with collections under `base`, which is created if missing.
    pub fn at(base: PathBuf) -> Self {
        std::fs::create_dir_all(&base).ok();
        Self { base_dir: base }
    }
}

/// Marker left in the new folder once the legacy files were handled.
const MIGRATED_MARKER: &str = ".migrated-from-legacy";

fn is_db_file(name: &str) -> bool {
    name.ends_with(".db") || name.ends_with(".db-wal") || name.ends_with(".db-shm")
}

fn has_db(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_str().is_some_and(|n| n.ends_with(".db")))
    })
}

/// One-time move of the legacy databases (`*.db`, `-wal`, `-shm`) from `legacy`
/// into `new`. Runs only when `new` has no `.db` yet and legacy has some, and
/// never overwrites a file. Across volumes the file is copied, size-checked and
/// only then removed. With `copy_only` the legacy files stay put. Returns the
/// number of files brought across.
pub fn migrate_legacy_vector_db(
    legacy: &Path,
    new: &Path,
    copy_only: bool,
) -> std::io::Result<usize> {
    if legacy == new || new.join(MIGRATED_MARKER).exists() || has_db(new) || !has_db(legacy) {
        return Ok(0);
    }
    std::fs::create_dir_all(new)?;
    let mut moved = 0;
    for entry in std::fs::read_dir(legacy)?.filter_map(Result::ok) {
        let name = entry.file_name();
        let Some(name_str) = name.to_str().filter(|n| is_db_file(n)) else {
            continue;
        };
        let src = entry.path();
        let dst = new.join(name_str);
        if !src.is_file() || dst.exists() {
            continue;
        }
        if !copy_only && std::fs::rename(&src, &dst).is_ok() {
            moved += 1;
            continue;
        }
        std::fs::copy(&src, &dst)?;
        let same = std::fs::metadata(&src)?.len() == std::fs::metadata(&dst)?.len();
        if !same {
            let _ = std::fs::remove_file(&dst);
            return Err(std::io::Error::other(format!("copy of {name_str} was incomplete")));
        }
        if !copy_only {
            let _ = std::fs::remove_file(&src);
        }
        moved += 1;
    }
    std::fs::write(new.join(MIGRATED_MARKER), legacy.to_string_lossy().as_bytes())?;
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("flint-vdb-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn state_uses_given_base() {
        let root = scratch("base");
        let base = root.join("vectordb");
        let state = VectorDBState::at(base.clone());
        assert_eq!(state.base_dir, base);
        assert!(base.is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_files_are_migrated_once() {
        let root = scratch("once");
        let (legacy, new) = (root.join("legacy"), root.join("new"));
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("a.db"), b"aaa").unwrap();
        std::fs::write(legacy.join("a.db-wal"), b"w").unwrap();
        std::fs::write(legacy.join("notes.txt"), b"keep").unwrap();
        assert_eq!(migrate_legacy_vector_db(&legacy, &new, false).unwrap(), 2);
        assert_eq!(std::fs::read(new.join("a.db")).unwrap(), b"aaa");
        assert!(!legacy.join("a.db").exists());
        assert!(legacy.join("notes.txt").exists());
        assert!(new.join(MIGRATED_MARKER).exists());
        // A second run, even with fresh legacy files, does nothing.
        std::fs::write(legacy.join("b.db"), b"b").unwrap();
        assert_eq!(migrate_legacy_vector_db(&legacy, &new, false).unwrap(), 0);
        assert!(legacy.join("b.db").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migration_never_overwrites() {
        let root = scratch("nooverwrite");
        let (legacy, new) = (root.join("legacy"), root.join("new"));
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(legacy.join("a.db"), b"old").unwrap();
        std::fs::write(new.join("a.db"), b"new").unwrap();
        assert_eq!(migrate_legacy_vector_db(&legacy, &new, false).unwrap(), 0);
        assert_eq!(std::fs::read(new.join("a.db")).unwrap(), b"new");
        assert!(legacy.join("a.db").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn env_override_copies_not_moves() {
        let root = scratch("copy");
        let (legacy, new) = (root.join("legacy"), root.join("new"));
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("a.db"), b"aaa").unwrap();
        assert_eq!(migrate_legacy_vector_db(&legacy, &new, true).unwrap(), 1);
        assert!(legacy.join("a.db").exists(), "the real install keeps its database");
        assert_eq!(std::fs::read(new.join("a.db")).unwrap(), b"aaa");
        let _ = std::fs::remove_dir_all(&root);
    }
}
