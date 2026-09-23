// The headless `jan` CLI and the desktop app are mutually exclusive builds: the
// `cli` feature gates off every Tauri-dependent module, so pairing it with the
// Tauri stack leaves the desktop entry points without their subsystems. Note
// that `--features cli` alone still implies `default` (and therefore
// `desktop`); the CLI must be built with `--no-default-features`.
#[cfg(all(feature = "cli", feature = "tauri-app"))]
compile_error!(
    "features `cli` and `tauri-app`/`desktop` are mutually exclusive; \
     build the CLI with `cargo build --no-default-features --features cli --bin jan`"
);

pub mod core;

#[cfg(not(feature = "cli"))]
use core::{
    app::commands::get_jan_data_folder_path,
    downloads::models::DownloadManagerState,
    mcp::models::McpSettings,
    setup::{self, setup_mcp},
    state::AppState,
};
#[cfg(not(feature = "cli"))]
use jan_utils::generate_app_token;
#[cfg(not(feature = "cli"))]
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
#[cfg(not(feature = "cli"))]
use tauri::{Emitter, Manager, RunEvent};
#[cfg(not(feature = "cli"))]
use tauri_plugin_store::StoreExt;
#[cfg(not(feature = "cli"))]
use tokio::sync::Mutex;

#[cfg(not(feature = "cli"))]
macro_rules! invoke_commands_with_extras {
    ($($extra:path),* $(,)?) => {
        tauri::generate_handler![
        // FS commands - Deperecate soon
        core::filesystem::commands::join_path,
        core::filesystem::commands::mkdir,
        core::filesystem::commands::exists_sync,
        core::filesystem::commands::readdir_sync,
        core::filesystem::commands::read_file_sync,
        core::filesystem::commands::rm,
        core::filesystem::commands::mv,
        core::filesystem::commands::file_stat,
        core::filesystem::commands::write_file_sync,
        core::filesystem::commands::write_yaml,
        core::filesystem::commands::read_yaml,
        core::filesystem::commands::decompress,
        core::filesystem::commands::open_dialog,
        core::filesystem::commands::save_dialog,
        // App configuration commands
        core::app::commands::get_app_configurations,
        core::app::commands::get_user_home_path,
        core::app::commands::update_app_configuration,
        core::app::commands::get_jan_data_folder_path,
        core::app::commands::get_configuration_file_path,
        core::app::commands::default_data_folder_path,
        core::app::commands::change_app_data_folder,
        core::app::commands::app_token,
        // JAN -> Flint first-launch data migration
        core::migration::commands::migration_detect,
        core::migration::commands::migration_plan,
        core::migration::commands::migration_execute,
        core::migration::commands::migration_status,
        core::migration::commands::migration_rollback,
        core::migration::commands::migration_dismiss,
        // Backend-owned settings store (webview zustand persistence)
        core::app::settings_store::settings_get,
        core::app::settings_store::settings_set,
        core::app::settings_store::settings_remove,
        core::server::provider_secrets::set_secret,
        core::server::provider_secrets::get_secret,
        // System commands
        core::system::commands::relaunch,
        core::system::commands::open_app_directory,
        core::system::commands::factory_reset,
        core::system::commands::take_pending_webdata_reset,
        core::system::commands::read_logs,
        core::system::commands::is_library_available,
        core::system::commands::launch_claude_code_with_config,
        core::system::commands::check_jan_cli_installed,
        core::system::commands::install_jan_cli,
        core::system::commands::uninstall_jan_cli,
        core::system::commands::clear_claude_code_env,
        // Server commands
        core::server::commands::start_server,
        core::server::commands::stop_server,
        core::server::commands::get_server_status,
        core::server::commands::set_server_run_in_background,
        // Agent commands
        core::agent::commands::agent_emergency_stop,
        core::agent::commands::get_compaction_policy,
        core::agent::commands::set_compaction_policy,
        // One provider transport: every OpenAI-compatible request resolves
        // and dials through here, so there is one address-selection rule.
        core::net::commands::provider_http_request,
        core::net::commands::provider_http_stream,
        core::net::commands::provider_http_cancel,
        core::net::commands::provider_endpoint_diagnostics,
        core::net::commands::provider_endpoint_refresh,
        core::net::commands::network_ca_status,
        core::net::commands::network_ca_check,
        core::agent::commands::agent_prompt_snapshots,
        core::agent::commands::agent_prompt_snapshots_delete,
        core::agent::commands::agent_worktree_export,
        core::agent::commands::agent_events_record,
        core::agent::commands::agent_events_list,
        core::agent::commands::agent_events_export,
        core::agent::commands::agent_events_export_cancel,
        core::agent::commands::agent_events_inspect,
        core::agent::commands::agent_events_runs,
        core::agent::commands::agent_events_run,
        core::agent::commands::agent_bundle_import,
        core::agent::commands::agent_bundle_import_cancel,
        core::agent::commands::agent_bundle_imports_list,
        core::agent::commands::agent_bundle_apply,
        core::agent::commands::agent_bundle_abandon,
        core::agent::commands::agent_replay_begin,
        core::agent::commands::agent_context_breakdown,
        core::agent::commands::agent_background_jobs,
        core::agent::commands::agent_job_start,
        core::agent::commands::agent_job_output,
        core::agent::commands::agent_job_cancel,
        core::agent::commands::agent_run_tree,
        core::agent::commands::agent_replay_plan,
        core::agent::commands::agent_replay_recorded,
        core::agent::commands::agent_replay_run_begin,
        core::agent::commands::agent_replay_run_settle,
        core::agent::commands::agent_replay_settle,
        core::agent::commands::agent_replays_list,
        core::agent::commands::tool_activity_record,
        core::agent::commands::tool_activity_items,
        core::agent::commands::tool_activity_diff,
        core::agent::commands::audit_export,
        core::agent::commands::payload_usage_record,
        core::agent::commands::payload_usage_lookup,
        core::agent::commands::utility_agent_record,
        core::agent::commands::session_export_save,
        core::agent::commands::session_import_open,
        core::agent::commands::session_handoff_save,
        core::agent::commands::session_folder_identity,
        core::agent::commands::utility_agent_lookup,
        core::agent::commands::project_tooling,
        core::agent::commands::agent_skill_list,
        core::agent::commands::agent_skill_read,
        core::agent::commands::agent_skill_write,
        core::agent::commands::agent_skill_delete,
        core::agent::commands::agent_skill_hub_list,
        core::agent::commands::agent_skill_hub_import,
        core::agent::commands::agent_skill_enabled_get,
        core::agent::commands::agent_skill_enabled_set,
        core::agent::cc_import::agent_cc_scan,
        core::agent::cc_import::agent_cc_import,
        core::agent::commands::agent_plugin_list,
        core::agent::commands::agent_plugin_details,
        core::agent::commands::agent_plugin_sources,
        core::agent::commands::agent_plugin_install,
        core::agent::commands::agent_plugin_install_cancel,
        core::agent::commands::agent_plugin_set_enabled,
        core::agent::commands::agent_plugin_remove,
        core::agent::commands::agent_plugin_search,
        core::agent::commands::agent_resolve_extensions,
        core::agent::commands::agent_extensions_matrix_get,
        core::agent::commands::agent_extensions_matrix_set,
        core::agent::commands::agent_extensions_matrix_set_item,
        core::agent::commands::agent_projects_list,
        core::agent::commands::agent_projects_register,
        core::agent::commands::agent_git_branch,
        core::agent::commands::agent_worktree_ensure,
        core::agent::commands::agent_worktree_state,
        core::agent::commands::agent_worktree_discard,
        core::agent::commands::agent_worktree_pending,
        core::agent::commands::agent_destructive_reason,
        core::agent::commands::agent_desktop_bridge,
        core::agent::commands::agent_worktree_list,
        core::agent::commands::agent_worktree_optimize,
        core::agent::commands::agent_proposal_from_worktree,
        core::agent::commands::agent_proposal_list,
        core::agent::commands::agent_proposal_apply,
        core::agent::commands::agent_proposal_reject,
        core::agent::commands::agent_team_child_begin,
        core::agent::commands::agent_team_child_settle,
        core::agent::commands::agent_team_children_list,
        core::agent::commands::agent_team_child_propose,
        core::agent::commands::agent_checkpoint_capture,
        core::agent::commands::agent_checkpoint_plan,
        core::agent::commands::agent_checkpoint_preview_diff,
        core::agent::commands::agent_checkpoint_restore,
        core::agent::commands::agent_checkpoint_forget,
        core::agent::commands::agent_git_status,
        core::agent::commands::agent_git_file_diff,
        core::agent::commands::agent_subagent_list,
        core::agent::commands::consolidate_memory,
        // Remote provider commands
        core::server::remote_provider_commands::register_provider_config,
        core::server::remote_provider_commands::unregister_provider_config,
        core::server::remote_provider_commands::delete_provider_keys,
        core::server::remote_provider_commands::set_model_param_defaults,
        core::server::remote_provider_commands::get_provider_config,
        core::server::remote_provider_commands::get_provider_keys,
        core::server::remote_provider_commands::list_provider_configs,
        core::server::remote_provider_commands::register_secret_values,
        // MCP commands
        core::mcp::commands::get_tools,
        core::mcp::commands::get_tools_for_servers,
        core::mcp::commands::get_server_summaries,
        core::mcp::commands::call_tool,
        core::mcp::commands::mcp_trusted_servers,
        core::mcp::commands::mcp_trust_report,
        core::mcp::commands::mcp_server_fingerprints,
        core::mcp::commands::mcp_trust_server,
        core::mcp::commands::mcp_revoke_server,
        core::mcp::commands::mcp_forget_server,
        core::mcp::commands::mcp_allow_once,
        core::mcp::commands::cancel_tool_call,
        core::mcp::commands::restart_mcp_servers,
        core::mcp::commands::get_connected_servers,
        core::mcp::commands::save_mcp_configs,
        core::mcp::commands::get_mcp_configs,
        core::mcp::commands::activate_mcp_server,
        core::mcp::commands::deactivate_mcp_server,
        core::mcp::commands::get_mcp_auth_status,
        core::mcp::commands::get_mcp_server_log,
        core::mcp::commands::authorize_mcp_server,
        core::mcp::commands::clear_mcp_auth,
        core::mcp::commands::check_jan_browser_extension_connected,
        // Threads
        core::threads::commands::list_threads,
        core::threads::commands::create_thread,
        core::threads::commands::modify_thread,
        core::threads::commands::delete_thread,
        core::threads::commands::list_messages,
        core::threads::commands::create_message,
        core::threads::commands::modify_message,
        core::threads::commands::delete_message,
        core::threads::commands::get_thread_assistant,
        core::threads::commands::create_thread_assistant,
        core::threads::commands::modify_thread_assistant,
        // Discussion rooms
        core::rooms::commands::rooms_list,
        core::rooms::commands::room_get,
        core::rooms::commands::room_save,
        core::rooms::commands::room_append,
        core::rooms::commands::room_delete,
        // Download
        core::downloads::commands::download_files,
        core::downloads::commands::cancel_download_task,
        core::downloads::commands::pause_download_task,
        // App lifecycle
        confirm_exit,
        // Theme
        core::setup::get_system_theme,
        core::setup::set_gtk_prefer_dark,
        core::setup::get_titlebar_layout,
        $(
            $extra,
        )*
    ]
    };
}

