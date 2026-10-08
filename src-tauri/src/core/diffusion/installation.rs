//! Platform-independent extraction and native engine library setup.
use std::path::Path;

/// Unpack a zip into `dest`. Every entry is checked to stay inside it.
pub fn unzip(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("Could not open the archive: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("The archive is damaged: {e}"))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("The archive is damaged: {e}"))?;
        // `enclosed_name` refuses absolute paths and `..`.
        let Some(relative) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
            return Err("The archive holds a path outside its folder.".to_string());
        };
        let out = dest.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut target = std::fs::File::create(&out).map_err(|e| format!("Could not unpack {}: {e}", relative.display()))?;
        std::io::copy(&mut entry, &mut target).map_err(|e| format!("Could not unpack {}: {e}", relative.display()))?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            // Restore executable bits, never setuid/setgid or world-writable modes.
            let mode = entry.unix_mode().unwrap_or(0o644) & 0o755;
            std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// The engine archive carries its ggml and image-codec libraries beside the server.
pub fn configure_library_path(command: &mut tokio::process::Command, dir: &Path) {
    #[cfg(target_os = "linux")] {
        let mut paths = vec![dir.to_path_buf()];
        if let Some(existing) = std::env::var_os("LD_LIBRARY_PATH") { paths.extend(std::env::split_paths(&existing)); }
        if let Ok(value) = std::env::join_paths(paths) { command.env("LD_LIBRARY_PATH", value); }
    }
    #[cfg(not(target_os = "linux"))] let _ = (command, dir);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(unix)]
    fn executable_mode_is_restored_without_privilege_bits() {
        use std::os::unix::fs::PermissionsExt;
        let file = tempfile::NamedTempFile::new().unwrap();
        let mut zip = zip::ZipWriter::new(file.reopen().unwrap());
        zip.start_file("sd-server", zip::write::FileOptions::default().unix_permissions(0o6755)).unwrap();
        std::io::Write::write_all(&mut zip, b"engine").unwrap();
        zip.finish().unwrap();
        let dir = tempfile::tempdir().unwrap();
        unzip(file.path(), dir.path()).unwrap();
        assert_eq!(std::fs::metadata(dir.path().join("sd-server")).unwrap().permissions().mode() & 0o7777, 0o755);
    }
    #[test]
    fn archive_paths_cannot_escape() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let mut zip = zip::ZipWriter::new(file.reopen().unwrap());
        zip.start_file("../escape", zip::write::FileOptions::default()).unwrap();
        std::io::Write::write_all(&mut zip, b"bad").unwrap();
        zip.finish().unwrap();
        let dir = tempfile::tempdir().unwrap();
        assert!(unzip(file.path(), dir.path()).is_err());
    }
}
