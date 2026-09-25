//! What the model was actually sent.
//!
//! A run's transcript shows what the model *said*. Nobody could see what it was
//! *given* — the assembled system prompt, the project context, the tool
//! declarations, the reasoning settings — because the frozen payload lived in
//! transport memory for the length of one call and was gone when the run ended.
//! That is the difference between "the model did something strange" and "the
//! model did something strange and here is why".
//!
//! Two rules shape everything here:
//!
//! * **The snapshot is the dispatch.** It is taken from the exact serialized
//!   request, at the point it is about to go on the wire, not from the state it
//!   was built from. A snapshot reconstructed from earlier state is a
//!   plausible-looking lie, and would be worse than having none.
//! * **Redaction happens before persistence, never after.** A credential is
//!   removed while the record is being built, so it is never written and then
//!   cleaned up. What was removed is recorded — the path and the reason — so a
//!   reader can tell "this field was empty" from "this field was a secret".

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Schema version, so a later reader knows what it is looking at.
pub const SCHEMA_VERSION: u32 = 1;

/// File name under the audit directory.
pub const PROMPTS_LOG: &str = "prompts.jsonl";

/// One field that was removed, and why.
///
/// Provenance rather than a bare count: "we redacted 3 things" tells a reader
/// nothing, while "`messages[2].content` matched a private key" tells them
/// where to look and what to fix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Redaction {
    /// Dotted path into the payload, e.g. `headers.authorization`.
    pub path: String,
    /// Why it went: `auth-header`, `api-key`, `private-key`, `token`, `cookie`.
    pub why: String,
}

/// Why a snapshot is not available, when it is not.
///
/// Recorded explicitly rather than leaving a gap: a missing snapshot and a
/// snapshot that was deliberately withheld are different facts, and only one of
/// them is a bug.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Unavailable {
    /// The payload could not be serialized.
    NotSerializable,
    /// Snapshots are switched off for this run.
    Disabled,
    /// The payload was too large to store whole.
    TooLarge,
}

fn one() -> u32 {
    1
}

/// Why a request was sent, which is not the same as when it was sent.
///
/// A retry and a continuation both follow an earlier dispatch in the same
/// turn, and reading one as the other would attribute a repeated payload to
/// progress that never happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DispatchKind {
    /// The first request of a turn.
    #[default]
    Initial,
    /// A further request in the same turn, after tool results.
    Continuation,
    /// The same request again, after a transient failure.
    Retry,
    /// A request whose history was compacted before sending.
    Compaction,
}

/// The exact payload a model was sent, after redaction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptSnapshot {
    #[serde(rename = "v")]
    pub version: u32,
    /// Stable id, unique within the data folder.
    pub id: String,
    /// RFC 3339, UTC.
    pub at: String,

    // -- identity ---------------------------------------------------------
    #[serde(default)]
    pub session: String,
    #[serde(default)]
    pub run: String,
    #[serde(default)]
    pub thread: String,
    #[serde(default)]
    pub agent: String,

    /// The dispatch this record belongs to.
    ///
    /// Assigned before the request leaves, unique per attempt, and carried on
    /// the stream event so the timeline can attach the record to the exact
    /// invocation rather than guessing from ordering. One assistant turn can
    /// hold several -- a continuation, a retry, a compaction -- and each has
    /// its own id.
    #[serde(default)]
    pub invocation: String,
    /// Which turn the invocation belongs to, when the caller knows.
    #[serde(default)]
    pub turn: String,
    /// 1 for the first attempt at this invocation, 2 for its first retry.
    #[serde(default = "one")]
    pub attempt: u32,
    /// What kind of dispatch this was.
    #[serde(default)]
    pub kind: DispatchKind,

    // -- what was asked of whom -------------------------------------------
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    /// Reasoning/effort configuration as it was sent.
    #[serde(default)]
    pub reasoning: Value,

    /// The redacted request, verbatim apart from what `redactions` names.
    ///
    /// `null` when `unavailable` says why there is nothing here.
    #[serde(default)]
    pub payload: Value,
    /// Hash of the redacted payload. Two dispatches with the same hash sent the
    /// same thing; a retry that changes anything gets a different hash, which is
    /// what stops a different payload hiding behind an approved one.
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub redactions: Vec<Redaction>,
    /// Present only when there is no payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<Unavailable>,
}

