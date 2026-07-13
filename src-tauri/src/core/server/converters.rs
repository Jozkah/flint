//! Translating-gateway support for the proxy.
//!
//! Jan's proxy accepts OpenAI chat/completions and, for OpenAI-compatible
//! upstreams, forwards verbatim. To also front providers with a different
//! native wire API (OpenAI `/v1/responses`, Google `generateContent`,
//! Anthropic `/v1/messages`), each such provider gets a converter that rewrites
//! the request and translates the response back to chat/completions.
//!
//! This module currently provides the shared primitive every converter needs:
//! an [`SseAccumulator`] that reassembles complete Server-Sent Events across
//! network chunk boundaries. The existing inline proxy parser splits each chunk
//! on lines and drops partial lines, which only survives because upstreams tend
//! to flush whole events; a real translator cannot rely on that.

/// One parsed Server-Sent Event.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SseEvent {
    /// The `event:` field value, empty when absent (chat/completions omits it;
    /// OpenAI `/responses` and Anthropic set it).
    pub event: String,
    /// Concatenated `data:` payload (multiple `data:` lines joined by `\n`),
    /// with sentinels like `[DONE]` preserved verbatim.
    pub data: String,
}

/// Accumulates raw response text and yields complete SSE events, buffering any
/// partial trailing event until its terminating blank line arrives in a later
/// chunk.
#[derive(Debug, Default)]
pub struct SseAccumulator {
    buf: String,
}

impl SseAccumulator {
    pub fn new() -> Self {
        Self { buf: String::new() }
    }

    /// Feed a chunk of the response body; returns every event completed by it.
    pub fn push(&mut self, chunk: &str) -> Vec<SseEvent> {
        // Normalize CRLF so boundary detection only has to look for "\n\n".
        self.buf.push_str(&chunk.replace("\r\n", "\n"));
        let mut events = Vec::new();
        while let Some(idx) = self.buf.find("\n\n") {
            let raw: String = self.buf.drain(..idx + 2).collect();
            if let Some(ev) = parse_event(&raw) {
                events.push(ev);
            }
        }
        events
    }

    /// Flush a final event that arrived without a terminating blank line (some
    /// servers omit it before closing the connection).
    pub fn finish(&mut self) -> Option<SseEvent> {
        let raw = std::mem::take(&mut self.buf);
        parse_event(&raw)
    }
}

fn parse_event(raw: &str) -> Option<SseEvent> {
    let mut ev = SseEvent::default();
    let mut data_lines: Vec<&str> = Vec::new();
    let mut has_field = false;
    for line in raw.lines() {
        // Blank lines separate events; lines starting with ':' are comments.
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.strip_prefix(' ').unwrap_or(rest));
            has_field = true;
        } else if let Some(rest) = line.strip_prefix("event:") {
            ev.event = rest.strip_prefix(' ').unwrap_or(rest).to_string();
            has_field = true;
        }
        // `id:`, `retry:`, and unknown fields are irrelevant to translation.
    }
    if !has_field {
        return None;
    }
    ev.data = data_lines.join("\n");
    Some(ev)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_single_event_in_one_chunk() {
        let mut acc = SseAccumulator::new();
        let events = acc.push("data: {\"a\":1}\n\n");
        assert_eq!(
            events,
            vec![SseEvent {
                event: String::new(),
                data: "{\"a\":1}".to_string()
            }]
        );
    }

    #[test]
    fn buffers_an_event_split_across_chunks() {
        let mut acc = SseAccumulator::new();
        assert!(acc.push("data: {\"a\":").is_empty());
        assert!(acc.push("1}").is_empty());
        let events = acc.push("\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "{\"a\":1}");
    }

    #[test]
    fn yields_multiple_events_from_one_chunk() {
        let mut acc = SseAccumulator::new();
        let events = acc.push("data: 1\n\ndata: 2\n\n");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].data, "1");
        assert_eq!(events[1].data, "2");
    }

    #[test]
    fn joins_multiline_data_and_reads_event_field() {
        let mut acc = SseAccumulator::new();
        let events = acc.push("event: response.delta\ndata: line1\ndata: line2\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "response.delta");
        assert_eq!(events[0].data, "line1\nline2");
    }

    #[test]
    fn normalizes_crlf_boundaries() {
        let mut acc = SseAccumulator::new();
        let events = acc.push("data: x\r\n\r\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "x");
    }

    #[test]
    fn ignores_comment_lines_and_preserves_done_sentinel() {
        let mut acc = SseAccumulator::new();
        let events = acc.push(": keep-alive\n\ndata: [DONE]\n\n");
        // The comment-only block yields no event; [DONE] is preserved verbatim.
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "[DONE]");
    }

    #[test]
    fn finish_flushes_a_trailing_event_without_blank_line() {
        let mut acc = SseAccumulator::new();
        assert!(acc.push("data: tail").is_empty());
        let last = acc.finish();
        assert_eq!(last.map(|e| e.data), Some("tail".to_string()));
    }

    #[test]
    fn finish_is_empty_when_buffer_has_no_fields() {
        let mut acc = SseAccumulator::new();
        acc.push("data: done\n\n");
        assert_eq!(acc.finish(), None);
    }
}
