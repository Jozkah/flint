// WARNING: These APIs will be deprecated soon due to removing FS API access from frontend.
// It's added to ensure the legacy implementation from frontend still functions before removal.
use super::grants::{is_within, record_picks, ReadGrants, DENIED_PREFIX};
use super::helpers::{
    canonical_scope_path, is_sensitive_read_path, resolve_app_path_within_jan_data_folder,
    resolve_app_read_path, resolve_path,
};
use crate::core::app::commands::get_jan_data_folder_path;
use std::path::PathBuf;
use super::models::{DialogOpenOptions, FileStat};
use super::picker::AsyncFileDialog;
use std::fs;
use tauri::{Manager, Runtime};

#[tauri::command(async)]
pub fn rm<R: Runtime>(app_handle: tauri::AppHandle<R>, args: Vec<String>) -> Result<(), String> {
    if args.is_empty() || args[0].is_empty() {
        return Err("rm error: Invalid argument".to_string());
    }

    let (canonical_data, path) = resolve_app_path_within_jan_data_folder(app_handle, &args[0])
        .map_err(|_| format!("rm error: path {} is not under jan data folder", args[0]))?;
    if path == canonical_data || !path.starts_with(&canonical_data) {
        return Err(format!(
            "rm error: path {} is not under jan data folder {}",
            path.display(),
            canonical_data.display()
        ));
    }

    if path.is_file() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    } else if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    } else {
        return Err("rm error: Path does not exist".to_string());
    }

    Ok(())
}

#[tauri::command(async)]
pub fn mkdir<R: Runtime>(app_handle: tauri::AppHandle<R>, args: Vec<String>) -> Result<(), String> {
    if args.is_empty() || args[0].is_empty() {
        return Err("mkdir error: Invalid argument".to_string());
    }

    let (_canonical_data, path) = resolve_app_path_within_jan_data_folder(app_handle, &args[0])
        .map_err(|_| format!("mkdir error: path {} is not under jan data folder", args[0]))?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn mv<R: Runtime>(app_handle: tauri::AppHandle<R>, args: Vec<String>) -> Result<(), String> {
    if args.len() < 2 || args[0].is_empty() || args[1].is_empty() {
        return Err("mv error: Invalid argument - source and destination required".to_string());
    }

    // Both ends have to stay inside the data folder: an unscoped source turns
    // `mv` into an exfiltration primitive, an unscoped destination into an
    // arbitrary-write one.
    let (_canonical_data, source) =
        resolve_app_path_within_jan_data_folder(app_handle.clone(), &args[0])
            .map_err(|_| format!("mv error: path {} is not under jan data folder", args[0]))?;
    let (_canonical_data, destination) =
        resolve_app_path_within_jan_data_folder(app_handle, &args[1])
            .map_err(|_| format!("mv error: path {} is not under jan data folder", args[1]))?;

    if !source.exists() {
        return Err("mv error: Source path does not exist".to_string());
    }

    fs::rename(&source, &destination).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn join_path<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    args: Vec<String>,
) -> Result<String, String> {
    if args.is_empty() {
        return Err("join_path error: Invalid argument".to_string());
    }

    let path = resolve_path(app_handle, &args[0]);
    let joined_path = args[1..].iter().fold(path, |acc, part| acc.join(part));
    Ok(joined_path.to_string_lossy().to_string())
}

#[tauri::command(async)]
pub fn exists_sync<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    args: Vec<String>,
) -> Result<bool, String> {
    if args.is_empty() || args[0].is_empty() {
        return Err("exist_sync error: Invalid argument".to_string());
    }

    match resolve_app_read_path(app_handle, &args[0]) {
        Ok(path) => Ok(path.exists()),
        // A path the webview may not read looks the same as a missing one, so
        // this command cannot probe the disk.
        Err(e) if e.starts_with(DENIED_PREFIX) => Ok(false),
        Err(e) => Err(e),
    }
}

#[tauri::command(async)]
pub fn file_stat<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    args: String,
) -> Result<FileStat, String> {
    if args.is_empty() {
        return Err("file_stat error: Invalid argument".to_string());
    }

    let path = resolve_app_read_path(app_handle, &args)?;
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    let is_directory = metadata.is_dir();
    let size = if is_directory { 0 } else { metadata.len() };
    let is_symlink = fs::symlink_metadata(&path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_secs()).ok());
    let file_stat = FileStat {
        is_directory,
        size,
        is_symlink,
        modified,
    };
    Ok(file_stat)
}

