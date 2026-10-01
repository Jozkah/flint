use std::collections::HashMap;
#[cfg(not(feature = "cli"))]
use std::collections::HashSet;
use std::sync::Arc;

#[cfg(not(feature = "cli"))]
use crate::core::mcp::models::{McpSettings, ToolWithServer};
#[cfg(not(feature = "cli"))]
use crate::core::mcp::progress::JanClientHandler;
#[cfg(feature = "cli")]
use rmcp::model::{CallToolRequestParams, CallToolResult, InitializeRequestParams, Tool};
#[cfg(feature = "cli")]
use rmcp::ServiceError;
use rmcp::{service::RunningService, RoleClient};
use tokio::sync::Mutex;
#[cfg(not(feature = "cli"))]
use tokio::sync::{oneshot, Notify};

/// Server handle type for managing the proxy server lifecycle
#[cfg(not(feature = "cli"))]
pub type ServerHandle =
    tokio::task::JoinHandle<Result<(), Box<dyn std::error::Error + Send + Sync>>>;

/// Provider configuration for remote model providers
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ProviderConfig {
    pub provider: String,
    /// First key (mirrors `api_keys[0]` when populated); kept for backward compatibility.
    pub api_key: Option<String>,
    /// Ordered keys for Bearer auth: proxy tries each on 401/403/429.
    #[serde(default)]
    pub api_keys: Vec<String>,
    pub base_url: Option<String>,
    pub custom_headers: Vec<ProviderCustomHeader>,
    pub models: Vec<String>,
    /// Upstream wire API this provider speaks. `None`/`"openai"` = OpenAI
    /// chat/completions (verbatim passthrough). Other values select a
    /// translating converter (e.g. `"openai-responses"`, `"google"`,
    /// `"anthropic"`) so the proxy can accept OpenAI-shaped requests and talk
    /// the provider's native API.
    #[serde(default)]
    pub api_type: Option<String>,
    /// Whether credentials kept outside this config -- the auth credential
    /// store, the OS keyring, account (OAuth) tokens -- may be attached to
    /// requests for it. Never persisted: it is decided afresh each time the
    /// configs are layered, from where this entry's `base_url` came from.
    #[serde(skip)]
    pub stored_credentials: StoredCredentials,
}

/// Provenance of a provider entry's endpoint, as far as credentials stored
/// under the provider's name are concerned. A provider name alone never
/// authorizes attaching a stored secret: a project's `agent.toml` can reuse
/// any name and point it anywhere (Jozkah/jan#60).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum StoredCredentials {
    /// The endpoint's provenance is unknown or project-supplied: only keys
    /// written inline in this very config are sent. The default, so an entry
    /// nobody vouched for fails closed.
    #[default]
    Withheld,
    /// The endpoint is one the user configured (global config, Desktop, a
    /// CLI override) or a project override naming that same endpoint.
    Allowed,
}

/// Whether two provider base URLs name the same endpoint. Both must parse as
/// absolute URLs with a host. Scheme and host case, a default port written
/// out, and one trailing slash on the path are ignored; everything else --
/// user info, port, path, query, fragment -- must match exactly. There is no
/// prefix, suffix or substring matching.
pub fn same_endpoint(a: &str, b: &str) -> bool {
    fn normalized(raw: &str) -> Option<url::Url> {
        let mut url = url::Url::parse(raw.trim()).ok()?;
        if url.cannot_be_a_base() || url.host_str().is_none() {
            return None;
        }
        if let Some(path) = url.path().strip_suffix('/').map(str::to_string) {
            url.set_path(&path);
        }
        Some(url)
    }
    matches!((normalized(a), normalized(b)), (Some(a), Some(b)) if a == b)
}

impl ProviderConfig {
    /// The one rule every stored-credential path consults before attaching a
    /// secret it did not find inline in this config.
    pub fn may_use_stored_credentials(&self) -> bool {
        self.stored_credentials == StoredCredentials::Allowed
    }