#[cfg(not(feature = "cli"))]
static SHUTTING_DOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(not(feature = "cli"))]
static GRACEFUL_IN_PROGRESS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
#[cfg(not(feature = "cli"))]
static BUSY_MODELS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

#[cfg(not(feature = "cli"))]
#[tauri::command]
async fn confirm_exit<R: tauri::Runtime>(_app_handle: tauri::AppHandle<R>) {
    SHUTTING_DOWN.store(true, std::sync::atomic::Ordering::SeqCst);
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        std::process::exit(0);
    });
}

#[cfg(not(feature = "cli"))]
/// Whether a llama.cpp engine worker is up, so the exit path knows whether it
/// owes the user a graceful shutdown.
///
/// `try_lock` rather than a blocking lock: this runs on the event loop. A held
/// lock means a start or stop is in flight, which counts as running -- the
/// graceful path is the safe answer when the state cannot be read.
fn is_llamacpp_engine_running<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    use tauri::Manager;
    app.try_state::<std::sync::Arc<tauri_plugin_llamacpp::LlamacppState>>()
        .map(|s| match s.engine.try_lock() {
            Ok(guard) => guard.is_some(),
            Err(_) => true,
        })
        .unwrap_or(false)
}

#[cfg(all(not(feature = "cli"), not(target_os = "macos")))]
fn is_proxy_server_running<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    use tauri::Manager;
    app.try_state::<AppState>()
        .and_then(|s| s.server_handle.try_lock().ok().map(|g| g.is_some()))
        .unwrap_or(false)
}

