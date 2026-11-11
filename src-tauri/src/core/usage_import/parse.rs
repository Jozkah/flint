//! Reading one session log. Formats were checked against real logs on disk:
//!
//! Claude Code: one JSON object per line; `type: "assistant"` lines carry
//! `timestamp`, `sessionId`, `cwd` and `message {id, model, usage}` where usage
//! has `input_tokens`, `cache_read_input_tokens`,
//! `cache_creation_input_tokens` and `output_tokens` (input excludes both
//! cache figures). A streamed reply is logged on several lines with one
//! `message.id`.
//!
//! Codex: `session_meta` (cwd, id), `turn_context` (model, cwd) and
//! `event_msg` with `payload.type == "token_count"` whose
//! `info.last_token_usage` is that call's usage and `info.total_token_usage`
//! the running total (repeated when nothing new happened). There
//! `input_tokens` already includes `cached_input_tokens`.

use std::collections::HashMap;
use std::io::BufRead;

use serde::Deserialize;

use super::{Agent, ParseStats, Record};

/// A line longer than this is skipped rather than held in memory.
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// Outcome of reading one line with a size cap.
#[derive(Debug, PartialEq, Eq)]
pub enum Line {
    Eof,
    Ok,
    /// The line was longer than the cap; its bytes were consumed and dropped.
    TooLong,
}

/// Read up to and including the next `\n` into `buf`, keeping at most `cap`
/// bytes. The rest of an over-long line is consumed without being stored.
pub fn read_capped_line<R: BufRead>(r: &mut R, buf: &mut Vec<u8>, cap: usize) -> std::io::Result<Line> {
    buf.clear();
    let mut seen_any = false;
    let mut too_long = false;
    loop {
        let chunk = r.fill_buf()?;
        if chunk.is_empty() {
            return Ok(if !seen_any {
                Line::Eof
            } else if too_long {
                Line::TooLong
            } else {
                Line::Ok
            });
        }
        seen_any = true;
        let (take, done) = match chunk.iter().position(|b| *b == b'\n') {
            Some(i) => (i + 1, true),
            None => (chunk.len(), false),
        };
        if !too_long {
            if buf.len() + take > cap {
                too_long = true;
                buf.clear();
            } else {
                buf.extend_from_slice(&chunk[..take]);
            }
        }
        r.consume(take);
        if done {
            return Ok(if too_long { Line::TooLong } else { Line::Ok });
        }
    }
}

fn project_name(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_string()
}

fn parse_ts(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

#[derive(Deserialize)]
struct CcLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    cwd: Option<String>,
    message: Option<CcMessage>,
}

#[derive(Deserialize)]
struct CcMessage {
    id: Option<String>,
    model: Option<String>,
    usage: Option<CcUsage>,
}

#[derive(Deserialize, Default)]
struct CcUsage {
    input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

/// Parse a Claude Code log. `fallback_project` names the project when a line
/// has no `cwd` (the folder the log sits in).
pub fn parse_claude_code<R: BufRead>(
    mut reader: R,
    fallback_session: &str,
    fallback_project: &str,
) -> std::io::Result<(Vec<Record>, ParseStats)> {
    let mut stats = ParseStats::default();
    let mut records: Vec<Record> = Vec::new();
    let mut by_id: HashMap<String, usize> = HashMap::new();
    let mut buf = Vec::new();
    loop {
        match read_capped_line(&mut reader, &mut buf, MAX_LINE_BYTES)? {
            Line::Eof => break,
            Line::TooLong => {
                stats.skipped_lines += 1;
                continue;
            }
            Line::Ok => {}
        }
        // Cheap filter first: most lines are not model replies.
        if !contains(&buf, b"\"usage\"") || !contains(&buf, b"\"assistant\"") {
            continue;
        }
        let line: CcLine = match serde_json::from_slice(&buf) {
            Ok(l) => l,
            Err(_) => {
                stats.skipped_lines += 1;
                continue;
            }
        };
        if line.kind.as_deref() != Some("assistant") {
            continue;
        }
        let Some(msg) = line.message else { continue };
        let (Some(usage), Some(model)) = (msg.usage, msg.model) else {
            stats.skipped_lines += 1;
            continue;
        };
        // Claude Code writes placeholder replies (`<synthetic>`) for errors.
        if model.starts_with('<') {
            continue;
        }
        let Some(ts) = line.timestamp.as_deref().and_then(parse_ts) else {
            stats.skipped_lines += 1;
            continue;
        };
        let project = line
            .cwd
            .as_deref()
            .map(project_name)
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| fallback_project.to_string());
        let rec = Record {
            agent: Agent::ClaudeCode,
            ts,
            model,
            session: line.session_id.unwrap_or_else(|| fallback_session.to_string()),
            project,
            input: usage.input_tokens.unwrap_or(0),
            cache_read: usage.cache_read_input_tokens.unwrap_or(0),
            cache_write: usage.cache_creation_input_tokens.unwrap_or(0),
            output: usage.output_tokens.unwrap_or(0),
            id: msg.id.map(|i| format!("cc:{i}")).unwrap_or_default(),
        };
        if rec.total_tokens() == 0 {
            continue;
        }
        if rec.id.is_empty() {
            records.push(rec);
        } else if let Some(&i) = by_id.get(&rec.id) {
            stats.duplicates += 1;
            // A streamed reply may be logged early with a partial output
            // count: keep the fullest one.
            if rec.output > records[i].output {
                records[i] = rec;
            }
        } else {
            by_id.insert(rec.id.clone(), records.len());
            records.push(rec);
        }
    }
    Ok((records, stats))
}