    pub fn bearer_key_chain(&self) -> Vec<String> {
        if !self.api_keys.is_empty() {
            return self.api_keys.clone();
        }
        self.api_key.clone().into_iter().collect()
    }

    /// The config as it may leave the backend: no keys, and no value of a
    /// header marked secret. janhq/jan#8208.
    pub fn without_secrets(&self) -> Self {
        Self {
            api_key: None,
            api_keys: Vec::new(),
            custom_headers: self
                .custom_headers
                .iter()
                .map(|h| ProviderCustomHeader {
                    value: if h.secret { String::new() } else { h.value.clone() },
                    ..h.clone()
                })
                .collect(),
            ..self.clone()
        }
    }
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ProviderCustomHeader {
    pub header: String,
    pub value: String,
    /// The value is a credential: kept out of anything the backend returns or
    /// logs. janhq/jan#8208.
    #[serde(default)]
    pub secret: bool,
}

/// Every connection uses the same handler, so that progress notifications are
/// observed at all -- rmcp drops them on the `()` handler. Desktop-only: the
/// handler emits through a Tauri `AppHandle`, which the CLI build doesn't have.
#[cfg(not(feature = "cli"))]
pub type RunningMcpService = RunningService<RoleClient, JanClientHandler>;
#[cfg(not(feature = "cli"))]
pub type SharedMcpServers = Arc<Mutex<HashMap<String, RunningMcpService>>>;

/// CLI's MCP client has no progress-notification sink, so it can use either
/// the plain handler or one seeded with an `initialize` response.
#[cfg(feature = "cli")]
pub enum RunningServiceEnum {
    NoInit(RunningService<RoleClient, ()>),
    WithInit(RunningService<RoleClient, InitializeRequestParams>),
}
#[cfg(feature = "cli")]
pub type SharedMcpServers = Arc<Mutex<HashMap<String, RunningServiceEnum>>>;

#[cfg(feature = "cli")]
impl RunningServiceEnum {
    /// The prompts this server offers (AH-138). Paginated listings are
    /// followed to the end, the same way tools are.
    pub async fn list_all_prompts(&self) -> Result<Vec<rmcp::model::Prompt>, ServiceError> {
        match self {
            Self::NoInit(s) => s.list_all_prompts().await,
            Self::WithInit(s) => s.list_all_prompts().await,
        }
    }

    /// One prompt, filled in with the server's own arguments (AH-138).
    pub async fn get_prompt(
        &self,
        param: rmcp::model::GetPromptRequestParams,
    ) -> Result<rmcp::model::GetPromptResult, ServiceError> {
        match self {
            Self::NoInit(s) => s.get_prompt(param).await,
            Self::WithInit(s) => s.get_prompt(param).await,
        }
    }

    pub async fn list_all_tools(&self) -> Result<Vec<Tool>, ServiceError> {
        match self {
            Self::NoInit(s) => s.list_all_tools().await,
            Self::WithInit(s) => s.list_all_tools().await,
        }
    }
    pub async fn call_tool(
        &self,
        params: CallToolRequestParams,
    ) -> Result<CallToolResult, ServiceError> {
        match self {
            Self::NoInit(s) => s.call_tool(params).await,
            Self::WithInit(s) => s.call_tool(params).await,
        }
    }

    /// What this server offers to read (AH-137).
    ///
    /// A resource is a document rather than a tool: listing or reading one
    /// runs nothing on the server.
    pub async fn list_all_resources(
        &self,
    ) -> Result<Vec<rmcp::model::Resource>, ServiceError> {
        match self {
            Self::NoInit(s) => s.list_all_resources().await,
            Self::WithInit(s) => s.list_all_resources().await,
        }
    }

    /// Read one resource by uri (AH-137).
    pub async fn read_resource(
        &self,
        params: rmcp::model::ReadResourceRequestParams,
    ) -> Result<rmcp::model::ReadResourceResult, ServiceError> {
        match self {
            Self::NoInit(s) => s.read_resource(params).await,
            Self::WithInit(s) => s.read_resource(params).await,
        }
    }

