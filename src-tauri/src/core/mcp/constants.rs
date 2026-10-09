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
  "mcpServers": {
    "Jan Browser MCP": {
      "command": "npx",
      "args": ["-y", "search-mcp-server@latest"],
      "env": {
        "BRIDGE_HOST": "127.0.0.1",
        "BRIDGE_PORT": "17389"
      },
      "active": false,
      "official": true
    },
    "browsermcp": {
      "command": "npx",
      "args": ["@browsermcp/mcp"],
      "env": {},
      "active": false
    },
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"],
      "env": {},
      "active": false
    },
    "duckduckgo": {
      "command": "uvx",
      "args": [
        "duckduckgo-mcp-server",
        "--transport",
        "streamable-http",
        "--host",
        "127.0.0.1",
        "--port",
        "8000"
      ],
      "env": {},
      "active": false
    },
    "serper": {
      "command": "npx",
      "args": ["-y", "serper-search-scrape-mcp-server"],
      "env": { "SERPER_API_KEY": "YOUR_SERPER_API_KEY_HERE" },
      "active": false
    },
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/path/to/other/allowed/dir"
      ],
      "env": {},
      "active": false
    },
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      "env": {},
      "active": false
    }
  },
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

/// Placeholder directory the shipped `filesystem` entry carries.
pub const DEFAULT_FILESYSTEM_PLACEHOLDER_DIR: &str = "/path/to/other/allowed/dir";

/// `DEFAULT_MCP_CONFIG` with the filesystem server's placeholder directory
/// swapped for the user's home folder, so the entry points at a real path
/// once the user enables it. Falls back to the raw config without a home dir.
pub fn default_mcp_config() -> String {
    match dirs::home_dir().and_then(|h| h.to_str().map(str::to_owned)) {
        Some(home) => {
            let escaped = serde_json::to_string(&home).unwrap_or_default();
            let escaped = escaped.trim_matches('"');
            DEFAULT_MCP_CONFIG.replace(DEFAULT_FILESYSTEM_PLACEHOLDER_DIR, escaped)
        }
        None => DEFAULT_MCP_CONFIG.to_string(),
    }
}
