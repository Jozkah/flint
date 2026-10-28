use std::{fs, io, path::PathBuf};

/// Recursively copy a directory from src to dst. `exclude_dirs` names are
/// matched against top-level entries of `src` only, so a user folder that
/// happens to share a name deeper in the tree is still copied.
pub fn copy_dir_recursive(
    src: &PathBuf,
    dst: &PathBuf,
    exclude_dirs: &[&str],
) -> Result<(), io::Error> {
    copy_tree(src, dst, exclude_dirs, true, false)
}

/// Like `copy_dir_recursive`, but a file is copied only when the destination
/// copy is missing or older. Used to merge into a non-empty target and for the
/// delta pass that picks up files written during the first copy.
#[cfg_attr(feature = "cli", allow(dead_code))]
pub fn copy_dir_newer(
    src: &PathBuf,
    dst: &PathBuf,
    exclude_dirs: &[&str],
) -> Result<(), io::Error> {
    copy_tree(src, dst, exclude_dirs, true, true)
}

/// True for a Windows reparse point (junction or symlink); always false elsewhere.
fn is_reparse_point(path: &std::path::Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        fs::symlink_metadata(path)
            .map(|m| m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

fn copy_tree(
    src: &PathBuf,
    dst: &PathBuf,
    exclude_dirs: &[&str],
    top: bool,
    only_newer: bool,
) -> Result<(), io::Error> {
    if !dst.exists() {
        fs::create_dir_all(dst)?;
    }

    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if top {
            if let Some(name) = entry.file_name().to_str() {
                if exclude_dirs.contains(&name) {
                    continue;
                }
            }
        }

        // A link to a directory is not followed: one pointing at an ancestor
        // (or at the destination) recursed until the disk filled. Windows
        // junctions are not symlinks to std, so check the reparse attribute.
        if (file_type.is_symlink() && src_path.is_dir())
            || (file_type.is_dir() && is_reparse_point(&src_path))
        {
            log::warn!("Skipping directory link: {src_path:?}");
            continue;
        }
        // The destination may sit inside the source; never copy it into itself.
        if file_type.is_dir() && &src_path == dst {
            continue;
        }

        if file_type.is_dir() {
            copy_tree(&src_path, &dst_path, exclude_dirs, false, only_newer)?;
        } else if file_type.is_file() || file_type.is_symlink() {
            if only_newer {
                let src_time = fs::metadata(&src_path).and_then(|m| m.modified());
                let dst_time = fs::metadata(&dst_path).and_then(|m| m.modified());
                if let (Ok(s), Ok(d)) = (src_time, dst_time) {
                    if d >= s {
                        continue;
                    }
                }
            }
            fs::copy(&src_path, &dst_path)?;
        } else {
            log::debug!("Skipping non-regular file: {src_path:?}");
        }
    }

    Ok(())
}

/// Nearest existing ancestor canonicalised, with the missing tail re-appended,
/// lowercased on Windows so comparisons are case-insensitive there.
fn normalised(path: &std::path::Path) -> PathBuf {
    let mut tail = Vec::new();
    let mut cur = path.to_path_buf();
    let base = loop {
        if let Ok(c) = cur.canonicalize() {
            break c;
        }
        match (cur.file_name().map(|n| n.to_os_string()), cur.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name);
                cur = parent.to_path_buf();
            }
            _ => break cur,
        }
    };
    let mut out = base;
    for part in tail.into_iter().rev() {
        out.push(part);
    }
    if cfg!(windows) {
        PathBuf::from(out.to_string_lossy().to_lowercase())
    } else {
        out
    }
}

