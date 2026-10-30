use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_llamacpp::cleanup_llama_processes;

use crate::core::app::commands::{
    default_data_folder_path, get_configuration_file_path, get_jan_data_folder_path,
    write_configuration_atomic,
};
use crate::core::app::constants::{
    JAN_DATA_DIRS_COMMON, JAN_DATA_DIRS_CONVERSATIONS, JAN_DATA_DIRS_MODELS,
    JAN_DATA_FILES_CONFIGS, JAN_DATA_FILES_SETTINGS,
};
use crate::core::app::models::AppConfiguration;
use crate::core::mcp::helpers::{stop_mcp_servers_with_context, ShutdownContext};
use crate::core::state::AppState;

fn is_safe_to_delete(path: &std::path::Path) -> bool {
    // Count real folder names: a drive prefix and root do not make `C:\Users` deeper.
    let depth = path
        .components()
        .filter(|c| matches!(c, std::path::Component::Normal(_)))
        .count();
    depth >= 2
}

fn remove_dir(data_folder: &std::path::Path, name: &str) -> Vec<String> {
    let path = data_folder.join(name);
    let mut failures = Vec::new();
    if path.is_dir() {
        log::info!("Removing directory: {}", path.display());
        if let Err(e) = fs::remove_dir_all(&path) {
            log::warn!("Failed to remove {}: {e}", path.display());
            failures.push(format!("{}: {e}", path.display()));
        }
    }
    failures
}

fn remove_file(data_folder: &std::path::Path, name: &str) -> Vec<String> {
    let path = data_folder.join(name);
    let mut failures = Vec::new();
    if path.is_file() {
        log::info!("Removing file: {}", path.display());
        if let Err(e) = fs::remove_file(&path) {
            log::warn!("Failed to remove {}: {e}", path.display());
            failures.push(format!("{}: {e}", path.display()));
        }
    }
    failures
}

/// Delete conversations and user content (threads, assistants, archive,
/// attachments, rooms, schedules, Studio output, vector databases).
fn delete_conversations(data_folder: &std::path::Path) -> Vec<String> {
    log::info!("Deleting conversations and user content");
    JAN_DATA_DIRS_CONVERSATIONS
        .iter()
        .flat_map(|dir| remove_dir(data_folder, dir))
        .collect()
}

/// Delete downloaded models, engine binaries, and configuration files
/// (engine settings, MCP config, etc.).
fn delete_models_and_configs(data_folder: &std::path::Path) -> Vec<String> {
    log::info!("Deleting models, engines, and configurations");
    let mut failures: Vec<String> = JAN_DATA_DIRS_MODELS
        .iter()
        .flat_map(|dir| remove_dir(data_folder, dir))
        .collect();
    for file in JAN_DATA_FILES_CONFIGS {
        failures.extend(remove_file(data_folder, file));
    }
    failures
}

/// Delete extensions, logs, caches - always cleaned during any reset.
fn delete_common_data(data_folder: &std::path::Path) -> Vec<String> {
    log::info!("Deleting common data (extensions, logs, caches)");
    JAN_DATA_DIRS_COMMON
        .iter()
        .flat_map(|dir| remove_dir(data_folder, dir))
        .collect()
}

/// Delete cross-category settings (store.json) - only during a full wipe
/// when the user is not keeping any data.
fn delete_settings(data_folder: &std::path::Path) -> Vec<String> {
    log::info!("Deleting cross-category settings (store.json)");
    JAN_DATA_FILES_SETTINGS
        .iter()
        .flat_map(|file| remove_file(data_folder, file))
        .collect()
}

/// Full wipe only: remove every remaining top-level entry so a feature
/// directory added later is cleaned by default.
fn delete_remaining_top_level(data_folder: &std::path::Path) -> Vec<String> {
    let mut failures = Vec::new();
    let entries = match fs::read_dir(data_folder) {
        Ok(e) => e,
        Err(e) => return vec![format!("{}: {e}", data_folder.display())],
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let res = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        if let Err(e) = res {
            log::warn!("Failed to remove {}: {e}", path.display());
            failures.push(format!("{}: {e}", path.display()));
        }
    }
    failures
}

/// Clear the WebKit/WRY webview profile (localStorage, cookies, IndexedDB,
/// updater state) stored in the bundle-id app-data dir (e.g. `jan.ai.app/`).
/// Distinct from the product-name data folder; only removed on explicit opt-in.
fn clear_webview_profile<R: Runtime>(
    app_handle: &tauri::AppHandle<R>,
    data_folder: &std::path::Path,
) {
    let webview_dir = match app_handle.path().app_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            log::warn!("Cannot resolve webview profile dir: {e}");
            return;
        }
    };

    // Never touch the dir if it is the user's data folder or contains it.
    if webview_dir == data_folder || data_folder.starts_with(&webview_dir) {
        log::warn!(
            "Skipping webview clear: data folder lives inside {}",
            webview_dir.display()
        );
        return;
    }

    if !webview_dir.is_dir() || !is_safe_to_delete(&webview_dir) {
        return;
    }

    log::info!("Clearing webview profile: {}", webview_dir.display());
    if let Err(e) = fs::remove_dir_all(&webview_dir) {
        log::warn!(
            "Failed to clear webview profile {}: {e}",
            webview_dir.display()
        );
    }
}

const WEBDATA_RESET_SENTINEL: &str = ".pending-webdata-reset";

/// Flags describing what a pending reset should prune from webview localStorage.
/// Consumed by the frontend on next startup before stores hydrate.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct WebdataResetFlags {
    pub keep_app_data: bool,
    pub keep_models_and_configs: bool,
    pub clear_web_data: bool,
}

/// Sentinel lives in the app config dir (alongside settings.json), which
/// survives the data-folder wipe.
fn webdata_reset_sentinel_path<R: Runtime>(app_handle: &tauri::AppHandle<R>) -> Option<PathBuf> {
    get_configuration_file_path(app_handle.clone())
        .parent()
        .map(|dir| dir.join(WEBDATA_RESET_SENTINEL))
}

const FACTORY_RESET_REPORT: &str = "factory-reset-report.json";

/// What a factory reset could not remove. Written to the app config dir (which
/// survives the data-folder wipe) so the next start can tell the user once.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct FactoryResetReport {
    pub failures: Vec<String>,
}

fn factory_reset_report_path<R: Runtime>(app_handle: &tauri::AppHandle<R>) -> Option<PathBuf> {
    get_configuration_file_path(app_handle.clone())
        .parent()
        .map(|dir| dir.join(FACTORY_RESET_REPORT))
}

fn write_report_at(path: &Path, failures: &[String]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(&FactoryResetReport {
        failures: failures.to_vec(),
    })
    .map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

/// Read and remove the report. An empty or unreadable file yields `None`.
fn take_report_at(path: &Path) -> Option<FactoryResetReport> {
    if !path.is_file() {
        return None;
    }
    let report = fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str::<FactoryResetReport>(&c).ok())
        .filter(|r| !r.failures.is_empty());
    if let Err(e) = fs::remove_file(path) {
        log::warn!("Failed to remove factory reset report: {e}");
    }
    report
}

/// The one-shot list of paths the last factory reset could not remove, for the
/// webview to show once on the start after the reset.
#[tauri::command]
pub fn take_factory_reset_report<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Option<FactoryResetReport> {
    take_report_at(&factory_reset_report_path(&app_handle)?)
}

/// Log what a reset could not remove and persist it for the next start. Does
/// nothing for an empty list.
fn report_failures<R: Runtime>(app_handle: &tauri::AppHandle<R>, failures: &[String]) {
    if failures.is_empty() {
        return;
    }
    log::error!("Factory reset incomplete: {}", failures.join("; "));
    match factory_reset_report_path(app_handle) {
        Some(path) => {
            if let Err(e) = write_report_at(&path, failures) {
                log::warn!("Failed to write factory reset report: {e}");
            }
        }
        None => log::warn!("No config dir for the factory reset report"),
    }
}

fn write_webdata_reset_sentinel<R: Runtime>(
    app_handle: &tauri::AppHandle<R>,
    keep_app_data: bool,
    keep_models_and_configs: bool,
    clear_web_data: bool,
) {
    let Some(path) = webdata_reset_sentinel_path(app_handle) else {
        return;
    };
    let flags = WebdataResetFlags {
        keep_app_data,
        keep_models_and_configs,
        clear_web_data,
    };
    match serde_json::to_string(&flags) {
        Ok(json) => {
            if let Err(e) = fs::write(&path, json) {
                log::warn!("Failed to write webdata reset sentinel: {e}");
            }
        }
        Err(e) => log::warn!("Failed to serialize webdata reset flags: {e}"),
    }
}

/// Read and remove the pending-reset sentinel. Returns the flags if one existed
/// so the frontend can prune the matching localStorage keys before hydration.
#[tauri::command]
pub fn take_pending_webdata_reset<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Option<WebdataResetFlags> {
    let path = webdata_reset_sentinel_path(&app_handle)?;
    if !path.is_file() {
        return None;
    }
    let flags = fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str::<WebdataResetFlags>(&content).ok());
    if let Err(e) = fs::remove_file(&path) {
        log::warn!("Failed to remove webdata reset sentinel: {e}");
    }
    flags
}

/// Detect the user's default shell and return the appropriate env file path.
/// Returns (shell_name, env_file_path).
fn detect_shell_env_file(home_dir: &str, is_macos: bool) -> (&'static str, String) {
    let shell = std::env::var("SHELL").unwrap_or_default();
    if shell.ends_with("/bash") {
        // macOS uses login shells in Terminal, so ~/.bash_profile is sourced.
        // Linux interactive shells source ~/.bashrc.
        let file = if is_macos {
            format!("{}/.bash_profile", home_dir)
        } else {
            format!("{}/.bashrc", home_dir)
        };
        ("bash", file)
    } else {
        // Default to zsh (macOS default since Catalina)
        ("zsh", format!("{}/.zshenv", home_dir))
    }
}

/// Quote `value` for a POSIX shell: single quotes, with each embedded single
/// quote written as `'\''`, so no character in it is ever interpreted (#95).
fn sh_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// `export` lines for the shell config, keys validated, values quoted (#95).
fn render_env_exports(env_vars: &[(String, String)]) -> String {
    env_vars
        .iter()
        .map(|(k, v)| format!("export {}={}\n", k, sh_single_quote(v)))
        .collect()
}

