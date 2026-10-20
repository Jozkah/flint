// Default MCP runtime settings
pub const DEFAULT_MCP_TOOL_CALL_TIMEOUT_SECS: u64 = 30;

/// Per-tool-result character cap applied before the result enters conversation
/// history. A single unbounded result (a full browser page snapshot, say) can
/// otherwise consume the whole model context. Roughly 12k tokens at ~3.5
/// chars/token: large enough for a real page, small enough to leave room for
/// the conversation. `0` disables the cap.
pub const DEFAULT_MCP_MAX_TOOL_OUTPUT_CHARS: u64 = 40_000;

// Browser MCP teardown: how long to wait for the port to free, and the poll cadence.
pub const MCP_PORT_FREE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(2000);
pub const MCP_PORT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
pub const DEFAULT_MCP_BASE_RESTART_DELAY_MS: u64 = 1000; // Start with 1 second
pub const DEFAULT_MCP_MAX_RESTART_DELAY_MS: u64 = 30000; // Cap at 30 seconds
pub const DEFAULT_MCP_BACKOFF_MULTIPLIER: f64 = 2.0; // Double the delay each time

pub const DEFAULT_MCP_CONFIG: &str = r#"{
  "mcpServers": {},
  "mcpSettings": {
    "toolCallTimeoutSeconds": 30,
    "baseRestartDelayMs": 1000,
    "maxRestartDelayMs": 30000,
    "backoffMultiplier": 2.0,
    "enableSmartToolRouting": true,
    "useLightweightRouterModel": false,
    "routerModelProvider": "",
    "routerModelId": "",
    "maxToolOutputChars": 40000
  }
}"#;

/// The config written when none exists yet.
pub fn default_mcp_config() -> String {
    DEFAULT_MCP_CONFIG.to_string()
}
