//! AppHandle-free MCP client for the CLI agent.
//!
//! The desktop activation stack (`core/mcp/helpers.rs`) is generic over a Tauri
//! `AppHandle` (data-folder lookup, `AppState`, event emit, bundled `bun`/`uv`
//! rewriting, health-monitor tasks). The CLI has no `AppHandle`, so this module
//! provides a focused connector: it reads the same `<jan_data>/mcp_config.json`,
//! reuses the shared `extract_command_args`/`extract_active_status` parsers, and
//! connects http/sse/stdio transports directly into a `SharedMcpServers` map that
//! the agent loop already consumes. No bundled-runtime rewriting, no Flint Browser
//! MCP bridge, no auto-reconnect monitor -- the CLI relies on the user's PATH.

use std::path::PathBuf;
use std::process::Stdio;

use rmcp::{
    model::{ClientCapabilities, ClientInfo, Implementation},
    transport::{
        streamable_http_client::{StreamableHttpClient, StreamableHttpClientTransportConfig},
        StreamableHttpClientTransport,
    },
    ServiceExt,
};
use serde_json::Value;
use tokio::process::Command;

use crate::core::app::commands::resolve_jan_data_folder;
use crate::core::mcp::models::McpSettings;
use crate::core::mcp::models::{extract_active_status, extract_command_args};
use crate::core::mcp::oauth;
use crate::core::state::{RunningServiceEnum, SharedMcpServers};

/// The Flint Browser MCP needs the desktop bridge/lockfile machinery, so it is
/// never offered or connected from the CLI.
const BROWSER_MCP_NAME: &str = "Jan Browser MCP";

/// A configured server as read from `mcp_config.json`.
pub struct McpServerEntry {
    pub name: String,
    pub active: bool,
    pub config: Value,
}

/// Resolve the config path under a data folder. `data_folder` is threaded
/// through the internal helpers so tests can point at a tempdir without a global
/// override; the public API uses the real Flint data folder via
/// `resolve_jan_data_folder()`.
fn config_path(data_folder: &std::path::Path) -> PathBuf {
    data_folder.join("mcp_config.json")
}

/// The real Flint data folder (the env override in `resolve_jan_data_folder`
/// applies, so a `JAN_DATA_FOLDER` redirect still works end to end).
fn default_data_folder() -> PathBuf {
    resolve_jan_data_folder()
}

fn read_config(data_folder: &std::path::Path) -> Value {
    match std::fs::read_to_string(config_path(data_folder)) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str(&s).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// The config for a read-modify-write. A missing or blank file is an empty
/// document; a file that cannot be read or parsed, or whose root is not an
/// object, is an error so the caller never writes a near-empty file over
/// servers (and their keys) it failed to read.
fn load_config(data_folder: &std::path::Path) -> Result<Value, String> {
    let path = config_path(data_folder);
    let text = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::json!({})),
        Err(e) => return Err(format!("{}: {e}; refusing to overwrite", path.display())),
    };
    if text.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    let cfg: Value = serde_json::from_str(&text)
        .map_err(|e| format!("{}: {e}; refusing to overwrite", path.display()))?;
    if !cfg.is_object() {
        return Err(format!(
            "{}: not a JSON object; refusing to overwrite",
            path.display()
        ));
    }
    Ok(cfg)
}

/// Atomically persist a full `mcp_config.json` document (tmp + rename), the
/// same idiom `set_active` already uses. `mcpServers`/`mcpSettings` keys are
/// ensured so a caller passing a bare servers object still writes a valid doc.
fn write_config(data_folder: &std::path::Path, cfg: &Value) -> Result<(), String> {
    let path = config_path(data_folder);
    let mut doc = if cfg.is_object() {
        cfg.clone()
    } else {
        serde_json::json!({})
    };
    let obj = doc.as_object_mut().ok_or("mcp_config is not an object")?;
    obj.entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    obj.entry("mcpSettings")
        .or_insert_with(|| serde_json::json!({}));

    let body = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    // A fresh install has no data folder until something writes to it.
    std::fs::create_dir_all(data_folder)
        .map_err(|e| format!("cannot create {}: {e}", data_folder.display()))?;
    let tmp = path.with_extension("json.tmp");
    // MCP env/header fields can hold keys entered during plugin setup, so the
    // file is owner-only on Unix from the moment it exists.
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // `mode` only applies on creation; a stale tmp file keeps its old bits.
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    std::io::Write::write_all(&mut file, body.as_bytes()).map_err(|e| e.to_string())?;
    drop(file);
    // Best effort: keep the previous file so a bad write is recoverable.
    if path.is_file() {
        let _ = std::fs::copy(&path, path.with_extension("json.bak"));
    }
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("cannot replace {}: {e}", path.display()))?;
    Ok(())
}

/// Read the `mcpServers` object as a mutable map, defaulting to an empty one.
fn servers_map_mut(cfg: &mut Value) -> &mut serde_json::Map<String, Value> {
    if !cfg.is_object() {
        *cfg = serde_json::json!({});
    }
    let root = cfg.as_object_mut().expect("root was just made an object");
    // A hand-edited file may hold null, an array or a string here.
    let entry = root
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    if !entry.is_object() {
        *entry = serde_json::json!({});
    }
    entry.as_object_mut().expect("mcpServers was just made an object")
}

