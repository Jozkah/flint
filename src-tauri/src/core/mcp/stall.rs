//! Stuck MCP tool calls.
//!
//! A call that outlives its timeout used to be abandoned on our side only: the
//! server kept running the work, and a server that never answers kept being
//! handed new calls. Here the timeout is carried by the request itself, so rmcp
//! sends `notifications/cancelled` for it, and a server that times out
//! [`STALL_STOP_THRESHOLD`] calls in a row is reported as stalled so the caller
//! can stop it (lazy start brings it back on the next use).
//!
//! Tauri-free so the counting and the cancel round trip are unit tested.

use rmcp::model::{
    CallToolRequest, CallToolRequestParams, CallToolResult, CancelledNotification,
    CancelledNotificationParam, ClientRequest, ServerResult,
};
use rmcp::service::{PeerRequestOptions, ServiceError};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Consecutive timed-out calls after which a server is stopped.
pub const STALL_STOP_THRESHOLD: u32 = 3;

/// Longest per-server timeout accepted from a config.
const MAX_SERVER_TIMEOUT_SECS: u64 = 3600;

/// This server's own tool-call timeout (`toolCallTimeoutSeconds` in its
/// config), or `default` when it sets none.
pub fn server_timeout(config: Option<&Value>, default: Duration) -> Duration {
    config
        .and_then(|c| c.get("toolCallTimeoutSeconds"))
        .and_then(Value::as_u64)
        .filter(|s| *s > 0)
        .map(|s| Duration::from_secs(s.min(MAX_SERVER_TIMEOUT_SECS)))
        .unwrap_or(default)
}

/// The `mcpServers` entries saved in `<data folder>/mcp_config.json`.
pub fn read_server_configs(data_folder: &std::path::Path) -> serde_json::Map<String, Value> {
    std::fs::read_to_string(data_folder.join("mcp_config.json"))
        .ok()
        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        .and_then(|v| v.get("mcpServers").and_then(Value::as_object).cloned())
        .unwrap_or_default()
}

#[derive(Debug, PartialEq, Eq)]
pub enum CallFailure {
    /// No answer in time; the server was sent `notifications/cancelled`.
    TimedOut,
    /// The user cancelled; the server was sent `notifications/cancelled`.
    Cancelled,
    Other(String),
}

/// One `tools/call`, bounded by `timeout`. On expiry rmcp sends the server a
/// cancellation for this request id before returning.
pub async fn call_tool_cancellable(
    peer: &rmcp::Peer<rmcp::RoleClient>,
    params: CallToolRequestParams,
    timeout: Duration,
) -> Result<CallToolResult, CallFailure> {
    call_tool_until(peer, params, timeout, std::future::pending::<()>()).await
}

/// Like [`call_tool_cancellable`], and also ends when `cancel` resolves (a user
/// cancel): the server is then sent `notifications/cancelled` for this request,
/// the same as for a timeout, so it can stop the work.
pub async fn call_tool_until(
    peer: &rmcp::Peer<rmcp::RoleClient>,
    params: CallToolRequestParams,
    timeout: Duration,
    cancel: impl Future<Output = ()>,
) -> Result<CallToolResult, CallFailure> {
    let request = ClientRequest::CallToolRequest(CallToolRequest::new(params));
    let handle = peer
        .send_cancellable_request(request, PeerRequestOptions::with_timeout(timeout))
        .await
        .map_err(|e| CallFailure::Other(e.to_string()))?;
    let (request_peer, request_id) = (handle.peer.clone(), handle.id.clone());
    let response = {
        let wait = handle.await_response();
        tokio::pin!(wait);
        tokio::pin!(cancel);
        tokio::select! {
            r = &mut wait => Some(r),
            _ = &mut cancel => None,
        }
    };
    let response = match response {
        Some(r) => r,
        None => {
            let notice = CancelledNotification::new(CancelledNotificationParam::new(
                Some(request_id),
                Some("user cancelled".to_string()),
            ));
            let _ = request_peer.send_notification(notice.into()).await;
            return Err(CallFailure::Cancelled);
        }
    };
    match response {
        Ok(ServerResult::CallToolResult(result)) => Ok(result),
        Ok(_) => Err(CallFailure::Other(
            "unexpected response to tools/call".to_string(),
        )),
        Err(ServiceError::Timeout { .. }) => Err(CallFailure::TimedOut),
        Err(e) => Err(CallFailure::Other(e.to_string())),
    }
}

/// Consecutive timeouts per server. A completed call (any outcome but a
/// timeout) clears the count, so only a server that keeps stalling is stopped.
#[derive(Default)]
pub struct StallTracker {
    counts: Mutex<HashMap<String, u32>>,
}

impl StallTracker {
    /// Records a timeout; true when the server has now stalled enough to stop.
    pub fn record_timeout(&self, server: &str) -> bool {
        let mut counts = self.counts.lock().unwrap_or_else(|p| p.into_inner());
        let n = counts.entry(server.to_string()).or_insert(0);
        *n += 1;
        if *n >= STALL_STOP_THRESHOLD {
            counts.remove(server);
            true
        } else {
            false
        }
    }

    pub fn record_answered(&self, server: &str) {
        self.counts
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(server);
    }
}