impl PromptSnapshot {
    /// The payload as a person reads it (AH-087): every message in order with
    /// its role and full text, each tool call the model made with its
    /// arguments, and the tools offered. Nothing is summarised or truncated;
    /// what redaction replaced is already replaced in the payload, and the
    /// header says how many values that was. A snapshot with no payload says
    /// why instead of printing an empty conversation.
    pub fn render_text(&self) -> String {
        use std::fmt::Write;
        let mut out = String::new();
        let _ = writeln!(out, "snapshot {} at {}", self.id, self.at);
        let _ = writeln!(
            out,
            "model {} · {:?} dispatch · hash {} · {} redaction(s)",
            if self.model.is_empty() { "unknown" } else { &self.model },
            self.kind,
            self.hash,
            self.redactions.len()
        );
        if let Some(why) = &self.unavailable {
            let _ = writeln!(out, "\nno payload was kept: {why:?}");
            return out;
        }
        let text_of = |content: &Value| -> String {
            match content {
                Value::String(s) => s.clone(),
                Value::Array(parts) => parts
                    .iter()
                    .map(|p| match p.get("type").and_then(Value::as_str) {
                        Some("text") => p.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
                        Some(other) => format!("[{other} part]"),
                        None => p.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
                Value::Null => String::new(),
                other => other.to_string(),
            }
        };
        let messages = self.payload.get("messages").and_then(Value::as_array);
        for (i, m) in messages.into_iter().flatten().enumerate() {
            let role = m.get("role").and_then(Value::as_str).unwrap_or("?");
            let _ = write!(out, "\n--- {} · {role}", i + 1);
            if let Some(id) = m.get("tool_call_id").and_then(Value::as_str) {
                let _ = write!(out, " · result of {id}");
            }
            let _ = writeln!(out, " ---");
            let body = text_of(m.get("content").unwrap_or(&Value::Null));
            if !body.is_empty() {
                let _ = writeln!(out, "{body}");
            }
            for call in m.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
                let f = call.get("function");
                let _ = writeln!(
                    out,
                    "[tool call {}] {}({})",
                    call.get("id").and_then(Value::as_str).unwrap_or("?"),
                    f.and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("?"),
                    f.and_then(|f| f.get("arguments")).and_then(Value::as_str).unwrap_or("")
                );
            }
        }
        let tools: Vec<&str> = self
            .payload
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|t| t.get("function").and_then(|f| f.get("name")).and_then(Value::as_str))
            .collect();
        let _ = writeln!(
            out,
            "\n--- tools offered: {} ---\n{}",
            tools.len(),
            if tools.is_empty() { "(none)".to_string() } else { tools.join(", ") }
        );
        out
    }

    /// How many messages the payload carried, for a summary view.
    pub fn message_count(&self) -> usize {
        self.payload
            .get("messages")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)
    }

    /// The tools declared to the model, by name.
    pub fn tool_names(&self) -> Vec<String> {
        self.payload
            .get("tools")
            .and_then(Value::as_array)
            .map(|tools| {
                tools
                    .iter()
                    .filter_map(|t| {
                        t.get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The system prompt, if the payload carried one.
    pub fn system_prompt(&self) -> Option<String> {
        self.payload
            .get("messages")
            .and_then(Value::as_array)?
            .iter()
            .find(|m| m.get("role").and_then(Value::as_str) == Some("system"))
            .and_then(|m| m.get("content"))
            .and_then(Value::as_str)
            .map(str::to_string)
    }
}

/// Field names whose *value* is a credential whatever it looks like.
///
/// Matched on the key, because an auth header's value is opaque: it may be a
/// long random string or the word `Bearer` followed by one, and no
/// value-shaped heuristic catches both reliably.
const CREDENTIAL_KEYS: [(&str, &str); 9] = [
    ("authorization", "auth-header"),
    ("proxy-authorization", "auth-header"),
    ("cookie", "cookie"),
    ("set-cookie", "cookie"),
    ("api_key", "api-key"),
    ("api-key", "api-key"),
    ("apikey", "api-key"),
    ("x-api-key", "api-key"),
    ("access_token", "token"),
];

fn credential_reason(key: &str) -> Option<&'static str> {
    let lower = key.to_ascii_lowercase();
    CREDENTIAL_KEYS
        .iter()
        .find(|(name, _)| lower == *name)
        .map(|(_, why)| *why)
        .or_else(|| {
            // Anything whose name says secret, even if we have not met it.
            ["secret", "password", "passwd", "private_key", "credential"]
                .iter()
                .any(|needle| lower.contains(needle))
                .then_some("secret-field")
        })
}

/// Remove credentials from a payload, recording what went and from where.
///
/// Walks the whole document: a credential in a nested tool argument is as much
/// a leak as one in a header.
pub fn redact_payload(payload: &Value) -> (Value, Vec<Redaction>) {
    let mut found = Vec::new();
    let redacted = walk(payload, "", &mut found);
    (redacted, found)
}

fn walk(value: &Value, path: &str, found: &mut Vec<Redaction>) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (key, child) in map {
                let child_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                match credential_reason(key) {
                    Some(why) if !child.is_null() => {
                        found.push(Redaction {
                            path: child_path,
                            why: why.to_string(),
                        });
                        out.insert(key.clone(), Value::String("[redacted]".into()));
                    }
                    _ => {
                        out.insert(key.clone(), walk(child, &child_path, found));
                    }
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(i, item)| walk(item, &format!("{path}[{i}]"), found))
                .collect(),
        ),
        Value::String(text) => {
            // Free text can carry a key too: an env line pasted into a prompt,
            // a private key in a file the agent read.
            let cleaned = crate::audit::redact(text);
            if &cleaned != text {
                found.push(Redaction {
                    path: path.to_string(),
                    why: "secret-in-text".into(),
                });
                return Value::String(cleaned);
            }
            value.clone()
        }
        other => other.clone(),
    }
}

/// A stable content hash of the redacted payload.
///
/// FNV-1a over the canonical serialization. Not cryptographic, and not meant to
/// be: its job is to say "this is the same payload as before" and to make a
/// changed payload obvious, which a fast non-cryptographic hash does honestly.
pub fn hash_payload(payload: &Value) -> String {
    let canonical = canonical_string(payload);
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in canonical.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("fnv1a64:{hash:016x}")
}

/// Serialize with object keys in a fixed order, so two equal payloads hash
/// equally regardless of how they were built.
fn canonical_string(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let inner: Vec<String> = keys
                .iter()
                .map(|k| format!("{:?}:{}", k, canonical_string(&map[*k])))
                .collect();
            format!("{{{}}}", inner.join(","))
        }
        Value::Array(items) => {
            let inner: Vec<String> = items.iter().map(canonical_string).collect();
            format!("[{}]", inner.join(","))
        }
        other => other.to_string(),
    }
}

