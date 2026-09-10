use std::{
    fs,
    path::{Path, PathBuf},
};
#[cfg(not(feature = "cli"))]
use tauri::{AppHandle, Manager, Runtime, State};

use super::constants::{CONFIGURATION_FILE_NAME, TAURI_BUNDLE_IDENTIFIER};
#[cfg(not(feature = "cli"))]
use super::helpers::copy_dir_recursive;
use super::models::AppConfiguration;
#[cfg(not(feature = "cli"))]
use crate::core::state::AppState;

/// The environment variable that redirects Jan's *home* root, the directory
/// `~/.jan` hangs off. The portable counterpart to `JAN_DATA_FOLDER`, which
/// already redirects the data folder.
pub const JAN_HOME_ENV: &str = "JAN_HOME";

/// The root Jan resolves `~/.jan` against.
///
/// `HOME` is not an isolation mechanism on Windows. `dirs::home_dir()` calls
/// `SHGetKnownFolderPath(FOLDERID_Profile)`, which reads neither `HOME` nor
/// `USERPROFILE`, so a test that redirected `HOME` and expected a scratch tree
/// silently read and wrote the real `C:\Users\<you>\.jan` instead -- which is
/// how a test fixture came to overwrite a developer's own `config.toml`.
///
/// So the override is explicit and platform-independent, and under `cfg!(test)`
/// there is no way to reach the real home at all: an unset `JAN_HOME` resolves
/// to a per-process, per-thread temp directory rather than falling through.
/// Tests fail closed, and they get a root each, so parallel tests cannot see
/// one another's writes.
pub fn jan_home_dir() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os(JAN_HOME_ENV) {
        if !explicit.is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }

    if cfg!(test) {
        let dir = std::env::temp_dir().join(format!(
            "jan-test-home-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::create_dir_all(&dir);
        return Some(dir);
    }

    dirs::home_dir()
}

/// Drop the `\\?\` extended-length prefix Windows canonicalisation adds.
///
/// `Path::canonicalize` returns a verbatim path on Windows -- the same
/// directory comes back as `\\?\C:\Users\...` rather than `C:\Users\...`.
/// That form is correct for the filesystem APIs and wrong for everything else:
/// compared against a path Jan built itself it is unequal, and written
/// somewhere a human or another program reads it -- the user's `PATH`, a
/// stored record -- it is a path most tools will not accept.
///
/// So canonicalise for correctness, then come back to the ordinary spelling
/// before the result is stored, compared, or shown. Non-verbatim paths, and
/// every path on other platforms, pass through untouched. UNC verbatim paths
/// (`\\?\UNC\server\share`) are deliberately left alone: rewriting those needs
/// more than removing a prefix.
pub fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        // `\\?\C:\...` -> `C:\...`, only for a real drive-letter path.
        Some(rest)
            if rest.len() >= 2
                && rest.as_bytes()[0].is_ascii_alphabetic()
                && rest.as_bytes()[1] == b':' =>
        {
            PathBuf::from(rest.to_string())
        }
        _ => path,
    }
}

/// Canonical Jan app support directory (`%APPDATA%/Jan` on Windows).
fn resolve_human_readable_app_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(env!("CARGO_PKG_NAME")))
}

/// Tauri bundle-id app support directory (e.g. `%APPDATA%/jan.ai.app` on Windows).
fn resolve_bundle_app_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(TAURI_BUNDLE_IDENTIFIER))
}

/// Keep `%APPDATA%/Jan/settings.json` as canonical, but recover from legacy or
/// alternate locations if users removed one directory (#7898).
fn migrate_legacy_app_configuration(app_data_dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(app_data_dir)?;
    let canonical = app_data_dir.join(CONFIGURATION_FILE_NAME);
    if canonical.exists() {
        return Ok(());
    }

    migrate_from_candidates(&canonical, legacy_app_config_candidate_paths(app_data_dir))
}

fn migrate_from_candidates(canonical: &Path, candidates: Vec<PathBuf>) -> std::io::Result<()> {
    if let Some(parent) = canonical.parent() {
        fs::create_dir_all(parent)?;
    }

    for legacy in candidates {
        if legacy.is_file() {
            log::info!(
                "Recovering app configuration from {} to {}",
                legacy.display(),
                canonical.display()
            );
            fs::copy(&legacy, canonical)?;
            // Remove the stale copy in the bundle-id folder so the canonical
            // product-name location is the single source of truth (#7898).
            if let Err(err) = fs::remove_file(&legacy) {
                log::warn!("Failed to remove legacy config {}: {err}", legacy.display());
            }
            return Ok(());
        }
    }
    Ok(())
}

