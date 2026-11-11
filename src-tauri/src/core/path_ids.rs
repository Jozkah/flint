//! Checks for ids that a client sends and the app turns into a path.
//!
//! Windows quietly drops trailing dots and spaces from a path component, so
//! `threads\...` is opened as `threads\` and `threads\abc.` as `threads\abc`.
//! An id that the filesystem rewrites like that can alias another entry or,
//! fed to a recursive delete, remove the whole parent folder. Device names
//! (`CON`, `NUL`, `COM1`...) and `:` (alternate data streams) are just as
//! surprising. These checks run on every platform so an id that is safe on
//! one is safe on all.

use std::io;
use std::path::{Path, PathBuf};

/// True for a Windows device name such as `CON`, `nul.txt` or `COM1.log`,
/// which open the device rather than a file in the folder.
pub fn is_windows_reserved_name(name: &str) -> bool {
    let base = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
    let upper = base.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ((upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.len() == 4
            && matches!(upper.as_bytes()[3], b'1'..=b'9'))
}

/// Refuse a name that is not one plain, unambiguous path component: empty,
/// `.`/`..`, ending in a dot or space, a device name, or holding a separator,
/// `:` or a control character. `kind` names the id in the error.
pub fn validate_path_id(kind: &str, id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && !id.ends_with(['.', ' '])
        && !id.contains(['/', '\\', ':'])
        && !id.chars().any(char::is_control)
        && !is_windows_reserved_name(id);
    if ok {
        Ok(())
    } else {
        Err(format!("invalid {kind} {id:?}"))
    }
}

/// Recursively remove `target`, but only when it resolves to a folder strictly
/// inside `base`. Never removes `base` itself or anything outside it, whatever
/// the id that built `target` turned out to mean on this filesystem. A target
/// that does not exist is not an error.
pub fn remove_dir_within(base: &Path, target: &Path) -> io::Result<()> {
    let resolved = match contained(base, target) {
        Ok(path) => path,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    std::fs::remove_dir_all(resolved)
}

/// `target` canonicalised, when it is a strict descendant of `base`.
pub fn contained(base: &Path, target: &Path) -> io::Result<PathBuf> {
    let target = std::fs::canonicalize(target)?;
    let base = std::fs::canonicalize(base)?;
    if target != base && target.starts_with(&base) {
        Ok(target)
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to remove a folder that is not inside its expected parent",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dangerous_shapes_are_refused() {
        for id in [
            "", ".", "..", "...", "....", "abc.", "abc ", " ", "a/b", "a\\b", "a:b",
            "x:stream", "a\u{0}b", "a\nb", "CON", "con", "nul.txt", "COM1", "lpt9.log",
            "AUX", "PRN.json", "CON .txt",
        ] {
            assert!(validate_path_id("id", id).is_err(), "{id:?} should be refused");
        }
    }

    #[test]
    fn ids_the_app_generates_still_pass() {
        for id in [
            "jan", "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", "thread_1", "a.b", ".hidden",
            "My Assistant", "COM10", "CONSOLE", "com0", "élan",
        ] {
            assert!(validate_path_id("id", id).is_ok(), "{id:?} should pass");
        }
    }

    #[test]
    fn remove_dir_within_refuses_the_base_and_outside() {
        let root = std::env::temp_dir().join(format!("flint-path-ids-{}", std::process::id()));
        let base = root.join("threads");
        let inner = base.join("t1");
        let outside = root.join("other");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        assert!(remove_dir_within(&base, &base).is_err());
        assert!(remove_dir_within(&base, &base.join(".")).is_err());
        assert!(remove_dir_within(&base, &base.join("..").join("other")).is_err());
        assert!(base.exists() && outside.exists());
        // On Windows `threads\...` resolves to `threads` itself.
        if cfg!(windows) {
            assert!(remove_dir_within(&base, &base.join("...")).is_err());
            assert!(base.exists());
        }
        remove_dir_within(&base, &base.join("missing")).unwrap();
        remove_dir_within(&base, &inner).unwrap();
        assert!(!inner.exists() && base.exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
