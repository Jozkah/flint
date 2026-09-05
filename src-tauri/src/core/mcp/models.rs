use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How a server imported from repository configuration must be confined.
///
/// Present only on a server Jan imported from a repository's own
/// configuration. A server the user configured themselves carries `None` and
/// keeps the behaviour it has always had — they chose the program, and
/// confining it would break the ordinary case for no gain in trust.
///
/// When it *is* present it is not advisory. A confinement that cannot be
/// built means the server does not start, because the alternative is running
/// a program a repository chose with the user's whole filesystem in reach.
#[derive(Debug, Clone)]
pub struct McpConfinement {
    /// The session workspace: readable and writable.
    pub workspace: std::path::PathBuf,
    /// The attached repository, readable.
    pub repository: Option<std::path::PathBuf>,
    /// Writable, when the session holds a live direct-edit grant for it.
    pub writable_repository: Option<std::path::PathBuf>,
    /// Jan's data folder, hidden from the server.
    pub jan_data: Option<std::path::PathBuf>,
    /// Environment names the user approved. Nothing else is passed through.
    pub allowed_env: Vec<String>,
}

/// Configuration parameters extracted from MCP server config
#[derive(Debug, Clone)]
pub struct McpServerConfig {
    pub transport_type: Option<String>,
    pub url: Option<String>,
    pub command: String,
    pub args: Vec<Value>,
    pub envs: serde_json::Map<String, Value>,
    pub timeout: Option<Duration>,
    pub headers: serde_json::Map<String, Value>,
    /// Set for an imported server; `None` for one the user configured.
    pub confinement: Option<McpConfinement>,
    /// Did this definition come from a repository rather than from the user?
    ///
    /// Carried separately from [`Self::confinement`] so the two can disagree,
    /// which is the whole point: an imported server with no confinement is a
    /// programming error, and it must fail closed rather than start.
    pub imported: bool,
}