/// Auto-accept the WebView2 "Reload site?" beforeunload confirmation so it
/// never interrupts the user. This desktop app has no page-level form state
/// worth guarding; the dialog only blocks HMR reloads and extension operations.
#[cfg(all(not(feature = "cli"), windows))]
fn suppress_beforeunload_dialog(window: &tauri::WebviewWindow) {
    window
        .with_webview(|webview| {
            use webview2_com::AddScriptToExecuteOnDocumentCreatedCompletedHandler;
            use windows_core::HSTRING;
            let controller = webview.controller();
            let core = unsafe { controller.CoreWebView2().unwrap() };
            let js = String::from(
                "Object.defineProperty(window,'onbeforeunload',\
                 {get(){return null},set(){}});\
                 window.addEventListener('beforeunload',\
                 function(e){e.stopImmediatePropagation();delete e.returnValue},\
                 true);",
            );
            let _ = AddScriptToExecuteOnDocumentCreatedCompletedHandler::wait_for_async_operation(
                Box::new(move |handler| unsafe {
                    let js = HSTRING::from(js);
                    core.AddScriptToExecuteOnDocumentCreated(&js, &handler)
                        .map_err(Into::into)
                }),
                Box::new(|e, _| e),
            );
        })
        .unwrap_or_else(|e| log::warn!("could not suppress beforeunload dialog: {e}"));
}

