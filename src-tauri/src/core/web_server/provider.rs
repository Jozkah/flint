//! Browser access to Flint's provider transport.
//!
//! The desktop app sends every provider request through
//! `core::net::transport`, which owns endpoint resolution, snapshots and
//! redaction. A browser cannot call most provider APIs directly (CORS), so it
//! posts the same request description here and reads the answer back as
//! newline-delimited `StreamChunk` JSON, the shape the desktop channel carries.

use std::convert::Infallible;

use http_body_util::{BodyExt, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::{header, Request, Response, StatusCode};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

use super::server::{read_json_value, read_json_value_max, reply, text, Resp, MAX_LARGE_JSON_BODY};
use crate::core::net::transport::{self, ChunkSink, ProviderRequest, StreamChunk};

/// Lines buffered for a browser that reads slower than the model writes. A
/// reader that falls this far behind is dropped instead of letting the queue
/// grow without bound.
const QUEUE_LINES: usize = 256;

/// Writes each chunk as one JSON line. When the browser disconnects the
/// receiver is gone, so the upstream request is cancelled rather than read
/// into nothing. The same happens when the queue is full: the reader is too
/// slow to keep up, and a chunk is never dropped from the middle of a stream.
struct LineSink {
    tx: mpsc::Sender<Bytes>,
    stream_id: String,
}

impl ChunkSink for LineSink {
    fn send(&self, chunk: StreamChunk) {
        let Ok(mut line) = serde_json::to_vec(&chunk) else {
            return;
        };
        line.push(b'\n');
        if self.tx.try_send(Bytes::from(line)).is_err() {
            transport::cancel_stream(&self.stream_id);
        }
    }
}

/// Cancels the upstream request when the response body is dropped (the
/// browser disconnected) while the transport still holds the sender, i.e.
/// the request is still running. A stream that already ended is left alone.
struct CancelOnDrop {
    stream_id: String,
    running: mpsc::WeakSender<Bytes>,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.running.upgrade().is_some() {
            transport::cancel_stream(&self.stream_id);
        }
    }
}

/// The id the relay cancels by. A client that sent none still gets one, so
/// its request stops when it disconnects like one that did.
fn relay_stream_id(requested: &mut Option<String>) -> String {
    requested
        .get_or_insert_with(|| format!("relay-{}", uuid::Uuid::new_v4()))
        .clone()
}

const KEEPALIVE: std::time::Duration = std::time::Duration::from_secs(15);

fn valid_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

pub async fn stream(req: Request<Incoming>) -> Resp {
    let value = match read_json_value_max(req, MAX_LARGE_JSON_BODY).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let Ok(mut request) = serde_json::from_value::<ProviderRequest>(value) else {
        return text(StatusCode::BAD_REQUEST, "Invalid provider request");
    };
    if !valid_url(&request.url) {
        return text(StatusCode::BAD_REQUEST, "Provider URL must be http or https");
    }
    let (tx, rx) = mpsc::channel::<Bytes>(QUEUE_LINES);
    let keepalive = tx.downgrade();
    let stream_id = relay_stream_id(&mut request.stream_id);
    let keepalive_stream = stream_id.clone();
    let guard = CancelOnDrop {
        stream_id: stream_id.clone(),
        running: tx.downgrade(),
    };
    let sink = LineSink { tx, stream_id };
    // A line every few seconds keeps proxies and phone radios from dropping a
    // stream that is only waiting on the model. The ticker holds a weak sender,
    // so it ends with the stream instead of keeping it open.
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(KEEPALIVE);
        tick.tick().await;
        loop {
            tick.tick().await;
            let Some(tx) = keepalive.upgrade() else { break };
            // A full queue already has data in it, so a missed ping costs
            // nothing; only a closed one ends the ticker.
            if let Err(mpsc::error::TrySendError::Closed(_)) =
                tx.try_send(Bytes::from_static(b"{\"kind\":\"ping\"}\n"))
            {
                // The browser went away while the model was silent: stop the
                // upstream request too instead of letting it run on.
                transport::cancel_stream(&keepalive_stream);
                break;
            }
        }
    });
    tokio::spawn(async move {
        // Failures are reported to the browser as an `error` chunk by the
        // transport; the returned error only repeats it.
        let _ = transport::send_stream(request, sink).await;
    });
    let body = StreamBody::new(
        ReceiverStream::new(rx).map(move |bytes| {
            // Owned by the body: dropped (and checked) when the body is.
            let _ = &guard;
            Ok::<_, Infallible>(Frame::data(bytes))
        }),
    );
    let mut response = Response::new(body.boxed_unsync());
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, "application/x-ndjson".parse().unwrap());
    super::server::add_security_headers(headers);
    headers.insert("x-accel-buffering", "no".parse().unwrap());
    response
}

