//! A minimal Chrome DevTools Protocol client over one WebSocket, in flat
//! session mode: a command names the session (tab, frame, worker) it is for,
//! and events say which session they came from.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

#[derive(Debug, Clone)]
pub struct Event {
    pub method: String,
    pub params: Value,
    pub session_id: Option<String>,
}

#[derive(Clone)]
pub struct Cdp {
    out: mpsc::UnboundedSender<String>,
    pending: Pending,
    next: Arc<AtomicU64>,
    /// Set by the reader before it drains `pending`: a later call must not wait.
    closed: Arc<AtomicBool>,
}

/// The longest any one command may wait for its answer.
const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Connect to a browser's DevTools endpoint. Events arrive on the returned
/// receiver, which ends when the browser closes the connection.
pub async fn connect(ws_url: &str) -> Result<(Cdp, mpsc::UnboundedReceiver<Event>), String> {
    // Our own browser on loopback only: never follow anything else.
    if !ws_url.starts_with("ws://127.0.0.1:") && !ws_url.starts_with("ws://localhost:") {
        return Err(format!("unexpected DevTools endpoint {ws_url}"));
    }
    let (socket, _) = tokio_tungstenite::connect_async(ws_url)
        .await
        .map_err(|e| format!("could not connect to the browser: {e}"))?;
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let (ev_tx, ev_rx) = mpsc::unbounded_channel::<Event>();
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));

    tokio::spawn(async move {
        while let Some(text) = out_rx.recv().await {
            if sink.send(Message::text(text)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let closed = Arc::new(AtomicBool::new(false));
    let reader_closed = closed.clone();
    let reader_pending = pending.clone();
    tokio::spawn(async move {
        while let Some(msg) = stream.next().await {
            let text = match msg {
                Ok(Message::Text(t)) => t.as_str().to_owned(),
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(_) => continue,
            };
            let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
            if let Some(id) = v.get("id").and_then(Value::as_u64) {
                let waiter = reader_pending.lock().ok().and_then(|mut p| p.remove(&id));
                if let Some(waiter) = waiter {
                    let result = match v.get("error") {
                        Some(err) => Err(err
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("DevTools error")
                            .to_string()),
                        None => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    let _ = waiter.send(result);
                }
            } else if let Some(method) = v.get("method").and_then(Value::as_str) {
                let _ = ev_tx.send(Event {
                    method: method.to_string(),
                    params: v.get("params").cloned().unwrap_or(Value::Null),
                    session_id: v.get("sessionId").and_then(Value::as_str).map(str::to_string),
                });
            }
        }
        // The browser is gone: every caller still waiting gets an answer.
        reader_closed.store(true, Ordering::SeqCst);
        if let Ok(mut p) = reader_pending.lock() {
            for (_, waiter) in p.drain() {
                let _ = waiter.send(Err("the browser closed".to_string()));
            }
        }
    });

    Ok((
        Cdp { out: out_tx, pending, next: Arc::new(AtomicU64::new(1)), closed },
        ev_rx,
    ))
}

impl Cdp {
    fn frame(&self, id: u64, method: &str, params: Value, session: Option<&str>) -> String {
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = Value::String(s.to_string());
        }
        msg.to_string()
    }

    /// Send a command and wait for its answer.
    pub async fn call(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        if let Ok(mut p) = self.pending.lock() {
            p.insert(id, tx);
        }
        // The reader may have drained between the insert and now: nobody
        // would ever answer this waiter.
        if self.closed.load(Ordering::SeqCst) {
            self.forget(id);
            return Err("the browser closed".to_string());
        }
        if self.out.send(self.frame(id, method, params, session)).is_err() {
            self.forget(id);
            return Err("the browser closed".to_string());
        }
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(r) => r.unwrap_or_else(|_| Err("the browser closed".to_string())),
            Err(_) => {
                self.forget(id);
                Err(format!("the browser did not answer {method} in time"))
            }
        }
    }

    fn forget(&self, id: u64) {
        if let Ok(mut p) = self.pending.lock() {
            p.remove(&id);
        }
    }

    /// Send a command without waiting (used from the event loop, which must
    /// not block on the browser it is answering).
    pub fn fire(&self, method: &str, params: Value, session: Option<&str>) {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let _ = self.out.send(self.frame(id, method, params, session));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cdp_call_after_close_errors() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
            let _ = ws.close(None).await;
        });
        let (cdp, _events) = connect(&format!("ws://127.0.0.1:{port}/x")).await.unwrap();
        for _ in 0..100 {
            if cdp.closed.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let r = tokio::time::timeout(std::time::Duration::from_secs(5), cdp.call("Page.enable", json!({}), None)).await;
        assert!(matches!(r, Ok(Err(_))), "call after close must fail fast, got {r:?}");
        assert!(cdp.pending.lock().unwrap().is_empty());
    }
}