#[cfg(not(feature = "cli"))]
fn reemit_busy_if_any<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) {
    let busy = BUSY_MODELS.lock().map(|g| g.clone()).unwrap_or_default();
    if !busy.is_empty() {
        let _ = app_handle.emit("llamacpp-busy-on-exit", &busy);
    }
}

#[cfg(not(feature = "cli"))]
async fn handle_graceful_exit<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    source: &'static str,
    exit_code: i32,
) {
    use std::sync::atomic::Ordering;
    // Reap any still-running agent bash command trees before we tear down, so
    // no shell (or child it spawned) outlives the app.
    tauri_plugin_agent_tools::tools::proc::kill_all();
    let mut emitted = false;
    loop {
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            return;
        }
        match tauri_plugin_llamacpp::try_graceful_stop_engine(app_handle.clone(), 1).await {
            Ok(None) => {
                if let Ok(mut g) = BUSY_MODELS.lock() {
                    g.clear();
                }
                SHUTTING_DOWN.store(true, Ordering::SeqCst);
                app_handle.exit(exit_code);
                return;
            }
            Ok(Some(busy)) => {
                if let Ok(mut g) = BUSY_MODELS.lock() {
                    *g = busy.clone();
                }
                if !emitted {
                    log::warn!("{}: {} model(s) busy: {:?}", source, busy.len(), busy);
                    if let Err(e) = app_handle.emit("llamacpp-busy-on-exit", &busy) {
                        log::warn!("emit llamacpp-busy-on-exit failed: {}", e);
                        SHUTTING_DOWN.store(true, Ordering::SeqCst);
                        app_handle.exit(exit_code);
                        return;
                    }
                    emitted = true;
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            Err(e) => {
                log::warn!("{}: try_graceful_stop_engine failed: {}", source, e);
                SHUTTING_DOWN.store(true, Ordering::SeqCst);
                app_handle.exit(exit_code);
                return;
            }
        }
    }
}

/// Construct the fully-configured Tauri application without entering the event loop.
///
/// This is the single source of builder configuration: plugins, the invoke
/// handler, managed [`AppState`], the `setup` hook and the generated context all
/// live here. Production goes through [`run`]; the `cowork-smoke` harness calls
/// this directly so it can capture the [`AppHandle`](tauri::AppHandle) before
/// handing the app to [`run_app`].
#[cfg(not(feature = "cli"))]
pub fn build_app() -> tauri::App {
    let builder = tauri::Builder::default();
    // Shadowed rather than mutated: under `cowork-smoke`/`e2e` the plugin below
    // is the only thing that touches `builder`, and a `mut` binding would then
    // be unused -- which CI's `clippy -D warnings` treats as an error.
    //
    // Not under `cowork-smoke`. The plugin's namespace is the bundle
    // identifier, so a harness build joined the same one as the user's own Flint:
    // starting the harness while Flint was running made the harness the *second*
    // instance, and it exited immediately, forwarding its argv to Flint. The
    // harness then reported success having run no scenarios at all, because its
    // driver thread never got an app to drive. A test driver has no business
    // claiming the application's single-instance identity.
    // Also disabled under `e2e`: single-instance keys off a per-user socket
    // (a TMPDIR socket on macOS, a D-Bus name on Linux, a named mutex on
    // Windows) that the harness's HOME override does not isolate, so a running
    // Flint would make the test binary the second instance and it would forward
    // its argv and exit before the embedded WebDriver server ever bound.
    #[cfg(all(desktop, not(feature = "cowork-smoke"), not(feature = "e2e")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|_app, argv, _cwd| {
        println!("a new app instance was opened with {argv:?} and the deep link event was already triggered");
        // when defining deep link schemes at runtime, you must also check `argv` here
    }));

    let mut app_builder = builder
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_llamacpp::init())
        .plugin(tauri_plugin_vector_db::init())
        .plugin(tauri_plugin_rag::init())
        .plugin(tauri_plugin_websearch::init())
        .plugin(tauri_plugin_agent_tools::init());

    #[cfg(feature = "deep-link")]
    {
        app_builder = app_builder.plugin(tauri_plugin_deep_link::init());
    }

    // e2e builds only: the embedded WebDriver server @wdio/tauri-service drives.
    // Gated behind the `e2e` feature so no release binary exposes it.
    #[cfg(feature = "e2e")]
    {
        app_builder = app_builder.plugin(tauri_plugin_wdio_webdriver::init());
    }

    #[cfg(target_os = "macos")]
    {
        app_builder = app_builder.plugin(tauri_plugin_mlx::init());
    }

    #[cfg(all(feature = "hardware", not(any(target_os = "android", target_os = "ios"))))]
    {
        app_builder = app_builder.plugin(tauri_plugin_hardware::init());
    }

    // Desktop registers the shared command list and nothing extra.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let app_builder = app_builder.invoke_handler(invoke_commands_with_extras![]);

    #[cfg(any(target_os = "android", target_os = "ios"))]
    let app_builder = app_builder.invoke_handler(invoke_commands_with_extras![
        // Mobile-specific remote provider commands
        core::server::remote_provider_commands::abort_remote_stream,
    ]);

    app_builder
        .manage(AppState {
            app_token: Some(generate_app_token()),
            mcp_servers: Arc::new(Mutex::new(HashMap::new())),
            download_manager: Arc::new(Mutex::new(DownloadManagerState::default())),
            mcp_active_servers: Arc::new(Mutex::new(HashMap::new())),
            server_handle: Arc::new(Mutex::new(None)),
            tool_call_cancellations: Arc::new(Mutex::new(HashMap::new())),
            mcp_settings: Arc::new(Mutex::new(McpSettings::default())),
            mcp_shutdown_in_progress: Arc::new(Mutex::new(false)),
            mcp_monitoring_tasks: Arc::new(Mutex::new(HashMap::new())),
            mcp_starting: Arc::new(Mutex::new(HashSet::new())),
            background_cleanup_handle: Arc::new(Mutex::new(None)),
            mcp_server_pids: Arc::new(Mutex::new(HashMap::new())),
            provider_configs: Arc::new(Mutex::new(HashMap::new())),
            model_param_defaults: Arc::new(Mutex::new(HashMap::new())),
            mcp_reconnect_notify: Arc::new(tokio::sync::Notify::new()),
            mcp_last_known_tools: Arc::new(Mutex::new(HashMap::new())),
            mcp_generation: Arc::new(Mutex::new(HashMap::new())),
        })
        .setup(|app| {
            // Anything a killed run left mid-flight is settled before the
            // window opens, so a timeline restored from disk never shows a
            // call as still running when nothing is left to finish it.
            tauri_plugin_agent_tools::activity::settle_unfinished(&get_jan_data_folder_path(
                app.handle().clone(),
            ));
            // AH-101/AH-102: and what became of the background jobs the last
            // process left. A job whose process is gone is interrupted, never
            // "still running"; one whose pid now belongs to something else is
            // orphaned and is not touched. Nothing is adopted on a pid alone.
            // AH-101: a job whose supervisor is still running is left alone --
            // that is the point of the supervisor. Everything else is settled.
            let settled = tauri_plugin_agent_tools::worker::reconcile_all(
                &get_jan_data_folder_path(app.handle().clone()),
            );
            if !settled.is_empty() {
                log::info!(
                    "background jobs: {} left by an earlier process were settled",
                    settled.len()
                );
            }
            // Request snapshots and usage counts are bounded rather than kept
            // forever. Off the main thread: a large log is a rewrite, and the
            // window should not wait for it.
            {
                let data_folder = get_jan_data_folder_path(app.handle().clone());
                std::thread::spawn(move || {
                    if let Err(e) =
                        tauri_plugin_agent_tools::retention::compact_default(&data_folder)
                    {
                        log::warn!("request log compaction failed: {e}");
                    }
                });
            }
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Debug)
                    // The plugin defaults to a 40 KB cap and KeepOne, which
                    // deletes the previous app.log on each rotation. At Debug
                    // level startup alone crosses 40 KB in ~30s, so a model
                    // load that logs after startup writes its flint-llama-worker
                    // / llama.cpp diagnostics into a segment the next rotation
                    // removes -- exactly the lines needed to triage local
                    // inference. Raise the cap and archive to dated files so
                    // worker and engine logs survive. janhq/jan log fix.
                    .max_file_size(10_000_000)
                    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                    // The plugin's own layout, with values the user marked
                    // secret (a custom provider header, janhq/jan#8208)
                    // replaced before any target -- file, stdout, webview --
                    // sees the line.
                    .format(|out, message, record| {
                        let now = tauri_plugin_log::TimezoneStrategy::UseUtc.get_now();
                        let message = message.to_string();
                        out.finish(format_args!(
                            "[{:04}-{:02}-{:02}][{:02}:{:02}:{:02}][{}][{}] {}",
                            now.year(),
                            u8::from(now.month()),
                            now.day(),
                            now.hour(),
                            now.minute(),
                            now.second(),
                            record.target(),
                            record.level(),
                            crate::core::secret_values::scrub(&message)
                        ))
                    })
                    .targets([
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                            path: get_jan_data_folder_path(app.handle().clone()).join("logs"),
                            file_name: Some("app".to_string()),
                        }),
                    ])
                    .build(),
            )?;
            // The Windows window is created hidden and shown here, at the place
            // it was last left, so it never paints at the default spot and then
            // jumps. See core::window_state.
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                let data_folder = get_jan_data_folder_path(app.handle().clone());
                core::window_state::restore_and_show(&window, &data_folder);
                core::window_state::install(&window, data_folder);
                suppress_beforeunload_dialog(&window);
            }
            // Start migration
            let mut store_path = get_jan_data_folder_path(app.handle().clone());
            store_path.push("store.json");
            let store = app
                .handle()
                .store(store_path)
                .expect("Store not initialized");
            let stored_version = store
                .get("version")
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_default();
            let app_version = app.config().version.clone().unwrap_or_default();

            // Migrate MCP servers
            if let Err(e) = setup::migrate_mcp_servers(app.handle().clone(), store.clone()) {
                log::error!("Failed to migrate MCP servers: {e}");
            }

            // Store the new app version
            store.set("version", serde_json::json!(app_version));
            store.save().expect("Failed to save store");
            // Migration completed

            #[cfg(feature = "desktop")]
            if setup::tray_always_visible() {
                log::info!("Enabling system tray icon");
                let _ = setup::setup_tray(app.handle());
            }

            #[cfg(all(feature = "deep-link", any(windows, target_os = "linux")))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }

            // Initialize SQLite database for mobile platforms
            #[cfg(any(target_os = "android", target_os = "ios"))]
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = crate::core::threads::db::init_database(&app_handle).await {
                        log::error!("Failed to initialize mobile database: {}", e);
                    }
                });
            }

            setup_mcp(app);
            #[cfg(desktop)]
            setup::setup_jan_cli(app.handle().clone(), stored_version != app_version);
            setup::setup_theme_listener(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
}
#[cfg(not(feature = "cli"))]
#[cfg_attr(
    all(mobile, any(target_os = "android", target_os = "ios")),
    tauri::mobile_entry_point
)]
pub fn run() {
    run_app(build_app());
}

