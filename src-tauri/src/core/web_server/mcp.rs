//! MCP servers for the browser: configuration, lifecycle, tools and calls.
//!
//! Built on the AppHandle-free client in `cli::mcp` plus the same trust grants
//! (`mcp_trust`) and result budgets the desktop enforces, so a browser session
//! gets no wider access than the desktop app gives its own window.
//!
//! Starting or editing a stdio server runs a program on this machine, which is
//! more than a sign-in credential otherwise grants, so it needs the operator's
//! `--allow-mcp-stdio` at startup. http and sse servers are always allowed.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use rmcp::model::CallToolRequestParams;
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::{oneshot, Mutex};

use crate::core::cli::mcp as client;
use crate::core::mcp::models::McpSettings;
use crate::core::mcp::redact;
use crate::core::mcp::stall;
use crate::core::state::SharedMcpServers;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    Stopped,
    Starting,
    Running,
    Failed { error: String },
}

pub struct Host {
    servers: SharedMcpServers,
    failures: Mutex<HashMap<String, String>>,
    // std mutexes, held only for a map edit and never across an await, so the
    // guards below can release their entry from `Drop`.
    starting: std::sync::Mutex<HashSet<String>>,
    cancellations: std::sync::Mutex<HashMap<String, oneshot::Sender<()>>>,
    allow_stdio: bool,
    /// One writer at a time for `mcp_config.json`: every change reads the
    /// document, edits it and writes it back.
    config_lock: Mutex<()>,
}

/// Marks a server as starting; clears the mark on drop, so a connect that is
/// cancelled mid-await (client disconnect) cannot leave it stuck on "starting".
struct StartingGuard<'a> {
    set: &'a std::sync::Mutex<HashSet<String>>,
    name: String,
}

impl<'a> StartingGuard<'a> {
    fn begin(set: &'a std::sync::Mutex<HashSet<String>>, name: &str) -> Option<Self> {
        let fresh = set
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(name.to_string());
        fresh.then(|| Self { set, name: name.to_string() })
    }
}

impl Drop for StartingGuard<'_> {
    fn drop(&mut self) {
        self.set
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.name);
    }
}

/// Registers a call's cancel sender; removes it on drop, finished or abandoned.
struct CancellationGuard<'a> {
    map: &'a std::sync::Mutex<HashMap<String, oneshot::Sender<()>>>,
    token: String,
}

impl<'a> CancellationGuard<'a> {
    fn register(
        map: &'a std::sync::Mutex<HashMap<String, oneshot::Sender<()>>>,
        token: &str,
        sender: oneshot::Sender<()>,
    ) -> Self {
        map.lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(token.to_string(), sender);
        Self { map, token: token.to_string() }
    }
}

impl Drop for CancellationGuard<'_> {
    fn drop(&mut self) {
        self.map
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.token);
    }
}

type Peer = rmcp::Peer<rmcp::RoleClient>;

/// Peers of the matching servers. The `servers` lock is held only for this
/// copy, never across a round trip to a server.
async fn peers_of(host: &Host, wanted: impl Fn(&str) -> bool) -> Vec<(String, Peer)> {
    host.servers
        .lock()
        .await
        .iter()
        .filter(|(name, _)| wanted(name))
        .map(|(name, service)| (name.clone(), service.peer()))
        .collect()
}

impl Host {
    pub fn new(allow_stdio: bool) -> Self {
        Self {
            servers: Arc::new(Mutex::new(HashMap::new())),
            failures: Mutex::new(HashMap::new()),
            starting: std::sync::Mutex::new(HashSet::new()),
            cancellations: std::sync::Mutex::new(HashMap::new()),
            allow_stdio,
            config_lock: Mutex::new(()),
        }
    }
}

fn data_folder() -> std::path::PathBuf {
    crate::core::app::commands::resolve_jan_data_folder()
}

/// Whether connecting this config can start a local program, which only an
/// operator who passed `--allow-mcp-stdio` may allow. The connect path treats a
/// config as remote only for `type` http or sse with a url; anything else that
/// names a `command` is spawned, whatever other fields it carries.
fn is_stdio(config: &Value) -> bool {
    let remote_type = matches!(
        config.get("type").and_then(Value::as_str),
        Some("http") | Some("sse")
    );
    if remote_type && config.get("url").and_then(Value::as_str).is_some() {
        return false;
    }
    if config.get("command").is_some() {
        return true;
    }
    config.get("url").is_none()
}

