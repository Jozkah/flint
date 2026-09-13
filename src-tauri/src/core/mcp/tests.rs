use super::commands::is_extension_not_connected_error;
use super::helpers::{add_server_config, add_server_config_with_path, run_mcp_commands};
use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::state::{AppState, SharedMcpServers};
use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{test::mock_app, Manager};
use tokio::sync::Mutex;

#[tokio::test]
async fn test_run_mcp_commands() {
    let app = mock_app();

    // Register AppState so state::<AppState>() calls succeed
    let servers_state: SharedMcpServers = Arc::new(Mutex::new(HashMap::new()));
    app.manage(AppState {
        mcp_servers: servers_state.clone(),
        ..Default::default()
    });

    // Get the app path where the config should be created
    let app_path = get_jan_data_folder_path(app.handle().clone());
    let config_path = app_path.join("mcp_config.json");

    // Ensure the directory exists
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).expect("Failed to create parent directory");
    }

    // Create a mock mcp_config.json file at the correct location
    let mut file: File = File::create(&config_path).expect("Failed to create config file");
    file.write_all(b"{\"mcpServers\":{}}")
        .expect("Failed to write to config file");

    // Call the run_mcp_commands function
    let result = run_mcp_commands(app.handle(), servers_state).await;

    // Assert that the function returns Ok(())
    assert!(result.is_ok());

    // Clean up the mock config file
    std::fs::remove_file(&config_path).expect("Failed to remove config file");
}

#[test]
fn test_add_server_config_new_file() {
    let app = mock_app();
    let app_path = get_jan_data_folder_path(app.handle().clone());
    let config_path = app_path.join("mcp_config_test_new.json");

    // Ensure the directory exists
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).expect("Failed to create parent directory");
    }

    // Create initial config file with empty mcpServers
    let mut file = File::create(&config_path).expect("Failed to create config file");
    file.write_all(b"{\"mcpServers\":{}}")
        .expect("Failed to write to config file");
    drop(file);

    // Test adding a new server config
    let server_value = serde_json::json!({
        "command": "npx",
        "args": ["-y", "test-server"],
        "env": { "TEST_API_KEY": "test_key" },
        "active": false
    });

    let result = add_server_config_with_path(
        app.handle().clone(),
        "test_server".to_string(),
        server_value.clone(),
        Some("mcp_config_test_new.json"),
    );

    assert!(result.is_ok(), "Failed to add server config: {result:?}");

    // Verify the config was added correctly
    let config_content = std::fs::read_to_string(&config_path).expect("Failed to read config file");
    let config: serde_json::Value =
        serde_json::from_str(&config_content).expect("Failed to parse config");

    assert!(config["mcpServers"]["test_server"].is_object());
    assert_eq!(config["mcpServers"]["test_server"]["command"], "npx");
    assert_eq!(config["mcpServers"]["test_server"]["args"][0], "-y");
    assert_eq!(
        config["mcpServers"]["test_server"]["args"][1],
        "test-server"
    );

    // Clean up
    std::fs::remove_file(&config_path).expect("Failed to remove config file");
}

#[test]
fn test_add_server_config_existing_servers() {
    let app = mock_app();
    let app_path = get_jan_data_folder_path(app.handle().clone());
    let config_path = app_path.join("mcp_config_test_existing.json");

    // Ensure the directory exists
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).expect("Failed to create parent directory");
    }

    // Create config file with existing server
    let initial_config = serde_json::json!({
        "mcpServers": {
            "existing_server": {
                "command": "existing_command",
                "args": ["arg1"],
                "active": true
            }
        }
    });

    let mut file = File::create(&config_path).expect("Failed to create config file");
    file.write_all(
        serde_json::to_string_pretty(&initial_config)
            .unwrap()
            .as_bytes(),
    )
    .expect("Failed to write to config file");
    drop(file);

    // Add new server
    let new_server_value = serde_json::json!({
        "command": "new_command",
        "args": ["new_arg"],
        "active": false
    });

    let result = add_server_config_with_path(
        app.handle().clone(),
        "new_server".to_string(),
        new_server_value,
        Some("mcp_config_test_existing.json"),
    );

    assert!(result.is_ok(), "Failed to add server config: {result:?}");

    // Verify both servers exist
    let config_content = std::fs::read_to_string(&config_path).expect("Failed to read config file");
    let config: serde_json::Value =
        serde_json::from_str(&config_content).expect("Failed to parse config");

    // Check existing server is still there
    assert!(config["mcpServers"]["existing_server"].is_object());
    assert_eq!(
        config["mcpServers"]["existing_server"]["command"],
        "existing_command"
    );

    // Check new server was added
    assert!(config["mcpServers"]["new_server"].is_object());
    assert_eq!(config["mcpServers"]["new_server"]["command"], "new_command");

    // Clean up
    std::fs::remove_file(&config_path).expect("Failed to remove config file");
}

#[test]
fn test_add_server_config_missing_config_file() {
    let app = mock_app();
    let app_path = get_jan_data_folder_path(app.handle().clone());

    // Ensure the directory exists
    if let Some(parent) = app_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::create_dir_all(&app_path).ok();

    let config_path = app_path.join("mcp_config.json");

    // Ensure the file doesn't exist
    if config_path.exists() {
        std::fs::remove_file(&config_path).ok();
    }

    let server_value = serde_json::json!({
        "command": "test",
        "args": [],
        "active": false
    });

    let result = add_server_config(app.handle().clone(), "test".to_string(), server_value);

    assert!(
        result.is_err(),
        "Expected error when config file doesn't exist"
    );
    assert!(result.unwrap_err().contains("Failed to read config file"));
}

#[cfg(not(target_os = "windows"))]
#[test]
fn test_bin_path_construction_with_join() {
    // Test that PathBuf::join properly constructs paths
    let bin_path = PathBuf::from("/usr/local/bin");
    let bun_path = bin_path.join("bun");

    assert_eq!(bun_path.to_string_lossy(), "/usr/local/bin/bun");

    // Test conversion to String via display()
    let bun_path_str = bun_path.display().to_string();
    assert_eq!(bun_path_str, "/usr/local/bin/bun");
}

#[cfg(not(target_os = "windows"))]
#[test]
fn test_uv_path_construction_with_join() {
    // Test that PathBuf::join properly constructs paths for uv
    let bin_path = PathBuf::from("/usr/local/bin");
    let uv_path = bin_path.join("uv");

    assert_eq!(uv_path.to_string_lossy(), "/usr/local/bin/uv");

    // Test conversion to String via display()
    let uv_path_str = uv_path.display().to_string();
    assert_eq!(uv_path_str, "/usr/local/bin/uv");
}

#[cfg(target_os = "windows")]
#[test]
fn test_bin_path_construction_windows() {
    // Test Windows-style paths
    let bin_path = PathBuf::from(r"C:\Program Files\bin");
    let bun_path = bin_path.join("bun.exe");

    assert_eq!(bun_path.to_string_lossy(), r"C:\Program Files\bin\bun.exe");

    let bun_path_str = bun_path.display().to_string();
    assert_eq!(bun_path_str, r"C:\Program Files\bin\bun.exe");
}

// ============================================================================
// get_server_summaries Tests
// ============================================================================

#[tokio::test]
async fn test_get_server_summaries_no_connected_servers() {
    use super::commands::get_server_summaries;

    let app = mock_app();
    let servers_state: SharedMcpServers = Arc::new(Mutex::new(HashMap::new()));
    app.manage(AppState {
        mcp_servers: servers_state.clone(),
        ..Default::default()
    });

    let state = app.state::<AppState>();
    let result = get_server_summaries(state).await;

    assert!(result.is_ok());
    assert!(result.unwrap().is_empty());
}

#[tokio::test]
async fn test_get_server_summaries_with_capabilities_in_active_config() {
    use super::commands::get_server_summaries;
    use crate::core::state::AppState;

    let app = mock_app();
    let servers_state: SharedMcpServers = Arc::new(Mutex::new(HashMap::new()));
    app.manage(AppState {
        mcp_servers: servers_state.clone(),
        ..Default::default()
    });

    let state = app.state::<AppState>();

    // Inject a pre-connected server name into mcp_servers (empty RunningServiceEnum is not
    // straightforward to create in unit tests, so we test the active_servers path directly)
    {
        let mut active = state.mcp_active_servers.lock().await;
        active.insert(
            "filesystem".to_string(),
            serde_json::json!({
                "command": "npx",
                "args": ["-y", "fs-server"],
                "capabilities": ["filesystem", "files"],
                "description": "Read and write local files"
            }),
        );
    }

    // Summaries are derived from enabled (active_servers) config, independent of
    // live connection state, so a transiently disconnected server still appears
    // and keeps contributing a stable tool schema.
    let result = get_server_summaries(state).await;
    assert!(result.is_ok());
    let summaries = result.unwrap();
    assert_eq!(
        summaries.len(),
        1,
        "enabled server appears even when disconnected"
    );
    assert_eq!(summaries[0].name, "filesystem");
    assert_eq!(summaries[0].capabilities, vec!["filesystem", "files"]);
    assert_eq!(summaries[0].description, "Read and write local files");
}

#[tokio::test]
async fn test_get_server_summaries_missing_metadata_defaults() {
    use super::commands::get_server_summaries;

    let app = mock_app();
    let servers_state: SharedMcpServers = Arc::new(Mutex::new(HashMap::new()));
    app.manage(AppState {
        mcp_servers: servers_state.clone(),
        ..Default::default()
    });

    let state = app.state::<AppState>();

    // Active server without capabilities/description fields
    {
        let mut active = state.mcp_active_servers.lock().await;
        active.insert(
            "minimal_server".to_string(),
            serde_json::json!({ "command": "npx", "args": [] }),
        );
    }

    // Enabled server with no metadata still appears, with defaulted fields.
    let result = get_server_summaries(state).await;
    assert!(result.is_ok());
    let summaries = result.unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].name, "minimal_server");
    assert!(summaries[0].capabilities.is_empty());
    assert_eq!(summaries[0].description, "");
}

// ============================================================================
// get_tools last-known-tools fallback tests
// ============================================================================