/// Parsed `mcpSettings` block (tool-call timeout etc.), defaults when absent.
pub fn read_settings() -> McpSettings {
    read_config(&default_data_folder())
        .get("mcpSettings")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// All configured servers (excluding the desktop-only browser bridge), sorted by
/// name so the picker order is stable.
pub fn list_servers() -> Vec<McpServerEntry> {
    list_servers_in(&default_data_folder())
}

/// `list_servers` against an explicit data folder (used by tests).
pub fn list_servers_in(data_folder: &std::path::Path) -> Vec<McpServerEntry> {
    let cfg = read_config(data_folder);
    let Some(servers) = cfg.get("mcpServers").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut out: Vec<McpServerEntry> = servers
        .iter()
        .filter(|(name, _)| name.as_str() != BROWSER_MCP_NAME)
        .map(|(name, config)| McpServerEntry {
            name: name.clone(),
            active: extract_active_status(config).unwrap_or(false),
            config: config.clone(),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Persist a server's `active` flag back to `mcp_config.json` (pretty-printed,
/// atomic tmp+rename) so the choice survives across CLI sessions.
pub fn set_active(name: &str, active: bool) -> Result<(), String> {
    set_active_in(&default_data_folder(), name, active)
}

fn set_active_in(data_folder: &std::path::Path, name: &str, active: bool) -> Result<(), String> {
    let mut cfg = load_config(data_folder)?;
    let entry = servers_map_mut(&mut cfg)
        .get_mut(name)
        .ok_or_else(|| format!("server '{name}' not found in mcp_config.json"))?;
    entry
        .as_object_mut()
        .ok_or_else(|| format!("config for '{name}' is not an object"))?
        .insert("active".to_string(), Value::Bool(active));

    write_config(data_folder, &cfg)
}

/// The whole `mcp_config.json` document, `Null` when absent or unreadable.
/// For the headless web server, which edits the file as the desktop UI does.
pub fn read_config_document() -> Value {
    read_config(&default_data_folder())
}

/// Atomically replace the whole `mcp_config.json` document.
pub fn write_config_document(cfg: &Value) -> Result<(), String> {
    write_config(&default_data_folder(), cfg)
}

/// Validate a server entry shape, reporting the missing field rather than the
/// generic "invalid MCP config" a connect would otherwise surface. Matches the
/// desktop's transport contract: `command`+`args` for stdio, or `type`+`url`
/// for http/sse.
pub fn validate_config(config: &Value) -> Result<(), String> {
    let obj = config
        .as_object()
        .ok_or_else(|| "server config must be a JSON object".to_string())?;
    let transport = obj.get("type").and_then(Value::as_str).unwrap_or("stdio");
    match transport {
        "http" | "sse" => {
            if obj.get("url").and_then(Value::as_str).is_none() {
                return Err(format!("server of type '{transport}' needs a 'url'"));
            }
            oauth::declared_scopes(config).map_err(|e| e.message().to_string())?;
        }
        "stdio" => {
            if obj.contains_key("oauth") {
                return Err("OAuth applies to http/sse servers only".to_string());
            }
            if obj.get("command").and_then(Value::as_str).is_none() {
                return Err("stdio server needs a 'command'".to_string());
            }
            if !obj.get("args").is_some_and(Value::is_array) {
                return Err("stdio server needs an 'args' array (may be empty)".to_string());
            }
        }
        other => {
            return Err(format!(
                "unknown transport '{other}' (expected stdio, http, or sse)"
            ));
        }
    }
    Ok(())
}

/// Validate a server name: non-empty and not the desktop-only browser bridge.
pub fn validate_server_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("server name cannot be empty".to_string());
    }
    if name == BROWSER_MCP_NAME {
        return Err(format!(
            "'{name}' is the desktop-only browser bridge and cannot be edited from the CLI"
        ));
    }
    Ok(())
}

/// Build a ready-to-persist server entry from typed fields, mirroring the
/// desktop's transport contract. `env`/`headers` are already parsed maps; the
/// callers (`flint cli mcp add` flags and the TUI form) both funnel through here
/// so neither re-implements the shape or its validation.
// Mirrors the fields of one configured server; a struct for them would be
// a second copy of the config type.
#[allow(clippy::too_many_arguments)]
pub fn build_server_config(
    transport: &str,
    command: Option<&str>,
    args: Vec<String>,
    env: serde_json::Map<String, Value>,
    url: Option<&str>,
    headers: serde_json::Map<String, Value>,
    active: bool,
    scopes: Vec<String>,
) -> Result<Value, String> {
    let mut config = serde_json::json!({ "type": transport, "active": active });
    if !scopes.is_empty() {
        config["oauth"] = serde_json::json!({ "scopes": scopes });
    }
    match transport {
        "stdio" => {
            let command = command
                .ok_or_else(|| "stdio server needs a 'command' (e.g. npx, uvx)".to_string())?;
            config["command"] = Value::String(command.to_string());
            config["args"] = serde_json::json!(args);
            config["env"] = Value::Object(env);
        }
        "http" | "sse" => {
            let url = url.ok_or_else(|| format!("server of type '{transport}' needs a 'url'"))?;
            config["url"] = Value::String(url.to_string());
            if !headers.is_empty() {
                config["headers"] = Value::Object(headers);
            }
        }
        other => {
            return Err(format!(
                "unknown transport '{other}' (expected stdio, http, or sse)"
            ));
        }
    }
    validate_config(&config)?;
    Ok(config)
}

/// Add or replace a server entry (by name) in `mcp_config.json`, preserving any
/// existing `active` and other keys when the name is already present. Does not
/// touch the live connection -- the caller decides whether to connect.
pub fn upsert_server(name: &str, config: &Value) -> Result<(), String> {
    upsert_server_in(&default_data_folder(), name, config)
}

fn upsert_server_in(
    data_folder: &std::path::Path,
    name: &str,
    config: &Value,
) -> Result<(), String> {
    validate_server_name(name)?;
    validate_config(config)?;
    let mut cfg = load_config(data_folder)?;
    let servers = servers_map_mut(&mut cfg);
    let existing_active = servers.get(name).and_then(|c| c.get("active")).cloned();
    let mut entry = config.clone();
    // Preserve the previous active flag on edit unless the new config sets one,
    // so editing a server never silently disables it.
    if entry.get("active").is_none() {
        if let Some(active) = existing_active {
            entry["active"] = active;
        }
    }
    servers.insert(name.to_string(), entry);
    write_config(data_folder, &cfg)
}

/// Remove a server entry by name from `mcp_config.json`. Errors if absent. Does
/// not disconnect a live transport -- the caller decides.
pub fn remove_server(name: &str) -> Result<(), String> {
    remove_server_in(&default_data_folder(), name)
}

fn remove_server_in(data_folder: &std::path::Path, name: &str) -> Result<(), String> {
    validate_server_name(name)?;
    let mut cfg = load_config(data_folder)?;
    let removed = servers_map_mut(&mut cfg).remove(name).is_some();
    if !removed {
        return Err(format!("server '{name}' not found in mcp_config.json"));
    }
    write_config(data_folder, &cfg)
}

/// Read one server entry by name (excluding the browser bridge), `None` when
/// absent. Used by the edit path to prefill a form.
pub fn get_server(name: &str) -> Option<McpServerEntry> {
    get_server_in(&default_data_folder(), name)
}

fn get_server_in(data_folder: &std::path::Path, name: &str) -> Option<McpServerEntry> {
    let cfg = read_config(data_folder);
    let servers = cfg.get("mcpServers")?.as_object()?;
    let config = servers.get(name)?;
    if name == BROWSER_MCP_NAME {
        return None;
    }
    Some(McpServerEntry {
        name: name.to_string(),
        active: extract_active_status(config).unwrap_or(false),
        config: config.clone(),
    })
}

/// Split a `KEY=VALUE` pair, rejecting anything without a separator or an empty
/// key. Shared by the headless `flint cli mcp add` flags and the TUI add/edit form
/// so the two surfaces parse `--env`/`--header` identically.
pub fn split_kv(kv: &str, what: &str) -> Result<(String, String), String> {
    match kv.split_once('=') {
        Some((k, v)) if !k.trim().is_empty() => Ok((k.trim().to_string(), v.to_string())),
        _ => Err(format!("--{what} must be KEY=VALUE, got '{kv}'")),
    }
}

/// Parse a whitespace-separated argument string into a list, trimming empty
/// runs. No shell quoting: the TUI form takes plain, already-split arguments.
pub fn parse_args(s: &str) -> Vec<String> {
    s.split_whitespace().map(str::to_string).collect()
}

/// Parse comma-separated `KEY=VALUE` pairs into a JSON object map. Empty input
/// yields an empty map; a malformed pair surfaces the first error.
pub fn parse_pairs(s: &str, what: &str) -> Result<serde_json::Map<String, Value>, String> {
    let mut map = serde_json::Map::new();
    for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (k, v) = split_kv(part, what)?;
        map.insert(k, Value::String(v));
    }
    Ok(map)
}

/// Why a connect failed, when the difference changes what the user should do.
///
/// A missing binary and an unauthorized remote both surface as "failed to
/// connect" from the transport, but only one of them is fixed by signing in --
/// so the distinction is carried in the type rather than left for the UI to
/// guess from an error string.
#[derive(Debug)]
pub enum ConnectError {
    /// The server advertises OAuth and there are no usable credentials for it.
    /// `/mcp` turns this into an `Authenticate` action.
    NeedsAuth {
        server: String,
        detail: String,
    },
    Failed(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NeedsAuth { server, detail } => {
                write!(f, "'{server}' needs authentication: {detail}")
            }
            Self::Failed(e) => f.write_str(e),
        }
    }
}

