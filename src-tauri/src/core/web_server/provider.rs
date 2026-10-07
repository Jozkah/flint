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
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_stream::StreamExt;

use super::server::{read_json_value, reply, text, Resp};
use crate::core::net::transport::{self, ChunkSink, ProviderRequest, StreamChunk};

/// Writes each chunk as one JSON line. When the browser disconnects the
/// receiver is gone, so the upstream request is cancelled rather than read
/// into nothing.
struct LineSink {
    tx: mpsc::UnboundedSender<Bytes>,
    stream_id: Option<String>,
}

impl ChunkSink for LineSink {
    fn send(&self, chunk: StreamChunk) {
        let Ok(mut line) = serde_json::to_vec(&chunk) else {
            return;
        };
        line.push(b'\n');
        if self.tx.send(Bytes::from(line)).is_err() {
            if let Some(id) = &self.stream_id {
                transport::cancel_stream(id);
            }
        }
    }
}

fn valid_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

pub async fn stream(req: Request<Incoming>) -> Resp {
    let value = match read_json_value(req).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let Ok(request) = serde_json::from_value::<ProviderRequest>(value) else {
        return text(StatusCode::BAD_REQUEST, "Invalid provider request");
    };
    if !valid_url(&request.url) {
        return text(StatusCode::BAD_REQUEST, "Provider URL must be http or https");
    }
    let (tx, rx) = mpsc::unbounded_channel::<Bytes>();
    let sink = LineSink {
        tx,
        stream_id: request.stream_id.clone(),
    };
    tokio::spawn(async move {
        // Failures are reported to the browser as an `error` chunk by the
        // transport; the returned error only repeats it.
        let _ = transport::send_stream(request, sink).await;
    });
    let body = StreamBody::new(
        UnboundedReceiverStream::new(rx).map(|bytes| Ok::<_, Infallible>(Frame::data(bytes))),
    );
    let mut response = Response::new(body.boxed_unsync());
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, "application/x-ndjson".parse().unwrap());
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert("x-accel-buffering", "no".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
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
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sink = LineSink { tx, stream_id: None };
        sink.send(StreamChunk::Data { b64: "aGk=".into() });
        sink.send(StreamChunk::End);
        let first = rx.try_recv().unwrap();
        assert_eq!(first.as_ref(), b"{\"kind\":\"data\",\"b64\":\"aGk=\"}\n");
        assert_eq!(rx.try_recv().unwrap().as_ref(), b"{\"kind\":\"end\"}\n");
    }

    #[test]
    fn only_http_urls_are_dialled() {
        assert!(valid_url("https://api.example.com/v1"));
        assert!(valid_url("http://127.0.0.1:8080"));
        assert!(!valid_url("file:///etc/passwd"));
        assert!(!valid_url("ftp://example.com"));
    }
}
