//! `flint cli data-folder`, `flint cli net ca check` and `flint cli net
//! endpoint`: the data-folder, certificate-check and endpoint-diagnostics
//! parts of the desktop's General and Providers settings, from the terminal.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::core::app::commands::{resolve_config_file_path, resolve_jan_data_folder, write_configuration_atomic};
use crate::core::app::models::AppConfiguration;
use crate::core::net::{resolver, tls};

/// Where the data folder comes from right now, and what that means for a change.
pub fn data_folder_info() -> Value {
    let env = crate::core::compat_env::var("DATA_FOLDER").ok().filter(|v| !v.is_empty());
    let config_file = resolve_config_file_path();
    json!({
        "dataFolder": resolve_jan_data_folder(),
        "source": if env.is_some() { "environment (FLINT_DATA_FOLDER / JAN_DATA_FOLDER)" } else { "settings file or default" },
        "settingsFile": config_file,
        "overriddenByEnvironment": env.is_some(),
    })
}

fn copy_recursive(src: &Path, dst: &Path, skip: &[&str]) -> std::io::Result<u64> {
    let mut files = 0;
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if skip.iter().any(|s| name.to_string_lossy() == *s) {
            continue;
        }
        let (from, to) = (entry.path(), dst.join(&name));
        // A link is not followed: copying what it points at could pull in a
        // tree that was never part of the data folder.
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            files += copy_recursive(&from, &to, skip)?;
        } else {
            std::fs::copy(&from, &to)?;
            files += 1;
        }
    }
    Ok(files)
}

/// `data-folder --set PATH [--no-copy]`: point Flint at another folder, copying
/// the current one into it first unless told not to. The desktop app reads the
/// same settings file, so both follow. Refused when the new folder is inside
/// the current one, which would copy a folder into itself.
pub fn set_data_folder(new_folder: &str, copy: bool) -> Result<Value, String> {
    let new_path = PathBuf::from(new_folder);
    if !new_path.is_absolute() {
        return Err("give the new data folder as an absolute path".to_string());
    }
    let current = resolve_jan_data_folder();
    std::fs::create_dir_all(&new_path).map_err(|e| format!("create {}: {e}", new_path.display()))?;
    // Compared after resolving, so `..`, links and (on Windows) letter case
    // cannot hide that one folder is inside the other.
    let key = |p: &Path| {
        let c = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        if cfg!(windows) { PathBuf::from(c.to_string_lossy().to_lowercase()) } else { c }
    };
    let (cur_key, new_key) = (key(&current), key(&new_path));
    if new_key != cur_key && (new_key.starts_with(&cur_key) || cur_key.starts_with(&new_key)) {
        return Err("the new data folder cannot be inside the current one, or contain it".to_string());
    }
    let mut copied = 0;
    if copy && current.exists() && new_key != cur_key {
        // Copying over an existing Flint or JAN folder would replace its files.
        let occupied = std::fs::read_dir(&new_path).map(|mut d| d.next().is_some()).unwrap_or(false);
        if occupied {
            return Err("the new folder is not empty; pick an empty one, or pass --no-copy to switch to it as it is".to_string());
        }
        copied = copy_recursive(&current, &new_path, &[".uvx", ".npx", "openclaw"])
            .map_err(|e| format!("copy to the new folder failed: {e}"))?;
    }
    let configuration = AppConfiguration {
        data_folder: new_path.to_string_lossy().to_string(),
        unavailable_data_folder: None,
    };
    write_configuration_atomic(&resolve_config_file_path(), &configuration)?;
    Ok(json!({
        "dataFolder": new_path,
        "filesCopied": copied,
        "note": "Close any running Flint app and restart it to use the new folder.",
    }))
}

/// `net ca check <path>`: what a bundle would do, without saving it.
pub fn ca_check(path: &str) -> Value {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return json!({ "state": "none" });
    }
    match tls::load(Path::new(trimmed), tls::Source::CliConfig) {
        Ok(bundle) => json!({
            "state": "in_use",
            "path": bundle.path.display().to_string(),
            "certificates": bundle.fingerprints.len(),
            "sha256": bundle.fingerprints,
        }),
        Err(error) => json!({
            "state": "broken",
            "kind": error.kind.tag(),
            "message": error.message,
        }),
    }
}

/// `net endpoint <host> <port>`: how the host resolves and which address would
/// be dialled first, the way the provider details page shows it.
pub fn endpoint(host: &str, port: u16) -> Result<Value, String> {
    let resolution = resolver::shared().resolve(&resolver::SystemDns, host, port)?;
    let selected = resolution.selected().map(|a| a.ip().to_string());
    Ok(json!({
        "host": resolution.host,
        "port": resolution.port,
        "localName": resolution.local_name,
        "candidates": resolution
            .candidates
            .iter()
            .map(|c| json!({ "address": c.addr.ip().to_string(), "class": c.class.as_str(), "eligible": c.eligible }))
            .collect::<Vec<_>>(),
        "selected": selected,
        "suppressedPublic": resolution.suppressed_public,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_skips_links_and_named_folders_and_counts_files() {
        let dir = tempfile::tempdir().unwrap();
        let (src, dst) = (dir.path().join("src"), dir.path().join("dst"));
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::create_dir_all(src.join(".npx")).unwrap();
        std::fs::write(src.join("a.txt"), "a").unwrap();
        std::fs::write(src.join("sub").join("b.txt"), "b").unwrap();
        std::fs::write(src.join(".npx").join("skip.txt"), "x").unwrap();
        let copied = copy_recursive(&src, &dst, &[".npx"]).unwrap();
        assert_eq!(copied, 2);
        assert!(dst.join("sub").join("b.txt").exists());
        assert!(!dst.join(".npx").exists());
    }

    #[test]
    fn set_data_folder_refuses_relative_and_nested_paths() {
        crate::core::app::commands::with_temp_data_folder(|data| {
            assert!(set_data_folder("relative/dir", true).is_err());
            let inside = data.join("child");
            assert!(set_data_folder(&inside.to_string_lossy(), true).is_err());
            // A spelling that only resolves to the inside, and a parent, are refused too.
            let sneaky = data.join("other").join("..").join("child2");
            assert!(set_data_folder(&sneaky.to_string_lossy(), true).is_err());
            let parent = data.parent().unwrap().to_path_buf();
            assert!(set_data_folder(&parent.to_string_lossy(), true).is_err());
            let info = data_folder_info();
            assert_eq!(info["overriddenByEnvironment"], true);
        });
    }

    #[test]
    fn ca_check_reports_none_and_broken() {
        assert_eq!(ca_check("  ")["state"], "none");
        let dir = tempfile::tempdir().unwrap();
        let bad = dir.path().join("bad.pem");
        std::fs::write(&bad, "not a certificate").unwrap();
        assert_eq!(ca_check(&bad.to_string_lossy())["state"], "broken");
        assert_eq!(ca_check(&dir.path().join("missing.pem").to_string_lossy())["state"], "broken");
    }

    #[test]
    fn endpoint_resolves_loopback() {
        let v = endpoint("127.0.0.1", 8080).unwrap();
        assert_eq!(v["selected"], "127.0.0.1");
        assert_eq!(v["port"], 8080);
    }
}