/// Parse a raw `mcp_config.json` server entry into typed connection params.
pub fn extract_command_args(config: &Value) -> Option<McpServerConfig> {
    let obj = config.as_object()?;
    let command = obj.get("command")?.as_str()?.to_string();
    let args = obj.get("args")?.as_array()?.clone();
    let url = obj.get("url").and_then(|u| u.as_str()).map(String::from);
    let transport_type = obj.get("type").and_then(|t| t.as_str()).map(String::from);
    let timeout = obj
        .get("timeout")
        .and_then(|t| t.as_u64())
        .map(Duration::from_secs);
    let headers = obj
        .get("headers")
        .unwrap_or(&Value::Object(serde_json::Map::new()))
        .as_object()?
        .clone();
    let envs = obj
        .get("env")
        .unwrap_or(&Value::Object(serde_json::Map::new()))
        .as_object()?
        .clone();
    Some(McpServerConfig {
        timeout,
        transport_type,
        url,
        command,
        args,
        envs,
        headers,
        // Not read from the repository's own file: Jan writes these onto the
        // config it builds when a session activates an imported server. A
        // `.mcp.json` never reaches this function verbatim — the importer
        // emits only command, args, env, type and url — so a repository
        // cannot describe its own sandbox or declare itself trusted.
        confinement: parse_confinement(obj),
        imported: obj
            .get("janImported")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// Read the confinement Jan attached when a session activated this server.
fn parse_confinement(obj: &serde_json::Map<String, Value>) -> Option<McpConfinement> {
    let value = obj.get("janConfinement")?.as_object()?;
    let path = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(std::path::PathBuf::from)
    };
    Some(McpConfinement {
        workspace: path("workspace")?,
        repository: path("repository"),
        writable_repository: path("writableRepository"),
        jan_data: path("janData"),
        allowed_env: value
            .get("allowedEnv")
            .and_then(Value::as_array)
            .map(|names| {
                names
                    .iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

pub fn extract_active_status(config: &Value) -> Option<bool> {
    let obj = config.as_object()?;
    let active = obj.get("active")?.as_bool()?;
    Some(active)
}

fn default_tool_call_timeout_seconds() -> u64 {
    super::constants::DEFAULT_MCP_TOOL_CALL_TIMEOUT_SECS
}

fn default_base_restart_delay_ms() -> u64 {
    super::constants::DEFAULT_MCP_BASE_RESTART_DELAY_MS
}

fn default_max_restart_delay_ms() -> u64 {
    super::constants::DEFAULT_MCP_MAX_RESTART_DELAY_MS
}

fn default_backoff_multiplier() -> f64 {
    super::constants::DEFAULT_MCP_BACKOFF_MULTIPLIER
}

fn default_enable_smart_tool_routing() -> bool {
    true
}

fn default_use_lightweight_router_model() -> bool {
    false
}

fn default_router_model_provider() -> String {
    String::new()
}

fn default_router_model_id() -> String {
    String::new()
}

fn default_max_tool_output_chars() -> u64 {
    super::constants::DEFAULT_MCP_MAX_TOOL_OUTPUT_CHARS
}

/// Runtime MCP settings that can be adjusted via UI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    #[serde(default = "default_tool_call_timeout_seconds")]
    pub tool_call_timeout_seconds: u64,
    #[serde(default = "default_base_restart_delay_ms")]
    pub base_restart_delay_ms: u64,
    #[serde(default = "default_max_restart_delay_ms")]
    pub max_restart_delay_ms: u64,
    #[serde(default = "default_backoff_multiplier")]
    pub backoff_multiplier: f64,
    #[serde(default = "default_enable_smart_tool_routing")]
    pub enable_smart_tool_routing: bool,
    #[serde(default = "default_use_lightweight_router_model")]
    pub use_lightweight_router_model: bool,
    #[serde(default = "default_router_model_provider")]
    pub router_model_provider: String,
    #[serde(default = "default_router_model_id")]
    pub router_model_id: String,
    /// Per-tool-result character cap; `0` disables it.
    #[serde(default = "default_max_tool_output_chars")]
    pub max_tool_output_chars: u64,
}

impl Default for McpSettings {
    fn default() -> Self {
        Self {
            tool_call_timeout_seconds: super::constants::DEFAULT_MCP_TOOL_CALL_TIMEOUT_SECS,
            base_restart_delay_ms: super::constants::DEFAULT_MCP_BASE_RESTART_DELAY_MS,
            max_restart_delay_ms: super::constants::DEFAULT_MCP_MAX_RESTART_DELAY_MS,
            backoff_multiplier: super::constants::DEFAULT_MCP_BACKOFF_MULTIPLIER,
            enable_smart_tool_routing: true,
            use_lightweight_router_model: false,
            router_model_provider: String::new(),
            router_model_id: String::new(),
            max_tool_output_chars: super::constants::DEFAULT_MCP_MAX_TOOL_OUTPUT_CHARS,
        }
    }
}

impl McpSettings {
    /// Returns the tool call timeout duration, enforcing a minimum of 1 second to avoid zero-duration timeouts.
    pub fn tool_call_timeout_duration(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.tool_call_timeout_seconds.max(1))
    }

    /// Effective per-tool-result character cap. `0` means uncapped.
    ///
    /// `override_chars` is the caller's own budget - the desktop chat derives one
    /// from the active model's context window, which the backend cannot see. The
    /// tighter of the two wins. A user setting of `0` disables capping outright,
    /// and an absent or `0` override simply leaves the setting in charge.
    pub fn tool_output_cap(&self, override_chars: Option<u64>) -> u64 {
        if self.max_tool_output_chars == 0 {
            return 0;
        }
        match override_chars {
            Some(o) if o > 0 => o.min(self.max_tool_output_chars),
            _ => self.max_tool_output_chars,
        }
    }
}

/// Tool with server information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolWithServer {
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "inputSchema")]
    pub input_schema: serde_json::Value,
    pub server: String,
}

/// Lightweight server metadata used by the frontend orchestrator for tool routing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSummary {
    pub name: String,
    pub capabilities: Vec<String>,
    pub description: String,
}

#[cfg(test)]
mod tests {
    use super::{extract_active_status, extract_command_args};
    use std::time::Duration;

    #[test]
    fn test_extract_command_args_minimal_config() {
        let cfg = serde_json::json!({
            "command": "npx",
            "args": ["-y", "server"]
        });
        let parsed = extract_command_args(&cfg).expect("should parse");
        assert_eq!(parsed.command, "npx");
        assert_eq!(parsed.args.len(), 2);
        assert_eq!(parsed.args[0], "-y");
        assert!(parsed.url.is_none());
        assert!(parsed.transport_type.is_none());
        assert!(parsed.timeout.is_none());
        assert!(parsed.envs.is_empty());
        assert!(parsed.headers.is_empty());
    }

    #[test]
    fn test_extract_command_args_full_config() {
        let cfg = serde_json::json!({
            "command": "",
            "args": [],
            "type": "http",
            "url": "https://mcp.example.com/mcp",
            "timeout": 45,
            "env": {"API_KEY": "abc", "DEBUG": "1"},
            "headers": {"Authorization": "Bearer xyz"}
        });
        let parsed = extract_command_args(&cfg).expect("should parse");
        assert_eq!(parsed.command, "");
        assert_eq!(parsed.transport_type.as_deref(), Some("http"));
        assert_eq!(parsed.url.as_deref(), Some("https://mcp.example.com/mcp"));
        assert_eq!(parsed.timeout, Some(Duration::from_secs(45)));
        assert_eq!(
            parsed.envs.get("API_KEY").and_then(|v| v.as_str()),
            Some("abc")
        );
        assert_eq!(parsed.envs.get("DEBUG").and_then(|v| v.as_str()), Some("1"));
        assert_eq!(
            parsed.headers.get("Authorization").and_then(|v| v.as_str()),
            Some("Bearer xyz")
        );
    }

    #[test]
    fn test_extract_command_args_returns_none_when_required_fields_missing() {
        // Missing command
        let cfg = serde_json::json!({"args": []});
        assert!(extract_command_args(&cfg).is_none());
        // Missing args
        let cfg = serde_json::json!({"command": "npx"});
        assert!(extract_command_args(&cfg).is_none());
        // Not an object
        let cfg = serde_json::json!(["a", "b"]);
        assert!(extract_command_args(&cfg).is_none());
        // command not a string
        let cfg = serde_json::json!({"command": 123, "args": []});
        assert!(extract_command_args(&cfg).is_none());
        // args not an array
        let cfg = serde_json::json!({"command": "npx", "args": "oops"});
        assert!(extract_command_args(&cfg).is_none());
    }

    #[test]
    fn test_extract_command_args_parses_default_mcp_config_servers() {
        use crate::core::mcp::constants::DEFAULT_MCP_CONFIG;
        let value: serde_json::Value = serde_json::from_str(DEFAULT_MCP_CONFIG).unwrap();
        for (name, cfg) in value["mcpServers"].as_object().unwrap() {
            let parsed = extract_command_args(cfg)
                .unwrap_or_else(|| panic!("default config server '{name}' should parse"));
            // command may be empty for HTTP transports
            if name == "exa" {
                assert_eq!(parsed.transport_type.as_deref(), Some("http"));
                assert!(parsed.url.is_some());
            } else {
                assert!(!parsed.command.is_empty(), "{name} should have a command");
            }
        }
    }

    #[test]
    fn test_extract_active_status_variants() {
        assert_eq!(
            extract_active_status(&serde_json::json!({"active": true})),
            Some(true)
        );
        assert_eq!(
            extract_active_status(&serde_json::json!({"active": false})),
            Some(false)
        );
        // Missing
        assert_eq!(extract_active_status(&serde_json::json!({})), None);
        // Wrong type
        assert_eq!(
            extract_active_status(&serde_json::json!({"active": "yes"})),
            None
        );
        // Not an object
        assert_eq!(extract_active_status(&serde_json::json!(true)), None);
    }
}