/// A definition without its on/off switch: what a trust grant is about.
fn definition(config: &Value) -> Value {
    let mut copy = config.clone();
    if let Some(object) = copy.as_object_mut() {
        object.remove("active");
    }
    copy
}

fn servers_of(document: &Value) -> Map<String, Value> {
    document
        .get("mcpServers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn saved_servers() -> Map<String, Value> {
    servers_of(&client::read_config_document())
}

fn refuse_stdio(host: &Host) -> String {
    debug_assert!(!host.allow_stdio);
    "Running stdio MCP servers from the browser is off. Start `flint serve` with \
     --allow-mcp-stdio to enable it."
        .to_string()
}

/// `mcp_config.json` with env values and headers masked, for the settings page
/// to parse as it does on desktop. The real secrets never leave the host.
pub fn config_text() -> String {
    redacted_text(&client::read_config_document())
}

fn redacted_text(document: &Value) -> String {
    match document {
        Value::Null => "{}".to_string(),
        document => redact::redact_mcp_config(document).to_string(),
    }
}

/// Put stored secrets back where the browser sent the mask, and drop any mask
/// with nothing to restore, as the desktop save does.
fn unmask(document: &mut Value, stored: &Map<String, Value>) {
    redact::restore_masked_secrets(document, stored);
    for entry in redact::strip_unrestored_masks(document) {
        log::warn!("web save mcp config: dropped hidden value with no stored secret: {entry}");
    }
}

/// Replace the saved configuration. A stdio server that is new or changed is
/// refused unless the operator allowed it; servers that disappeared, changed or
/// were switched off are disconnected so nothing keeps running a stale
/// definition.
pub async fn save_config(host: &Host, text: &str) -> Result<(), String> {
    let _writer = host.config_lock.lock().await;
    let mut document: Value = serde_json::from_str(text).map_err(|e| format!("invalid JSON: {e}"))?;
    if !document.is_object() {
        return Err("configuration must be a JSON object".into());
    }
    let before = saved_servers();
    unmask(&mut document, &before);
    let incoming = servers_of(&document);
    for (name, config) in &incoming {
        client::validate_server_name(name)?;
        client::validate_config(config)?;
        let unchanged = before
            .get(name)
            .is_some_and(|old| definition(old) == definition(config));
        if is_stdio(config) && !unchanged && !host.allow_stdio {
            return Err(refuse_stdio(host));
        }
        // Turning a stdio server on is starting it; the lifecycle routes gate
        // that, but a saved `active` flag must not smuggle it past them.
        let was_active = before.get(name).is_some_and(active);
        if is_stdio(config) && active(config) && !was_active && !host.allow_stdio {
            return Err(refuse_stdio(host));
        }
    }
    client::write_config_document(&document)?;
    for (name, old) in &before {
        let keep = incoming
            .get(name)
            .is_some_and(|new| definition(new) == definition(old) && active(new));
        if !keep {
            client::disconnect(name, &host.servers).await;
            host.failures.lock().await.remove(name);
        }
    }
    Ok(())
}

fn active(config: &Value) -> bool {
    config.get("active").and_then(Value::as_bool).unwrap_or(false)
}

async fn connect(host: &Host, name: &str) -> Result<(), String> {
    let config = saved_servers()
        .get(name)
        .cloned()
        .ok_or_else(|| format!("server '{name}' is not configured"))?;
    if is_stdio(&config) && !host.allow_stdio {
        return Err(refuse_stdio(host));
    }
    if host.servers.lock().await.contains_key(name) {
        return Ok(());
    }
    let Some(starting) = StartingGuard::begin(&host.starting, name) else {
        return Err(format!("server '{name}' is already starting"));
    };
    let result = client::connect(name, &config, &host.servers).await;
    drop(starting);
    match result {
        Ok(()) => {
            host.failures.lock().await.remove(name);
            Ok(())
        }
        Err(error) => {
            let message = error.to_string();
            host.failures
                .lock()
                .await
                .insert(name.to_string(), message.clone());
            Err(message)
        }
    }
}

pub async fn activate(host: &Host, name: &str, config: Value, start: bool) -> Result<(), String> {
    let _writer = host.config_lock.lock().await;
    client::validate_server_name(name)?;
    client::validate_config(&config)?;
    let changed = saved_servers()
        .get(name)
        .is_none_or(|old| definition(old) != definition(&config));
    if is_stdio(&config) && !host.allow_stdio && (changed || start) {
        return Err(refuse_stdio(host));
    }
    if changed {
        client::disconnect(name, &host.servers).await;
    }
    client::upsert_server(name, &config)?;
    client::set_active(name, true)?;
    if start {
        connect(host, name).await?;
    }
    Ok(())
}

pub async fn deactivate(host: &Host, name: &str) -> Result<(), String> {
    let _writer = host.config_lock.lock().await;
    client::disconnect(name, &host.servers).await;
    host.failures.lock().await.remove(name);
    client::set_active(name, false)
}

pub async fn start(host: &Host, name: &str) -> Result<(), String> {
    connect(host, name).await
}

pub async fn stop(host: &Host, name: &str) {
    client::disconnect(name, &host.servers).await;
}

pub async fn restart_all(host: &Host) {
    let names: Vec<String> = host.servers.lock().await.keys().cloned().collect();
    for name in names {
        client::disconnect(&name, &host.servers).await;
    }
    for (name, config) in saved_servers() {
        if active(&config) {
            let _ = connect(host, &name).await;
        }
    }
}

pub async fn statuses(host: &Host) -> HashMap<String, Status> {
    let running: HashSet<String> = host.servers.lock().await.keys().cloned().collect();
    let starting = host.starting.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let failures = host.failures.lock().await.clone();
    saved_servers()
        .into_iter()
        .filter(|(_, config)| active(config))
        .map(|(name, _)| {
            let status = if running.contains(&name) {
                Status::Running
            } else if starting.contains(&name) {
                Status::Starting
            } else if let Some(error) = failures.get(&name) {
                Status::Failed { error: error.clone() }
            } else {
                Status::Stopped
            };
            (name, status)
        })
        .collect()
}

pub async fn connected(host: &Host) -> Vec<String> {
    let mut names: Vec<String> = host.servers.lock().await.keys().cloned().collect();
    names.sort();
    names
}

fn settings() -> McpSettings {
    client::read_settings()
}

/// Tools of the named servers (all connected ones when `names` is `None`).
/// With `start`, enabled servers that are not running are started first.
pub async fn tools(host: &Host, names: Option<Vec<String>>, start: bool) -> Vec<Value> {
    if start {
        for (name, config) in saved_servers() {
            let wanted = names.as_ref().is_none_or(|list| list.contains(&name));
            if wanted && active(&config) {
                let _ = connect(host, &name).await;
            }
        }
    }
    let timeout = settings().tool_call_timeout_duration();
    let peers = peers_of(host, |name| {
        names.as_ref().is_none_or(|list| list.iter().any(|n| n == name))
    })
    .await;
    let mut out = Vec::new();
    for (name, service) in peers {
        let Ok(Ok(listed)) = tokio::time::timeout(timeout, service.list_all_tools()).await else {
            continue;
        };
        for tool in listed {
            if let Ok(Value::Object(mut object)) = serde_json::to_value(&tool) {
                object.insert("server".into(), json!(name));
                out.push(Value::Object(object));
            }
        }
    }
    out
}

pub async fn summaries(host: &Host) -> Vec<Value> {
    let mut out = Vec::new();
    for name in connected(host).await {
        if let Some(detail) = client::describe(&name, &host.servers).await {
            out.push(json!({
                "name": name,
                "capabilities": detail.capabilities,
                "description": detail.implementation.unwrap_or_default(),
            }));
        }
    }
    out
}

pub fn log(name: &str, lines: Option<usize>) -> Vec<String> {
    crate::core::mcp::server_log::tail(&data_folder(), name, lines.unwrap_or(200).min(2000))
}

/// Fingerprint of the definition a server name stands for: what is saved now.
fn fingerprint_of(name: &str) -> Option<String> {
    saved_servers()
        .get(name)
        .map(tauri_plugin_agent_tools::mcp_identity::fingerprint)
}

pub fn fingerprints() -> HashMap<String, String> {
    saved_servers()
        .iter()
        .map(|(name, config)| {
            (
                name.clone(),
                tauri_plugin_agent_tools::mcp_identity::fingerprint(config),
            )
        })
        .collect()
}

pub fn trusted() -> Vec<String> {
    tauri_plugin_agent_tools::mcp_trust::trusted(&data_folder())
        .into_iter()
        .map(|grant| grant.name)
        .collect()
}

pub fn trust_report() -> Value {
    let folder = data_folder();
    let fingerprints = fingerprints();
    let trusted: Vec<Value> = tauri_plugin_agent_tools::mcp_trust::trusted(&folder)
        .into_iter()
        .map(|grant| {
            json!({
                "currentFingerprint": fingerprints.get(&grant.name),
                "name": grant.name,
                "fingerprint": grant.fingerprint,
                "grantedAt": grant.granted_at,
            })
        })
        .collect();
    let invalidated: Vec<Value> = tauri_plugin_agent_tools::mcp_trust::invalidated(&folder)
        .into_iter()
        .map(|entry| {
            json!({
                "name": entry.name,
                "reason": entry.reason,
                "at": entry.at,
                "fingerprint": entry.fingerprint,
            })
        })
        .collect();
    json!({ "trusted": trusted, "invalidated": invalidated })
}

pub fn trust(name: &str, expected: &str) -> Result<(), String> {
    let current = fingerprint_of(name)
        .ok_or_else(|| format!("MCP server '{name}' is not configured, so it cannot be trusted"))?;
    if expected != current {
        return Err(tauri_plugin_agent_tools::mcp_trust::Refusal::ConfigurationChanged {
            server: name.to_string(),
        }
        .message());
    }
    tauri_plugin_agent_tools::mcp_trust::trust(&data_folder(), name, &current)
}

pub fn revoke(name: &str) -> Result<(), String> {
    tauri_plugin_agent_tools::mcp_trust::revoke(
        &data_folder(),
        name,
        tauri_plugin_agent_tools::mcp_trust::RevokeReason::User,
    )
    .map(|_| ())
}

pub fn forget(name: &str, reason: &str) -> Result<(), String> {
    use tauri_plugin_agent_tools::mcp_trust::RevokeReason;
    let reason = RevokeReason::parse(reason)
        .filter(|r| *r != RevokeReason::User)
        .ok_or_else(|| format!("unknown reason '{reason}': expected 'deleted' or 'renamed'"))?;
    let folder = data_folder();
    tauri_plugin_agent_tools::mcp_trust::revoke(&folder, name, reason)?;
    crate::core::mcp::oauth::clear(&folder, name).map(|_| ())
}

pub fn allow_once(name: &str, tool: &str, expected: &str) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("a server name is required to authorize a call".into());
    }
    let current = fingerprint_of(name).ok_or_else(|| {
        format!("MCP server '{name}' is not configured, so no call to it can be authorized")
    })?;
    tauri_plugin_agent_tools::mcp_trust::allow_once(&data_folder(), name, tool, &current, Some(expected))
}

