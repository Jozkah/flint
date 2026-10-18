//! The tool-effect ledger: what a run did to the world, in order.
//!
//! The transcript says what the model said and the diff says what the tree
//! looks like now; neither says which calls changed it. The ledger is an
//! append-only record, stored with the run in its session event log
//! (`ledger.effect` events), of every call that can have side effects:
//!
//! * **file writes** (`write`, `edit`) with the file's sha256 before and after,
//!   so "this run changed `a.rs`" is a fact and not an inference, and a write
//!   that was refused or changed nothing says so;
//! * **commands** (`bash` and the other shells) with the command line and
//!   whether it succeeded;
//! * **network** calls (`web_fetch`, `web_search`, ...) with what was asked for;
//! * **other tools** whose effect the harness cannot see (MCP servers), named
//!   but not described.
//!
//! The payload goes through the event log's own redaction, so a secret on a
//! command line is removed like anywhere else in the log. Reading is
//! `flint cli agent ledger <run>`; the entries are ordinary events too, so
//! anything that reads the log sees them.

use std::fmt::Write as _;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri_plugin_agent_tools::event_log;
use tauri_plugin_agent_tools::tools::{lookup, Capability};

/// The event kind a ledger entry is stored under.
pub const KIND: &str = "ledger.effect";

/// Files larger than this are noted but not hashed.
const MAX_HASHED_BYTES: u64 = 16 * 1024 * 1024;
/// A command or target longer than this is cut.
const MAX_TARGET_CHARS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectKind {
    FileWrite,
    Command,
    Network,
    /// A tool whose effect the harness cannot observe.
    External,
}

impl EffectKind {
    fn tag(self) -> &'static str {
        match self {
            Self::FileWrite => "file_write",
            Self::Command => "command",
            Self::Network => "network",
            Self::External => "external",
        }
    }
}

/// One ledger entry as stored and as read back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub run: String,
    pub kind: EffectKind,
    pub tool: String,
    pub call_id: String,
    /// The path, command line or URL.
    pub target: String,
    /// Whether the call succeeded (not whether it changed anything).
    pub ok: bool,
    /// File writes: the file's sha256 before the call; `None` when it did not
    /// exist (or could not be hashed, see `note`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    /// File writes: whether the content differs after the call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// What is known about a call before it runs.
#[derive(Debug, Clone)]
pub(crate) struct Pending {
    call_id: String,
    tool: String,
    kind: EffectKind,
    target: String,
    path: Option<PathBuf>,
    before: Hashed,
}

#[derive(Debug, Clone, PartialEq)]
enum Hashed {
    NotApplicable,
    Missing,
    Hash(String),
    Skipped(&'static str),
}

impl Pending {
    pub(crate) fn call_id(&self) -> &str {
        &self.call_id
    }
}

/// Classify a call, or `None` when it cannot have side effects worth a record.
fn classify(tool: &str, args: &Value) -> Option<(EffectKind, String, Option<String>)> {
    if crate::core::agent::subagent::is_subagent_tool(tool) {
        return None;
    }
    let text = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_string);
    match lookup(tool) {
        Some(builtin) => match builtin.capability {
            Capability::Read => None,
            Capability::Write => {
                let path = builtin.path_args.iter().find_map(|k| text(k));
                match path {
                    Some(p) => Some((EffectKind::FileWrite, p.clone(), Some(p))),
                    None => Some((EffectKind::External, tool.to_string(), None)),
                }
            }
            Capability::Exec => {
                let command = text("command").or_else(|| text("script")).or_else(|| text("cmd")).unwrap_or_else(|| tool.to_string());
                Some((EffectKind::Command, command, None))
            }
            Capability::Net => {
                let target = text("url").or_else(|| text("query")).unwrap_or_else(|| tool.to_string());
                Some((EffectKind::Network, target, None))
            }
        },
        // Not a built-in: a tool from an MCP server or the host.
        None => Some((EffectKind::External, tool.to_string(), None)),
    }
}