/// A snapshot id no earlier process of the app has issued.
///
/// The counter alone restarted at 1 with every launch, so the second run of
/// the app wrote `snap-1` again into the same log, and a lookup by id found
/// the older record. The process's start time keeps each launch's ids apart.
fn next_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    static LAUNCH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let launch = LAUNCH.get_or_init(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{nanos:x}{:x}", std::process::id())
    });
    format!("snap-{launch}-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

/// Identity to attach to a snapshot. Separate from the payload so the caller
/// cannot accidentally omit half of it.
#[derive(Debug, Clone, Default)]
pub struct Identity {
    pub session: String,
    pub run: String,
    pub thread: String,
    pub agent: String,
    pub provider: String,
    /// Unique per dispatch attempt. Empty only for a caller that predates it.
    pub invocation: String,
    pub turn: String,
    pub attempt: u32,
    pub kind: DispatchKind,
}

/// Build a snapshot from the exact payload about to be dispatched.
pub fn capture(payload: &Value, identity: &Identity) -> PromptSnapshot {
    let (redacted, redactions) = redact_payload(payload);
    let hash = hash_payload(&redacted);
    PromptSnapshot {
        version: SCHEMA_VERSION,
        id: next_id(),
        at: crate::audit::now(),
        session: identity.session.clone(),
        run: identity.run.clone(),
        thread: identity.thread.clone(),
        agent: identity.agent.clone(),
        invocation: identity.invocation.clone(),
        turn: identity.turn.clone(),
        attempt: identity.attempt.max(1),
        kind: identity.kind,
        provider: identity.provider.clone(),
        model: redacted
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        reasoning: redacted
            .get("reasoning")
            .or_else(|| redacted.get("reasoning_effort"))
            .cloned()
            .unwrap_or(Value::Null),
        payload: redacted,
        hash,
        redactions,
        unavailable: None,
    }
}

/// A snapshot that records why there is nothing to show.
pub fn unavailable(identity: &Identity, why: Unavailable) -> PromptSnapshot {
    PromptSnapshot {
        version: SCHEMA_VERSION,
        id: next_id(),
        at: crate::audit::now(),
        session: identity.session.clone(),
        run: identity.run.clone(),
        thread: identity.thread.clone(),
        agent: identity.agent.clone(),
        invocation: identity.invocation.clone(),
        turn: identity.turn.clone(),
        attempt: identity.attempt.max(1),
        kind: identity.kind,
        provider: identity.provider.clone(),
        model: String::new(),
        reasoning: Value::Null,
        payload: Value::Null,
        hash: String::new(),
        redactions: Vec::new(),
        unavailable: Some(why),
    }
}

pub fn log_path(data_folder: &Path) -> PathBuf {
    data_folder.join("audit").join(PROMPTS_LOG)
}

/// Append a snapshot. Never fails the dispatch it describes: a snapshot is a
/// witness, and failing to record one must not stop the model call.
pub fn append(data_folder: &Path, snapshot: &PromptSnapshot) {
    if let Err(e) = try_append(data_folder, snapshot) {
        eprintln!("prompt snapshot: could not record a dispatch: {e}");
        return;
    }
    // Bounded by bytes as well as by count, checked cheaply. A snapshot can be
    // hundreds of KB, so the log passes the byte threshold long before the
    // count cap; bounding only the count left it above the threshold, and
    // every later dispatch re-parsed the whole file for nothing
    // (Jozkah/jan#282). Trimming to half the threshold keeps the next
    // thousands of dispatches on the cheap path.
    let big = std::fs::metadata(log_path(data_folder))
        .map(|m| m.len() > SNAPSHOT_LOG_MAX_BYTES)
        .unwrap_or(false);
    if big {
        if let Err(e) = trim_bytes(data_folder, SNAPSHOT_LOG_MAX_BYTES / 2) {
            eprintln!("prompt snapshot: could not apply retention: {e}");
        }
        if let Err(e) = prune(data_folder, MAX_SNAPSHOTS) {
            eprintln!("prompt snapshot: could not apply retention: {e}");
        }
    }
}

/// The size past which the snapshot log is trimmed on append.
const SNAPSHOT_LOG_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// Keep only the newest whole lines of the log that fit in `keep` bytes.
fn trim_bytes(data_folder: &Path, keep: u64) -> Result<(), String> {
    let _guard = crate::retention::lock();
    let path = log_path(data_folder);
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(());
    };
    if bytes.len() as u64 <= keep {
        return Ok(());
    }
    let from = bytes.len() - keep as usize;
    let start = bytes[from..]
        .iter()
        .position(|b| *b == b'\n')
        .map_or(bytes.len(), |i| from + i + 1);
    crate::workspace::write_atomic(&path, &bytes[start..]).map_err(|e| e.to_string())
}

fn try_append(data_folder: &Path, snapshot: &PromptSnapshot) -> Result<(), String> {
    // Shared with compaction and deletion, so a record appended while the log
    // is being rewritten is not lost between the read and the rename.
    let _guard = crate::retention::lock();
    let path = log_path(data_folder);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut line = serde_json::to_string(snapshot).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())
}

