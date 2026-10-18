//! The loop's side of approvals that are scoped, deferred, or void.
//!
//! The stores and the matching live in `tauri_plugin_agent_tools`
//! ([`scoped_rules`](tauri_plugin_agent_tools::scoped_rules),
//! [`deferred_approvals`](tauri_plugin_agent_tools::deferred_approvals)); this
//! file is what the agent loop and the surfaces that answer prompts share:
//!
//! - the answer's *form*: which scope the person picked for a request, passed
//!   next to the decision rather than inside it, so the decision enum every
//!   surface already matches on is unchanged;
//! - "answer later": a request marked as deferred, and the words the model is
//!   given when its call is deferred, still pending, refused as expired, or
//!   denied while nobody was there;
//! - `[approvals]` in `agent.toml`;
//! - the note a run gets after a checkpoint restore, naming the earlier
//!   approvals and refusals that no longer stand.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::Value;
use tauri_plugin_agent_tools::scoped_rules::ApprovalScope;

/// `[approvals]` -- what a run does at a prompt nobody is there to answer.
///
/// `defer = true` records the question and ends the run instead of denying the
/// call on the spot; the call is then answered with `flint cli approvals allow` or
/// `deny` and the session resumed. It never grants anything: an unanswered or
/// expired question leaves the call unrun.
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct ApprovalsSection {
    #[serde(default)]
    pub defer: bool,
    /// How long a deferred question stays answerable. Unset is a day; the
    /// longest is a week.
    #[serde(default)]
    pub defer_ttl_hours: Option<u64>,
}

impl ApprovalsSection {
    pub fn ttl_secs(&self) -> u64 {
        self.defer_ttl_hours
            .map(|h| h.saturating_mul(3600))
            .unwrap_or(0)
    }
}

/// What one run knows about approvals.
#[derive(Default)]
pub(crate) struct Runtime {
    /// Defer a prompt nobody can answer, with this time to live (`0` is the
    /// default). `None` keeps today's behavior: the prompt is denied.
    pub defer_unattended: Option<u64>,
    /// Ids of the questions this run deferred.
    deferred: Mutex<Vec<String>>,
}

impl Runtime {
    pub fn from_section(section: &ApprovalsSection) -> Self {
        Self {
            defer_unattended: section.defer.then(|| section.ttl_secs()),
            deferred: Mutex::new(Vec::new()),
        }
    }

    pub fn note_deferred(&self, id: &str) {
        let mut ids = self.deferred.lock().unwrap_or_else(|e| e.into_inner());
        if !ids.iter().any(|i| i == id) {
            ids.push(id.to_string());
        }
    }

