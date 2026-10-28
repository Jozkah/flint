//! Server-to-browser events: the stream the Tauri event bus is on desktop.
//!
//! Model load progress and engine faults are published here and delivered to
//! every signed-in page as server-sent events (`GET /api/v1/events`). Delivery
//! is best effort and live only: a page that was not connected misses what was
//! published, as a window that was not listening would on desktop.

use std::convert::Infallible;
use std::time::Duration;

use http_body_util::{BodyExt, StreamBody};
use hyper::body::{Bytes, Frame};
use hyper::{header, Response};
use serde::Serialize;
use tauri_plugin_llamacpp::commands::{LoadProgressPayload, ProgressSink};
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

use super::server::Resp;

const KEEPALIVE: Duration = Duration::from_secs(15);
const BACKLOG: usize = 256;

/// Frames queued for one SSE client before it counts as stalled.
pub(super) const SSE_QUEUE: usize = 256;
/// Longest a replay write may wait for a client that is not reading.
pub(super) const SSE_WRITE_TIMEOUT: Duration = Duration::from_secs(30);

/// Queues one live frame. False when the stream must end: the client is gone,
/// or its queue is full. A full queue gets a last `event: gap` (one slot is
/// kept free for it) and then ends, so the client reconnects with
/// `Last-Event-ID` and resumes from the ring instead of the server queueing
/// without limit.
pub(super) fn offer(tx: &mpsc::Sender<Bytes>, chunk: Bytes) -> bool {
    if tx.capacity() > 1 {
        return tx.try_send(chunk).is_ok();
    }
    let _ = tx.try_send(Bytes::from_static(
        b"event: gap\ndata: {\"reason\":\"slow-client\"}\n\n",
    ));
    false
}

/// Queues one frame of the opening replay, waiting for room (the replay can
/// be longer than the queue) but not past [`SSE_WRITE_TIMEOUT`]. False when
/// the stream must end.
pub(super) async fn put(tx: &mpsc::Sender<Bytes>, chunk: Bytes) -> bool {
    matches!(
        tokio::time::timeout(SSE_WRITE_TIMEOUT, tx.send(chunk)).await,
        Ok(Ok(()))
    )
}

#[derive(Clone)]
pub struct Bus {
    sender: broadcast::Sender<String>,
}

impl Default for Bus {
    fn default() -> Self {
        Self::new()
    }
}

impl Bus {
    pub fn new() -> Self {
        Self {
            sender: broadcast::channel(BACKLOG).0,
        }
    }

    /// Tell every connected page. Nobody listening is not an error.
    pub fn publish(&self, event: &str, payload: &impl Serialize) {
        let Ok(payload) = serde_json::to_value(payload) else {
            return;
        };
        let line = serde_json::json!({ "event": event, "payload": payload }).to_string();
        let _ = self.sender.send(line);
    }

    fn subscribe(&self) -> broadcast::Receiver<String> {
        self.sender.subscribe()
    }
}

/// Model load progress, published as the event the desktop app emits.
impl ProgressSink for Bus {
    fn load_progress(&self, payload: LoadProgressPayload) {
        self.publish("llamacpp-model-load-progress", &payload);
    }
}

/// The event stream for one page. Ends when the page goes away.
pub fn stream(bus: &Bus) -> Resp {
    let mut events = bus.subscribe();
    let (tx, rx) = mpsc::channel::<Bytes>(SSE_QUEUE);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(KEEPALIVE);
        tick.tick().await;
        if !put(&tx, Bytes::from_static(b": connected\n\n")).await {
            return;
        }
        loop {
            let chunk = tokio::select! {
                received = events.recv() => match received {
                    Ok(line) => Bytes::from(format!("data: {line}\n\n")),
                    // A slow page fell behind and missed some; keep going.
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                _ = tick.tick() => Bytes::from_static(b": keepalive\n\n"),
            };
            if !offer(&tx, chunk) {
                break;
            }
        }
    });
    let body = StreamBody::new(
        ReceiverStream::new(rx).map(|bytes| Ok::<_, Infallible>(Frame::data(bytes))),
    );
    let mut response = Response::new(body.boxed_unsync());
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, "text/event-stream".parse().unwrap());
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert("x-accel-buffering", "no".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn published_events_reach_subscribers_as_json_lines() {
        let bus = Bus::new();
        let mut rx = bus.subscribe();
        bus.load_progress(LoadProgressPayload {
            model: "m1".into(),
            stage: Some("text_model".into()),
            stages: vec!["text_model".into()],
            value: 0.5,
        });
        let line = rx.recv().await.unwrap();
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["event"], "llamacpp-model-load-progress");
        assert_eq!(value["payload"]["model"], "m1");
        assert_eq!(value["payload"]["value"], 0.5);
    }

    #[tokio::test]
    async fn sse_slow_client_dropped_after_queue_full() {
        let (tx, mut rx) = mpsc::channel::<Bytes>(SSE_QUEUE);
        // A client that never reads: the queue fills, one slot stays free.
        let mut accepted = 0;
        while offer(&tx, Bytes::from_static(b"data: x\n\n")) {
            accepted += 1;
            assert!(accepted < SSE_QUEUE, "queue must be bounded");
        }
        assert_eq!(accepted, SSE_QUEUE - 1);
        drop(tx);
        // What the client can still read ends with the gap marker, then EOF.
        let mut frames = Vec::new();
        while let Some(f) = rx.recv().await {
            frames.push(f);
        }
        assert_eq!(frames.len(), SSE_QUEUE);
        assert!(frames.last().unwrap().starts_with(b"event: gap"));
    }

    #[tokio::test]
    async fn sse_gap_frame_keeps_last_event_id() {
        // No `id:` line, so the browser's Last-Event-ID stays at the last
        // real event and the reconnect resumes from there.
        let (tx, mut rx) = mpsc::channel::<Bytes>(2);
        assert!(offer(&tx, Bytes::from_static(b"id: 7\ndata: x\n\n")));
        assert!(!offer(&tx, Bytes::from_static(b"id: 8\ndata: y\n\n")));
        let _ = rx.recv().await;
        let gap = rx.recv().await.unwrap();
        assert!(!String::from_utf8_lossy(&gap).contains("id:"));
        assert!(put(&tx, Bytes::from_static(b": ok\n\n")).await);
    }

    #[test]
    fn publishing_with_no_listener_is_harmless() {
        Bus::new().publish("anything", &serde_json::json!({ "a": 1 }));
    }
}