/// `path` under `root`, or `None` when it is absolute outside the root or
/// climbs out of it.
fn within(root: &Path, path: &str) -> Option<PathBuf> {
    let rel = Path::new(path);
    if rel.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    let full = if rel.is_absolute() { rel.to_path_buf() } else { root.join(rel) };
    full.starts_with(root).then_some(full)
}

fn hash_file(path: &Path) -> Hashed {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Hashed::Missing,
        Err(_) => return Hashed::Skipped("unreadable"),
    };
    if !meta.is_file() {
        return Hashed::Skipped("not a regular file");
    }
    if meta.len() > MAX_HASHED_BYTES {
        return Hashed::Skipped("too large to hash");
    }
    match std::fs::read(path) {
        Ok(bytes) => Hashed::Hash(format!("{:x}", Sha256::digest(&bytes))),
        Err(_) => Hashed::Skipped("unreadable"),
    }
}

fn cut(text: &str) -> String {
    if text.chars().count() <= MAX_TARGET_CHARS {
        text.to_string()
    } else {
        let head: String = text.chars().take(MAX_TARGET_CHARS).collect();
        format!("{head}...")
    }
}

/// Look at a batch of calls before it runs: classify each and hash the files
/// the writes are about to change. `root` is the project folder (`None` for an
/// invoker that has none, which records writes without hashes).
pub(crate) fn before_batch(root: Option<&Path>, calls: &[Value]) -> Vec<Pending> {
    calls
        .iter()
        .filter_map(|call| {
            let function = call.get("function")?;
            let tool = function.get("name")?.as_str()?.to_string();
            let id = call.get("id")?.as_str()?.to_string();
            let args: Value = function
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|raw| serde_json::from_str(raw).ok())
                .or_else(|| function.get("arguments").cloned())
                .unwrap_or(Value::Null);
            let (kind, target, path) = classify(&tool, &args)?;
            let (path, before) = match (kind, path, root) {
                (EffectKind::FileWrite, Some(p), Some(root)) => match within(root, &p) {
                    Some(full) => {
                        let before = hash_file(&full);
                        (Some(full), before)
                    }
                    None => (None, Hashed::Skipped("outside the project")),
                },
                (EffectKind::FileWrite, _, None) => (None, Hashed::Skipped("no project folder")),
                _ => (None, Hashed::NotApplicable),
            };
            Some(Pending { call_id: id, tool, kind, target: cut(&target), path, before })
        })
        .collect()
}

/// Turn a finished call into its entry. `failed` is the loop's one failure
/// classification for the call.
pub(crate) fn finish(pending: Pending, failed: bool) -> Entry {
    let after = match (&pending.path, pending.kind) {
        (Some(path), EffectKind::FileWrite) => hash_file(path),
        (_, EffectKind::FileWrite) => pending.before.clone(),
        _ => Hashed::NotApplicable,
    };
    let (before_hash, after_hash, changed, note) = match (&pending.before, &after) {
        (Hashed::NotApplicable, _) => (None, None, None, None),
        (Hashed::Skipped(why), _) | (_, Hashed::Skipped(why)) => (None, None, None, Some((*why).to_string())),
        (before, after) => {
            let h = |x: &Hashed| match x {
                Hashed::Hash(h) => Some(h.clone()),
                _ => None,
            };
            (h(before), h(after), Some(before != after), None)
        }
    };
    Entry {
        seq: 0,
        run: String::new(),
        kind: pending.kind,
        tool: pending.tool,
        call_id: pending.call_id,
        target: pending.target,
        ok: !failed,
        before: before_hash,
        after: after_hash,
        changed,
        note,
    }
}