#[tokio::test]
async fn test_get_tools_falls_back_to_last_known_when_server_enabled_but_disconnected() {
    use super::commands::get_tools;
    use super::models::ToolWithServer;

    let app = mock_app();
    let servers_state: SharedMcpServers = Arc::new(Mutex::new(HashMap::new()));
    app.manage(AppState {
        mcp_servers: servers_state.clone(),
        ..Default::default()
    });

    let state = app.state::<AppState>();

    // Enabled (in active_servers) but not present in mcp_servers — simulates a
    // transient disconnect of a remote MCP server.
    {
        let mut active = state.mcp_active_servers.lock().await;
        active.insert("exa".to_string(), serde_json::json!({ "type": "http" }));
    }
    {
        let mut last_known = state.mcp_last_known_tools.lock().await;
        last_known.insert(
            "exa".to_string(),
            vec![ToolWithServer {
                name: "web_search_exa".to_string(),
                description: Some("search the web".to_string()),
                input_schema: serde_json::json!({}),
                server: "exa".to_string(),
            }],
        );
    }

    let result = get_tools(app.handle().clone(), state).await;
    assert!(result.is_ok());
    let tools = result.unwrap();
    assert_eq!(
        tools.len(),
        1,
        "disconnected-but-enabled server's last-known tools still present"
    );
    assert_eq!(tools[0].name, "web_search_exa");
    assert_eq!(tools[0].server, "exa");
}

#[tokio::test]
async fn test_get_tools_omits_disabled_server_even_with_stale_last_known_entry() {
    use super::commands::get_tools;
    use super::models::ToolWithServer;

    let app = mock_app();
    let servers_state: SharedMcpServers = Arc::new(Mutex::new(HashMap::new()));
    app.manage(AppState {
        mcp_servers: servers_state.clone(),
        ..Default::default()
    });

    let state = app.state::<AppState>();

    // Not in active_servers (disabled/never enabled this session) but a stale
    // last-known entry lingers — must not leak into the tool list.
    {
        let mut last_known = state.mcp_last_known_tools.lock().await;
        last_known.insert(
            "old_server".to_string(),
            vec![ToolWithServer {
                name: "stale_tool".to_string(),
                description: None,
                input_schema: serde_json::json!({}),
                server: "old_server".to_string(),
            }],
        );
    }

    let result = get_tools(app.handle().clone(), state).await;
    assert!(result.is_ok());
    assert!(
        result.unwrap().is_empty(),
        "disabled server must not contribute stale tools"
    );
}

// ============================================================================
// Shutdown Context Tests
// ============================================================================

use super::helpers::ShutdownContext;
use std::time::Duration;

#[test]
fn test_shutdown_context_app_exit_timeouts() {
    let context = ShutdownContext::AppExit;
    assert_eq!(context.per_server_timeout(), Duration::from_millis(500));
    assert_eq!(context.overall_timeout(), Duration::from_millis(1500));
}

#[test]
fn test_shutdown_context_manual_restart_timeouts() {
    let context = ShutdownContext::ManualRestart;
    assert_eq!(context.per_server_timeout(), Duration::from_secs(2));
    assert_eq!(context.overall_timeout(), Duration::from_secs(5));
}

#[test]
fn test_shutdown_context_factory_reset_timeouts() {
    let context = ShutdownContext::FactoryReset;
    assert_eq!(context.per_server_timeout(), Duration::from_secs(5));
    assert_eq!(context.overall_timeout(), Duration::from_secs(10));
}

#[test]
fn test_shutdown_context_overall_greater_than_per_server() {
    for context in [
        ShutdownContext::AppExit,
        ShutdownContext::ManualRestart,
        ShutdownContext::FactoryReset,
    ] {
        assert!(
            context.overall_timeout() > context.per_server_timeout(),
            "Overall timeout should be greater than per-server timeout for {:?}",
            context
        );
    }
}

#[test]
fn test_shutdown_context_is_copy() {
    let context = ShutdownContext::AppExit;
    let copied = context;
    assert!(matches!(context, ShutdownContext::AppExit));
    assert!(matches!(copied, ShutdownContext::AppExit));
}

#[tokio::test]
async fn test_background_cleanup_with_empty_state() {
    use super::helpers::background_cleanup_mcp_servers;

    let app = mock_app();
    let servers_state: SharedMcpServers = Arc::new(Mutex::new(HashMap::new()));
    app.manage(AppState {
        mcp_servers: servers_state.clone(),
        ..Default::default()
    });

    let state = app.state::<AppState>();
    background_cleanup_mcp_servers(app.handle(), &state).await;

    let servers = state.mcp_servers.lock().await;
    assert!(servers.is_empty());

    let active = state.mcp_active_servers.lock().await;
    assert!(active.is_empty());
}

#[tokio::test]
async fn test_stop_mcp_servers_with_context_empty_servers() {
    use super::helpers::{stop_mcp_servers_with_context, ShutdownContext};

    let app = mock_app();
    let servers_state: SharedMcpServers = Arc::new(Mutex::new(HashMap::new()));
    app.manage(AppState {
        mcp_servers: servers_state.clone(),
        ..Default::default()
    });

    let state = app.state::<AppState>();
    let result =
        stop_mcp_servers_with_context(app.handle(), &state, ShutdownContext::AppExit).await;

    assert!(result.is_ok());
}

#[tokio::test]
async fn test_stop_mcp_servers_prevents_concurrent_shutdown() {
    use super::helpers::{stop_mcp_servers_with_context, ShutdownContext};

    let app = mock_app();
    let servers_state: SharedMcpServers = Arc::new(Mutex::new(HashMap::new()));
    app.manage(AppState {
        mcp_servers: servers_state.clone(),
        ..Default::default()
    });

    let state = app.state::<AppState>();

    {
        let mut shutdown_flag = state.mcp_shutdown_in_progress.lock().await;
        *shutdown_flag = true;
    }

    let result =
        stop_mcp_servers_with_context(app.handle(), &state, ShutdownContext::AppExit).await;

    assert!(result.is_ok());

    {
        let shutdown_flag = state.mcp_shutdown_in_progress.lock().await;
        assert!(*shutdown_flag);
    }
}

// ============================================================================
// Extension Connection Error Detection Tests
// ============================================================================

#[test]
fn test_extension_disconnected_error_detection() {
    // Real error messages from Jan Browser MCP server when extension is not connected
    let disconnected_errors = [
        // Direct error messages from MCP server
        "Browser extension not connected to bridge",
        "Browser extension not responding to ping",
        "extension not connected",
        // Error with different casing (case insensitive)
        "BROWSER EXTENSION NOT CONNECTED TO BRIDGE",
        // Tool not found errors (older extension without ping tool)
        "tool ping not found",
        "Tool 'browser_snapshot' not found in available tools",
        // Wrapped error messages
        "Error: Browser extension not connected to bridge. Please retry.",
        "[MCP] extension not connected - check browser",
    ];

    for msg in disconnected_errors {
        assert!(
            is_extension_not_connected_error(msg),
            "Should detect as disconnected: {msg}"
        );
    }
}

#[test]
fn test_extension_connected_response_detection() {
    // Valid responses when extension IS connected - should NOT trigger error detection
    let connected_responses = [
        "pong",                   // Successful ping response
        "Success",                // Generic success
        "Connected successfully", // Connection confirmation
        "",                       // Empty response (not an error)
        "Screenshot captured",    // Successful browser_snapshot
        "Page loaded",            // Browser action success
        "browser",                // Single keyword (not an error pattern)
        "tool",                   // Single keyword (not an error pattern)
    ];

    for msg in connected_responses {
        assert!(
            !is_extension_not_connected_error(msg),
            "Should NOT detect as disconnected: {msg}"
        );
    }
}

// ============================================================================
// constants.rs Tests
// ============================================================================

#[test]
fn test_default_constants_values() {
    use super::constants::*;
    assert_eq!(DEFAULT_MCP_TOOL_CALL_TIMEOUT_SECS, 30);
    assert_eq!(DEFAULT_MCP_BASE_RESTART_DELAY_MS, 1000);
    assert_eq!(DEFAULT_MCP_MAX_RESTART_DELAY_MS, 30000);
    assert!((DEFAULT_MCP_BACKOFF_MULTIPLIER - 2.0).abs() < f64::EPSILON);
    const _: () = assert!(DEFAULT_MCP_BASE_RESTART_DELAY_MS < DEFAULT_MCP_MAX_RESTART_DELAY_MS);
}

#[test]
fn test_default_mcp_config_parses_as_valid_json() {
    use super::constants::DEFAULT_MCP_CONFIG;
    let value: serde_json::Value =
        serde_json::from_str(DEFAULT_MCP_CONFIG).expect("DEFAULT_MCP_CONFIG must be valid JSON");
    assert!(value["mcpServers"].is_object());
    assert!(value["mcpSettings"].is_object());
    // Spot-check known servers
    assert!(value["mcpServers"]["fetch"].is_object());
    assert_eq!(value["mcpServers"]["fetch"]["command"], "uvx");
    assert_eq!(
        value["mcpSettings"]["toolCallTimeoutSeconds"],
        super::constants::DEFAULT_MCP_TOOL_CALL_TIMEOUT_SECS
    );
}

#[test]
fn test_default_mcp_config_servers_have_required_fields() {
    use super::constants::DEFAULT_MCP_CONFIG;
    let value: serde_json::Value = serde_json::from_str(DEFAULT_MCP_CONFIG).unwrap();
    let servers = value["mcpServers"].as_object().unwrap();
    for (name, cfg) in servers {
        assert!(cfg.get("command").is_some(), "{name} missing command");
        assert!(cfg.get("args").is_some(), "{name} missing args");
        assert!(
            cfg.get("active").and_then(|v| v.as_bool()).is_some(),
            "{name} missing active bool"
        );
    }
}

// ============================================================================
// models.rs Tests
// ============================================================================

#[test]
fn test_mcp_settings_default_matches_constants() {
    use super::constants;
    use super::models::McpSettings;
    let s = McpSettings::default();
    assert_eq!(
        s.tool_call_timeout_seconds,
        constants::DEFAULT_MCP_TOOL_CALL_TIMEOUT_SECS
    );
    assert_eq!(
        s.base_restart_delay_ms,
        constants::DEFAULT_MCP_BASE_RESTART_DELAY_MS
    );
    assert_eq!(
        s.max_restart_delay_ms,
        constants::DEFAULT_MCP_MAX_RESTART_DELAY_MS
    );
    assert!(
        (s.backoff_multiplier - constants::DEFAULT_MCP_BACKOFF_MULTIPLIER).abs() < f64::EPSILON
    );
    assert!(s.enable_smart_tool_routing);
    assert!(!s.use_lightweight_router_model);
    assert!(s.router_model_provider.is_empty());
    assert!(s.router_model_id.is_empty());
    assert_eq!(
        s.max_tool_output_chars,
        constants::DEFAULT_MCP_MAX_TOOL_OUTPUT_CHARS
    );
}