fn legacy_app_config_candidate_paths(_app_data_dir: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(bundle_dir) = resolve_bundle_app_data_dir() {
        paths.push(bundle_dir.join(CONFIGURATION_FILE_NAME));
    }

    #[cfg(target_os = "linux")]
    {
        let package_name = env!("CARGO_PKG_NAME");
        if let Some(config_dir) = dirs::config_dir() {
            let legacy = config_dir.join(package_name).join(CONFIGURATION_FILE_NAME);
            if legacy != _app_data_dir.join(CONFIGURATION_FILE_NAME) {
                paths.push(legacy);
            }
        }
    }

    paths
}

#[cfg(not(feature = "cli"))]
fn app_data_dir_with_fallback<R: Runtime>(app_handle: &tauri::AppHandle<R>) -> PathBuf {
    let package_name = env!("CARGO_PKG_NAME");
    app_handle
        .path()
        .data_dir()
        .unwrap_or_else(|err| {
            log::error!("Failed to get data directory: {err}. Using home directory instead.");

            let home_dir = std::env::var(if cfg!(target_os = "windows") {
                "USERPROFILE"
            } else {
                "HOME"
            })
            .expect("Failed to determine the home directory");

            PathBuf::from(home_dir)
        })
        .join(package_name)
}

/// Resolve the Jan config file path without an AppHandle (for CLI use).
/// Canonical location is `%APPDATA%/Jan/settings.json` (or OS equivalent),
/// with fallback recovery from bundle-id location when needed.
pub fn resolve_config_file_path() -> PathBuf {
    let app_data = resolve_human_readable_app_data_dir().unwrap_or_else(|| {
        let package_name = env!("CARGO_PKG_NAME");
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        PathBuf::from(home).join(package_name)
    });

    if let Err(err) = migrate_legacy_app_configuration(&app_data) {
        log::warn!("Legacy app config migration (CLI) skipped: {err}");
    }

    app_data.join(CONFIGURATION_FILE_NAME)
}

/// Run `f` with `JAN_DATA_FOLDER` pointed at a fresh temp directory, restoring
/// the previous value afterwards. Serialized on `TEST_ENV_LOCK`, the
/// one lock every `JAN_DATA_FOLDER` mutator takes: the env is process-wide and
/// Rust runs tests on threads, so a private lock here would exclude only the
/// other callers of this helper while the secret-store tests redirected the
/// folder (and dropped its temp dir) underneath a run already in progress.
#[cfg(all(test, feature = "cli"))]
pub(crate) fn with_temp_data_folder<T>(f: impl FnOnce(&std::path::Path) -> T) -> T {
    let _guard = crate::core::server::provider_secrets::TEST_ENV_LOCK.lock();

    let dir = tempfile::tempdir().expect("tempdir");
    let prev = std::env::var_os("JAN_DATA_FOLDER");
    std::env::set_var("JAN_DATA_FOLDER", dir.path());
    let result = f(dir.path());
    match prev {
        Some(p) => std::env::set_var("JAN_DATA_FOLDER", p),
        None => std::env::remove_var("JAN_DATA_FOLDER"),
    }
    result
}