    /// The questions this run has deferred, once any.
    pub fn deferred_ids(&self) -> Vec<String> {
        self.deferred.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

// -- the form's answer and the "answer later" mark ----------------------------

// Only the headless surfaces (CLI, `serve`) relay these answers.
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
const TABLE_CAP: usize = 512;

static SCOPE_CHOICES: Mutex<Option<HashMap<String, ApprovalScope>>> = Mutex::new(None);
static DEFER_MARKS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// The scope a person picked for open request `request_id`. Called by the
/// surface that relays the answer, before it sends the decision.
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
pub(crate) fn record_scope_choice(request_id: &str, scope: ApprovalScope) {
    let mut table = SCOPE_CHOICES.lock().unwrap_or_else(|e| e.into_inner());
    let table = table.get_or_insert_with(HashMap::new);
    if table.len() >= TABLE_CAP {
        table.clear();
    }
    table.insert(request_id.to_string(), scope);
}

/// The scope picked for `request_id`, once; it never outlives its request.
pub(crate) fn take_scope_choice(request_id: &str) -> Option<ApprovalScope> {
    SCOPE_CHOICES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
        .and_then(|t| t.remove(request_id))
}

/// "Answer later" for open request `request_id`: the surface then sends a
/// denial, and the loop reads this mark to defer the call instead of refusing it.
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
pub(crate) fn mark_defer(request_id: &str) {
    let mut marks = DEFER_MARKS.lock().unwrap_or_else(|e| e.into_inner());
    let marks = marks.get_or_insert_with(HashSet::new);
    if marks.len() >= TABLE_CAP {
        marks.clear();
    }
    marks.insert(request_id.to_string());
}

pub(crate) fn take_defer_mark(request_id: &str) -> bool {
    DEFER_MARKS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
        .is_some_and(|s| s.remove(request_id))
}

/// What an earlier deferred answer says about a call that is being put to the
/// user now.
pub(crate) enum Settled {
    /// Nothing on file: ask as usual.
    Ask,
    /// Allowed earlier, and spent by this call.
    Allow,
    /// Denied earlier, and spent by this call.
    Deny,
    /// Not run: still waiting, or expired. Carries what the model is told.
    Refuse(String),
}

/// A line naming what a call does, for the deferred-approvals listing.
pub(crate) fn call_summary(tool: &str, path_args: &[&str], args: &Value) -> String {
    let named = args
        .get("command")
        .and_then(|v| v.as_str())
        .or_else(|| path_args.iter().find_map(|k| args.get(*k).and_then(|v| v.as_str())));
    match named {
        Some(text) => format!("{tool}: {text}"),
        None => tool.to_string(),
    }
}

// -- what the model is told ---------------------------------------------------

/// A phrase every deferral result carries, which the restore note looks for.
pub(crate) const DEFERRED_MARK: &str = "the approval is deferred";

pub(crate) fn deferred_text(tool: &str, id: &str, summary: &str) -> String {
    format!(
        "ERROR: tool {tool} was not run: {DEFERRED_MARK}. Nobody could answer it now, so it \
         was recorded as {id} ({summary}). Do not retry it and do not look for another way \
         to do the same thing. Say in one line what you were about to do and why, then stop: \
         this run ends here. When the user has answered and the session is resumed, propose \
         exactly the same call again."
    )
}

pub(crate) fn stale_text(tool: &str, id: &str) -> String {
    format!(
        "ERROR: tool {tool} was not run: {id} was allowed, but the file it changes was changed \
         by something else after the question was asked, so the answer does not cover it and \
         nothing was written. Read the file again and propose the change against what is there now."
    )
}

pub(crate) fn still_pending_text(tool: &str, id: &str) -> String {
    format!(
        "ERROR: tool {tool} was not run: {DEFERRED_MARK} and {id} has not been answered yet. \
         Do not retry it. Say that you are waiting for the answer, then stop."
    )
}

pub(crate) fn expired_text(tool: &str, id: &str) -> String {
    format!(
        "ERROR: tool {tool} was not run: the answer window for {id} closed before it was used, \
         so nothing was approved. If the call is still wanted, propose it again and it will be \
         put to the user afresh."
    )
}

pub(crate) fn halt_note(ids: &[String]) -> String {
    format!(
        "Stopped: waiting for approval of {}. Answer with `flint cli approvals allow <id>` or \
         `flint cli approvals deny <id>` (or in the desktop app's settings), then resume this \
         session.",
        ids.join(", ")
    )
}

// -- after a restore ----------------------------------------------------------

const LISTED: usize = 6;

fn brief(name: &str, args: &Value) -> String {
    let detail = args
        .get("command")
        .or_else(|| args.get("path"))
        .or_else(|| args.get("file_path"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let detail: String = detail.split_whitespace().collect::<Vec<_>>().join(" ");
    let detail: String = if detail.chars().count() > 60 {
        format!("{}...", detail.chars().take(60).collect::<String>())
    } else {
        detail
    };
    if detail.is_empty() {
        name.to_string()
    } else {
        format!("{name} `{detail}`")
    }
}

fn listed(items: &[String]) -> String {
    let mut text = items.iter().take(LISTED).cloned().collect::<Vec<_>>().join("; ");
    if items.len() > LISTED {
        text.push_str(&format!("; and {} more", items.len() - LISTED));
    }
    text
}

fn is_gated(name: &str) -> bool {
    tauri_plugin_agent_tools::tools::lookup(name).is_some_and(|t| {
        matches!(
            t.capability,
            tauri_plugin_agent_tools::tools::Capability::Write
                | tauri_plugin_agent_tools::tools::Capability::Exec
        )
    })
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// What a run is told when its workspace was restored to a checkpoint: the
/// calls the conversation shows going through, and the ones refused, which
/// were answered against a workspace that is gone. `None` when the
/// conversation holds no call that needed an answer.
pub(crate) fn restore_note(messages: &[Value]) -> Option<String> {
    let mut calls: HashMap<String, (String, Value)> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for message in messages {
        let Some(list) = message.get("tool_calls").and_then(|v| v.as_array()) else {
            continue;
        };
        for call in list {
            let (Some(id), Some(name)) = (
                call.get("id").and_then(|v| v.as_str()),
                call.pointer("/function/name").and_then(|v| v.as_str()),
            ) else {
                continue;
            };
            let args = call
                .pointer("/function/arguments")
                .and_then(|v| v.as_str())
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .or_else(|| call.pointer("/function/arguments").cloned())
                .unwrap_or(Value::Null);
            calls.insert(id.to_string(), (name.to_string(), args));
            order.push(id.to_string());
        }
    }
    let mut went_ahead = Vec::new();
    let mut refused = Vec::new();
    let mut deferred = Vec::new();
    let results: HashMap<&str, String> = messages
        .iter()
        .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("tool"))
        .filter_map(|m| {
            Some((
                m.get("tool_call_id")?.as_str()?,
                text_of(m.get("content").unwrap_or(&Value::Null)),
            ))
        })
        .collect();
    for id in &order {
        let Some((name, args)) = calls.get(id) else { continue };
        if !is_gated(name) {
            continue;
        }
        let Some(result) = results.get(id.as_str()) else { continue };
        let line = brief(name, args);
        if result.contains(DEFERRED_MARK) {
            deferred.push(line);
        } else if result.starts_with("ERROR: tool ") && result.contains("denied by user") {
            refused.push(line);
        } else if !result.starts_with("ERROR") {
            went_ahead.push(line);
        }
    }
    if went_ahead.is_empty() && refused.is_empty() && deferred.is_empty() {
        return None;
    }
    let mut parts = vec![
        "[checkpoint restore] The workspace was just restored to an earlier checkpoint, so the \
         permission answers given before it no longer stand."
            .to_string(),
    ];
    if !went_ahead.is_empty() {
        parts.push(format!("Calls that went ahead and are void: {}.", listed(&went_ahead)));
    }
    if !refused.is_empty() {
        parts.push(format!("Calls that were refused and are void: {}.", listed(&refused)));
    }
    if !deferred.is_empty() {
        parts.push(format!("Calls waiting on a deferred answer, now cancelled: {}.", listed(&deferred)));
    }
    parts.push(
        "If you still want any of them, propose it again and wait for the answer: do not assume \
         it is allowed, and do not assume a refusal still holds. Rules the user saved for a \
         folder or a command prefix are unaffected."
            .to_string(),
    );
    Some(parts.join(" "))
}

/// Tell the session's next run about a checkpoint restore, once: when the
/// session was restored since it last ran, the conversation gets the note
/// from [`restore_note`] as a reminder. Returns whether it was added.
pub(crate) fn apply_restore_note(
    data_folder: &std::path::Path,
    session: &str,
    messages: &mut Vec<Value>,
) -> bool {
    if tauri_plugin_agent_tools::deferred_approvals::take_restore(data_folder, session).is_none() {
        return false;
    }
    match restore_note(messages) {
        Some(note) => {
            crate::core::agent::reminder::attach(messages, &note);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(id: &str, name: &str, args: Value) -> Value {
        json!({ "id": id, "type": "function", "function": { "name": name, "arguments": args.to_string() } })
    }

    fn convo() -> Vec<Value> {
        vec![
            json!({ "role": "user", "content": "go" }),
            json!({ "role": "assistant", "content": null, "tool_calls": [
                call("c1", "write", json!({ "path": "src/a.rs", "content": "x" })),
                call("c2", "bash", json!({ "command": "make deploy" })),
                call("c3", "read", json!({ "path": "README.md" })),
                call("c4", "bash", json!({ "command": "git push" })),
                call("c5", "edit", json!({ "path": "src/b.rs" })),
            ]}),
            json!({ "role": "tool", "tool_call_id": "c1", "content": "wrote 1 line" }),
            json!({ "role": "tool", "tool_call_id": "c2", "content": "ERROR: tool 'bash' denied by user" }),
            json!({ "role": "tool", "tool_call_id": "c3", "content": "# readme" }),
            json!({ "role": "tool", "tool_call_id": "c4", "content": deferred_text("bash", "defer-1", "git push") }),
            json!({ "role": "tool", "tool_call_id": "c5", "content": "ERROR: tool 'edit' is denied by policy" }),
        ]
    }

    #[test]
    fn the_note_names_what_went_ahead_what_was_refused_and_what_was_waiting() {
        let note = restore_note(&convo()).unwrap();
        assert!(note.contains("write `src/a.rs`"), "{note}");
        assert!(note.contains("void: bash `make deploy`"), "{note}");
        assert!(note.contains("deferred answer, now cancelled: bash `git push`"), "{note}");
        assert!(note.contains("propose it again"), "{note}");
        // A read needed no answer; a policy refusal was never an approval.
        assert!(!note.contains("README"), "{note}");
        assert!(!note.contains("src/b.rs"), "{note}");
    }

    #[test]
    fn the_note_reaches_the_next_run_of_a_restored_session_once() {
        let dir = tempfile::tempdir().unwrap();
        let mut messages = convo();
        // Never restored: nothing added.
        assert!(!apply_restore_note(dir.path(), "s1", &mut messages));
        assert_eq!(messages.len(), convo().len());
        tauri_plugin_agent_tools::deferred_approvals::record_restore(dir.path(), "s1").unwrap();
        // Another session is not told.
        assert!(!apply_restore_note(dir.path(), "s2", &mut messages));
        assert!(apply_restore_note(dir.path(), "s1", &mut messages));
        let last = messages.last().unwrap();
        assert_eq!(last["role"], "user");
        assert!(last["content"].as_str().unwrap().contains("checkpoint restore"), "{last}");
        // Told once.
        let after = messages.len();
        assert!(!apply_restore_note(dir.path(), "s1", &mut messages));
        assert_eq!(messages.len(), after);
    }

    #[test]
    fn a_conversation_with_nothing_to_void_gets_no_note() {
        let messages = vec![
            json!({ "role": "user", "content": "hi" }),
            json!({ "role": "assistant", "content": "hello" }),
        ];
        assert_eq!(restore_note(&messages), None);
        let only_reads = vec![
            json!({ "role": "assistant", "tool_calls": [call("a", "read", json!({ "path": "x" }))] }),
            json!({ "role": "tool", "tool_call_id": "a", "content": "text" }),
        ];
        assert_eq!(restore_note(&only_reads), None);
    }

    #[test]
    fn a_long_list_is_cut_and_says_how_many_more() {
        let mut calls = Vec::new();
        let mut results = Vec::new();
        for i in 0..10 {
            calls.push(call(&format!("c{i}"), "write", json!({ "path": format!("f{i}.txt") })));
            results.push(json!({ "role": "tool", "tool_call_id": format!("c{i}"), "content": "ok" }));
        }
        let mut messages = vec![json!({ "role": "assistant", "tool_calls": calls })];
        messages.extend(results);
        let note = restore_note(&messages).unwrap();
        assert!(note.contains("and 4 more"), "{note}");
        assert!(!note.contains("f9.txt"), "{note}");
    }

    #[test]
    fn a_long_command_is_shortened_and_one_line() {
        let long = format!("echo {}\nsecond line", "x".repeat(200));
        let messages = vec![
            json!({ "role": "assistant", "tool_calls": [call("a", "bash", json!({ "command": long }))] }),
            json!({ "role": "tool", "tool_call_id": "a", "content": "done" }),
        ];
        let note = restore_note(&messages).unwrap();
        assert!(note.contains("..."), "{note}");
        assert!(!note.contains('\n'), "{note}");
        assert!(!note.contains(&"x".repeat(100)), "{note}");
    }

    #[test]
    fn the_scope_choice_is_taken_once_and_marks_do_not_cross_requests() {
        record_scope_choice("req-a", ApprovalScope::Run);
        assert_eq!(take_scope_choice("req-b"), None);
        assert_eq!(take_scope_choice("req-a"), Some(ApprovalScope::Run));
        assert_eq!(take_scope_choice("req-a"), None);
        mark_defer("req-c");
        assert!(!take_defer_mark("req-d"));
        assert!(take_defer_mark("req-c"));
        assert!(!take_defer_mark("req-c"));
    }

    #[test]
    fn the_section_defaults_to_off_and_clamps_nothing_itself() {
        let s: ApprovalsSection = toml::from_str("").unwrap();
        assert!(!s.defer);
        assert!(Runtime::from_section(&s).defer_unattended.is_none());
        let s: ApprovalsSection = toml::from_str("defer = true\ndefer_ttl_hours = 2\nsomething_new = 1").unwrap();
        assert_eq!(Runtime::from_section(&s).defer_unattended, Some(7200));
        let s: ApprovalsSection = toml::from_str("defer = true").unwrap();
        assert_eq!(Runtime::from_section(&s).defer_unattended, Some(0), "0 means the default window");
    }

    #[test]
    fn agent_toml_keeps_every_other_section_beside_approvals() {
        let cfg: crate::core::agent::project::AgentToml = toml::from_str(
            "[approvals]\ndefer = true\ndefer_ttl_hours = 3\nsome_future_key = \"x\"\n\n[tools]\nallow = [\"read\"]\n",
        )
        .unwrap();
        assert!(cfg.approvals.defer);
        assert_eq!(cfg.approvals.defer_ttl_hours, Some(3));
        assert_eq!(cfg.tools.allow, vec!["read".to_string()]);
        let none: crate::core::agent::project::AgentToml = toml::from_str("[tools]\nallow = [\"read\"]\n").unwrap();
        assert!(!none.approvals.defer, "a project that never wrote the section defers nothing");
    }

    #[test]
    fn the_runtime_remembers_each_deferral_once() {
        let rt = Runtime::default();
        rt.note_deferred("d1");
        rt.note_deferred("d1");
        rt.note_deferred("d2");
        assert_eq!(rt.deferred_ids(), vec!["d1".to_string(), "d2".to_string()]);
        assert!(halt_note(&rt.deferred_ids()).contains("d1, d2"));
    }
}
