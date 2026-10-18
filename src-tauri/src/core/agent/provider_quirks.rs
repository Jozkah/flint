//! Table-driven provider stream quirks. Every row is one SSE script a real
//! OpenAI-compatible server has been seen to send, with the completion the agent
//! loop must end up with. Each row runs through two parsers:
//!
//! * [`SseAccumulator`] -- the hand-written reassembler used for converted
//!   native wires (Anthropic/Gemini translated to chat chunks);
//! * the `genai` streamer behind `stream_chat_completions`, over a real
//!   socket, for rows where `wire` is true. The vendored `genai` is strict about
//!   JSON, so rows that corrupt a data line opt out of the wire run.
//!
//! A new quirk is one row; both parsers are held to it.

use super::*;
use serde_json::json;

struct Want {
    content: &'static str,
    reasoning: &'static str,
    /// (id, name, arguments-as-sent-back)
    calls: &'static [(&'static str, &'static str, &'static str)],
    finish: Option<&'static str>,
    total_tokens: Option<u64>,
}

const NONE: Want = Want {
    content: "",
    reasoning: "",
    calls: &[],
    finish: None,
    total_tokens: None,
};

struct Row {
    name: &'static str,
    /// One `data:` payload per entry.
    sse: &'static [&'static str],
    want: Want,
    /// Also run over the genai wire.
    wire: bool,
}