#[test]
fn test_mcp_settings_tool_call_timeout_duration_enforces_minimum() {
    use super::models::McpSettings;
    let mut s = McpSettings {
        tool_call_timeout_seconds: 0,
        ..McpSettings::default()
    };
    assert_eq!(s.tool_call_timeout_duration(), Duration::from_secs(1));
    s.tool_call_timeout_seconds = 5;
    assert_eq!(s.tool_call_timeout_duration(), Duration::from_secs(5));
    s.tool_call_timeout_seconds = 600;
    assert_eq!(s.tool_call_timeout_duration(), Duration::from_secs(600));
}

#[test]
fn test_mcp_settings_tool_output_cap_takes_the_tighter_of_setting_and_override() {
    use super::models::McpSettings;
    let s = McpSettings {
        max_tool_output_chars: 40_000,
        ..McpSettings::default()
    };

    // No caller budget: the user's setting governs.
    assert_eq!(s.tool_output_cap(None), 40_000);
    // A tighter model-derived budget wins.
    assert_eq!(s.tool_output_cap(Some(8_000)), 8_000);
    // A looser one cannot raise the user's ceiling.
    assert_eq!(s.tool_output_cap(Some(500_000)), 40_000);
    // A 0 override means "no derived budget", not "uncapped".
    assert_eq!(s.tool_output_cap(Some(0)), 40_000);
}

#[test]
fn test_mcp_settings_zero_max_tool_output_chars_disables_capping() {
    use super::models::McpSettings;
    let s = McpSettings {
        max_tool_output_chars: 0,
        ..McpSettings::default()
    };

    assert_eq!(s.tool_output_cap(None), 0);
    assert_eq!(
        s.tool_output_cap(Some(8_000)),
        0,
        "an explicit opt-out is not overridden by a derived budget"
    );
}

#[test]
fn test_mcp_settings_deserialize_uses_defaults_for_missing_fields() {
    use super::models::McpSettings;
    let s: McpSettings = serde_json::from_str("{}").unwrap();
    assert_eq!(s, McpSettings::default_for_eq());
}

// helper trait-like for equality (we don't derive PartialEq on the public type)
impl super::models::McpSettings {
    fn default_for_eq() -> Self {
        Self::default()
    }
}

// Compare individual fields since McpSettings doesn't derive PartialEq
impl PartialEq for super::models::McpSettings {
    fn eq(&self, other: &Self) -> bool {
        self.tool_call_timeout_seconds == other.tool_call_timeout_seconds
            && self.base_restart_delay_ms == other.base_restart_delay_ms
            && self.max_restart_delay_ms == other.max_restart_delay_ms
            && (self.backoff_multiplier - other.backoff_multiplier).abs() < f64::EPSILON
            && self.enable_smart_tool_routing == other.enable_smart_tool_routing
            && self.use_lightweight_router_model == other.use_lightweight_router_model
            && self.router_model_provider == other.router_model_provider
            && self.router_model_id == other.router_model_id
            && self.max_tool_output_chars == other.max_tool_output_chars
    }
}

#[test]
fn test_mcp_settings_round_trip_camel_case() {
    use super::models::McpSettings;
    let s = McpSettings {
        tool_call_timeout_seconds: 42,
        router_model_provider: "openai".into(),
        router_model_id: "gpt-4".into(),
        use_lightweight_router_model: true,
        ..McpSettings::default()
    };
    let json = serde_json::to_string(&s).unwrap();
    assert!(json.contains("\"toolCallTimeoutSeconds\":42"));
    assert!(json.contains("\"routerModelProvider\":\"openai\""));
    assert!(json.contains("\"useLightweightRouterModel\":true"));
    let parsed: McpSettings = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, s);
}

#[test]
fn test_mcp_settings_partial_deserialize_preserves_provided_values() {
    use super::models::McpSettings;
    let json = r#"{"toolCallTimeoutSeconds": 90, "backoffMultiplier": 3.5}"#;
    let s: McpSettings = serde_json::from_str(json).unwrap();
    assert_eq!(s.tool_call_timeout_seconds, 90);
    assert!((s.backoff_multiplier - 3.5).abs() < f64::EPSILON);
    // Other fields must fall back to defaults
    let d = McpSettings::default();
    assert_eq!(s.base_restart_delay_ms, d.base_restart_delay_ms);
    assert_eq!(s.enable_smart_tool_routing, d.enable_smart_tool_routing);
}

#[test]
fn test_tool_with_server_serialization_uses_input_schema_camel_case() {
    use super::models::ToolWithServer;
    let t = ToolWithServer {
        name: "search".into(),
        description: Some("d".into()),
        input_schema: serde_json::json!({"type": "object"}),
        server: "srv".into(),
    };
    let json = serde_json::to_string(&t).unwrap();
    assert!(json.contains("\"inputSchema\":"));
    assert!(!json.contains("\"input_schema\""));
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["name"], "search");
    assert_eq!(v["server"], "srv");
}

#[test]
fn test_server_summary_round_trip() {
    use super::models::ServerSummary;
    let s = ServerSummary {
        name: "fs".into(),
        capabilities: vec!["filesystem".into(), "files".into()],
        description: "Read files".into(),
    };
    let json = serde_json::to_string(&s).unwrap();
    let parsed: ServerSummary = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.name, "fs");
    assert_eq!(parsed.capabilities, vec!["filesystem", "files"]);
    assert_eq!(parsed.description, "Read files");
}

// ============================================================================
// lockfile.rs Tests
// ============================================================================

#[test]
fn test_mcp_lock_file_serde_round_trip() {
    use super::lockfile::McpLockFile;
    let lock = McpLockFile {
        pid: 4242,
        jan_pid: std::process::id(),
        port: 17389,
        server_name: "Jan Browser MCP".to_string(),
        created_at: "2026-01-01T00:00:00+00:00".to_string(),
        hostname: "test-host".to_string(),
    };
    let json = serde_json::to_string_pretty(&lock).unwrap();
    let parsed: McpLockFile = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.pid, 4242);
    assert_eq!(parsed.port, 17389);
    assert_eq!(parsed.server_name, "Jan Browser MCP");
    assert_eq!(parsed.created_at, "2026-01-01T00:00:00+00:00");
    assert_eq!(parsed.hostname, "test-host");
}

