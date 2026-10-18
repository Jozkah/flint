//! Saving a download the model asked for, and nothing else.
//!
//! The session refuses every download by default. The `download` action opens a
//! short window: the browser is told to write files under a GUID name into a
//! scratch folder inside the destination the tool layer already confined, and
//! when the file is complete it is moved to a sanitised, never-overwriting name.
//! A page therefore chooses neither the folder nor an existing file to replace.

use std::path::{Path, PathBuf};

/// The largest file `download` keeps.
pub const MAX_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;
/// Longest wait for a download to finish.
pub const MAX_DOWNLOAD_WAIT_MS: u64 = 120_000;

const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3",
    "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// A file name safe to create on any platform from a name the page suggested:
/// no folders, no control or reserved characters, no leading dot, no Windows
/// device name, no trailing dot or space, bounded length. Never empty.
pub fn safe_file_name(suggested: &str) -> String {
    let base = suggested.rsplit(['/', '\\']).next().unwrap_or("");
    let mut name: String = base
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    name = name.trim_matches(|c: char| c == '.' || c == ' ').to_string();
    if name.chars().count() > 120 {
        let ext: String = name.rsplit_once('.').map(|(_, e)| e.chars().take(10).collect()).unwrap_or_default();
        let stem: String = name.chars().take(100).collect();
        name = if ext.is_empty() { stem } else { format!("{stem}.{ext}") };
    }
    if name.is_empty() {
        return "download".to_string();
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    if RESERVED.contains(&stem.as_str()) {
        name.insert(0, '_');
    }
    name
}

/// `dir/name`, or `dir/name (2)` ... when taken: an existing file is never replaced.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (2..10_000)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or_else(|| dir.join(format!("{stem}-{}{ext}", std::process::id())))
}

/// A download folder the model named, confined to the folders the run may write.
///
/// Refused: a `..` component, a path that is not (or cannot become) a folder,
/// anything whose nearest existing ancestor resolves outside the roots, and the
/// agent's own hidden state folder. The folder is created only after it passes,
/// then checked again once it exists.
pub fn confine_dir(
    project_root: &Path,
    scratch: Option<&Path>,
    write_roots: &[PathBuf],
    raw: &str,
) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("download needs a `path`: a folder inside your working folder to save the file into.".to_string());
    }
    let target = crate::tools::sandbox::resolve_path(project_root, scratch, raw);
    if target.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("{raw} contains \"..\", so it was not used. Name the folder directly."));
    }
    let mut roots: Vec<PathBuf> = vec![project_root.to_path_buf()];
    roots.extend(scratch.map(Path::to_path_buf));
    roots.extend(write_roots.iter().cloned());
    let roots: Vec<PathBuf> = roots.iter().filter_map(|r| std::fs::canonicalize(r).ok()).collect();
    let inside = |p: &Path| roots.iter().any(|r| p.starts_with(r));
    if target.exists() && !target.is_dir() {
        return Err(format!("{raw} is a file; download saves into a folder."));
    }
    let ancestor = target.ancestors().find(|a| a.exists()).ok_or_else(|| format!("{raw} has no existing parent folder."))?;
    let canon_ancestor = std::fs::canonicalize(ancestor).map_err(|e| format!("cannot use {raw}: {e}"))?;
    if !inside(&canon_ancestor) {
        return Err(format!("{raw} is outside your working folder, so nothing was downloaded there. Use a folder in the workspace."));
    }
    if crate::tools::sandbox::is_hidden_jan_path_in(project_root, write_roots, &target.to_string_lossy()) {
        return Err("that path is the agent's own state directory, which is hidden and cannot receive downloads.".to_string());
    }
    std::fs::create_dir_all(&target).map_err(|e| format!("cannot create {raw}: {e}"))?;
    let canon = std::fs::canonicalize(&target).map_err(|e| format!("cannot use {raw}: {e}"))?;
    if !inside(&canon) {
        return Err(format!("{raw} resolves outside your working folder, so nothing was downloaded there."));
    }
    let shown = canon.to_string_lossy();
    Ok(match shown.strip_prefix(r"\\?\") {
        Some(plain) if !plain.starts_with("UNC") => PathBuf::from(plain),
        _ => canon,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_cannot_pick_the_folder_or_a_device_name() {
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("..\\..\\win.ini"), "win.ini");
        assert_eq!(safe_file_name("C:\\x\\evil.exe"), "evil.exe");
        assert_eq!(safe_file_name("a<b>:c?.txt"), "a_b__c_.txt");
        assert_eq!(safe_file_name(".bashrc"), "bashrc");
        assert_eq!(safe_file_name("NUL.txt"), "_NUL.txt");
        assert_eq!(safe_file_name("report. "), "report");
        assert_eq!(safe_file_name(""), "download");
        assert_eq!(safe_file_name("..."), "download");
        assert!(safe_file_name(&format!("{}.zip", "a".repeat(500))).chars().count() <= 111);
    }

    #[test]
    fn an_existing_file_is_never_replaced() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.zip"), "1").unwrap();
        std::fs::write(d.path().join("a (2).zip"), "2").unwrap();
        assert_eq!(unique_path(d.path(), "a.zip"), d.path().join("a (3).zip"));
        assert_eq!(unique_path(d.path(), "b.zip"), d.path().join("b.zip"));
    }

    #[test]
    fn the_destination_must_stay_inside_the_run_folders() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let p = root.path();
        for bad in ["", "../x", "sub/../../x"] {
            assert!(confine_dir(p, None, &[], bad).is_err(), "{bad}");
        }
        assert!(confine_dir(p, None, &[], &outside.path().to_string_lossy()).is_err());
        assert!(confine_dir(p, None, &[], &outside.path().join("new").to_string_lossy()).is_err());
        assert!(!outside.path().join("new").exists(), "nothing is created outside");
        std::fs::write(p.join("f.txt"), "x").unwrap();
        assert!(confine_dir(p, None, &[], "f.txt").unwrap_err().contains("is a file"));
        assert!(confine_dir(p, None, &[], ".jan/agent").is_err(), "the agent's own state folder is hidden");
        let ok = confine_dir(p, None, &[], "out/dl").unwrap();
        assert!(ok.is_dir() && ok.ends_with("dl"));
        let granted = confine_dir(p, None, &[outside.path().to_path_buf()], &outside.path().join("g").to_string_lossy()).unwrap();
        assert!(granted.is_dir());
    }
}