fn rows() -> Vec<Row> {
    vec![
        Row {
            name: "plain text with a stop",
            sse: &[
                r#"{"choices":[{"delta":{"role":"assistant","content":""}}]}"#,
                r#"{"choices":[{"delta":{"content":"Hel"}}]}"#,
                r#"{"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
            ],
            want: Want { content: "Hello", finish: Some("stop"), ..NONE },
            wire: true,
        },
        Row {
            name: "arguments streamed as string fragments",
            sse: &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"grep","arguments":""}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"q\":"}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"x\"}"}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ],
            want: Want { calls: &[("c1", "grep", r#"{"q":"x"}"#)], finish: Some("tool_calls"), ..NONE },
            wire: true,
        },
        Row {
            name: "arguments sent as a JSON object, not a string",
            sse: &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"grep","arguments":{"q":"x","n":2}}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ],
            want: Want { calls: &[("c1", "grep", r#"{"n":2,"q":"x"}"#)], finish: Some("tool_calls"), ..NONE },
            wire: true,
        },
        Row {
            name: "empty content string next to tool calls",
            sse: &[
                r#"{"choices":[{"delta":{"role":"assistant","content":"","tool_calls":[{"index":0,"id":"c1","function":{"name":"ls","arguments":"{}"}}]}}]}"#,
                r#"{"choices":[{"delta":{"content":""},"finish_reason":"tool_calls"}]}"#,
            ],
            want: Want { calls: &[("c1", "ls", "{}")], finish: Some("tool_calls"), ..NONE },
            wire: true,
        },
        Row {
            name: "no finish_reason anywhere",
            sse: &[
                r#"{"choices":[{"delta":{"content":"partial"}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"ls","arguments":"{}"}}]}}]}"#,
            ],
            want: Want { content: "partial", calls: &[("c1", "ls", "{}")], finish: None, ..NONE },
            wire: true,
        },
        Row {
            name: "reasoning_content kept apart from the answer",
            sse: &[
                r#"{"choices":[{"delta":{"reasoning_content":"think "}}]}"#,
                r#"{"choices":[{"delta":{"reasoning_content":"hard"}}]}"#,
                r#"{"choices":[{"delta":{"content":"42"}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
            ],
            want: Want { content: "42", reasoning: "think hard", finish: Some("stop"), ..NONE },
            wire: true,
        },
        Row {
            name: "reasoning delivered under the `reasoning` alias",
            sse: &[
                r#"{"choices":[{"delta":{"reasoning":"hm","content":""}}]}"#,
                r#"{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}"#,
            ],
            want: Want { content: "ok", reasoning: "hm", finish: Some("stop"), ..NONE },
            wire: true,
        },
        Row {
            name: "inline think tags stay in content for the consumer to strip",
            sse: &[
                r#"{"choices":[{"delta":{"content":"<think>pl"}}]}"#,
                r#"{"choices":[{"delta":{"content":"an</think>"}}]}"#,
                r#"{"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}"#,
            ],
            want: Want { content: "<think>plan</think>answer", finish: Some("stop"), ..NONE },
            wire: true,
        },
        Row {
            name: "usage only in a trailing chunk with no choices",
            sse: &[
                r#"{"choices":[{"delta":{"content":"ok"}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
                r#"{"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}"#,
            ],
            want: Want { content: "ok", finish: Some("stop"), total_tokens: Some(5), ..NONE },
            wire: true,
        },
        Row {
            name: "usage on the finish chunk",
            sse: &[
                r#"{"choices":[{"delta":{"content":"ok"}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}"#,
            ],
            want: Want { content: "ok", finish: Some("stop"), total_tokens: Some(5), ..NONE },
            wire: true,
        },
        Row {
            name: "two parallel calls sharing one id",
            sse: &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"dup","function":{"name":"a","arguments":"{}"}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"dup","function":{"name":"b","arguments":"{}"}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ],
            want: Want { calls: &[("dup", "a", "{}"), ("dup_2", "b", "{}")], finish: Some("tool_calls"), ..NONE },
            wire: true,
        },
        Row {
            name: "tool call without an id",
            sse: &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"ls","arguments":"{}"}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ],
            want: Want { calls: &[("call_0", "ls", "{}")], finish: Some("tool_calls"), ..NONE },
            wire: true,
        },
        Row {
            name: "arguments arrive before the id and name",
            sse: &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"a\":"}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"ls","arguments":"1}"}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ],
            want: Want { calls: &[("c1", "ls", r#"{"a":1}"#)], finish: Some("tool_calls"), ..NONE },
            wire: true,
        },
        Row {
            name: "two calls batched into a single chunk",
            sse: &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"grep","arguments":"{\"q\":1}"}},{"index":1,"id":"b","function":{"name":"read","arguments":"{\"p\":"}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"2}"}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ],
            want: Want {
                calls: &[("a", "grep", r#"{"q":1}"#), ("b", "read", r#"{"p":2}"#)],
                finish: Some("tool_calls"),
                ..NONE
            },
            wire: true,
        },
        Row {
            name: "three calls batched, no index fields",
            sse: &[
                r#"{"choices":[{"delta":{"tool_calls":[{"id":"a","function":{"name":"x","arguments":"{}"}},{"id":"b","function":{"name":"y","arguments":"{}"}},{"id":"c","function":{"name":"z","arguments":"{}"}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ],
            want: Want {
                calls: &[("a", "x", "{}"), ("b", "y", "{}"), ("c", "z", "{}")],
                finish: Some("tool_calls"),
                ..NONE
            },
            wire: true,
        },
        Row {
            name: "parallel calls with interleaved argument fragments",
            sse: &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"x","arguments":"{\"k\""}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"y","arguments":"{\"k\""}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":":2}"}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ],
            want: Want {
                calls: &[("a", "x", r#"{"k":1}"#), ("b", "y", r#"{"k":2}"#)],
                finish: Some("tool_calls"),
                ..NONE
            },
            wire: true,
        },
        Row {
            name: "calls and finish_reason in the same chunk",
            sse: &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"x","arguments":"{}"}},{"index":1,"id":"b","function":{"name":"y","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}"#,
            ],
            want: Want { calls: &[("a", "x", "{}"), ("b", "y", "{}")], finish: Some("tool_calls"), ..NONE },
            wire: true,
        },
        Row {
            name: "content and finish_reason in the same chunk",
            sse: &[r#"{"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}"#],
            want: Want { content: "done", finish: Some("stop"), ..NONE },
            wire: true,
        },
        Row {
            name: "null fields on every delta",
            sse: &[
                r#"{"choices":[{"delta":{"role":"assistant","content":null,"tool_calls":null,"reasoning_content":null},"finish_reason":null}]}"#,
                r#"{"choices":[{"delta":{"content":"hi","tool_calls":null},"finish_reason":null}],"usage":null}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
            ],
            want: Want { content: "hi", finish: Some("stop"), ..NONE },
            wire: true,
        },
        Row {
            name: "no-argument tool keeps an empty argument string",
            sse: &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"now","arguments":""}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ],
            want: Want { calls: &[("c1", "now", "")], finish: Some("tool_calls"), ..NONE },
            wire: true,
        },
        // -- Rows that corrupt the data line itself: the strict genai streamer
        // errors on these by design, so they only run through `SseAccumulator`.
        Row {
            name: "stray bytes after the JSON on a data line",
            sse: &[
                r#"{"choices":[{"delta":{"content":"ok"}}]}trailing-garbage"#,
                r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
            ],
            want: Want { content: "ok", finish: Some("stop"), ..NONE },
            wire: false,
        },
        Row {
            name: "a non-JSON data line between chunks",
            sse: &[
                r#"{"choices":[{"delta":{"content":"a"}}]}"#,
                "PROCESSING",
                r#"{"choices":[{"delta":{"content":"b"},"finish_reason":"stop"}]}"#,
            ],
            want: Want { content: "ab", finish: Some("stop"), ..NONE },
            wire: false,
        },
    ]
}

#[derive(Debug, PartialEq)]
struct Observed {
    content: String,
    reasoning: String,
    calls: Vec<(String, String, String)>,
    finish: Option<String>,
    total_tokens: Option<u64>,
}