#[tauri::command(async)]
pub fn read_file_sync<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    args: Vec<String>,
) -> Result<String, String> {
    if args.is_empty() || args[0].is_empty() {
        return Err("read_file_sync error: Invalid argument".to_string());
    }

    let path = resolve_app_read_path(app_handle, &args[0])?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn write_file_sync<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    args: Vec<String>,
) -> Result<(), String> {
    if args.len() < 2 || args[0].is_empty() || args[1].is_empty() {
        return Err("write_file_sync error: Invalid argument".to_string());
    }

    let (_canonical_data, path) = resolve_app_path_within_jan_data_folder(app_handle, &args[0])
        .map_err(|_| {
            format!(
                "write_file_sync error: path {} is not under jan data folder",
                args[0]
            )
        })?;
    let content = &args[1];
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn readdir_sync<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    args: Vec<String>,
) -> Result<Vec<String>, String> {
    if args.is_empty() || args[0].is_empty() {
        return Err("read_dir_sync error: Invalid argument".to_string());
    }

    let path = resolve_app_read_path(app_handle.clone(), &args[0])?;
    let data = canonical_scope_path(&get_jan_data_folder_path(app_handle.clone()));
    let in_data = is_within(&path, &data);
    let none = ReadGrants::default();
    let state = app_handle.try_state::<ReadGrants>();
    let grants: &ReadGrants = state.as_deref().unwrap_or(&none);
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let paths: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        // List only what the webview could then read: no secret stores, and
        // outside the data folder no link out of the grant and no file a
        // narrower grant (a picked `.gguf`'s folder) does not cover.
        .filter(|entry| {
            !is_sensitive_read_path(entry)
                && (in_data || grants.allows(&canonical_scope_path(entry), &data))
        })
        .map(|entry| entry.to_string_lossy().to_string())
        .collect();
    Ok(paths)
}

#[tauri::command(async)]
pub fn write_yaml(
    app: tauri::AppHandle<impl Runtime>,
    data: serde_json::Value,
    save_path: &str,
) -> Result<(), String> {
    // TODO: have an internal function to check scope
    let (_jan_data_folder, save_path) = resolve_app_path_within_jan_data_folder(app, save_path)?;
    let file = fs::File::create(&save_path).map_err(|e| e.to_string())?;
    let mut writer = std::io::BufWriter::new(file);
    serde_yaml::to_writer(&mut writer, &data).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn read_yaml<R: Runtime>(
    app: tauri::AppHandle<R>,
    path: &str,
) -> Result<serde_json::Value, String> {
    let (_jan_data_folder, path) = resolve_app_path_within_jan_data_folder(app, path)?;
    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = std::io::BufReader::new(file);
    let data: serde_json::Value = serde_yaml::from_reader(reader).map_err(|e| e.to_string())?;
    Ok(data)
}

/// Unpacking a backend archive is hundreds of megabytes of gzip and file IO. A
/// synchronous command would run it on the main thread and freeze the window
/// (and, on WebKitGTK, all rendering) for its whole duration, so the work is
/// handed to the blocking pool instead.
#[tauri::command]
pub async fn decompress<R: Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    output_dir: String,
) -> Result<(), String> {
    // The archive must be one the webview may read: in the data folder (a
    // downloaded backend) or picked by the user. A raw path would let the
    // webview unpack any archive on disk into the data folder.
    let path_buf = resolve_app_read_path(app.clone(), &path)?;
    let (_jan_data_folder, output_dir_buf) =
        resolve_app_path_within_jan_data_folder(app, &output_dir)?;

    tauri::async_runtime::spawn_blocking(move || unpack_archive(&path_buf, &output_dir_buf))
        .await
        .map_err(|e| format!("Decompression task failed: {}", e))?
}

/// Most entries one archive may unpack to.
const MAX_UNPACK_ENTRIES: u64 = 200_000;
/// Most bytes one archive may unpack to (a backend is a few GB at most).
const MAX_UNPACK_BYTES: u64 = 16 * 1024 * 1024 * 1024;

/// Unpack into a staging folder beside `output_dir_buf`, then move the result
/// into place: a failed or refused unpack (a bomb past the caps, a broken
/// entry) leaves no half-written output behind.
pub(crate) fn unpack_archive(
    path_buf: &std::path::Path,
    output_dir_buf: &std::path::Path,
) -> Result<(), String> {
    unpack_archive_capped(path_buf, output_dir_buf, MAX_UNPACK_ENTRIES, MAX_UNPACK_BYTES)
}

pub(crate) fn unpack_archive_capped(
    path_buf: &std::path::Path,
    output_dir_buf: &std::path::Path,
    max_entries: u64,
    max_bytes: u64,
) -> Result<(), String> {
    let parent = output_dir_buf
        .parent()
        .ok_or_else(|| "the output directory has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| {
        format!("Failed to create output directory {}: {e}", parent.to_string_lossy())
    })?;
    let leaf = output_dir_buf
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "out".into());
    let staging = parent.join(format!(".{leaf}.unpack-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&staging).map_err(|e| {
        format!("Failed to create output directory {}: {e}", staging.to_string_lossy())
    })?;
    let result = unpack_into(path_buf, &staging, max_entries, max_bytes)
        .and_then(|()| move_unpacked(&staging, output_dir_buf));
    let _ = fs::remove_dir_all(&staging);
    result
}

