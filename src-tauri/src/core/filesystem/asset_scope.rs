//! Runtime grants for the `asset:` protocol.
//!
//! `tauri.conf.json` allows only the standard user roots statically. The UI also
//! shows files from places outside them (other drives, a custom data folder), so
//! the webview asks for a grant per path before calling `convertFileSrc`.
//! Neither the native picker (`rfd`) nor the dialog plugin extends the asset
//! scope, so this command is the only path to such files.

use std::path::{Component, Path, PathBuf};
use tauri::Runtime;

/// Directory names that are never exposed, wherever they appear in the path.
const SENSITIVE_DIRS: &[&str] = &[".ssh", ".gnupg", ".aws", ".kube", ".azure"];

/// Strip the Windows verbatim prefix `canonicalize` adds so scope globs match.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\?\UNC\") {
        return PathBuf::from(format!(r"\{rest}"));
    }
    match s.strip_prefix(r"\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

/// Pure policy check on an already-canonical path. `Err` carries the reason.
pub fn check_asset_path(path: &Path, home: Option<&Path>, recursive: bool) -> Result<(), String> {
    if path.parent().is_none() {
        return Err("refusing to expose a filesystem root".into());
    }
    if let Some(home) = home {
        // Covers the profile itself and every ancestor (C:\Users, /home, ...).
        if home.starts_with(path) {
            return Err("refusing to expose the user profile root".into());
        }
    }

    let names: Vec<String> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(n) => Some(n.to_string_lossy().to_lowercase()),
            _ => None,
        })
        .collect();

    if let Some(hit) = names.iter().find(|n| SENSITIVE_DIRS.contains(&n.as_str())) {
        return Err(format!("refusing to expose sensitive folder {hit}"));
    }
    if names
        .windows(3)
        .any(|w| w[0] == "appdata" && w[1] == "roaming" && w[2] == "microsoft")
    {
        return Err("refusing to expose AppData/Roaming/Microsoft".into());
    }
    if recursive
        && names
            .last()
            .is_some_and(|n| n == "appdata" || n == "roaming")
    {
        return Err("refusing to recursively expose AppData".into());
    }
    if let Some(name) = names.last() {
        if name.starts_with("provider_secrets") {
            return Err("refusing to expose app secrets".into());
        }
    }
    Ok(())
}

/// Grant the webview `asset:` access to a user-chosen file or folder.
#[tauri::command]
pub fn allow_asset_path<R: Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    recursive: bool,
) -> Result<(), String> {
    use tauri::Manager;

    let canon = strip_verbatim(
        std::fs::canonicalize(&path).map_err(|e| format!("cannot resolve {path}: {e}"))?,
    );
    let meta = std::fs::metadata(&canon).map_err(|e| e.to_string())?;
    let home = app
        .path()
        .home_dir()
        .ok()
        .and_then(|h| std::fs::canonicalize(h).ok())
        .map(strip_verbatim);
    check_asset_path(&canon, home.as_deref(), recursive && meta.is_dir())?;

    let scope = app.asset_protocol_scope();
    if meta.is_dir() {
        scope
            .allow_directory(&canon, recursive)
            .map_err(|e| e.to_string())
    } else if meta.is_file() {
        scope.allow_file(&canon).map_err(|e| e.to_string())
    } else {
        Err("not a regular file or directory".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn refuses_roots_and_profile() {
        let home = p("/home/u");
        assert!(check_asset_path(&p("/"), Some(&home), true).is_err());
        assert!(check_asset_path(&p("/home"), Some(&home), true).is_err());
        assert!(check_asset_path(&home, Some(&home), false).is_err());
    }

    #[test]
    fn refuses_sensitive_folders_and_secrets() {
        let home = p("/home/u");
        assert!(check_asset_path(&p("/home/u/.ssh/id_rsa"), Some(&home), false).is_err());
        assert!(check_asset_path(&p("/home/u/.AWS"), Some(&home), true).is_err());
        assert!(check_asset_path(&p("/home/u/x/.gnupg/k"), Some(&home), false).is_err());
        assert!(
            check_asset_path(&p("/d/AppData/Roaming/Microsoft/Cr"), Some(&home), false).is_err()
        );
        assert!(
            check_asset_path(&p("/d/Flint/provider_secrets.json"), Some(&home), false).is_err()
        );
        assert!(check_asset_path(&p("/home/u/AppData"), Some(&home), true).is_err());
    }

    #[test]
    fn allows_ordinary_paths() {
        let home = p("/home/u");
        assert!(check_asset_path(&p("/mnt/data/pics"), Some(&home), true).is_ok());
        assert!(check_asset_path(&p("/home/u/Pictures/a.png"), Some(&home), false).is_ok());
        assert!(check_asset_path(
            &p("/home/u/AppData/Roaming/Flint/x.png"),
            Some(&home),
            false
        )
        .is_ok());
    }

    #[test]
    fn strips_verbatim_prefix() {
        assert_eq!(strip_verbatim(p(r"\?\D:\a\b")), p(r"D:\a\b"));
        assert_eq!(strip_verbatim(p(r"\?\UNC\srv\share")), p(r"\srv\share"));
    }
}