/// Attach the lifecycle-event handler and enter the platform event loop.
///
/// Consumes the [`App`](tauri::App) produced by [`build_app`] and blocks until the
/// process exits, so the smoke harness and production share one event loop.
#[cfg(not(feature = "cli"))]
pub fn run_app(app: tauri::App) {
    app.run(|app, event| {
        use std::sync::atomic::Ordering;
        if let RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { api, .. },
            label,
            ..
        } = &event
        {
            if label == "main" && !SHUTTING_DOWN.load(Ordering::SeqCst) {
                // macOS: closing the window hides it; the app (and background
                // services) keep running. Quit happens via Cmd+Q / dock / tray,
                // which routes through RunEvent::ExitRequested.
                #[cfg(target_os = "macos")]
                {
                    api.prevent_close();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                    return;
                }
                // Windows/Linux: hide to tray only while the Local API Server is
                // running and the user opted into keeping it alive in the
                // background; otherwise fall through to the normal quit-on-close.
                // The llamacpp engine is not a reason to keep the app resident
                // (normal chat usage keeps it alive), so it gets torn down via
                // the ExitRequested path on quit.
                #[cfg(not(target_os = "macos"))]
                if is_proxy_server_running(app)
                    && core::server::commands::SERVER_RUN_IN_BACKGROUND.load(Ordering::SeqCst)
                {
                    api.prevent_close();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                    return;
                }
            }
        }
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = &event {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        if let RunEvent::ExitRequested { api, code, .. } = &event {
            if SHUTTING_DOWN.load(Ordering::SeqCst) || !is_llamacpp_engine_running(app) {
                return;
            }
            api.prevent_exit();
            let _ = app.emit("llamacpp-close-attempt", ());
            if GRACEFUL_IN_PROGRESS.swap(true, Ordering::SeqCst) {
                reemit_busy_if_any(app);
                return;
            }
            let app_handle = app.clone();
            let exit_code = code.unwrap_or(0);
            tauri::async_runtime::spawn(async move {
                handle_graceful_exit(app_handle, "ExitRequested", exit_code).await;
                GRACEFUL_IN_PROGRESS.store(false, Ordering::SeqCst);
            });
            return;
        }
        if let RunEvent::Exit = event {
            let app_handle = app.clone();

            // Drain any debounced settings writes before the process dies so
            // jan CLI never reads a stale settings.json.
            core::app::settings_store::flush_settings();

            #[cfg(not(any(target_os = "ios", target_os = "android")))]
            {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.emit("app-shutting-down", ());
                    let _ = window.hide();
                }
            }

            let state = app_handle.state::<AppState>();

            // Check if cleanup already ran
            let cleanup_already_running = tokio::task::block_in_place(|| {
                tauri::async_runtime::block_on(async {
                    let handle = state.background_cleanup_handle.lock().await;
                    handle.is_some()
                })
            });

            if cleanup_already_running {
                return;
            }

            // Run cleanup synchronously and WAIT for it to complete
            tokio::task::block_in_place(|| {
                tauri::async_runtime::block_on(async {
                    use crate::core::mcp::helpers::background_cleanup_mcp_servers;
                    use tauri_plugin_llamacpp::cleanup_llama_processes;

                    let state = app_handle.state::<AppState>();

                    // Increase timeout to 10 seconds and log if it times out
                    let cleanup_future = background_cleanup_mcp_servers(&app_handle, &state);
                    match tokio::time::timeout(tokio::time::Duration::from_secs(10), cleanup_future)
                        .await
                    {
                        Ok(_) => log::info!("MCP cleanup completed successfully"),
                        Err(_) => log::warn!("MCP cleanup timed out after 10 seconds"),
                    }

                    if let Err(e) = cleanup_llama_processes(app_handle.clone()).await {
                        log::warn!("Failed to shut down the llama.cpp engine: {}", e);
                    } else {
                        log::info!("llama.cpp engine shut down successfully");
                    }

                    #[cfg(target_os = "macos")]
                    {
                        use tauri_plugin_mlx::cleanup_mlx_processes;
                        if let Err(e) = cleanup_mlx_processes(app_handle.clone()).await {
                            log::warn!("Failed to cleanup MLX processes: {}", e);
                        } else {
                            log::info!("MLX processes cleaned up successfully");
                        }
                    }

                    log::info!("App cleanup completed");
                });
            });
        }
    });
}
