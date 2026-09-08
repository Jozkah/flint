//! The provider transport, over IPC.
//!
//! The web app talks to OpenAI-compatible providers through these commands
//! rather than through a fetch of its own, so model discovery, chat completion,
//! embeddings, health checks and connection tests all share one endpoint
//! resolution and one set of diagnostics.

use serde::Serialize;
use tauri::ipc::Channel;

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

#[tauri::command]
pub async fn provider_http_request(request: ProviderRequest) -> Result<ProviderResponse, String> {
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