/// A shell variable name: `[A-Za-z_][A-Za-z0-9_]*`.
fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Variables that change how every later process loads code or resolves
/// commands. Writing one into a shell rc or the user registry is persistence,
/// not Claude Code configuration.
fn is_blocked_env_key(key: &str) -> bool {
    let k = key.to_ascii_uppercase();
    k.starts_with("LD_")
        || k.starts_with("DYLD_")
        || matches!(
            k.as_str(),
            "PATH"
                | "PATHEXT"
                | "COMSPEC"
                | "BASH_ENV"
                | "ENV"
                | "PROMPT_COMMAND"
                | "PS1"
                | "IFS"
                | "SHELL"
                | "HOME"
                | "USERPROFILE"
                | "PYTHONPATH"
                | "PYTHONSTARTUP"
                | "PYTHONHOME"
                | "NODE_OPTIONS"
                | "NODE_PATH"
                | "PERL5OPT"
                | "PERL5LIB"
                | "RUBYOPT"
                | "RUBYLIB"
                | "JAVA_TOOL_OPTIONS"
                | "_JAVA_OPTIONS"
                | "CLASSPATH"
                | "GIT_SSH_COMMAND"
                | "GIT_EXEC_PATH"
        )
}

/// Replace `path` with `content` through a temp file in the same directory,
/// keeping the original's permissions and following a symlinked rc file.
fn atomic_write_preserving(path: &str, content: &str) -> Result<(), String> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| std::path::PathBuf::from(path));
    let dir = target
        .parent()
        .ok_or_else(|| "env file has no parent directory".to_string())?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "env".to_string());
    let tmp = dir.join(format!(".{name}.flint-tmp"));
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    if let Ok(meta) = std::fs::metadata(&target) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

// Helper function to write env vars to a shell config file
fn write_env_to_shell(env_file_path: &str, env_vars: &[(String, String)]) -> Result<(), String> {
    let marker = "# Jan Local API Server - Claude Code Config";
    let new_entries = render_env_exports(env_vars);

    let existing_content = std::fs::read_to_string(env_file_path).unwrap_or_default();
    // Drop the whole block written last time, custom variables included, so a
    // re-save replaces it instead of piling up copies.
    let cleaned = strip_jan_env_block(&existing_content);

    let new_content = format!("{}\n{}\n{}\n", marker, new_entries, marker);

    let final_content = cleaned + "\n" + new_content.as_str();
    atomic_write_preserving(env_file_path, &final_content)?;
    Ok(())
}

const JAN_ENV_MARKER: &str = "# Jan Local API Server - Claude Code Config";

/// `content` without the block Jan wrote between its two marker lines, every
/// variable in it included (custom ones too, not only `ANTHROPIC_*`). Stray
/// marker lines are dropped too. An unclosed block runs to the end of the
/// file, since Jan always appends its block last. Only when no marker line
/// exists is the legacy layout cleaned: a `# Jan Local API Server` header and
/// the exact exports Flint wrote directly under it. The user's own
/// `ANTHROPIC_*` exports are never touched.
fn strip_jan_env_block(content: &str) -> String {
    let lines: Vec<&str> = content.split('\n').collect();
    let has_marker = lines.iter().any(|l| l.starts_with(JAN_ENV_MARKER));
    let mut kept: Vec<&str> = Vec::new();
    if has_marker {
        let mut inside = false;
        for line in lines {
            if line.starts_with(JAN_ENV_MARKER) {
                inside = !inside;
            } else if !inside {
                kept.push(line);
            }
        }
    } else {
        let mut i = 0;
        while i < lines.len() {
            if lines[i].starts_with("# Jan Local API Server") {
                i += 1;
                while i < lines.len() && is_legacy_env_export(lines[i]) {
                    i += 1;
                }
            } else {
                kept.push(lines[i]);
                i += 1;
            }
        }
    }
    kept.join("\n").trim_end().to_string()
}

/// Names Flint wrote in older versions, outside any marker block.
const LEGACY_ENV_NAMES: [&str; 5] = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

fn is_legacy_env_export(line: &str) -> bool {
    line.strip_prefix("export ")
        .and_then(|rest| rest.split('=').next())
        .is_some_and(|name| LEGACY_ENV_NAMES.contains(&name.trim()))
}

/// Where the names of the variables `setx` wrote on Windows are recorded, so
/// Reset can remove custom ones too, not only the fixed `ANTHROPIC_*` names.
fn claude_code_env_keys_path() -> PathBuf {
    crate::core::app::commands::resolve_jan_data_folder().join("claude-code-env-keys.json")
}

fn load_claude_code_env_keys(path: &std::path::Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str(&raw) {
        Ok(keys) => keys,
        Err(e) => {
            // Reading garbage as "nothing recorded" would let the next save
            // erase the names; keep the file aside instead.
            log::warn!("claude-code-env-keys.json is unreadable ({e}); moved to .bak");
            let _ = std::fs::rename(path, path.with_extension("json.bak"));
            Vec::new()
        }
    }
}

fn save_claude_code_env_keys(path: &std::path::Path, keys: &[String]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(keys).map_err(|e| e.to_string())?;
    atomic_write_preserving(&path.to_string_lossy(), &json)
}

fn record_claude_code_env_keys(path: &std::path::Path, keys: &[String]) -> Result<(), String> {
    let mut all = load_claude_code_env_keys(path);
    for key in keys {
        if !all.contains(key) {
            all.push(key.clone());
        }
    }
    save_claude_code_env_keys(path, &all)
}

/// Recorded names that the new variable set no longer contains: they were
/// written by an earlier `setx` and must be deleted, or a removed custom
/// variable lingers in the user environment.
fn stale_claude_code_env_keys(recorded: &[String], current: &[String]) -> Vec<String> {
    recorded
        .iter()
        .filter(|k| !current.contains(k))
        .cloned()
        .collect()
}

/// Drop `forget` from the recorded names.
fn forget_claude_code_env_keys(path: &std::path::Path, forget: &[String]) -> Result<(), String> {
    let kept: Vec<String> = load_claude_code_env_keys(path)
        .into_iter()
        .filter(|k| !forget.contains(k))
        .collect();
    save_claude_code_env_keys(path, &kept)
}

/// Every user variable Reset removes on Windows: the fixed Claude Code names
/// plus whatever was recorded when it was written.
fn claude_code_env_keys_to_clear(recorded: Vec<String>) -> Vec<String> {
    let mut keys: Vec<String> = [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
    ]
    .iter()
    .map(|k| k.to_string())
    .collect();
    for key in recorded {
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

/// Delete the data-folder categories selected by the keep flags. Returns the
/// paths that could not be removed. A full wipe also sweeps every remaining
/// top-level entry and the stored secrets.
fn wipe_data_folder(
    data_folder: &std::path::Path,
    keep_app_data: bool,
    keep_models_and_configs: bool,
) -> Vec<String> {
    let mut failures = delete_common_data(data_folder);
    if !keep_app_data {
        failures.extend(delete_conversations(data_folder));
    }
    if !keep_models_and_configs {
        failures.extend(delete_models_and_configs(data_folder));
    }
    // store.json spans all categories; only wipe it when nothing is kept
    if !keep_app_data && !keep_models_and_configs {
        failures.extend(delete_settings(data_folder));
        failures.extend(delete_remaining_top_level(data_folder));
    }
    failures
}

#[tauri::command]
pub async fn factory_reset<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    keep_app_data: Option<bool>,
    keep_models_and_configs: Option<bool>,
    clear_web_data: Option<bool>,
) -> Result<(), String> {
    // Async so the slow stops and deletes run off the main thread: a sync
    // command blocked the event loop, the window froze and never closed.
    // Ok in every case that reaches the restart: the windows are hidden by
    // now, so an error would leave the app running with no visible window.
    let keep_app_data = keep_app_data.unwrap_or(false);
    let keep_models_and_configs = keep_models_and_configs.unwrap_or(false);
    let clear_web_data = clear_web_data.unwrap_or(false);
    let full_wipe = !keep_app_data && !keep_models_and_configs;

    // The exit handler must not hold the restart for a graceful engine stop.
    #[cfg(not(feature = "cli"))]
    crate::mark_shutting_down();

    // Hide instead of close: the restart tears the windows down anyway, and
    // the user sees the app go away at once instead of a frozen window.
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    for (label, window) in app_handle.webview_windows().iter() {
        if window.hide().is_err() {
            log::warn!("Failed to hide window: {label:?}");
        }
    }
    let data_folder = get_jan_data_folder_path(app_handle.clone());
    log::info!(
        "Factory reset (keep_app_data={}, keep_models_and_configs={}, clear_web_data={}), data folder: {:?}",
        keep_app_data,
        keep_models_and_configs,
        clear_web_data,
        data_folder
    );

    let mut failures: Vec<String> = Vec::new();
    let _ = stop_mcp_servers_with_context(&app_handle, &state, ShutdownContext::FactoryReset).await;

    {
        let mut active_servers = state.mcp_active_servers.lock().await;
        active_servers.clear();
    }

    use crate::core::mcp::lockfile::cleanup_own_locks;
    if let Err(e) = cleanup_own_locks(&app_handle) {
        log::warn!("Failed to cleanup lock files: {}", e);
    }
    let _ = cleanup_llama_processes(app_handle.clone()).await;

    if data_folder.exists() {
        if !is_safe_to_delete(&data_folder) {
            let msg = format!(
                "Refusing factory reset: path is too close to filesystem root: {}",
                data_folder.display()
            );
            report_failures(&app_handle, &[msg]);
            // Nothing was removed; just bring the window back.
            app_handle.restart();
        }

        let folder = data_folder.clone();
        let wiped = tauri::async_runtime::spawn_blocking(move || {
            use crate::core::app::settings_store::{discard_settings, flush_settings};
            if full_wipe {
                // settings.json goes with the full wipe: stop the in-memory
                // store first so no debounced or exit flush writes it back.
                discard_settings();
                // Secrets live mostly in the OS keyring; clear them while the
                // index can still name them (kept out of wipe_data_folder so
                // tests never touch the real keyring).
                let wiped = crate::core::server::provider_secrets::wipe_all_secrets();
                log::info!("Factory reset: wiped {wiped} stored secret(s)");
            } else {
                // settings.json is kept: write pending changes now.
                flush_settings();
            }
            wipe_data_folder(&folder, keep_app_data, keep_models_and_configs)
        })
        .await;
        match wiped {
            Ok(f) => failures.extend(f),
            Err(e) => failures.push(format!("Factory reset task failed: {e}")),
        }
    }

    // Restart even when something could not be removed (the windows are
    // already hidden); the next start shows the list once.
    report_failures(&app_handle, &failures);

    // Reset app configuration to defaults unless user chose to keep configs
    if !keep_models_and_configs {
        let default_config = AppConfiguration {
            data_folder: default_data_folder_path(app_handle.clone()),
            unavailable_data_folder: None,
        };
        // A reset is meant to replace the file even when it could not be read.
        let _ = write_configuration_atomic(
            &get_configuration_file_path(app_handle.clone()),
            &default_config,
        );
    }

    // Persisted UI state (model-provider, setup flag) lives in webview
    // localStorage, not the data folder. Renderer-side removal races the
    // restart flush, and the on-disk localStorage location is
    // platform-specific (esp. macOS WKWebView), so instead drop a sentinel
    // that the frontend consumes on next startup to clear localStorage via
    // the webview API before stores hydrate. File-level profile deletion
    // (Linux cookies/cache) stays as a best-effort supplement.
    if !keep_app_data || !keep_models_and_configs || clear_web_data {
        write_webdata_reset_sentinel(
            &app_handle,
            keep_app_data,
            keep_models_and_configs,
            clear_web_data,
        );
    }
    if clear_web_data || full_wipe {
        let app = app_handle.clone();
        let folder = data_folder.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || clear_webview_profile(&app, &folder))
            .await;
    }

    app_handle.restart();
}