impl ConnectError {
    pub fn needs_auth(&self) -> bool {
        matches!(self, Self::NeedsAuth { .. })
    }
}

impl From<String> for ConnectError {
    fn from(e: String) -> Self {
        Self::Failed(e)
    }
}

/// Connect one server and insert it into the shared map. Best-effort: a bad
/// transport/config returns `Err` without touching the map.
///
/// For http/sse this is where OAuth is applied: stored credentials (refreshed
/// if stale) are wrapped around the base client so every request carries the
/// bearer token. When there are none and the connect fails, the server is asked
/// whether it advertises OAuth at all, which is what separates
/// `ConnectError::NeedsAuth` from an ordinary transport failure.
pub async fn connect(
    name: &str,
    config: &Value,
    servers: &SharedMcpServers,
) -> Result<(), ConnectError> {
    connect_in(&default_data_folder(), name, config, servers).await
}

async fn connect_in(
    data_folder: &std::path::Path,
    name: &str,
    config: &Value,
    servers: &SharedMcpServers,
) -> Result<(), ConnectError> {
    if name == BROWSER_MCP_NAME {
        return Err(ConnectError::Failed(
            "Jan Browser MCP is desktop-only".to_string(),
        ));
    }
    let params = extract_command_args(config)
        .ok_or_else(|| ConnectError::Failed(format!("invalid MCP config for '{name}'")))?;

    let service =
        match (params.transport_type.as_deref(), params.url.as_deref()) {
            (Some(transport @ ("http" | "sse")), Some(url)) => {
                crate::core::mcp::netguard::enforce_url(url).map_err(ConnectError::Failed)?;
                let pin = crate::core::mcp::netguard::preflight_url(url)
                    .await
                    .map_err(ConnectError::Failed)?;
                let base = http_client(&params.headers, &pin)?;
                // A credential problem we can already name (expired with no refresh
                // token, or issued for a different url) is `NeedsAuth` outright --
                // there is no point attempting a connect we know is unauthorized.
                let auth = oauth::authorized_client(data_folder, name, url, config, base.clone())
                    .await
                    .map_err(|detail| ConnectError::NeedsAuth {
                        server: name.to_string(),
                        detail: detail.to_string(),
                    })?;
                let authorized = auth.is_some();
                // rmcp 3.x dropped the SSE client transport (MCP deprecated
                // HTTP+SSE for Streamable HTTP), so a legacy `sse` config
                // connects over the streamable-http client instead.
                if transport == "sse" {
                    log::warn!(
                        "MCP server '{name}' uses the deprecated 'sse' transport; \
                         connecting over Streamable HTTP instead"
                    );
                }
                let result = match auth {
                    Some(client) => serve_http(client, url, name).await,
                    None => serve_http(base, url, name).await,
                };
                match result {
                    Ok(service) => service,
                    // Only worth probing when we did not already send a token: a
                    // failure *with* credentials is either a real outage or tokens
                    // the provider revoked, and `advertises_oauth` cannot tell the
                    // difference. Re-authenticating is offered from `/mcp` anyway.
                    Err(e) if !authorized && oauth::advertises_oauth(url).await => {
                        // The transport error is kept: a server can advertise OAuth
                        // *and* have failed for an unrelated reason, and dropping
                        // the cause would report that as "needs authentication".
                        return Err(ConnectError::NeedsAuth {
                            server: name.to_string(),
                            detail: format!("no credentials are stored ({e})"),
                        });
                    }
                    Err(e) => return Err(ConnectError::Failed(e)),
                }
            }
            _ => {
                // The CLI shares `extract_command_args` with the desktop, so an
                // imported definition can reach here too. It goes through the same
                // capability: there is no second, unconfined way to start a local
                // MCP server.
                let build = || {
                    // A bare `npx`/`uvx` is a `.cmd` shim on Windows, which
                    // CreateProcessW will not find by name (#224).
                    let mut cmd = Command::new(crate::core::mcp::launch::launchable_program(&params.command));
                    #[cfg(windows)]
                    {
                        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
                    }
                    #[cfg(unix)]
                    {
                        cmd.process_group(0);
                    }
                    cmd.kill_on_drop(true);
                    // Flint's own gateway/worker keys are not the server's to read.
                    jan_process::WithoutAppSecrets::without_app_secrets(&mut cmd);
                    for arg in params.args.iter().filter_map(Value::as_str) {
                        cmd.arg(arg);
                    }
                    for (k, v) in params.envs.iter() {
                        if let Some(v) = v.as_str() {
                            cmd.env(k, v);
                        }
                    }
                    cmd
                };
                let launch = crate::core::mcp::launch::ConfinedMcpLaunch::prepare(&params, build)
                    .map_err(ConnectError::Failed)?;
                // AH-140: stderr is kept -- line by line into the server's own
                // log -- rather than discarded, so "why did it stop" has an
                // answer from the CLI too.
                let (process, stderr) = launch
                    .spawn(Stdio::piped())
                    .map_err(|e| ConnectError::Failed(format!("failed to spawn '{name}': {e}")))?;
                if let Some(stderr) = stderr {
                    let server = name.to_string();
                    let folder = data_folder.to_path_buf();
                    tokio::spawn(async move {
                        let mut reader = tokio::io::BufReader::new(stderr);
                        while let Some(line) = read_capped_line(&mut reader, STDERR_LINE_CAP).await {
                            crate::core::mcp::server_log::append(&folder, &server, &line);
                        }
                    });
                }
                // A server that starts but never answers `initialize` must not
                // hang the whole agent run; dropping the future kills it.
                let served = tokio::time::timeout(CONNECT_TIMEOUT, ().serve(process))
                    .await
                    .map_err(|_| {
                        ConnectError::Failed(format!(
                            "'{name}' did not complete the MCP handshake within {}s",
                            CONNECT_TIMEOUT.as_secs()
                        ))
                    })?;
                RunningServiceEnum::NoInit(served.map_err(|e| {
                    ConnectError::Failed(format!("failed to connect to '{name}': {e}"))
                })?)
            }
        };

    servers.lock().await.insert(name.to_string(), service);
    Ok(())
}

