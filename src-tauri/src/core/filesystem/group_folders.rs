//! Folder inspection for conversation groups.
//!
//! A group folder is organizational context only. This command resolves a
//! picked path to a canonical form (following junctions and symlinks) and
//! reports whether it is currently reachable. It never lists or reads folder
//! contents and never grants access: grants still go through the agent-tools
//! access flow, with its own canonicalization, protected-path refusals and
//! audit.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroupFolderInfo {
    /// The path as picked.
    pub path: String,
    /// Symlinks and junctions resolved, `\\?\` prefixes removed. When the
    /// folder is unreachable this is the lexically normalized path.
    pub canonical_path: String,
    pub display_name: String,
    /// False when missing, moved, not a directory, or not accessible.
    pub available: bool,
    /// `local`, `unc` (network share) or `link` (resolved through a
    /// symlink/junction to a different location).
    pub kind: String,
}

/// Removes Windows verbatim prefixes so canonical paths compare and display
/// like the paths users pick.
pub fn strip_verbatim(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// Resolves `.` and `..` without touching the filesystem.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn is_unc(path: &str) -> bool {
    path.starts_with(r"\\") || path.starts_with("//")
}

fn display_name_of(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

pub fn inspect(path: &str) -> Result<GroupFolderInfo, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Folder path is empty".into());
    }
    let picked = Path::new(trimmed);
    if !picked.is_absolute() && !is_unc(trimmed) {
        return Err("Folder path must be absolute".into());
    }
    let lexical = strip_verbatim(&lexical_normalize(picked).to_string_lossy());

    // `metadata` follows links; it stats the target without listing it.
    let reachable_dir = std::fs::metadata(picked).map(|m| m.is_dir()).unwrap_or(false);
    let (canonical, available) = if reachable_dir {
        match std::fs::canonicalize(picked) {
            Ok(c) => (strip_verbatim(&c.to_string_lossy()), true),
            Err(_) => (lexical.clone(), false),
        }
    } else {
        (lexical.clone(), false)
    };

    let is_link = std::fs::symlink_metadata(picked)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
        || (available && !same_path(&canonical, &lexical));
    let kind = if is_unc(&canonical) {
        "unc"
    } else if is_link {
        "link"
    } else {
        "local"
    };

    Ok(GroupFolderInfo {
        path: trimmed.to_string(),
        display_name: display_name_of(&canonical),
        canonical_path: canonical,
        available,
        kind: kind.into(),
    })
}

fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_string();
    if cfg!(windows) {
        norm(a).eq_ignore_ascii_case(&norm(b))
    } else {
        norm(a) == norm(b)
    }
}

/// Inspects folders for a conversation group. Read-only metadata; never
/// grants access and never reads directory contents.
#[tauri::command]
pub async fn inspect_group_folders(paths: Vec<String>) -> Vec<Result<GroupFolderInfo, String>> {
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|p| inspect(p)).collect())
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_verbatim_prefixes() {
        assert_eq!(strip_verbatim(r"\\?\C:\Work"), r"C:\Work");
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\share"), r"\\srv\share");
        assert_eq!(strip_verbatim("/home/a"), "/home/a");
    }

    #[test]
    fn existing_folder_is_available_and_canonical() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("..").join("a");
        std::fs::create_dir_all(dir.path().join("a")).unwrap();
        let info = inspect(&nested.to_string_lossy()).unwrap();
        assert!(info.available);
        assert_eq!(info.display_name, "a");
        assert!(!info.canonical_path.starts_with(r"\\?\"));
        assert!(!info.canonical_path.contains(".."));
    }

    #[test]
    fn missing_folder_is_kept_but_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("moved-away");
        let info = inspect(&gone.to_string_lossy()).unwrap();
        assert!(!info.available);
        assert_eq!(info.display_name, "moved-away");
    }

    #[test]
    fn file_is_not_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("f.txt");
        std::fs::write(&f, "x").unwrap();
        assert!(!inspect(&f.to_string_lossy()).unwrap().available);
    }

    #[test]
    fn rejects_relative_and_empty() {
        assert!(inspect("").is_err());
        assert!(inspect("relative/dir").is_err());
    }

    #[test]
    fn unc_paths_are_classified() {
        let info = inspect(r"\\nonexistent-host-for-test\share\proj").unwrap();
        assert_eq!(info.kind, "unc");
        assert_eq!(info.display_name, "proj");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_resolves_to_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        std::fs::create_dir(&target).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let info = inspect(&link.to_string_lossy()).unwrap();
        assert!(info.available);
        assert_eq!(info.kind, "link");
        assert!(info.canonical_path.ends_with("target"));
    }

    #[cfg(windows)]
    #[test]
    fn junction_resolves_to_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        std::fs::create_dir(&target).unwrap();
        let link = dir.path().join("junction");
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            return; // mklink unavailable in this environment
        }
        let info = inspect(&link.to_string_lossy()).unwrap();
        assert!(info.available);
        assert_eq!(info.kind, "link");
        assert!(info.canonical_path.to_lowercase().ends_with("target"));
    }
}