/// Move the staged tree into `dst`: a rename when `dst` does not exist yet,
/// otherwise merged in the way unpacking in place did (files overwrite files
/// of the same name, folders merge, nothing else in `dst` is touched).
fn move_unpacked(staging: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    let moved = |e: std::io::Error, to: &std::path::Path| {
        format!("Failed to move the unpacked files to {}: {e}", to.display())
    };
    if fs::symlink_metadata(dst).is_err() {
        return fs::rename(staging, dst).map_err(|e| moved(e, dst));
    }
    for entry in fs::read_dir(staging).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let to_meta = fs::symlink_metadata(&to).ok();
        let from_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        match to_meta {
            Some(m) if from_dir && m.is_dir() => move_unpacked(&from, &to)?,
            Some(m) => {
                if m.is_dir() {
                    fs::remove_dir_all(&to).map_err(|e| moved(e, &to))?;
                } else {
                    fs::remove_file(&to).map_err(|e| moved(e, &to))?;
                }
                fs::rename(&from, &to).map_err(|e| moved(e, &to))?;
            }
            None => fs::rename(&from, &to).map_err(|e| moved(e, &to))?,
        }
    }
    Ok(())
}

fn unpack_into(
    path_buf: &std::path::Path,
    output_dir_buf: &std::path::Path,
    max_entries: u64,
    max_bytes: u64,
) -> Result<(), String> {
    let too_big = || {
        format!(
            "the archive unpacks to more than {max_entries} entries or {} MB, so it was not unpacked",
            max_bytes / (1024 * 1024)
        )
    };
    // Use short path on Windows to handle paths with spaces
    #[cfg(windows)]
    let file = {
        if let Some(short_path) = jan_utils::path::get_short_path(path_buf) {
            fs::File::open(&short_path).map_err(|e| e.to_string())?
        } else {
            fs::File::open(path_buf).map_err(|e| e.to_string())?
        }
    };

    #[cfg(not(windows))]
    let file = fs::File::open(path_buf).map_err(|e| e.to_string())?;
    let name = path_buf.to_string_lossy().to_lowercase();
    if name.ends_with(".tar.gz") {
        let tar = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(tar);
        // Modes from the archive are not applied as given (no setuid, no
        // world-writable files); the umask decides.
        archive.set_preserve_permissions(false);
        let (mut entries, mut bytes) = (0u64, 0u64);
        for entry in archive.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            entries += 1;
            bytes = bytes.saturating_add(entry.header().size().unwrap_or(0));
            if entries > max_entries || bytes > max_bytes {
                return Err(too_big());
            }
            // `unpack_in` refuses an entry whose path leaves the folder.
            entry.unpack_in(output_dir_buf).map_err(|e| e.to_string())?;
        }
    } else if name.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        if zip.len() as u64 > max_entries {
            return Err(too_big());
        }
        let mut bytes = 0u64;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
            let outpath = output_dir_buf.join(
                entry
                    .enclosed_name()
                    .ok_or_else(|| "Invalid zip entry path".to_string())?,
            );

            if entry.name().ends_with('/') {
                std::fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = outpath.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let mut outfile = std::fs::File::create(&outpath).map_err(|e| e.to_string())?;
                // The declared size can lie: count what is really written.
                let room = max_bytes.saturating_sub(bytes) + 1;
                let written = std::io::copy(&mut std::io::Read::take(&mut entry, room), &mut outfile)
                    .map_err(|e| e.to_string())?;
                bytes = bytes.saturating_add(written);
                if bytes > max_bytes {
                    return Err(too_big());
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Some(mode) = entry.unix_mode() {
                        let _ = std::fs::set_permissions(
                            &outpath,
                            std::fs::Permissions::from_mode(mode & 0o755),
                        );
                    }
                }
            }
        }
    } else {
        return Err("Unsupported file format. Only .tar.gz and .zip are supported.".to_string());
    }

    Ok(())
}

// rfd native file dialog
#[tauri::command]
pub async fn open_dialog<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    options: Option<DialogOpenOptions>,
) -> Result<Option<serde_json::Value>, String> {
    let picked = pick(options).await;
    // Every path the user picked becomes readable (and `asset:`-viewable) by
    // the webview; recorded here, where the webview cannot forge it.
    if let Some(value) = &picked {
        let paths: Vec<PathBuf> = match value {
            serde_json::Value::String(s) => vec![PathBuf::from(s)],
            serde_json::Value::Array(items) => items
                .iter()
                .filter_map(|v| v.as_str().map(PathBuf::from))
                .collect(),
            _ => Vec::new(),
        };
        record_picks(&app_handle, &paths);
    }
    Ok(picked)
}