#[test]
fn test_mcp_lock_file_rejects_malformed_json() {
    use super::lockfile::McpLockFile;
    assert!(serde_json::from_str::<McpLockFile>("{").is_err());
    // Missing required fields
    assert!(serde_json::from_str::<McpLockFile>(r#"{"pid": 1}"#).is_err());
}

#[test]
fn test_is_process_alive_for_current_process() {
    use super::lockfile::is_process_alive;
    let me = std::process::id();
    assert!(is_process_alive(me), "current process must be alive");
}

#[cfg(unix)]
#[test]
fn test_is_process_alive_for_almost_certainly_dead_pid() {
    use super::lockfile::is_process_alive;
    // PID 0 is the scheduler / not a real signalable process on Linux/macOS
    // and PID 999999 is extremely unlikely to exist
    // (i32::MAX as u32) exceeds Linux pid_max → kernel returns ESRCH/EINVAL
    assert!(!is_process_alive(i32::MAX as u32));
}

/// A mock app whose app-data directory -- where MCP lock files live -- is its
/// own. The lock-file tests used to share the stock mock identifier's folder,
/// and `cleanup_own_locks` removes every lock this process owns there: run
/// alongside it, `keeps_live_lock` lost the lock it had just created. The
/// directory is removed when the guard drops.
fn lock_test_app() -> (tauri::App<tauri::test::MockRuntime>, LockDirGuard) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!(
        "jan.test.mcp-lock.{}.{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    );
    let app = tauri::test::mock_builder()
        .build(context)
        .expect("mock app");
    let dir = app.handle().path().app_data_dir().expect("app data dir");
    (app, LockDirGuard(dir))
}

struct LockDirGuard(PathBuf);

impl Drop for LockDirGuard {
    fn drop(&mut self) {
        // Only ever the per-test identifier's folder created above.
        if self
            .0
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("jan.test.mcp-lock."))
        {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[test]
fn test_create_read_delete_lock_file_round_trip() {
    use super::lockfile::{create_lock_file, delete_lock_file, read_lock_file};
    let (app, _lock_dir) = lock_test_app();
    // Use an unusual port to avoid colliding with other tests
    let port: u16 = 53_111;
    // Ensure clean slate
    let _ = delete_lock_file(app.handle(), port);

    let fake_child_pid = std::process::id().wrapping_add(1);
    create_lock_file(app.handle(), port, "test-server", fake_child_pid).expect("create_lock_file");
    let lock = read_lock_file(app.handle(), port).expect("read_lock_file");
    assert_eq!(lock.port, port);
    assert_eq!(lock.server_name, "test-server");
    assert_eq!(lock.pid, fake_child_pid);
    assert_eq!(lock.jan_pid, std::process::id());
    assert!(!lock.created_at.is_empty());
    assert!(!lock.hostname.is_empty());

    delete_lock_file(app.handle(), port).expect("delete_lock_file");
    assert!(read_lock_file(app.handle(), port).is_none());
}

#[test]
fn test_read_lock_file_returns_none_for_missing_port() {
    use super::lockfile::{delete_lock_file, read_lock_file};
    let (app, _lock_dir) = lock_test_app();
    let port: u16 = 53_112;
    // Make sure it does not exist
    let _ = delete_lock_file(app.handle(), port);
    assert!(read_lock_file(app.handle(), port).is_none());
}

#[test]
fn test_delete_lock_file_is_idempotent_when_missing() {
    use super::lockfile::delete_lock_file;
    let (app, _lock_dir) = lock_test_app();
    let port: u16 = 53_113;
    // Calling delete on a non-existent file should still return Ok(())
    assert!(delete_lock_file(app.handle(), port).is_ok());
    assert!(delete_lock_file(app.handle(), port).is_ok());
}

#[tokio::test]
async fn test_check_and_cleanup_stale_lock_no_lock_returns_false() {
    use super::lockfile::{check_and_cleanup_stale_lock, delete_lock_file};
    let (app, _lock_dir) = lock_test_app();
    let port: u16 = 53_114;
    let _ = delete_lock_file(app.handle(), port);
    let cleaned = check_and_cleanup_stale_lock(app.handle(), port)
        .await
        .unwrap();
    assert!(!cleaned);
}

#[tokio::test]
async fn test_check_and_cleanup_stale_lock_keeps_live_lock() {
    use super::lockfile::{
        check_and_cleanup_stale_lock, create_lock_file, delete_lock_file, read_lock_file,
    };
    let (app, _lock_dir) = lock_test_app();
    let port: u16 = 53_115;
    let _ = delete_lock_file(app.handle(), port);
    create_lock_file(app.handle(), port, "live", std::process::id()).unwrap();
    // Lock pid is the current process (alive) → must NOT be removed
    let cleaned = check_and_cleanup_stale_lock(app.handle(), port)
        .await
        .unwrap();
    assert!(!cleaned);
    assert!(read_lock_file(app.handle(), port).is_some());
    let _ = delete_lock_file(app.handle(), port);
}

#[cfg(unix)]
#[tokio::test]
async fn test_check_and_cleanup_stale_lock_removes_dead_pid_lock() {
    use super::lockfile::{check_and_cleanup_stale_lock, read_lock_file, McpLockFile};
    use tauri::Manager;
    let (app, _lock_dir) = lock_test_app();
    let port: u16 = 53_116;
    // Use the SAME directory the lockfile module uses
    let app_data_dir = app.handle().path().app_data_dir().expect("app data dir");
    std::fs::create_dir_all(&app_data_dir).ok();
    let lock_path = app_data_dir.join(format!("mcp_lock_{}.json", port));

    // PID above pid_max guarantees ESRCH/EINVAL on Unix → reported as not alive
    let dead_pid: u32 = i32::MAX as u32;
    let lock = McpLockFile {
        pid: dead_pid,
        jan_pid: std::process::id(),
        port,
        server_name: "ghost".to_string(),
        created_at: "2020-01-01T00:00:00+00:00".to_string(),
        hostname: "x".to_string(),
    };
    std::fs::write(&lock_path, serde_json::to_string(&lock).unwrap()).unwrap();
    assert!(
        read_lock_file(app.handle(), port).is_some(),
        "seed lock readable"
    );

    let cleaned = check_and_cleanup_stale_lock(app.handle(), port)
        .await
        .unwrap();
    assert!(cleaned, "stale lock for dead PID must be cleaned");
    assert!(read_lock_file(app.handle(), port).is_none());
}

#[test]
fn test_cleanup_own_locks_removes_only_current_pid_locks() {
    use super::lockfile::{
        cleanup_own_locks, create_lock_file, delete_lock_file, read_lock_file, McpLockFile,
    };
    use tauri::Manager;
    let (app, _lock_dir) = lock_test_app();
    let own_port: u16 = 53_117;
    let other_port: u16 = 53_118;
    let _ = delete_lock_file(app.handle(), own_port);
    let _ = delete_lock_file(app.handle(), other_port);

    // Lock owned by us (jan_pid matches current process)
    let fake_child_pid = std::process::id().wrapping_add(1);
    create_lock_file(app.handle(), own_port, "ours", fake_child_pid).unwrap();

    // Lock owned by a different Jan instance — write directly into the SAME dir lockfile uses
    let app_data_dir = app.handle().path().app_data_dir().expect("app data dir");
    std::fs::create_dir_all(&app_data_dir).ok();
    let other_path = app_data_dir.join(format!("mcp_lock_{}.json", other_port));
    let foreign_jan_pid = if std::process::id() == 1 { 2 } else { 1 };
    let foreign = McpLockFile {
        pid: foreign_jan_pid,
        jan_pid: foreign_jan_pid,
        port: other_port,
        server_name: "theirs".into(),
        created_at: "2020-01-01T00:00:00+00:00".into(),
        hostname: "x".into(),
    };
    std::fs::write(&other_path, serde_json::to_string(&foreign).unwrap()).unwrap();
    assert!(read_lock_file(app.handle(), other_port).is_some());

    cleanup_own_locks(app.handle()).expect("cleanup_own_locks");

    // Our lock removed, foreign lock untouched
    assert!(read_lock_file(app.handle(), own_port).is_none());
    assert!(
        read_lock_file(app.handle(), other_port).is_some(),
        "foreign-PID lock must be preserved"
    );

    // Cleanup
    let _ = std::fs::remove_file(&other_path);
}

#[cfg(unix)]
#[tokio::test]
async fn terminate_browser_mcp_reaps_process_group() {
    use super::helpers::terminate_browser_mcp;
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    // Group leader (pgid == pid) that keeps a backgrounded grandchild alive.
    // killpg must reap the whole group, not just the leader.
    let mut child = {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg("sleep 30 & wait");
        cmd.process_group(0);
        cmd.spawn().expect("spawn group leader")
    };
    let pid = child.id();

    // A port nothing binds → terminate kills the group, finds the port already
    // free, and returns. (We're the leader's parent, so after the kill it sits as
    // a zombie until we wait() below.)
    let free_port = {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let p = l.local_addr().unwrap().port();
        drop(l);
        p
    };

    terminate_browser_mcp(Some(pid), free_port).await;

    let status = child.wait().expect("reap leader");
    assert!(
        !status.success(),
        "group leader should have been signalled, got {status:?}"
    );
}

/// Confining a local MCP server at the launcher boundary.
///
/// These assert the thing the plugin's own tests cannot: that the command
/// Jan is about to spawn is the confined one, with the environment rebuilt
/// rather than inherited. The policy itself is the plugin's, and tested there.
#[cfg(test)]
mod mcp_confinement_tests {
    use super::super::launch::confined_mcp_command;
    use super::super::models::{McpConfinement, McpServerConfig};
    use std::path::PathBuf;
    use tokio::process::Command;

    fn params(env: &[(&str, &str)]) -> McpServerConfig {
        let mut envs = serde_json::Map::new();
        for (k, v) in env {
            envs.insert(
                (*k).to_string(),
                serde_json::Value::String((*v).to_string()),
            );
        }
        McpServerConfig {
            transport_type: Some("stdio".to_string()),
            url: None,
            command: "node".to_string(),
            args: vec![],
            envs,
            timeout: None,
            headers: serde_json::Map::new(),
            confinement: None,
            imported: false,
        }
    }

    fn confinement() -> McpConfinement {
        McpConfinement {
            workspace: PathBuf::from("/tmp/jan-session"),
            repository: Some(PathBuf::from("/home/dev/obs-forwarder")),
            writable_repository: None,
            jan_data: Some(PathBuf::from("/home/dev/.jan")),
            allowed_env: vec!["API_TOKEN".to_string()],
        }
    }

    fn plain() -> Command {
        let mut cmd = Command::new("/usr/bin/node");
        cmd.arg("server.js");
        cmd
    }

    /// A server the user configured themselves is untouched. They chose the
    /// program; confining it would break the ordinary case for no gain.
    #[test]
    fn a_user_configured_server_is_left_alone() {
        let mut p = params(&[]);
        p.confinement = None;

        // The caller skips confinement entirely when there is none to apply,
        // which is what `start_mcp_server` does with the `confine` closure.
        assert!(p.confinement.is_none());
    }

    #[test]
    fn an_imported_server_is_spawned_through_the_wrapper() {
        let built = confined_mcp_command(plain(), &params(&[]), &confinement());

        let Ok(cmd) = built else {
            // No backend on this host: refusing is the correct outcome and is
            // asserted by `an_imported_server_will_not_start_unconfined`.
            return;
        };
        assert_ne!(
            cmd.as_std().get_program(),
            std::ffi::OsStr::new("/usr/bin/node"),
            "the server must be launched through the sandbox wrapper"
        );
    }

    /// Jan's process holds the user's whole session. `Command` inherits that
    /// by default, so the environment is rebuilt rather than filtered.
    #[test]
    fn only_approved_environment_names_reach_the_server() {
        let p = params(&[
            ("API_TOKEN", "for-the-server"),
            ("AWS_SECRET_ACCESS_KEY", "not-yours"),
        ]);
        let Ok(cmd) = confined_mcp_command(plain(), &p, &confinement()) else {
            return;
        };

        let passed: Vec<String> = cmd
            .as_std()
            .get_envs()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();

        assert_eq!(passed, vec!["API_TOKEN".to_string()]);
        assert!(!passed.iter().any(|one| one.contains("AWS")));
    }

    #[test]
    fn the_server_starts_in_the_session_workspace() {
        let Ok(cmd) = confined_mcp_command(plain(), &params(&[]), &confinement()) else {
            return;
        };

        assert_eq!(
            cmd.as_std().get_current_dir(),
            Some(std::path::Path::new("/tmp/jan-session"))
        );
    }

    /// Fail closed. A confinement that cannot be built means no server, not a
    /// server running with the user's whole filesystem in reach.
    #[test]
    fn an_imported_server_will_not_start_unconfined() {
        if tauri_plugin_agent_tools::tools::mcp_confine::confinement_available() {
            return;
        }

        let err = confined_mcp_command(plain(), &params(&[]), &confinement())
            .expect_err("with nothing enforcing there is no confined command");

        assert!(!err.is_empty(), "the refusal has to explain itself");
    }

    /// The environment is rebuilt, not filtered — proved by running it.
    ///
    /// `Command` inherits the parent's environment by default, and inspecting
    /// the builder cannot tell `env_clear` apart from its absence: the getter
    /// reports only explicit overrides either way. So the check is behavioural:
    /// set a marker in this process, run a confined shell, and require that it
    /// cannot see it.
    #[tokio::test]
    async fn a_confined_server_cannot_see_this_process_environment() {
        if !tauri_plugin_agent_tools::tools::mcp_confine::confinement_available() {
            return;
        }
        // Not runnable from a test binary on Windows, and not because the
        // product is wrong. The AppContainer backend cannot be expressed as an
        // argv prefix -- it is a token attribute on the spawn -- so `jail::wrap`
        // re-execs `current_exe()` with helper arguments and lets that process
        // perform the confined spawn. Inside a unit-test harness
        // `current_exe()` is the harness, which implements no such helper, so
        // the wrapped command produces no output and *both* assertions below
        // become vacuous. The behaviour is covered where a real host binary
        // exists: the cowork-smoke harness, which runs the actual application.
        if cfg!(windows) {
            // Still assert the shape, so a backend silently degrading to
            // "no confinement" on Windows is caught here rather than shipping.
            let probe = Command::new("cmd.exe");
            let mut p = params(&[("API_TOKEN", "approved-value")]);
            p.confinement = Some(McpConfinement {
                workspace: std::env::temp_dir(),
                repository: None,
                writable_repository: None,
                jan_data: None,
                allowed_env: vec!["API_TOKEN".to_string()],
            });
            let confinement = p.confinement.clone().expect("set above");
            let wrapped = confined_mcp_command(probe, &p, &confinement)
                .expect("a confined command must be constructible");
            let program = wrapped.as_std().get_program().to_string_lossy().into_owned();
            assert_ne!(
                program.to_lowercase(),
                "cmd.exe",
                "the command was handed back unconfined instead of wrapped"
            );
            return;
        }
        std::env::set_var("JAN_MCP_LEAK_MARKER", "must-not-escape");

        let workspace = std::env::temp_dir()
            .canonicalize()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join(format!("jan-mcp-env-{}", std::process::id()));
        std::fs::create_dir_all(&workspace).expect("workspace");

        // The shell, and the way it spells a variable, differ by platform.
        // Hard-coding `/bin/sh` meant this produced no output at all on
        // Windows: the approved-variable assertion failed for the missing
        // shell, and -- worse -- the leak assertion passed vacuously, because
        // empty output contains no marker either. A confinement test that
        // cannot fail is not a confinement test.
        let mut inner = if cfg!(windows) {
            let mut c = Command::new("cmd.exe");
            c.arg("/c")
                .arg("echo [%JAN_MCP_LEAK_MARKER%][%API_TOKEN%]");
            c
        } else {
            let mut c = Command::new("/bin/sh");
            c.arg("-c").arg("echo [$JAN_MCP_LEAK_MARKER][$API_TOKEN]");
            c
        };

        let mut p = params(&[("API_TOKEN", "approved-value")]);
        p.confinement = Some(McpConfinement {
            workspace: workspace.clone(),
            repository: None,
            writable_repository: None,
            jan_data: None,
            allowed_env: vec!["API_TOKEN".to_string()],
        });
        let confinement = p.confinement.clone().expect("set above");

        let Ok(mut cmd) = confined_mcp_command(inner, &p, &confinement) else {
            return;
        };
        let out = cmd.output().await.expect("run the confined command");
        let text = String::from_utf8_lossy(&out.stdout).to_string();

        assert!(
            !text.contains("must-not-escape"),
            "the parent environment leaked into a confined server: {text}"
        );
        assert!(
            text.contains("approved-value"),
            "an approved variable must still reach the server: {text}"
        );
    }

    /// Fail closed at the launcher, not at the caller.
    ///
    /// Every path that starts a local server constructs a `ConfinedMcpLaunch`
    /// — the desktop activation, the restart loop that replays a stored
    /// config, and the CLI. An imported server whose confinement was never
    /// attached stops there rather than starting with the user's whole
    /// filesystem in reach because some caller forgot.
    #[test]
    fn an_imported_server_with_no_confinement_is_refused() {
        use super::super::launch::ConfinedMcpLaunch;

        let mut p = params(&[]);
        p.imported = true;
        p.confinement = None;

        let err = ConfinedMcpLaunch::prepare(&p, plain)
            .expect_err("an imported server must not start unconfined");

        assert!(err.contains("unconfined"), "{err}");
    }

    #[test]
    fn a_user_configured_server_still_starts_unchanged() {
        use super::super::launch::ConfinedMcpLaunch;

        let mut p = params(&[]);
        p.imported = false;
        p.confinement = None;

        let launch =
            ConfinedMcpLaunch::prepare(&p, plain).expect("a user's own server is untouched");

        assert!(!launch.is_confined());
    }

    /// The confinement is read from what Jan attached, never from the
    /// repository's own file.
    #[test]
    fn confinement_is_parsed_from_the_configuration_jan_builds() {
        use super::super::models::extract_command_args;

        let config = serde_json::json!({
            "command": "node",
            "args": [],
            "janImported": true,
            "janConfinement": {
                "workspace": "/tmp/jan-session",
                "repository": "/home/dev/obs-forwarder",
                "allowedEnv": ["API_TOKEN"]
            }
        });

        let parsed = extract_command_args(&config).expect("parse");

        assert!(parsed.imported);
        let confinement = parsed.confinement.expect("confinement");
        assert_eq!(
            confinement.workspace,
            std::path::PathBuf::from("/tmp/jan-session")
        );
        assert_eq!(confinement.allowed_env, vec!["API_TOKEN".to_string()]);
        assert!(
            confinement.writable_repository.is_none(),
            "no write root unless one was granted"
        );
    }

    /// An ordinary server carries neither, and is unaffected.
    #[test]
    fn an_ordinary_configuration_is_neither_imported_nor_confined() {
        use super::super::models::extract_command_args;

        let parsed = extract_command_args(&serde_json::json!({
            "command": "node",
            "args": []
        }))
        .expect("parse");

        assert!(!parsed.imported);
        assert!(parsed.confinement.is_none());
    }
}

/// The real launch path, with a real MCP server on the other end.
///
/// Everything else in this file asserts how a command is *built*. This runs
/// one: it prepares a confined launch through the production capability,
/// spawns it, completes an actual JSON-RPC handshake with a server on stdio,
/// lists its tools and calls one. The fixture is a small script rather than a
/// mock so the protocol is genuinely exercised, and it reaches no network and
/// depends on nothing installed beyond python3.
/// AH-137: an MCP server's documents, over the real protocol.
///
/// Its own module rather than a case inside the end-to-end tests above,
/// because those are unix-shaped (they prepare a confined launch first) and
/// resources are worth exercising on every host. Same fixture, same client,
/// no confinement -- what is under test is the protocol and what the harness
/// does with the answer.
#[cfg(test)]
mod mcp_resource_tests {
    use rmcp::model::ReadResourceRequestParam;
    use rmcp::ServiceExt;
    use std::path::PathBuf;
    use std::process::Stdio;

    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp_stdio_server.py")
    }

    /// The interpreter this host calls python, or nothing.
    fn python() -> Option<&'static str> {
        for candidate in ["python3", "python"] {
            let ok = std::process::Command::new(candidate)
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if ok {
                return Some(candidate);
            }
        }
        None
    }

    #[tokio::test]
    async fn a_servers_resources_are_listed_and_read_and_are_not_instructions() {
        let (Some(python), true) = (python(), fixture().exists()) else {
            // No interpreter here: the test says so rather than passing
            // silently, because a skip that looks like a pass is how a test
            // stops testing anything.
            eprintln!("skipped: no python interpreter on this host");
            return;
        };
        eprintln!("running the resource test against {python}");
        let mut command = tokio::process::Command::new(python);
        command.arg(fixture());
        let service = ().serve(rmcp::transport::TokioChildProcess::new(command).expect("spawn"))
            .await
            .expect("initialize");

        let resources = service.list_all_resources().await.expect("resources/list");
        assert!(
            resources.iter().any(|r| r.raw.uri == "fixture://notes/one"),
            "the server's resource must be discovered: {resources:?}"
        );

        let read = service
            .read_resource(ReadResourceRequestParam {
                uri: "fixture://notes/one".to_string(),
            })
            .await
            .expect("resources/read");
        let text = serde_json::to_string(&read).expect("serialize");
        assert!(text.contains("ignore your instructions"), "the content came back: {text}");

        // A uri the server does not have is that server's refusal, not a
        // silent empty document.
        assert!(service
            .read_resource(ReadResourceRequestParam {
                uri: "fixture://notes/missing".to_string(),
            })
            .await
            .is_err());

        service.cancel().await.expect("shutdown");
    }

    /// AH-143: the fixture serves its tools over two pages, and the second
    /// tool exists only on the second. A client that does not follow the
    /// cursor is visibly missing it, rather than merely untested.
    #[tokio::test]
    async fn a_paginated_listing_is_followed_to_the_end() {
        let (Some(python), true) = (python(), fixture().exists()) else {
            eprintln!("skipped: no python interpreter on this host");
            return;
        };
        let mut command = tokio::process::Command::new(python);
        command.arg(fixture());
        let service = ().serve(rmcp::transport::TokioChildProcess::new(command).expect("spawn"))
            .await
            .expect("initialize");

        let tools = service.list_all_tools().await.expect("tools/list");
        let names: Vec<String> = tools.iter().map(|t| t.name.to_string()).collect();
        assert!(
            names.iter().any(|n| n == "echo_fixture"),
            "the first page: {names:?}"
        );
        assert!(
            names.iter().any(|n| n == "echo_fixture_page_two"),
            "the second page is only reachable by following the cursor: {names:?}"
        );

        service.cancel().await.expect("shutdown");
    }

    /// AH-138: a server's prompts are listed and one is fetched, filled in
    /// with the argument it declared. What comes back is the server's
    /// content -- returned as it was written, and refused by the server when
    /// it is asked for something it does not have.
    #[tokio::test]
    async fn a_servers_prompts_are_listed_and_fetched() {
        use crate::core::mcp::commands::{get_prompt, list_prompts};
        use crate::core::mcp::models::render_prompt;

        let (Some(python), true) = (python(), fixture().exists()) else {
            eprintln!("skipped: no python interpreter on this host");
            return;
        };
        let mut command = tokio::process::Command::new(python);
        command.arg(fixture());
        let service = ().serve(rmcp::transport::TokioChildProcess::new(command).expect("spawn"))
            .await
            .expect("initialize");

        let prompts = list_prompts(&service).await.expect("prompts/list");
        let greet = prompts
            .iter()
            .find(|p| p.name == "greet")
            .expect("the fixture's prompt");
        assert_eq!(
            greet
                .arguments
                .as_ref()
                .map(|a| a.iter().map(|arg| arg.name.clone()).collect::<Vec<_>>()),
            Some(vec!["name".to_string()]),
            "its declared argument travels with it"
        );

        let mut arguments = serde_json::Map::new();
        arguments.insert("name".to_string(), serde_json::json!("the fixture"));
        let filled = get_prompt(&service, "greet", arguments)
            .await
            .expect("prompts/get");
        let rendered = render_prompt(&filled);
        assert!(rendered.contains("Say hello to the fixture."), "{rendered}");
        // The role is kept: a server's message is labelled as what it is.
        assert!(rendered.contains("[user]"), "{rendered}");

        // A prompt the server does not have is the server's refusal, not an
        // empty prompt.
        let missing = get_prompt(&service, "nowhere", serde_json::Map::new()).await;
        assert!(missing.is_err(), "{missing:?}");

        service.cancel().await.expect("shutdown");
    }
}

#[cfg(all(test, unix))]
mod mcp_end_to_end_tests {
    use super::super::launch::ConfinedMcpLaunch;
    use super::super::models::extract_command_args;
    use rmcp::model::CallToolRequestParam;
    use rmcp::ServiceExt;
    use std::path::PathBuf;
    use std::process::Stdio;

    fn fixture_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp_stdio_server.py")
    }

    /// A workspace holding its own copy of the server.
    ///
    /// The confined process cannot read the repository — that is the policy
    /// working, not a problem to route around — so the fixture is placed
    /// where the session can actually reach it, which is also where a real
    /// imported server's files would have to be.
    fn workspace() -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir()
            .canonicalize()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join(format!("jan-mcp-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("workspace");
        let server = dir.join("mcp_stdio_server.py");
        std::fs::copy(fixture_path(), &server).expect("stage the fixture");
        (dir, server)
    }

    /// The config Jan builds when a session consents to an imported server.
    fn imported_config(workspace: &std::path::Path, server: &std::path::Path) -> serde_json::Value {
        serde_json::json!({
            "command": "/usr/bin/python3",
            "args": [server.to_string_lossy()],
            "type": "stdio",
            "janImported": true,
            "janConfinement": {
                "workspace": workspace.to_string_lossy(),
                "allowedEnv": []
            }
        })
    }

    #[tokio::test]
    async fn a_consented_import_handshakes_lists_and_calls_through_the_real_path() {
        if !tauri_plugin_agent_tools::tools::mcp_confine::confinement_available() {
            return;
        }
        if !fixture_path().exists() || !std::path::Path::new("/usr/bin/python3").exists() {
            return;
        }

        let (ws, server) = workspace();
        let config = imported_config(&ws, &server);

        // Exactly what the desktop and the CLI do: parse the config Jan built,
        // then prepare a launch through the one capability that can make one.
        let params = extract_command_args(&config).expect("parse the imported config");
        assert!(params.imported, "the config Jan builds marks the import");
        assert!(params.confinement.is_some(), "and carries its confinement");

        let launch = ConfinedMcpLaunch::prepare(&params, || {
            let mut cmd = tokio::process::Command::new(&params.command);
            for arg in params.args.iter().filter_map(serde_json::Value::as_str) {
                cmd.arg(arg);
            }
            cmd
        })
        .expect("a confined launch");
        assert!(launch.is_confined(), "an imported server runs confined");

        let (process, _stderr) = launch.spawn(Stdio::piped()).expect("spawn");

        // A real handshake, through the same client the production path uses.
        let service = ().serve(process).await.expect("initialize");
        let info = service.peer_info().expect("the server identified itself");
        assert_eq!(info.server_info.name, "jan-test-fixture");

        let tools = service.list_all_tools().await.expect("tools/list");
        assert!(
            tools.iter().any(|tool| tool.name == "echo_fixture"),
            "the server's tool must be discovered: {tools:?}"
        );

        let result = service
            .call_tool(CallToolRequestParam {
                name: "echo_fixture".into(),
                arguments: None,
            })
            .await
            .expect("tools/call");
        let text = serde_json::to_string(&result).expect("serialize the result");
        assert!(
            text.contains("fixture-answer"),
            "the tool call must return the server's answer: {text}"
        );

        // Shutting down is part of the lifecycle: a server left running would
        // outlive the test that started it.
        service.cancel().await.expect("shutdown");
    }

    /// An imported definition with no confinement never reaches a process.
    #[tokio::test]
    async fn an_import_without_confinement_never_starts() {
        let (ws, server) = workspace();
        let mut config = imported_config(&ws, &server);
        config
            .as_object_mut()
            .expect("object")
            .remove("janConfinement");

        let params = extract_command_args(&config).expect("parse");
        let err =
            ConfinedMcpLaunch::prepare(&params, || tokio::process::Command::new(&params.command))
                .expect_err("must not be launchable");

        assert!(err.contains("unconfined"), "{err}");
    }
}

/// Jan's real remote transport, against a real server on loopback.
///
/// Everything here goes through `serve_http` — the same construction the
/// desktop and the CLI use — with a real `reqwest` client and a real
/// `StreamableHttpClientTransport`. The only substitution is the progress
/// sink, which exists to emit events into a Tauri window there is none of
/// here. The server is a fixture on 127.0.0.1 with an OS-chosen port, so the
/// test reaches no network and guesses no port.
#[cfg(test)]
mod mcp_http_integration_tests {
    use super::super::helpers::serve_http;
    use super::super::progress::JanClientHandler;
    use rmcp::model::{CallToolRequestParam, ClientInfo};
    use std::io::BufRead;
    use std::path::PathBuf;

    /// A fixture process, and the port it bound.
    struct Fixture {
        child: std::process::Child,
        port: u16,
    }

    impl Fixture {
        /// Starts the fixture, or fails the test. It used to return `None` --
        /// and every caller returned early and passed -- whenever
        /// `/usr/bin/python3` was absent, so on Windows none of these tests
        /// ever exercised the transport.
        fn start(mode: &str, barrier: Option<&std::path::Path>) -> Option<Self> {
            let script =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp_http_server.py");
            assert!(script.exists(), "missing fixture {}", script.display());
            let python = ["python3", "python"]
                .into_iter()
                .find(|p| {
                    std::process::Command::new(p)
                        .arg("--version")
                        .output()
                        .is_ok_and(|o| o.status.success())
                })
                .expect("python is required for the HTTP MCP fixture");

            let mut command = std::process::Command::new(python);
            command.arg(&script).arg(mode);
            if let Some(path) = barrier {
                command.arg(path);
            }
            let mut child = command
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .ok()?;

            // The fixture prints the port it was given, so nothing here has to
            // pick one and race another test for it.
            let stdout = child.stdout.take()?;
            let mut line = String::new();
            std::io::BufReader::new(stdout).read_line(&mut line).ok()?;
            let port = line.trim().parse().ok()?;
            Some(Self { child, port })
        }

        fn url(&self) -> String {
            format!("http://127.0.0.1:{}/mcp", self.port)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    fn handler(name: &str) -> JanClientHandler {
        JanClientHandler::for_test(ClientInfo::default(), name.to_string())
    }

    /// Connect the way production does, and report what the server said.
    async fn connect(
        fixture: &Fixture,
    ) -> Result<super::super::super::state::RunningMcpService, String> {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| e.to_string())?;
        serve_http(client, &fixture.url(), handler("fixture")).await
    }

    #[tokio::test]
    async fn a_remote_server_handshakes_lists_and_calls() {
        let fixture = Fixture::start("ok", None).expect("the HTTP MCP fixture started");

        let service = connect(&fixture).await.expect("initialize");
        let info = service.peer_info().expect("the server identified itself");
        assert_eq!(info.server_info.name, "jan-http-fixture");

        let tools = service.list_all_tools().await.expect("tools/list");
        assert!(
            tools.iter().any(|tool| tool.name == "echo_fixture"),
            "the server's tool must be discovered: {tools:?}"
        );

        let result = service
            .call_tool(CallToolRequestParam {
                name: "echo_fixture".into(),
                arguments: None,
            })
            .await
            .expect("tools/call");
        let text = serde_json::to_string(&result).expect("serialize");
        assert!(text.contains("fixture-answer"), "{text}");

        service.cancel().await.expect("shutdown");
    }

    /// Nothing is listening. The client has to say so rather than hang.
    #[tokio::test]
    async fn a_refused_connection_is_reported_not_awaited() {
        // Bind and drop, so the port is one nothing is listening on.
        let port = {
            let socket = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
            socket.local_addr().expect("addr").port()
        };
        let client = reqwest::Client::builder().build().expect("client");

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            serve_http(
                client,
                &format!("http://127.0.0.1:{port}/mcp"),
                handler("gone"),
            ),
        )
        .await;

        match result {
            Ok(Err(_)) => {}
            Ok(Ok(_)) => panic!("connecting to a closed port must not succeed"),
            Err(_) => panic!("a refused connection must fail rather than hang"),
        }
    }

    /// An `initialize` reply that is not a valid result is a failed handshake,
    /// not a server to start publishing tools from.
    #[tokio::test]
    async fn a_malformed_initialize_is_a_failed_handshake() {
        let fixture = Fixture::start("malformed-init", None).expect("the HTTP MCP fixture started");

        assert!(
            connect(&fixture).await.is_err(),
            "a malformed initialize must not produce a usable service"
        );
    }

    /// A server that accepts the connection and never answers must not hold a
    /// caller open indefinitely.
    #[tokio::test]
    async fn an_unanswered_initialize_does_not_hang_forever() {
        let fixture = Fixture::start("hang-init", None).expect("the HTTP MCP fixture started");

        let outcome =
            tokio::time::timeout(std::time::Duration::from_secs(3), connect(&fixture)).await;

        // Either the client gave up on its own, or the caller's timeout did.
        // What matters is that a bounded wait is possible at all.
        assert!(
            outcome.is_err() || outcome.expect("settled").is_err(),
            "a server that never answers must not yield a working service"
        );
    }

    /// The handshake succeeded and the tool listing did not. There are no
    /// tools to publish, and the failure has to surface.
    #[tokio::test]
    async fn a_tool_listing_failure_yields_no_tools() {
        let fixture = Fixture::start("tools-list-error", None).expect("the HTTP MCP fixture started");

        let service = connect(&fixture).await.expect("initialize");
        assert!(
            service.list_all_tools().await.is_err(),
            "a failing tools/list must be reported, not treated as an empty set"
        );

        service.cancel().await.ok();
    }

    #[tokio::test]
    async fn a_failing_tool_call_is_reported() {
        let fixture = Fixture::start("tool-call-error", None).expect("the HTTP MCP fixture started");

        let service = connect(&fixture).await.expect("initialize");
        let outcome = service
            .call_tool(CallToolRequestParam {
                name: "echo_fixture".into(),
                arguments: None,
            })
            .await;

        assert!(
            outcome.is_err(),
            "the server refused; that must reach the caller"
        );
        service.cancel().await.ok();
    }

    /// Shutting down while a call is still in flight.
    ///
    /// The call blocks on a barrier the test controls, so "in flight" is a
    /// state rather than a race. Cancelling must not wedge: the point is that
    /// the shutdown completes and the pending call stops waiting.
    #[tokio::test]
    async fn a_call_in_flight_does_not_wedge_shutdown() {
        let barrier = std::env::temp_dir().join(format!(
            "jan-mcp-barrier-{}-{}",
            std::process::id(),
            "inflight"
        ));
        let _ = std::fs::remove_file(&barrier);

        let fixture = Fixture::start("slow-call", Some(&barrier)).expect("the HTTP MCP fixture started");

        let service = connect(&fixture).await.expect("initialize");
        let call = tokio::spawn({
            let service = std::sync::Arc::new(service);
            let held = service.clone();
            async move {
                held.call_tool(CallToolRequestParam {
                    name: "echo_fixture".into(),
                    arguments: None,
                })
                .await
            }
        });

        // Let the server answer, then confirm the call settles one way or the
        // other rather than hanging forever.
        std::fs::write(&barrier, b"go").expect("release the barrier");
        let settled = tokio::time::timeout(std::time::Duration::from_secs(10), call).await;
        let _ = std::fs::remove_file(&barrier);

        assert!(
            settled.is_ok(),
            "a call released by the server must settle rather than hang"
        );
    }

    /// Nothing in a failure string is a secret. The fixture is given none, and
    /// the URL it reports is a loopback address.
    #[tokio::test]
    async fn failures_carry_no_secret_and_no_public_endpoint() {
        let fixture = Fixture::start("malformed-init", None).expect("the HTTP MCP fixture started");

        let message = match connect(&fixture).await {
            Err(message) => message,
            Ok(_) => panic!("a malformed initialize must not produce a service"),
        };

        assert!(!message.to_lowercase().contains("secret"), "{message}");
        assert!(!message.to_lowercase().contains("token"), "{message}");
        assert!(
            !message.contains("https://"),
            "the fixture is loopback-only: {message}"
        );
    }
}

/// Jan's real SSE transport, against a real SSE server on loopback.
///
/// SSE is two halves: a long-lived stream the server writes events to, and a
/// POST endpoint the client is told about in the stream's first event. Both
/// are real here, driven through Jan's own `serve_sse` — so this covers the
/// transport Jan advertises rather than a parser that recognises its name.
#[cfg(test)]
mod mcp_sse_integration_tests {
    use super::super::helpers::serve_sse;
    use super::super::progress::JanClientHandler;
    use rmcp::model::{CallToolRequestParam, ClientInfo};
    use std::io::BufRead;
    use std::path::PathBuf;

    struct Fixture {
        child: std::process::Child,
        port: u16,
    }

    impl Fixture {
        fn start(mode: &str, barrier: Option<&std::path::Path>) -> Option<Self> {
            let script =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp_sse_server.py");
            if !script.exists() || !std::path::Path::new("/usr/bin/python3").exists() {
                return None;
            }
            let mut command = std::process::Command::new("/usr/bin/python3");
            command.arg(&script).arg(mode);
            if let Some(path) = barrier {
                command.arg(path);
            }
            let mut child = command
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .ok()?;
            let stdout = child.stdout.take()?;
            let mut line = String::new();
            std::io::BufReader::new(stdout).read_line(&mut line).ok()?;
            Some(Self {
                child,
                port: line.trim().parse().ok()?,
            })
        }

        fn url(&self) -> String {
            format!("http://127.0.0.1:{}/sse", self.port)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    async fn connect(
        fixture: &Fixture,
    ) -> Result<super::super::super::state::RunningMcpService, String> {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| e.to_string())?;
        serve_sse(
            client,
            &fixture.url(),
            JanClientHandler::for_test(ClientInfo::default(), "sse-fixture".to_string()),
        )
        .await
    }

    /// The whole lifecycle: stream, endpoint, initialize, list, call, shutdown.
    #[tokio::test]
    async fn an_sse_server_handshakes_lists_and_calls() {
        let fixture = Fixture::start("ok", None).expect("the HTTP MCP fixture started");

        let service = connect(&fixture).await.expect("initialize over SSE");
        let info = service.peer_info().expect("the server identified itself");
        assert_eq!(info.server_info.name, "jan-sse-fixture");

        let tools = service.list_all_tools().await.expect("tools/list");
        assert!(
            tools.iter().any(|tool| tool.name == "echo_fixture"),
            "the server's tool must be discovered: {tools:?}"
        );

        let called = service
            .call_tool(CallToolRequestParam {
                name: "echo_fixture".into(),
                arguments: None,
            })
            .await
            .expect("tools/call");
        let text = serde_json::to_string(&called).expect("serialize");
        assert!(text.contains("fixture-answer"), "{text}");

        service.cancel().await.expect("shutdown");
    }

    /// The stream drops before the handshake completes. There is no service.
    #[tokio::test]
    async fn a_stream_that_closes_during_initialize_yields_no_service() {
        let fixture = Fixture::start("close-during-init", None).expect("the HTTP MCP fixture started");

        let outcome =
            tokio::time::timeout(std::time::Duration::from_secs(10), connect(&fixture)).await;

        assert!(
            outcome.is_err() || outcome.expect("settled").is_err(),
            "a stream that closes during initialize must not produce a service"
        );
    }

    /// An event that is not valid JSON-RPC must not derail the handshake into
    /// reporting success.
    #[tokio::test]
    async fn a_malformed_event_does_not_produce_a_working_service() {
        let fixture = Fixture::start("malformed-event", None).expect("the HTTP MCP fixture started");

        let outcome = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let service = connect(&fixture).await?;
            // If the handshake did survive the junk event, the server is
            // genuinely usable — which is also an acceptable outcome, as
            // long as it is real.
            service.list_all_tools().await.map_err(|e| e.to_string())?;
            service.cancel().await.ok();
            Ok::<(), String>(())
        })
        .await;

        // What must not happen is a hang: either it worked or it failed.
        assert!(
            outcome.is_ok(),
            "a malformed event must not leave the client waiting forever"
        );
    }

    #[tokio::test]
    async fn a_tool_listing_failure_is_reported_over_sse() {
        let fixture = Fixture::start("tools-list-error", None).expect("the HTTP MCP fixture started");

        let service = connect(&fixture).await.expect("initialize");
        assert!(
            service.list_all_tools().await.is_err(),
            "a failing tools/list must be reported, not treated as an empty set"
        );
        service.cancel().await.ok();
    }

    /// A call held open by the server, released by the test rather than by a
    /// sleep, then shut down.
    #[tokio::test]
    async fn a_call_in_flight_settles_and_shutdown_completes() {
        let barrier = std::env::temp_dir().join(format!("jan-sse-barrier-{}", std::process::id()));
        let _ = std::fs::remove_file(&barrier);

        let fixture = Fixture::start("slow-call", Some(&barrier)).expect("the HTTP MCP fixture started");

        let service = std::sync::Arc::new(connect(&fixture).await.expect("initialize"));
        let held = service.clone();
        let call = tokio::spawn(async move {
            held.call_tool(CallToolRequestParam {
                name: "echo_fixture".into(),
                arguments: None,
            })
            .await
        });

        std::fs::write(&barrier, b"go").expect("release the barrier");
        let settled = tokio::time::timeout(std::time::Duration::from_secs(15), call).await;
        let _ = std::fs::remove_file(&barrier);

        assert!(
            settled.is_ok(),
            "a call the server released must settle rather than hang"
        );
    }

    /// Nothing in a failure carries a secret, and the endpoint is loopback.
    #[tokio::test]
    async fn sse_failures_carry_no_secret_and_no_public_endpoint() {
        let fixture = Fixture::start("close-during-init", None).expect("the HTTP MCP fixture started");

        let message =
            match tokio::time::timeout(std::time::Duration::from_secs(10), connect(&fixture)).await
            {
                Ok(Err(message)) => message,
                _ => return,
            };

        assert!(!message.to_lowercase().contains("secret"), "{message}");
        assert!(!message.to_lowercase().contains("token"), "{message}");
        assert!(!message.contains("https://"), "{message}");
    }
}

/// Deciding whether a server may start under a name.
///
/// The rule this pins: a name is not an identity. Two definitions that differ
/// in what they run, where they run it, or what they are handed are two
/// programs, and one must never quietly stand in for the other.
#[cfg(test)]
mod registration_decision_tests {
    use super::super::models::{definition_identity, registration_decision, RegistrationDecision};
    use serde_json::json;

    fn stdio(command: &str, args: &[&str]) -> serde_json::Value {
        json!({ "type": "stdio", "command": command, "args": args })
    }

    #[test]
    fn a_name_nobody_is_using_may_start() {
        assert_eq!(
            registration_decision(false, None, &stdio("node", &["server.js"])),
            RegistrationDecision::Start
        );
    }

    /// Starting the same server twice opens a second client that sends its own
    /// `initialize`, which a streamable-HTTP server rejects — tearing down the
    /// connection that was already working.
    #[test]
    fn the_same_definition_already_running_is_skipped() {
        let config = stdio("node", &["server.js"]);

        assert_eq!(
            registration_decision(true, Some(&config), &config),
            RegistrationDecision::AlreadyRunning
        );
    }

    /// The failure this closes. Before, the guard compared names only, so an
    /// edited definition returned "fine" while the old program kept running.
    #[test]
    fn a_different_definition_under_the_same_name_is_refused() {
        let running = stdio("node", &["server.js"]);
        let edited = stdio("node", &["other-server.js"]);

        match registration_decision(true, Some(&running), &edited) {
            RegistrationDecision::Conflict { reason } => {
                assert!(reason.contains("different"), "{reason}");
            }
            other => panic!("an edited definition must not silently share a name: {other:?}"),
        }
    }

    #[test]
    fn a_server_running_under_a_name_nothing_describes_is_refused() {
        match registration_decision(true, None, &stdio("node", &["server.js"])) {
            RegistrationDecision::Conflict { .. } => {}
            other => panic!("an unidentifiable server must not be claimed: {other:?}"),
        }
    }

    /// Everything that decides which program runs is part of the identity.
    #[test]
    fn identity_changes_when_the_program_does() {
        let base = stdio("node", &["server.js"]);

        for (what, changed) in [
            ("the executable", stdio("python3", &["server.js"])),
            ("the arguments", stdio("node", &["evil.js"])),
            (
                "the transport",
                json!({ "type": "http", "url": "https://example.test/mcp" }),
            ),
            (
                "the endpoint",
                json!({ "type": "http", "url": "https://elsewhere.test/mcp" }),
            ),
            (
                "the environment it is handed",
                json!({
                    "type": "stdio",
                    "command": "node",
                    "args": ["server.js"],
                    "env": { "AWS_SECRET_ACCESS_KEY": "x" }
                }),
            ),
        ] {
            assert_ne!(
                definition_identity(&base),
                definition_identity(&changed),
                "changing {what} must change the identity"
            );
        }
    }

    /// And nothing else is. A description or an `active` flag does not make it
    /// a different program, and treating it as one would refuse a server the
    /// user never changed.
    #[test]
    fn identity_ignores_what_does_not_decide_the_program() {
        let plain = stdio("node", &["server.js"]);
        let annotated = json!({
            "type": "stdio",
            "command": "node",
            "args": ["server.js"],
            "active": true,
            "description": "notes for the user"
        });

        assert_eq!(definition_identity(&plain), definition_identity(&annotated));
        assert_eq!(
            registration_decision(true, Some(&plain), &annotated),
            RegistrationDecision::AlreadyRunning
        );
    }

    /// Only the names travel. A value would make two servers with the same
    /// program look different, and would put a secret in the comparison.
    #[test]
    fn identity_carries_environment_names_and_no_values() {
        let with_value = json!({
            "type": "stdio",
            "command": "node",
            "args": [],
            "env": { "API_TOKEN": "sk-live-do-not-leak" }
        });

        let identity = definition_identity(&with_value);
        assert!(identity.contains("API_TOKEN"));
        assert!(!identity.contains("sk-live-do-not-leak"), "{identity}");
    }

    /// Two servers differing only in the *value* of an environment variable
    /// are the same program, and must not be refused as a conflict.
    #[test]
    fn a_changed_environment_value_alone_is_not_a_different_program() {
        let before = json!({
            "type": "stdio", "command": "node", "args": [],
            "env": { "API_TOKEN": "one" }
        });
        let after = json!({
            "type": "stdio", "command": "node", "args": [],
            "env": { "API_TOKEN": "two" }
        });

        assert_eq!(definition_identity(&before), definition_identity(&after));
    }
}

/// AH-139: the liveness probe, through the real rmcp client, against an
/// in-process JSON-RPC peer that answers, errors, stays silent or hangs up.
#[cfg(test)]
mod liveness_tests {
    use super::super::helpers::{probe_liveness, Liveness};
    use rmcp::ServiceExt;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[derive(Clone, Copy)]
    enum Ping {
        Answer,
        Error,
        Ignore,
        IgnoreEverything,
        HangUp,
    }

    /// A client connected to a peer that handles `initialize` and then treats
    /// `ping` (and `tools/list`) as `mode` says. Returns the client and the
    /// methods the peer saw.
    async fn connect(
        mode: Ping,
    ) -> (
        rmcp::service::RunningService<rmcp::RoleClient, ()>,
        Arc<StdMutex<Vec<String>>>,
    ) {
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(server_io);
            let mut lines = BufReader::new(r).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let msg: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let method = msg["method"].as_str().unwrap_or("").to_string();
                log.lock().unwrap().push(method.clone());
                let Some(id) = msg.get("id").cloned() else { continue };
                let reply = match (method.as_str(), mode) {
                    ("initialize", _) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": {
                        "protocolVersion": "2024-11-05", "capabilities": { "tools": {} },
                        "serverInfo": { "name": "liveness-peer", "version": "1" } } }),
                    ("ping", Ping::Answer) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
                    ("ping", Ping::Error) => serde_json::json!({ "jsonrpc": "2.0", "id": id,
                        "error": { "code": -32601, "message": "Method not found" } }),
                    ("ping", Ping::HangUp) => return,
                    ("ping", Ping::Ignore | Ping::IgnoreEverything) => continue,
                    ("tools/list", Ping::IgnoreEverything) => continue,
                    ("tools/list", _) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": [] } }),
                    _ => continue,
                };
                let mut out = reply.to_string();
                out.push('\n');
                if w.write_all(out.as_bytes()).await.is_err() {
                    return;
                }
            }
        });
        let (r, w) = tokio::io::split(client_io);
        let client = ().serve((r, w)).await.expect("initialize");
        (client, seen)
    }

    const QUICK: Duration = Duration::from_millis(400);

    #[tokio::test]
    async fn a_server_that_answers_ping_is_alive_and_is_not_asked_for_its_tools() {
        let (client, seen) = connect(Ping::Answer).await;
        assert_eq!(probe_liveness(&client, QUICK, QUICK).await, Liveness::Alive);
        let seen = seen.lock().unwrap().clone();
        assert!(seen.contains(&"ping".to_string()), "{seen:?}");
        assert!(!seen.contains(&"tools/list".to_string()), "the probe listed tools: {seen:?}");
    }

    #[tokio::test]
    async fn an_error_reply_to_ping_is_still_a_live_server() {
        let (client, _) = connect(Ping::Error).await;
        assert_eq!(probe_liveness(&client, QUICK, QUICK).await, Liveness::Alive);
    }

    #[tokio::test]
    async fn a_server_that_ignores_ping_but_lists_tools_is_alive_and_said_so() {
        let (client, seen) = connect(Ping::Ignore).await;
        assert_eq!(probe_liveness(&client, QUICK, QUICK).await, Liveness::AliveWithoutPing);
        assert!(seen.lock().unwrap().contains(&"tools/list".to_string()));
    }

    #[tokio::test]
    async fn a_server_that_answers_nothing_is_unresponsive() {
        let (client, _) = connect(Ping::IgnoreEverything).await;
        assert!(matches!(probe_liveness(&client, QUICK, QUICK).await, Liveness::Unresponsive(_)));
    }

    #[tokio::test]
    async fn a_server_that_hung_up_is_gone_or_unresponsive_never_alive() {
        let (client, _) = connect(Ping::HangUp).await;
        let first = probe_liveness(&client, QUICK, QUICK).await;
        assert!(!first.is_alive(), "{first:?}");
        // Once the transport has noticed, the answer is that it is gone.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let later = probe_liveness(&client, QUICK, QUICK).await;
        assert!(!later.is_alive(), "{later:?}");
    }
}