pub fn clear_auth(name: &str) -> Result<bool, String> {
    client::clear_auth(name)
}

pub fn auth_status(name: &str) -> Value {
    let config = saved_servers().get(name).cloned().unwrap_or(Value::Null);
    let info = client::auth_status_info(name, &config);
    serde_json::to_value(info).unwrap_or(Value::Null)
}

pub async fn cancel(host: &Host, token: &str) {
    let sender = host
        .cancellations
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(token);
    if let Some(sender) = sender {
        let _ = sender.send(());
    }
}

pub struct Call<'a> {
    pub tool: &'a str,
    pub server: Option<&'a str>,
    pub arguments: Option<Map<String, Value>>,
    pub cancellation_token: Option<String>,
    pub max_output_chars: Option<u64>,
    pub approval_ticket: Option<&'a str>,
}

fn flatten(result: &rmcp::model::CallToolResult) -> Value {
    let value = serde_json::to_value(result).unwrap_or(Value::Null);
    let content = value.get("content").cloned().unwrap_or_else(|| json!([]));
    let error = if result.is_error == Some(true) {
        content
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| "Tool call failed".to_string())
    } else {
        String::new()
    };
    json!({ "error": error, "content": content })
}

/// Call a tool. The trust decision is made against the server that actually
/// publishes the tool, before any argument is sent, exactly as on desktop.
pub async fn call(host: &Host, request: Call<'_>) -> Result<Value, String> {
    let settings = settings();
    let timeout = settings.tool_call_timeout_duration();
    let output_cap = settings.tool_output_cap(request.max_output_chars);

    // Lazy start of the server this call needs, when it is enabled.
    let saved = saved_servers();
    let wanted: Vec<String> = match request.server {
        Some(name) => vec![name.to_string()],
        None => saved.keys().cloned().collect(),
    };
    for name in wanted {
        if saved.get(&name).is_some_and(active) && !host.servers.lock().await.contains_key(&name) {
            let _ = connect(host, &name).await;
        }
    }

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let _registered = request
        .cancellation_token
        .as_deref()
        .map(|token| CancellationGuard::register(&host.cancellations, token, cancel_tx));
    call_inner(host, &request, timeout, output_cap, cancel_rx).await
}