#[tauri::command]
pub fn relaunch<R: Runtime>(app: AppHandle<R>) {
    app.restart()
}

#[tauri::command]
pub fn open_app_directory<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let app_path = get_jan_data_folder_path(app.clone());
    let program = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let mut command = std::process::Command::new(program);
    // `xdg-open` hands off to the user's file manager, which must not load the
    // AppImage's libraries.
    jan_process::HostProcessEnv::host_env(&mut command);
    command
        .arg(app_path)
        .status()
        .map_err(|e| format!("Failed to open app directory: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn read_logs<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let log_path = get_jan_data_folder_path(app).join("logs").join("app.log");
    if log_path.exists() {
        let content = fs::read_to_string(log_path).map_err(|e| e.to_string())?;
        Ok(content)
    } else {
        Err("Log file not found".to_string())
    }
}

/// Most of `app.log` one [`read_logs_since`] call returns.
const LOG_CHUNK_BYTES: u64 = 2 * 1024 * 1024;

/// New log text and where the next read starts.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct LogChunk {
    pub text: String,
    pub offset: u64,
    /// The text does not continue the caller's offset (first read, or the
    /// log was rotated or truncated): replace what is shown, do not append.
    pub reset: bool,
}

/// Read whole lines of `path` from `offset`, at most `cap` bytes. With no
/// offset, or one past the end, the tail of the file is returned instead, so
/// the viewer polls only new lines and never re-reads a 10 MB log.
pub fn read_log_chunk(path: &Path, offset: Option<u64>, cap: u64) -> std::io::Result<LogChunk> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    let (start, reset) = match offset {
        Some(o) if o <= len => (o, false),
        _ => (len.saturating_sub(cap), true),
    };
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    file.take(cap).read_to_end(&mut buf)?;
    let mut begin = 0;
    if reset && start > 0 {
        // Started mid-line: drop the partial first line.
        begin = buf.iter().position(|&b| b == b'\n').map_or(buf.len(), |i| i + 1);
    }
    // Only complete lines; a line still being written is read next time.
    let end = buf.iter().rposition(|&b| b == b'\n').map_or(begin, |i| (i + 1).max(begin));
    Ok(LogChunk {
        text: String::from_utf8_lossy(&buf[begin..end]).into_owned(),
        offset: start + end as u64,
        reset,
    })
}

/// The log lines appended since `offset` (report-24 #8).
#[tauri::command]
pub async fn read_logs_since<R: Runtime>(
    app: AppHandle<R>,
    offset: Option<u64>,
) -> Result<LogChunk, String> {
    let log_path = get_jan_data_folder_path(app).join("logs").join("app.log");
    tokio::task::spawn_blocking(move || read_log_chunk(&log_path, offset, LOG_CHUNK_BYTES))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "Log file not found".to_string())
}

/// How much of `app.log` the redacted export carries.
const EXPORT_LOG_TAIL_LINES: usize = 5000;

/// The log text with known credential shapes removed: the CLI bundle's two
/// passes (`flint bug-report`), the regex rules and the agent tools' scanner.
fn redact_log_text(text: &str) -> String {
    use crate::core::log_redaction::SHARED;
    let first = SHARED.scrub(text);
    tauri_plugin_agent_tools::secrets::redact_secrets(&first)
}

/// Bytes of `app.log` read for the export; the line cap applies inside this.
const EXPORT_LOG_TAIL_BYTES: u64 = 1024 * 1024;

/// The last `max_lines` lines of `path`, reading only its final `max_bytes`.
fn read_log_tail(path: &Path, max_bytes: u64, max_lines: usize) -> std::io::Result<String> {
    let chunk = read_log_chunk(path, None, max_bytes)?;
    let lines: Vec<&str> = chunk.text.lines().collect();
    Ok(lines[lines.len().saturating_sub(max_lines)..].join("
"))
}

/// Write the tail of the app log, redacted, to a file the user picks in a save
/// dialog opened here, so the renderer never names the destination. Only the
/// log is included, never thread contents. `None` means the user cancelled.
#[tauri::command]
pub async fn export_redacted_logs<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    use crate::core::filesystem::export_file::{pick_path, sanitize_file_name, write_atomically};
    let log_path = get_jan_data_folder_path(app).join("logs").join("app.log");
    let tail = tokio::task::spawn_blocking(move || {
        read_log_tail(&log_path, EXPORT_LOG_TAIL_BYTES, EXPORT_LOG_TAIL_LINES)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|_| "Log file not found".to_string())?;
    let report = format!(
        "Flint {} log export ({} {})
Known secrets are stripped; the scan is best-effort, so review before sharing.

{}
",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        redact_log_text(&tail)
    );
    let name = sanitize_file_name("flint-logs", "txt");
    let Some(path) = pick_path("txt", &name).await else {
        return Ok(None);
    };
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Refusing to write through a symbolic link".to_string());
    }
    write_atomically(&path, report.as_bytes())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// The desktop diagnostic bundle's members: what `flint bug-report` carries
/// that the desktop has (version, environment, the app log redacted), cut to
/// the same per-member and total caps.
fn diagnostic_members(log_tail: &str) -> Vec<(String, String)> {
    use crate::core::diagnostics_bundle::{cap_members, MEMBER_CAP, TOTAL_CAP};
    let mut members = vec![
        ("version.txt".to_string(), format!("Flint {}\n", env!("CARGO_PKG_VERSION"))),
        (
            "environment.txt".to_string(),
            format!("os={}\narch={}\n", std::env::consts::OS, std::env::consts::ARCH),
        ),
        ("logs/app.log".to_string(), redact_log_text(log_tail)),
    ];
    cap_members(&mut members, MEMBER_CAP, TOTAL_CAP);
    members
}

/// Save a diagnostic bundle (`.tar.gz`, the CLI bug-report format) to a file
/// the user picks in a save dialog opened here. No thread contents, nothing
/// uploaded. `None` means the user cancelled.
#[tauri::command]
pub async fn export_diagnostic_bundle<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    use crate::core::diagnostics_bundle::MEMBER_CAP;
    use crate::core::filesystem::export_file::{pick_path, sanitize_file_name, write_atomically};
    let log_path = get_jan_data_folder_path(app).join("logs").join("app.log");
    // A missing log is not fatal: the bundle still says which build and OS.
    let tail = tokio::task::spawn_blocking(move || read_log_tail(&log_path, MEMBER_CAP as u64, usize::MAX))
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let archive = crate::core::diagnostics_bundle::write_archive(Vec::new(), &diagnostic_members(&tail))?;
    let name = sanitize_file_name("flint-diagnostics.tar", "gz");
    let Some(path) = pick_path("gz", &name).await else {
        return Ok(None);
    };
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Refusing to write through a symbolic link".to_string());
    }
    write_atomically(&path, &archive)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command(async)]
pub fn launch_claude_code_with_config(
    api_url: String,
    api_key: Option<String>,
    big_model: Option<String>,
    medium_model: Option<String>,
    small_model: Option<String>,
    fable_model: Option<String>,
    custom_env_vars: Vec<serde_json::Value>,
) -> Result<(), String> {
    let env_vars = build_claude_code_env_vars(
        api_url,
        api_key,
        big_model,
        medium_model,
        small_model,
        fable_model,
        custom_env_vars,
    )?;

    // Claude Code talks to Flint's local API server, which authenticates inbound
    // requests against its own key (the proxy_api_key). ANTHROPIC_AUTH_TOKEN
    // MUST therefore be the local server key, and there is no valid placeholder:
    // anything else reaches the proxy, passes its key check, and then gets
    // rejected by the remote provider as a bogus credential (an opaque 403).
    // Refuse to launch with a clear message rather than ship a fake key.
    write_claude_code_env_vars(&env_vars)
}

