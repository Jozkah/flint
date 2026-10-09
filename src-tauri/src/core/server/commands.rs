use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_llamacpp::state::LlamacppState;

use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::server::proxy;
use crate::core::state::AppState;

#[derive(serde::Deserialize)]
pub struct StartServerConfig {
    pub host: String,
    pub port: u16,
    pub prefix: String,
    pub api_key: String,
    pub trusted_hosts: Vec<String>,
    pub proxy_timeout: u64,
    pub enable_server_tool_execution: Option<bool>,
    /// The Settings "CORS" switch; on when a caller does not say, as before.
    pub cors_enabled: Option<bool>,
    /// The Settings "Verbose Server Logs" switch; off when a caller does not
    /// say (#144).
    pub verbose_logs: Option<bool>,
}

#[tauri::command]
pub async fn start_server<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, AppState>,
    config: StartServerConfig,
) -> Result<u16, String> {
    let StartServerConfig {
        host,
        port,
        prefix,
        api_key,
        trusted_hosts,
        proxy_timeout,
        enable_server_tool_execution,
        cors_enabled,
        verbose_logs,
    } = config;
    proxy::set_verbose_logs(verbose_logs.unwrap_or(false));
    let server_handle = state.server_handle.clone();
    let llama_state: State<Arc<LlamacppState>> = app_handle.state();
    let llama_state_arc = llama_state.inner().clone();

    // MLX is macOS-only; elsewhere the session map is permanently empty.
    #[cfg(target_os = "macos")]
    let mlx_sessions = {
        let mlx_state: State<tauri_plugin_mlx::state::MlxState> = app_handle.state();
        mlx_state.mlx_server_process.clone()
    };
    #[cfg(not(target_os = "macos"))]
    let mlx_sessions: Arc<
        tokio::sync::Mutex<std::collections::HashMap<i32, crate::core::server::MlxBackendSession>>,
    > = Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));

    let actual_port = proxy::start_server(
        server_handle,
        llama_state_arc,
        mlx_sessions,
        host,
        port,
        prefix,
        api_key,
        vec![trusted_hosts],
        proxy_timeout,
        state.provider_configs.clone(),
        state.model_param_defaults.clone(),
        state.mcp_servers.clone(),
        state.mcp_settings.clone(),
        get_jan_data_folder_path(app_handle.clone())
            .to_string_lossy()
            .into_owned(),
        enable_server_tool_execution.unwrap_or(false),
        cors_enabled.unwrap_or(true),
    )
    .await
    .map_err(|e| e.to_string())?;

    #[cfg(feature = "desktop")]
    crate::core::setup::show_tray(&app_handle);

    Ok(actual_port)
}

#[tauri::command]
pub async fn stop_server<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let server_handle = state.server_handle.clone();

    proxy::stop_server(server_handle)
        .await
        .map_err(|e| e.to_string())?;

    #[cfg(feature = "desktop")]
    if !CLOSE_TO_TRAY.load(Ordering::SeqCst) {
        crate::core::setup::remove_tray(&app_handle);
    }
    #[cfg(not(feature = "desktop"))]
    let _ = app_handle;

    Ok(())
}

/// Whether closing the main window while the Local API Server runs should hide
/// the app to the tray instead of quitting (Windows/Linux only).
pub static SERVER_RUN_IN_BACKGROUND: AtomicBool = AtomicBool::new(true);

#[tauri::command]
pub fn set_server_run_in_background(enabled: bool) {
    SERVER_RUN_IN_BACKGROUND.store(enabled, Ordering::SeqCst);
}

/// "Close to tray" setting: closing the main window hides it to the tray even
/// when the Local API Server is not running (Windows/Linux). Off by default.
pub static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn set_close_to_tray<R: Runtime>(app_handle: AppHandle<R>, enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::SeqCst);
    #[cfg(feature = "desktop")]
    if enabled {
        crate::core::setup::show_tray(&app_handle);
    }
    #[cfg(not(feature = "desktop"))]
    let _ = app_handle;
}

#[tauri::command]
pub async fn get_server_status(state: State<'_, AppState>) -> Result<bool, String> {
    let server_handle = state.server_handle.clone();

    Ok(proxy::is_server_running(server_handle).await)
}