#[derive(Deserialize)]
struct CxLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    payload: Option<CxPayload>,
}

#[derive(Deserialize)]
struct CxPayload {
    #[serde(rename = "type")]
    kind: Option<String>,
    id: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    info: Option<CxInfo>,
}

#[derive(Deserialize)]
struct CxInfo {
    total_token_usage: Option<CxUsage>,
    last_token_usage: Option<CxUsage>,
}

#[derive(Deserialize, Default, Clone, Copy, PartialEq, Eq)]
struct CxUsage {
    input_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    cache_write_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

/// Parse a Codex rollout log.
pub fn parse_codex<R: BufRead>(
    mut reader: R,
    fallback_session: &str,
) -> std::io::Result<(Vec<Record>, ParseStats)> {
    let mut stats = ParseStats::default();
    let mut records = Vec::new();
    let mut buf = Vec::new();
    let mut session = fallback_session.to_string();
    let mut project = String::new();
    let mut model = String::new();
    let mut last_total: Option<CxUsage> = None;
    loop {
        match read_capped_line(&mut reader, &mut buf, MAX_LINE_BYTES)? {
            Line::Eof => break,
            Line::TooLong => {
                stats.skipped_lines += 1;
                continue;
            }
            Line::Ok => {}
        }
        let interesting = contains(&buf, b"\"token_count\"")
            || contains(&buf, b"\"turn_context\"")
            || contains(&buf, b"\"session_meta\"");
        if !interesting {
            continue;
        }
        let line: CxLine = match serde_json::from_slice(&buf) {
            Ok(l) => l,
            Err(_) => {
                stats.skipped_lines += 1;
                continue;
            }
        };
        let Some(p) = line.payload else { continue };
        match line.kind.as_deref() {
            Some("session_meta") => {
                if let Some(id) = p.id {
                    session = id;
                }
                if let Some(cwd) = p.cwd {
                    project = project_name(&cwd);
                }
            }
            Some("turn_context") => {
                if let Some(m) = p.model {
                    model = m;
                }
                if project.is_empty() {
                    if let Some(cwd) = p.cwd {
                        project = project_name(&cwd);
                    }
                }
            }
            Some("event_msg") if p.kind.as_deref() == Some("token_count") => {
                let Some(info) = p.info else { continue };
                let Some(last) = info.last_token_usage else { continue };
                // The same running total again means no new call happened.
                if let Some(total) = info.total_token_usage {
                    if last_total == Some(total) {
                        stats.duplicates += 1;
                        continue;
                    }
                    last_total = Some(total);
                }
                let Some(ts) = line.timestamp.as_deref().and_then(parse_ts) else {
                    stats.skipped_lines += 1;
                    continue;
                };
                let prompt = last.input_tokens.unwrap_or(0);
                let cached = last.cached_input_tokens.unwrap_or(0).min(prompt);
                let written = last.cache_write_input_tokens.unwrap_or(0).min(prompt - cached);
                let output = last.output_tokens.unwrap_or(0);
                let rec = Record {
                    agent: Agent::Codex,
                    ts,
                    model: if model.is_empty() { "unknown".into() } else { model.clone() },
                    session: session.clone(),
                    project: project.clone(),
                    input: prompt - cached - written,
                    cache_read: cached,
                    cache_write: written,
                    output,
                    id: format!("cx:{ts}:{prompt}:{cached}:{output}"),
                };
                if rec.total_tokens() > 0 {
                    records.push(rec);
                }
            }
            _ => {}
        }
    }
    Ok((records, stats))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn cc(id: &str, out: u64, extra: &str) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"2026-10-26T12:27:58.850Z","sessionId":"s1","cwd":"C:\\tmp\\proj","message":{{"id":"{id}","model":"claude-sonnet-5-5","usage":{{"input_tokens":2,"cache_creation_input_tokens":100,"cache_read_input_tokens":50,"output_tokens":{out}{extra}}}}}}}"#
        )
    }

    #[test]
    fn claude_dedupes_ids_keeps_fullest_and_skips_malformed() {
        let log = [
            cc("m1", 5, ""),
            cc("m1", 40, ""),
            cc("m2", 7, ""),
            "{not json \"usage\" \"assistant\"".to_string(),
            r#"{"type":"user","message":{"content":"hello"}}"#.to_string(),
            // no model
            r#"{"type":"assistant","timestamp":"2026-10-26T12:27:58Z","message":{"usage":{"output_tokens":1}}}"#.to_string(),
            // synthetic placeholder
            r#"{"type":"assistant","timestamp":"2026-10-26T12:27:58Z","message":{"id":"x","model":"<synthetic>","usage":{"output_tokens":9}}}"#.to_string(),
            // missing token fields: all zero, dropped silently
            r#"{"type":"assistant","timestamp":"2026-10-26T12:27:58Z","message":{"id":"z","model":"claude-x","usage":{}}}"#.to_string(),
        ]
        .join("\n");
        let (recs, stats) = parse_claude_code(Cursor::new(log), "file", "folder").unwrap();
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].output, 40);
        assert_eq!(recs[0].cache_write, 100);
        assert_eq!(recs[0].cache_read, 50);
        assert_eq!(recs[0].input, 2);
        assert_eq!(recs[0].project, "proj");
        assert_eq!(recs[0].session, "s1");
        assert_eq!(stats.duplicates, 1);
        assert_eq!(stats.skipped_lines, 2);
    }

    #[test]
    fn claude_huge_line_is_skipped_not_held() {
        let mut log = cc("m1", 5, "");
        log.push('\n');
        log.push_str(&"x".repeat(MAX_LINE_BYTES + 10));
        log.push('\n');
        log.push_str(&cc("m2", 6, ""));
        let (recs, stats) = parse_claude_code(Cursor::new(log), "f", "p").unwrap();
        assert_eq!(recs.len(), 2);
        assert_eq!(stats.skipped_lines, 1);
    }

    #[test]
    fn capped_reader_handles_missing_trailing_newline() {
        let mut r = Cursor::new(b"ab\ncd".to_vec());
        let mut buf = Vec::new();
        assert_eq!(read_capped_line(&mut r, &mut buf, 16).unwrap(), Line::Ok);
        assert_eq!(buf, b"ab\n");
        assert_eq!(read_capped_line(&mut r, &mut buf, 16).unwrap(), Line::Ok);
        assert_eq!(buf, b"cd");
        assert_eq!(read_capped_line(&mut r, &mut buf, 16).unwrap(), Line::Eof);
    }

    #[test]
    fn codex_splits_cached_input_uses_turn_model_and_drops_repeat_totals() {
        let tc = |ts: &str, total: u64, last_in: u64, cached: u64, out: u64| {
            format!(
                r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{total},"total_tokens":{total}}},"last_token_usage":{{"input_tokens":{last_in},"cached_input_tokens":{cached},"cache_write_input_tokens":0,"output_tokens":{out},"total_tokens":{}}}}}}}}}"#,
                last_in + out
            )
        };
        let log = [
            r#"{"timestamp":"2026-10-12T13:00:00Z","type":"session_meta","payload":{"id":"sess","cwd":"C:\\a\\proj"}}"#.to_string(),
            r#"{"timestamp":"2026-10-12T13:00:01Z","type":"turn_context","payload":{"model":"gpt-x","cwd":"C:\\a\\proj"}}"#.to_string(),
            r#"{"timestamp":"2026-10-12T13:00:02Z","type":"event_msg","payload":{"type":"token_count","info":null}}"#.to_string(),
            tc("2026-10-12T13:05:01Z", 1000, 1000, 0, 10),
            tc("2026-10-12T13:05:02Z", 1000, 1000, 0, 10),
            tc("2026-10-12T13:05:09Z", 3000, 2000, 1500, 20),
        ]
        .join("\n");
        let (recs, stats) = parse_codex(Cursor::new(log), "file").unwrap();
        assert_eq!(recs.len(), 2);
        assert_eq!(stats.duplicates, 1);
        assert_eq!(recs[1].model, "gpt-x");
        assert_eq!(recs[1].input, 500);
        assert_eq!(recs[1].cache_read, 1500);
        assert_eq!(recs[1].session, "sess");
        assert_eq!(recs[1].project, "proj");
    }

    #[test]
    fn codex_without_turn_context_has_unknown_model() {
        let log = r#"{"timestamp":"2026-10-12T13:05:01Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":5,"output_tokens":1}}}}"#;
        let (recs, _) = parse_codex(Cursor::new(log), "file").unwrap();
        assert_eq!(recs[0].model, "unknown");
        assert_eq!(recs[0].session, "file");
    }
}
