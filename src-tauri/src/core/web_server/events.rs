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
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_stream::StreamExt;

use super::server::Resp;

const KEEPALIVE: Duration = Duration::from_secs(15);
const BACKLOG: usize = 256;

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
    let (tx, rx) = mpsc::unbounded_channel::<Bytes>();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(KEEPALIVE);
        tick.tick().await;
        if tx.send(Bytes::from_static(b": connected\n\n")).is_err() {
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
            if tx.send(chunk).is_err() {
                break;
            }
        }
    });
    let body = StreamBody::new(
        UnboundedReceiverStream::new(rx).map(|bytes| Ok::<_, Infallible>(Frame::data(bytes))),
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

    #[test]
    fn publishing_with_no_listener_is_harmless() {
        Bus::new().publish("anything", &serde_json::json!({ "a": 1 }));
    }
}