/// Every snapshot, oldest first. A line that no longer parses is skipped, so a
/// process killed mid-write costs that record and nothing before it.
pub fn read_all(data_folder: &Path) -> Vec<PromptSnapshot> {
    let Ok(file) = std::fs::File::open(log_path(data_folder)) else {
        return Vec::new();
    };
    std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(&l).ok())
        .collect()
}

/// How many snapshots the log keeps. Older ones are dropped first when an
/// append takes it over this, so the log is bounded without a timer.
pub const MAX_SNAPSHOTS: usize = 2_000;

/// Rewrite the log keeping only the lines `keep` accepts, atomically: a temp
/// file beside it, then a rename. A crash mid-rewrite leaves the old log whole.
/// Lines that no longer parse cannot be attributed to anyone and are kept.
fn rewrite(data_folder: &Path, keep: impl Fn(usize, &PromptSnapshot) -> bool) -> Result<usize, String> {
    // The lock every append takes (Jozkah/jan#287): without it a snapshot
    // appended between the read and the rename below is lost.
    let _guard = crate::retention::lock();
    let path = log_path(data_folder);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(0);
    };
    let mut out = String::with_capacity(text.len());
    let mut removed = 0;
    let mut index = 0;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        match serde_json::from_str::<PromptSnapshot>(line) {
            Ok(s) => {
                let kept = keep(index, &s);
                index += 1;
                if !kept {
                    removed += 1;
                    continue;
                }
            }
            Err(_) => {}
        }
        out.push_str(line);
        out.push('\n');
    }
    if removed == 0 {
        return Ok(0);
    }
    let temp = path.with_extension(format!("jsonl.tmp-{}", std::process::id()));
    std::fs::write(&temp, out).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })?;
    Ok(removed)
}

/// Take some text out of every snapshot that carries it, keeping the record
/// of the request itself.
///
/// Forgetting a memory has to reach the prompts it was already sent in: a
/// snapshot is the exact payload, so leaving it there would keep the forgotten
/// words readable in the inspector, the CLI, the audit export and the session
/// export for as long as the log lives. What is left in their place is a
/// marker naming why, so the record still shows that something was there and
/// that it was removed on purpose -- a redaction, not a hole.
///
/// Returns how many snapshots changed. Rewrites atomically, like every other
/// pass over this log; a line that no longer parses is left exactly as it is,
/// because text that cannot be attributed must not be edited either.
pub fn redact_text(data_folder: &Path, needles: &[&str], why: &str) -> Result<usize, String> {
    // Same read-modify-rename as `rewrite`, under the same lock (Jozkah/jan#287).
    let _guard = crate::retention::lock();
    let needles: Vec<&str> = needles
        .iter()
        .copied()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .collect();
    if needles.is_empty() {
        return Ok(0);
    }
    let path = log_path(data_folder);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(0);
    };
    let marker = format!("[redacted: {why}]");
    let mut out = String::with_capacity(text.len());
    let mut changed = 0usize;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let mut snapshot = match serde_json::from_str::<PromptSnapshot>(line) {
            Ok(s) => s,
            Err(_) => {
                out.push_str(line);
                out.push('\n');
                continue;
            }
        };
        let Ok(mut payload) = serde_json::to_string(&snapshot.payload) else {
            out.push_str(line);
            out.push('\n');
            continue;
        };
        let mut hit = false;
        for needle in &needles {
            // The payload is JSON text, so the needle is matched as it appears
            // once serialized -- with the escaping a JSON string would have.
            let Ok(encoded) = serde_json::to_string(needle) else {
                continue;
            };
            let encoded = encoded.trim_matches('"');
            if !encoded.is_empty() && payload.contains(encoded) {
                payload = payload.replace(encoded, &marker);
                hit = true;
            }
        }
        if !hit {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        match serde_json::from_str::<Value>(&payload) {
            Ok(redacted) => {
                snapshot.payload = redacted;
                snapshot.redactions.push(Redaction {
                    path: "payload".to_string(),
                    why: why.to_string(),
                });
                changed += 1;
                match serde_json::to_string(&snapshot) {
                    Ok(encoded) => {
                        out.push_str(&encoded);
                        out.push('\n');
                    }
                    Err(_) => {
                        out.push_str(line);
                        out.push('\n');
                    }
                }
            }
            // A replacement that broke the JSON is not written: the snapshot
            // stays as it was rather than becoming unreadable.
            Err(_) => {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    if changed == 0 {
        return Ok(0);
    }
    let temp = path.with_extension(format!("jsonl.tmp-redact-{}", std::process::id()));
    std::fs::write(&temp, out).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })?;
    Ok(changed)
}

/// [`redact_text`], reporting instead of returning.
///
/// The caller is `memory/`, which may not log at all -- a memory body could
/// travel with the message -- so the reporting happens here, where the text
/// being handled is already known not to be one.
pub fn redact_text_reporting(data_folder: &Path, needles: &[&str], why: &str) {
    match redact_text(data_folder, needles, why) {
        Ok(0) => {}
        Ok(n) => eprintln!("prompt snapshots: redacted {why} from {n} snapshot(s)"),
        Err(e) => eprintln!("prompt snapshots: could not redact {why}: {e}"),
    }
}