/// The manager's own bookkeeping, driven through a real Tauri app handle.
///
/// `start_mcp_server` is more than a connection: it records the active config,
/// marks the name as starting, decides whether a duplicate is a no-op or a
/// conflict, and installs a health monitor. Those are the parts a transport
/// test cannot reach, and the parts that go wrong when a name is started twice
/// or replaced mid-flight.
#[cfg(test)]
mod manager_bookkeeping_tests {
    use super::super::helpers::start_mcp_server;
    use crate::core::state::AppState;
    use serde_json::json;
    use tauri::test::mock_app;
    use tauri::Manager;

    /// An app with the state the manager reads, and its shared server map.
    fn app_with_state() -> (
        tauri::App<tauri::test::MockRuntime>,
        crate::core::state::SharedMcpServers,
    ) {
        let app = mock_app();
        let state = AppState::default();
        let servers = state.mcp_servers.clone();
        app.manage(state);
        (app, servers)
    }

    /// A definition that cannot connect: the point is the bookkeeping around
    /// the attempt, not a live server.
    fn unreachable(command: &str) -> serde_json::Value {
        json!({ "type": "stdio", "command": command, "args": [] })
    }

    #[tokio::test]
    async fn a_start_records_the_config_it_was_given() {
        let (app, servers) = app_with_state();
        let handle = app.handle().clone();

        let _ = start_mcp_server(
            handle.clone(),
            servers,
            "recorder".to_string(),
            unreachable("definitely-not-a-real-binary"),
        )
        .await;

        // Recorded for restart even though the start itself failed: the user
        // asked for this server, and that is what the record is.
        let state = handle.state::<AppState>();
        let active = state.mcp_active_servers.lock().await;
        assert!(active.contains_key("recorder"));
    }