pub async fn cancel(req: Request<Incoming>) -> Resp {
    let value = match read_json_value(req).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(id) = value.get("streamId").and_then(serde_json::Value::as_str) {
        transport::cancel_stream(id);
    }
    reply(StatusCode::NO_CONTENT, "text/plain", Bytes::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sink_writes_one_json_line_per_chunk() {
        let (tx, mut rx) = mpsc::channel(8);
        let sink = LineSink { tx, stream_id: "lines".into() };
        sink.send(StreamChunk::Data { b64: "aGk=".into() });
        sink.send(StreamChunk::End);
        let first = rx.try_recv().unwrap();
        assert_eq!(first.as_ref(), b"{\"kind\":\"data\",\"b64\":\"aGk=\"}\n");
        assert_eq!(rx.try_recv().unwrap().as_ref(), b"{\"kind\":\"end\"}\n");
    }

    #[test]
    fn web_provider_stream_bounded_backpressure() {
        let (tx, mut rx) = mpsc::channel(2);
        let sink = LineSink {
            tx,
            stream_id: "slow-reader".into(),
        };
        for _ in 0..5 {
            sink.send(StreamChunk::Data { b64: "aGk=".into() });
        }
        // Nothing past the bound is queued while the reader is not reading.
        assert!(rx.try_recv().is_ok());
        assert!(rx.try_recv().is_ok());
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn a_request_without_a_stream_id_gets_its_own() {
        let mut none = None;
        let a = relay_stream_id(&mut none);
        assert_eq!(none.as_deref(), Some(a.as_str()));
        assert_ne!(a, relay_stream_id(&mut None));
        let mut given = Some("mine".to_string());
        assert_eq!(relay_stream_id(&mut given), "mine");
    }

    /// The browser going away while the request still runs cancels it; a
    /// body dropped after the request ended does not.
    #[test]
    fn dropping_the_body_cancels_only_a_running_request() {
        let (tx, _rx) = mpsc::channel::<Bytes>(1);
        drop(CancelOnDrop { stream_id: "relay-drop-test-running".into(), running: tx.downgrade() });
        assert!(transport::take_early_cancel_for_test("relay-drop-test-running"));
        let weak = tx.downgrade();
        drop(tx);
        drop(CancelOnDrop { stream_id: "relay-drop-test-ended".into(), running: weak });
        assert!(!transport::take_early_cancel_for_test("relay-drop-test-ended"));
    }

    /// The stream carries the same security headers as every other API reply.
    #[test]
    fn the_stream_response_has_the_api_security_headers() {
        let mut headers = hyper::HeaderMap::new();
        super::super::server::add_security_headers(&mut headers);
        for name in ["content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy", "cache-control"] {
            assert!(headers.contains_key(name), "{name}");
        }
        assert_eq!(headers["x-frame-options"], "DENY");
    }

    #[test]
    fn only_http_urls_are_dialled() {
        assert!(valid_url("https://api.example.com/v1"));
        assert!(valid_url("http://127.0.0.1:8080"));
        assert!(!valid_url("file:///etc/passwd"));
        assert!(!valid_url("ftp://example.com"));
    }
}
