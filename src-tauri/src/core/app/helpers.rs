use std::{fs, io, path::PathBuf};

/// Recursively copy a directory from src to dst, excluding specified directories
pub fn copy_dir_recursive(
    src: &PathBuf,
    dst: &PathBuf,
    exclude_dirs: &[&str],
) -> Result<(), io::Error> {
    if !dst.exists() {
        fs::create_dir_all(dst)?;
    }

    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if let Some(name) = entry.file_name().to_str() {
            if exclude_dirs.contains(&name) {
                continue;
            }
        }

        // A link to a directory is not followed: one pointing at an ancestor
        // (or at the destination) recursed until the disk filled.
        if file_type.is_symlink() && src_path.is_dir() {
            log::warn!("Skipping directory link: {src_path:?}");
            continue;
        }
        // The destination may sit inside the source; never copy it into itself.
        if file_type.is_dir() && &src_path == dst {
            continue;
        }

        if file_type.is_dir() {
            copy_dir_recursive(&src_path, &dst_path, exclude_dirs)?;
        } else if file_type.is_file() || file_type.is_symlink() {
            fs::copy(&src_path, &dst_path)?;
        } else {
            log::debug!("Skipping non-regular file: {src_path:?}");
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
        write_file(&src.join("nested/node_modules/also.txt"), "s");

        copy_dir_recursive(&src, &dst, &["node_modules"]).unwrap();

        assert!(dst.join("keep.txt").exists());
        assert!(!dst.join("node_modules").exists());
        assert!(!dst.join("nested/node_modules").exists());
        assert!(dst.join("nested").exists());
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
}