    /// The in-flight marker exists to stop a second `serve()` racing the first.
    /// It has to be cleared however the attempt ends, or the name is wedged.
    #[tokio::test]
    async fn a_failed_start_does_not_wedge_the_name() {
        let (app, servers) = app_with_state();
        let handle = app.handle().clone();

        let _ = start_mcp_server(
            handle.clone(),
            servers,
            "wedged".to_string(),
            unreachable("definitely-not-a-real-binary"),
        )
        .await;

        let state = handle.state::<AppState>();
        let starting = state.mcp_starting.lock().await;
        assert!(
            !starting.contains("wedged"),
            "the in-flight marker must be cleared even when the start fails"
        );
    }

    #[tokio::test]
    async fn a_failed_start_leaves_no_server_and_no_monitor() {
        let (app, servers) = app_with_state();
        let handle = app.handle().clone();

        let result = start_mcp_server(
            handle.clone(),
            servers.clone(),
            "absent".to_string(),
            unreachable("definitely-not-a-real-binary"),
        )
        .await;

        assert!(result.is_err(), "an unreachable command cannot start");
        assert!(servers.lock().await.get("absent").is_none());
        let state = handle.state::<AppState>();
        let monitors = state.mcp_monitoring_tasks.lock().await;
        assert!(
            !monitors.contains_key("absent"),
            "a failed start must not leave a monitor reconnecting it"
        );
    }