/// Serve the streamable-http transport over any client that implements it, so
/// the plain and OAuth-wrapped clients share one code path instead of the
/// transport construction being written out twice.
async fn serve_http<C>(client: C, url: &str, name: &str) -> Result<RunningServiceEnum, String>
where
    C: StreamableHttpClient + Send + Sync + 'static,
{
    let transport = StreamableHttpClientTransport::with_client(
        client,
        StreamableHttpClientTransportConfig::with_uri(url.to_string()),
    );
    let served = tokio::time::timeout(CONNECT_TIMEOUT, client_info().serve(transport))
        .await
        .map_err(|_| {
            format!(
                "'{name}' did not complete the MCP handshake within {}s",
                CONNECT_TIMEOUT.as_secs()
            )
        })?;
    Ok(RunningServiceEnum::WithInit(
        served.map_err(|e| format!("failed to connect to '{name}': {e}"))?,
    ))
}

/// Upper bound for the MCP `initialize` handshake of one server.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

fn client_info() -> ClientInfo {
    ClientInfo::new(
        ClientCapabilities::default(),
        Implementation::new("Flint CLI Client", "0.0.1"),
    )
}

/// Build a reqwest client that sends the configured `headers` on every request
/// (http auth). Non-string header names/values are skipped. Uses `reqwest13`
/// because rmcp's streamable-http transport is implemented for reqwest 0.13;
/// apply13 keeps Flint's custom-CA TLS trust (AH-190) on it.
fn http_client(
    headers: &serde_json::Map<String, Value>,
    pin: &crate::core::mcp::netguard::Pin,
) -> Result<reqwest13::Client, String> {
    let mut map = reqwest13::header::HeaderMap::new();
    for (key, value) in headers.iter() {
        if let Some(v) = value.as_str() {
            // Trimmed: a trailing newline from a pasted token is invalid in a
            // header value and would drop the header (and the credential) silently.
            match (
                reqwest13::header::HeaderName::from_bytes(key.as_bytes()),
                reqwest13::header::HeaderValue::from_str(v.trim()),
            ) {
                (Ok(name), Ok(val)) => {
                    map.insert(name, val);
                }
                // Named, never valued: the value may be a secret.
                _ => log::warn!("MCP header '{key}' is not valid and was skipped"),
            }
        }
    }
    crate::core::mcp::netguard::mcp_client13(
        reqwest13::Client::builder()
            .default_headers(map)
            .connect_timeout(std::time::Duration::from_secs(15))
            .read_timeout(std::time::Duration::from_secs(300)),
        pin,
    )
        .build()
        .map_err(|e| e.to_string())
}