/// Append an entry to the run's record. Best effort: the ledger must never fail
/// the call it describes.
pub(crate) fn append(data_folder: &Path, session: &str, run: &str, invocation: &str, entry: &Entry) {
    if session.is_empty() {
        return;
    }
    let _ = event_log::append(
        data_folder,
        event_log::NewEvent {
            id: format!("ledger:{run}:{}", entry.call_id),
            session: session.to_string(),
            run: run.to_string(),
            invocation: invocation.to_string(),
            kind: KIND.to_string(),
            payload: serde_json::to_value(entry).unwrap_or(Value::Null),
        },
    );
}

/// The ledger for `run_or_session`: a run id (`<session>#run-N`) selects that
/// run, a session id selects every run in it. Oldest first.
pub fn read(data_folder: &Path, run_or_session: &str) -> Result<Vec<Entry>, String> {
    let wanted = run_or_session.trim();
    if wanted.is_empty() {
        return Err("name the run (or session) whose ledger to show".to_string());
    }
    let session = wanted.split('#').next().unwrap_or(wanted);
    let events = event_log::read_session(data_folder, session).map_err(|e| format!("the session log could not be read: {e:?}"))?;
    let mut out = Vec::new();
    for event in events.into_iter().filter(|e| e.kind == KIND) {
        if wanted != session && event.run != wanted {
            continue;
        }
        if let Ok(mut entry) = serde_json::from_value::<Entry>(event.payload) {
            entry.seq = event.seq;
            entry.run = event.run;
            out.push(entry);
        }
    }
    Ok(out)
}

