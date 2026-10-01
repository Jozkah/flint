//! `open_session_path`: open or reveal a path from a reply, but only when it
//! lies inside a folder the session holds.
//!
//! The frontend decides which paths to *offer* as links; this is the boundary
//! that decides what may actually be handed to the OS. Both the roots and the
//! path are canonicalized (symlinks and junctions followed, `..` resolved,
//! Windows verbatim prefix stripped the same way for both) and compared
//! component by component, so `/work/proj2` is not inside `/work/proj`, a link
//! inside the folder that points outside is refused, and drive letters and
//! UNC names compare case-insensitively on Windows.
//!
//! Flint's own data folder (logs, the memory store, session sandboxes,
//! artifacts, worktrees) is always allowed, and the backend derives it itself:
//! a caller opening one of those passes no roots at all, so a compromised
//! webview cannot widen what the app-owned callers may reach. `roots` only
//! carries the user's own attached folders.
//!
//! Executables are never launched: `open` of one is refused, `reveal` (show in
//! the file manager) is allowed.

use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

/// Opening these would run code, so they can only be revealed.
const EXECUTABLE_EXTS: &[&str] = &[
    "exe", "bat", "cmd", "ps1", "lnk", "msi", "sh", "app", "com", "scr",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenMode {
    Open,
    Reveal,
}

fn is_executable(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| EXECUTABLE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Canonicalize and drop the `\\?\` verbatim prefix so a root and a path
/// always compare in the same spelling.
fn canonical(path: &Path) -> Option<PathBuf> {
    let canon = std::fs::canonicalize(path).ok()?;
    Some(strip_verbatim(canon))
}

fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

fn key(component: Component<'_>) -> String {
    let text = component.as_os_str().to_string_lossy().into_owned();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// Is `path` equal to or below `root`? Whole components, never a string prefix.
fn contained(root: &Path, path: &Path) -> bool {
    let root_keys: Vec<String> = root.components().map(key).collect();
    let path_keys: Vec<String> = path.components().map(key).collect();
    // A filesystem root (`/`, `C:\`) would contain everything: never a root.
    let normals = root
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count();
    if normals == 0 {
        return false;
    }
    path_keys.len() >= root_keys.len() && path_keys[..root_keys.len()] == root_keys[..]
}

/// The canonical path to hand the OS, or why it was refused.
pub fn resolve_session_path(
    roots: &[String],
    path: &str,
    mode: OpenMode,
) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("empty path".into());
    }
    let requested = Path::new(path.trim());
    if !requested.is_absolute() {
        return Err("path must be absolute".into());
    }
    let target = canonical(requested).ok_or_else(|| "path does not exist".to_string())?;
    let allowed = roots
        .iter()
        .filter(|r| Path::new(r.trim()).is_absolute())
        .filter_map(|r| canonical(Path::new(r.trim())))
        .any(|root| contained(&root, &target));
    if !allowed {
        return Err("path is outside the session folders".into());
    }
    if mode == OpenMode::Open && (is_executable(requested) || is_executable(&target)) {
        return Err("executables can only be revealed, not opened".into());
    }
    Ok(target)
}

/// The roots a request may use: the caller's folders plus Flint's data folder.
pub fn allowed_roots(caller: &[String], data_folder: &Path) -> Vec<String> {
    let mut all: Vec<String> = caller.to_vec();
    all.push(data_folder.to_string_lossy().into_owned());
    all
}

/// Open or reveal `path` when it is inside one of `roots` (the user's attached
/// folders) or Flint's own data folder. The webview never gets to name an
/// arbitrary path.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn open_session_path<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    roots: Vec<String>,
    path: String,
    mode: OpenMode,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let data_folder = crate::core::app::commands::get_jan_data_folder_path(app.clone());
    let roots = allowed_roots(&roots, &data_folder);
    let target = tauri::async_runtime::spawn_blocking(move || {
        resolve_session_path(&roots, &path, mode)
    })
    .await
    .map_err(|e| e.to_string())??;
    match mode {
        OpenMode::Open => app
            .opener()
            .open_path(target.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string()),
        OpenMode::Reveal => app
            .opener()
            .reveal_item_in_dir(&target)
            .map_err(|e| e.to_string()),
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn open_session_path(
    _roots: Vec<String>,
    _path: String,
    _mode: OpenMode,
) -> Result<(), String> {
    Err("not supported on mobile".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Fixture {
        _dir: tempfile::TempDir,
        proj: PathBuf,
        sibling: PathBuf,
        outside: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("work");
        let proj = base.join("proj");
        let sibling = base.join("proj2");
        let outside = base.join("secret");
        for d in [&proj, &sibling, &outside, &proj.join("src")] {
            fs::create_dir_all(d).unwrap();
        }
        fs::write(proj.join("src").join("a.ts"), "x").unwrap();
        fs::write(proj.join("run.exe"), "x").unwrap();
        fs::write(proj.join("tool.SH"), "x").unwrap();
        fs::write(sibling.join("a.ts"), "x").unwrap();
        fs::write(outside.join("s.txt"), "x").unwrap();
        Fixture { _dir: dir, proj, sibling, outside }
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn allows_files_and_folders_inside_a_root() {
        let f = fixture();
        let roots = vec![s(&f.proj)];
        assert!(resolve_session_path(&roots, &s(&f.proj.join("src").join("a.ts")), OpenMode::Open).is_ok());
        assert!(resolve_session_path(&roots, &s(&f.proj.join("src")), OpenMode::Open).is_ok());
        assert!(resolve_session_path(&roots, &s(&f.proj), OpenMode::Reveal).is_ok());
    }

    #[test]
    fn refuses_a_sibling_that_shares_the_prefix() {
        let f = fixture();
        let roots = vec![s(&f.proj)];
        assert!(resolve_session_path(&roots, &s(&f.sibling.join("a.ts")), OpenMode::Open).is_err());
    }

    #[test]
    fn refuses_dot_dot_escape_but_allows_one_that_stays_inside() {
        let f = fixture();
        let roots = vec![s(&f.proj)];
        let escape = format!("{}{}..{}secret{}s.txt", s(&f.proj), std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR);
        assert!(resolve_session_path(&roots, &escape, OpenMode::Open).is_err());
        let inside = format!("{}{}src{}..{}src{}a.ts", s(&f.proj), std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR);
        assert!(resolve_session_path(&roots, &inside, OpenMode::Open).is_ok());
    }

    #[test]
    fn refuses_relative_missing_and_empty_paths() {
        let f = fixture();
        let roots = vec![s(&f.proj)];
        assert!(resolve_session_path(&roots, "src/a.ts", OpenMode::Open).is_err());
        assert!(resolve_session_path(&roots, &s(&f.proj.join("nope.ts")), OpenMode::Open).is_err());
        assert!(resolve_session_path(&roots, "  ", OpenMode::Open).is_err());
    }

    #[test]
    fn never_trusts_a_filesystem_root_or_missing_root() {
        let f = fixture();
        let fs_root = f.proj.ancestors().last().unwrap().to_path_buf();
        assert!(resolve_session_path(&[s(&fs_root)], &s(&f.outside.join("s.txt")), OpenMode::Open).is_err());
        assert!(resolve_session_path(&[], &s(&f.proj), OpenMode::Open).is_err());
        assert!(resolve_session_path(&["relative".into()], &s(&f.proj), OpenMode::Open).is_err());
    }

    #[test]
    fn executables_are_reveal_only() {
        let f = fixture();
        let roots = vec![s(&f.proj)];
        for name in ["run.exe", "tool.SH"] {
            let p = s(&f.proj.join(name));
            assert!(resolve_session_path(&roots, &p, OpenMode::Open).is_err(), "{name}");
            assert!(resolve_session_path(&roots, &p, OpenMode::Reveal).is_ok(), "{name}");
        }
    }

    #[test]
    fn the_data_folder_is_always_allowed_and_nothing_else_is_added() {
        let f = fixture();
        // App-owned callers pass no roots: the backend's data folder decides.
        let roots = allowed_roots(&[], &f.proj);
        assert!(resolve_session_path(&roots, &s(&f.proj.join("src").join("a.ts")), OpenMode::Open).is_ok());
        assert!(resolve_session_path(&roots, &s(&f.proj), OpenMode::Reveal).is_ok());
        assert!(resolve_session_path(&roots, &s(&f.sibling.join("a.ts")), OpenMode::Open).is_err());
        assert!(resolve_session_path(&roots, &s(&f.outside), OpenMode::Reveal).is_err());
    }

    #[test]
    fn app_owned_executables_are_still_reveal_only() {
        let f = fixture();
        let roots = allowed_roots(&[], &f.proj);
        let exe = s(&f.proj.join("run.exe"));
        assert!(resolve_session_path(&roots, &exe, OpenMode::Open).is_err());
        assert!(resolve_session_path(&roots, &exe, OpenMode::Reveal).is_ok());
    }

    #[test]
    fn a_link_out_of_the_data_folder_is_refused() {
        let f = fixture();
        let link = f.proj.join("escape");
        if !make_dir_link(&f.outside, &link) {
            eprintln!("skipping: cannot create a symlink or junction here");
            return;
        }
        let roots = allowed_roots(&[], &f.proj);
        assert!(resolve_session_path(&roots, &s(&link.join("s.txt")), OpenMode::Reveal).is_err());
    }

    #[test]
    fn any_of_several_roots_will_do() {
        let f = fixture();
        let roots = vec![s(&f.sibling), s(&f.proj)];
        assert!(resolve_session_path(&roots, &s(&f.proj.join("src").join("a.ts")), OpenMode::Open).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_compare_case_insensitively() {
        let f = fixture();
        let roots = vec![s(&f.proj).to_uppercase()];
        let p = s(&f.proj.join("src").join("a.ts")).to_lowercase();
        assert!(resolve_session_path(&roots, &p, OpenMode::Open).is_ok());
    }

    #[test]
    fn verbatim_prefixes_are_stripped() {
        assert_eq!(strip_verbatim(PathBuf::from(r"\\?\C:\a\b")), PathBuf::from(r"C:\a\b"));
        assert_eq!(strip_verbatim(PathBuf::from(r"\\?\UNC\srv\share\x")), PathBuf::from(r"\\srv\share\x"));
        assert_eq!(strip_verbatim(PathBuf::from("/a/b")), PathBuf::from("/a/b"));
    }

    /// A link inside the folder that points outside must not be a way out.
    /// Skipped where the OS will not let this account create the link.
    #[test]
    fn refuses_a_link_that_escapes_the_root() {
        let f = fixture();
        let link = f.proj.join("escape");
        let made = make_dir_link(&f.outside, &link);
        if !made {
            eprintln!("skipping: cannot create a symlink or junction here");
            return;
        }
        let roots = vec![s(&f.proj)];
        assert!(resolve_session_path(&roots, &s(&link.join("s.txt")), OpenMode::Open).is_err());
        assert!(resolve_session_path(&roots, &s(&link), OpenMode::Open).is_err());
    }

    #[cfg(unix)]
    fn make_dir_link(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    /// Windows: try a symlink (needs privilege), then a junction (does not).
    #[cfg(windows)]
    fn make_dir_link(target: &Path, link: &Path) -> bool {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return true;
        }
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[cfg(not(any(unix, windows)))]
    fn make_dir_link(_target: &Path, _link: &Path) -> bool {
        false
    }
}