/// Build the environment variable map for the Claude Code integration.
/// Returns an error if no local API key is set, since the proxy will not
/// authenticate the session otherwise.
fn build_claude_code_env_vars(
    api_url: String,
    api_key: Option<String>,
    big_model: Option<String>,
    medium_model: Option<String>,
    small_model: Option<String>,
    fable_model: Option<String>,
    custom_env_vars: Vec<serde_json::Value>,
) -> Result<Vec<(String, String)>, String> {
    let token = api_key.filter(|k| !k.trim().is_empty()).ok_or_else(|| {
        "No local API key is set. Open Settings > Local API Server, set an API key, \
             and try again: Claude Code needs a real key to authenticate with the local \
             server and reach remote models."
            .to_string()
    })?;

    // A tier left unset keeps Claude Code's real model name for it, and the
    // default (Sonnet) tier is the one a session starts on. That name reaches
    // the local server, matches nothing, and surfaces as a login error
    // (janhq/jan issue 8107). Every tier follows a chosen model instead, the
    // medium one first since it is the default.
    let fallback = medium_model
        .clone()
        .or_else(|| big_model.clone())
        .or_else(|| small_model.clone())
        .or_else(|| fable_model.clone());
    let big_model = big_model.or_else(|| fallback.clone());
    let medium_model = medium_model.or_else(|| fallback.clone());
    let small_model = small_model.or_else(|| fallback.clone());
    let fable_model = fable_model.or(fallback);

    let mut env_vars: Vec<(String, String)> = Vec::with_capacity(8);
    env_vars.push(("ANTHROPIC_BASE_URL".to_string(), api_url));
    env_vars.push(("ANTHROPIC_AUTH_TOKEN".to_string(), token));

    if let Some(model) = big_model {
        env_vars.push(("ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(), model));
    }

    if let Some(model) = medium_model {
        env_vars.push(("ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(), model));
    }

    if let Some(model) = small_model {
        env_vars.push(("ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(), model));
    }

    if let Some(model) = fable_model {
        env_vars.push(("ANTHROPIC_DEFAULT_FABLE_MODEL".to_string(), model));
    }

    // Add custom env vars from the custom CLI section
    for env in &custom_env_vars {
        if let (Some(key), Some(value)) = (
            env.get("key").and_then(|v| v.as_str()),
            env.get("value").and_then(|v| v.as_str()),
        ) {
            // #95: these are written into a shell startup file.
            if !is_valid_env_key(key) {
                return Err(format!(
                    "Invalid environment variable name {key:?}: use letters, digits and \
                     underscores, not starting with a digit."
                ));
            }
            if is_blocked_env_key(key) {
                return Err(format!(
                    "The environment variable {key} cannot be set here: it changes how \
                     programs load code or find commands."
                ));
            }
            if value.contains('\0') {
                return Err(format!("The value of {key} contains a NUL byte."));
            }
            env_vars.push((key.to_string(), value.to_string()));
        }
    }

    Ok(env_vars)
}

/// Persist the Claude Code environment variables to the user's shell config
/// (macOS/Linux) or the Windows registry, then return the result.
fn write_claude_code_env_vars(env_vars: &[(String, String)]) -> Result<(), String> {
    // Build the command environment
    // Export environment variables to the user's shell config file

    if cfg!(target_os = "macos") {
        let home_dir = std::env::var("HOME").map_err(|e| e.to_string())?;
        let (shell_name, env_file_path) = detect_shell_env_file(&home_dir, true);
        log::info!(
            "Detected shell: {}, writing env to: {}",
            shell_name,
            env_file_path
        );

        // Try direct write first
        match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&env_file_path)
        {
            Ok(_) => {
                write_env_to_shell(&env_file_path, env_vars)?;
                Ok(())
            }
            Err(_) => {
                // Never write a user's rc file as root: the file is
                // user-owned, so a failure here means it is read-only or
                // locked and the user has to fix that themselves.
                Err(format!(
                    "Could not write {env_file_path}. Make the file writable and try again, \
                     or add the exported variables to it manually."
                ))
            }
        }
    } else if cfg!(target_os = "linux") {
        let home_dir = std::env::var("HOME").map_err(|e| e.to_string())?;
        let (shell_name, env_file_path) = detect_shell_env_file(&home_dir, false);
        log::info!(
            "Detected shell: {}, writing env to: {}",
            shell_name,
            env_file_path
        );

        match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&env_file_path)
        {
            Ok(_) => {
                write_env_to_shell(&env_file_path, env_vars)?;
                Ok(())
            }
            Err(_) => {
                let jan_config_dir = format!("{}/.config/jan", home_dir);
                let ext = if shell_name == "bash" { "bash" } else { "zsh" };
                let env_file = format!("{}/claude-code-env.{}", jan_config_dir, ext);
                Err(format!("NEED_PERMISSION:{}", env_file))
            }
        }
    } else {
        // On Windows, set persistent user environment variables using setx.
        // Record the names first, so Reset can find every one even if a later
        // setx fails part-way.
        let names: Vec<String> = env_vars.iter().map(|(k, _)| k.clone()).collect();
        let keys_path = claude_code_env_keys_path();
        // Delete what an earlier apply wrote but this one no longer sets, so a
        // removed custom variable does not linger (#122).
        let stale = stale_claude_code_env_keys(&load_claude_code_env_keys(&keys_path), &names);
        let mut deleted = Vec::with_capacity(stale.len());
        for key in stale {
            use jan_process::CommandConsole;
            // A missing value makes `reg delete` fail, which also means it is
            // gone; only a command that could not run keeps the name recorded.
            if std::process::Command::new("reg")
                .args(["delete", "HKCU\\Environment", "/v", &key, "/f"])
                .background()
                .output()
                .is_ok()
            {
                deleted.push(key);
            }
        }
        if !deleted.is_empty() {
            if let Err(e) = forget_claude_code_env_keys(&keys_path, &deleted) {
                log::warn!("Could not update the recorded Claude Code env var names: {e}");
            }
        }
        if let Err(e) = record_claude_code_env_keys(&keys_path, &names) {
            log::warn!("Could not record the Claude Code env var names: {e}");
        }
        for (key, value) in env_vars {
            use jan_process::CommandConsole;
            let output = std::process::Command::new("setx")
                .arg(key)
                .arg(value)
                .background()
                .output()
                .map_err(|e| e.to_string())?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Failed to set env var {}: {}", key, stderr));
            }
        }

        log::info!("Environment variables set permanently in Windows registry.");
        Ok(())
    }
}

/// A Claude Code setting that overrides the environment Flint writes.
#[derive(serde::Serialize, Debug, Clone)]
pub struct ClaudeCodeOverride {
    /// `model`, `env` or `apiKeyHelper`.
    pub kind: String,
    /// The setting's name: `model`, `apiKeyHelper`, or the env variable.
    pub key: String,
    /// The value, for a model name only; credentials are never returned.
    pub value: Option<String>,
    /// The file the setting is in.
    pub file: String,
}

/// Variables in Claude Code's `env` settings block that decide which server and
/// model a session talks to.
fn is_routing_env_key(key: &str) -> bool {
    key.starts_with("ANTHROPIC_") || key.starts_with("CLAUDE_CODE_USE_")
}

/// What `settings.json` in Claude Code's config directory sets that wins over
/// the environment variables Flint exports: a pinned `model` (what `/model`
/// writes, so the old model keeps coming back), an `env` block with the routing
/// variables, and an `apiKeyHelper`. Read-only; a missing or unreadable file
/// reports nothing.
fn claude_code_overrides_in(config_dir: &Path) -> Vec<ClaudeCodeOverride> {
    let path = config_dir.join("settings.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let file = path.to_string_lossy().into_owned();
    let mut found = Vec::new();
    if let Some(model) = json
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|m| !m.is_empty())
    {
        found.push(ClaudeCodeOverride {
            kind: "model".into(),
            key: "model".into(),
            value: Some(model.to_string()),
            file: file.clone(),
        });
    }
    if json
        .get("apiKeyHelper")
        .and_then(|v| v.as_str())
        .is_some_and(|h| !h.is_empty())
    {
        found.push(ClaudeCodeOverride {
            kind: "apiKeyHelper".into(),
            key: "apiKeyHelper".into(),
            value: None,
            file: file.clone(),
        });
    }
    if let Some(env) = json.get("env").and_then(|v| v.as_object()) {
        for key in env.keys().filter(|k| is_routing_env_key(k)) {
            found.push(ClaudeCodeOverride {
                kind: "env".into(),
                key: key.clone(),
                value: None,
                file: file.clone(),
            });
        }
    }
    found
}

/// Claude Code's config directory: `CLAUDE_CONFIG_DIR`, else `~/.claude`.
fn claude_code_config_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".claude")))
}

/// Settings in the user's Claude Code config that override what Save & Enable
/// exports. The settings page explains each one; nothing is changed here.
#[tauri::command(async)]
pub fn detect_claude_code_overrides() -> Vec<ClaudeCodeOverride> {
    claude_code_config_dir()
        .map(|dir| claude_code_overrides_in(&dir))
        .unwrap_or_default()
}

#[derive(serde::Serialize)]
pub struct CliInstallStatus {
    pub installed: bool,
    pub path: Option<String>,
}

fn cli_binary_name() -> &'static str {
    if cfg!(windows) { "flint.exe" } else { "flint" }
}

/// Check if the `flint` CLI binary is accessible on PATH, or — failing that —
/// at one of the known install destinations.
///
/// `which`/`where` only sees what the Tauri process's PATH sees. Linux GUI
/// launches typically inherit a minimal PATH (no `~/.local/bin`), and on
/// Windows the registry PATH update from `add_to_path_windows` doesn't apply
/// to the already-running process. Without the fallback probe, a successful
/// install reports `installed: false` after the next remount of Settings.
#[tauri::command]
pub async fn check_jan_cli_installed() -> CliInstallStatus {
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    let mut cmd = std::process::Command::new(which_cmd);
    cmd.arg(cli_binary_name());

    {
        use jan_process::CommandConsole;
        cmd.background();
    }

    let path_from_which = match tokio::task::spawn_blocking(move || cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => {
            let raw = String::from_utf8_lossy(&out.stdout);
            #[cfg(windows)]
            let path = {
                raw.lines()
                    .map(str::trim).find(|p| !p.is_empty() && !p.to_ascii_lowercase().contains("\\target\\"))
                    .map(str::to_string)
                    .or_else(|| {
                        raw.lines()
                            .map(str::trim)
                            .find(|p| !p.is_empty())
                            .map(str::to_string)
                    })
            };
            #[cfg(not(windows))]
            let path = {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            };
            path
        }
        _ => None,
    };

    if let Some(p) = path_from_which {
        return CliInstallStatus {
            installed: true,
            path: Some(p),
        };
    }

    // Fall back to probing the destinations `install_jan_cli_sync` writes to.
    for candidate in jan_cli_install_candidates() {
        if candidate.exists() {
            return CliInstallStatus {
                installed: true,
                path: Some(candidate.to_string_lossy().into_owned()),
            };
        }
    }

    CliInstallStatus {
        installed: false,
        path: None,
    }
}

/// Paths where `install_jan_cli_sync` may have placed the `flint` binary.
fn jan_cli_install_candidates() -> Vec<PathBuf> {
    let bin = cli_binary_name();
    let mut out: Vec<PathBuf> = Vec::new();

    #[cfg(unix)]
    {
        out.push(PathBuf::from("/usr/local/bin").join(bin));
        if let Ok(home) = std::env::var("HOME") {
            out.push(PathBuf::from(home).join(".local").join("bin").join(bin));
        }
    }
    #[cfg(windows)]
    {
        if let Ok(dir) = jan_cli_bin_dir_windows() {
            out.push(dir.join(bin));
        }
    }
    out
}

/// The bundled CLI binary, and the path this app installs it to.
///
/// On Windows the CLI is not copied anywhere: its bundled location is put on
/// PATH, so the target is the bundled file itself.
pub fn cli_install_target<R: Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<(PathBuf, PathBuf), String> {
    let bin_name = cli_binary_name();
    // `resource_dir()` hands back a verbatim `\\?\C:\...` path on Windows. That
    // is fine to open a file with and wrong to persist: written into the user's
    // PATH it produced an entry most shells and tools will not resolve, and it
    // is not a spelling anyone recognises when they look at their own PATH.
    let resource_bin_dir = crate::core::app::commands::strip_verbatim_prefix(
        app_handle
            .path()
            .resource_dir()
            .map_err(|e| e.to_string())?,
    )
    .join("resources/bin");
    let bundled = resource_bin_dir.join(bin_name);
    #[cfg(windows)]
    let target = bundled.clone();
    #[cfg(unix)]
    let target = jan_cli_install_dir()?.join(bin_name);
    Ok((bundled, target))
}