/// Check a requested data folder before anything is created or copied.
/// Errors starting with `TARGET_NOT_EMPTY` mean the folder has content and
/// `allow_merge` was not set.
#[cfg_attr(feature = "cli", allow(dead_code))]
pub fn validate_new_data_folder(
    current: &std::path::Path,
    new: &std::path::Path,
    allow_merge: bool,
) -> Result<(), String> {
    if !new.is_absolute() {
        return Err("INVALID_TARGET: the new data folder must be an absolute path".to_string());
    }
    let cur = normalised(current);
    let tgt = normalised(new);
    if tgt == cur {
        return Err("INVALID_TARGET: the new data folder is the current data folder".to_string());
    }
    if tgt.starts_with(&cur) {
        return Err(
            "INVALID_TARGET: the new data folder cannot be inside the current data folder"
                .to_string(),
        );
    }
    if cur.starts_with(&tgt) {
        return Err(
            "INVALID_TARGET: the new data folder cannot contain the current data folder"
                .to_string(),
        );
    }
    if tgt.exists() {
        if !tgt.is_dir() {
            return Err("INVALID_TARGET: the new data folder is not a directory".to_string());
        }
        let non_empty = fs::read_dir(&tgt)
            .map(|mut d| d.next().is_some())
            .map_err(|e| format!("Failed to read new data folder: {e}"))?;
        if non_empty && !allow_merge {
            return Err(format!(
                "TARGET_NOT_EMPTY: {} already has content; set allow_merge to copy only newer files into it",
                new.display()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_file(path: &PathBuf, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn copies_files_and_nested_dirs() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        write_file(&src.join("a.txt"), "hello");
        write_file(&src.join("nested/b.txt"), "world");

        copy_dir_recursive(&src, &dst, &[]).unwrap();

        assert_eq!(fs::read_to_string(dst.join("a.txt")).unwrap(), "hello");
        assert_eq!(
            fs::read_to_string(dst.join("nested/b.txt")).unwrap(),
            "world"
        );
    }

    #[test]
    fn excludes_named_directories() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        write_file(&src.join("keep.txt"), "k");
        write_file(&src.join("node_modules/skip.txt"), "s");
        write_file(&src.join("nested/node_modules/deep.txt"), "d");

        copy_dir_recursive(&src, &dst, &["node_modules"]).unwrap();

        assert!(dst.join("keep.txt").exists());
        assert!(!dst.join("node_modules").exists());
        // Excludes apply to the top level only.
        assert!(dst.join("nested/node_modules/deep.txt").exists());
    }

    #[test]
    fn creates_destination_when_missing() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("does/not/exist");
        write_file(&src.join("f.txt"), "x");

        copy_dir_recursive(&src, &dst, &[]).unwrap();
        assert!(dst.join("f.txt").exists());
    }

    #[test]
    fn empty_source_dir_results_in_empty_dest() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        fs::create_dir_all(&src).unwrap();

        copy_dir_recursive(&src, &dst, &[]).unwrap();
        assert!(dst.exists());
        assert_eq!(fs::read_dir(&dst).unwrap().count(), 0);
    }

    #[test]
    fn a_link_to_an_ancestor_is_not_followed() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        write_file(&src.join("f.txt"), "x");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&src, src.join("loop")).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&src, src.join("loop")).is_ok();
        copy_dir_recursive(&src, &dst, &[]).unwrap();
        assert!(dst.join("f.txt").exists());
        if made {
            assert!(!dst.join("loop").exists());
        }
    }

    #[test]
    fn errors_when_source_missing() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("nope");
        let dst = tmp.path().join("dst");
        let result = copy_dir_recursive(&src, &dst, &[]);
        assert!(result.is_err());
    }

    #[test]
    fn nested_user_folder_named_uvx_is_copied() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        write_file(&src.join(".uvx/skip.txt"), "s");
        write_file(&src.join("projects/.uvx/keep.txt"), "k");

        copy_dir_recursive(&src, &dst, &[".uvx"]).unwrap();

        assert!(!dst.join(".uvx").exists());
        assert!(dst.join("projects/.uvx/keep.txt").exists());
    }

    #[test]
    fn delta_pass_copies_file_written_during_copy() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        write_file(&src.join("a.txt"), "one");
        copy_dir_recursive(&src, &dst, &[]).unwrap();
        // Written after the first pass, and an existing file changed.
        write_file(&src.join("late.txt"), "late");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        write_file(&src.join("a.txt"), "two");

        copy_dir_newer(&src, &dst, &[]).unwrap();

        assert_eq!(fs::read_to_string(dst.join("late.txt")).unwrap(), "late");
        assert_eq!(fs::read_to_string(dst.join("a.txt")).unwrap(), "two");
    }

    #[test]
    fn rejects_nonempty_target_without_merge() {
        let tmp = TempDir::new().unwrap();
        let cur = tmp.path().join("cur");
        let tgt = tmp.path().join("tgt");
        fs::create_dir_all(&cur).unwrap();
        write_file(&tgt.join("x.txt"), "x");

        let err = validate_new_data_folder(&cur, &tgt, false).unwrap_err();
        assert!(err.starts_with("TARGET_NOT_EMPTY"), "{err}");
        assert!(validate_new_data_folder(&cur, &tgt, true).is_ok());
    }

    #[test]
    fn no_stray_folder_on_subdirectory_refusal() {
        let tmp = TempDir::new().unwrap();
        let cur = tmp.path().join("cur");
        fs::create_dir_all(&cur).unwrap();
        let inside = cur.join("a/b");

        assert!(validate_new_data_folder(&cur, &inside, false).is_err());
        assert!(!inside.exists());
        assert!(validate_new_data_folder(&cur, &cur, false).is_err());
        assert!(validate_new_data_folder(&cur, tmp.path(), false).is_err());
        assert!(validate_new_data_folder(&cur, std::path::Path::new("relative"), false).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn junction_not_followed() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        write_file(&src.join("f.txt"), "x");
        let target = tmp.path().join("elsewhere");
        write_file(&target.join("secret.txt"), "s");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(src.join("junc"))
            .arg(&target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        copy_dir_recursive(&src, &dst, &[]).unwrap();

        assert!(dst.join("f.txt").exists());
        if made {
            assert!(!dst.join("junc").exists());
        }
    }
}
