//! Path normalisation for comparing two paths that may be spelled differently.
//!
//! `Path::canonicalize` on Windows returns the verbatim form (`\\?\C:\x`,
//! `\\?\UNC\srv\sh`), which never compares equal to the plain spelling of the
//! same folder. Both sides of a containment check go through
//! `normalize_for_compare` so they use one spelling.

use std::path::{Path, PathBuf};

/// `\\?\C:\x` becomes `C:\x` and `\\?\UNC\srv\sh` becomes `\\srv\sh`; any other
/// string is returned unchanged.
pub(crate) fn strip_verbatim(s: &str) -> String {
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.to_string()
    }
}

/// The canonical form of `p` (symlinks resolved when it exists) without the
/// verbatim prefix, lowercased on Windows, for comparing against another path
/// normalised the same way.
pub(crate) fn normalize_for_compare(p: &Path) -> PathBuf {
    let canonical = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let text = strip_verbatim(&canonical.to_string_lossy());
    #[cfg(windows)]
    let text = text.to_lowercase();
    PathBuf::from(text)
}

/// True when either path is inside the other (or they are the same folder).
pub(crate) fn overlaps(a: &Path, b: &Path) -> bool {
    let (a, b) = (normalize_for_compare(a), normalize_for_compare(b));
    a.starts_with(&b) || b.starts_with(&a)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_verbatim_drive() {
        assert_eq!(strip_verbatim(r"\\?\C:\Users\me"), r"C:\Users\me");
    }

    #[test]
    fn strip_verbatim_unc() {
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\sh\x"), r"\\srv\sh\x");
        assert_eq!(strip_verbatim("/plain/path"), "/plain/path");
    }

    #[test]
    fn overlap_detected_for_nested_and_same_folder() {
        let dir = tempfile::tempdir().unwrap();
        let child = dir.path().join("child");
        std::fs::create_dir(&child).unwrap();
        assert!(overlaps(dir.path(), &child));
        assert!(overlaps(&child, dir.path()));
        assert!(overlaps(dir.path(), dir.path()));
    }

    #[test]
    fn non_overlap_allowed() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        assert!(!overlaps(a.path(), b.path()));
    }
}