/// Core install logic — synchronous, no Tauri command overhead.
///
/// Replaces whatever is at the target. That is right for the settings button,
/// where the user asked for it, and wrong for the automatic on-launch install,
/// which goes through `cli_provenance::decide_auto` first (janhq/jan#8812).
pub fn install_jan_cli_sync<R: Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<CliInstallStatus, String> {
    let (bundled, _target) = cli_install_target(app_handle)?;
    #[cfg(windows)]
    let resource_bin_dir = bundled
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "bundled CLI has no parent directory".to_string())?;

    if !bundled.exists() {
        return Err("Flint CLI binary not bundled with this version of Flint.".to_string());
    }

    #[cfg(windows)]
    {
        add_to_path_windows(&resource_bin_dir)?;
        Ok(CliInstallStatus {
            installed: true,
            path: Some(bundled.to_string_lossy().into_owned()),
        })
    }

    #[cfg(unix)]
    {
        let install_dir = jan_cli_install_dir()?;
        std::fs::create_dir_all(&install_dir).map_err(|e| e.to_string())?;
        let dest = install_dir.join(cli_binary_name());

        std::fs::copy(&bundled, &dest)
            .map_err(|e| format!("Failed to copy flint to {}: {}", dest.display(), e))?;

        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
        // So a later automatic install can tell this copy from a standalone
        // one at the same path, and leave the standalone one alone.
        if let Err(e) = super::cli_provenance::record_ours(&dest) {
            log::warn!("could not record CLI provenance at {}: {e}", dest.display());
        }

        Ok(CliInstallStatus {
            installed: true,
            path: Some(dest.to_string_lossy().into_owned()),
        })
    }
}

/// Copy the bundled `flint` binary to the system PATH (Tauri command wrapper).
#[tauri::command]
pub async fn install_jan_cli<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<CliInstallStatus, String> {
    install_jan_cli_sync(&app_handle)
}

/// Remove the installed `flint` CLI binary.
#[tauri::command(async)]
pub fn uninstall_jan_cli() -> Result<(), String> {
    #[cfg(windows)]
    {
        let bin_dir = jan_cli_bin_dir_windows()?;
        remove_from_path_windows(&bin_dir)?;
        Ok(())
    }

    #[cfg(unix)]
    {
        let dest = jan_cli_install_dir()?.join(cli_binary_name());
        if dest.exists() {
            std::fs::remove_file(&dest)
                .map_err(|e| format!("Failed to remove Flint CLI from {}: {}", dest.display(), e))?;
        }
        super::cli_provenance::forget(&dest);
        Ok(())
    }
}

/// Build the cleaned shell-file content with all Flint CC env vars stripped out.
fn build_cleaned_env_content(env_file_path: &str) -> String {
    let existing_content = std::fs::read_to_string(env_file_path).unwrap_or_default();
    // Trailing blank lines left behind by the removed block are trimmed too.
    strip_jan_env_block(&existing_content) + "\n"
}

/// Clear all Flint-written Claude Code environment variables from the shell config.
/// Uses the same write-probe logic as `launch_claude_code_with_config`; when the
/// file is not writable it returns `NEED_PERMISSION:<path>` and never escalates.
#[tauri::command(async)]
pub fn clear_claude_code_env() -> Result<(), String> {
    if cfg!(target_os = "macos") {
        let home_dir = std::env::var("HOME").map_err(|e| e.to_string())?;
        let (shell_name, env_file_path) = detect_shell_env_file(&home_dir, true);
        log::info!(
            "Clearing CC env from shell: {}, file: {}",
            shell_name,
            env_file_path
        );

        let cleaned = build_cleaned_env_content(&env_file_path);

        match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&env_file_path)
        {
            Ok(_) => {
                atomic_write_preserving(&env_file_path, &cleaned)?;
                Ok(())
            }
            Err(_) => Err(format!("NEED_PERMISSION:{}", env_file_path)),
        }
    } else if cfg!(target_os = "linux") {
        let home_dir = std::env::var("HOME").map_err(|e| e.to_string())?;
        let (shell_name, env_file_path) = detect_shell_env_file(&home_dir, false);
        log::info!(
            "Clearing CC env from shell: {}, file: {}",
            shell_name,
            env_file_path
        );

        let cleaned = build_cleaned_env_content(&env_file_path);

        match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&env_file_path)
        {
            Ok(_) => {
                std::fs::write(&env_file_path, &cleaned).map_err(|e| e.to_string())?;
                Ok(())
            }
            Err(_) => Err(format!("NEED_PERMISSION:{}", env_file_path)),
        }
    } else {
        // Windows: delete the persistent user env vars from the registry
        let keys_path = claude_code_env_keys_path();
        let keys = claude_code_env_keys_to_clear(load_claude_code_env_keys(&keys_path));
        for key in &keys {
            // No console window per deletion (Jozkah/jan#253), like `setx` above.
            use jan_process::CommandConsole;
            let _ = std::process::Command::new("reg")
                .args(["delete", "HKCU\\Environment", "/v", key, "/f"])
                .background()
                .output();
        }
        let _ = std::fs::remove_file(&keys_path);
        log::info!("CC env vars removed from Windows registry.");
        Ok(())
    }
}

/// Determine the best writable directory for the Flint CLI install (Unix only).
#[cfg(unix)]
fn jan_cli_install_dir() -> Result<PathBuf, String> {
    let usr_local_bin = PathBuf::from("/usr/local/bin");
    if usr_local_bin.exists() {
        let probe = usr_local_bin.join(".jan_write_probe");
        if std::fs::write(&probe, b"").is_ok() {
            let _ = std::fs::remove_file(&probe);
            return Ok(usr_local_bin);
        }
    }
    let home = std::env::var("HOME").map_err(|_| "Cannot determine home directory".to_string())?;
    Ok(PathBuf::from(home).join(".local").join("bin"))
}

/// Return the directory containing the bundled CLI binary on Windows: the
/// same `resources/bin` beside the app that `cli_install_target` puts on
/// PATH. A hardcoded `Programs\Jan` never matched the `Programs\Flint` install,
/// so uninstall removed nothing and detection never found the CLI.
#[cfg(windows)]
fn jan_cli_bin_dir_windows() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("Cannot locate the app: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "the app has no parent directory".to_string())?;
    Ok(crate::core::app::commands::strip_verbatim_prefix(dir.to_path_buf()).join("resources/bin"))
}

/// The user PATH with `install_dir` put first, or `None` when it is already on
/// it. A stale entry for the old desktop layout (`old_jan_dir`) is dropped
/// unless `holds_cli` says it still holds somebody's CLI install
/// (janhq/jan#8812).
#[cfg_attr(not(windows), allow(dead_code))]
fn path_with_dir_added(
    existing: &str,
    install_dir: &str,
    old_jan_dir: Option<&str>,
    holds_cli: impl Fn(&str) -> bool,
) -> Option<String> {
    let parts: Vec<&str> = existing
        .split(';')
        .filter(|p| !p.is_empty())
        .filter(|p| match old_jan_dir {
            Some(old) => !p.eq_ignore_ascii_case(old) || holds_cli(p),
            None => true,
        })
        .collect();
    if parts.iter().any(|p| p.eq_ignore_ascii_case(install_dir)) {
        return None;
    }
    let mut new_parts = vec![install_dir];
    new_parts.extend(parts);
    Some(new_parts.join(";"))
}

/// The user PATH without `dir`.
#[cfg_attr(not(windows), allow(dead_code))]
fn path_without_dir(existing: &str, dir: &str) -> String {
    existing
        .split(';')
        .filter(|p| !p.is_empty() && !p.eq_ignore_ascii_case(dir))
        .collect::<Vec<_>>()
        .join(";")
}

/// PowerShell that prints the user PATH exactly as stored: `%VAR%` entries
/// stay unexpanded. `[Environment]::GetEnvironmentVariable` expands them, and
/// writing that back would flatten every `%VAR%` entry in the user's PATH.
#[cfg_attr(not(windows), allow(dead_code))]
const READ_USER_PATH_RAW_SCRIPT: &str = "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); \
if ($k) { $k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }";

/// PowerShell that stores `path` as the user PATH, keeping the value's existing
/// registry type (REG_EXPAND_SZ when none exists yet), then broadcasts the
/// environment change the way `SetEnvironmentVariable` does.
/// `[Environment]::SetEnvironmentVariable` would rewrite it as REG_SZ.
#[cfg_attr(not(windows), allow(dead_code))]
fn write_user_path_raw_script(path: &str) -> String {
    format!(
        "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); \
$kind = [Microsoft.Win32.RegistryValueKind]::ExpandString; \
try {{ $kind = $k.GetValueKind('Path') }} catch {{}}; \
$k.SetValue('Path', '{}', $kind); \
[Environment]::SetEnvironmentVariable('FLINT_ENV_REFRESH', '1', 'User'); \
[Environment]::SetEnvironmentVariable('FLINT_ENV_REFRESH', $null, 'User')",
        ps_single_quote_escape(path)
    )
}

/// The body of a PowerShell single-quoted string. PowerShell treats the
/// typographic quotes U+2018 to U+201B as single quotes too, so a folder name
/// holding one would end the string early; each quote character is doubled.
fn ps_single_quote_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        out.push(c);
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
    }
    out
}

/// Add a directory to the Windows user PATH.
#[cfg(windows)]
fn add_to_path_windows(install_dir: &Path) -> Result<(), String> {
    use std::process::Command;

    let install_dir_str = install_dir.to_string_lossy().to_string();

    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-Command",
        READ_USER_PATH_RAW_SCRIPT,
    ]);
    {
        use jan_process::CommandConsole;
        cmd.background();
    }
    let read_output = cmd
        .output()
        .map_err(|e| format!("Failed to read user PATH: {}", e))?;

    // A failed or interrupted read must never be mistaken for an empty PATH:
    // writing back from it would replace the whole user PATH.
    if !read_output.status.success() {
        return Err(format!(
            "Failed to read user PATH: {}",
            String::from_utf8_lossy(&read_output.stderr).trim()
        ));
    }
    let existing_user_path = String::from_utf8_lossy(&read_output.stdout)
        .trim()
        .to_string();

    // Remove stale old-style PATH entry (..\\Programs\\Flint without \\resources\\bin)
    // left by previous versions that placed jan.exe next to the GUI binary.
    let old_jan_dir = install_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_string_lossy().to_string());

    let Some(new_path) = path_with_dir_added(&existing_user_path, &install_dir_str, old_jan_dir.as_deref(), |entry| {
        super::cli_provenance::path_entry_holds_cli(std::path::Path::new(entry))
    }) else {
        return Ok(());
    };

    let mut cmd_write = Command::new("powershell");
    cmd_write.args([
        "-NoProfile",
        "-Command",
        &write_user_path_raw_script(&new_path),
    ]);

    {
        use jan_process::CommandConsole;
        cmd_write.background();
    }

    let write_output = cmd_write
        .output()
        .map_err(|e| format!("Failed to update user PATH: {}", e))?;

    if !write_output.status.success() {
        return Err(format!(
            "Failed to update PATH: {}",
            String::from_utf8_lossy(&write_output.stderr)
        ));
    }

    log::info!("Added {} to Windows user PATH", install_dir_str);
    Ok(())
}