/// Forget every snapshot of one session. The user's way to delete what the
/// model was sent, and what deleting the session does to its snapshots.
pub fn delete_session(data_folder: &Path, session: &str) -> Result<usize, String> {
    if session.trim().is_empty() {
        return Err("name the session whose snapshots to delete".into());
    }
    rewrite(data_folder, |_, s| s.session != session)
}

/// Keep only the newest `max` snapshots.
pub fn prune(data_folder: &Path, max: usize) -> Result<usize, String> {
    let total = read_all(data_folder).len();
    if total <= max {
        return Ok(0);
    }
    let cut = total - max;
    rewrite(data_folder, move |index, _| index >= cut)
}

pub fn find(data_folder: &Path, id: &str) -> Option<PromptSnapshot> {
    read_all(data_folder).into_iter().find(|s| s.id == id)
}

pub fn by_run(data_folder: &Path, run: &str) -> Vec<PromptSnapshot> {
    read_all(data_folder)
        .into_iter()
        .filter(|s| s.run == run)
        .collect()
}

pub fn by_session(data_folder: &Path, session: &str) -> Vec<PromptSnapshot> {
    read_all(data_folder)
        .into_iter()
        .filter(|s| s.session == session)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Jozkah/jan#282: a log past the byte threshold with few (large)
    /// records is trimmed on the next append, so the one after that does
    /// not re-parse it; the newest record survives whole.
    #[test]
    fn a_log_of_few_large_records_is_trimmed_below_the_threshold() {
        let dir = std::env::temp_dir().join(format!("jan_snap_trim_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let big = "x".repeat(400 * 1024);
        for i in 0..25 {
            let mut s = capture(
                &json!({ "model": "m", "messages": [{ "role": "user", "content": big }] }),
                &Identity { session: format!("s{i}"), ..Default::default() },
            );
            s.at = crate::audit::now();
            append(&dir, &s);
        }
        let len = std::fs::metadata(log_path(&dir)).unwrap().len();
        assert!(len <= SNAPSHOT_LOG_MAX_BYTES, "{len} bytes left over the threshold");
        let all = read_all(&dir);
        // The trim really ran: 25 records of ~400 KB do not all fit.
        assert!(all.len() < 25, "only {} records; capture may have truncated", all.len());
        assert!(!all.is_empty() && all.last().unwrap().session == "s24");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// AH-083: forgetting has to reach the prompts the memory was already
    /// sent in. What is left behind says a redaction happened, so the record
    /// still shows that something was there.
    #[test]
    fn forgotten_text_leaves_the_prompts_it_was_sent_in() {
        let dir = std::env::temp_dir().join(format!(
            "jan-snap-redact-{}-{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH.elapsed().unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let secret = "the staging host is called larkspur";
        let carrying = capture(
            &json!({ "messages": [
                { "role": "system", "content": format!("<remembered_facts>\n- [mem-1] (user) {secret}\n</remembered_facts>") },
                { "role": "user", "content": "deploy it" },
            ] }),
            &Identity { session: "s1".into(), ..Default::default() },
        );
        let other = capture(
            &json!({ "messages": [{ "role": "user", "content": "nothing to do with it" }] }),
            &Identity { session: "s2".into(), ..Default::default() },
        );
        append(&dir, &carrying);
        append(&dir, &other);

        let changed = redact_text(&dir, &[secret], "forgotten memory").expect("a rewrite");
        assert_eq!(changed, 1, "only the snapshot that carried it is rewritten");

        let raw = std::fs::read_to_string(log_path(&dir)).unwrap();
        assert!(!raw.contains(secret), "the forgotten words are still on disk: {raw}");
        assert!(raw.contains("[redacted: forgotten memory]"), "{raw}");

        let back = find(&dir, &carrying.id).expect("the snapshot is still there");
        // The request is still readable: what it asked, and that something was
        // taken out of it.
        assert!(back.render_text().contains("deploy it"));
        assert!(back.render_text().contains("[redacted: forgotten memory]"));
        assert!(back.redactions.iter().any(|r| r.why == "forgotten memory"));
        assert!(back.payload.get("messages").is_some(), "the payload is still a payload");
        // And nobody else's snapshot was touched.
        let untouched = find(&dir, &other.id).expect("the other session's snapshot");
        assert_eq!(untouched.payload, other.payload);
        assert!(untouched.redactions.is_empty());

        // Idempotent: a second forget of the same words changes nothing more.
        assert_eq!(redact_text(&dir, &[secret], "forgotten memory").unwrap(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Nothing to redact, nothing to rewrite -- and a needle that is only
    /// whitespace is not a needle at all.
    #[test]
    fn redaction_refuses_to_rewrite_for_nothing() {
        let dir = std::env::temp_dir().join(format!(
            "jan-snap-redact-none-{}-{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH.elapsed().unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let snap = capture(
            &json!({ "messages": [{ "role": "user", "content": "keep me" }] }),
            &Identity { session: "s1".into(), ..Default::default() },
        );
        append(&dir, &snap);
        let before = std::fs::read_to_string(log_path(&dir)).unwrap();
        assert_eq!(redact_text(&dir, &["   "], "forgotten memory").unwrap(), 0);
        assert_eq!(redact_text(&dir, &[], "forgotten memory").unwrap(), 0);
        assert_eq!(redact_text(&dir, &["never sent"], "forgotten memory").unwrap(), 0);
        assert_eq!(std::fs::read_to_string(log_path(&dir)).unwrap(), before);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// AH-087: the text view carries every message whole, in order, with its
    /// role, each tool call with its arguments, and the tools offered.
    #[test]
    fn the_text_view_is_what_the_model_saw() {
        let long = "x".repeat(5_000);
        let payload = json!({
            "model": "m",
            "messages": [
                { "role": "system", "content": "You are Jan. Today is 2026-09-11." },
                { "role": "user", "content": [{ "type": "text", "text": format!("read it {long}") }, { "type": "image_url", "image_url": { "url": "data:x" } }] },
                { "role": "assistant", "content": null, "tool_calls": [{ "id": "c1", "type": "function", "function": { "name": "read", "arguments": "{\"path\":\"README.md\"}" } }] },
                { "role": "tool", "tool_call_id": "c1", "content": "# Readme" },
            ],
            "tools": [{ "type": "function", "function": { "name": "read" } }, { "type": "function", "function": { "name": "ls" } }],
        });
        let snap = capture(&payload, &Identity { session: "s1".into(), ..Default::default() });
        let text = snap.render_text();
        let order = ["1 · system", "Today is 2026-09-11", "2 · user", "3 · assistant", "4 · tool · result of c1", "# Readme"];
        let mut at = 0;
        for needle in order {
            let found = text[at..].find(needle).unwrap_or_else(|| panic!("{needle} missing or out of order:\n{text}"));
            at += found;
        }
        assert!(text.contains(&long), "a long message was cut");
        assert!(text.contains("[image_url part]"));
        assert!(text.contains("[tool call c1] read({\"path\":\"README.md\"})"));
        assert!(text.contains("tools offered: 2 ---\nread, ls"));
        assert!(text.contains(&snap.hash));
    }

    /// A credential is not in the text view: it was redacted before the
    /// snapshot was written, and the header says a redaction was made.
    #[test]
    fn the_text_view_shows_redactions_not_secrets() {
        let payload = json!({ "messages": [{ "role": "user", "content": "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }] });
        let snap = capture(&payload, &Identity::default());
        let text = snap.render_text();
        assert!(!text.contains("AAAAAAAAAAAAAAAAAAAA"), "{text}");
        assert!(!text.contains(" 0 redaction(s)"), "{text}");
    }

    #[test]
    fn a_snapshot_without_a_payload_says_why() {
        let snap = unavailable(&Identity::default(), Unavailable::TooLarge);
        let text = snap.render_text();
        assert!(text.contains("no payload was kept: TooLarge"), "{text}");
        assert!(!text.contains("tools offered"));
    }

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jan-snap-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn ident() -> Identity {
        Identity {
            session: "s1".into(),
            run: "r1".into(),
            thread: "t1".into(),
            agent: "main".into(),
            provider: "openai".into(),
            ..Default::default()
        }
    }

    fn payload() -> Value {
        json!({
            "model": "gpt-4o",
            "reasoning": { "effort": "high" },
            "messages": [
                { "role": "system", "content": "You are a coding agent." },
                { "role": "user", "content": "read src/main.rs lines 1-40" }
            ],
            "tools": [
                { "type": "function", "function": { "name": "read", "parameters": {} } },
                { "type": "function", "function": { "name": "bash", "parameters": {} } }
            ]
        })
    }

    // ---- retention and deletion (AH-078) ---------------------------------

    fn seeded(tag: &str, sessions: &[&str]) -> PathBuf {
        let d = dir(tag);
        for (i, s) in sessions.iter().enumerate() {
            let mut id = ident();
            id.session = (*s).into();
            id.run = format!("r{i}");
            append(&d, &capture(&payload(), &id));
        }
        d
    }

    #[test]
    fn deleting_a_session_removes_only_its_snapshots() {
        let d = seeded("del", &["a", "b", "a", "c"]);
        assert_eq!(delete_session(&d, "a").unwrap(), 2);
        let left: Vec<String> = read_all(&d).into_iter().map(|s| s.session).collect();
        assert_eq!(left, vec!["b", "c"]);
        assert!(by_session(&d, "a").is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn deleting_needs_a_session() {
        let d = seeded("del-empty", &["a"]);
        assert!(delete_session(&d, "  ").is_err());
        assert_eq!(read_all(&d).len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn retention_keeps_the_newest() {
        let d = seeded("prune", &["s0", "s1", "s2", "s3", "s4"]);
        assert_eq!(prune(&d, 2).unwrap(), 3);
        let left: Vec<String> = read_all(&d).into_iter().map(|s| s.session).collect();
        assert_eq!(left, vec!["s3", "s4"]);
        assert_eq!(prune(&d, 2).unwrap(), 0, "nothing more to drop");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_torn_line_survives_a_rewrite() {
        let d = seeded("torn", &["a", "b"]);
        let path = log_path(&d);
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str("{\"v\":1,\"id\":\"half\n");
        std::fs::write(&path, raw).unwrap();
        delete_session(&d, "a").unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"half"), "an unattributable line was dropped");
        assert_eq!(read_all(&d).len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    // ---- ids ------------------------------------------------------------

    /// An earlier launch of the app numbered its snapshots from 1 as well. A
    /// new snapshot must not take one of those ids, or a lookup by id --
    /// the timeline's, and a replay's -- finds the older record instead.
    #[test]
    fn an_id_from_an_earlier_launch_is_never_issued_again() {
        let d = dir("relaunch");
        let earlier = capture(&payload(), &ident());
        for n in 1..=2000 {
            let mut old = earlier.clone();
            old.id = format!("snap-{n}");
            old.run = "earlier-launch".into();
            append(&d, &old);
        }
        let mine = capture(&payload(), &ident());
        append(&d, &mine);
        let found = find(&d, &mine.id).expect("the new snapshot is on disk");
        assert_eq!(found.run, "r1", "{} named an earlier launch's record", mine.id);
    }

    // ---- the snapshot is the dispatch -----------------------------------

    #[test]
    fn the_snapshot_is_the_payload_that_was_sent() {
        let snap = capture(&payload(), &ident());
        assert_eq!(
            snap.payload,
            payload(),
            "no field may be dropped or reshaped"
        );
        assert_eq!(snap.model, "gpt-4o");
        assert_eq!(snap.reasoning, json!({ "effort": "high" }));
        assert_eq!(snap.message_count(), 2);
        assert_eq!(snap.tool_names(), vec!["read", "bash"]);
        assert_eq!(
            snap.system_prompt().as_deref(),
            Some("You are a coding agent.")
        );
        assert_eq!(snap.session, "s1");
        assert_eq!(snap.run, "r1");
        assert_eq!(snap.agent, "main");
    }

    #[test]
    fn the_same_payload_hashes_the_same_however_it_was_built() {
        // Key order must not change the hash, or a retry of an identical
        // payload would look like a different one.
        let a = capture(
            &json!({ "a": 1, "b": [1, 2], "c": { "x": true } }),
            &ident(),
        );
        let b = capture(
            &json!({ "c": { "x": true }, "b": [1, 2], "a": 1 }),
            &ident(),
        );
        assert_eq!(a.hash, b.hash);
        // ...and ids are still distinct, so two dispatches are two records.
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn a_changed_payload_cannot_hide_behind_the_old_hash() {
        // The property AH-078 asks for: a retry that sends anything different
        // gets a different hash.
        let first = capture(&payload(), &ident());
        let mut altered = payload();
        altered["messages"][1]["content"] = json!("read /etc/shadow");
        let retry = capture(&altered, &ident());
        assert_ne!(first.hash, retry.hash);
    }

    // ---- redaction before persistence -----------------------------------

    #[test]
    fn credentials_never_reach_the_record() {
        let leaky = json!({
            "model": "gpt-4o",
            "headers": {
                "authorization": "Bearer sk-abcdefghijklmnopqrstuvwxyz",
                "cookie": "session=abc123",
                "content-type": "application/json"
            },
            "api_key": "sk-livekeyvalue",
            "messages": [
                { "role": "user", "content": "PGPASSWORD=hunter2 psql -h db" }
            ]
        });
        let snap = capture(&leaky, &ident());
        let serialized = serde_json::to_string(&snap).unwrap();

        assert!(!serialized.contains("sk-abcdefghijklmnopqrstuvwxyz"));
        assert!(!serialized.contains("sk-livekeyvalue"));
        assert!(!serialized.contains("session=abc123"));
        assert!(!serialized.contains("hunter2"));
        // A field that is not a credential is untouched.
        assert_eq!(snap.payload["headers"]["content-type"], "application/json");
    }

    #[test]
    fn redactions_say_where_and_why_not_merely_how_many() {
        let snap = capture(
            &json!({ "headers": { "authorization": "Bearer x" }, "api_key": "k" }),
            &ident(),
        );
        let paths: Vec<&str> = snap.redactions.iter().map(|r| r.path.as_str()).collect();
        assert!(paths.contains(&"headers.authorization"), "{paths:?}");
        assert!(paths.contains(&"api_key"), "{paths:?}");
        let why: Vec<&str> = snap.redactions.iter().map(|r| r.why.as_str()).collect();
        assert!(why.contains(&"auth-header"));
        assert!(why.contains(&"api-key"));
    }

    #[test]
    fn a_credential_nested_in_a_tool_argument_is_still_found() {
        let snap = capture(
            &json!({
                "messages": [{
                    "role": "assistant",
                    "tool_calls": [{
                        "function": {
                            "name": "http",
                            "arguments": { "headers": { "Authorization": "Bearer secret" } }
                        }
                    }]
                }]
            }),
            &ident(),
        );
        assert!(!serde_json::to_string(&snap)
            .unwrap()
            .contains("Bearer secret"));
        assert!(!snap.redactions.is_empty());
    }

    #[test]
    fn the_hash_is_of_the_redacted_payload() {
        // Otherwise a reader could not verify the record against its own hash.
        let snap = capture(&json!({ "api_key": "k", "model": "m" }), &ident());
        assert_eq!(snap.hash, hash_payload(&snap.payload));
    }

    // ---- storage --------------------------------------------------------

    #[test]
    fn a_snapshot_survives_a_restart_and_is_found_by_run_and_session() {
        let d = dir("restart");
        let a = capture(&payload(), &ident());
        let mut other = ident();
        other.run = "r2".into();
        other.session = "s2".into();
        let b = capture(&payload(), &other);
        append(&d, &a);
        append(&d, &b);

        assert_eq!(read_all(&d).len(), 2);
        assert_eq!(find(&d, &a.id).unwrap().hash, a.hash);
        assert_eq!(by_run(&d, "r1").len(), 1);
        assert_eq!(by_session(&d, "s2")[0].id, b.id);
        assert!(find(&d, "snap-does-not-exist").is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_truncated_final_record_costs_only_itself() {
        let d = dir("truncated");
        append(&d, &capture(&payload(), &ident()));
        append(&d, &capture(&payload(), &ident()));
        let path = log_path(&d);
        let mut body = std::fs::read_to_string(&path).unwrap();
        body.push_str("{\"v\":1,\"id\":\"snap-tr");
        std::fs::write(&path, body).unwrap();

        assert_eq!(read_all(&d).len(), 2, "the complete records must survive");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unavailable_snapshot_says_so_rather_than_leaving_a_gap() {
        let d = dir("unavailable");
        append(&d, &unavailable(&ident(), Unavailable::TooLarge));
        let back = &read_all(&d)[0];
        assert_eq!(back.unavailable, Some(Unavailable::TooLarge));
        assert!(back.payload.is_null());
        assert!(back.hash.is_empty());
        // The identity is still there, so the gap is attributable.
        assert_eq!(back.run, "r1");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_missing_log_reads_as_empty() {
        let d = dir("absent");
        assert!(read_all(&d).is_empty());
        assert!(by_run(&d, "r1").is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }
}

/// Scoped retrieval, shared by the Tauri command and its tests. AH-078.
///
/// Split out of the command so the boundary can be tested without a Tauri
/// app handle: the rule is what matters, not the transport.
///
/// An id alone is not authority. The caller must also name the session or run
/// it believes the snapshot belongs to, and the record has to agree — otherwise
/// ids are guessable and the scope is decorative.
pub fn scoped_lookup(
    data_folder: &Path,
    snapshot_id: Option<&str>,
    run: Option<&str>,
    session: Option<&str>,
) -> Result<Vec<PromptSnapshot>, String> {
    if let Some(id) = snapshot_id {
        if session.is_none() && run.is_none() {
            return Err(
                "a snapshot must be requested with the session or run it belongs to".into(),
            );
        }
        let Some(found) = find(data_folder, id) else {
            return Ok(Vec::new());
        };
        let in_scope =
            session.map_or(true, |s| found.session == s) && run.map_or(true, |r| found.run == r);
        if !in_scope {
            return Err(
                "a snapshot must be requested with the session or run it belongs to".into(),
            );
        }
        return Ok(vec![found]);
    }
    match (run, session) {
        (Some(run), _) => Ok(by_run(data_folder, run)),
        (None, Some(session)) => Ok(by_session(data_folder, session)),
        // Refused rather than returning everything: an unscoped list is every
        // prompt in every session.
        (None, None) => Err("name a snapshot id, a run, or a session".into()),
    }
}

#[cfg(test)]
mod scope_tests {
    use super::*;
    use serde_json::json;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jan-snapscope-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn seed(d: &Path) -> (PromptSnapshot, PromptSnapshot) {
        let mine = capture(
            &json!({ "model": "m", "messages": [{ "role": "user", "content": "mine" }] }),
            &Identity {
                session: "s-mine".into(),
                run: "r-mine".into(),
                thread: "t".into(),
                agent: "main".into(),
                provider: "openai".into(),
                ..Default::default()
            },
        );
        let theirs = capture(
            &json!({ "model": "m", "messages": [{ "role": "user", "content": "theirs" }] }),
            &Identity {
                session: "s-theirs".into(),
                run: "r-theirs".into(),
                thread: "t".into(),
                agent: "main".into(),
                provider: "openai".into(),
                ..Default::default()
            },
        );
        append(d, &mine);
        append(d, &theirs);
        (mine, theirs)
    }

    #[test]
    fn a_session_sees_only_its_own_snapshots() {
        let d = dir("session");
        let (mine, _) = seed(&d);
        let got = scoped_lookup(&d, None, None, Some("s-mine")).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, mine.id);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_run_sees_only_its_own_snapshots() {
        let d = dir("run");
        let (mine, _) = seed(&d);
        let got = scoped_lookup(&d, None, Some("r-mine"), None).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, mine.id);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_id_from_another_session_is_refused_not_returned() {
        // The boundary that matters: knowing an id must not be enough.
        let d = dir("cross");
        let (_, theirs) = seed(&d);
        let refused = scoped_lookup(&d, Some(&theirs.id), None, Some("s-mine"));
        assert!(refused.is_err(), "{refused:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_id_from_another_run_is_refused() {
        let d = dir("cross-run");
        let (_, theirs) = seed(&d);
        assert!(scoped_lookup(&d, Some(&theirs.id), Some("r-mine"), None).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_id_on_its_own_is_refused() {
        let d = dir("bare-id");
        let (mine, _) = seed(&d);
        assert!(
            scoped_lookup(&d, Some(&mine.id), None, None).is_err(),
            "an id alone must not be authority"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unscoped_list_is_refused() {
        let d = dir("unscoped");
        seed(&d);
        assert!(
            scoped_lookup(&d, None, None, None).is_err(),
            "an unscoped list is every prompt in every session"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_correctly_scoped_id_is_returned() {
        let d = dir("ok");
        let (mine, _) = seed(&d);
        let got = scoped_lookup(&d, Some(&mine.id), None, Some("s-mine")).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, mine.id);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unknown_id_is_empty_rather_than_an_error() {
        // Absence is not a permission failure, and must not be reported as one.
        let d = dir("unknown");
        seed(&d);
        let got = scoped_lookup(&d, Some("snap-nope"), None, Some("s-mine")).unwrap();
        assert!(got.is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }
}