/// Remove a server from the shared map and cancel its transport.
pub async fn disconnect(name: &str, servers: &SharedMcpServers) {
    let service = servers.lock().await.remove(name);
    match service {
        Some(RunningServiceEnum::NoInit(s)) => {
            let _ = s.cancel().await;
        }
        Some(RunningServiceEnum::WithInit(s)) => {
            let _ = s.cancel().await;
        }
        None => {}
    }
}

/// The `mcp_config.json` a server is declared in. Surfaced by the `/mcp` detail
/// screen: "where do I edit this by hand" is otherwise unanswerable from the UI.
pub fn config_file_path() -> PathBuf {
    config_path(&default_data_folder())
}

/// This server's OAuth state, without touching the network.
pub fn auth_status(name: &str, config: &Value) -> oauth::AuthStatus {
    oauth::status(&default_data_folder(), name, config)
}

/// The same, with the declared, requested and granted scopes, for display.
pub fn auth_status_info(name: &str, config: &Value) -> oauth::AuthStatusInfo {
    oauth::status_info(&default_data_folder(), name, config)
}

/// Forget one server's stored tokens. `Ok(false)` when there were none.
pub fn clear_auth(name: &str) -> Result<bool, String> {
    oauth::clear(&default_data_folder(), name)
}

/// Start an interactive authorization for a configured http/sse server. The
/// caller owns opening the browser and awaiting `PendingAuth::complete`.
pub async fn begin_auth(name: &str) -> Result<oauth::PendingAuth, String> {
    let entry =
        get_server(name).ok_or_else(|| format!("server '{name}' not found in mcp_config.json"))?;
    let url = entry
        .config
        .get("url")
        .and_then(Value::as_str)
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| {
            format!("'{name}' is a stdio server - OAuth applies to http/sse servers only")
        })?;
    let scopes = oauth::declared_scopes(&entry.config).map_err(|e| e.message().to_string())?;
    oauth::begin(name, url, &scopes).await
}

/// Finish an authorization by persisting the tokens it produced.
pub async fn finish_auth(pending: oauth::PendingAuth) -> Result<oauth::StoredCredentials, String> {
    pending.complete(&default_data_folder()).await
}

/// Everything the `/mcp` detail screen shows about one server. Split from the
/// tool list on purpose: all of this is local (config plus the cached
/// `initialize` response), so the screen opens without a round trip and the
/// tool list arrives separately.
pub struct ServerDetail {
    pub name: String,
    pub active: bool,
    pub connected: bool,
    pub transport: String,
    /// The url for http/sse, or `command args` for stdio.
    pub endpoint: String,
    pub config_path: PathBuf,
    pub auth: oauth::AuthStatus,
    /// Capability names the server advertised, in a stable display order.
    pub capabilities: Vec<&'static str>,
    /// `name version` from the server's `initialize` response, when connected.
    pub implementation: Option<String>,
}