/// Remove a directory from the Windows user PATH.
#[cfg(windows)]
fn remove_from_path_windows(dir: &Path) -> Result<(), String> {
    use std::process::Command;

    let dir_str = dir.to_string_lossy().to_string();

    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-Command",
        READ_USER_PATH_RAW_SCRIPT,
    ]);
    {
        use jan_process::CommandConsole;
        cmd.background();
    }
    let read_output = cmd
        .output()
        .map_err(|e| format!("Failed to read user PATH: {}", e))?;

    if !read_output.status.success() {
        return Err(format!(
            "Failed to read user PATH: {}",
            String::from_utf8_lossy(&read_output.stderr).trim()
        ));
    }
    let existing_user_path = String::from_utf8_lossy(&read_output.stdout)
        .trim()
        .to_string();
    // Nothing read means nothing to remove; never write from an empty read.
    if existing_user_path.is_empty() {
        return Ok(());
    }

    let new_path = path_without_dir(&existing_user_path, &dir_str);

    if new_path.len() != existing_user_path.len() {
        let mut cmd_write = Command::new("powershell");
        cmd_write.args([
            "-NoProfile",
            "-Command",
            &write_user_path_raw_script(&new_path),
        ]);

        {
            use jan_process::CommandConsole;
            cmd_write.background();
        }

        let write_output = cmd_write
            .output()
            .map_err(|e| format!("Failed to update user PATH: {}", e))?;

        if !write_output.status.success() {
            return Err(format!(
                "Failed to update PATH: {}",
                String::from_utf8_lossy(&write_output.stderr)
            ));
        }

        log::info!("Removed {} from Windows user PATH", dir_str);
    }
    Ok(())
}

#[cfg(test)]
mod user_path_tests {
    use super::*;

    #[test]
    fn the_install_dir_goes_first_and_only_once() {
        let added = path_with_dir_added("C:/a;C:/b", "C:/jan", None, |_| false).unwrap();
        assert_eq!(added, "C:/jan;C:/a;C:/b");
        assert!(path_with_dir_added("C:/a;c:/JAN", "C:/jan", None, |_| false).is_none());
        assert_eq!(path_with_dir_added("", "C:/jan", None, |_| false).as_deref(), Some("C:/jan"));
    }

    #[test]
    fn the_stale_layout_entry_goes_unless_it_holds_a_cli() {
        let stale = path_with_dir_added("C:/old;C:/a", "C:/jan", Some("C:/OLD"), |_| false).unwrap();
        assert_eq!(stale, "C:/jan;C:/a");
        let kept = path_with_dir_added("C:/old;C:/a", "C:/jan", Some("C:/old"), |_| true).unwrap();
        assert_eq!(kept, "C:/jan;C:/old;C:/a");
    }

    #[test]
    fn user_path_scripts_keep_unexpanded_entries_and_the_registry_type() {
        assert!(READ_USER_PATH_RAW_SCRIPT.contains("DoNotExpandEnvironmentNames"));
        assert!(!READ_USER_PATH_RAW_SCRIPT.contains("GetEnvironmentVariable('Path'"));
        let write = write_user_path_raw_script("%USERPROFILE%\\bin;C:\\it's");
        assert!(write.contains("SetValue('Path', '%USERPROFILE%\\bin;C:\\it''s', $kind)"));
        assert_eq!(ps_single_quote_escape("a\u{2019}b'c"), "a\u{2019}\u{2019}b''c");
        assert!(write.contains("ExpandString"));
        assert!(write.contains("GetValueKind('Path')"));
        assert!(!write.contains("SetEnvironmentVariable('Path'"));
    }

    #[test]
    fn percent_entries_survive_adding_and_removing() {
        let existing = "%USERPROFILE%\\bin;C:/a";
        let added = path_with_dir_added(existing, "C:/jan", None, |_| false).unwrap();
        assert_eq!(added, "C:/jan;%USERPROFILE%\\bin;C:/a");
        assert_eq!(path_without_dir(&added, "C:/jan"), existing);
    }

