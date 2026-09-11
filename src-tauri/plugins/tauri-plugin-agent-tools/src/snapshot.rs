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

/// Unique across restarts, not just within one process: the log outlives the
/// process, and a counter alone restarted at `snap-1` and handed a new
/// snapshot the id of an old one, so a lookup by id could return the wrong
/// request. Start time and pid separate processes; the counter separates
/// snapshots inside one.
fn next_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::OnceLock;
    static NEXT: AtomicU64 = AtomicU64::new(1);
    static PROCESS: OnceLock<String> = OnceLock::new();
    let process = PROCESS.get_or_init(|| {
        let started = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("{started:x}-{:x}", std::process::id())
    });
    format!("snap-{process}-{}", NEXT.fetch_add(1, Ordering::Relaxed))
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
    // Bounded by count, checked cheaply: only a log big enough to possibly
    // hold more than the cap is read back and counted.
    let big = std::fs::metadata(log_path(data_folder))
        .map(|m| m.len() > 8 * 1024 * 1024)
        .unwrap_or(false);
    if big {
        if let Err(e) = prune(data_folder, MAX_SNAPSHOTS) {
            eprintln!("prompt snapshot: could not apply retention: {e}");
        }
    }
}

fn try_append(data_folder: &Path, snapshot: &PromptSnapshot) -> Result<(), String> {
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
    fn ids_carry_the_process_so_a_restart_cannot_reuse_one() {
        // A bare counter restarts at 1 in every process, so the first
        // snapshot after a restart used to be `snap-1` again, the same id as
        // an older record in the same log.
        let a = next_id();
        let b = next_id();
        assert_ne!(a, b);
        let parts: Vec<&str> = a.split('-').collect();
        assert_eq!(parts.len(), 4, "snap-<start>-<pid>-<n>, got {a}");
        assert_eq!(parts[0], "snap");
        assert_eq!(parts[2], format!("{:x}", std::process::id()));
        assert_ne!(a, "snap-1");
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