/// Snapshot one server for the detail screen. `None` when the name is no longer
/// in the config (deleted from another surface while the picker was open).
pub async fn describe(name: &str, servers: &SharedMcpServers) -> Option<ServerDetail> {
    let entry = get_server(name)?;
    let cfg = &entry.config;
    let transport = cfg
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("stdio")
        .to_string();
    let endpoint = if transport == "stdio" {
        let command = cfg.get("command").and_then(Value::as_str).unwrap_or("");
        let args: Vec<&str> = cfg
            .get("args")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        if args.is_empty() {
            command.to_string()
        } else {
            format!("{command} {}", args.join(" "))
        }
    } else {
        cfg.get("url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };

    // The lock is held only for the cached `initialize` response; nothing here
    // goes to the network, so the render loop is never parked on a peer.
    let peer = servers.lock().await.get(name).and_then(|s| s.peer_info());
    let connected = peer.is_some();
    let mut capabilities = Vec::new();
    let mut implementation = None;
    if let Some(peer) = peer {
        let caps = &peer.capabilities;
        for (present, label) in [
            (caps.tools.is_some(), "tools"),
            (caps.resources.is_some(), "resources"),
            (caps.prompts.is_some(), "prompts"),
            (caps.logging.is_some(), "logging"),
            (caps.completions.is_some(), "completions"),
        ] {
            if present {
                capabilities.push(label);
            }
        }
        implementation = peer
            .server_info
            .as_ref()
            .map(|si| format!("{} {}", si.name, si.version));
    }

    Some(ServerDetail {
        auth: auth_status(name, cfg),
        name: entry.name,
        active: entry.active,
        connected,
        transport,
        endpoint,
        config_path: config_file_path(),
        capabilities,
        implementation,
    })
}

/// The tool names a connected server exposes, for the detail screen's `Tools:`
/// line and its `View tools` action. `Err` when the server is not connected or
/// the listing round trip fails.
///
/// This is the one part of the detail screen that talks to the peer, which is
/// why it is a separate call: the caller runs it off the render loop.
///
/// The round trip is bounded by `tool_call_timeout_duration`, as every other
/// `list_all_tools` call site is: the guard is the process-wide server map that
/// each agent turn also locks, so a peer that accepts the request and never
/// answers would otherwise stall turns and not just this screen.
pub async fn list_tools(name: &str, servers: &SharedMcpServers) -> Result<Vec<String>, String> {
    let timeout_duration = read_settings().tool_call_timeout_duration();
    let guard = servers.lock().await;
    let service = guard
        .get(name)
        .ok_or_else(|| format!("'{name}' is not connected"))?;
    let mut names: Vec<String> = tokio::time::timeout(timeout_duration, service.list_all_tools())
        .await
        .map_err(|_| {
            format!(
                "listing tools for '{name}' timed out after {}s",
                timeout_duration.as_secs()
            )
        })?
        .map_err(|e| format!("could not list tools for '{name}': {e}"))?
        .into_iter()
        .map(|t| t.name.to_string())
        .collect();
    names.sort();
    Ok(names)
}

/// The prompts a connected server offers (AH-138).
///
/// Bounded by the same timeout every other round trip to a peer uses: the
/// guard here is the process-wide server map that each agent turn also locks,
/// so a peer that accepts a request and never answers would stall turns and
/// not just this call.
pub async fn list_prompts(name: &str, servers: &SharedMcpServers) -> Result<Vec<String>, String> {
    let timeout_duration = read_settings().tool_call_timeout_duration();
    let guard = servers.lock().await;
    let service = guard
        .get(name)
        .ok_or_else(|| format!("'{name}' is not connected"))?;
    let prompts = tokio::time::timeout(timeout_duration, service.list_all_prompts())
        .await
        .map_err(|_| {
            format!(
                "listing prompts for '{name}' timed out after {}s",
                timeout_duration.as_secs()
            )
        })?
        .map_err(|e| format!("could not list prompts for '{name}': {e}"))?;
    let mut lines: Vec<String> = prompts
        .into_iter()
        .map(|p| match p.description {
            Some(description) if !description.is_empty() => format!("{} — {description}", p.name),
            _ => p.name.to_string(),
        })
        .collect();
    lines.sort();
    Ok(lines)
}

/// One prompt from a connected server, filled in (AH-138).
///
/// What comes back is the server's content, labelled by role. It is handed on
/// as a message, the way a person pasting it would -- never merged into the
/// harness's own instructions.
pub async fn get_prompt(
    name: &str,
    prompt: &str,
    arguments: serde_json::Map<String, Value>,
    servers: &SharedMcpServers,
) -> Result<String, String> {
    let timeout_duration = read_settings().tool_call_timeout_duration();
    let guard = servers.lock().await;
    let service = guard
        .get(name)
        .ok_or_else(|| format!("'{name}' is not connected"))?;
    let mut prompt_params = rmcp::model::GetPromptRequestParams::new(prompt.to_string());
    if !arguments.is_empty() {
        prompt_params = prompt_params.with_arguments(arguments);
    }
    let result = tokio::time::timeout(
        timeout_duration,
        service.get_prompt(prompt_params),
    )
    .await
    .map_err(|_| {
        format!(
            "asking '{name}' for prompt '{prompt}' timed out after {}s",
            timeout_duration.as_secs()
        )
    })?
    .map_err(|e| format!("could not get prompt '{prompt}' from '{name}': {e}"))?;
    Ok(crate::core::mcp::models::render_prompt(&result))
}

/// Number of servers marked `active` in `mcp_config.json`.
pub fn active_count() -> usize {
    list_servers().iter().filter(|e| e.active).count()
}

/// Outcome of a best-effort connect of every `active` server.
///
/// Failures are returned rather than logged: the TUI owns the terminal while
/// this runs, so a `log::warn!` here paints raw text over the alternate screen.
/// The caller decides how to surface them (the TUI notes them in the
/// transcript alongside the ready line; headless logs them as before).
#[derive(Debug, Default)]
pub struct ConnectOutcome {
    /// Servers that came up, in the order they connected.
    pub connected: Vec<String>,
    /// One `failed to connect to '<name>': <error>` per server that didn't.
    pub failed: Vec<String>,
    /// Servers that are up to the user to sign into, kept apart from `failed`
    /// so the caller can point at `/mcp` instead of repeating a transport error
    /// nobody can act on.
    pub needs_auth: Vec<String>,
}

/// Connect every `active` server into the shared map, best-effort.
pub async fn connect_active(servers: &SharedMcpServers) -> ConnectOutcome {
    let mut out = ConnectOutcome::default();
    for entry in list_servers().into_iter().filter(|e| e.active) {
        match connect(&entry.name, &entry.config, servers).await {
            Ok(()) => out.connected.push(entry.name),
            Err(ConnectError::NeedsAuth { server, .. }) => out.needs_auth.push(server),
            Err(e) => out.failed.push(e.to_string()),
        }
    }
    out
}

/// Longest stderr line kept for a server's log; the rest of the line is read
/// and dropped, so a server writing megabytes without a newline cannot grow
/// the CLI's memory.
const STDERR_LINE_CAP: usize = 8 * 1024;

/// Next line (without the newline), cut to `cap` bytes; `None` at end of
/// stream or on a read error.
async fn read_capped_line<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R, cap: usize) -> Option<String> {
    use tokio::io::AsyncBufReadExt;
    let mut kept: Vec<u8> = Vec::new();
    let mut cut = false;
    let mut read_any = false;
    loop {
        let buf = reader.fill_buf().await.ok()?;
        if buf.is_empty() {
            break;
        }
        read_any = true;
        let (chunk, used, done) = match buf.iter().position(|&b| b == b'\n') {
            Some(i) => (&buf[..i], i + 1, true),
            None => (buf, buf.len(), false),
        };
        let room = cap.saturating_sub(kept.len());
        if chunk.len() > room {
            cut = true;
        }
        kept.extend_from_slice(&chunk[..chunk.len().min(room)]);
        reader.consume(used);
        if done {
            break;
        }
    }
    if !read_any {
        return None;
    }
    if kept.last() == Some(&b'\r') {
        kept.pop();
    }
    let mut line = String::from_utf8_lossy(&kept).into_owned();
    if cut {
        line.push_str(" ...(truncated)");
    }
    Some(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stderr_lines_are_capped_without_buffering_the_whole_line() {
        let mut data = vec![b'x'; 1 << 20];
        data.extend_from_slice(b"\nnext\r\nlast");
        let mut reader = tokio::io::BufReader::new(&data[..]);
        let first = read_capped_line(&mut reader, 16).await.unwrap();
        assert_eq!(first, format!("{} ...(truncated)", "x".repeat(16)));
        assert_eq!(read_capped_line(&mut reader, 16).await.unwrap(), "next");
        assert_eq!(read_capped_line(&mut reader, 16).await.unwrap(), "last");
        assert!(read_capped_line(&mut reader, 16).await.is_none());
    }

    /// A temporary data folder with a fresh config path, cleaned up on drop.
    fn temp_data() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn upsert_creates_and_preserves_active_on_edit() {
        let data = temp_data();
        let folder = data.path();
        let cfg = serde_json::json!({
            "command": "npx",
            "args": ["-y", "server"],
        });
        upsert_server_in(folder, "files", &cfg).unwrap();

        let entry = get_server_in(folder, "files").unwrap();
        assert_eq!(entry.name, "files");
        assert!(!entry.active);

        // Mark active, then edit again: active must survive.
        set_active_in(folder, "files", true).unwrap();
        upsert_server_in(
            folder,
            "files",
            &serde_json::json!({
                "command": "npx",
                "args": ["-y", "server2"],
            }),
        )
        .unwrap();
        let entry = get_server_in(folder, "files").unwrap();
        assert!(entry.active, "editing must not clear the active flag");
        assert_eq!(entry.config["args"][1], "server2");
    }

    #[test]
    fn upsert_rejects_bad_shape_and_browser_name() {
        let data = temp_data();
        let folder = data.path();
        // Missing command.
        assert!(upsert_server_in(folder, "x", &serde_json::json!({ "args": [] })).is_err());
        // Missing args.
        assert!(upsert_server_in(folder, "x", &serde_json::json!({ "command": "npx" })).is_err());
        // Unknown transport.
        assert!(upsert_server_in(
            folder,
            "x",
            &serde_json::json!({ "type": "bogus", "url": "http://x" })
        )
        .is_err());
        // Desktop-only browser bridge.
        assert!(upsert_server_in(
            folder,
            BROWSER_MCP_NAME,
            &serde_json::json!({ "command": "npx", "args": [] })
        )
        .is_err());
    }

    #[test]
    fn http_and_sse_validate_by_url() {
        let data = temp_data();
        let folder = data.path();
        let http = serde_json::json!({ "type": "http", "url": "https://x/mcp" });
        assert!(validate_config(&http).is_ok());
        upsert_server_in(folder, "http", &http).unwrap();

        let sse_no_url = serde_json::json!({ "type": "sse" });
        let err = validate_config(&sse_no_url).unwrap_err();
        assert!(err.contains("url"), "{err}");
        assert!(upsert_server_in(folder, "sse", &sse_no_url).is_err());
    }

    #[test]
    fn remove_deletes_and_errors_when_absent() {
        let data = temp_data();
        let folder = data.path();
        upsert_server_in(
            folder,
            "files",
            &serde_json::json!({ "command": "npx", "args": [] }),
        )
        .unwrap();
        remove_server_in(folder, "files").unwrap();
        assert!(get_server_in(folder, "files").is_none());

        let err = remove_server_in(folder, "files").unwrap_err();
        assert!(err.contains("not found"), "{err}");
    }

    #[test]
    fn write_config_ensures_top_level_keys() {
        let data = temp_data();
        let folder = data.path();
        // A caller passing a bare servers object still gets a valid doc.
        write_config(folder, &serde_json::json!({ "mcpServers": {} })).unwrap();
        let raw = std::fs::read_to_string(config_path(folder)).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(doc.get("mcpServers").is_some());
        assert!(doc.get("mcpSettings").is_some());
    }

    #[test]
    fn mutators_refuse_to_overwrite_an_unparsable_config() {
        let data = temp_data();
        let folder = data.path();
        let bad = "{\"mcpServers\":{\"a\":{\"command\":\"x\",\"env\":{\"KEY\":\"secret\"}}},}";
        std::fs::write(config_path(folder), bad).unwrap();
        let cfg = serde_json::json!({ "command": "echo", "args": [] });
        let err = upsert_server_in(folder, "b", &cfg).unwrap_err();
        assert!(err.contains("mcp_config.json"), "error names the file: {err}");
        assert!(set_active_in(folder, "a", true).is_err());
        assert!(remove_server_in(folder, "a").is_err());
        assert_eq!(std::fs::read_to_string(config_path(folder)).unwrap(), bad);
    }

    #[test]
    fn mutators_refuse_a_non_object_root() {
        let data = temp_data();
        let folder = data.path();
        std::fs::write(config_path(folder), "[1,2]").unwrap();
        assert!(upsert_server_in(folder, "b", &serde_json::json!({ "command": "echo", "args": [] })).is_err());
        assert_eq!(std::fs::read_to_string(config_path(folder)).unwrap(), "[1,2]");
    }

    #[test]
    fn missing_file_still_creates_the_config() {
        let data = temp_data();
        let folder = data.path();
        upsert_server_in(folder, "b", &serde_json::json!({ "command": "echo", "args": [] })).unwrap();
        assert!(config_path(folder).is_file());
    }

    #[test]
    fn write_config_keeps_a_backup_of_the_previous_file() {
        let data = temp_data();
        let folder = data.path();
        write_config(folder, &serde_json::json!({ "mcpServers": { "a": {} } })).unwrap();
        let first = std::fs::read_to_string(config_path(folder)).unwrap();
        write_config(folder, &serde_json::json!({ "mcpServers": {} })).unwrap();
        let bak = std::fs::read_to_string(config_path(folder).with_extension("json.bak")).unwrap();
        assert_eq!(bak, first);
    }

    #[test]
    fn write_config_creates_a_missing_data_folder() {
        let data = temp_data();
        let folder = data.path().join("fresh").join("install");
        write_config(&folder, &serde_json::json!({})).unwrap();
        assert!(config_path(&folder).is_file());
    }

    #[cfg(unix)]
    #[test]
    fn write_config_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let data = temp_data();
        let folder = data.path();
        // A stale tmp file with loose bits must not leak into the result.
        let tmp = config_path(folder).with_extension("json.tmp");
        std::fs::write(&tmp, "x").unwrap();
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_config(folder, &serde_json::json!({ "mcpServers": {} })).unwrap();
        let mode = std::fs::metadata(config_path(folder)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn list_filters_browser_and_orders_by_name() {
        let data = temp_data();
        let folder = data.path();
        upsert_server_in(
            folder,
            "zeta",
            &serde_json::json!({ "command": "npx", "args": [] }),
        )
        .unwrap();
        upsert_server_in(
            folder,
            "alpha",
            &serde_json::json!({ "command": "npx", "args": [] }),
        )
        .unwrap();
        write_config(
            folder,
            &serde_json::json!({
                "mcpServers": {
                    "zeta": { "command": "npx", "args": [] },
                    "alpha": { "command": "npx", "args": [] },
                }
            }),
        )
        .and_then(|_| {
            // Seed the browser bridge directly (upsert refuses it).
            let mut cfg = read_config(folder);
            servers_map_mut(&mut cfg).insert(
                BROWSER_MCP_NAME.to_string(),
                serde_json::json!({ "command": "npx", "args": [] }),
            );
            write_config(folder, &cfg)
        })
        .unwrap();

        let names: Vec<String> = list_servers_in(folder)
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, vec!["alpha", "zeta"]);
    }

    #[test]
    fn split_kv_and_parse_pairs() {
        assert_eq!(
            split_kv("K=V", "env").unwrap(),
            ("K".to_string(), "V".to_string())
        );
        assert!(split_kv("novalue", "env").is_err());
        assert!(split_kv("=V", "header").is_err());

        let map = parse_pairs("A=1,B=2", "env").unwrap();
        assert_eq!(map.get("A").and_then(Value::as_str), Some("1"));
        assert_eq!(map.get("B").and_then(Value::as_str), Some("2"));
        assert!(parse_pairs("A=1,broken", "env").is_err());
        assert!(parse_pairs("", "env").unwrap().is_empty());
        assert_eq!(parse_args("npx  -y  my-mcp"), vec!["npx", "-y", "my-mcp"]);
    }

    #[test]
    fn browser_mcp_excluded_and_sorted() {
        // list_servers reads the real data folder; assert only invariants that
        // hold regardless of installed config.
        let servers = list_servers();
        assert!(servers.iter().all(|s| s.name != BROWSER_MCP_NAME));
        for w in servers.windows(2) {
            assert!(w[0].name <= w[1].name);
        }
    }
}

// ---- trust ----

/// The fingerprint of the definition saved for `name`, which is what a grant
/// binds to. `None` when no such server is configured.
pub fn saved_fingerprint(name: &str) -> Option<String> {
    get_server(name).map(|entry| tauri_plugin_agent_tools::mcp_identity::fingerprint(&entry.config))
}

/// One standing grant, as `mcp trust-report` lists it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustRow {
    pub name: String,
    pub granted_at: String,
    /// `current` when the server is configured as approved, `changed` when its
    /// definition has changed since (the grant no longer applies), `missing`
    /// when no server by this name is configured.
    pub state: &'static str,
}

/// Standing grants and the approvals that stopped applying, with why.
pub fn trust_report(data_folder: &std::path::Path) -> (Vec<TrustRow>, Vec<(String, String, String)>) {
    let rows = tauri_plugin_agent_tools::mcp_trust::trusted(data_folder)
        .into_iter()
        .map(|g| {
            let state = match list_servers_in(data_folder)
                .into_iter()
                .find(|e| e.name == g.name)
                .map(|e| tauri_plugin_agent_tools::mcp_identity::fingerprint(&e.config))
            {
                Some(fp) if fp == g.fingerprint => "current",
                Some(_) => "changed",
                None => "missing",
            };
            TrustRow { name: g.name, granted_at: g.granted_at, state }
        })
        .collect();
    let invalidated = tauri_plugin_agent_tools::mcp_trust::invalidated(data_folder)
        .into_iter()
        .map(|i| (i.name, i.reason, i.at))
        .collect();
    (rows, invalidated)
}

/// Trust `name` as currently configured, for every conversation, until revoked.
pub fn trust_server(data_folder: &std::path::Path, name: &str) -> Result<String, String> {
    let fingerprint = list_servers_in(data_folder)
        .into_iter()
        .find(|e| e.name == name)
        .map(|e| tauri_plugin_agent_tools::mcp_identity::fingerprint(&e.config))
        .ok_or_else(|| format!("MCP server '{name}' is not configured, so it cannot be trusted"))?;
    tauri_plugin_agent_tools::mcp_trust::trust(data_folder, name, &fingerprint)?;
    Ok(fingerprint)
}

/// Withdraw trust from `name`. Returns whether a grant was removed.
pub fn revoke_server(data_folder: &std::path::Path, name: &str) -> Result<bool, String> {
    tauri_plugin_agent_tools::mcp_trust::revoke(
        data_folder,
        name,
        tauri_plugin_agent_tools::mcp_trust::RevokeReason::User,
    )
}

#[cfg(test)]
mod trust_tests {
    use super::*;

    #[test]
    fn trust_binds_to_the_definition_and_a_change_ends_it() {
        crate::core::app::commands::with_temp_data_folder(|data| {
            assert!(trust_server(data, "ghost").is_err());
            upsert_server("demo", &serde_json::json!({ "command": "node", "args": ["a.js"], "active": true })).unwrap();
            let fp = trust_server(data, "demo").unwrap();
            assert_eq!(Some(fp), saved_fingerprint("demo"));
            let (rows, _) = trust_report(data);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].state, "current");

            upsert_server("demo", &serde_json::json!({ "command": "node", "args": ["b.js"], "active": true })).unwrap();
            assert_eq!(trust_report(data).0[0].state, "changed");

            assert!(revoke_server(data, "demo").unwrap());
            assert!(trust_report(data).0.is_empty());
        });
    }
}