    #[test]
    fn removing_a_dir_keeps_the_rest_in_order() {
        assert_eq!(path_without_dir("C:/a;;C:/JAN;C:/b", "c:/jan"), "C:/a;C:/b");
        assert_eq!(path_without_dir("C:/a", "C:/jan"), "C:/a");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn export_redacted_logs_has_no_path_parameter() {
        let src = include_str!("commands.rs");
        let at = src.find("pub async fn export_redacted_logs").unwrap();
        let sig = &src[at..at + src[at..].find('{').unwrap()];
        assert!(!sig.contains("destination") && !sig.contains("path"), "{sig}");
        let at = src.find("pub async fn export_diagnostic_bundle").unwrap();
        let sig = &src[at..at + src[at..].find('{').unwrap()];
        assert!(!sig.contains("destination") && !sig.contains("path"), "{sig}");
    }

    /// The desktop bundle holds the CLI bundle's caps and strips secrets from
    /// the log, and its archive round-trips to exactly those members.
    #[test]
    fn diagnostic_bundle_is_capped_redacted_and_archived() {
        use crate::core::diagnostics_bundle::{write_archive, MEMBER_CAP};
        use std::io::Read;
        let key = concat!("sk-", "abcdefghijklmnopqrstu");
        let mut log = format!("INFO upstream said {key}\n");
        while log.len() <= 2 * MEMBER_CAP {
            log.push_str("INFO a long and boring line of log text\n");
        }
        let members = super::diagnostic_members(&log);
        let names: Vec<&str> = members.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["version.txt", "environment.txt", "logs/app.log"]);
        let app_log = &members[2].1;
        assert!(app_log.starts_with("[truncated: kept the last"), "log not capped");
        assert!(app_log.len() <= MEMBER_CAP + 80, "{}", app_log.len());
        let small = super::diagnostic_members(&format!("INFO upstream said {key}\n"));
        assert!(!small[2].1.contains(key), "secret survived: {}", small[2].1);

        let archive = write_archive(Vec::new(), &small).unwrap();
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive.as_slice()));
        let unpacked: Vec<(String, String)> = tar
            .entries()
            .unwrap()
            .map(|e| {
                let mut e = e.unwrap();
                let mut body = String::new();
                e.read_to_string(&mut body).unwrap();
                (e.path().unwrap().display().to_string(), body)
            })
            .collect();
        assert_eq!(unpacked, small);
    }

    #[test]
    fn tail_reader_reads_last_n_lines_without_loading_file() {
        let dir = std::env::temp_dir().join(format!("flint-tail-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("app.log");
        let body: String = (0..10_000).map(|i| format!("line {i}
")).collect();
        fs::write(&p, &body).unwrap();
        // 4 KiB window: far smaller than the file, still whole lines only.
        let tail = read_log_tail(&p, 4096, 5).unwrap();
        let got: Vec<&str> = tail.lines().collect();
        assert_eq!(got.len(), 5);
        assert_eq!(got[4], "line 9999");
        assert_eq!(got[0], "line 9995");
        let _ = fs::remove_dir_all(&dir);
    }

    use super::*;
    use crate::core::app::constants::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn rewriting_the_env_block_drops_custom_vars_instead_of_duplicating_them() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".zshenv");
        fs::write(&path, "export PATH=/usr/bin\n").unwrap();
        let vars = vec![
            ("ANTHROPIC_BASE_URL".to_string(), "http://x".to_string()),
            ("HTTPS_PROXY".to_string(), "http://u:p@proxy".to_string()),
        ];
        write_env_to_shell(path.to_str().unwrap(), &vars).unwrap();
        write_env_to_shell(path.to_str().unwrap(), &vars).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert_eq!(written.matches("export HTTPS_PROXY=").count(), 1, "{written}");
        assert_eq!(written.matches(JAN_ENV_MARKER).count(), 2, "{written}");
        assert!(written.starts_with("export PATH=/usr/bin\n"));

        let cleaned = build_cleaned_env_content(path.to_str().unwrap());
        assert_eq!(cleaned, "export PATH=/usr/bin\n");
    }

    #[test]
    fn user_anthropic_export_outside_block_survives_save() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".zshenv");
        fs::write(&path, "export ANTHROPIC_API_KEY=mine\nexport PATH=/usr/bin\n").unwrap();
        let vars = vec![("ANTHROPIC_BASE_URL".to_string(), "http://x".to_string())];
        write_env_to_shell(path.to_str().unwrap(), &vars).unwrap();
        write_env_to_shell(path.to_str().unwrap(), &vars).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("export ANTHROPIC_API_KEY=mine\n"), "{written}");
        assert_eq!(written.matches("export ANTHROPIC_BASE_URL=").count(), 1, "{written}");
    }

    #[test]
    fn user_anthropic_export_survives_reset() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".zshenv");
        let vars = vec![("ANTHROPIC_BASE_URL".to_string(), "http://x".to_string())];
        fs::write(&path, "export ANTHROPIC_API_KEY=mine\n").unwrap();
        write_env_to_shell(path.to_str().unwrap(), &vars).unwrap();
        let cleaned = build_cleaned_env_content(path.to_str().unwrap());
        assert_eq!(cleaned, "export ANTHROPIC_API_KEY=mine\n");
    }

    #[test]
    fn legacy_header_block_still_cleaned() {
        let content = "a\n# Jan Local API Server\nexport ANTHROPIC_BASE_URL='x'\nexport ANTHROPIC_AUTH_TOKEN='y'\nexport ANTHROPIC_API_KEY=mine\nb\n";
        assert_eq!(
            strip_jan_env_block(content),
            "a\nexport ANTHROPIC_API_KEY=mine\nb"
        );
    }

    #[test]
    fn unclosed_block_still_runs_to_eof() {
        let content = format!("a\n{JAN_ENV_MARKER}\nexport FOO='bar'\nexport BAZ='1'\n");
        assert_eq!(strip_jan_env_block(&content), "a");
    }

    #[test]
    fn macos_clear_has_no_privileged_path() {
        // A Windows checkout may carry CRLF; the scan below looks for "\n}\n".
        let src = include_str!("commands.rs").replace("\r\n", "\n");
        let at = src.find("pub fn clear_claude_code_env").unwrap();
        let body = &src[at..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(!body.contains("osascript") && !body.contains("administrator"));
    }

    #[test]
    fn strip_keeps_lines_after_the_block() {
        let content = format!(
            "a\n{JAN_ENV_MARKER}\nexport FOO='bar'\n{JAN_ENV_MARKER}\nb\n"
        );
        assert_eq!(strip_jan_env_block(&content), "a\nb");
    }

    #[test]
    fn the_fable_tier_is_set_only_when_chosen() {
        let with = build_claude_code_env_vars(
            "http://127.0.0.1:1337".to_string(),
            Some("k".to_string()),
            None,
            None,
            None,
            Some("my-fable".to_string()),
            vec![],
        )
        .unwrap();
        assert!(with.contains(&("ANTHROPIC_DEFAULT_FABLE_MODEL".to_string(), "my-fable".to_string())));
        let without = build_claude_code_env_vars(
            "http://127.0.0.1:1337".to_string(),
            Some("k".to_string()),
            None,
            None,
            None,
            None,
            vec![],
        )
        .unwrap();
        assert!(!without.iter().any(|(k, _)| k == "ANTHROPIC_DEFAULT_FABLE_MODEL"));
    }

    /// janhq/jan issue 8107: with only one tier chosen, the other aliases kept
    /// their real Claude names, so Claude Code's default (Sonnet) model went to
    /// the local server as `claude-sonnet-*` and failed as a login error.
    #[test]
    fn unset_tiers_follow_a_chosen_model_so_no_alias_keeps_a_claude_name() {
        let get = |vars: &Vec<(String, String)>, k: &str| {
            vars.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone())
        };
        let only_big = build_claude_code_env_vars(
            "http://127.0.0.1:1337".to_string(),
            Some("k".to_string()),
            Some("qwen".to_string()),
            None,
            None,
            None,
            vec![],
        )
        .unwrap();
        for key in [
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
        ] {
            assert_eq!(get(&only_big, key).as_deref(), Some("qwen"), "{key}");
        }

        // A chosen tier is never replaced; the medium model is the default one.
        let mixed = build_claude_code_env_vars(
            "http://127.0.0.1:1337".to_string(),
            Some("k".to_string()),
            None,
            Some("medium-m".to_string()),
            Some("small-m".to_string()),
            None,
            vec![],
        )
        .unwrap();
        assert_eq!(get(&mixed, "ANTHROPIC_DEFAULT_OPUS_MODEL").as_deref(), Some("medium-m"));
        assert_eq!(get(&mixed, "ANTHROPIC_DEFAULT_SONNET_MODEL").as_deref(), Some("medium-m"));
        assert_eq!(get(&mixed, "ANTHROPIC_DEFAULT_HAIKU_MODEL").as_deref(), Some("small-m"));
        assert_eq!(get(&mixed, "ANTHROPIC_DEFAULT_FABLE_MODEL").as_deref(), Some("medium-m"));
    }

    #[test]
    fn claude_code_settings_that_override_the_environment_are_reported() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{"model":"claude-sonnet-4-5","apiKeyHelper":"~/k.sh",
                "env":{"ANTHROPIC_BASE_URL":"https://x","ANTHROPIC_AUTH_TOKEN":"secret","FOO":"1"}}"#,
        )
        .unwrap();
        let found = claude_code_overrides_in(dir.path());
        let kinds: Vec<(&str, &str)> = found
            .iter()
            .map(|f| (f.kind.as_str(), f.key.as_str()))
            .collect();
        assert!(kinds.contains(&("model", "model")), "{kinds:?}");
        assert!(kinds.contains(&("apiKeyHelper", "apiKeyHelper")), "{kinds:?}");
        assert!(kinds.contains(&("env", "ANTHROPIC_BASE_URL")), "{kinds:?}");
        assert!(kinds.contains(&("env", "ANTHROPIC_AUTH_TOKEN")), "{kinds:?}");
        assert!(!kinds.iter().any(|(_, k)| *k == "FOO"));
        // A credential's value is never handed to the UI.
        let token = found.iter().find(|f| f.key == "ANTHROPIC_AUTH_TOKEN").unwrap();
        assert!(token.value.is_none());
        let model = found.iter().find(|f| f.kind == "model").unwrap();
        assert_eq!(model.value.as_deref(), Some("claude-sonnet-4-5"));
        assert!(found[0].file.ends_with("settings.json"));
    }

    #[test]
    fn a_missing_or_clean_claude_code_settings_file_reports_nothing() {
        let dir = tempdir().unwrap();
        assert!(claude_code_overrides_in(dir.path()).is_empty());
        fs::write(dir.path().join("settings.json"), r#"{"theme":"dark"}"#).unwrap();
        assert!(claude_code_overrides_in(dir.path()).is_empty());
        fs::write(dir.path().join("settings.json"), "not json").unwrap();
        assert!(claude_code_overrides_in(dir.path()).is_empty());
    }

    #[test]
    fn windows_reset_clears_recorded_custom_keys() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.json");
        record_claude_code_env_keys(&path, &["HTTPS_PROXY".to_string()]).unwrap();
        record_claude_code_env_keys(
            &path,
            &["ANTHROPIC_BASE_URL".to_string(), "MY_TOKEN".to_string()],
        )
        .unwrap();
        let keys = claude_code_env_keys_to_clear(load_claude_code_env_keys(&path));
        assert!(keys.contains(&"HTTPS_PROXY".to_string()));
        assert!(keys.contains(&"MY_TOKEN".to_string()));
        assert!(keys.contains(&"ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string()));
        assert!(keys.contains(&"ANTHROPIC_DEFAULT_FABLE_MODEL".to_string()));
        assert_eq!(keys.iter().filter(|k| *k == "ANTHROPIC_BASE_URL").count(), 1);
    }

    /// #122: re-applying without a custom variable deletes it and stops
    /// recording it, while the still-set names stay recorded.
    #[test]
    fn windows_reapply_forgets_removed_custom_keys() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.json");
        record_claude_code_env_keys(
            &path,
            &["ANTHROPIC_BASE_URL".to_string(), "HTTPS_PROXY".to_string()],
        )
        .unwrap();
        let current = vec!["ANTHROPIC_BASE_URL".to_string()];
        let stale = stale_claude_code_env_keys(&load_claude_code_env_keys(&path), &current);
        assert_eq!(stale, vec!["HTTPS_PROXY".to_string()]);
        forget_claude_code_env_keys(&path, &stale).unwrap();
        record_claude_code_env_keys(&path, &current).unwrap();
        assert_eq!(load_claude_code_env_keys(&path), current);
    }

    #[test]
    fn shell_env_values_are_quoted_so_quotes_cannot_break_out() {
        assert_eq!(sh_single_quote("O'Reilly"), "'O'\\''Reilly'");
        let dir = tempdir().unwrap();
        let file = dir.path().join(".zshenv");
        let file_s = file.to_str().unwrap();
        let vars = vec![
            ("MY_VAR".to_string(), "O'Reilly".to_string()),
            ("X".to_string(), "a'; touch /tmp/pwned; echo '".to_string()),
        ];
        write_env_to_shell(file_s, &vars).unwrap();
        let written = fs::read_to_string(&file).unwrap();
        assert!(written.contains("export MY_VAR='O'\\''Reilly'\n"), "{written}");
        assert!(written.contains("export X='a'\\''; touch /tmp/pwned; echo '\\'''\n"), "{written}");

        #[cfg(unix)]
        {
            let marker = dir.path().join("pwned");
            let evil = vec![(
                "X".to_string(),
                format!("a'; touch {}; echo '", marker.display()),
            ), ("MY_VAR".to_string(), "O'Reilly".to_string())];
            write_env_to_shell(file_s, &evil).unwrap();
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(format!(". '{}'; printf %s \"$MY_VAR\"", file_s))
                .output()
                .unwrap();
            assert!(out.status.success());
            assert_eq!(String::from_utf8_lossy(&out.stdout), "O'Reilly");
            assert!(!marker.exists(), "an env value ran a shell command");
        }
    }

    #[test]
    fn a_resave_replaces_custom_variables_and_keeps_user_lines() {
        let dir = tempdir().unwrap();
        let file = dir.path().join(".bashrc");
        fs::write(&file, "alias ll='ls -l'\n").unwrap();
        let file_s = file.to_str().unwrap();
        write_env_to_shell(file_s, &[("OLD_CUSTOM".to_string(), "1".to_string())]).unwrap();
        write_env_to_shell(file_s, &[("NEW_CUSTOM".to_string(), "2".to_string())]).unwrap();
        let written = fs::read_to_string(&file).unwrap();
        assert!(!written.contains("OLD_CUSTOM"), "{written}");
        assert!(written.contains("export NEW_CUSTOM='2'"), "{written}");
        assert!(written.contains("alias ll='ls -l'"), "{written}");
        assert_eq!(written.matches("# Jan Local API Server").count(), 2, "{written}");
    }

    #[test]
    fn an_invalid_custom_env_key_is_rejected() {
        let result = build_claude_code_env_vars(
            "http://127.0.0.1:1337".to_string(),
            Some("k".to_string()),
            None,
            None,
            None,
            None,
            vec![serde_json::json!({"key": "FOO; id", "value": "x"})],
        );
        assert!(result.unwrap_err().contains("FOO; id"));
        assert!(is_blocked_env_key("LD_PRELOAD"));
        assert!(is_blocked_env_key("dyld_insert_libraries"));
        assert!(is_blocked_env_key("PATH"));
        assert!(!is_blocked_env_key("CLAUDE_CODE_MAX_OUTPUT_TOKENS"));
        assert!(is_valid_env_key("_MY_VAR1"));
        assert!(!is_valid_env_key("1ABC"));
        assert!(!is_valid_env_key(""));
    }

    #[test]
    fn bundled_cli_uses_flint_executable_name() {
        assert_eq!(cli_binary_name(), if cfg!(windows) { "flint.exe" } else { "flint" });
        assert!(jan_cli_install_candidates()
            .iter()
            .all(|path| path.file_name().and_then(|name| name.to_str()) == Some(cli_binary_name())));
    }

    fn create_all_data(dir: &std::path::Path) {
        for subdir in JAN_DATA_SUBDIRS {
            fs::create_dir_all(dir.join(subdir)).unwrap();
            fs::write(dir.join(subdir).join("dummy.txt"), "data").unwrap();
        }
        for file in JAN_DATA_FILES {
            fs::write(dir.join(file), "data").unwrap();
        }
    }

    fn exists_any(dir: &std::path::Path, names: &[&str]) -> bool {
        names.iter().any(|n| dir.join(n).exists())
    }

    fn exists_all(dir: &std::path::Path, names: &[&str]) -> bool {
        names.iter().all(|n| dir.join(n).exists())
    }

    #[test]
    fn test_delete_conversations_only_removes_conversation_dirs() {
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);

        delete_conversations(d);

        assert!(!exists_any(d, JAN_DATA_DIRS_CONVERSATIONS));
        assert!(exists_all(d, JAN_DATA_DIRS_MODELS));
        assert!(exists_all(d, JAN_DATA_DIRS_COMMON));
        assert!(d.join("settings.json").exists());
        assert!(d.join("mcp_config.json").exists());
    }

    #[test]
    fn test_delete_models_and_configs_only_removes_model_dirs_and_config_files() {
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);

        delete_models_and_configs(d);

        assert!(!exists_any(d, JAN_DATA_DIRS_MODELS));
        assert!(!exists_any(d, JAN_DATA_FILES_CONFIGS));
        assert!(exists_all(d, JAN_DATA_DIRS_CONVERSATIONS));
        assert!(exists_all(d, JAN_DATA_DIRS_COMMON));
        assert!(d.join("settings.json").exists());
    }

    #[test]
    fn test_delete_common_data_only_removes_common_dirs() {
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);

        delete_common_data(d);

        assert!(!exists_any(d, JAN_DATA_DIRS_COMMON));
        assert!(exists_all(d, JAN_DATA_DIRS_CONVERSATIONS));
        assert!(exists_all(d, JAN_DATA_DIRS_MODELS));
        assert!(d.join("settings.json").exists());
        assert!(d.join("mcp_config.json").exists());
    }

    #[test]
    fn test_delete_settings_only_removes_settings_json() {
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);

        delete_settings(d);

        assert!(!d.join("settings.json").exists());
        assert!(exists_all(d, JAN_DATA_DIRS_CONVERSATIONS));
        assert!(exists_all(d, JAN_DATA_DIRS_MODELS));
        assert!(exists_all(d, JAN_DATA_DIRS_COMMON));
        assert!(d.join("mcp_config.json").exists());
    }

    #[test]
    fn test_settings_json_survives_when_keeping_any_category() {
        // Simulate: keep_app_data=true, keep_models_and_configs=false
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);

        delete_common_data(d);
        delete_models_and_configs(d);
        // settings.json should NOT be deleted because keep_app_data=true
        assert!(d.join("settings.json").exists());

        // Simulate: keep_app_data=false, keep_models_and_configs=true
        let tmp2 = tempdir().unwrap();
        let d2 = tmp2.path();
        create_all_data(d2);

        delete_common_data(d2);
        delete_conversations(d2);
        // settings.json should NOT be deleted because keep_models_and_configs=true
        assert!(d2.join("settings.json").exists());
    }

    #[test]
    fn test_full_wipe_deletes_settings_json() {
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);

        delete_common_data(d);
        delete_conversations(d);
        delete_models_and_configs(d);
        delete_settings(d);

        assert!(!d.join("settings.json").exists());
        assert!(!exists_any(d, JAN_DATA_SUBDIRS));
        assert!(!exists_any(d, JAN_DATA_FILES));
    }

    #[test]
    fn factory_reset_removes_archive_attachments_rooms_schedules_images() {
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);
        let failures = wipe_data_folder(d, false, false);
        assert!(failures.is_empty());
        for n in [".archive", "attachments", "rooms", "schedules", "images", "videos", "vectordb"] {
            assert!(!d.join(n).exists(), "{n} survived");
        }
    }

    #[test]
    fn keep_app_data_true_keeps_archive_and_attachments() {
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);
        let failures = wipe_data_folder(d, true, false);
        assert!(failures.is_empty());
        assert!(d.join(".archive").exists());
        assert!(d.join("attachments").exists());
        assert!(d.join("threads").exists());
        assert!(!d.join("models").exists());
    }

    #[test]
    fn keep_models_keeps_models_but_wipes_conversation_extras() {
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);
        let failures = wipe_data_folder(d, false, true);
        assert!(failures.is_empty());
        assert!(exists_all(d, JAN_DATA_DIRS_MODELS));
        assert!(!d.join(".archive").exists());
        assert!(!d.join("rooms").exists());
        assert!(d.join("settings.json").exists());
    }

    #[test]
    fn full_wipe_removes_unknown_top_level_dirs() {
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);
        fs::create_dir_all(d.join("some-future-feature")).unwrap();
        fs::write(d.join("stray.bin"), "x").unwrap();
        let failures = wipe_data_folder(d, false, false);
        assert!(failures.is_empty());
        assert_eq!(fs::read_dir(d).unwrap().count(), 0);
    }

    #[test]
    fn keep_flags_never_sweep_unknown_top_level_dirs() {
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);
        fs::create_dir_all(d.join("some-future-feature")).unwrap();
        wipe_data_folder(d, true, false);
        assert!(d.join("some-future-feature").exists());
    }

    #[test]
    fn removal_failures_are_reported() {
        let tmp = tempdir().unwrap();
        let not_a_dir = tmp.path().join("f");
        fs::write(&not_a_dir, "x").unwrap();
        assert!(!delete_remaining_top_level(&not_a_dir).is_empty());
    }

    #[test]
    fn agent_session_stores_follow_keep_app_data() {
        let agent = [
            "events", "mailbox", "campaigns", "team-children", "replays", "reviews",
            "pull_requests", "consensus", "semantic", "undo", "proposals", "imports",
            "exports", "approvals", "audit", "jobs", "agent-workspace",
        ];
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);
        assert!(wipe_data_folder(d, true, false).is_empty());
        assert!(agent.iter().all(|n| d.join(n).exists()), "kept with conversations");
        assert!(wipe_data_folder(d, false, true).is_empty());
        assert!(agent.iter().all(|n| !d.join(n).exists()), "wiped without");
    }

    #[test]
    fn failure_report_round_trips_and_is_taken_once() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("cfg").join(FACTORY_RESET_REPORT);
        write_report_at(&path, &["a: denied".into(), "b: busy".into()]).unwrap();
        let got = take_report_at(&path).unwrap();
        assert_eq!(got.failures, vec!["a: denied".to_string(), "b: busy".to_string()]);
        assert!(!path.exists());
        assert!(take_report_at(&path).is_none());
    }

    #[test]
    fn empty_or_garbage_report_yields_nothing() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join(FACTORY_RESET_REPORT);
        write_report_at(&path, &[]).unwrap();
        assert!(take_report_at(&path).is_none());
        assert!(!path.exists());
        fs::write(&path, "not json").unwrap();
        assert!(take_report_at(&path).is_none());
    }

    /// The reset must not block the main thread: a sync command with
    /// `block_on` froze the window for up to 30 s and its close never landed.
    #[test]
    fn factory_reset_is_async_and_never_blocks_on() {
        // A Windows checkout may carry CRLF; the scan below looks for "\n}\n".
        let src = include_str!("commands.rs").replace("\r\n", "\n");
        let start = src
            .find("pub async fn factory_reset<")
            .expect("factory_reset must be an async command");
        let body = &src[start..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(!body.contains(concat!("block", "_on")));
        assert!(body.contains("spawn_blocking"));
    }

    #[test]
    fn delete_helpers_report_nothing_for_missing_paths() {
        let tmp = tempdir().unwrap();
        assert!(remove_dir(tmp.path(), "threads").is_empty());
        assert!(remove_file(tmp.path(), "settings.json").is_empty());
    }

    #[test]
    fn test_full_wipe_list_includes_the_secret_index() {
        assert!(JAN_DATA_FILES_SETTINGS.contains(&"provider_secrets.enc"));
        assert!(JAN_DATA_FILES_SETTINGS.contains(&"provider_secrets.index.json"));
    }

    #[test]
    fn test_delete_on_nonexistent_dirs_does_not_panic() {
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        // Nothing created — should not panic
        delete_conversations(d);
        delete_models_and_configs(d);
        delete_common_data(d);
        delete_settings(d);
    }

    #[test]
    fn corrupt_env_key_record_is_kept_aside_and_saves_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("claude-code-env-keys.json");
        std::fs::write(&path, "{not json").unwrap();
        assert!(load_claude_code_env_keys(&path).is_empty());
        assert!(dir.path().join("claude-code-env-keys.json.bak").exists());
        record_claude_code_env_keys(&path, &["A".to_string(), "B".to_string()]).unwrap();
        assert_eq!(load_claude_code_env_keys(&path), vec!["A".to_string(), "B".to_string()]);
        forget_claude_code_env_keys(&path, &["A".to_string()]).unwrap();
        assert_eq!(load_claude_code_env_keys(&path), vec!["B".to_string()]);
    }

    #[test]
    fn test_is_safe_to_delete() {
        assert!(!is_safe_to_delete(std::path::Path::new("/")));
        assert!(!is_safe_to_delete(std::path::Path::new("/home")));
        #[cfg(windows)]
        {
            assert!(!is_safe_to_delete(std::path::Path::new(r"C:\Users")));
            assert!(is_safe_to_delete(std::path::Path::new(r"C:\Users\name")));
        }
        assert!(is_safe_to_delete(std::path::Path::new("/home/user/jan")));
        assert!(is_safe_to_delete(std::path::Path::new(
            "/home/user/.local/share/jan"
        )));
    }
    #[test]
    fn claude_code_env_uses_real_token_when_set() {
        let env = build_claude_code_env_vars(
            "http://127.0.0.1:1337".to_string(),
            Some("sk-real-secret".to_string()),
            None,
            None,
            None,
            None,
            vec![],
        )
        .unwrap();
        let token = env
            .iter()
            .find(|(k, _)| k == "ANTHROPIC_AUTH_TOKEN")
            .map(|(_, v)| v.as_str())
            .unwrap();
        assert_eq!(token, "sk-real-secret");
        assert!(
            env.iter().all(|(_, v)| v != "jan"),
            "placeholder must never be shipped as a token"
        );
    }

    #[test]
    fn claude_code_env_rejects_missing_key() {
        let err = build_claude_code_env_vars(
            "http://127.0.0.1:1337".to_string(),
            None,
            None,
            None,
            None,
            None,
            vec![],
        )
        .unwrap_err();
        assert!(
            err.contains("API key"),
            "should tell the user a local API key is required: {err}"
        );
    }

    #[test]
    fn claude_code_env_rejects_blank_key() {
        let err = build_claude_code_env_vars(
            "http://127.0.0.1:1337".to_string(),
            Some("   ".to_string()),
            None,
            None,
            None,
            None,
            vec![],
        )
        .unwrap_err();
        assert!(
            err.contains("API key"),
            "a whitespace-only key is not a real credential: {err}"
        );
    }
}