/// Resolve the Jan data folder path without an AppHandle (for CLI use).
/// Reads AppConfiguration from the config file; falls back to the default location.
pub fn resolve_jan_data_folder() -> PathBuf {
    // Explicit override wins on every platform, tests included. `dirs::data_dir()`
    // reads XDG_DATA_HOME only on Linux, so tests/headless consumers need a
    // portable way to redirect the data folder without relying on OS-specific env.
    //
    // This is checked *before* the `cfg!(test)` fallback below, and that order
    // matters. With the fallback first, a test that set `JAN_DATA_FOLDER` got a
    // per-thread scratch directory instead of the one it asked for -- and since
    // the secret store writes through `spawn_blocking`, the store ran on a pool
    // thread and the load ran on the test thread, giving each a different folder
    // and turning "read back what I just wrote" into `None`.
    if let Ok(folder) = std::env::var("JAN_DATA_FOLDER") {
        if !folder.is_empty() {
            return PathBuf::from(folder);
        }
    }

    // Never the developer's real Jan folder under `cargo test`. This function
    // is reached from the agent dispatcher (the cancellation audit record), and
    // without this a test run would append to the data of whoever ran it --
    // the same mistake `get_jan_data_folder_path` already guards against. Tests
    // that want a shared folder across threads set the override above; this is
    // only the fail-closed default for those that set nothing.
    if cfg!(test) {
        let dir = std::env::temp_dir().join(format!(
            "jan-test-data-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::create_dir_all(&dir);
        return dir;
    }

    let config_file = resolve_config_file_path();

    if config_file.exists() {
        if let Ok(content) = fs::read_to_string(&config_file) {
            if let Ok(config) = serde_json::from_str::<AppConfiguration>(&content) {
                return PathBuf::from(config.data_folder);
            }
        }
    }

    // Default: data_dir/Jan/data  (mirrors default_data_folder_path)
    let app_name = std::env::var("APP_NAME").unwrap_or_else(|_| "Jan".to_string());
    if let Some(data_dir) = dirs::data_dir() {
        return data_dir.join(&app_name).join("data");
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home).join(&app_name).join("data")
}

#[cfg(not(feature = "cli"))]
#[tauri::command]
pub fn get_app_configurations<R: Runtime>(app_handle: tauri::AppHandle<R>) -> AppConfiguration {
    let mut app_default_configuration = AppConfiguration::default();

    if std::env::var("CI").unwrap_or_default() == "e2e" {
        return app_default_configuration;
    }

    // The same explicit override `resolve_jan_data_folder` honours. Without it
    // the two disagreed: settings resolved to the redirected folder while
    // everything reached through this one -- the extensions' own storage, and
    // so the user's configured providers -- resolved to the real folder. A
    // harness run then loaded the developer's real provider list and tried to
    // connect to their machines.
    if let Ok(folder) = std::env::var("JAN_DATA_FOLDER") {
        if !folder.is_empty() {
            app_default_configuration.data_folder = folder;
            return app_default_configuration;
        }
    }

    let app_path = app_data_dir_with_fallback(&app_handle);
    if let Err(err) = migrate_legacy_app_configuration(&app_path) {
        log::warn!("Legacy app config migration skipped: {err}");
    }

    let configuration_file = app_path.join(CONFIGURATION_FILE_NAME);

    let default_data_folder = default_data_folder_path(app_handle.clone());

    if !configuration_file.exists() {
        log::info!("App config not found, creating default config at {configuration_file:?}");

        app_default_configuration.data_folder = default_data_folder;

        if let Err(err) = fs::write(
            &configuration_file,
            serde_json::to_string(&app_default_configuration).unwrap(),
        ) {
            log::error!("Failed to create default config: {err}");
        }

        return app_default_configuration;
    }

    match fs::read_to_string(&configuration_file) {
        Ok(content) => {
            match serde_json::from_str::<AppConfiguration>(&content) {
                Ok(app_configurations) => app_configurations,
                Err(err) => {
                    log::error!("Failed to parse app config, returning default config instead. Error: {err}");
                    // Use the proper default data folder path, not the relative "./data"
                    app_default_configuration.data_folder = default_data_folder;
                    app_default_configuration
                }
            }
        }
        Err(err) => {
            log::error!(
                "Failed to read app config, returning default config instead. Error: {err}"
            );
            // Use the proper default data folder path, not the relative "./data"
            app_default_configuration.data_folder = default_data_folder;
            app_default_configuration
        }
    }
}

#[cfg(not(feature = "cli"))]
#[tauri::command]
pub fn update_app_configuration<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    configuration: AppConfiguration,
) -> Result<(), String> {
    let configuration_file = get_configuration_file_path(app_handle);
    log::info!("update_app_configuration, configuration_file: {configuration_file:?}");

    fs::write(
        configuration_file,
        serde_json::to_string(&configuration).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[cfg(not(feature = "cli"))]
#[tauri::command]
pub fn get_jan_data_folder_path<R: Runtime>(app_handle: tauri::AppHandle<R>) -> PathBuf {
    if cfg!(test) {
        use std::cell::RefCell;
        thread_local! {
            static TEST_DATA_DIR: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
        }

        return TEST_DATA_DIR.with(|dir| {
            let mut dir = dir.borrow_mut();
            if dir.is_none() {
                let unique_id = std::thread::current().id();
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                let path = std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(format!("test-data-{unique_id:?}-{timestamp}"));
                let _ = fs::create_dir_all(&path);
                *dir = Some(path);
            }
            dir.clone().unwrap()
        });
    }

    let app_configurations = get_app_configurations(app_handle);
    absolute_data_folder(
        PathBuf::from(app_configurations.data_folder),
        std::env::current_dir().ok(),
    )
}

/// The data folder as an absolute path.
///
/// A relative one -- the `./data` default `CI=e2e` serves -- was resolved by
/// each consumer against its own base. Most used the working directory, but
/// the settings store resolves a relative path against the OS app-data
/// directory, so an isolated harness run read and wrote `store.json` under the
/// installed app's own `%APPDATA%\jan.ai.app\data`, inherited its
/// `mcp_version`, and skipped the startup migrations it was meant to test.
#[cfg(not(feature = "cli"))]
fn absolute_data_folder(folder: PathBuf, cwd: Option<PathBuf>) -> PathBuf {
    match cwd {
        Some(cwd) if folder.is_relative() => cwd.join(folder),
        _ => folder,
    }
}

#[cfg(not(feature = "cli"))]
#[tauri::command]
pub fn get_configuration_file_path<R: Runtime>(app_handle: tauri::AppHandle<R>) -> PathBuf {
    let app_path = app_data_dir_with_fallback(&app_handle);
    if let Err(err) = migrate_legacy_app_configuration(&app_path) {
        log::warn!("Legacy app config migration skipped: {err}");
    }
    app_path.join(CONFIGURATION_FILE_NAME)
}

#[cfg(not(feature = "cli"))]
#[tauri::command]
pub fn default_data_folder_path<R: Runtime>(app_handle: tauri::AppHandle<R>) -> String {
    let mut path = app_handle.path().data_dir().unwrap_or_else(|err| {
        log::error!("Failed to get data directory: {err}. Falling back to home directory.");
        let home = std::env::var(if cfg!(target_os = "windows") {
            "USERPROFILE"
        } else {
            "HOME"
        })
        .unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home)
    });

    let app_name = std::env::var("APP_NAME")
        .unwrap_or_else(|_| app_handle.config().product_name.clone().unwrap());
    path.push(app_name);
    path.push("data");

    let mut path_str = path.to_string_lossy().into_owned();

    if let Some(stripped) = path_str.strip_suffix(".ai.app") {
        path_str = stripped.to_string();
    }

    path_str
}

#[cfg(not(feature = "cli"))]
#[tauri::command]
pub fn get_user_home_path<R: Runtime>(app: AppHandle<R>) -> String {
    get_app_configurations(app.clone()).data_folder
}

#[cfg(not(feature = "cli"))]
#[tauri::command]
pub fn change_app_data_folder<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    new_data_folder: String,
) -> Result<(), String> {
    // Get current data folder path
    let current_data_folder = get_jan_data_folder_path(app_handle.clone());
    let new_data_folder_path = PathBuf::from(&new_data_folder);

    // Create the new data folder if it doesn't exist
    if !new_data_folder_path.exists() {
        fs::create_dir_all(&new_data_folder_path)
            .map_err(|e| format!("Failed to create new data folder: {e}"))?;
    }

    // Copy all files from the old folder to the new one
    if current_data_folder.exists() {
        log::info!("Copying data from {current_data_folder:?} to {new_data_folder_path:?}");

        // Check if this is a parent directory to avoid infinite recursion
        if new_data_folder_path.starts_with(&current_data_folder) {
            return Err(
                "New data folder cannot be a subdirectory of the current data folder".to_string(),
            );
        }
        copy_dir_recursive(
            &current_data_folder,
            &new_data_folder_path,
            &[".uvx", ".npx", "openclaw"],
        )
        .map_err(|e| format!("Failed to copy data to new folder: {e}"))?;
    } else {
        log::info!("Current data folder does not exist, nothing to copy");
    }

    // Update the configuration to point to the new folder
    let mut configuration = get_app_configurations(app_handle.clone());
    configuration.data_folder = new_data_folder;

    // Save the updated configuration
    update_app_configuration(app_handle, configuration)
}

#[cfg(not(feature = "cli"))]
#[tauri::command]
pub fn app_token(state: State<'_, AppState>) -> Option<String> {
    state.app_token.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use tempfile::tempdir;

    /// A relative data folder is anchored at the working directory once, so
    /// no consumer can resolve it against a base of its own (the settings
    /// store used the OS app-data directory).
    #[cfg(not(feature = "cli"))]
    #[test]
    fn a_relative_data_folder_is_anchored_at_the_working_directory() {
        let cwd = PathBuf::from(if cfg!(windows) { r"C:\run" } else { "/run" });
        assert_eq!(
            absolute_data_folder(PathBuf::from("./data"), Some(cwd.clone())),
            cwd.join("./data")
        );
        assert!(absolute_data_folder(PathBuf::from("./data"), Some(cwd.clone())).is_absolute());
        let absolute = cwd.join("elsewhere");
        assert_eq!(
            absolute_data_folder(absolute.clone(), Some(PathBuf::from("/ignored"))),
            absolute
        );
        // No working directory to anchor at: left as given rather than guessed.
        assert_eq!(
            absolute_data_folder(PathBuf::from("data"), None),
            PathBuf::from("data")
        );
    }

    #[test]
    fn migration_recovers_legacy_then_removes_stale_copy() {
        let tmp = tempdir().expect("temp dir");
        let canonical_dir = tmp.path().join("Jan");
        let canonical = canonical_dir.join(CONFIGURATION_FILE_NAME);
        let legacy = tmp.path().join("jan.ai.app").join(CONFIGURATION_FILE_NAME);

        fs::create_dir_all(legacy.parent().unwrap()).expect("create legacy dir");
        fs::write(&legacy, r#"{"data_folder":"D:\\jan.ai"}"#).expect("write legacy config");

        migrate_from_candidates(&canonical, vec![legacy.clone()]).expect("migration succeeds");

        let recovered = fs::read_to_string(&canonical).expect("read canonical");
        assert!(
            recovered.contains(r#""data_folder":"D:\\jan.ai""#),
            "settings must be preserved in the canonical location"
        );
        assert!(
            !legacy.exists(),
            "stale legacy copy must be removed after recovery"
        );
    }

    #[test]
    fn migration_skips_when_canonical_exists() {
        let tmp = tempdir().expect("temp dir");
        let canonical_dir = tmp.path().join("Jan");
        let canonical = canonical_dir.join(CONFIGURATION_FILE_NAME);
        let legacy = tmp.path().join("jan.ai.app").join(CONFIGURATION_FILE_NAME);

        fs::create_dir_all(canonical.parent().unwrap()).expect("create canonical dir");
        fs::create_dir_all(legacy.parent().unwrap()).expect("create legacy dir");
        fs::write(&canonical, r#"{"data_folder":"D:\\kept"}"#).expect("write canonical config");
        fs::write(&legacy, r#"{"data_folder":"D:\\legacy"}"#).expect("write legacy config");

        migrate_legacy_app_configuration(&canonical_dir).expect("migration succeeds");

        let current = fs::read_to_string(&canonical).expect("read canonical");
        assert!(current.contains(r#""data_folder":"D:\\kept""#));
    }

    #[test]
    fn migration_handles_missing_legacy_files() {
        let tmp = tempdir().expect("temp dir");
        let canonical = tmp.path().join("Jan").join(CONFIGURATION_FILE_NAME);
        let missing = tmp.path().join("missing").join(CONFIGURATION_FILE_NAME);

        migrate_from_candidates(&canonical, vec![missing]).expect("migration succeeds");
        assert!(!canonical.exists(), "canonical should remain absent");
    }

    #[test]
    fn bundle_identifier_matches_tauri_conf() {
        let conf_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let content = fs::read_to_string(conf_path).expect("read tauri.conf.json");
        let json: Value = serde_json::from_str(&content).expect("parse tauri.conf.json");
        let identifier = json
            .get("identifier")
            .and_then(|v| v.as_str())
            .expect("identifier field exists");

        assert_eq!(
            identifier, TAURI_BUNDLE_IDENTIFIER,
            "TAURI_BUNDLE_IDENTIFIER must stay synced with tauri.conf.json"
        );
    }
}