async fn call_inner(
    host: &Host,
    request: &Call<'_>,
    timeout: std::time::Duration,
    output_cap: u64,
    cancel_rx: oneshot::Receiver<()>,
) -> Result<Value, String> {
    let folder = data_folder();
    let saved = saved_servers();
    let candidates = peers_of(host, |name| request.server.is_none_or(|wanted| wanted == name)).await;
    if candidates.is_empty() {
        return Err(match request.server {
            Some(server) => format!("Server '{server}' not found"),
            None => format!("Tool {} not found - no MCP servers connected", request.tool),
        });
    }
    for (name, service) in &candidates {
        let Ok(Ok(listed)) = tokio::time::timeout(timeout, service.list_all_tools()).await else {
            continue;
        };
        if !listed.iter().any(|tool| tool.name == request.tool) {
            continue;
        }
        let current = saved
            .get(name)
            .map(tauri_plugin_agent_tools::mcp_identity::fingerprint);
        tauri_plugin_agent_tools::mcp_trust::permits(
            &folder,
            name,
            request.tool,
            current.as_deref(),
            request.approval_ticket,
        )
        .map_err(|refusal| refusal.message())?;

        let budget = crate::core::mcp::budget::ServerBudget::for_server(&folder, name);
        crate::core::mcp::budget::check(name, &budget)?;
        let cap = budget.result_cap(output_cap);

        let mut params = CallToolRequestParams::new(request.tool.to_string());
        if let Some(arguments) = request.arguments.clone() {
            params = params.with_arguments(arguments);
        }
        let outcome = stall::call_tool_until(service, params, timeout, async {
            // A dropped sender is not a cancel: wait forever instead.
            if cancel_rx.await.is_err() {
                std::future::pending::<()>().await;
            }
        })
        .await;
        if stall::note_outcome(name, &outcome) {
            // No `servers` lock is held here; lazy start brings it back.
            client::disconnect(name, &host.servers).await;
        }
        let result = outcome.map_err(|failure| match failure {
            stall::CallFailure::TimedOut => format!(
                "Tool call '{}' timed out after {} seconds",
                request.tool,
                timeout.as_secs()
            ),
            stall::CallFailure::Cancelled => {
                format!("Tool call '{}' was cancelled", request.tool)
            }
            stall::CallFailure::Other(message) => message,
        })?;
        let capped = crate::core::mcp::truncate::truncate_tool_result(&result, cap);
        crate::core::mcp::budget::charge(name, crate::core::mcp::budget::result_chars(&capped));
        return Ok(flatten(&capped));
    }
    Err(format!("Tool {} not found", request.tool))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        json!({"mcpServers": {"s": {
            "type": "http", "url": "https://x.test/mcp", "active": true,
            "headers": {"Authorization": "Bearer real-secret"}
        }}})
    }

    #[test]
    fn web_mcp_config_get_masks_env_and_headers() {
        let text = redacted_text(&sample());
        assert!(!text.contains("real-secret"));
        assert!(text.contains(redact::MASK));
        assert_eq!(redacted_text(&Value::Null), "{}");
    }

    #[test]
    fn web_mcp_config_put_roundtrip_keeps_secrets() {
        let stored = sample();
        let mut sent: Value = serde_json::from_str(&redacted_text(&stored)).unwrap();
        unmask(&mut sent, &servers_of(&stored));
        assert_eq!(
            sent["mcpServers"]["s"]["headers"]["Authorization"],
            "Bearer real-secret"
        );
        // A mask with nothing stored is dropped, never written.
        let mut fresh: Value = serde_json::from_str(&redacted_text(&stored)).unwrap();
        unmask(&mut fresh, &Map::new());
        assert!(!fresh.to_string().contains(redact::MASK));
    }

    #[test]
    fn web_mcp_connect_drop_clears_starting() {
        let host = Host::new(false);
        let guard = StartingGuard::begin(&host.starting, "a").expect("first start");
        assert!(StartingGuard::begin(&host.starting, "a").is_none());
        drop(guard);
        assert!(host.starting.lock().unwrap().is_empty());
        assert!(StartingGuard::begin(&host.starting, "a").is_some());
    }

    #[test]
    fn web_mcp_call_drop_clears_cancellation() {
        let host = Host::new(false);
        let (tx, _rx) = oneshot::channel::<()>();
        let guard = CancellationGuard::register(&host.cancellations, "t", tx);
        assert!(host.cancellations.lock().unwrap().contains_key("t"));
        drop(guard);
        assert!(host.cancellations.lock().unwrap().is_empty());
    }

    #[test]
    fn web_mcp_timeouts_trip_stall_tracker() {
        let server = "web-mcp-stall-test";
        let timed_out: Result<(), stall::CallFailure> = Err(stall::CallFailure::TimedOut);
        for _ in 1..stall::STALL_STOP_THRESHOLD {
            assert!(!stall::note_outcome(server, &timed_out));
        }
        assert!(stall::note_outcome(server, &timed_out));
    }

    /// A server whose tool listing never answers.
    struct Stalled;

    impl rmcp::ServerHandler for Stalled {
        fn get_info(&self) -> rmcp::model::ServerInfo {
            rmcp::model::ServerInfo::new(
                rmcp::model::ServerCapabilities::builder().enable_tools().build(),
            )
        }

        async fn list_tools(
            &self,
            _request: Option<rmcp::model::PaginatedRequestParams>,
            _context: rmcp::service::RequestContext<rmcp::RoleServer>,
        ) -> Result<rmcp::model::ListToolsResult, rmcp::ErrorData> {
            std::future::pending().await
        }
    }

    #[tokio::test]
    async fn web_mcp_call_does_not_hold_servers_lock() {
        use rmcp::ServiceExt;
        let host = Arc::new(Host::new(false));
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        tokio::spawn(async move {
            let running = Stalled.serve(server_io).await.expect("server starts");
            let _ = running.waiting().await;
        });
        let client = ().serve(client_io).await.expect("client starts");
        host.servers
            .lock()
            .await
            .insert("stub".into(), crate::core::state::RunningServiceEnum::NoInit(client));

        let background = host.clone();
        let call_task = tokio::spawn(async move {
            let request = Call {
                tool: "t",
                server: Some("stub"),
                arguments: None,
                cancellation_token: None,
                max_output_chars: None,
                approval_ticket: None,
            };
            let (_tx, rx) = oneshot::channel::<()>();
            call_inner(&background, &request, std::time::Duration::from_secs(3), 1000, rx).await
        });
        // Let the call reach the stalled round trip.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(
            host.servers.try_lock().is_ok(),
            "a stalled call must not hold the servers lock"
        );
        assert!(!call_task.is_finished());
        call_task.abort();
    }

    #[test]
    fn transport_is_read_from_the_definition() {
        assert!(is_stdio(&json!({"command": "npx", "args": []})));
        assert!(is_stdio(&json!({"type": "stdio", "command": "x"})));
        assert!(!is_stdio(&json!({"type": "http", "url": "https://x"})));
        assert!(!is_stdio(&json!({"type": "sse", "url": "https://x"})));
        assert!(!is_stdio(&json!({"url": "https://x"})));
        // A url beside a command does not make it remote: the connect path
        // spawns the command unless the type is http or sse.
        assert!(is_stdio(&json!({"command": "calc.exe", "args": [], "url": "http://x"})));
        assert!(is_stdio(&json!({"type": "stdio", "command": "x", "args": [], "url": "http://x"})));
        assert!(is_stdio(&json!({"type": "streamable-http", "command": "x", "args": [], "url": "http://x"})));
        assert!(!is_stdio(&json!({"type": "http", "url": "https://x", "command": "ignored"})));
    }

    #[test]
    fn active_switch_is_not_part_of_the_definition() {
        let on = json!({"command": "x", "active": true});
        let off = json!({"command": "x", "active": false});
        assert_eq!(definition(&on), definition(&off));
        assert_ne!(definition(&on), definition(&json!({"command": "y"})));
        assert!(!active(&json!({"command": "x"})));
        assert!(active(&on));
        assert!(!active(&off));
    }

    #[test]
    fn tool_errors_are_flattened_for_the_web_app() {
        let ok = rmcp::model::CallToolResult::success(vec![rmcp::model::ContentBlock::text("hi")]);
        assert_eq!(flatten(&ok)["error"], "");
        assert_eq!(flatten(&ok)["content"][0]["text"], "hi");
        let bad = rmcp::model::CallToolResult::error(vec![rmcp::model::ContentBlock::text("boom")]);
        assert_eq!(flatten(&bad)["error"], "boom");
    }
}