    /// The peer's handshake info: what the server said it implements. Read by
    /// the `/mcp` detail screen for its capabilities and version lines.
    pub fn peer_info(&self) -> Option<rmcp::model::ServerPeerInfo> {
        match self {
            Self::NoInit(s) => s.peer_info().map(|p| (*p).clone()),
            Self::WithInit(s) => s.peer_info().map(|p| (*p).clone()),
        }
    }
}

/// Shared desktop application state owned by Tauri. The CLI builds its
/// subsystems (MCP map, provider configs) directly instead.
#[cfg(not(feature = "cli"))]
pub struct AppState {
    pub app_token: Option<String>,
    pub mcp_servers: SharedMcpServers,
    pub mcp_active_servers: Arc<Mutex<HashMap<String, serde_json::Value>>>,
    pub server_handle: Arc<Mutex<Option<ServerHandle>>>,
    pub tool_call_cancellations: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    pub mcp_settings: Arc<Mutex<McpSettings>>,
    pub mcp_shutdown_in_progress: Arc<Mutex<bool>>,
    pub mcp_monitoring_tasks: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    /// Names of MCP servers whose initial start is currently in flight. Guards
    /// against a server being `serve()`'d twice (e.g. boot startup racing a
    /// frontend activation), which sends duplicate `initialize` requests.
    pub mcp_starting: Arc<Mutex<HashSet<String>>>,
    pub background_cleanup_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    pub mcp_server_pids: Arc<Mutex<HashMap<String, u32>>>,
    /// Remote provider configurations (e.g., Anthropic, OpenAI, etc.)
    pub provider_configs: Arc<Mutex<HashMap<String, ProviderConfig>>>,
    /// Per-model sampling defaults the API server injects when the caller omits
    /// them (MLX path; llamacpp uses the router preset instead). Keyed by model
    /// id; values are objects already in the target's request-body key form.
    pub model_param_defaults: Arc<Mutex<HashMap<String, serde_json::Value>>>,
    /// Wakes up MCP monitors to trigger an immediate health check + reconnect
    pub mcp_reconnect_notify: Arc<Notify>,
    /// Last successful tool listing per enabled server, served when a server
    /// is transiently disconnected so its schema stays present and stable in
    /// the prompt instead of disappearing/reappearing across reconnects.
    /// Cleared only on explicit user deactivation, never on a transient
    /// list-tools failure.
    pub mcp_last_known_tools: Arc<Mutex<HashMap<String, Vec<ToolWithServer>>>>,
    /// Which instance of a named server is the current one.
    ///
    /// A name can be started, stopped and started again with a different
    /// definition while an earlier start is still in flight. Without this the
    /// earlier attempt's completion would install a health monitor for a name
    /// that now means a different program — and that monitor would keep
    /// reconnecting it. Every start takes a number; a completion only counts
    /// while its number is still the current one.
    pub mcp_generation: Arc<Mutex<HashMap<String, u64>>>,
    /// On-demand start bookkeeping: one start per server, status, idle time.
    pub mcp_lazy: Arc<crate::core::mcp::lazy::LazyMcp>,
}

#[cfg(not(feature = "cli"))]
impl Default for AppState {
    fn default() -> Self {
        Self {
            app_token: None,
            mcp_servers: Default::default(),
            mcp_active_servers: Default::default(),
            server_handle: Default::default(),
            tool_call_cancellations: Default::default(),
            mcp_settings: Default::default(),
            mcp_shutdown_in_progress: Default::default(),
            mcp_monitoring_tasks: Default::default(),
            mcp_starting: Default::default(),
            background_cleanup_handle: Default::default(),
            mcp_server_pids: Default::default(),
            provider_configs: Default::default(),
            model_param_defaults: Default::default(),
            mcp_reconnect_notify: Arc::new(Notify::new()),
            mcp_last_known_tools: Default::default(),
            mcp_generation: Default::default(),
            mcp_lazy: Default::default(),
        }
    }
}