async fn pick(options: Option<DialogOpenOptions>) -> Option<serde_json::Value> {
    // Test-only: the cowork-smoke harness scripts the picker's answer because a
    // WebView harness cannot drive a native modal. Everything else on this path
    // stays real. Absent from release builds -- see `smoke_dialog`.
    #[cfg(feature = "cowork-smoke")]
    if let Some(scripted) = super::smoke_dialog::scripted_response() {
        return scripted;
    }

    let mut dialog = AsyncFileDialog::new();

    if let Some(opts) = options {
        // Set default path
        if let Some(path) = opts.default_path {
            dialog = dialog.set_directory(&path);
        }

        // Set filters
        if let Some(filters) = opts.filters {
            for filter in filters {
                let extensions: Vec<&str> = filter.extensions.iter().map(|s| s.as_str()).collect();
                dialog = dialog.add_filter(&filter.name, &extensions);
            }
        }

        // Handle directory vs file selection
        if opts.directory == Some(true) {
            let result = dialog.pick_folder().await;
            return result.map(|folder| {
                serde_json::Value::String(folder.path().to_string_lossy().to_string())
            });
        }

        // Handle multiple file selection
        if opts.multiple == Some(true) {
            let result = dialog.pick_files().await;
            return result.map(|files| {
                let paths: Vec<String> = files
                    .iter()
                    .map(|f| f.path().to_string_lossy().to_string())
                    .collect();
                serde_json::to_value(paths).unwrap()
            });
        }
    }

    // Default: single file selection
    let result = dialog.pick_file().await;
    result.map(|file| serde_json::Value::String(file.path().to_string_lossy().to_string()))
}

/// Split a dialog's default path into the folder to open in and, when it names
/// a file, the file name to suggest. Handing a full file path to
/// `set_directory` made the system dialog show "Untitled" instead of the name.
fn split_default_path(path: &str) -> (std::path::PathBuf, Option<String>) {
    let path = std::path::Path::new(path);
    if path.is_dir() || path.to_string_lossy().ends_with(['/', '\\']) {
        return (path.to_path_buf(), None);
    }
    match (path.parent(), path.file_name().and_then(|n| n.to_str())) {
        (Some(parent), Some(name)) if !name.is_empty() => {
            (parent.to_path_buf(), Some(name.to_string()))
        }
        _ => (path.to_path_buf(), None),
    }
}

fn apply_default_path(dialog: AsyncFileDialog, default_path: &str) -> AsyncFileDialog {
    let (dir, name) = split_default_path(default_path);
    let dialog = if dir.as_os_str().is_empty() {
        dialog
    } else {
        dialog.set_directory(&dir)
    };
    match name {
        Some(name) => dialog.set_file_name(name),
        None => dialog,
    }
}

#[tauri::command]
pub async fn save_dialog(options: Option<DialogOpenOptions>) -> Result<Option<String>, String> {
    // Test-only, as for `open_dialog`: the harness scripts the answer.
    #[cfg(feature = "cowork-smoke")]
    if let Some(scripted) = super::smoke_dialog::scripted_save_response() {
        return Ok(scripted);
    }

    let mut dialog = AsyncFileDialog::new();

    if let Some(opts) = options {
        // Set default path
        if let Some(path) = opts.default_path {
            dialog = apply_default_path(dialog, &path);
        }

        // Set filters
        if let Some(filters) = opts.filters {
            for filter in filters {
                let extensions: Vec<&str> = filter.extensions.iter().map(|s| s.as_str()).collect();
                dialog = dialog.add_filter(&filter.name, &extensions);
            }
        }
    }

    let result = dialog.save_file().await;
    Ok(result.map(|file| file.path().to_string_lossy().to_string()))
}

#[cfg(test)]
mod default_path_tests {
    use super::split_default_path;

    #[test]
    fn a_folder_is_used_as_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let (folder, name) = split_default_path(dir.path().to_str().unwrap());
        assert_eq!(folder, dir.path());
        assert_eq!(name, None);
    }

    #[test]
    fn a_file_path_becomes_a_folder_and_a_suggested_name() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("memory-export.json");
        let (folder, name) = split_default_path(file.to_str().unwrap());
        assert_eq!(folder, dir.path());
        assert_eq!(name.as_deref(), Some("memory-export.json"));
    }

    #[test]
    fn a_trailing_separator_means_a_folder_even_if_missing() {
        let (folder, name) = split_default_path("/no/such/place/");
        assert_eq!(folder, std::path::Path::new("/no/such/place/"));
        assert_eq!(name, None);
    }

    #[test]
    fn a_bare_file_name_is_only_a_suggestion() {
        let (folder, name) = split_default_path("export.json");
        assert!(folder.as_os_str().is_empty());
        assert_eq!(name.as_deref(), Some("export.json"));
    }
}