#[cfg(test)]
mod redacted_export_tests {
    use super::redact_log_text;

    #[test]
    fn the_export_strips_credentials_and_keeps_the_rest() {
        let out = redact_log_text("GET failed\nAuthorization: Bearer sk-abcdef1234567890abcdef\nok");
        assert!(!out.contains("sk-abcdef1234567890abcdef"), "{out}");
        assert!(out.contains("GET failed") && out.contains("ok"));
    }
}

#[cfg(test)]
mod log_chunk_tests {
    use super::read_log_chunk;

    #[test]
    fn reads_whole_lines_and_resumes_from_the_offset() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "one\ntwo\nthr").unwrap();
        let first = read_log_chunk(&path, None, 1024).unwrap();
        assert_eq!((first.text.as_str(), first.offset, first.reset), ("one\ntwo\n", 8, true));
        std::fs::write(&path, "one\ntwo\nthree\n").unwrap();
        let next = read_log_chunk(&path, Some(first.offset), 1024).unwrap();
        assert_eq!((next.text.as_str(), next.reset), ("three\n", false));
        // Rotated: the old offset is past the end, so the tail comes back.
        std::fs::write(&path, "new\n").unwrap();
        let rotated = read_log_chunk(&path, Some(next.offset), 1024).unwrap();
        assert_eq!((rotated.text.as_str(), rotated.reset), ("new\n", true));
    }

    #[test]
    fn the_first_read_of_a_large_log_is_its_tail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "aaaa\nbbbb\ncccc\n").unwrap();
        let chunk = read_log_chunk(&path, None, 7).unwrap();
        assert_eq!(chunk.text, "cccc\n");
        assert_eq!(chunk.offset, 15);
    }
}