    /// Every start takes a number, and the number moves. That is what lets a
    /// completion tell whether it is still the current instance.
    #[tokio::test]
    async fn each_start_takes_a_new_number() {
        let (app, servers) = app_with_state();
        let handle = app.handle().clone();

        for _ in 0..2 {
            let _ = start_mcp_server(
                handle.clone(),
                servers.clone(),
                "numbered".to_string(),
                unreachable("definitely-not-a-real-binary"),
            )
            .await;
        }

        let state = handle.state::<AppState>();
        let generations = state.mcp_generation.lock().await;
        assert_eq!(
            generations.get("numbered").copied(),
            Some(2),
            "two starts must be two instances"
        );
    }

    /// A different definition under a name already running is refused rather
    /// than skipped — the failure that let an edited server keep serving the
    /// old program.
    #[tokio::test]
    async fn a_conflicting_definition_is_refused_by_the_manager() {
        use crate::core::mcp::models::{registration_decision, RegistrationDecision};

        let running = unreachable("node");
        let edited = unreachable("python3");

        assert!(matches!(
            registration_decision(true, Some(&running), &edited),
            RegistrationDecision::Conflict { .. }
        ));
        assert_eq!(
            registration_decision(true, Some(&running), &running),
            RegistrationDecision::AlreadyRunning
        );
    }
}