/// What the loop actually consumes out of a completion.
fn observed(completion: &serde_json::Value) -> Observed {
    let choice = &completion["choices"][0];
    let message = &choice["message"];
    Observed {
        content: message["content"].as_str().unwrap_or("").to_string(),
        reasoning: message["reasoning_content"].as_str().unwrap_or("").to_string(),
        calls: message["tool_calls"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|c| {
                        (
                            c["id"].as_str().unwrap_or("").to_string(),
                            c["function"]["name"].as_str().unwrap_or("").to_string(),
                            c["function"]["arguments"].as_str().unwrap_or("").to_string(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default(),
        finish: choice["finish_reason"].as_str().map(str::to_string),
        total_tokens: completion["usage"]["total_tokens"].as_u64(),
    }
}

fn expected(w: &Want) -> Observed {
    Observed {
        content: w.content.to_string(),
        reasoning: w.reasoning.to_string(),
        calls: w
            .calls
            .iter()
            .map(|(i, n, a)| (i.to_string(), n.to_string(), a.to_string()))
            .collect(),
        finish: w.finish.map(str::to_string),
        total_tokens: w.total_tokens,
    }
}

/// Tool-call arguments compared as JSON when both sides parse, so a row does
/// not depend on the key order of a re-serialised object.
fn same_args(a: &str, b: &str) -> bool {
    match (
        serde_json::from_str::<serde_json::Value>(a),
        serde_json::from_str::<serde_json::Value>(b),
    ) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

fn assert_matches(row: &Row, got: &Observed, parser: &str) {
    let want = expected(&row.want);
    let calls_ok = got.calls.len() == want.calls.len()
        && got
            .calls
            .iter()
            .zip(&want.calls)
            .all(|(g, w)| g.0 == w.0 && g.1 == w.1 && same_args(&g.2, &w.2));
    assert!(
        calls_ok
            && got.content == want.content
            && got.reasoning == want.reasoning
            && got.finish == want.finish
            && got.total_tokens == want.total_tokens,
        "[{parser}] quirk `{}`:\n  want {want:?}\n  got  {got:?}",
        row.name
    );
}

#[test]
fn every_quirk_reassembles_through_the_sse_accumulator() {
    for row in rows() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut acc = SseAccumulator::default();
        for payload in row.sse {
            acc.ingest(payload, &tx);
        }
        acc.ingest("[DONE]", &tx);
        assert!(acc.error.is_none(), "quirk `{}` set an error", row.name);
        assert_matches(&row, &observed(&acc.into_completion()), "accumulator");
    }
}

#[test]
fn comment_lines_crlf_and_trailing_text_are_tolerated_by_the_line_reader() {
    let (tx, _rx) = mpsc::unbounded_channel();
    let mut acc = SseAccumulator::default();
    let mut buf = String::new();
    buf.push_str(": keep-alive\n\nevent: ping\ndata: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\r\n\r\n");
    buf.push_str("data:{\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n");
    buf.push_str("data: [DONE]\n\ntrailing nonsense with no newline");
    drain_complete_lines(&mut buf, &mut acc, &tx);
    flush_trailing_line(&buf, &mut acc, &tx);
    let got = observed(&acc.into_completion());
    assert_eq!(got.content, "ok");
    assert_eq!(got.finish.as_deref(), Some("stop"));
}

#[test]
fn an_in_stream_error_survives_later_chunks() {
    let (tx, _rx) = mpsc::unbounded_channel();
    let mut acc = SseAccumulator::default();
    acc.ingest(r#"{"error":{"type":"overloaded","message":"busy"}}"#, &tx);
    acc.ingest(r#"{"choices":[{"delta":{"content":"late"}}]}"#, &tx);
    assert_eq!(acc.error.as_deref(), Some("overloaded: busy"));
}

#[test]
fn uniquify_leaves_distinct_ids_alone_and_suffixes_repeats() {
    let mut calls = vec![
        json!({"id": "a"}),
        json!({"id": "b"}),
        json!({"id": "a"}),
        json!({"id": "a"}),
        json!({"id": "a_2"}),
    ];
    uniquify_tool_call_ids(&mut calls);
    let ids: Vec<&str> = calls.iter().map(|c| c["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["a", "b", "a_2", "a_3", "a_2_2"]);
}

async fn serve_once(payloads: &[&str]) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let body: String = payloads
        .iter()
        .map(|e| format!("data: {e}\n\n"))
        .chain(std::iter::once("data: [DONE]\n\n".to_string()))
        .collect();
    let reply = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        if let Ok((mut sock, _)) = listener.accept().await {
            let mut scratch = [0u8; 8192];
            let _ = sock.read(&mut scratch).await;
            let _ = sock.write_all(reply.as_bytes()).await;
            let _ = sock.flush().await;
            let _ = sock.shutdown().await;
            // Hold the socket until the client has read everything.
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });
    format!("http://{addr}/v1/chat/completions")
}

#[tokio::test]
async fn every_quirk_reassembles_over_the_genai_wire() {
    let body = json!({ "model": "m", "messages": [{ "role": "user", "content": "hi" }] });
    for row in rows().into_iter().filter(|r| r.wire) {
        let url = serve_once(row.sse).await;
        let (tx, _rx) = mpsc::unbounded_channel();
        let completion = super::super::genai_bridge::stream_chat_completions(
            &agent_http_client(),
            &url,
            &[],
            None,
            &body,
            &tx,
            None,
        )
        .await
        .unwrap_or_else(|e| panic!("quirk `{}` failed the stream: {e}", row.name));
        assert_matches(&row, &observed(&completion), "genai wire");
    }
}