/// The ledger as the CLI prints it.
pub fn render_text(entries: &[Entry]) -> String {
    if entries.is_empty() {
        return "no side-effecting tool calls are recorded for this run\n".to_string();
    }
    let mut out = format!("{} recorded effect(s)\n", entries.len());
    for e in entries {
        let _ = write!(out, "{:>4}  {:<10} {:<14} {:<6}", e.seq, e.kind.tag(), e.tool, if e.ok { "ok" } else { "failed" });
        let _ = write!(out, " {}", e.target.replace('\n', " "));
        match (&e.before, &e.after, e.changed) {
            (_, _, Some(false)) => out.push_str("  (unchanged)"),
            (before, Some(after), Some(true)) => {
                let short = |h: &str| h.chars().take(12).collect::<String>();
                let _ = write!(
                    out,
                    "  {} -> {}",
                    before.as_deref().map(short).unwrap_or_else(|| "(new file)".to_string()),
                    short(after)
                );
            }
            (_, None, Some(true)) => out.push_str("  (removed)"),
            _ => {}
        }
        if let Some(note) = &e.note {
            let _ = write!(out, "  [{note}]");
        }
        out.push('\n');
    }
    let changed: Vec<&str> = entries
        .iter()
        .filter(|e| e.kind == EffectKind::FileWrite && e.changed == Some(true))
        .map(|e| e.target.as_str())
        .collect();
    if !changed.is_empty() {
        let mut unique = changed;
        unique.sort_unstable();
        unique.dedup();
        let _ = writeln!(out, "files changed: {}", unique.join(", "));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(id: &str, tool: &str, args: Value) -> Value {
        json!({ "id": id, "type": "function", "function": { "name": tool, "arguments": args.to_string() } })
    }

    #[test]
    fn reads_are_not_effects_and_the_rest_are_classified() {
        let dir = tempfile::tempdir().unwrap();
        let pending = before_batch(
            Some(dir.path()),
            &[
                call("1", "read", json!({"path": "a"})),
                call("2", "write", json!({"path": "a", "content": "x"})),
                call("3", "bash", json!({"command": "ls"})),
                call("4", "web_fetch", json!({"url": "https://example.com"})),
                call("5", "some_mcp_tool", json!({})),
                call("6", "dispatch_subagent", json!({})),
            ],
        );
        let kinds: Vec<(&str, EffectKind)> = pending.iter().map(|p| (p.call_id.as_str(), p.kind)).collect();
        assert_eq!(
            kinds,
            vec![
                ("2", EffectKind::FileWrite),
                ("3", EffectKind::Command),
                ("4", EffectKind::Network),
                ("5", EffectKind::External),
            ]
        );
    }

    #[test]
    fn a_write_records_the_hash_before_and_after() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "one").unwrap();
        let calls = [call("1", "edit", json!({"path": "a.txt"}))];
        let pending = before_batch(Some(dir.path()), &calls);
        std::fs::write(&file, "two").unwrap();
        let entry = finish(pending.into_iter().next().unwrap(), false);
        assert_eq!(entry.before.as_deref(), Some(format!("{:x}", Sha256::digest(b"one")).as_str()));
        assert_eq!(entry.after.as_deref(), Some(format!("{:x}", Sha256::digest(b"two")).as_str()));
        assert_eq!(entry.changed, Some(true));
        assert!(entry.ok);
    }

    #[test]
    fn a_new_file_has_no_before_and_a_refused_write_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let calls = [call("1", "write", json!({"path": "new.txt"})), call("2", "write", json!({"path": "kept.txt"}))];
        std::fs::write(dir.path().join("kept.txt"), "k").unwrap();
        let mut pending = before_batch(Some(dir.path()), &calls).into_iter();
        std::fs::write(dir.path().join("new.txt"), "n").unwrap();
        let created = finish(pending.next().unwrap(), false);
        assert_eq!((created.before.clone(), created.changed), (None, Some(true)));
        assert!(created.after.is_some());
        let refused = finish(pending.next().unwrap(), true);
        assert_eq!(refused.changed, Some(false));
        assert!(!refused.ok);
    }

    #[test]
    fn a_path_outside_the_project_is_recorded_but_never_hashed() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        let abs = outside.path().to_string_lossy().to_string();
        let calls = [call("1", "write", json!({"path": abs})), call("2", "write", json!({"path": "../up.txt"}))];
        for p in before_batch(Some(dir.path()), &calls) {
            let entry = finish(p, false);
            assert_eq!(entry.before, None);
            assert_eq!(entry.note.as_deref(), Some("outside the project"));
        }
    }

    #[test]
    fn entries_are_appended_to_the_session_log_and_read_back_by_run_or_session() {
        let data = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let session = "ledger-s1";
        for (run, id, tool, args) in [
            ("ledger-s1#run-1", "c1", "write", json!({"path": "a.txt"})),
            ("ledger-s1#run-1", "c2", "bash", json!({"command": "cargo test"})),
            ("ledger-s1#run-2", "c3", "bash", json!({"command": "ls"})),
        ] {
            let pending = before_batch(Some(dir.path()), &[call(id, tool, args)]);
            if tool == "write" {
                std::fs::write(dir.path().join("a.txt"), "hi").unwrap();
            }
            append(data.path(), session, run, "inv", &finish(pending.into_iter().next().unwrap(), false));
        }
        let one = read(data.path(), "ledger-s1#run-1").unwrap();
        assert_eq!(one.iter().map(|e| e.call_id.as_str()).collect::<Vec<_>>(), ["c1", "c2"]);
        let all = read(data.path(), session).unwrap();
        assert_eq!(all.len(), 3);
        assert!(all.windows(2).all(|w| w[0].seq < w[1].seq), "append-only and ordered");
        let text = render_text(&one);
        assert!(text.contains("file_write") && text.contains("(new file)") && text.contains("cargo test"), "{text}");
        assert!(text.contains("files changed: a.txt"));
        assert!(render_text(&[]).contains("no side-effecting"));
        assert!(read(data.path(), " ").is_err());
    }

    #[test]
    fn writing_the_same_call_twice_is_one_entry() {
        let data = tempfile::tempdir().unwrap();
        let pending = before_batch(None, &[call("c1", "bash", json!({"command": "ls"}))]);
        let entry = finish(pending.into_iter().next().unwrap(), false);
        append(data.path(), "s2", "s2#run-1", "i", &entry);
        append(data.path(), "s2", "s2#run-1", "i", &entry);
        assert_eq!(read(data.path(), "s2").unwrap().len(), 1);
    }
}
