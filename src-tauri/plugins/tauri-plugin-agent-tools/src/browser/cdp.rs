//! A minimal Chrome DevTools Protocol client over one WebSocket or the
//! browser's debugging pipe, in flat session mode: a command names the session
//! (tab, frame, worker) it is for, and events say which session they came from.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
#[cfg(any(unix, test))]
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
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
    let (cdp, mut out_rx, inbound) = channels();

    tokio::spawn(async move {
        while let Some(text) = out_rx.recv().await {
            if sink.send(Message::text(text)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let (ev_tx, ev_rx) = mpsc::unbounded_channel::<Event>();
    tokio::spawn(async move {
        while let Some(msg) = stream.next().await {
            match msg {
                Ok(Message::Text(t)) => inbound.dispatch(t.as_str(), &ev_tx),
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(_) => continue,
            }
        }
        inbound.close();
    });

    Ok((cdp, ev_rx))
}

/// Speak DevTools over the browser's `--remote-debugging-pipe` channel:
/// `to_browser` is what the browser reads as fd 3, `from_browser` what it
/// writes as fd 4. Each message is one JSON text followed by a NUL byte. Unlike
/// a debugging port this leaves no listener that another local process (or a
/// sandboxed shell sharing the host network) could connect to. Used on Unix,
/// where the launcher can hand the browser fds 3 and 4.
#[cfg(any(unix, test))]
pub fn connect_pipe<W, R>(to_browser: W, from_browser: R) -> (Cdp, mpsc::UnboundedReceiver<Event>)
where
    W: AsyncWrite + Unpin + Send + 'static,
    R: AsyncRead + Unpin + Send + 'static,
{
    let (cdp, mut out_rx, inbound) = channels();

    tokio::spawn(async move {
        let mut writer = to_browser;
        while let Some(text) = out_rx.recv().await {
            let mut frame = text.into_bytes();
            frame.push(0);
            if writer.write_all(&frame).await.is_err() || writer.flush().await.is_err() {
                break;
            }
        }
        let _ = writer.shutdown().await;
    });

    let (ev_tx, ev_rx) = mpsc::unbounded_channel::<Event>();
    tokio::spawn(async move {
        let mut reader = BufReader::new(from_browser);
        let mut frame = Vec::new();
        loop {
            frame.clear();
            match reader.read_until(0, &mut frame).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if frame.last() == Some(&0) {
                frame.pop();
            }
            if let Ok(text) = std::str::from_utf8(&frame) {
                inbound.dispatch(text, &ev_tx);
            }
        }
        inbound.close();
    });

    (cdp, ev_rx)
}

/// The reader's half of a connection: answers waiting calls, forwards events,
/// and fails every waiter once the browser is gone.
struct Inbound {
    pending: Pending,
    closed: Arc<AtomicBool>,
}

impl Inbound {
    fn dispatch(&self, text: &str, events: &mpsc::UnboundedSender<Event>) {
        let Ok(v) = serde_json::from_str::<Value>(text) else { return };
        if let Some(id) = v.get("id").and_then(Value::as_u64) {
            let waiter = self.pending.lock().ok().and_then(|mut p| p.remove(&id));
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
            let _ = events.send(Event {
                method: method.to_string(),
                params: v.get("params").cloned().unwrap_or(Value::Null),
                session_id: v.get("sessionId").and_then(Value::as_str).map(str::to_string),
            });
        }
    }

    /// The browser is gone: every caller still waiting gets an answer.
    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(mut p) = self.pending.lock() {
            for (_, waiter) in p.drain() {
                let _ = waiter.send(Err("the browser closed".to_string()));
            }
        }
    }
}

/// A client, the queue its writer drains, and the reader's half.
fn channels() -> (Cdp, mpsc::UnboundedReceiver<String>, Inbound) {
    let (out_tx, out_rx) = mpsc::unbounded_channel::<String>();
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let closed = Arc::new(AtomicBool::new(false));
    let inbound = Inbound { pending: pending.clone(), closed: closed.clone() };
    (Cdp { out: out_tx, pending, next: Arc::new(AtomicU64::new(1)), closed }, out_rx, inbound)
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

    /// A fake browser on the far side of two in-memory pipes: it sends one
    /// event, then reads NUL-framed commands and answers each by id.
    #[tokio::test]
    async fn pipe_transport_frames_commands_and_answers_with_nul() {
        let (ours_w, theirs_r) = tokio::io::duplex(4096);
        let (theirs_w, ours_r) = tokio::io::duplex(4096);
        let browser = tokio::spawn(async move {
            let mut reader = BufReader::new(theirs_r);
            let mut writer = theirs_w;
            let event = json!({ "method": "Target.targetCreated", "params": { "x": 1 }, "sessionId": "s1" });
            let mut out = event.to_string().into_bytes();
            out.push(0);
            writer.write_all(&out).await.unwrap();
            let mut seen = Vec::new();
            let mut frame = Vec::new();
            while reader.read_until(0, &mut frame).await.unwrap() > 0 {
                assert_eq!(frame.pop(), Some(0), "every command ends with NUL");
                let v: Value = serde_json::from_slice(&frame).unwrap();
                seen.push(v["method"].as_str().unwrap().to_string());
                let reply = if v["method"] == "Bad.method" {
                    json!({ "id": v["id"], "error": { "message": "no such method" } })
                } else {
                    json!({ "id": v["id"], "result": { "echo": v["params"], "session": v["sessionId"] } })
                };
                let mut out = reply.to_string().into_bytes();
                out.push(0);
                writer.write_all(&out).await.unwrap();
                frame.clear();
                if seen.len() == 2 {
                    break;
                }
            }
            seen
        });
        let (cdp, mut events) = connect_pipe(ours_w, ours_r);
        let ev = events.recv().await.unwrap();
        assert_eq!(ev.method, "Target.targetCreated");
        assert_eq!(ev.session_id.as_deref(), Some("s1"));
        let ok = cdp.call("Page.enable", json!({ "a": 2 }), Some("s1")).await.unwrap();
        assert_eq!(ok["echo"]["a"], 2);
        assert_eq!(ok["session"], "s1");
        let err = cdp.call("Bad.method", json!({}), None).await.unwrap_err();
        assert_eq!(err, "no such method");
        assert_eq!(browser.await.unwrap(), vec!["Page.enable", "Bad.method"]);
        // The fake browser is gone (its pipe ends dropped): calls fail fast.
        for _ in 0..100 {
            if cdp.closed.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let r = tokio::time::timeout(std::time::Duration::from_secs(5), cdp.call("Page.enable", json!({}), None)).await;
        assert!(matches!(r, Ok(Err(_))), "call after the pipe closed must fail fast, got {r:?}");
    }
}
