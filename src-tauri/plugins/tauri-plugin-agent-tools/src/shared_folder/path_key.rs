//! The spelling two paths are compared by when deciding whether sessions
//! share a folder or a file.

use std::path::{Path, PathBuf};

/// `\\?\C:\x` -> `C:\x`, `\\?\UNC\h\s` -> `\\h\s`. Other text is unchanged.
pub fn strip_verbatim(text: &str) -> String {
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    if let Some(plain) = text.strip_prefix(r"\\?\") {
        return plain.to_string();
    }
    if let Some(unc) = text.strip_prefix("//?/UNC/") {
        return format!("//{unc}");
    }
    if let Some(plain) = text.strip_prefix("//?/") {
        return plain.to_string();
    }
    text.to_string()
}

fn windows_style(text: &str) -> bool {
    let b = text.as_bytes();
    (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') || text.starts_with("//")
}

/// The string half of [`folder_key`]: verbatim prefix gone, `/` separators, no
/// trailing separator, lower case for Windows spellings (a drive letter or a
/// UNC share) or when `fold` is set.
pub fn normalize_text(text: &str, fold: bool) -> String {
    let plain = strip_verbatim(text.trim());
    let mut unified = plain.replace('\\', "/");
    while unified.len() > 1 && unified.ends_with('/') && !unified.ends_with(":/") {
        unified.pop();
    }
    if fold || windows_style(&unified) {
        unified.to_lowercase()
    } else {
        unified
    }
}

/// Canonical form of `path` even when its tail does not exist yet: the nearest
/// existing ancestor is canonicalized (symlinks resolved, 8.3 names expanded)
/// and the rest is appended as written.
pub(crate) fn canonical_lenient(path: &Path) -> PathBuf {
    if let Ok(real) = path.canonicalize() {
        return real;
    }
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = path.to_path_buf();
    loop {
        if let Ok(real) = cursor.canonicalize() {
            let mut out = real;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (cursor.parent(), cursor.file_name()) {
            (Some(parent), Some(name)) if !parent.as_os_str().is_empty() => {
                tail.push(name.to_os_string());
                cursor = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// The key sessions are grouped by: equal for every spelling of one folder.
pub fn folder_key(path: &Path) -> String {
    normalize_text(&canonical_lenient(path).to_string_lossy(), cfg!(windows))
}

/// The key of a file, same rules as [`folder_key`].
pub fn file_key(path: &Path) -> String {
    folder_key(path)
}

/// Is `inner` the folder `outer` or below it? Both are keys.
pub fn key_inside(outer: &str, inner: &str) -> bool {
    !outer.is_empty()
        && (inner == outer
            || inner
                .strip_prefix(outer)
                .is_some_and(|rest| rest.starts_with('/') || outer.ends_with('/')))
}

/// `file` shown relative to `folder` (both keys or plain paths) when inside it.
pub fn relative_to(folder_key_text: &str, file: &str) -> String {
    let file = file.replace('\\', "/");
    let folder = folder_key_text.replace('\\', "/");
    let head = file.get(..folder.len());
    if head.is_some_and(|h| h.eq_ignore_ascii_case(&folder))
        && file.len() > folder.len()
        && file.as_bytes()[folder.len()] == b'/'
    {
        return file[folder.len()..].trim_start_matches('/').to_string();
    }
    file
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_prefix_is_stripped() {
        assert_eq!(strip_verbatim(r"\\?\C:\Users\a"), r"C:\Users\a");
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\share\x"), r"\\srv\share\x");
        assert_eq!(strip_verbatim("/home/a"), "/home/a");
    }

    #[test]
    fn windows_spellings_are_one_key() {
        let a = normalize_text(r"\\?\C:\Users\Joe\Repo\", false);
        let b = normalize_text("c:/users/joe/repo", false);
        let c = normalize_text(r"C:\USERS\joe\REPO", false);
        assert_eq!(a, b);
        assert_eq!(b, c);
    }

    #[test]
    fn posix_case_is_kept_unless_folded() {
        assert_ne!(normalize_text("/Home/A", false), normalize_text("/home/a", false));
        assert_eq!(normalize_text("/Home/A", true), normalize_text("/home/a", false));
    }

    #[test]
    fn trailing_separators_and_roots() {
        assert_eq!(normalize_text("/a/b///", false), "/a/b");
        assert_eq!(normalize_text("/", false), "/");
        assert_eq!(normalize_text(r"C:\", false), "c:/");
    }

    #[test]
    fn unc_is_folded() {
        assert_eq!(normalize_text(r"\\SRV\Share\X", false), "//srv/share/x");
    }

    #[test]
    fn inside_means_a_whole_component() {
        assert!(key_inside("/a/b", "/a/b"));
        assert!(key_inside("/a/b", "/a/b/c"));
        assert!(!key_inside("/a/b", "/a/bc"));
        assert!(!key_inside("", "/a"));
    }

    #[test]
    fn relative_display() {
        assert_eq!(relative_to("c:/r", r"C:\r\src\a.ts"), "src/a.ts");
        assert_eq!(relative_to("/r", "/other/a.ts"), "/other/a.ts");
        assert_eq!(relative_to("/r", "/rx/a.ts"), "/rx/a.ts");
    }

    #[test]
    fn real_folder_with_dot_segments_and_case() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("Repo");
        std::fs::create_dir(&real).unwrap();
        let dotted = dir.path().join("Repo").join("..").join("Repo");
        assert_eq!(folder_key(&real), folder_key(&dotted));
        if cfg!(windows) {
            let swapped = dir.path().join("rEPO");
            assert_eq!(folder_key(&real), folder_key(&swapped));
        }
    }

    #[test]
    fn a_missing_tail_keeps_the_resolved_head() {
        let dir = tempfile::tempdir().unwrap();
        let ghost = dir.path().join("new").join("file.txt");
        let key = folder_key(&ghost);
        assert!(key.ends_with("/new/file.txt"), "{key}");
        assert_eq!(
            key.strip_suffix("/new/file.txt").unwrap(),
            folder_key(dir.path())
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_resolves_to_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(folder_key(&real), folder_key(&link));
        assert_eq!(folder_key(&real.join("f")), folder_key(&link.join("f")));
    }

    /// The 8.3 name of an existing folder, through the shell (test only).
    #[cfg(windows)]
    fn short_name(path: &Path) -> Option<String> {
        let out = std::process::Command::new("cmd")
            .args(["/C", "for", "%I", "in"])
            .arg(format!("(\"{}\")", path.display()))
            .args(["do", "@echo", "%~sI"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!text.is_empty()).then_some(text)
    }

    #[cfg(windows)]
    #[test]
    fn a_short_name_is_the_long_name() {
        let dir = tempfile::tempdir().unwrap();
        let long = dir.path().join("A Long Folder Name For Sharing");
        std::fs::create_dir(&long).unwrap();
        let Some(short) = short_name(&long) else { return };
        if short.to_lowercase().contains("a long folder") {
            return; // 8.3 generation is off on this volume
        }
        assert_eq!(folder_key(&long), folder_key(Path::new(&short)));
        let child = long.join("f.txt");
        std::fs::write(&child, "x").unwrap();
        assert_eq!(
            file_key(&child),
            file_key(&Path::new(&short).join("f.txt"))
        );
    }
}