pub fn tracker() -> &'static StallTracker {
    static TRACKER: OnceLock<StallTracker> = OnceLock::new();
    TRACKER.get_or_init(StallTracker::default)
}

/// Update the tracker with a finished call. Returns true when `server` should
/// be stopped now.
pub fn note_outcome<T>(server: &str, outcome: &Result<T, CallFailure>) -> bool {
    match outcome {
        Err(CallFailure::TimedOut) => tracker().record_timeout(server),
        _ => {
            tracker().record_answered(server);
            false
        }
    }
}

// ---- Stop hook for paths that hold no AppHandle ------------------------------

type StopFn = dyn Fn(String) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync;

static STOP_HOOK: OnceLock<Box<StopFn>> = OnceLock::new();

/// Installed by the desktop app at setup; stops one running server.
pub fn install_stop_hook(hook: Box<StopFn>) {
    let _ = STOP_HOOK.set(hook);
}

/// Stop a stalled server from a path that has no app handle. A no-op where no
/// hook is installed (CLI, tests).
pub async fn request_stop(server: &str) {
    if let Some(hook) = STOP_HOOK.get() {
        hook(server.to_string()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::{CallToolResponse, ContentBlock, ServerCapabilities, ServerInfo};
    use rmcp::service::RequestContext;
    use rmcp::{ErrorData as McpError, RoleServer, ServerHandler, ServiceExt};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// A server whose only tool never answers, and records being cancelled.
    struct Sleeper {
        cancelled: Arc<AtomicBool>,
    }

    impl ServerHandler for Sleeper {
        fn get_info(&self) -> ServerInfo {
            ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
        }

        async fn call_tool(
            &self,
            _request: CallToolRequestParams,
            context: RequestContext<RoleServer>,
        ) -> Result<CallToolResponse, McpError> {
            context.ct.cancelled().await;
            self.cancelled.store(true, Ordering::SeqCst);
            Ok(CallToolResult::success(vec![ContentBlock::text("late")]).into())
        }
    }

    #[test]
    fn a_server_override_wins_and_is_bounded() {
        let default = Duration::from_secs(30);
        assert_eq!(server_timeout(None, default), default);
        let cfg = serde_json::json!({"toolCallTimeoutSeconds": 120});
        assert_eq!(
            server_timeout(Some(&cfg), default),
            Duration::from_secs(120)
        );
        let zero = serde_json::json!({"toolCallTimeoutSeconds": 0});
        assert_eq!(server_timeout(Some(&zero), default), default);
        let huge = serde_json::json!({"toolCallTimeoutSeconds": 999999});
        assert_eq!(
            server_timeout(Some(&huge), default),
            Duration::from_secs(MAX_SERVER_TIMEOUT_SECS)
        );
        let junk = serde_json::json!({"toolCallTimeoutSeconds": "soon"});
        assert_eq!(server_timeout(Some(&junk), default), default);
    }

    #[test]
    fn only_consecutive_timeouts_stop_a_server() {
        let t = StallTracker::default();
        assert!(!t.record_timeout("a"));
        assert!(!t.record_timeout("a"));
        t.record_answered("a");
        assert!(!t.record_timeout("a"));
        assert!(!t.record_timeout("a"));
        assert!(t.record_timeout("a"));
        // The count restarts after a stop; another server is independent.
        assert!(!t.record_timeout("a"));
        assert!(!t.record_timeout("b"));
    }

    #[tokio::test]
    async fn a_timeout_sends_the_server_a_cancellation() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let server = Sleeper {
            cancelled: cancelled.clone(),
        };
        tokio::spawn(async move {
            let running = server.serve(server_io).await.expect("server starts");
            let _ = running.waiting().await;
        });
        let client = ().serve(client_io).await.expect("client starts");
        let peer = client.peer().clone();

        let started = std::time::Instant::now();
        let outcome = call_tool_cancellable(
            &peer,
            CallToolRequestParams::new("hang"),
            Duration::from_millis(300),
        )
        .await;
        assert_eq!(outcome.unwrap_err(), CallFailure::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5));

        // The server's handler sees the cancellation, not just our client
        // giving up.
        for _ in 0..50 {
            if cancelled.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            cancelled.load(Ordering::SeqCst),
            "server never saw notifications/cancelled"
        );
    }

    #[tokio::test]
    async fn a_user_cancel_sends_the_server_a_cancellation() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let server = Sleeper {
            cancelled: cancelled.clone(),
        };
        tokio::spawn(async move {
            let running = server.serve(server_io).await.expect("server starts");
            let _ = running.waiting().await;
        });
        let client = ().serve(client_io).await.expect("client starts");
        let peer = client.peer().clone();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let _ = tx.send(());
        });

        let started = std::time::Instant::now();
        let outcome = call_tool_until(
            &peer,
            CallToolRequestParams::new("hang"),
            Duration::from_secs(60),
            async {
                let _ = rx.await;
            },
        )
        .await;
        assert_eq!(outcome.unwrap_err(), CallFailure::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(5));
        for _ in 0..50 {
            if cancelled.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            cancelled.load(Ordering::SeqCst),
            "server never saw notifications/cancelled for a user cancel"
        );
    }
}
