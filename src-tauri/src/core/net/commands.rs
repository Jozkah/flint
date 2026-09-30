//! The provider transport, over IPC.
//!
//! The web app talks to OpenAI-compatible providers through these commands
//! rather than through a fetch of its own, so model discovery, chat completion,
//! embeddings, health checks and connection tests all share one endpoint
//! resolution and one set of diagnostics.

use serde::Serialize;
use tauri::{ipc::Channel, Runtime};

use super::resolver;
use super::transport::{self, ChunkSink, ProviderRequest, ProviderResponse, StreamChunk};

/// One resolved address, as shown in provider diagnostics.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateView {
    pub address: String,
    pub class: String,
    pub eligible: bool,
}

/// What happened when this endpoint was last resolved. Contains no credentials:
/// it is built from the hostname and the resolver's answers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointDiagnostics {
    pub host: String,
    pub port: u16,
    /// Whether the name is treated as local, which is what enables suppression.
    pub local_name: bool,
    pub candidates: Vec<CandidateView>,
    pub selected: Option<String>,
    pub suppressed_public: bool,
    /// The address that actually answered, once one has.
    pub responded: Option<String>,
}

struct ChannelSink(Channel<StreamChunk>);

impl ChunkSink for ChannelSink {
    fn send(&self, chunk: StreamChunk) {
        // A closed channel means the webview navigated away mid-stream; there
        // is nothing to do about it and nothing worth failing the request for.
        let _ = self.0.send(chunk);
    }
}

fn internal_response(body: serde_json::Value) -> Result<ProviderResponse, String> {
    Ok(ProviderResponse {
        status: 200,
        status_text: "OK".to_string(),
        headers: std::collections::HashMap::new(),
        body: serde_json::to_string(&body).map_err(|e| e.to_string())?,
        peer: None,
        snapshot: None,
    })
}

fn body_json(request: &ProviderRequest) -> Result<serde_json::Value, String> {
    request
        .body
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| format!("Invalid Hugging Face request: {e}"))?
        .ok_or_else(|| "Missing Hugging Face request body".to_string())
}

fn body_string<'a>(body: &'a serde_json::Value, key: &str) -> Result<&'a str, String> {
    body.get(key)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("Missing Hugging Face field: {key}"))
}

fn optional_string(body: &serde_json::Value, key: &str) -> Option<String> {
    body.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
}

/// Explicit-only bridge for the model Hub. It deliberately uses a `flint://`
/// pseudo URL so ordinary provider traffic can never fall into it by accident.
/// No startup path calls these actions; opening/searching/downloading in Hub is
/// the user's network consent boundary.
async fn huggingface_bridge<R: Runtime>(
    app: tauri::AppHandle<R>,
    request: &ProviderRequest,
) -> Result<Option<ProviderResponse>, String> {
    const PREFIX: &str = "flint://huggingface/";
    let Some(action) = request.url.strip_prefix(PREFIX) else {
        return Ok(None);
    };
    let body = body_json(request)?;
    let token = optional_string(&body, "token");
    let value = match action {
        "search" => {
            let query = body
                .get("query")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string();
            let format = optional_string(&body, "format");
            serde_json::to_value(
                crate::core::huggingface::huggingface_search_models(query, format, token).await?,
            )
            .map_err(|e| e.to_string())?
        }
        "files" => {
            let repo = body_string(&body, "repo")?.to_string();
            serde_json::to_value(
                crate::core::huggingface::huggingface_model_files(repo, token).await?,
            )
            .map_err(|e| e.to_string())?
        }
        "readme" => {
            let repo = body_string(&body, "repo")?.to_string();
            serde_json::Value::String(
                crate::core::huggingface::huggingface_readme(repo, token).await?,
            )
        }
        "download" => {
            let task_id = body_string(&body, "taskId")?.to_string();
            let repo = body_string(&body, "repo")?.to_string();
            let filename = body_string(&body, "filename")?.to_string();
            let expected_size = body.get("expectedSize").and_then(serde_json::Value::as_u64);
            let expected_sha256 = optional_string(&body, "expectedSha256");
            let path = crate::core::huggingface::huggingface_download_model(
                app,
                task_id,
                repo,
                filename,
                expected_size,
                expected_sha256,
                token,
            )
            .await?;
            serde_json::Value::String(path)
        }
        "cancel" => {
            let task_id = body_string(&body, "taskId")?.to_string();
            crate::core::huggingface::huggingface_cancel_download(task_id).await?;
            serde_json::Value::Null
        }
        _ => return Err(format!("Unknown Hugging Face action: {action}")),
    };
    internal_response(value).map(Some)
}

#[tauri::command]
pub async fn provider_http_request<R: Runtime>(
    app: tauri::AppHandle<R>,
    request: ProviderRequest,
) -> Result<ProviderResponse, String> {
    if let Some(response) = huggingface_bridge(app, &request).await? {
        return Ok(response);
    }
    transport::send(request).await
}

#[tauri::command]
pub async fn provider_http_stream(
    request: ProviderRequest,
    channel: Channel<StreamChunk>,
) -> Result<(), String> {
    transport::send_stream(request, ChannelSink(channel)).await
}

/// Stop a stream whose consumer has gone.
#[tauri::command]
pub fn provider_http_cancel(stream_id: String) {
    transport::cancel_stream(&stream_id);
}

/// What was resolved for an endpoint, for the provider details surface.
#[tauri::command]
pub fn provider_endpoint_diagnostics(
    host: String,
    port: u16,
) -> Result<Option<EndpointDiagnostics>, String> {
    Ok(resolver::shared().peek(&host, port).map(|r| {
        let selected = r.selected().map(|a| a.ip().to_string());
        EndpointDiagnostics {
            host: r.host,
            port: r.port,
            local_name: r.local_name,
            candidates: r
                .candidates
                .iter()
                .map(|c| CandidateView {
                    address: c.addr.ip().to_string(),
                    class: c.class.as_str().to_string(),
                    eligible: c.eligible,
                })
                .collect(),
            selected,
            suppressed_public: r.suppressed_public,
            responded: r.responded.map(|a| a.ip().to_string()),
        }
    }))
}

/// Forget what was resolved: a provider was edited, the network moved, or the
/// user asked for a fresh attempt. Omitting the host clears everything.
#[tauri::command]
pub fn provider_endpoint_refresh(host: Option<String>, port: Option<u16>) {
    match (host, port) {
        (Some(host), Some(port)) => transport::invalidate(&host, port),
        _ => transport::invalidate_all(),
    }
}

/// What the configured CA bundle does right now (AH-190).
#[tauri::command]
pub fn network_ca_status() -> serde_json::Value {
    super::tls::status()
}

/// Check a bundle path before it is saved, so the settings page can say what
/// it would do. Nothing is stored here: the page saves the path itself, and the
/// next outbound client built reads it from the settings.
#[tauri::command]
pub fn network_ca_check(path: String) -> serde_json::Value {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return serde_json::json!({ "state": "none" });
    }
    match super::tls::load(std::path::Path::new(trimmed), super::tls::Source::DesktopSettings) {
        Ok(bundle) => serde_json::json!({
            "state": "in_use",
            "path": bundle.path.display().to_string(),
            "certificates": bundle.fingerprints.len(),
            "sha256": bundle.fingerprints,
        }),
        Err(error) => serde_json::json!({
            "state": "broken",
            "kind": error.kind.tag(),
            "path": error.path.display().to_string(),
            "message": error.message,
        }),
    }
}
