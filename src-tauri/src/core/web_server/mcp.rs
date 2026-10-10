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
    starting: Mutex<HashSet<String>>,
    cancellations: Mutex<HashMap<String, oneshot::Sender<()>>>,
    allow_stdio: bool,
    /// One writer at a time for `mcp_config.json`: every change reads the
    /// document, edits it and writes it back.
    config_lock: Mutex<()>,
}

impl Host {
    pub fn new(allow_stdio: bool) -> Self {
        Self {
            servers: Arc::new(Mutex::new(HashMap::new())),
            failures: Mutex::new(HashMap::new()),
            starting: Mutex::new(HashSet::new()),
            cancellations: Mutex::new(HashMap::new()),
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

/// Raw `mcp_config.json`, for the settings page to parse as it does on desktop.
pub fn config_text() -> String {
    match client::read_config_document() {
        Value::Null => "{}".to_string(),
        document => document.to_string(),
    }
}

/// Replace the saved configuration. A stdio server that is new or changed is
/// refused unless the operator allowed it; servers that disappeared, changed or
/// were switched off are disconnected so nothing keeps running a stale
/// definition.
pub async fn save_config(host: &Host, text: &str) -> Result<(), String> {
    let _writer = host.config_lock.lock().await;
    let document: Value = serde_json::from_str(text).map_err(|e| format!("invalid JSON: {e}"))?;
    if !document.is_object() {
        return Err("configuration must be a JSON object".into());
    }
    let incoming = servers_of(&document);
    let before = saved_servers();
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
    if !host.starting.lock().await.insert(name.to_string()) {
        return Err(format!("server '{name}' is already starting"));
    }
    let result = client::connect(name, &config, &host.servers).await;
    host.starting.lock().await.remove(name);
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
    let starting = host.starting.lock().await.clone();
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
    let guard = host.servers.lock().await;
    let mut out = Vec::new();
    for (name, service) in guard.iter() {
        if names.as_ref().is_some_and(|list| !list.contains(name)) {
            continue;
        }
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

pub fn trust(name: &str, expected: Option<&str>) -> Result<(), String> {
    let current = fingerprint_of(name)
        .ok_or_else(|| format!("MCP server '{name}' is not configured, so it cannot be trusted"))?;
    if expected.is_some_and(|expected| expected != current) {
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

pub fn allow_once(name: &str, tool: &str, expected: Option<&str>) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("a server name is required to authorize a call".into());
    }
    let current = fingerprint_of(name).ok_or_else(|| {
        format!("MCP server '{name}' is not configured, so no call to it can be authorized")
    })?;
    tauri_plugin_agent_tools::mcp_trust::allow_once(&data_folder(), name, tool, &current, expected)
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
    if let Some(sender) = host.cancellations.lock().await.remove(token) {
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
    if let Some(token) = &request.cancellation_token {
        host.cancellations.lock().await.insert(token.clone(), cancel_tx);
    }
    let outcome = call_inner(host, &request, timeout, output_cap, cancel_rx).await;
    if let Some(token) = &request.cancellation_token {
        host.cancellations.lock().await.remove(token);
    }
    outcome
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
    let guard = host.servers.lock().await;
    let candidates: Vec<_> = guard
        .iter()
        .filter(|(name, _)| request.server.is_none_or(|wanted| wanted == name.as_str()))
        .collect();
    if candidates.is_empty() {
        return Err(match request.server {
            Some(server) => format!("Server '{server}' not found"),
            None => format!("Tool {} not found - no MCP servers connected", request.tool),
        });
    }
    for (name, service) in candidates {
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
        let call = service.call_tool(params);
        let result = tokio::select! {
            result = tokio::time::timeout(timeout, call) => match result {
                Ok(done) => done.map_err(|e| e.to_string()),
                Err(_) => Err(format!(
                    "Tool call '{}' timed out after {} seconds",
                    request.tool,
                    timeout.as_secs()
                )),
            },
            _ = cancel_rx => Err(format!("Tool call '{}' was cancelled", request.tool)),
        }?;
        let capped = crate::core::mcp::truncate::truncate_tool_result(&result, cap);
        crate::core::mcp::budget::charge(name, crate::core::mcp::budget::result_chars(&capped));
        return Ok(flatten(&capped));
    }
    Err(format!("Tool {} not found", request.tool))
}

#[cfg(test)]
mod tests {
    use super::*;

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
