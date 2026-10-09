//! CLI adapter layer — thin wrappers that call core logic without an AppHandle.
//!
//! This module is only compiled when the `cli` feature is enabled.

mod agent_status;
pub mod auth;
pub mod brand;
pub mod color;
pub mod browser;
#[cfg(test)]
mod contract_conformance;
pub mod device_auth;
pub mod doctor;
pub mod file_log;
pub mod inflight;
pub mod journal;
pub mod json_api;
pub mod bench;
pub mod login;
pub mod hf_cmd;
pub mod mcp;
pub mod memory_cmd;
pub mod migrate_cmd;
/// `jan mcp serve`: the other direction, Jan's toolset served over MCP.
pub mod mcp_serve;
mod model_capabilities;
mod path_refs;
/// `jan cli agent schema`: the protocol's JSON Schema, generated from the types.
pub mod protocol_schema;
/// `jan cli agent rpc`: persistent, session-scoped JSON-RPC transport.
pub mod rpc;
/// `jan cli agent rpc-schema`: the RPC request and event schemas.
pub mod rpc_schema;
pub mod providers;
pub mod run_report;
pub mod archive_cmd;
pub mod run_data_cmd;
pub mod schedule;
pub mod skills_cmd;
pub mod system_cmd;
pub mod thread_export;
pub mod schedule_manage;
pub mod secrets;
mod secret_input;
pub mod stream_input;
pub mod terminal_setup;
pub mod tokamak;
mod tui;
/// Renders reported usage from the Tokamak usage API (upstream #9034).
pub mod usage_view;
pub mod version;
/// The user-message wire shape, shared by the TUI and the headless channel.
mod user_message;
pub mod worktree;
pub mod worktree_cmd;

use std::path::PathBuf;
use std::sync::Arc;

use crate::core::app::commands::resolve_jan_data_folder;
use crate::core::threads::{
    constants::THREADS_FILE,
    helpers::{read_messages_from_file, update_thread_metadata, write_messages_to_file},
    utils::{
        ensure_data_dirs, get_data_dir, get_messages_path, get_thread_dir, get_thread_metadata_path,
    },
};

// ── Thread operations ──────────────────────────────────────────────────────

/// List thread metadata under `<base>/threads/`. `base` is the Flint data folder
/// (desktop store) or a project's `.jan/agent` dir (TUI store).
pub fn list_threads_in(base: &std::path::Path) -> Result<Vec<serde_json::Value>, String> {
    use std::fs;

    let data_dir = get_data_dir(base);
    let mut threads = Vec::new();
    if !data_dir.exists() {
        return Ok(threads);
    }
    for entry in fs::read_dir(&data_dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            let metadata_path = path.join(THREADS_FILE);
            if metadata_path.exists() {
                let data = fs::read_to_string(&metadata_path).map_err(|e| e.to_string())?;
                if let Ok(thread) = serde_json::from_str(&data) {
                    threads.push(thread);
                }
            }
        }
    }
    Ok(threads)
}

/// List all threads from the Flint data folder (desktop store).
pub async fn cli_list_threads() -> Result<Vec<serde_json::Value>, String> {
    let data_folder = resolve_jan_data_folder();
    ensure_data_dirs(&data_folder)?;
    list_threads_in(&data_folder)
}

/// Which saved thread a `--resume` / `--continue` / `/resume` request refers to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResumeTarget {
    /// Most recently updated thread for the project.
    Latest,
    /// A full thread id or a unique prefix of one.
    Id(String),
}

impl ResumeTarget {
    /// Build a target from the CLI flag pair: `--resume [ID]` and `--continue`/`-c`
    /// (an alias for a bare `--resume`). `None` means "do not resume".
    pub fn from_flags(resume: Option<Option<String>>, continue_session: bool) -> Option<Self> {
        match resume {
            Some(Some(id)) if !id.trim().is_empty() => Some(Self::Id(id.trim().to_string())),
            Some(_) => Some(Self::Latest),
            None if continue_session => Some(Self::Latest),
            None => None,
        }
    }
}

/// A resume request: which thread, and whether to branch it instead of
/// continuing it. `fork` writes the resolved thread's prefix into a fresh id and
/// opens that, so the source stays on disk exactly as it was.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResumeRequest {
    pub target: ResumeTarget,
    pub fork: bool,
}

impl ResumeRequest {
    /// Continue the resolved thread in place.
    pub fn resume(target: ResumeTarget) -> Self {
        Self {
            target,
            fork: false,
        }
    }

    /// Branch the resolved thread into a new one.
    pub fn fork(target: ResumeTarget) -> Self {
        Self { target, fork: true }
    }

    /// Build a request from the CLI flags. `--fork-session` alone means "branch
    /// the most recent session", so it implies a target of its own.
    pub fn from_flags(
        resume: Option<Option<String>>,
        continue_session: bool,
        fork: bool,
    ) -> Option<Self> {
        let target = ResumeTarget::from_flags(resume, continue_session)
            .or_else(|| fork.then_some(ResumeTarget::Latest))?;
        Some(Self { target, fork })
    }
}
/// Recency sort key for a saved thread (`updated`, falling back to `created`).
pub fn thread_recency(t: &serde_json::Value) -> f64 {
    t.get("updated")
        .or_else(|| t.get("created"))
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0)
}

/// Sort threads most-recent-first (by `updated`/`created`).
pub fn sort_threads_recent(threads: &mut [serde_json::Value]) {
    threads.sort_by(|a, b| {
        thread_recency(b)
            .partial_cmp(&thread_recency(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

/// Message shown when there is nothing to resume; the caller then starts fresh.
pub const NO_SESSION_TO_RESUME: &str = "No session to resume";

/// Resolve a resume target against `<base>/threads/`, returning the thread
/// metadata. Threads whose `thread.json` is unparsable are skipped by
/// `list_threads_in`, so a corrupted neighbour never blocks a resume.
pub fn find_resume_thread(
    base: &std::path::Path,
    target: &ResumeTarget,
) -> Result<serde_json::Value, String> {
    let mut threads = list_threads_in(base)?;
    match target {
        ResumeTarget::Latest => {
            sort_threads_recent(&mut threads);
            threads
                .into_iter()
                .next()
                .ok_or_else(|| NO_SESSION_TO_RESUME.to_string())
        }
        ResumeTarget::Id(id) => {
            let mut matches: Vec<serde_json::Value> = threads
                .into_iter()
                .filter(|t| {
                    t.get("id")
                        .and_then(|v| v.as_str())
                        .is_some_and(|full| full == id || full.starts_with(id.as_str()))
                })
                .collect();
            match matches.len() {
                0 => Err(format!("no thread matches '{id}'")),
                1 => Ok(matches.remove(0)),
                n => Err(format!("'{id}' is ambiguous ({n} matches)")),
            }
        }
    }
}

/// Resolve a resume request to the thread the session should open: the matched
/// thread, or a fresh fork of it that leaves the match untouched.
pub fn resolve_resume(
    base: &std::path::Path,
    request: &ResumeRequest,
) -> Result<serde_json::Value, String> {
    let thread = find_resume_thread(base, &request.target)?;
    if !request.fork {
        return Ok(thread);
    }
    let source = thread
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "saved thread has no id".to_string())?;
    let id = fork_thread(base, source, None)?;
    cli_get_thread_in(base, &id)
}

/// Read a thread's messages, tolerating a truncated or malformed line (a crash
/// mid-append leaves one). Returns the parsed records and the skipped count, so
/// a resume degrades to "lost the tail" instead of failing outright.
pub fn cli_read_messages_lenient(
    base: &std::path::Path,
    thread_id: &str,
) -> Result<(Vec<serde_json::Value>, usize), String> {
    use std::io::BufRead;

    let path = get_messages_path(base, thread_id);
    if !path.exists() {
        return Ok((Vec::new(), 0));
    }
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut messages = Vec::new();
    let mut skipped = 0;
    for line in std::io::BufReader::new(file).lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str(&line) {
            Ok(v) => messages.push(v),
            Err(_) => skipped += 1,
        }
    }
    Ok((messages, skipped))
}

/// Read a thread's messages from `<base>/threads/<id>/messages.jsonl`.
pub fn cli_list_messages_in(
    base: &std::path::Path,
    thread_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    read_messages_from_file(base, thread_id)
}

/// A thread's messages as the conversation shows them: the active version at
/// each fork, not every edited or regenerated one. A linear thread is returned
/// whole. `all_versions` gives the stored list.
pub fn cli_list_messages_active_in(
    base: &std::path::Path,
    thread_id: &str,
    all_versions: bool,
) -> Result<Vec<serde_json::Value>, String> {
    let messages = read_messages_from_file(base, thread_id)?;
    if all_versions {
        return Ok(messages);
    }
    let active_root = cli_get_thread_in(base, thread_id).ok().and_then(|t| {
        t.pointer("/metadata/activeRootId")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    });
    Ok(crate::core::threads::branching::active_path(
        &messages,
        active_root.as_deref(),
    ))
}

/// List messages for a thread (the active path unless `all_versions`).
pub fn cli_list_messages(
    thread_id: &str,
    all_versions: bool,
) -> Result<Vec<serde_json::Value>, String> {
    cli_list_messages_active_in(&resolve_jan_data_folder(), thread_id, all_versions)
}

/// Delete a thread directory.
pub fn cli_delete_thread(thread_id: &str) -> Result<(), String> {
    delete_thread_at(&resolve_jan_data_folder(), thread_id)
}

/// Metadata key naming the repository that holds a thread's snapshot ref.
/// Written by the TUI with its snapshots; read back on delete, which otherwise
/// has no repository in hand to drop the ref from (Jozkah/jan#143).
pub(crate) const SNAPSHOT_REPO_KEY: &str = "snapshot_repo";

fn delete_thread_at(data_folder: &std::path::Path, thread_id: &str) -> Result<(), String> {
    use std::fs;

    // Read where the snapshots live before the thread's files go away.
    let snapshot_repo = fs::read_to_string(get_thread_metadata_path(data_folder, thread_id))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|t| {
            t.pointer(&format!("/metadata/{SNAPSHOT_REPO_KEY}"))
                .and_then(|v| v.as_str())
                .map(std::path::PathBuf::from)
        });
    let thread_dir = get_thread_dir(data_folder, thread_id);
    if thread_dir.exists() {
        fs::remove_dir_all(thread_dir).map_err(|e| e.to_string())?;
    }
    crate::core::agent::git::cleanup_snapshot_index(thread_id);
    // The ref is what keeps the snapshot commit chain alive; the index above
    // is only scratch. Same pair the desktop's checkpoint::forget drops.
    if let Some(repo) = snapshot_repo.filter(|r| r.is_dir()) {
        let _ = crate::core::agent::git::drop_ref(&repo, thread_id);
    }
    // What the thread's runs recorded goes with it, as on the desktop
    // (Jozkah/jan#294): snapshots, usage, diffs, decisions, undo journal.
    if let Err(e) = tauri_plugin_agent_tools::retention::delete_session(&data_folder, thread_id) {
        eprintln!("could not remove the records of thread {thread_id}: {e}");
    }
    // Its agent scratch dir goes too (Jozkah/jan#186).
    if let Some(scratch) = crate::core::threads::utils::thread_scratch_dir(thread_id) {
        let _ = fs::remove_dir_all(scratch);
    }
    Ok(())
}

/// Get thread metadata by ID from a given store (`<base>/threads/<id>`).
pub fn cli_get_thread_in(
    base: &std::path::Path,
    thread_id: &str,
) -> Result<serde_json::Value, String> {
    let path = get_thread_metadata_path(base, thread_id);
    if !path.exists() {
        return Err(format!("Thread '{thread_id}' not found"));
    }
    let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

/// Get thread metadata by ID from the desktop store.
pub fn cli_get_thread(thread_id: &str) -> Result<serde_json::Value, String> {
    cli_get_thread_in(&resolve_jan_data_folder(), thread_id)
}

/// Persist a TUI conversation as a desktop-compatible thread so it appears in
/// `/resume` and the desktop app. `history` is OpenAI-shaped (`{role, content}`);
/// it is written as `thread.message` records plus `thread.json` metadata. Pass
/// an existing `thread_id` to update that thread, or `None` to create one
/// (returns the id). Title/created are preserved when updating.
pub fn cli_save_thread(
    base: &std::path::Path,
    thread_id: Option<&str>,
    model: &str,
    history: &[serde_json::Value],
    metadata: Option<serde_json::Value>,
) -> Result<String, String> {
    if history.is_empty() {
        return Err("empty conversation".to_string());
    }
    ensure_data_dirs(base)?;
    let id = thread_id
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(get_thread_dir(base, &id)).map_err(|e| e.to_string())?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let now_ms = now.as_millis() as i64;
    let now_secs = now.as_secs_f64();

    let messages: Vec<serde_json::Value> = history
        .iter()
        .filter_map(|m| {
            let role = m.get("role").and_then(|v| v.as_str())?;
            let content = openai_content_text(m.get("content"));
            let mut record = serde_json::json!({
                "id": uuid::Uuid::new_v4().to_string(),
                "object": "thread.message",
                "thread_id": id,
                "role": role,
                "type": "text",
                "status": "ready",
                "created_at": now_ms,
                "completed_at": now_ms,
                "content": [{ "type": "text", "text": { "value": content, "annotations": [] } }],
            });
            // Carry the wire fields the text form cannot express, so a resumed
            // conversation still shows the model the tools it ran. Extra keys on
            // a `thread.message`; the desktop reads `role` and `content`.
            for key in ["tool_calls", "tool_call_id"] {
                if let Some(v) = m.get(key) {
                    record[key] = v.clone();
                }
            }
            Some(record)
        })
        .collect();
    write_messages_to_file(&messages, &get_messages_path(base, &id))?;

    let existing: Option<serde_json::Value> =
        std::fs::read_to_string(get_thread_metadata_path(base, &id))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok());
    let created = existing
        .as_ref()
        .and_then(|e| e.get("created").and_then(serde_json::Value::as_f64))
        .unwrap_or(now_secs);
    let title = existing
        .as_ref()
        .and_then(|e| e.get("title").and_then(|v| v.as_str()))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| default_thread_title(history));

    // Preserve prior metadata when the caller passes none (e.g. a plain save with
    // no worktree state), so an update never drops isolation bookkeeping.
    let metadata = metadata
        .or_else(|| existing.as_ref().and_then(|e| e.get("metadata").cloned()))
        .unwrap_or_else(|| serde_json::json!({}));

    let thread = serde_json::json!({
        "id": id,
        "object": "thread",
        "title": title,
        "created": created,
        "updated": now_secs,
        "model": { "id": model, "provider": "" },
        "metadata": metadata,
    });
    update_thread_metadata(base, &id, &thread)?;
    Ok(id)
}

/// Persist a TUI `/model` choice to the project's `agent.toml` `[agent].model`,
/// so it is remembered on the next session (agent.toml wins over the desktop
/// default in the model-resolution order). `agent_dir` is `<project>/.jan/agent`.
pub fn cli_set_project_model(agent_dir: &std::path::Path, model: &str) -> Result<(), String> {
    set_model_in_agent_toml(&agent_dir.join("agent.toml"), model)
}

/// Stands in for a tool result that never reached disk, so the call it answers
/// stays valid. Says what happened rather than inventing an outcome.
pub(crate) const MISSING_TOOL_RESULT: &str =
    "(result not saved: the session ended before this call's output was recorded)";

/// Rebuild the wire conversation from persisted `thread.message` records: the
/// user/assistant text plus the tool calls and results that text cannot express,
/// so a resumed model sees the work it did instead of only its own answers.
///
/// Tool pairing is enforced, because an OpenAI-compatible upstream rejects a
/// conversation where it is broken: a result whose call is gone is dropped, and a
/// call whose result is missing (a crash between the two) gets the placeholder
/// above. Roles the agent owns (`system`) and messages carrying neither text nor
/// calls are left out.
pub(crate) fn rebuild_wire_history(messages: &[serde_json::Value]) -> Vec<serde_json::Value> {
    fn answer_open(out: &mut Vec<serde_json::Value>, open: &mut Vec<String>) {
        for id in open.drain(..) {
            out.push(serde_json::json!({
                "role": "tool",
                "tool_call_id": id,
                "content": MISSING_TOOL_RESULT,
            }));
        }
    }

    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut open: Vec<String> = Vec::new();
    for m in messages {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or_default();
        let text = thread_message_text(m);
        if role == "tool" {
            let id = m
                .get("tool_call_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if let Some(pos) = open.iter().position(|open_id| open_id == id) {
                open.remove(pos);
                out.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": id,
                    "content": text,
                }));
            }
            continue;
        }
        if !matches!(role, "user" | "assistant") {
            continue;
        }
        // A new turn: whatever the previous assistant left unanswered is closed
        // out first, so calls and results stay adjacent and paired.
        answer_open(&mut out, &mut open);
        let calls = m
            .get("tool_calls")
            .filter(|v| v.as_array().is_some_and(|a| !a.is_empty()));
        if text.is_empty() && calls.is_none() {
            continue;
        }
        let mut msg = serde_json::json!({ "role": role, "content": text });
        if let Some(calls) = calls {
            msg["tool_calls"] = calls.clone();
            open = calls
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|c| c.get("id").and_then(|v| v.as_str()))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
        }
        out.push(msg);
    }
    answer_open(&mut out, &mut open);
    out
}

// ── Thread forking ─────────────────────────────────────────────────────────

/// Key in a thread's `metadata` naming the thread it was branched from. A
/// free-form metadata entry rather than a field on the thread record, so the
/// desktop reader and the mobile store need no migration and an existing store
/// (where every thread is a root) renders as today's flat list.
pub const FORKED_FROM_KEY: &str = "forked_from";

/// True for a `user` message the user actually authored. Hidden reminders ride
/// in on the `user` role but are not turns: a rewind target, a fork point, a
/// recall entry or a checkpoint key built from one would be a row the user never
/// typed, and would shift every later index out of step with the display
/// journal, which holds no reminder at all.
pub(crate) fn is_user_turn(m: &serde_json::Value) -> bool {
    m.get("role").and_then(|v| v.as_str()) == Some("user")
        && !crate::core::agent::reminder::is_reminder_only(
            m.get("content").unwrap_or(&serde_json::Value::Null),
        )
}

/// Index of the `target`-th (0-based) user turn in a wire conversation, i.e.
/// where a rewind or fork to that turn cuts. `None` when there are fewer turns.
pub(crate) fn user_turn_index(history: &[serde_json::Value], target: usize) -> Option<usize> {
    history
        .iter()
        .enumerate()
        .filter(|(_, m)| is_user_turn(m))
        .nth(target)
        .map(|(i, _)| i)
}

/// How many user turns a wire conversation holds.
pub(crate) fn user_turn_count(history: &[serde_json::Value]) -> usize {
    history.iter().filter(|m| is_user_turn(m)).count()
}

/// The thread a fork came from, when this one is a fork.
pub fn forked_parent(thread: &serde_json::Value) -> Option<&str> {
    thread
        .get("metadata")?
        .get(FORKED_FROM_KEY)?
        .get("thread_id")?
        .as_str()
}

/// Metadata for a fork: the source's, minus the bookkeeping that describes turns
/// the branch does not have, plus the parent pointer. Forking a fork overwrites
/// the pointer, so it always names the immediate parent.
fn fork_metadata(
    source_metadata: Option<&serde_json::Value>,
    source_id: &str,
    user_turn: usize,
) -> serde_json::Value {
    let mut meta = source_metadata
        .and_then(|m| m.as_object().cloned())
        .unwrap_or_default();
    if let Some(checkpoints) = meta.get_mut("checkpoints").and_then(|v| v.as_array_mut()) {
        checkpoints.retain(|c| {
            c.get("user_index")
                .and_then(serde_json::Value::as_u64)
                .is_some_and(|i| (i as usize) < user_turn)
        });
    }
    // Two conversations must not edit one checkout: the branch records no
    // worktree, so opening it with worktrees on gets it one of its own, based on
    // where the source left off (see `resolve_workspace`).
    meta.remove(worktree::WORKTREE_KEY);
    meta.insert(
        FORKED_FROM_KEY.to_string(),
        serde_json::json!({ "thread_id": source_id, "user_turn": user_turn }),
    );
    serde_json::Value::Object(meta)
}

/// Branch a saved thread into a new one holding its prefix up to `at_user_turn`
/// (that turn and everything after it are left behind, the same cut a rewind
/// makes), or the whole conversation when `None`. Both the wire history and the
/// display journal are carried, so the fork replays with its tool rows.
///
/// The source is only read, never written: that is the whole point of a fork
/// over a rewind.
///
/// A fork never inherits the source's worktree (see `fork_metadata`): the two
/// conversations diverge from here, and one checkout cannot hold both.
pub fn fork_thread(
    base: &std::path::Path,
    source_id: &str,
    at_user_turn: Option<usize>,
) -> Result<String, String> {
    let source = std::fs::read_to_string(get_thread_metadata_path(base, source_id))
        .map_err(|e| format!("thread '{source_id}' not found: {e}"))?;
    let source: serde_json::Value = serde_json::from_str(&source).map_err(|e| e.to_string())?;

    let (messages, _) = cli_read_messages_lenient(base, source_id)?;
    // Cut the rebuilt conversation, not the raw records: `rebuild_wire_history`
    // is what enforces tool_call/tool_result pairing, and cutting immediately
    // before a user turn leaves that pairing intact because it closes every open
    // call at each turn boundary.
    let mut history = rebuild_wire_history(&messages);
    let mut journal = journal::read_journal(&journal::journal_path(base, source_id));
    if let Some(turn) = at_user_turn {
        let cut = user_turn_index(&history, turn)
            .ok_or_else(|| format!("no message #{} to fork at", turn + 1))?;
        history.truncate(cut);
        // The journal is keyed by its own user entries, not by history indices:
        // it holds rows (tool calls, reasoning) history never had.
        journal.truncate(journal::truncate_at_user(&journal, turn));
    }
    if history.is_empty() {
        return Err("nothing before that message to fork".to_string());
    }

    let model = source
        .get("model")
        .and_then(|m| m.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    // Cutting at user turn N keeps exactly N turns, so the recorded turn is the
    // same number whether the cut was asked for or the whole thread was taken.
    let metadata = fork_metadata(source.get("metadata"), source_id, user_turn_count(&history));
    let id = cli_save_thread(base, None, model, &history, Some(metadata))?;
    journal::write_journal(&journal::journal_path(base, &id), &journal)?;
    Ok(id)
}

/// One row of the fork forest: a thread plus how deep it sits under its root.
pub struct ThreadNode {
    pub thread: serde_json::Value,
    pub depth: usize,
    /// Last among its siblings, so a renderer can pick the corner glyph.
    pub last: bool,
}

fn push_children(stack: &mut Vec<(usize, usize, bool)>, kids: &[usize], depth: usize) {
    // Reversed, so popping yields the children in order.
    for (n, &child) in kids.iter().enumerate().rev() {
        stack.push((child, depth, n + 1 == kids.len()));
    }
}

/// Arrange saved threads into the forest their `forked_from` pointers describe,
/// depth-first, siblings most-recent-first. A thread whose parent is gone is a
/// root, so deleting a session never hides the forks taken from it.
pub fn thread_forest(mut threads: Vec<serde_json::Value>) -> Vec<ThreadNode> {
    use std::collections::HashMap;

    sort_threads_recent(&mut threads);
    let index_of: HashMap<&str, usize> = threads
        .iter()
        .enumerate()
        .filter_map(|(i, t)| Some((t.get("id")?.as_str()?, i)))
        .collect();
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); threads.len()];
    let mut roots: Vec<usize> = Vec::new();
    for (i, t) in threads.iter().enumerate() {
        match forked_parent(t)
            .and_then(|p| index_of.get(p))
            .copied()
            .filter(|&p| p != i)
        {
            Some(parent) => children[parent].push(i),
            None => roots.push(i),
        }
    }

    let mut out = Vec::new();
    let mut seen = vec![false; threads.len()];
    let mut stack: Vec<(usize, usize, bool)> = Vec::new();
    push_children(&mut stack, &roots, 0);
    while let Some((i, depth, last)) = stack.pop() {
        if std::mem::replace(&mut seen[i], true) {
            continue;
        }
        push_children(&mut stack, &children[i], depth + 1);
        out.push(ThreadNode {
            thread: threads[i].clone(),
            depth,
            last,
        });
    }
    // A cycle of forks is reachable from no root and would otherwise vanish from
    // the list; show those threads flat rather than lose a session.
    for (i, t) in threads.iter().enumerate() {
        if !seen[i] {
            out.push(ThreadNode {
                thread: t.clone(),
                depth: 0,
                last: true,
            });
        }
    }
    out
}
/// Text of a persisted `thread.message` (content parts carry `text.value`) or of
/// an OpenAI-shaped message (`content` is a plain string or `text` parts), so
/// the same reader works on both sides of a save/resume round trip.
pub(crate) fn thread_message_text(msg: &serde_json::Value) -> String {
    match msg.get("content") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| {
                p.get("text")
                    .and_then(|t| t.get("value"))
                    .and_then(|v| v.as_str())
                    .or_else(|| p.get("text").and_then(|t| t.as_str()))
                    .or_else(|| p.as_str())
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// Text of an OpenAI-shaped message `content`: the string as-is, or the joined
/// `text` parts of a multimodal content array (image parts contribute nothing).
fn openai_content_text(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter(|p| p.get("type").and_then(|v| v.as_str()) == Some("text"))
            .filter_map(|p| p.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// If `text` is a machine-generated skill or plugin-command invocation message
/// (the `[IMPORTANT: You have invoked the "<name>" <kind> - follow its
/// instructions...]` wrapper produced by `skills::build_invocation_message` and
/// `commands::build_message`), return the compact transcript label
/// (`[skill:<name>]` or `[command:<name>]`). `None` for any other text, so a
/// user who types that prefix verbatim still renders normally.
pub fn invocation_label(text: &str) -> Option<String> {
    const PREFIX: &str = "[IMPORTANT: You have invoked the \"";
    let rest = text.strip_prefix(PREFIX)?;
    let (name, rest) = rest.split_once('"')?;
    if name.is_empty() {
        return None;
    }
    let kind = if rest.starts_with(" skill - follow its instructions") {
        "skill"
    } else if rest.starts_with(" command - follow its instructions") {
        "command"
    } else {
        return None;
    };
    Some(format!("[{kind}:{name}]"))
}

/// Fallback thread title: the first user message, whitespace-collapsed and
/// truncated. Used only when no summarized title exists yet.
fn default_thread_title(history: &[serde_json::Value]) -> String {
    let first_user = history
        .iter()
        .find(|m| m.get("role").and_then(|v| v.as_str()) == Some("user"))
        .map(|m| openai_content_text(m.get("content")))
        .unwrap_or_default();
    if let Some(label) = invocation_label(&first_user) {
        return label;
    }
    let collapsed = first_user.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return "Agent chat".to_string();
    }
    if collapsed.chars().count() > 50 {
        format!("{}…", collapsed.chars().take(49).collect::<String>())
    } else {
        collapsed
    }
}

// ── Agent operations ───────────────────────────────────────────────────────

use crate::core::agent::events::StreamEvent;
use crate::core::agent::project::{
    ensure_project, load_agent_config, load_agent_config_with_profile, permissions_from,
    set_model_in_agent_toml,
};
use crate::core::agent::r#loop::{
    run_orchestration_steered, run_orchestration_streamed, OrchestrationArgs, PermissionRegistry,
    SteeringRequest,
};
use crate::core::cli::providers::{load_provider_configs, ProviderOverrides};
use crate::core::cli::run_report::{
    ndjson_line, Init, InputContentParts, OutputFormat, PermissionDecisionRecord, RunReport,
};
use crate::core::cli::stream_input::{
    parse_input_line, InputErrorRecord, InputFormat, InputMessage, StreamInput, INPUT_KINDS,
    MAX_ECHO_BYTES, MAX_LINE_BYTES,
};
use crate::core::mcp::models::McpSettings;
use std::collections::HashMap;
use std::io::Write as _;
use tauri_plugin_agent_tools::tools::gate::PermissionDecision;
use tauri_plugin_agent_tools::workspace;
use tokio::sync::{mpsc, Mutex};

/// Token-spend ceiling for one agent run when `agent.toml [budget].max_tokens`
/// is unset. `0` disables the ceiling entirely. Counted marginally by
/// `SessionBudget`, so it tracks real new spend, not the context replayed on
/// every turn.
///
/// Spending it stops the run (see `body_session_budget`); `--max-turns` adds a
/// turn cap on top.
const DEFAULT_MAX_SESSION_TOKENS: u64 = 128_000;

/// Where the session token ceiling in effect came from, so `agent status` can
/// say which source won.
///
/// `agent status` takes no budget flag and so always passes `None`, making
/// `"flag"` unreachable from the binary today. It is kept because the argument
/// mirrors `resolve_session_budget` below: a status surface that does accept
/// the flag (or any caller reporting an in-flight run's ceiling) would
/// otherwise report `agent.toml` for a value the flag had overridden.
fn session_budget_source(flag: Option<u64>, configured: Option<u64>) -> &'static str {
    match (flag, configured) {
        (Some(_), _) => "flag",
        (None, Some(_)) => "agent.toml",
        (None, None) => "default",
    }
}

/// Session token ceiling for one run. Precedence is the per-invocation
/// `--max-session-tokens` flag, then `agent.toml [budget].max_tokens`, then
/// `DEFAULT_MAX_SESSION_TOKENS` - the same flag/config/default shape the
/// sandbox setting resolves with. `0` from either source means unbounded and is
/// carried through as-is (see `body_session_budget`).
/// The money ceiling for a run (upstream #9034): `--max-budget-usd`, then
/// `[budget].max_usd`, then none.
///
/// A ceiling is only meaningful if the run can be priced, and in this fork the
/// price is what a person declared in `<data folder>/prices.toml`. So a model
/// with no declared price is **refused** rather than run uncapped, and a
/// negative limit is refused as a typo. `0` is allowed and honest: it stops at
/// the first billed request. Refused at startup, before any paid request.
fn resolve_cost_ceiling(
    flag: Option<f64>,
    configured: Option<f64>,
    prices: &std::collections::BTreeMap<String, crate::core::agent::spend::Price>,
    model: &str,
) -> Result<Option<crate::core::agent::session::CostCeiling>, String> {
    let Some(max_usd) = flag.or(configured) else {
        return Ok(None);
    };
    if !max_usd.is_finite() || max_usd < 0.0 {
        return Err(format!(
            "a cost ceiling must be a non-negative amount in USD, not {max_usd}"
        ));
    }
    let price = crate::core::agent::spend::price_for(prices, model).ok_or_else(|| {
        format!(
            "cannot cap spend for {model}: no price is declared for it in prices.toml, so \
             there is nothing to meter a ${max_usd} ceiling against. Remove the limit to run \
             uncapped, or declare the model's price (dollars per million tokens)."
        )
    })?;
    // prices.toml is dollars per million tokens.
    let per_token = |per_million: f64| per_million / 1_000_000.0;
    Ok(Some(crate::core::agent::session::CostCeiling {
        rates: crate::core::agent::session::TokenRates {
            prompt_usd: per_token(price.input),
            completion_usd: per_token(price.output),
            cache_read_usd: price.cached_input.map(per_token),
            cache_write_usd: None,
        },
        max_usd,
    }))
}

fn resolve_session_budget(flag: Option<u64>, configured: Option<u64>) -> u64 {
    flag.or(configured).unwrap_or(DEFAULT_MAX_SESSION_TOKENS)
}

/// Resolve the `--project` flag (default `"."`) to an absolute path. The raw
/// value is what the model would otherwise see verbatim in the system prompt's
/// working-directory block, so a bare "." must become the real cwd rather than
/// being sent to the model as-is. Falls back to the raw (possibly relative)
/// path if canonicalization fails (e.g. the directory doesn't exist yet).
fn resolve_project_root(project: &str) -> PathBuf {
    PathBuf::from(project)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(project))
}

/// Resolved-config + provider snapshot for `flint cli agent status`.
pub fn cli_agent_status(
    project: &str,
    overrides: &ProviderOverrides,
) -> Result<serde_json::Value, String> {
    let project_root = resolve_project_root(project);
    ensure_project(&project_root)?;
    let cfg = load_agent_config(&project_root)?;
    let provider_configs = load_provider_configs(Some(&project_root), overrides)?;

    // Only providers this build can reach: local-engine entries inherited from
    // the desktop store have no upstream here (see `is_cli_reachable`).
    let mut providers: Vec<serde_json::Value> = provider_configs
        .values()
        .filter(|c| crate::core::cli::providers::is_cli_reachable(c))
        .map(|c| {
            serde_json::json!({
                "provider": c.provider,
                "base_url": c.base_url,
                "has_api_key": crate::core::cli::providers::has_credential(c),
                "models": c.models.len(),
            })
        })
        .collect();
    providers.sort_by(|a, b| a["provider"].as_str().cmp(&b["provider"].as_str()));

    Ok(serde_json::json!({
        "project": project_root.to_string_lossy(),
        "data_folder": resolve_jan_data_folder().to_string_lossy(),
        "model": cfg.agent.model,
        // The effective ceiling with the config files resolved. A
        // `--max-session-tokens` flag is per-invocation and so, like
        // `--sandbox` below, cannot be reflected in a config dump.
        "max_session_tokens": resolve_session_budget(None, cfg.budget.max_tokens),
        "max_session_tokens_source": session_budget_source(None, cfg.budget.max_tokens),
        // The configured money ceiling, or null when the project sets none.
        // Whether it can be enforced depends on the model a run resolves.
        "max_budget_usd": cfg.budget.max_usd,
        "tools": {
            "default": cfg.tools.default,
            "allow": cfg.tools.allow,
            "deny": cfg.tools.deny,
            "allow_write": cfg.tools.allow_write,
            "allow_network": cfg.tools.allow_network,
            "allow_home_read": cfg.tools.allow_home_read,
            "sandbox": cfg.tools.sandbox,
        },
        // What `bash` will actually do, with the config files already resolved
        // (the `--sandbox` flag is per-invocation and so cannot be reported
        // here). `backend` names the confinement that would be used and is
        // `none` where none can be established -- with `enabled` true that
        // combination is what withholds `bash` entirely.
        "sandbox": {
            "enabled": crate::core::agent::r#loop::effective_sandbox(&project_root),
            "backend": tauri_plugin_agent_tools::tools::jail::backend().as_str(),
        },
        "providers": providers,
    }))
}

/// Set (create or merge) a provider entry in the global `~/.jan/config.toml`,
/// the standalone-agent credential store. Returns the config path so the caller
/// can report where the value landed. Headless: no Desktop app required.
pub fn cli_agent_config_set(
    provider: &str,
    api_key: Option<String>,
    base_url: Option<String>,
    models: Option<Vec<String>>,
    api_type: Option<String>,
) -> Result<PathBuf, String> {
    crate::core::agent::global_config::set_provider(
        provider,
        crate::core::agent::global_config::ProviderUpdate {
            api_key,
            clear_api_key: false,
            base_url,
            models,
            api_type,
            ..Default::default()
        },
    )
}

/// Remove a provider entry from `~/.jan/config.toml`. `Ok(false)` means it was
/// already absent.
pub fn cli_agent_config_unset(provider: &str) -> Result<bool, String> {
    crate::core::agent::global_config::remove_provider(provider)
}

/// The global config file path, scaffolding a commented template if it doesn't
/// exist yet so `jan config path` always points at a real file.
pub fn cli_agent_config_path() -> Result<PathBuf, String> {
    crate::core::agent::global_config::ensure_global_config()
}

/// Providers configured in `~/.jan/config.toml`, as JSON with API keys redacted.
/// Reflects only the global store (what the user set), not Desktop inherit.
pub fn cli_agent_config_list() -> Result<serde_json::Value, String> {
    let configs = crate::core::agent::global_config::load_global_config()?;
    let mut providers: Vec<serde_json::Value> = configs
        .values()
        .map(|c| {
            serde_json::json!({
                "provider": c.provider,
                "base_url": c.base_url,
                "has_api_key": c.api_key.is_some(),
                "api_type": c.api_type,
                "models": c.models,
            })
        })
        .collect();
    providers.sort_by(|a, b| a["provider"].as_str().cmp(&b["provider"].as_str()));
    Ok(serde_json::json!({
        "config_path": crate::core::agent::global_config::global_config_path()?.to_string_lossy(),
        "providers": providers,
    }))
}

/// List plugins installed for a project.
pub fn cli_plugin_list(project: &str) -> Vec<crate::core::agent::plugins::InstalledPlugin> {
    crate::core::agent::plugins::installed(&resolve_project_root(project))
}

/// Install git or marketplace plugin(s) for a project.
///
/// This is the interactive CLI path: a multi-plugin collection prompts the user
/// to choose which plugins to install (it has an owning terminal, unlike the
/// TUI render loop which reads stdin itself and so uses the non-interactive
/// listing-error behavior). Returns every plugin actually installed.
pub async fn cli_plugin_install(
    project: &str,
    spec: &str,
) -> Result<Vec<crate::core::agent::plugins::InstalledPlugin>, String> {
    crate::core::agent::plugins::install_interactive(&resolve_project_root(project), spec).await
}

/// Remove a plugin from a project.
pub fn cli_plugin_remove(project: &str, name: &str) -> Result<(), String> {
    crate::core::agent::plugins::remove(&resolve_project_root(project), name)
}

/// Search the configured plugin marketplace for a project.
pub async fn cli_plugin_search(
    project: &str,
    query: &str,
) -> Result<Vec<crate::core::agent::plugins::MarketEntry>, String> {
    crate::core::agent::plugins::search(&resolve_project_root(project), query).await
}

/// Autonomous run: as many turns as the task needs, bounded by a `max_turns`
/// cap when one is set, and by the session token budget.
///
/// The failure is classified (AH-009), so the caller can choose an exit status
/// and a message from what went wrong rather than from how it was worded.
#[allow(clippy::too_many_arguments)]
pub async fn cli_agent_run(
    project: &str,
    task: &str,
    model: Option<String>,
    overrides: ProviderOverrides,
    flags: SessionFlags,
    resume: Option<ResumeRequest>,
    format: OutputFormat,
    input_format: InputFormat,
    host_tools: Option<&str>,
    host_gate: bool,
) -> Result<(), tauri_plugin_agent_tools::harness_error::HarnessError> {
    run_agent_loop(
        project, task, model, false, overrides, flags, resume, format, input_format,
        host_tools,
        host_gate,
    )
    .await
}

/// Single-turn run for debugging: the turn cap is pinned to 1 here and
/// outranks any `--max-turns`.
pub async fn cli_agent_step(
    project: &str,
    task: &str,
    model: Option<String>,
    overrides: ProviderOverrides,
    flags: SessionFlags,
) -> Result<(), tauri_plugin_agent_tools::harness_error::HarnessError> {
    run_agent_loop(
        project,
        task,
        model,
        true,
        overrides,
        flags,
        None,
        OutputFormat::Text,
        InputFormat::Text,
        // `step` is a debugging path with no client on stdin, so there is
        // nothing that could execute a host tool.
        None,
        false,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
fn build_cli_orchestration_args(
    project_root: PathBuf,
    permissions: tauri_plugin_agent_tools::permissions::ToolPermissions,
    provider_configs: HashMap<String, crate::core::state::ProviderConfig>,
    mcp_servers: crate::core::state::SharedMcpServers,
    mcp_settings: McpSettings,
    permission_requests: PermissionRegistry,
    host_tools: crate::core::agent::host_tools::HostToolSet,
    host_tool_requests: crate::core::agent::host_tools::HostToolRegistry,
    auto_approve: bool,
    plan: bool,
    max_parallel_subagents: u32,
    sandbox: Option<bool>,
    // `[agent].fallback`: providers to try when the model cannot be reached
    // (AH-193). Empty unless the project configured a chain.
    fallback_models: Vec<String>,
    // The named profile this run was started under (AH-186).
    profile: Option<String>,
) -> OrchestrationArgs {
    OrchestrationArgs {
        profile,
        fallback_models,
        // A CLI run is nobody's child.
        parent_run: None,
        dispatch_id: None,
        client: crate::core::agent::upstream::agent_http_client(),
        provider_configs: Arc::new(Mutex::new(provider_configs)),
        mcp_servers,
        mcp_settings: Arc::new(Mutex::new(mcp_settings)),
        jan_data_folder: resolve_jan_data_folder().to_string_lossy().into_owned(),
        permissions,
        project_root: Some(project_root),
        permission_requests,
        host_tools,
        host_tool_requests,
        host_owns_gate: false,
        host_tool_route: None,
        ask_requests: None,
        todo_registry: None,
        system_prompt_override: None,
        subagents_enabled: true,
        max_parallel_subagents,
        auto_approve,
        run_mode: if plan {
            crate::core::agent::plan::RunMode::Plan
        } else {
            crate::core::agent::plan::RunMode::Normal
        },
        // Key the persistent bash `/tmp` scratch to this session. Generated per
        // run/session: a one-shot CLI wipes it after its single run; the TUI
        // reuses `args` across turns and wipes it when the interactive session
        // ends.
        session_id: Some(uuid::Uuid::new_v4().to_string()),
        // The top-level run is not a child: no dispatch gave it an id.
        run_id: None,
        // `--sandbox` only when passed; unset falls through to the project's
        // `[tools].sandbox` and then the user's global `sandbox`.
        subject: tauri_plugin_agent_tools::subject::Subject::MainAgent,
        sandbox,
    }
}

/// Everything needed to drive one agent run: the engine handle, request body,
/// and the shared permission registry. Built once and consumed by either the
/// plain CLI printer or the TUI renderer.
pub(crate) struct PreparedRun {
    pub args: OrchestrationArgs,
    pub body: serde_json::Value,
    /// The window this run was resolved to, so the headless printer can say
    /// how full it is getting (AH-077).
    pub limits: SessionLimits,
    pub permission_requests: PermissionRegistry,
    /// Background connect of `active` MCP servers, awaited before the first turn.
    pub mcp_task: Option<tokio::task::JoinHandle<mcp::ConnectOutcome>>,
    /// Where to write the conversation once the run finishes.
    persist: PersistTarget,
}

/// Bookkeeping for writing a non-interactive run to the project's thread store,
/// so `--resume` can pick it up later. `thread_id` is `None` for a new session.
struct PersistTarget {
    agent_dir: PathBuf,
    thread_id: Option<String>,
    model: String,
    history: Vec<serde_json::Value>,
    /// The checkout this run worked in, recorded on the thread so a later
    /// `--resume` reattaches to it.
    #[cfg_attr(feature = "cli", allow(dead_code))]
    workspace: Option<worktree::Worktree>,
}

/// Per-run limits resolved from agent.toml. Grouped rather than passed as a
/// run of bare numbers, which would be trivial to transpose at a call site.
#[derive(Debug, Clone)]
pub(crate) struct SessionLimits {
    /// Context window limit in tokens for the model. Resolution order is the
    /// configured `[agent].context_window` override, then the built-in model
    /// catalog, then a 128K fallback. Used to display `ctx N/K` in the header
    /// and trigger compaction.
    pub context_window: u64,
    /// Where `context_window` came from: configured override, catalog, or fallback.
    pub context_window_source: crate::core::cli::model_capabilities::ContextWindowSource,
    /// Tokens reserved for the model's response. Defaults to 16K if unset.
    /// Compaction triggers at `context_window - reserve_tokens`.
    pub reserve_tokens: u64,
    /// The shared compaction policy (AH-076); `reserve_tokens` is its
    /// `reserve_tokens`.
    pub compaction: tauri_plugin_agent_tools::compaction_policy::Policy,
    /// Per-request output cap forwarded to the model as OpenAI `max_tokens`.
    /// `None` omits the field (model default).
    pub max_tokens: Option<u64>,
    /// `--max-session-tokens`, else `[budget].max_tokens`, else the default:
    /// marginal token-spend ceiling for one run. `0` is no ceiling.
    ///
    /// Spending it stops the run; `max_turns` is a separate turn cap.
    pub max_session_tokens: u64,
    /// `--max-turns`: hard cap on agentic turns for this run. `None` omits the field from the request
    /// body, which the engine reads as unbounded; `0` means unbounded too (see
    /// `body_turn_cap`).
    pub max_turns: Option<u64>,
    /// `--max-budget-usd`, else `[budget].max_usd`: the run's money ceiling and
    /// the rates to meter it against, resolved once at startup by
    /// `resolve_cost_ceiling`. `None` leaves the run unmetered.
    pub cost_ceiling: Option<crate::core::agent::session::CostCeiling>,
}

/// Resolved engine handle for a chat session: the args are built once and the
/// request body is assembled per turn (the TUI reuses this across many turns;
/// the plain CLI builds a single body). `model`/`limits` seed each body.
pub(crate) struct AgentSession {
    pub args: OrchestrationArgs,
    pub permission_requests: PermissionRegistry,
    pub model: String,
    /// Fast model for the `smol` role (goal evaluation). Falls back to `model`.
    pub smol_model: String,
    pub limits: SessionLimits,
    /// Whether the TUI expands `<think>` reasoning blocks (default false).
    pub show_reasoning: bool,
    /// Whether the TUI streams reasoning into the live tail while it folds
    /// (`stream_reasoning` in `~/.jan/config.toml`, default true). Independent
    /// of `show_reasoning`, which unfolds it for good.
    pub stream_reasoning: bool,
    /// Whether to resend a prior assistant turn's reasoning to the model
    /// (default true). False drops `reasoning_content` from outgoing assistant
    /// messages; the display journal still keeps reasoning for a resume.
    pub send_reasoning: bool,
    /// Shared MCP connection map (same Arc held by `args`), so the TUI can
    /// connect/disconnect servers live via `/mcp` and later turns pick them up.
    pub mcp_servers: crate::core::state::SharedMcpServers,
    /// Background connect of `active` MCP servers, awaited before the first turn.
    /// `None` when no server is active. Resolves to the connected server names.
    pub mcp_task: Option<tokio::task::JoinHandle<mcp::ConnectOutcome>>,
    /// The git worktree this session's tools work in, when it has one. `None`
    /// is the default: the agent edits the project directory itself.
    pub workspace: Option<worktree::Worktree>,
    /// Why a requested worktree could not be set up, for the surface to report.
    /// `Some` only when one was asked for and the session fell back to the
    /// project directory.
    pub workspace_note: Option<String>,
}

/// The request body for one turn, as a free function of the parts that shape
/// it. Split out of [`AgentSession::body`] so the wire contract is testable
/// without standing up an orchestration handle (MCP maps, HTTP client, tool
/// permissions), none of which this assembly reads.
fn request_body(
    model: &str,
    limits: &SessionLimits,
    send_reasoning: bool,
    messages: serde_json::Value,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_session_tokens": limits.max_session_tokens,
        "stream": true,
    });
    // Forward the per-request output cap only when configured; it flows to
    // the upstream via `copy_optional_chat_params`.
    if let Some(max) = limits.max_tokens {
        body["max_tokens"] = serde_json::json!(max);
    }
    // Single place a turn cap enters the body: `agent step` pins 1 the same
    // way `--max-turns` pins N, so both go through `limits`. Absent rather
    // than 0 when unset, so the engine's own default applies.
    if let Some(turns) = limits.max_turns {
        body["max_turns"] = serde_json::json!(turns);
    }
    // The ceiling travels with the rates it is metered against: the loop is
    // not `cli`-gated, so prices resolved here are the only ones it sees.
    if let Some(ceiling) = limits.cost_ceiling {
        body["max_budget_usd"] = serde_json::json!(ceiling.max_usd);
        body["token_rates"] = serde_json::json!({
            "prompt_usd": ceiling.rates.prompt_usd,
            "completion_usd": ceiling.rates.completion_usd,
            "cache_read_usd": ceiling.rates.cache_read_usd,
            "cache_write_usd": ceiling.rates.cache_write_usd,
        });
    }
    // Reasoning resend policy: the request-level flag the loop reads to
    // decide whether prior assistant `reasoning_content` goes back out.
    body["send_reasoning"] = serde_json::json!(send_reasoning);
    body
}

impl AgentSession {
    /// Build a streaming request body for the given conversation history.
    pub(crate) fn body(&self, messages: serde_json::Value) -> serde_json::Value {
        request_body(&self.model, &self.limits, self.send_reasoning, messages)
    }
}

/// How freely a session acts, named the way the desktop's Cowork modes are.
///
/// * `review`: read-only plan mode; leaving it needs the plan approved.
/// * `ask`: writes, shell commands and MCP calls prompt (`--safe`).
/// * `auto`: those run unprompted, inside the sandbox when it is on (default).
/// * `bypass`: as `auto`. The tools that always ask (`host_*`, `computer`,
///   clipboard) still ask in every mode; no mode covers them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    Review,
    Ask,
    Auto,
    Bypass,
}

impl PermissionMode {
    pub fn parse(s: &str) -> Result<PermissionMode, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "review" => Ok(PermissionMode::Review),
            "ask" => Ok(PermissionMode::Ask),
            "auto" => Ok(PermissionMode::Auto),
            "bypass" => Ok(PermissionMode::Bypass),
            other => Err(format!("unknown mode '{other}' (review, ask, auto, bypass)")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            PermissionMode::Review => "review",
            PermissionMode::Ask => "ask",
            PermissionMode::Auto => "auto",
            PermissionMode::Bypass => "bypass",
        }
    }

    /// Whether writes, shell commands and MCP calls run without a prompt.
    pub fn auto_approve(self) -> bool {
        matches!(self, PermissionMode::Auto | PermissionMode::Bypass)
    }

    /// Whether the session is read-only plan mode.
    pub fn plan(self) -> bool {
        self == PermissionMode::Review
    }

    /// `(auto_approve, plan)` for a start-up request: `--mode` when given,
    /// else the older `--safe` and `--plan` switches.
    pub fn resolve(mode: Option<&str>, safe: bool, plan: bool) -> Result<(bool, bool), String> {
        match mode {
            Some(m) => {
                if safe || plan {
                    return Err("--mode replaces --safe and --plan; give one or the other".to_string());
                }
                let m = PermissionMode::parse(m)?;
                // Review reads only, so what it would approve never comes up.
                Ok((m.auto_approve(), m.plan()))
            }
            None => Ok((!safe, plan)),
        }
    }
}

/// The per-invocation switches a session starts with.
///
/// A struct rather than a run of positional `bool`s: `(.., false, false, true)`
/// at a call site names none of them, and the compiler cannot catch two of them
/// being swapped.
#[derive(Debug, Clone, Default)]
pub struct SessionFlags {
    /// Skip the permission prompt for writes, shell, and MCP calls.
    pub auto_approve: bool,
    /// Start in read-only plan mode.
    pub plan: bool,
    /// Fail when no model resolves instead of launching with an empty one. The
    /// TUI leaves this off so `/login` can fill the model in later.
    pub require_model: bool,
    /// `--sandbox`: run `bash` under OS confinement. `None` (not passed) defers
    /// to `[tools].sandbox`, then the global `sandbox`, then the CLI default of
    /// off.
    pub sandbox: Option<bool>,
    /// `--profile`: a named variation on this project's settings (AH-186).
    /// `None` is the project's own configuration.
    pub profile: Option<String>,
    /// `--compact` / `--verbose`: how much a headless run says about itself
    /// (AH-181). `None` defers to `[output].density`, then normal.
    pub density: Option<Density>,
    /// `--interrupted`: what to do with a resumed session whose last run was
    /// cut off mid-turn (AH-026). `None` refuses such a resume rather than
    /// choosing for the user.
    pub interrupted: Option<inflight::InterruptedChoice>,
    /// `--worktree`: work in a dedicated git checkout. `None` (not passed)
    /// defers to `[agent].worktree`, then the global `worktree`, then the CLI
    /// default of off.
    pub worktree: Option<bool>,
    /// `--max-turns`: hard cap on agentic turns. `None` (not passed) leaves the run unbounded by turns; `0`
    /// is unbounded as well.
    pub max_turns: Option<u64>,
    /// `--max-session-tokens`: session token ceiling, outranking
    /// `[budget].max_tokens`. `None` (not passed) defers to that, then to
    /// `DEFAULT_MAX_SESSION_TOKENS`.
    pub max_session_tokens: Option<u64>,
    /// `--max-budget-usd`: hard USD ceiling for the run, outranking
    /// `[budget].max_usd`. A run that asks for one but cannot be priced is
    /// refused (see `resolve_cost_ceiling`).
    pub max_budget_usd: Option<f64>,
}

/// The desktop app's currently-selected model, adopted only when signed in to
/// Tokamak. Split out from the resolution chain so the rule is testable without
/// a `settings.json` on disk; see the note at the call site for why the sign-in
/// gates it.
fn inherit_desktop_model(
    signed_in: bool,
    selection: crate::core::cli::providers::DesktopSelection,
) -> Option<String> {
    signed_in.then_some(selection.model).flatten()
}

/// The newest workspace snapshot a thread recorded, which is where a fork of it
/// should start its own checkout: the files as that conversation last left them,
/// rather than a `HEAD` its whole transcript predates.
fn latest_snapshot(thread: Option<&serde_json::Value>) -> Option<String> {
    let metadata = thread?.get("metadata")?;
    metadata
        .get("checkpoints")
        .and_then(|c| c.as_array())
        .and_then(|c| c.last())
        .and_then(|c| c.get("sha"))
        .or_else(|| metadata.get("base_snapshot"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// The metadata to save a thread with so it names the checkout the run worked
/// in, merged into whatever that thread already recorded rather than replacing
/// it. `None` when there is no worktree, which is `cli_save_thread`'s "keep the
/// existing metadata" case.
///
/// Without this a resumed session branches a *fresh* worktree and the model
/// reads a pristine tree, silently losing everything the run it is continuing
/// did in there.
#[cfg_attr(feature = "cli", allow(dead_code))]
fn worktree_metadata(
    agent_dir: &std::path::Path,
    thread_id: Option<&str>,
    workspace: Option<&worktree::Worktree>,
) -> Option<serde_json::Value> {
    let workspace = workspace?;
    let mut meta = thread_id
        .and_then(|id| cli_get_thread_in(agent_dir, id).ok())
        .and_then(|thread| thread.get("metadata")?.as_object().cloned())
        .unwrap_or_default();
    meta.insert(
        worktree::WORKTREE_KEY.to_string(),
        worktree::to_metadata(workspace),
    );
    Some(serde_json::Value::Object(meta))
}

/// The commit a fork's checkout starts from.
///
/// The newest snapshot the source thread recorded is the best answer: it is the
/// tree that conversation last left. A headless run takes no snapshots (they are
/// the TUI's per-turn checkpoints), so fall back to capturing the source's
/// worktree as it stands -- otherwise the branch opens on a pristine `HEAD`
/// while the transcript it inherited describes work that is not in it, and the
/// model's first act is to re-read files that disagree with what it just said.
///
/// `None` leaves the choice to `HEAD`, which is right when the source never had
/// a checkout of its own.
fn fork_base(source: Option<&serde_json::Value>) -> Option<String> {
    use crate::core::agent::git;

    if let Some(sha) = latest_snapshot(source) {
        return Some(sha);
    }
    let source = source?;
    let workspace = worktree::from_metadata(source.get("metadata"))?;
    if !workspace.path.is_dir() {
        return None;
    }
    // Keyed per source thread and cleaned up: this index is a one-shot, unlike
    // the per-thread one a session keeps warm across its turns.
    let key = format!("fork-base-{}", source.get("id")?.as_str()?);
    let changed: Vec<PathBuf> = git::changed_paths(&workspace.path)
        .into_iter()
        .map(PathBuf::from)
        .collect();
    let sha = git::snapshot(&workspace.path, None, "jan agent fork base", &key, &changed).ok();
    git::cleanup_snapshot_index(&key);
    sha
}

/// Decide the checkout this session's tools work in.
///
/// A plain resume reattaches to the worktree its thread recorded. A fork is a
/// *different* thread, so it branches its own from where the source left off --
/// two conversations editing one checkout is the thing a worktree exists to
/// prevent. A session that cannot get the worktree it asked for runs in the
/// project directory and says why, because that fallback is exactly how every
/// session behaved before worktrees existed.
fn resolve_workspace(
    project_root: &std::path::Path,
    flag: Option<bool>,
    resume: Option<&ResumeRequest>,
) -> (Option<worktree::Worktree>, Option<String>) {
    let configured = crate::core::agent::project::run_settings(project_root).worktree;
    if !worktree::resolve_enabled(flag, configured) {
        return (None, None);
    }
    let forking = resume.is_some_and(|request| request.fork);
    let source = resume
        .and_then(|request| find_resume_thread(&agent_dir_for(project_root), &request.target).ok());
    let recorded = if forking {
        None
    } else {
        worktree::from_metadata(source.as_ref().and_then(|t| t.get("metadata")))
    };
    let base = forking.then(|| fork_base(source.as_ref())).flatten();
    match worktree::for_session(project_root, recorded.as_ref(), base.as_deref()) {
        // A different path than the one recorded means the checkout was gone and
        // a fresh one was branched from HEAD: nothing was committed there, so the
        // resumed conversation now describes edits this tree does not have.
        Ok(workspace) => {
            let note = recorded
                .filter(|old| old.path != workspace.path)
                .map(|old| {
                    format!(
                        "the checkout this thread recorded ({}) is gone; starting fresh from HEAD",
                        old.path.display()
                    )
                });
            (Some(workspace), note)
        }
        Err(e) => (None, Some(format!("no worktree for this session: {e}"))),
    }
}

/// Resolve project config + credentials into a ready-to-run engine handle.
/// Shared by `run_agent_loop` (plain CLI) and `cli_agent_ui` (TUI).
fn prepare_agent_session(
    project: &str,
    model_override: Option<String>,
    overrides: ProviderOverrides,
    flags: SessionFlags,
    resume: Option<&ResumeRequest>,
) -> Result<AgentSession, String> {
    let project_root = resolve_project_root(project);
    ensure_project(&project_root)?;
    if let Err(e) = crate::core::agent::global_config::ensure_global_config() {
        log::warn!("Agent: could not scaffold ~/.jan/config.toml: {e}");
    }
    // AH-186: the run's settings are the project's, with the chosen profile
    // folded in. An unknown profile is refused here -- before a provider, a
    // tool or a model is resolved from settings nobody asked for.
    let cfg = load_agent_config_with_profile(&project_root, flags.profile.as_deref())?;
    let permissions = permissions_from(&cfg);

    // Resolution order: --model flag, then agent.toml [agent].model, then the
    // standalone global config (~/.jan/config.toml default_model / first provider
    // model), then the desktop app's currently-selected model (settings.json
    // inherit). Global config outranks desktop so a standalone agent is
    // self-sufficient without a desktop install.
    //
    // The desktop inherit is the last resort and applies only when signed in to
    // Tokamak. Without a sign-in, silently adopting whatever model the desktop
    // app last had selected starts the session on a provider the user never
    // chose here -- and hides the sign-in notice that would otherwise fire,
    // because a non-empty model reads as "configured". Leaving it unset surfaces
    // the notice instead. An explicit --model, agent.toml, or ~/.jan default is
    // unaffected: all three outrank this.
    let explicit = model_override.is_some() || overrides.api_key.is_some();
    let model = model_override
        .or_else(|| cfg.agent.model.clone())
        .or_else(|| {
            crate::core::agent::global_config::default_model()
                .ok()
                .flatten()
        })
        .or_else(|| {
            inherit_desktop_model(
                crate::core::cli::tokamak::auth_status().signed_in,
                crate::core::cli::providers::desktop_selection(),
            )
        });
    // A project or global default can name a model with nobody around to serve
    // it (e.g. this repo's own agent.toml pins one, but a fresh `~/.jan` has no
    // credentials for anything). Trust it only when the user was explicit
    // (--model/--api-key) or some provider can actually be reached; otherwise
    // treat it as unset so the TUI's sign-in notice fires instead of failing on
    // the first message.
    let model = if !flags.require_model
        && !explicit
        && !crate::core::cli::providers::has_usable_provider(Some(&project_root))
    {
        String::new()
    } else {
        model.unwrap_or_default()
    };
    if model.is_empty() && flags.require_model {
        return Err(
            "no model specified: run `flint login` to sign in to Tokamak, or pass --model, set [agent].model in agent.toml, set default_model in ~/.jan/config.toml, or select a model in the desktop app"
                .to_string(),
        );
    }
    // AH-194: the project's own rules about which model answers what. Read
    // here, where the model has been resolved and before anything is sent, and
    // refused at startup when a rule cannot be honoured -- a rule quietly
    // ignored would send the run to a model nobody chose while looking as
    // though the rule had been honoured.
    let routing = crate::core::agent::routing::rules(&cfg.routing)
        .map_err(|e| e.message().to_string())?;
    let model = match crate::core::agent::routing::route(
        &routing,
        &crate::core::agent::routing::Request {
            role: "task",
            agent: None,
            model: &model,
        },
    ) {
        Some(routed) => {
            eprintln!("(routing: the run's model is {routed})");
            routed
        }
        None => model,
    };
    // The `smol` role (used by /goal evaluation): an explicit smol_model in
    // ~/.jan/config.toml, else reuse the main model so evaluation always works.
    let smol_model = crate::core::agent::global_config::smol_model()
        .ok()
        .flatten()
        .unwrap_or_else(|| model.clone());
    let smol_model = crate::core::agent::routing::route(
        &routing,
        &crate::core::agent::routing::Request {
            role: "smol",
            agent: None,
            model: &smol_model,
        },
    )
    .unwrap_or(smol_model);

    let mut provider_configs = load_provider_configs(Some(&project_root), &overrides)?;

    // `--provider` names the provider the run goes to, by id or by the name
    // the desktop app shows. Without pinning, upstream resolution picks
    // whichever provider serves the model id first, which may be another one.
    if let Some(requested) = overrides.provider.as_deref().filter(|_| overrides.pin) {
        crate::core::cli::providers::pin_provider(&mut provider_configs, requested, &model)?;
    }

    // Reject a model whose only provider is a local engine descriptor before any
    // setup work: the CLI cannot start an engine itself, so this would otherwise
    // fail mid-run with a far vaguer message. Local models are still runnable
    // over HTTP -- via the desktop app's API server -- which is what the hint
    // points at; a provider entry with a base_url never reaches this branch.
    if let Some(local) =
        crate::core::cli::providers::unreachable_local_provider(&provider_configs, &model)
    {
        return Err(format!(
            "model '{model}' is only offered by '{local}', a local engine the Flint CLI cannot \
             start itself. To use it, run the model in the Jan desktop app with its API server \
             enabled and point a provider at it:\n  \
             flint config set --provider jan --base-url http://localhost:1337/v1 --model {model}\n\
             Or pick a model from `flint cli models list`."
        ));
    }

    // MCP servers marked `active` in mcp_config.json connect off-thread so setup/
    // render isn't blocked on a cold stdio spawn. The caller awaits `mcp_task`
    // before the first turn (tools are collected once per run), so a race with
    // the first message can't leave the model without its MCP tools. `None` when
    // no server is active.
    let mcp_servers: crate::core::state::SharedMcpServers = Arc::new(Mutex::new(HashMap::new()));
    let mcp_settings = mcp::read_settings();
    let mcp_task = if mcp::active_count() > 0 {
        let servers = mcp_servers.clone();
        Some(tokio::spawn(
            async move { mcp::connect_active(&servers).await },
        ))
    } else {
        None
    };

    // `think_tags` is user-wide and read from free rendering functions, so it is
    // applied to the process here, the one path every agent surface takes.
    tui::set_think_tags_parsed(crate::core::agent::global_config::think_tags_enabled());

    let permission_requests: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
    let max_parallel_subagents = cfg
        .agent
        .max_parallel_subagents
        .unwrap_or(crate::core::agent::subagent::DEFAULT_MAX_PARALLEL_SUBAGENTS);
    // The tools work in the worktree when there is one; everything else about
    // the session (agent.toml, credentials, the thread store) stays keyed to the
    // project, which is where the user configured it.
    let (workspace, workspace_note) = resolve_workspace(&project_root, flags.worktree, resume);
    let tool_root = workspace
        .as_ref()
        .map(|w| w.path.clone())
        .unwrap_or_else(|| project_root.clone());
    let args = build_cli_orchestration_args(
        tool_root,
        permissions,
        provider_configs,
        mcp_servers.clone(),
        mcp_settings,
        permission_requests.clone(),
        // Host tools are declared per *run*, by a client on stdin, so the
        // session is built without them and the duplex headless path installs
        // the declared set before orchestration starts. The TUI leaves this
        // empty, and `run_subagent` clears it for a child, so neither emits a
        // `tool_request` -- only a run with a client that can answer one does.
        crate::core::agent::host_tools::HostToolSet::new(),
        crate::core::agent::host_tools::new_registry(),
        flags.auto_approve,
        flags.plan,
        max_parallel_subagents,
        flags.sandbox,
        cfg.agent.fallback.clone(),
        flags.profile.clone(),
    );

    // Resolution order: configured `[agent].context_window` override, then the
    // built-in model catalog, then the 128K fallback.
    let resolved_window = crate::core::cli::model_capabilities::resolve_context_window(
        &model,
        cfg.agent.context_window,
    );

    // AH-076: the same policy the loop reads, with the legacy
    // `[agent].compaction_reserve_tokens` still honoured as a project value.
    let compaction = tauri_plugin_agent_tools::compaction_policy::Policy::resolve(
        Some(&crate::core::app::commands::resolve_jan_data_folder()),
        Some(&resolve_project_root(project)),
        cfg.agent.compaction_reserve_tokens,
    )
    .map_err(|e| e.message().to_string())?;

    // Resolved before the session is built: a run that asked for a ceiling it
    // cannot be priced against is refused here, before any paid request.
    let cost_ceiling = match flags.max_budget_usd.or(cfg.budget.max_usd) {
        None => None,
        Some(_) => {
            let prices = crate::core::agent::spend::prices(
                &crate::core::app::commands::resolve_jan_data_folder(),
            )
            .map_err(|e| e.message)?;
            resolve_cost_ceiling(flags.max_budget_usd, cfg.budget.max_usd, &prices, &model)?
        }
    };

    Ok(AgentSession {
        args,
        permission_requests,
        model,
        smol_model,
        limits: SessionLimits {
            context_window: resolved_window.tokens,
            context_window_source: resolved_window.source,
            reserve_tokens: compaction.reserve_tokens,
            compaction: compaction.clone(),
            max_tokens: cfg.agent.max_tokens,
            max_session_tokens: resolve_session_budget(
                flags.max_session_tokens,
                cfg.budget.max_tokens,
            ),
            max_turns: flags.max_turns,
            cost_ceiling,
        },
        show_reasoning: cfg.agent.show_reasoning.unwrap_or(false),
        stream_reasoning: crate::core::agent::global_config::stream_reasoning_enabled(),
        send_reasoning: cfg.agent.send_reasoning.unwrap_or(true),
        mcp_servers,
        mcp_task,
        workspace,
        workspace_note,
    })
}

/// The prior conversation a non-interactive `--resume` run continues, in
/// OpenAI `{role, content}` shape (the wire format the engine expects).
struct ResumedSession {
    thread_id: String,
    history: Vec<serde_json::Value>,
}

/// Load a saved thread's conversation for continuation, tool calls and results
/// included (see `rebuild_wire_history`), matching `/resume` in the TUI. Errors
/// describe why nothing could be resumed; the caller starts fresh.
fn load_resume_history(
    agent_dir: &std::path::Path,
    request: &ResumeRequest,
) -> Result<ResumedSession, String> {
    let thread = resolve_resume(agent_dir, request)?;
    let thread_id = thread
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "saved thread has no id".to_string())?
        .to_string();
    let (messages, skipped) = cli_read_messages_lenient(agent_dir, &thread_id)?;
    if skipped > 0 {
        eprintln!("(skipped {skipped} unreadable message(s) in the resumed session)");
    }
    let history = rebuild_wire_history(&messages);
    Ok(ResumedSession { thread_id, history })
}

/// Decide what a resumed session continues from when its last run did not end
/// (AH-026).
///
/// A session another live process is running is refused. A session whose run
/// was cut off is refused unless the caller chose what to do with the
/// interrupted turn -- keep the partial reply or discard it -- and then
/// continues from the checkpoint: every completed tool call and result, which
/// the saved thread (written only at the end of a run) never had.
fn recover_interrupted(
    agent_dir: &std::path::Path,
    resumed: ResumedSession,
    choice: Option<inflight::InterruptedChoice>,
) -> Result<ResumedSession, String> {
    let thread_dir = get_thread_dir(agent_dir, &resumed.thread_id);
    match inflight::state(&thread_dir) {
        inflight::RunState::Settled => Ok(resumed),
        inflight::RunState::Live { pid } => Err(format!(
            "[invalid_input] session {} is still being run by process {pid}; wait for it to finish or stop it before resuming",
            short_id(&resumed.thread_id)
        )),
        inflight::RunState::Interrupted(checkpoint) => {
            let Some(choice) = choice else {
                return Err(format!(
                    "[invalid_input] session {} was interrupted mid-turn ({} completed message(s), {} character(s) of an unfinished reply). \
                     Resume with --interrupted=continue to keep the unfinished reply, or --interrupted=discard-partial to drop it",
                    short_id(&resumed.thread_id),
                    checkpoint.conversation.len(),
                    checkpoint.partial.chars().count()
                ));
            };
            // An unreadable checkpoint recovers nothing more than the saved
            // thread already holds.
            let base = if checkpoint.conversation.is_empty() {
                resumed.history.clone()
            } else {
                checkpoint.conversation.clone()
            };
            let recovered = inflight::recovered_conversation(
                &inflight::Checkpoint { conversation: base, ..checkpoint },
                choice,
            );
            eprintln!(
                "(recovered the interrupted turn of session {}: {})",
                short_id(&resumed.thread_id),
                match choice {
                    inflight::InterruptedChoice::Continue => "kept the unfinished reply",
                    inflight::InterruptedChoice::DiscardPartial => "discarded the unfinished reply",
                }
            );
            inflight::clear(&thread_dir);
            Ok(ResumedSession { thread_id: resumed.thread_id, history: recovered })
        }
    }
}

fn prepare_agent_run(
    project: &str,
    task: &str,
    model_override: Option<String>,
    single_turn: bool,
    overrides: ProviderOverrides,
    flags: SessionFlags,
    resume: Option<ResumeRequest>,
) -> Result<PreparedRun, String> {
    let interrupted_choice = flags.interrupted;
    // Non-interactive runs (`agent run`/`step`) have no plan-review handoff, so
    // plan mode stays a TUI-only startup option, and a run with no model has no
    // terminal to recover in, so it must fail rather than launch empty.
    let session = prepare_agent_session(
        project,
        model_override,
        overrides,
        SessionFlags {
            plan: false,
            require_model: true,
            // `agent step` is a single turn by definition and outranks any
            // flag; `agent run` carries whatever `--max-turns` asked for.
            max_turns: if single_turn { Some(1) } else { flags.max_turns },
            ..flags
        },
        resume.as_ref(),
    )?;
    let project_root = resolve_project_root(project);
    if let Some(note) = session.workspace_note.as_deref() {
        eprintln!("({note})");
    }
    if let Some(workspace) = session.workspace.as_ref() {
        eprintln!(
            "(working in {} on {})",
            workspace.path.display(),
            workspace.branch
        );
    }
    // `@path` names a file the agent is about to work on, so it resolves against
    // the checkout the tools see rather than the project directory.
    let read_root = session
        .workspace
        .as_ref()
        .map(|w| w.path.clone())
        .unwrap_or_else(|| project_root.clone());
    let (clean_task, injected) = path_refs::resolve_references(task, &read_root);
    let final_task = if injected.is_empty() {
        clean_task
    } else {
        format!("{clean_task}\n\n---\nReferenced file contents:\n\n{injected}")
    };

    // A failed resume is not fatal: report it and run the prompt in a new session.
    let resumed = match resume {
        None => None,
        Some(target) => match load_resume_history(&agent_dir_for(&project_root), &target) {
            Ok(r) => Some(recover_interrupted(&agent_dir_for(&project_root), r, interrupted_choice)?),
            Err(e) => {
                eprintln!("{e}; starting a new session");
                None
            }
        },
    };
    if let Some(r) = resumed.as_ref() {
        eprintln!(
            "(resumed session {} with {} message(s))",
            short_id(&r.thread_id),
            r.history.len()
        );
    }

    // AH-008: the record's session is the conversation the user sees, not the
    // process that happened to run this turn. Without this a `--resume` run
    // minted a fresh session id, so seven turns of one conversation left seven
    // unrelated event logs, seven prompt histories and seven sets of changes,
    // and nothing could join them.
    let mut session = session;
    if let Some(resumed) = resumed.as_ref() {
        session.args.session_id = Some(resumed.thread_id.clone());
    }
    // A new conversation saves under the id its run already used, so the same
    // join holds from the first turn rather than only from the second.
    let thread_id = resumed
        .as_ref()
        .map(|r| r.thread_id.clone())
        .or_else(|| session.args.session_id.clone());

    let mut history = resumed
        .as_ref()
        .map(|r| r.history.clone())
        .unwrap_or_default();
    history.push(serde_json::json!({ "role": "user", "content": final_task }));
    let body = session.body(serde_json::json!(history.clone()));
    // Emit resolved references stderr so the user sees what was injected
    if !injected.is_empty() {
        eprintln!("(resolved @path references)");
    }
    Ok(PreparedRun {
        args: session.args,
        body,
        limits: session.limits,
        permission_requests: session.permission_requests,
        mcp_task: session.mcp_task,
        // Non-interactive runs persist into the same per-project store the TUI
        // uses, so a run can later be continued with --resume from either side.
        persist: PersistTarget {
            agent_dir: agent_dir_for(&project_root),
            thread_id,
            model: session.model,
            history,
            workspace: session.workspace,
        },
    })
}

/// First 8 chars of a thread id, the form the TUI shows in `/threads`.
fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

/// Read a host's tool declarations from the file `--host-tools` names.
///
/// Every failure is the host's to fix and is reported with the path, since a
/// host that mistyped one is otherwise left guessing which of its tools the run
/// disagreed with.
fn load_host_tools(path: &str) -> Result<crate::core::agent::host_tools::HostToolSet, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read --host-tools file '{path}': {e}"))?;
    let decls: Vec<crate::core::agent::host_tools::HostToolDecl> = serde_json::from_str(&raw)
        .map_err(|e| format!("--host-tools file '{path}' is not a list of tool declarations: {e}"))?;
    crate::core::agent::host_tools::HostToolSet::declare(decls)
        .map_err(|e| format!("--host-tools file '{path}': {e}"))
}

#[allow(clippy::too_many_arguments)]
async fn run_agent_loop(
    project: &str,
    task: &str,
    model_override: Option<String>,
    single_turn: bool,
    overrides: ProviderOverrides,
    flags: SessionFlags,
    resume: Option<ResumeRequest>,
    format: OutputFormat,
    input_format: InputFormat,
    host_tools: Option<&str>,
    host_gate: bool,
) -> Result<(), tauri_plugin_agent_tools::harness_error::HarnessError> {
    // A duplex run switches off both of the CLI's own answer paths, so the
    // client is the only thing that can resolve a permission request -- and it
    // can only do that if it is being told the request ids. `text` prints them
    // to stderr and `json` prints nothing at all until the run ends, so either
    // pairing leaves a gated call unanswerable. Rejected rather than silently
    // upgraded: a caller parsing plain text should not have the format changed
    // under it.
    let started = std::time::Instant::now();
    // Read before the flags are handed on: this is the run's own answer about
    // how much to say, and it is wanted after the run as well as during it.
    let asked_density = flags.density;
    // Every refusal below is a setup failure like any other, so it is reported
    // the way `prepare_agent_run`'s is: one `result` record with
    // `error.code: "setup_error"`. Returning early instead would leave a
    // machine consumer an empty stdout and a human string on stderr, which is
    // the one thing this channel promises never to do -- and a mistyped
    // `--host-tools` path is the first failure a host is likely to hit.
    let setup = (|| {
        if input_format.is_stream_json() && !format.is_stream_json() {
            return Err(
                "--input-format stream-json requires --output-format stream-json (the client \
                 answers permission requests, so it must be reading them)"
                    .to_string(),
            );
        }
        // Declared before anything is spent: a malformed or unacceptable tool
        // set is the host's own mistake, and finding out at the first call --
        // mid-task, after paid requests -- is worse than refusing to start.
        // Handing the gate to a host that declared no tools would be a no-op
        // the caller probably did not mean; say so rather than ignore it.
        if host_gate && host_tools.is_none() {
            return Err("--host-gate requires --host-tools".to_string());
        }
        match host_tools {
            Some(path) => {
                if !input_format.is_stream_json() {
                    return Err(
                        "--host-tools requires --input-format stream-json (a host tool call is \
                         answered with a tool_result message on stdin)"
                            .to_string(),
                    );
                }
                load_host_tools(path)
            }
            None => Ok(crate::core::agent::host_tools::HostToolSet::new()),
        }
    })();
    let host_tools = match setup {
        Ok(host_tools) => host_tools,
        Err(e) => {
            if format.is_machine() {
                print_report(
                    format,
                    RunReport::setup_failure(&e).finish(
                        None,
                        "",
                        started.elapsed().as_millis(),
                        None,
                    ),
                );
            }
            return Err(tauri_plugin_agent_tools::harness_error::HarnessError::new(
                tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
                e,
            )
            .at(tauri_plugin_agent_tools::harness_error::Stage::Startup));
        }
    };
    let prepared = prepare_agent_run(
        project,
        task,
        model_override,
        single_turn,
        overrides,
        flags,
        resume,
    );
    // A setup failure never reaches the event stream, so a JSON consumer would
    // otherwise get an empty stdout and have to parse the human error off stderr.
    let PreparedRun {
        mut args,
        body,
        limits,
        permission_requests,
        mcp_task,
        persist,
    } = match prepared {
        Ok(prepared) => prepared,
        Err(e) => {
            if format.is_machine() {
                print_report(
                    format,
                    RunReport::setup_failure(&e).finish(
                        None,
                        "",
                        started.elapsed().as_millis(),
                        None,
                    ),
                );
            }
            // Setup failed before a provider was ever reached: the run never
            // started, which is a startup failure and not the model's.
            return Err(tauri_plugin_agent_tools::harness_error::HarnessError::new(
                tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
                e,
            )
            .at(tauri_plugin_agent_tools::harness_error::Stage::Startup));
        }
    };
    // Installed after the session is built, since host tools are declared per
    // run rather than per project: the same session config serves a run with
    // them and one without.
    args.host_tools = host_tools;
    // `--host-gate`: the host's own callback is the approval step, so Jan
    // raises no `permission_request` for a host tool of any class.
    args.host_owns_gate = host_gate;

    // Block until active MCP servers connect, so tools (collected once per run)
    // are present on the first turn.
    if let Some(task) = mcp_task {
        match task.await {
            Ok(outcome) => {
                if !outcome.connected.is_empty() {
                    log::info!("MCP: connected {}", outcome.connected.join(", "));
                }
                // Headless has no transcript to note into, so these stay logs.
                for failure in &outcome.failed {
                    log::warn!("MCP: {failure}");
                }
                // Signing in needs a browser and a keypress, neither of which
                // exists here, so the fix is named rather than attempted.
                if !outcome.needs_auth.is_empty() {
                    log::warn!(
                        "MCP: {} need authentication - run `jan` and use /mcp to sign in",
                        outcome.needs_auth.join(", ")
                    );
                }
            }
            Err(e) => log::warn!("MCP connect task failed: {e}"),
        }
    }

    // AH-077: the headless run warns as the window fills, once per approach,
    // with the same words the TUI uses.
    let pressure_window = limits.context_window;
    let pressure_reserve = limits.reserve_tokens;
    // AH-185/AH-184: who to tell, checked before the run rather than when it
    // ends and nobody is told. A project that declares nothing costs nothing.
    let notify = crate::core::agent::project::load_agent_config(std::path::Path::new(project))
        .ok()
        .map(|cfg| cfg.notify)
        .unwrap_or_default();
    let notify = crate::core::agent::notify::check(&notify)?;
    let notify_root = std::path::PathBuf::from(project);
    let notify_session = args.session_id.clone().unwrap_or_default();
    // The session this run saves under, decided here rather than at save time
    // so the `init` record can name it: a client learns the id it can `--resume`
    // from the first line of the stream, and a run killed mid-flight still told
    // it which id to look for.
    let session_id = persist
        .thread_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    // The run's own id becomes the session id, so the one a client is handed,
    // the one its requests are correlated under, and the one a provenance
    // record names are the same id: three spellings of a session would only
    // ever be a way to lose the thread between them.
    args.session_id = Some(session_id.clone());

    // The handshake, before anything else can reach stdout. Printed here rather
    // than from the printer task for exactly that reason: nothing has been
    // spawned yet, so "first line" is a property of the code's order rather than
    // a race against the run's own events.
    if format.is_stream_json() {
        print_json_line(&init_record(&args, &session_id, &persist.model, input_format).await);
    }

    // The client on stdin, when there is one: it owns every permission decision
    // and can steer or stop the run while it is in flight.
    let input = input_format
        .is_stream_json()
        .then(|| Arc::new(StreamInput::default()));
    // Created before the reader so it can report the host requests it releases
    // on the same channel as the run's events: the printer then orders those
    // records before the final result, which it prints only once every sender
    // (the reader's included) has dropped.
    let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
    let reader = input.as_ref().map(|input| {
        spawn_input_reader(
            Arc::clone(input),
            Arc::clone(&permission_requests),
            Arc::clone(&args.host_tool_requests),
            tx.clone(),
            format,
        )
    });
    let client = input.clone();
    let host_tool_requests = Arc::clone(&args.host_tool_requests);

    // The report is folded in both formats from the same stream the printer
    // reads, so the JSON envelope can never disagree with the text output.
    // AH-181: how much this run says about itself. The flag outranks the
    // project's declaration, and an unreadable declaration refuses the run
    // rather than quietly printing a different amount than was asked for.
    let density = match asked_density {
        Some(density) => density,
        None => {
            let declared = crate::core::agent::project::load_agent_config(std::path::Path::new(project))
                .ok()
                .and_then(|cfg| cfg.output.density)
                .unwrap_or_default();
            Density::parse(&declared).map_err(|e| {
                tauri_plugin_agent_tools::harness_error::HarnessError::new(
                    tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
                    format!("[output].density: {e}"),
                )
                .at(tauri_plugin_agent_tools::harness_error::Stage::Startup)
            })?
        }
    };
    let notify_for_prompts = notify.clone();
    let prompt_root = notify_root.clone();
    let prompt_session = notify_session.clone();
    // AH-026: the turn in flight is on disk as it happens, so a run killed
    // mid-turn can be resumed without losing it.
    // The thread is written when the run starts, not only when it ends: a run
    // killed mid-turn otherwise leaves a checkpoint in a thread that no
    // listing knows, and `--resume` cannot name it.
    if let Some(thread) = persist.thread_id.as_deref() {
        if let Err(e) = cli_save_thread(&persist.agent_dir, Some(thread), &persist.model, &persist.history, None) {
            eprintln!("(could not save session before the run: {e})");
        }
    }
    let checkpoint = std::sync::Arc::new(std::sync::Mutex::new(match persist.thread_id.as_deref() {
        Some(thread) => Some(inflight::Writer::begin(
            &get_thread_dir(&persist.agent_dir, thread),
            &persist.model,
            persist.history.clone(),
        )?),
        None => None,
    }));
    let checkpoint_for_printer = checkpoint.clone();
    let printer = tokio::spawn(async move {
        // The last conversation the loop published, kept for the save below.
        let mut conversation: Option<Vec<serde_json::Value>> = None;
        let mut report = RunReport::default();
        let mut warned_about_context = false;
        while let Some(ev) = rx.recv().await {
            report.observe(&ev);
            // Said before the reply that would overflow, not after: the point
            // of the warning is that there is still a choice to make.
            if let StreamEvent::TurnUsage { usage, .. } = &ev {
                let used = usage.total_tokens.or(usage.prompt_tokens).unwrap_or(0);
                match crate::core::agent::context_pressure::pressure(
                    used,
                    pressure_window,
                    pressure_reserve,
                    // The headless path reports the provider's own numbers.
                    true,
                ) {
                    Some(found) if !warned_about_context => {
                        warned_about_context = true;
                        eprintln!(
                            "\n{}",
                            color::paint(
                                "33",
                                format_args!(
                                    "[context] {}",
                                    crate::core::agent::context_pressure::line(&found),
                                ),
                            ),
                        );
                    }
                    Some(_) => {}
                    None => warned_about_context = false,
                }
            }
            // The run's own conversation, as the loop last published it. A
            // headless run used to save only the prompt and the final answer,
            // so a `--resume` turn handed the model a transcript in which it
            // had *described* work and never called a tool -- which is an
            // example of exactly the wrong behaviour, and the model imitates
            // it. Keeping the calls and their results is what makes a resumed
            // turn continue the same run rather than re-enact a summary of it.
            if let StreamEvent::MessagesUpdated { messages } = &ev {
                conversation = Some(messages.clone());
            }
            if let Ok(mut guard) = checkpoint_for_printer.lock() {
                if let Some(writer) = guard.as_mut() {
                    match &ev {
                        StreamEvent::MessagesUpdated { messages } => writer.conversation(messages),
                        StreamEvent::Token { text } => writer.text(text),
                        _ => {}
                    }
                }
            }
            // A run that has stopped to wait for a person is the moment
            // worth interrupting somebody for: nothing else happens until
            // they answer.
            if let (Some(notify), StreamEvent::PermissionRequest { tool_name, .. }) =
                (notify_for_prompts.as_ref(), &ev)
            {
                let note = crate::core::agent::notify::Notification::new(
                    crate::core::agent::notify::Moment::NeedsAttention,
                    &prompt_session,
                    None,
                    format!("waiting for approval of a {tool_name} call"),
                );
                for outcome in crate::core::agent::notify::deliver(
                    notify,
                    &note,
                    &prompt_root,
                    crate::core::agent::notify::Moment::NeedsAttention,
                )
                .await
                {
                    if let crate::core::agent::notify::Delivered::Failed(why) = outcome {
                        log::warn!("notify: {why}");
                    }
                }
            }
            // Asked per event, not once per run: the client owns the decision
            // only while it is still reading. Once stdin has closed, the CLI
            // takes its own path back, which on a pipe is an auto-deny.
            let duplex = client.as_ref().is_some_and(|c| !c.client_gone());
            // Only the client can answer a host tool call. If it has already
            // left, the call is failed here: `strand_all` fired when stdin
            // closed, so nothing else will ever release this one and the turn
            // would park forever.
            if let StreamEvent::ToolRequest { request_id, .. } = &ev {
                if !duplex {
                    // The request is already on stdout, so its withdrawal is
                    // too; printed here because this task is the stream's order.
                    if crate::core::agent::host_tools::strand(&host_tool_requests, request_id)
                        .await
                    {
                        let cancelled = request_cancelled(request_id, CANCEL_CLIENT_GONE);
                        report.observe(&cancelled);
                        if format.is_stream_json() {
                            print_json_line(&cancelled);
                        }
                    }
                    continue;
                }
            }
            match format {
                OutputFormat::Text => {
                    print_event(ev, &permission_requests, density, duplex).await
                }
                OutputFormat::Json => {
                    resolve_permission_silently(ev, &permission_requests, duplex).await;
                }
                OutputFormat::StreamJson => {
                    print_json_line(&ev);
                    if let Some((request_id, decision)) =
                        resolve_permission_silently(ev, &permission_requests, duplex).await
                    {
                        print_json_line(&PermissionDecisionRecord::new(&request_id, decision));
                    }
                }
            }
        }
        (report, conversation)
    });

    // `None` when the client aborted: the run produced no completion, but a
    // deliberate stop is an outcome rather than a failure, so it is reported on
    // the stream and the process still exits 0.
    let outcome = match input.as_ref() {
        Some(input) => run_steered(&tx, &body, &args, input).await,
        None => Some(run_orchestration_streamed(&tx, &body, &args).await),
    };
    if let Some(reader) = reader {
        reader.abort();
    }
    // A request still registered now belongs to a call the run dropped (it
    // failed or stopped mid-batch); nothing will await its answer, so the host
    // is told to stop working on it before the result record closes the stream.
    for id in crate::core::agent::host_tools::cancel_all(&args.host_tool_requests).await {
        let _ = tx.send(request_cancelled(&id, CANCEL_ABORTED));
    }
    let aborted = outcome.is_none();
    let result = outcome.unwrap_or_else(|| Err(ABORTED_BY_CLIENT.into()));
    drop(tx);
    let (report, conversation) = printer.await.unwrap_or_default();
    if let Some(input) = input.as_ref() {
        report_dropped_follow_ups(input, format);
    }

    // AH-185/AH-184: the run is over, whoever started it has moved on, and
    // this says so. How it ended, and nothing of what it did.
    if let Some(notify) = notify.as_ref() {
        let summary = match result.as_ref() {
            Ok(_) => "the run ended: completed".to_string(),
            Err(e) => format!("the run ended: {} ({})", e.kind().tag(), e.stage().tag()),
        };
        let note = crate::core::agent::notify::Notification::new(
            crate::core::agent::notify::Moment::RunEnded,
            &notify_session,
            None,
            summary,
        );
        for outcome in crate::core::agent::notify::deliver(
            notify,
            &note,
            &notify_root,
            crate::core::agent::notify::Moment::RunEnded,
        )
        .await
        {
            if let crate::core::agent::notify::Delivered::Failed(why) = outcome {
                log::warn!("notify: {why}");
            }
        }
    }

    // Write the turn back so the session stays continuable with --resume.
    let model = persist.model.clone();
    let persisted = persist_headless_run(persist, &result, conversation, Some(&session_id));
    let (session_id, final_text) = (persisted.session_id, persisted.final_text);
    // Saved, so nothing is in flight any more. A run that failed before its
    // thread could be written keeps its checkpoint: its completed steps are
    // still the only copy.
    if persisted.saved || result.is_ok() {
        if let Some(writer) = checkpoint.lock().ok().and_then(|mut g| g.take()) {
            writer.finish();
        }
    }
    if persisted.saved && !format.is_machine() {
        if let Some(id) = session_id.as_deref() {
            eprintln!(
                "{}",
                color::paint(
                    "2",
                    format_args!(
                        "[session {} - resume with `flint --resume={}`]",
                        short_id(id),
                        short_id(id),
                    ),
                ),
            );
        }
    }
    if format.is_machine() {
        print_report(
            format,
            report.finish(
                session_id.as_deref().map(short_id).as_deref(),
                &model,
                started.elapsed().as_millis(),
                final_text.as_deref(),
            ),
        );
    }
    // The stream belongs to this run (AH-183); a later command in the same
    // process is not it.
    tauri_plugin_agent_tools::event_log::unwatch();
    // The one-shot CLI runs exactly one turn, so its session ends here: wipe
    // the persistent bash `/tmp` scratch this run used.
    if let Some(session) = args.session_id.as_deref() {
        let _ = workspace::remove_scratch_dir(session).await;
    }
    if aborted {
        return Ok(());
    }
    result.map(|_| ())
}

/// What writing a finished headless run back produced.
pub(crate) struct PersistedRun {
    /// The thread the run lives in: the one it resumed, or the one just saved.
    pub session_id: Option<String>,
    pub final_text: Option<String>,
    /// Whether this call wrote the thread.
    pub saved: bool,
}

/// Write a finished headless run to the project's thread store so `--resume`
/// can continue it. Shared by `flint cli agent run` and the JSON API (AH-182), so
/// the two cannot save a run differently.
fn persist_headless_run(
    persist: PersistTarget,
    result: &Result<serde_json::Value, tauri_plugin_agent_tools::harness_error::HarnessError>,
    conversation: Option<Vec<serde_json::Value>>,
    save_as: Option<&str>,
) -> PersistedRun {
    let PersistTarget {
        agent_dir,
        thread_id,
        model,
        mut history,
        ..
    } = persist;
    let mut session_id = thread_id.clone();
    let mut final_text = None;
    let mut saved = false;
    if let Ok(completion) = result.as_ref() {
        final_text = completion_text(completion);
        // What the run actually did, when the loop published it: the user's
        // prompt, every tool call the model made, every result it got back,
        // and the answer. Falling back to prompt-and-answer only when no
        // conversation was published (a run that never reached a turn).
        match conversation {
            Some(messages) if !messages.is_empty() => {
                history = messages;
                if let Some(text) = final_text.as_ref() {
                    let already = history
                        .last()
                        .and_then(|m| m.get("content"))
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|last| last == text);
                    if !already {
                        history.push(
                            serde_json::json!({ "role": "assistant", "content": text.clone() }),
                        );
                    }
                }
            }
            _ => {
                if let Some(text) = final_text.as_ref() {
                    history
                        .push(serde_json::json!({ "role": "assistant", "content": text.clone() }));
                }
            }
        }
        match cli_save_thread(
            &agent_dir,
            thread_id.as_deref().or(save_as),
            &model,
            &history,
            None,
        ) {
            Ok(id) => {
                session_id = Some(id);
                saved = true;
            }
            Err(e) => eprintln!("(could not save session: {e})"),
        }
    }
    PersistedRun { session_id, final_text, saved }
}

/// This project's permission policy, as a document somebody can review
/// (AH-052).
pub fn cli_policy_export(
    project: &str,
) -> Result<
    tauri_plugin_agent_tools::policy_transfer::PolicyDocument,
    tauri_plugin_agent_tools::harness_error::HarnessError,
> {
    use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
    let root = resolve_project_root(project);
    // A project with no agent.toml runs under the default policy, so that is
    // the policy to export; only a file that exists and cannot be read is an
    // error.
    let path = crate::core::agent::project::agent_toml_path(&root);
    let config = if path.exists() {
        crate::core::agent::project::load_agent_config(&root).map_err(|e| {
            HarnessError::new(ErrorKind::MalformedState, format!("this project's configuration cannot be read: {e}"))
                .at(Stage::Startup)
        })?
    } else {
        crate::core::agent::project::AgentToml::default()
    };
    Ok(tauri_plugin_agent_tools::policy_transfer::export(
        config.tools.default.as_deref().unwrap_or("read-only"),
        &config.tools.allow,
        &config.tools.deny,
        &config.tools.allow_write,
    ))
}

/// Replace this project's permission policy with a reviewed document
/// (AH-052).
///
/// Refuses anything that would let the agent do more than it can now, unless
/// `accept_widening` says the caller has seen exactly what it opens.
pub fn cli_policy_import(
    project: &str,
    text: &str,
    accept_widening: bool,
) -> Result<
    tauri_plugin_agent_tools::policy_transfer::PolicyChange,
    tauri_plugin_agent_tools::harness_error::HarnessError,
> {
    use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
    use tauri_plugin_agent_tools::policy_transfer::{plan_import, to_toml, Widening};
    let current = cli_policy_export(project)?;
    let (document, change) = plan_import(
        &current,
        text,
        if accept_widening { Widening::Accept } else { Widening::Refuse },
    )?;
    if change.is_empty() {
        return Ok(change);
    }
    let root = resolve_project_root(project);
    let path = agent_dir_for(&root).join("agent.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let rewritten = crate::core::agent::project::replace_tools_section(&existing, &to_toml(&document));
    std::fs::create_dir_all(agent_dir_for(&root)).map_err(|e| {
        HarnessError::new(ErrorKind::Io, format!("the project's config directory is not writable: {e}"))
            .at(Stage::Persistence)
    })?;
    std::fs::write(&path, rewritten).map_err(|e| {
        HarnessError::new(ErrorKind::Io, format!("the policy could not be written: {e}"))
            .at(Stage::Persistence)
    })?;
    Ok(change)
}

/// Put `section` where the file's `[tools]` block was, keeping everything
/// else exactly as it is: a policy import must not rewrite a project's model,
/// budget or skills.
/// Send this run's canonical events somewhere as they happen (AH-183).
///
/// `-` is stdout, anything else a file that is created or truncated. The
/// events are the same envelopes the session's log holds, one JSON line each,
/// written as they are recorded rather than read back afterwards -- so a
/// caller watching a headless run sees it happen.
///
/// Fails before the run starts when the destination cannot be written: a run
/// whose output nobody can see is not what was asked for.
pub fn stream_events_to(
    destination: &str,
) -> Result<(), tauri_plugin_agent_tools::harness_error::HarnessError> {
    use std::io::Write;
    use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};

    let sink: std::sync::Arc<std::sync::Mutex<Box<dyn Write + Send>>> = if destination == "-" {
        std::sync::Arc::new(std::sync::Mutex::new(Box::new(std::io::stdout())))
    } else {
        let file = std::fs::File::create(destination).map_err(|e| {
            HarnessError::new(
                ErrorKind::Io,
                format!("the event stream could not be opened: {e}"),
            )
            .at(Stage::Startup)
        })?;
        std::sync::Arc::new(std::sync::Mutex::new(Box::new(file)))
    };
    tauri_plugin_agent_tools::event_log::watch(move |envelope| {
        let Ok(line) = serde_json::to_string(envelope) else {
            return;
        };
        if let Ok(mut out) = sink.lock() {
            // A stream nobody is reading any more must not fail the run: the
            // record is on disk either way.
            let _ = writeln!(out, "{line}");
            let _ = out.flush();
        }
    });
    Ok(())
}

/// The `init` handshake of a `--output-format stream-json` run, assembled from
/// the same parts the run itself uses: the session it saves under, the model it
/// dispatches to, and the tools its first turn will advertise, so the record
/// cannot describe a run other than this one.
async fn init_record(
    args: &OrchestrationArgs,
    session_id: &str,
    model: &str,
    input_format: InputFormat,
) -> Init {
    let tools: Vec<String> = crate::core::agent::r#loop::context_advertised_tools(
        &args.mcp_servers,
        &args.mcp_settings,
        &args.permissions,
        args.project_root.as_deref(),
        args.run_mode,
        args.subagents_enabled,
        args.max_parallel_subagents,
        args.ask_requests.is_some(),
        args.todo_registry.is_some(),
        &args.host_tools,
    )
    .await
    .iter()
    .filter_map(tool_name)
    .collect();
    // Only the host tools' schemas are echoed, not every advertised tool's: the
    // host is comparing these against what it sent, and a built-in's schema is
    // this process's own business.
    //
    // Filtered to what `tools` actually advertises rather than to everything
    // declared. A deny list, an allowlist or Plan mode can withhold a host tool,
    // and a host that saw its schema echoed anyway would conclude the tool was
    // live and wait for a call that is never coming. Echoing the advertised set
    // lets it detect the suppression instead.
    let tool_specs = args
        .host_tools
        .schemas()
        .into_iter()
        .filter(|spec| {
            tool_name(spec).is_some_and(|name| tools.iter().any(|t| t == &name))
        })
        .collect();
    // The project root the run's tools are confined to, as the run itself sees
    // it. A caller that built these args without one gets `null`: any path
    // substituted here would claim a confinement the run does not have.
    let cwd = args
        .project_root
        .as_deref()
        .map(|root| root.to_string_lossy().into_owned());
    // A run that does not read stdin accepts nothing, and says so: an empty
    // list is a client's answer that there is no reply path, which is more use
    // than an absent field or a list of kinds the run will ignore.
    let input_kinds = if input_format.is_stream_json() {
        INPUT_KINDS.to_vec()
    } else {
        Vec::new()
    };
    // The caps go with the kinds: a client that can send an image should learn
    // the limits from the handshake rather than by having a message rejected.
    let input_content_parts = input_format
        .is_stream_json()
        .then(InputContentParts::current);
    Init::new(
        session_id,
        model,
        cwd,
        tools,
        tool_specs,
        input_kinds,
        input_content_parts,
    )
}

/// A rendered tool schema's name, out of the OpenAI `{"type":"function",
/// "function":{"name":…}}` shape the advertised array carries.
fn tool_name(tool: &serde_json::Value) -> Option<String> {
    Some(tool.get("function")?.get("name")?.as_str()?.to_string())
}

/// Stop reason reported for a run the client ended with an `abort` message, and
/// the error the run itself returns -- never printed, since an abort exits 0.
const ABORTED_BY_CLIENT: &str = "aborted by client";

/// Drive the run against a duplex client: the orchestration loop's steering
/// handshake is answered from the queue the reader fills, and an `abort`
/// message drops the run. `None` is that abort.
///
/// Dropping the orchestration future is what stops the run, so anything it was
/// awaiting (an upstream request, a tool) is cancelled where it stands; a child
/// process a `bash` call had already spawned outlives it, as it does on the
/// TUI's cancel path.
async fn run_steered(
    tx: &mpsc::UnboundedSender<StreamEvent>,
    body: &serde_json::Value,
    args: &OrchestrationArgs,
    input: &Arc<StreamInput>,
) -> Option<Result<serde_json::Value, tauri_plugin_agent_tools::harness_error::HarnessError>> {
    let (steering_tx, mut steering_rx) = mpsc::unbounded_channel::<SteeringRequest>();
    let queue = Arc::clone(input);
    let steerer = tokio::spawn(async move {
        while let Some(request) = steering_rx.recv().await {
            // Empty is the normal answer: the loop asks at every turn boundary.
            let _ = request.reply.send(queue.take_queued());
        }
    });
    let outcome = tokio::select! {
        result = run_orchestration_steered(tx, body, args, Some(&steering_tx)) => Some(result),
        _ = input.aborted() => {
            // A host still holding a request must be told to drop it: the run
            // it would answer is gone. Released here, not by the reader, so
            // the records land before `done` and cannot race the reader's
            // shutdown; `cancel_all` rather than `strand_all` so a child still
            // awaiting one is told it was cancelled, not that the host left.
            for id in crate::core::agent::host_tools::cancel_all(&args.host_tool_requests).await {
                let _ = tx.send(request_cancelled(&id, CANCEL_ABORTED));
            }
            // The loop emits its own terminal event; an abort pre-empts it, so
            // the report is given one here or it would read as a clean stop.
            let _ = tx.send(StreamEvent::Done {
                stop_reason: "aborted".to_string(),
                usage: None,
            });
            None
        }
    };
    steerer.abort();
    outcome
}

/// Run one durable subagent from its spec (AH-101). Started by a job
/// supervisor as `flint cli agent run-subagent --spec <file>`; its answer is what
/// it prints, which the supervisor keeps as the job's output.
///
/// Configured exactly as an in-process child is (`configure_child_args`,
/// `child_body`). Nobody is attached to answer a permission prompt, so every
/// prompt is denied and said so on stderr: a durable child does only what its
/// project's rules already allow.
pub async fn run_durable_subagent(
    spec_file: &std::path::Path,
) -> Result<(), tauri_plugin_agent_tools::harness_error::HarnessError> {
    use crate::core::agent::subagent::{self as sub, SubagentRegistry, SubagentRequest};
    use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};

    let spec = crate::core::agent::durable_subagent::read_spec(spec_file)?;
    // The data folder the parent uses: its providers, and where the record of
    // this run belongs. Set before anything reads it.
    if !spec.data_folder.is_empty() {
        std::env::set_var("JAN_DATA_FOLDER", &spec.data_folder);
    }
    let session = prepare_agent_session(
        &spec.project,
        Some(spec.model.clone()),
        ProviderOverrides::default(),
        SessionFlags {
            require_model: true,
            ..Default::default()
        },
        None,
    )
    .map_err(|e| HarnessError::new(ErrorKind::InvalidInput, e).at(Stage::Startup))?;
    let AgentSession {
        mut args,
        permission_requests,
        mcp_task,
        ..
    } = session;
    args.session_id = Some(spec.session.clone());
    args.parent_run = (!spec.parent_run.is_empty()).then(|| spec.parent_run.clone());
    let project_root = args
        .project_root
        .clone()
        .ok_or_else(|| HarnessError::new(ErrorKind::InvalidInput, "no project").at(Stage::Startup))?;
    let registry = SubagentRegistry::load(&project_root);
    let request = SubagentRequest {
        subagent_name: spec.subagent_name.clone(),
        description: spec.description.clone(),
        allowed_tools: spec.allowed_tools.clone(),
        system_prompt: spec.system_prompt.clone(),
        isolate: Some(false),
        fork_context: false,
        durable: true,
        max_turns: spec.max_turns,
        title: None,
    };
    let resolved = sub::resolve_dispatch(&registry, &request, &args.permissions)
        .map_err(|e| HarnessError::new(ErrorKind::InvalidInput, e.to_string()).at(Stage::Child))?;
    let child_args = sub::configure_child_args(args, &resolved, &spec.dispatch_id);
    let parent = sub::ParentRun {
        routing: Vec::new(),
        conversation: None,
        model: spec.model.clone(),
        budget_remaining: spec.max_session_tokens,
        send_reasoning: spec.send_reasoning,
        model_settings: sub::load_model_settings(),
    };
    let mut body = sub::child_body(&resolved, &spec.description, &parent, None, spec.max_turns);
    if spec.max_turns.is_none() {
        // A durable job that asked for no limit is unbounded, as it always was.
        body["max_turns"] = serde_json::json!(0);
    }
    // Routed when it was dispatched; the child runs what its parent chose.
    body["model"] = serde_json::json!(spec.model);

    if let Some(task) = mcp_task {
        let _ = task.await;
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();
    let registry = permission_requests.clone();
    let drain = tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if let StreamEvent::PermissionRequest {
                request_id,
                tool_name,
                ..
            } = ev
            {
                eprintln!("(durable subagent: {tool_name} needs approval and nobody is attached to give it; denied)");
                if let Some(sender) = registry.lock().await.remove(&request_id) {
                    let _ = sender.send(PermissionDecision::Deny);
                }
            }
        }
    });
    let result =
        crate::core::agent::r#loop::run_orchestration_streamed(&tx, &body, &child_args).await;
    drop(tx);
    let _ = drain.await;
    match result {
        Ok(completion) => {
            println!("{}", sub::final_assistant_text(&completion));
            Ok(())
        }
        Err(e) => Err(HarnessError::new(ErrorKind::ChildFailed, e.message().to_string()).at(Stage::Child)),
    }
}
/// `tool_request_cancelled` reasons this surface raises: the client stopped the
/// run, or it can no longer answer (stdin closed).
const CANCEL_ABORTED: &str = "aborted";
const CANCEL_CLIENT_GONE: &str = "client_gone";

fn request_cancelled(request_id: &str, reason: &str) -> StreamEvent {
    StreamEvent::ToolRequestCancelled {
        request_id: request_id.to_string(),
        reason: reason.to_string(),
    }
}

/// What a client line asks the reader to do next.
#[derive(Debug, PartialEq, Eq)]
enum InputFlow {
    Continue,
    /// A permission request was answered; the id and decision are echoed on the
    /// stream so it stays a complete account of the run.
    Decided(String, PermissionDecision),
    /// An `abort`: stop reading, the run is ending.
    Stop,
}

/// The registries a client line can resolve against.
struct InputTargets<'a> {
    permissions: &'a PermissionRegistry,
    host_tools: &'a crate::core::agent::host_tools::HostToolRegistry,
}

/// Apply one client line. `Err` is the message reported back to the client; it
/// is never fatal, since this is a peer process's output and one malformed line
/// must not cost the work already done.
async fn apply_input_line(
    line: &str,
    input: &StreamInput,
    targets: &InputTargets<'_>,
) -> Result<InputFlow, String> {
    let registry = targets.permissions;
    match parse_input_line(line)? {
        InputMessage::User(text) => {
            input.queue_user(text);
            Ok(InputFlow::Continue)
        }
        InputMessage::UserParts(parts) => {
            input.queue_user_parts(parts);
            Ok(InputFlow::Continue)
        }
        InputMessage::Abort => {
            input.abort();
            Ok(InputFlow::Stop)
        }
        InputMessage::Permission {
            request_id,
            decision,
        } => {
            // Taking the sender is what makes a decision single-use: a second
            // reply for the same id finds nothing and is reported, rather than
            // silently overwriting an answer the run already acted on.
            let sender = registry.lock().await.remove(&request_id);
            let Some(sender) = sender else {
                return Err(format!("no permission request '{request_id}' is pending"));
            };
            let _ = sender.send(decision);
            Ok(InputFlow::Decided(request_id, decision))
        }
        InputMessage::ToolResult { request_id, result } => {
            // Same single-use rule as a permission decision, and the same
            // reason: the run has already fed this answer to the model, so a
            // second one cannot be applied and must be reported rather than
            // silently dropped.
            crate::core::agent::host_tools::respond(targets.host_tools, &request_id, Ok(result))
                .await?;
            Ok(InputFlow::Continue)
        }
    }
}

/// One line from the client, bounded.
struct ClientLine {
    text: String,
    /// True when the line went past [`MAX_LINE_BYTES`] and was cut: `text` is
    /// then the echo-sized prefix, and the line is rejected without being
    /// parsed.
    oversized: bool,
}

/// Client lines, read on a detached OS thread.
///
/// Not `tokio::io::stdin`: that parks the read on the runtime's blocking pool,
/// which shutdown waits for, so a client that keeps stdin open -- which is what
/// a duplex client does for the whole run -- leaves the process alive after its
/// terminal record has been printed. A plain thread dies with the process.
///
/// The read is bounded rather than line-at-a-time: a line is only as long as
/// the client says it is, and `BufRead::lines` would hold whatever arrives in
/// memory before the cap could be applied to it.
fn stdin_lines() -> mpsc::UnboundedReceiver<ClientLine> {
    let (tx, rx) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        let mut reader = std::io::stdin().lock();
        while let Ok(Some(line)) = read_bounded_line(&mut reader) {
            if tx.send(line).is_err() {
                return;
            }
        }
    });
    rx
}

/// Read one line, keeping at most [`MAX_LINE_BYTES`] of it and discarding the
/// rest rather than growing to hold it.
///
/// A line over the cap keeps only its first [`MAX_ECHO_BYTES`]: it can never be
/// parsed, so the only use its bytes have left is the echo in `input_error`.
/// Cutting there can split a character, which is why the kept bytes go through
/// `from_utf8_lossy` -- the echo is for a human, and a line that is over the cap
/// is already being refused.
fn read_bounded_line<R: std::io::BufRead>(
    reader: &mut R,
) -> std::io::Result<Option<ClientLine>> {
    let mut bytes: Vec<u8> = Vec::new();
    let mut oversized = false;
    let mut saw_any = false;
    loop {
        let available = match reader.fill_buf()? {
            [] => break,
            buf => buf,
        };
        saw_any = true;
        let newline = available.iter().position(|b| *b == b'\n');
        let take = newline.map_or(available.len(), |i| i + 1);
        if !oversized {
            let room = MAX_LINE_BYTES.saturating_sub(bytes.len());
            if take <= room {
                bytes.extend_from_slice(&available[..take]);
            } else {
                bytes.truncate(MAX_ECHO_BYTES.min(bytes.len()));
                oversized = true;
            }
        }
        reader.consume(take);
        if newline.is_some() {
            break;
        }
    }
    if !saw_any {
        return Ok(None);
    }
    while matches!(bytes.last(), Some(b'\n') | Some(b'\r')) {
        bytes.pop();
    }
    Ok(Some(ClientLine {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        oversized,
    }))
}

/// Consume client messages until `abort` or end of input.
///
/// End of input is not an abort: a client that has said everything it means to
/// say may close the pipe and still want its answer. It *is* the end of the
/// only thing that can answer a permission request or run a host tool, though,
/// so the exit is latched and anything already waiting is released -- see
/// [`strand_pending_permissions`] and
/// [`crate::core::agent::host_tools::strand_all`]. Each released host request
/// is reported on `events` as `tool_request_cancelled`.
///
/// An `abort` leaves the host requests alone: the run's abort path withdraws
/// them itself, as `aborted` rather than `client_gone`.
async fn read_input_lines(
    mut lines: mpsc::UnboundedReceiver<ClientLine>,
    input: Arc<StreamInput>,
    registry: PermissionRegistry,
    host_tools: crate::core::agent::host_tools::HostToolRegistry,
    events: mpsc::UnboundedSender<StreamEvent>,
    format: OutputFormat,
) {
    let targets = InputTargets {
        permissions: &registry,
        host_tools: &host_tools,
    };
    let mut aborted = false;
    while let Some(line) = lines.recv().await {
        if line.oversized {
            report_input_error(
                format,
                &format!("line is over the {MAX_LINE_BYTES} byte cap"),
                &line.text,
            );
            continue;
        }
        let line = line.text;
        if line.trim().is_empty() {
            continue;
        }
        match apply_input_line(&line, &input, &targets).await {
            Ok(InputFlow::Continue) => {}
            Ok(InputFlow::Decided(request_id, decision)) => {
                if format.is_stream_json() {
                    print_json_line(&PermissionDecisionRecord::new(&request_id, decision));
                }
            }
            Ok(InputFlow::Stop) => {
                aborted = true;
                break;
            }
            Err(message) => report_input_error(format, &message, &line),
        }
    }
    // Latch first: a request raised between the drain and the latch would
    // otherwise be recorded as the client's to answer and find no reader.
    input.mark_client_gone();
    strand_pending_permissions(&registry, format).await;
    if aborted {
        return;
    }
    // A host tool call cannot be answered by anyone else, so a parked turn is
    // released with a typed failure rather than waiting on a dead pipe.
    for id in crate::core::agent::host_tools::strand_all(&host_tools).await {
        let _ = events.send(request_cancelled(&id, CANCEL_CLIENT_GONE));
    }
}

/// Name the follow-ups the run ended before reaching. Queued turns are joined
/// at a turn boundary, so a run that stops first (abort, error, or an answer
/// the model considered final) never consumes them; reported one by one, since
/// the text is what the client needs to decide whether to send it again.
fn report_dropped_follow_ups(input: &StreamInput, format: OutputFormat) {
    for turn in input.take_queued() {
        // The text, whether it arrived as a string or as content parts: an
        // image-only follow-up reads as empty here, which is all this report
        // needs to say about it.
        let text = crate::core::cli::user_message::text_of_content(&turn["content"]);
        report_input_error(format, "run ended before this follow-up was read", &text);
    }
}

/// Release every request still waiting on a client that has gone. Dropping the
/// sender is what resolves the run's `rx.await` to `Deny`, so the run declines
/// the call and finishes with its result envelope rather than parking forever.
/// The decision is echoed for the same reason a client-sent one is: the stream
/// stays a complete account of what the run did.
async fn strand_pending_permissions(registry: &PermissionRegistry, format: OutputFormat) {
    let stranded: Vec<String> = registry.lock().await.drain().map(|(id, _)| id).collect();
    for request_id in stranded {
        if format.is_stream_json() {
            print_json_line(&PermissionDecisionRecord::new(
                &request_id,
                PermissionDecision::Deny,
            ));
        } else {
            eprintln!(
                "{}",
                color::paint(
                    "33",
                    format_args!(
                        "[permission] auto-denied '{request_id}' (client closed stdin)",
                    ),
                ),
            );
        }
    }
}

fn spawn_input_reader(
    input: Arc<StreamInput>,
    registry: PermissionRegistry,
    host_tools: crate::core::agent::host_tools::HostToolRegistry,
    events: mpsc::UnboundedSender<StreamEvent>,
    format: OutputFormat,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(read_input_lines(
        stdin_lines(),
        input,
        registry,
        host_tools,
        events,
        format,
    ))
}

/// Tell the client its line was rejected, on whichever stream it is reading.
fn report_input_error(format: OutputFormat, message: &str, line: &str) {
    if format.is_stream_json() {
        print_json_line(&InputErrorRecord::new(message, line));
    } else {
        eprintln!("{}", color::paint("33", format_args!("[input] {message}")));
    }
}

/// Write the result envelope to stdout, the last thing either machine format
/// puts there. `json` pretty-prints it -- those are read by people at least as
/// often as by programs, and `jq` does not care either way -- while
/// `stream-json` must keep it to the one line its contract promises.
fn print_report(format: OutputFormat, report: run_report::RunResult) {
    if format.is_stream_json() {
        print_json_line(&report);
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).unwrap_or_default()
        );
    }
}

/// Write one NDJSON record and flush it, so a consumer reading the pipe sees
/// the event as it happens rather than when the block buffer fills.
fn print_json_line<T: serde::Serialize>(value: &T) {
    let Some(line) = ndjson_line(value) else {
        return;
    };
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(line.as_bytes());
    let _ = out.flush();
}

/// Answer a permission request without printing progress, for the machine
/// formats. Leaving it unanswered would wedge the run: the loop waits on the
/// reply. Returns the decision so `stream-json` can report it; with no TTY
/// `prompt_permission` denies rather than blocking on a terminal nobody is at.
async fn resolve_permission_silently(
    ev: StreamEvent,
    registry: &PermissionRegistry,
    duplex: bool,
) -> Option<(String, PermissionDecision)> {
    let StreamEvent::PermissionRequest {
        request_id,
        tool_name,
        capability,
        path,
        command,
        ..
    } = ev
    else {
        return None;
    };
    // With a client on stdin the decision is its call; answering here would
    // race the reply already on its way.
    if duplex {
        return None;
    }
    let detail = command
        .map(|c| format!(" ({c})"))
        .or_else(|| path.map(|p| format!(" on {p}")))
        .unwrap_or_default();
    let decision = prompt_permission(tool_name, capability, detail).await;
    if let Some(sender) = registry.lock().await.remove(&request_id) {
        let _ = sender.send(decision);
    }
    Some((request_id, decision))
}

/// Assistant text of a chat-completion response, if any.
fn completion_text(completion: &serde_json::Value) -> Option<String> {
    let text = completion
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")
        .and_then(|v| v.as_str())?;
    (!text.is_empty()).then(|| text.to_string())
}

/// Launch the interactive chat console (bare `jan`). An optional `task`
/// seeds the first turn; otherwise the user types the first message. Shares the
/// engine with `run_agent_loop` via `AgentSession` — only presentation differs.
#[allow(clippy::too_many_arguments)]
pub async fn cli_agent_ui(
    project: &str,
    task: Option<String>,
    model: Option<String>,
    images: Vec<String>,
    overrides: ProviderOverrides,
    flags: SessionFlags,
    resume: Option<ResumeRequest>,
) -> Result<(), String> {
    let project_root = resolve_project_root(project);
    // A non-interactive invocation with nothing configured has no terminal to
    // show the sign-in notice in, so it fails fast with instructions instead.
    // Bypassed by an explicit --api-key/env key.
    if overrides.api_key.is_none() {
        login::reject_headless_without_provider(Some(&project_root))?;
    }
    // Fresh install with a terminal attached: launch with no model rather than
    // forcing sign-in here. The TUI shows a one-line notice and `/login` (or
    // `flint login`) picks a model up once the user is ready.
    let session = prepare_agent_session(
        project,
        model,
        overrides,
        SessionFlags {
            require_model: false,
            ..flags
        },
        resume.as_ref(),
    )?;
    // TUI threads persist under the project's .jan/agent dir, separate from the
    // desktop store, so continuing here never mutates desktop threads.
    let agent_dir = agent_dir_for(&project_root);
    tui::run(session, agent_dir, project_root, task, images, resume).await
}

/// Where the TUI persists a project's threads (`<project>/.jan/agent`).
pub fn agent_dir_for(project_root: &std::path::Path) -> PathBuf {
    project_root.join(".jan").join("agent")
}

/// Render one `StreamEvent` for the terminal. Content tokens go to stdout so a
/// run can be piped; progress/diagnostics go to stderr. `PermissionRequest` is
/// resolved via the terminal (deny when non-interactive).
/// How much a headless run says about itself (AH-181).
///
/// The answer on stdout never changes: a piped run yields exactly the model's
/// completion at every density. What changes is the progress on stderr, which
/// is what a person reads while waiting and what a log keeps afterwards -- and
/// those two want different amounts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Density {
    /// One line per tool call, errors, and the answer. No reasoning, no live
    /// command output, no turn markers, no tool results.
    Compact,
    /// What a run has always printed.
    #[default]
    Normal,
    /// Everything Normal prints, plus each turn's token usage as the provider
    /// reported it.
    Verbose,
}

impl Density {
    /// Read a declared density. Anything else is refused rather than quietly
    /// treated as the default, which would be a run that says less than
    /// somebody asked it to.
    pub fn parse(text: &str) -> Result<Self, String> {
        match text.trim().to_ascii_lowercase().as_str() {
            "compact" | "quiet" => Ok(Density::Compact),
            "normal" | "" => Ok(Density::Normal),
            "verbose" => Ok(Density::Verbose),
            other => Err(format!(
                "{other:?} is not an output density; use compact, normal or verbose"
            )),
        }
    }
}

async fn print_event(
    ev: StreamEvent,
    registry: &PermissionRegistry,
    density: Density,
    duplex: bool,
) {
    if crate::core::cli::auth::account::take_claude_alias_engaged() {
        eprintln!(
            "{}",
            color::paint(
                "33",
                format_args!(
                    "[warning] {}",
                    crate::core::cli::auth::account::CLAUDE_ALIAS_NOTICE,
                ),
            ),
        );
    }
    match ev {
        // AH-078. The snapshot is already written to the data folder by the
        // dispatcher; this event only says one exists. Headless stdout is the
        // model's completion and nothing else, and the payload is never printed
        // anywhere -- reading a snapshot back is `jan snapshots`, which serves
        // the redacted record. Matched explicitly rather than through a
        // wildcard so a new event still fails this build instead of vanishing.
        StreamEvent::PromptSnapshot { .. } => {}
        // Provenance is machine-facing: an identity record for a harness, not
        // something to draw. The stream-json writer serializes the event itself.
        StreamEvent::RequestProvenance { .. } => {}
        StreamEvent::Token { text } => {
            print!("{text}");
            let _ = std::io::stdout().flush();
        }
        // A command's live output is progress, not answer: it goes to stderr so a
        // piped stdout still holds only the model's completion. The full output
        // arrives again with the tool result, which is what the model sees; this
        // is purely so a long command is not silent in a headless run.
        StreamEvent::ToolOutputDelta { delta, .. } => {
            // Live command output is the noisiest thing a run produces, and
            // the whole of it arrives again with the tool result.
            if density != Density::Compact {
                eprint!("{}", color::paint("2", format_args!("{delta}")));
                let _ = std::io::stderr().flush();
            }
        }
        // Reasoning is progress, not answer: dimmed on stderr so piping stdout
        // yields only the real completion.
        StreamEvent::Reasoning { text } => {
            if density != Density::Compact {
                eprint!("{}", color::paint("2", format_args!("{text}")));
                let _ = std::io::stderr().flush();
            }
        }
        StreamEvent::Step { index, max } => {
            if density != Density::Compact {
                match max {
                    0 => eprintln!("\n{}", color::paint("2", format_args!("[turn {index}]"))),
                    m => eprintln!("\n{}", color::paint("2", format_args!("[turn {index}/{m}]"))),
                }
            }
        }
        // In-progress signal is for the live TUI; the piped log stays quiet
        // until the full call (with args) arrives just below.
        // Headless prints one line per completed call; the in-progress signal
        // and its argument deltas have nothing to render into.
        StreamEvent::ToolCallStarted { .. } | StreamEvent::ToolCallArgsDelta { .. } => {}
        // Headless reports totals once, from the terminal `Done` -- unless the
        // run was asked to say more, in which case each turn's own numbers are
        // worth having, because a total hides which turn was expensive.
        StreamEvent::TurnUsage { usage, .. } => {
            if density == Density::Verbose {
                let (input, output, total) = (
                    usage.prompt_tokens.unwrap_or(0),
                    usage.completion_tokens.unwrap_or(0),
                    usage.total_tokens.unwrap_or(0),
                );
                eprintln!(
                    "{}",
                    color::paint(
                        "2",
                        format_args!(
                            "[turn-usage] in={input} out={output} total={total}",
                        ),
                    ),
                );
            }
        }
        StreamEvent::ToolCall { name, args, .. } => eprintln!(
            "{}",
            color::paint(
                "2",
                format_args!(
                    "[tool] {}",
                    crate::core::agent::events::describe_tool_call(&name, &args),
                ),
            ),
        ),
        StreamEvent::ToolResult {
            content, is_error, ..
        } => {
            let tag = if is_error {
                "tool-error"
            } else {
                "tool-result"
            };
            // A failure is never quiet: a compact run drops results, not the
            // news that something did not work.
            if density != Density::Compact || is_error {
                eprintln!("{}", color::paint("2", format_args!("[{tag}] {content}")));
            }
        }
        StreamEvent::SubagentStart { name, .. } => {
            eprintln!("{}", color::paint("2", format_args!("[subagent:{name}] started (background)")))
        }
        StreamEvent::SubagentQueued { name, waiting, .. } => {
            eprintln!("{}", color::paint("2", format_args!("[subagent:{name}] queued ({waiting} waiting)")))
        }
        StreamEvent::SubagentTitle { name, title, .. } => {
            eprintln!("{}", color::paint("2", format_args!("[subagent:{name}] {title}")))
        }
        StreamEvent::SubagentEnd { name, .. } => {
            eprintln!("{}", color::paint("2", format_args!("[subagent:{name}] finished")))
        }
        StreamEvent::SubagentFinished { name, status, usage, .. } => {
            let tokens = usage
                .as_ref()
                .and_then(|u| u.get("total_tokens"))
                .and_then(|t| t.as_u64())
                .filter(|t| *t > 0);
            let note = match (status.as_str(), tokens) {
                ("turn_limit", _) => " stopped at its turn limit".to_string(),
                ("error", _) => " failed".to_string(),
                (_, Some(t)) => format!(" used {t} tokens"),
                _ => String::new(),
            };
            if !note.is_empty() {
                eprintln!("{}", color::paint("2", format_args!("[subagent:{name}]{note}")));
            }
        }
        StreamEvent::Subagent { name, event, .. } => {
            if let StreamEvent::ToolCall {
                name: tool, args, ..
            } = *event
            {
                eprintln!(
                    "{}",
                    color::paint(
                        "2",
                        format_args!(
                            "[subagent:{name}] {}",
                            crate::core::agent::events::describe_tool_call(&tool, &args),
                        ),
                    ),
                );
            }
        }
        // AH-174: progress, not answer -- stderr, and only when something ran.
        StreamEvent::RunResources { resources } => {
            if density != Density::Compact {
                let figures = if resources.measured_commands > 0 {
                    format!(
                        "CPU {} ms, peak memory {} bytes, {} processes",
                        resources.cpu_ms, resources.peak_memory_bytes, resources.processes
                    )
                } else {
                    format!(
                        "not measured: {}",
                        resources.unmeasured_reason.as_deref().unwrap_or("unknown")
                    )
                };
                eprintln!(
                    "{}",
                    color::paint(
                        "2",
                        format_args!(
                            "[resources] {figures} ({} of {} commands measured)",
                            resources.measured_commands, resources.commands
                        ),
                    ),
                );
            }
        }
        StreamEvent::Done { stop_reason, usage } => {
            let tokens = usage.and_then(|u| u.total_tokens).unwrap_or(0);
            eprintln!("\n{}", color::paint("2", format_args!("[done] stop_reason={stop_reason} tokens={tokens}")));
        }
        StreamEvent::Error { code, message } => {
            // AH-009: the event already carries the classification, so the
            // line says what kind of failure it was once, and a cancellation
            // does not read as a crash.
            if code == "cancelled" {
                eprintln!("\n{}", color::paint("2", format_args!("[stopped] {message}")));
            } else {
                eprintln!("\n{}", color::paint("31", format_args!("[error:{code}] {message}")));
            }
        }
        StreamEvent::AskRequest { .. } => {
            eprintln!("\n{}", color::paint("31", format_args!("[error] interactive ask requires `flint agent ui`")))
        }
        // Headless never renders an ask prompt, so there is nothing to dismiss.
        StreamEvent::AskResolved { .. } => {}
        // The non-interactive CLI doesn't persist session state; a todo update
        // is silently dropped here (mirrors MessagesUpdated below).
        StreamEvent::TodoUpdate { .. } => {}
        // The non-interactive CLI doesn't persist session state, so
        // MessagesUpdated is a no-op here.
        StreamEvent::MessagesUpdated { .. } => {}
        StreamEvent::PermissionRequest {
            request_id,
            tool_name,
            capability,
            path,
            command,
            diff,
            reason,
            ..
        } => {
            // Why a call auto-approval would have run is being asked about.
            if let Some(reason) = &reason {
                eprintln!("{}", color::paint("33", format_args!("[permission] {reason}")));
            }
            let detail = command
                .map(|c| format!(" ({c})"))
                .or_else(|| path.map(|p| format!(" on {p}")))
                .unwrap_or_default();
            if let Some(diff) = diff {
                eprintln!("{}", color::paint("2", format_args!("{diff}")));
            }
            if duplex {
                eprintln!(
                    "{}",
                    color::paint(
                        "33",
                        format_args!(
                            "[permission] {capability} via '{tool_name}'{detail} - awaiting '{request_id}' on stdin",
                        ),
                    ),
                );
                return;
            }
            let decision = prompt_permission(tool_name, capability, detail).await;
            if let Some(sender) = registry.lock().await.remove(&request_id) {
                let _ = sender.send(decision);
            }
        }
        // Only a host process can answer this, and only over the duplex
        // channel; a text-format run cannot declare host tools at all (the
        // flag requires stream-json both ways), so this is diagnostics only.
        StreamEvent::ToolRequest {
            request_id,
            tool_name,
            ..
        } => {
            eprintln!(
                "{}",
                color::paint(
                    "33",
                    format_args!("[host tool] '{tool_name}' - awaiting '{request_id}' on stdin"),
                ),
            );
        }
        StreamEvent::ToolRequestCancelled { request_id, reason } => {
            eprintln!(
                "{}",
                color::paint("2", format_args!("[host tool] '{request_id}' cancelled ({reason})")),
            );
        }
        // Structured data for a host's own display; text output has none.
        StreamEvent::ToolDetails { .. } => {}
    }
}

/// Ask the terminal to approve a gated tool call. Non-interactive stdin (pipe,
/// CI) auto-denies, matching the headless "safe default" contract; blocking
/// stdin is confined to a blocking thread so the loop task keeps running.
async fn prompt_permission(
    tool_name: String,
    capability: String,
    detail: String,
) -> PermissionDecision {
    use std::io::IsTerminal;
    if !std::io::stdin().is_terminal() {
        eprintln!("{}", color::paint("33", format_args!("[permission] auto-denied {capability} via '{tool_name}' (non-interactive)")));
        return PermissionDecision::Deny;
    }
    tokio::task::spawn_blocking(move || {
        eprint!("{}", color::paint("33", format_args!("[permission] allow {capability} via '{tool_name}'{detail}? [y/N] ")));
        let _ = std::io::stderr().flush();
        let mut line = String::new();
        if std::io::stdin().read_line(&mut line).is_err() {
            return PermissionDecision::Deny;
        }
        match line.trim().to_ascii_lowercase().as_str() {
            "y" | "yes" => PermissionDecision::AllowOnce,
            _ => PermissionDecision::Deny,
        }
    })
    .await
    .unwrap_or(PermissionDecision::Deny)
}

#[cfg(test)]
mod tests {
    #[test]
    fn permission_modes_map_to_the_two_switches() {
        assert_eq!(PermissionMode::resolve(None, false, false), Ok((true, false)));
        assert_eq!(PermissionMode::resolve(None, true, true), Ok((false, true)));
        assert_eq!(PermissionMode::resolve(Some("ask"), false, false), Ok((false, false)));
        assert_eq!(PermissionMode::resolve(Some("Auto"), false, false), Ok((true, false)));
        assert_eq!(PermissionMode::resolve(Some("bypass"), false, false), Ok((true, false)));
        assert_eq!(PermissionMode::resolve(Some("review"), false, false), Ok((false, true)));
        assert!(PermissionMode::resolve(Some("ask"), true, false).is_err());
        assert!(PermissionMode::resolve(Some("nope"), false, false).is_err());
        assert_eq!(PermissionMode::parse("review").unwrap().as_str(), "review");
    }

    /// #200: every colored line goes through `color::paint`, so NO_COLOR and
    /// non-terminal stderr are honored. Neither source may hold an SGR
    /// sequence of its own, whether escaped or as a raw ESC character.
    #[test]
    fn cli_sources_hold_no_raw_escape_sequences() {
        let escaped = concat!("\\", "x1b[");
        for (name, src) in [
            ("core/cli/mod.rs", include_str!("mod.rs")),
            ("bin/flint.rs", include_str!("../../bin/flint.rs")),
        ] {
            assert!(!src.contains(escaped), "{name} writes an escape sequence directly");
            assert!(!src.contains('\u{1b}'), "{name} holds a raw ESC character");
        }
    }

    /// #143: deleting a thread drops its snapshot ref in the repository the
    /// thread recorded, not only the scratch index.
    #[test]
    fn deleting_a_thread_drops_its_snapshot_ref() {
        use crate::core::agent::git;
        let git_in = |dir: &std::path::Path, args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .output()
                .expect("git");
            assert!(out.status.success(), "git {args:?}: {out:?}");
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let repo = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        git_in(repo.path(), &["init", "-q"]);
        // The empty tree (stdin is empty), written so commit-tree can use it.
        let tree = git_in(repo.path(), &["hash-object", "-t", "tree", "-w", "--stdin"]);
        let sha = git_in(
            repo.path(),
            &[
                "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
                "commit-tree", &tree, "-m", "s",
            ],
        );
        let id = "cli-delete-drops-ref";
        git::update_ref(repo.path(), id, &sha).unwrap();
        let reference = git::snapshot_ref(id);
        git_in(repo.path(), &["rev-parse", "--verify", &reference]);

        let meta_path = super::get_thread_metadata_path(data.path(), id);
        std::fs::create_dir_all(meta_path.parent().unwrap()).unwrap();
        std::fs::write(
            &meta_path,
            serde_json::json!({
                "id": id,
                "metadata": { super::SNAPSHOT_REPO_KEY: repo.path().to_string_lossy() },
            })
            .to_string(),
        )
        .unwrap();

        super::delete_thread_at(data.path(), id).unwrap();

        let still = std::process::Command::new("git")
            .args(["rev-parse", "--verify", "--quiet", &reference])
            .current_dir(repo.path())
            .output()
            .unwrap();
        assert!(!still.status.success(), "snapshot ref survived the delete");
        assert!(!meta_path.exists());
    }

    /// AH-181: a declared density is read, and anything that is not one is
    /// refused rather than quietly treated as the default -- a run that says
    /// less than somebody asked it to is a run whose log is missing what they
    /// wanted to read.
    #[test]
    fn an_output_density_is_read_or_refused_by_name() {
        use super::Density;
        assert_eq!(Density::parse("compact"), Ok(Density::Compact));
        assert_eq!(Density::parse(" QUIET "), Ok(Density::Compact));
        assert_eq!(Density::parse("normal"), Ok(Density::Normal));
        // Unset in a config file reads as the default rather than as an error.
        assert_eq!(Density::parse(""), Ok(Density::Normal));
        assert_eq!(Density::parse("verbose"), Ok(Density::Verbose));
        assert_eq!(Density::default(), Density::Normal);

        let err = Density::parse("loud").unwrap_err();
        assert!(err.contains("not an output density"), "{err}");
        assert!(err.contains("compact, normal or verbose"), "{err}");
    }

    /// A headless run's conversation survives being saved and resumed, tool
    /// calls and all.
    ///
    /// This is what stops a resumed turn showing the model a transcript in
    /// which it described work and never called a tool -- an example of the
    /// wrong behaviour, which a model will imitate. Observed against a real
    /// provider before the run's conversation was persisted: the model
    /// narrated tool calls it had not made and reported their results.
    #[test]
    fn a_resumed_turn_still_shows_the_model_the_tools_it_ran() {
        let base = std::env::temp_dir().join(format!(
            "flint-cli-resume-tools-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        // What the loop publishes: the prompt, the call, its result, the answer.
        let conversation = vec![
            serde_json::json!({ "role": "user", "content": "how many files?" }),
            serde_json::json!({
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": { "name": "ls", "arguments": "{\"path\":\".\"}" }
                }]
            }),
            serde_json::json!({ "role": "tool", "tool_call_id": "call_1", "content": "a.py b.py" }),
            serde_json::json!({ "role": "assistant", "content": "Two." }),
        ];
        let id = cli_save_thread(&base, None, "m", &conversation, None).expect("saved");

        let resumed = load_resume_history(&base, &ResumeRequest::resume(ResumeTarget::Id(id.clone())))
            .expect("the thread resumes");
        let roles: Vec<&str> = resumed
            .history
            .iter()
            .filter_map(|m| m.get("role").and_then(|v| v.as_str()))
            .collect();
        assert_eq!(
            roles,
            ["user", "assistant", "tool", "assistant"],
            "the resumed history is not the conversation: {roles:?}"
        );
        let call = resumed
            .history
            .iter()
            .find(|m| m.get("tool_calls").is_some())
            .expect("the assistant's tool call survived");
        assert_eq!(call["tool_calls"][0]["function"]["name"], "ls");
        let result = resumed
            .history
            .iter()
            .find(|m| m.get("role").and_then(|v| v.as_str()) == Some("tool"))
            .expect("the tool's result survived");
        assert_eq!(result["tool_call_id"], "call_1");
        assert_eq!(result["content"], "a.py b.py");
        let _ = std::fs::remove_dir_all(&base);
    }

    use super::*;

    /// The duplex channel end to end over a pipe: a follow-up is queued for the
    /// steering handshake, a permission reply reaches the waiting run, a
    /// malformed line is survivable, and `abort` stops the reader.
    ///
    /// Driven through `read_input_lines` rather than the built binary because a
    /// cargo test cannot own process stdin; the binary is exercised by hand.
    #[tokio::test]
    async fn a_duplex_client_steers_answers_and_aborts_over_one_pipe() {
        let input = Arc::new(StreamInput::default());
        let registry: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
        let (answer_tx, answer) = tokio::sync::oneshot::channel();
        registry.lock().await.insert("perm-1".to_string(), answer_tx);

        let script = [
            r#"{"type":"user","text":"also check the tests"}"#,
            "   ",
            "{ not json",
            r#"{"type":"permission","request_id":"perm-1","decision":"allow_once"}"#,
            r#"{"type":"user","text":"and the docs"}"#,
            r#"{"type":"abort"}"#,
            r#"{"type":"user","text":"never read"}"#,
        ];
        let (lines_tx, lines) = mpsc::unbounded_channel();
        for line in script {
            lines_tx
                .send(ClientLine {
                    text: line.to_string(),
                    oversized: false,
                })
                .expect("reader is alive");
        }
        drop(lines_tx);
        read_input_lines(
            lines,
            Arc::clone(&input),
            Arc::clone(&registry),
            crate::core::agent::host_tools::new_registry(),
            mpsc::unbounded_channel().0,
            OutputFormat::Json,
        )
        .await;

        assert_eq!(
            answer.await.expect("the run's permission wait is answered"),
            PermissionDecision::AllowOnce
        );
        let queued = input.take_queued();
        assert_eq!(queued.len(), 2, "the bad line cost neither follow-up");
        assert_eq!(queued[0]["content"], "also check the tests");
        assert_eq!(queued[1]["content"], "and the docs");
        // Lines after `abort` are not read: the run is already ending.
        assert!(input.take_queued().is_empty());
        input.aborted().await;
    }

    /// A decision is single-use. The second reply has no sender left to take,
    /// which is what keeps a client from answering a request the run already
    /// acted on.
    #[tokio::test]
    async fn a_second_reply_to_one_request_is_rejected() {
        let input = StreamInput::default();
        let registry: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
        let (tx, _rx) = tokio::sync::oneshot::channel();
        registry.lock().await.insert("perm-1".to_string(), tx);
        let line = r#"{"type":"permission","request_id":"perm-1","decision":"deny"}"#;

        let host_tools = crate::core::agent::host_tools::new_registry();
        let targets = InputTargets {
            permissions: &registry,
            host_tools: &host_tools,
        };
        assert_eq!(
            apply_input_line(line, &input, &targets).await,
            Ok(InputFlow::Decided(
                "perm-1".to_string(),
                PermissionDecision::Deny
            ))
        );
        let err = apply_input_line(line, &input, &targets)
            .await
            .expect_err("nothing is pending any more");
        assert!(err.contains("no permission request 'perm-1'"), "{err}");
    }

    /// The same single-use rule for a host tool answer, and the same reason:
    /// the first result has already been fed to the model.
    #[tokio::test]
    async fn a_second_tool_result_for_one_request_is_rejected() {
        let input = StreamInput::default();
        let registry: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
        let host_tools = crate::core::agent::host_tools::new_registry();
        // The id comes from the registry: the counter is process-wide, so a
        // literal would depend on which tests ran first.
        let (id, answer) = crate::core::agent::host_tools::register(&host_tools).await;
        let targets = InputTargets {
            permissions: &registry,
            host_tools: &host_tools,
        };
        let line = format!(r#"{{"type":"tool_result","request_id":"{id}","content":"moved"}}"#);
        let line = line.as_str();

        assert_eq!(
            apply_input_line(line, &input, &targets).await,
            Ok(InputFlow::Continue)
        );
        assert_eq!(
            answer.await.expect("the run's tool wait is answered"),
            Ok(crate::core::agent::host_tools::HostToolResult {
                content: "moved".to_string(),
                parts: None,
                details: None,
                is_error: false,
            })
        );
        let err = apply_input_line(line, &input, &targets)
            .await
            .expect_err("nothing is pending any more");
        assert!(err.contains(&format!("no host tool request '{id}'")), "{err}");
    }

    /// The wedge this guards: with a client on stdin the CLI answers nothing
    /// itself, so a request still pending when the pipe closes had no way out.
    /// Dropping the sender is what resolves the run's wait to `Deny`.
    #[tokio::test]
    async fn closing_stdin_releases_a_request_the_client_never_answered() {
        let input = Arc::new(StreamInput::default());
        let registry: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
        let (answer_tx, answer) = tokio::sync::oneshot::channel();
        registry
            .lock()
            .await
            .insert("perm-1".to_string(), answer_tx);

        // No lines at all: the client opened the pipe and closed it again.
        let (lines_tx, lines) = mpsc::unbounded_channel::<ClientLine>();
        drop(lines_tx);
        read_input_lines(
            lines,
            Arc::clone(&input),
            Arc::clone(&registry),
            crate::core::agent::host_tools::new_registry(),
            mpsc::unbounded_channel().0,
            OutputFormat::StreamJson,
        )
        .await;

        assert!(
            answer.await.is_err(),
            "the sender is dropped, which the run reads as Deny"
        );
        assert!(registry.lock().await.is_empty());
        assert!(
            input.client_gone(),
            "later requests must not be recorded as the client's to answer"
        );
    }

    /// The same wedge for a host tool, where it is sharper: only the client can
    /// answer a `tool_request`, so a pipe that closes mid-call would park the
    /// turn forever rather than merely losing a decision default.
    #[tokio::test]
    async fn a_pending_host_tool_call_is_released_when_the_client_leaves() {
        let input = Arc::new(StreamInput::default());
        let registry: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
        let host_tools = crate::core::agent::host_tools::new_registry();
        let (id, answer) = crate::core::agent::host_tools::register(&host_tools).await;

        let (lines_tx, lines) = mpsc::unbounded_channel::<ClientLine>();
        drop(lines_tx);
        let (events_tx, mut events) = mpsc::unbounded_channel();
        read_input_lines(
            lines,
            Arc::clone(&input),
            Arc::clone(&registry),
            Arc::clone(&host_tools),
            events_tx,
            OutputFormat::StreamJson,
        )
        .await;

        assert_eq!(
            answer.await.expect("the wait is settled, not dropped"),
            Err(crate::core::agent::host_tools::HostToolError::ClientGone)
        );
        assert!(host_tools.lock().await.is_empty());
        // The host is told, on the run's own stream, which request it lost.
        assert_eq!(
            serde_json::to_value(events.recv().await.expect("a record")).unwrap(),
            serde_json::json!({
                "type": "tool_request_cancelled",
                "request_id": id,
                "reason": "client_gone"
            })
        );
        assert!(events.recv().await.is_none(), "one record per released request");
    }

    /// An `abort` stops the reader but leaves host requests to the run's abort
    /// path, which withdraws them as `aborted`; releasing them here as well
    /// would report the same request twice under two reasons.
    #[tokio::test]
    async fn an_abort_leaves_host_requests_to_the_run() {
        let input = Arc::new(StreamInput::default());
        let host_tools = crate::core::agent::host_tools::new_registry();
        let (id, _answer) = crate::core::agent::host_tools::register(&host_tools).await;
        let (lines_tx, lines) = mpsc::unbounded_channel();
        lines_tx
            .send(ClientLine {
                text: r#"{"type":"abort"}"#.to_string(),
                oversized: false,
            })
            .expect("reader is alive");
        drop(lines_tx);
        let (events_tx, mut events) = mpsc::unbounded_channel();
        read_input_lines(
            lines,
            Arc::clone(&input),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::clone(&host_tools),
            events_tx,
            OutputFormat::StreamJson,
        )
        .await;
        assert!(events.recv().await.is_none());
        assert!(host_tools.lock().await.contains_key(&id));
        // What the abort path then does: the host is told, and a reply the
        // host was already writing is refused as no longer pending.
        let released = crate::core::agent::host_tools::cancel_all(&host_tools).await;
        assert_eq!(released, vec![id.clone()]);
        let late = format!(r#"{{"type":"tool_result","request_id":"{id}","content":"late"}}"#);
        let targets = InputTargets {
            permissions: &Arc::new(Mutex::new(HashMap::new())),
            host_tools: &host_tools,
        };
        let err = apply_input_line(&late, &input, &targets)
            .await
            .expect_err("nothing pending");
        assert!(err.contains("is pending (answered, cancelled, or never issued)"), "{err}");
    }

    /// An over-cap tool result is refused as a line, and the request is still
    /// pending: the host can shrink the image and answer again.
    #[tokio::test]
    async fn an_over_cap_tool_result_leaves_the_request_pending() {
        let input = StreamInput::default();
        let host_tools = crate::core::agent::host_tools::new_registry();
        let (id, answer) = crate::core::agent::host_tools::register(&host_tools).await;
        let permissions: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
        let targets = InputTargets {
            permissions: &permissions,
            host_tools: &host_tools,
        };
        let big = "A".repeat((stream_input::MAX_IMAGE_BYTES + 3) / 3 * 4);
        let line = serde_json::json!({
            "type": "tool_result",
            "request_id": id,
            "content": [{ "type": "image_url",
                          "image_url": { "url": format!("data:image/png;base64,{big}") } }]
        })
        .to_string();
        let err = apply_input_line(&line, &input, &targets)
            .await
            .expect_err("over the cap");
        assert!(err.contains("byte cap"), "{err}");
        assert!(host_tools.lock().await.contains_key(&id), "still pending");
        let retry = serde_json::json!({
            "type": "tool_result",
            "request_id": id,
            "content": [{ "type": "text", "text": "smaller" }],
            "details": { "retry": 1 }
        })
        .to_string();
        assert_eq!(
            apply_input_line(&retry, &input, &targets).await,
            Ok(InputFlow::Continue)
        );
        let result = answer.await.expect("delivered").expect("answered");
        assert_eq!(result.content, "smaller");
        assert_eq!(result.details, Some(serde_json::json!({ "retry": 1 })));
    }

    /// The other half of the same wedge, and the sharper half: a request raised
    /// *after* the pipe closed. `strand_all` has already run by then, so unless
    /// the printer fails this call itself the turn parks on a reply no one is
    /// left to send. Asserts the release, not merely that the latch flipped.
    #[tokio::test]
    async fn a_request_raised_after_the_client_left_is_failed_not_parked() {
        let input = StreamInput::default();
        let host_tools = crate::core::agent::host_tools::new_registry();

        // The client leaves, and the reader drains what was pending.
        input.mark_client_gone();
        crate::core::agent::host_tools::strand_all(&host_tools).await;

        // Only now does the model call a host tool.
        let (request_id, answer) =
            crate::core::agent::host_tools::register(&host_tools).await;
        assert!(input.client_gone());
        crate::core::agent::host_tools::strand(&host_tools, &request_id).await;

        assert_eq!(
            answer.await.expect("the wait is settled, not dropped"),
            Err(crate::core::agent::host_tools::HostToolError::ClientGone)
        );
        assert!(host_tools.lock().await.is_empty());
    }

    /// `--input-format stream-json` with any other output format leaves the
    /// client unable to see the request ids it is expected to answer.
    #[tokio::test]
    async fn a_duplex_run_is_refused_unless_the_output_is_stream_json() {
        for format in [OutputFormat::Text, OutputFormat::Json] {
            let err = run_agent_loop(
                ".",
                "task",
                None,
                false,
                ProviderOverrides::default(),
                SessionFlags::default(),
                None,
                format,
                InputFormat::StreamJson,
                None,
                false,
            )
            .await
            .expect_err("the pairing is required");
            assert!(
                err.to_string().contains("requires --output-format stream-json"),
                "{err}"
            );
        }
    }

    /// A content-part follow-up reaches the queue as the client wrote it: the
    /// same parts `upstream.rs` hands the provider, not a re-encoding of them.
    #[tokio::test]
    async fn a_content_part_follow_up_is_queued_verbatim() {
        let input = Arc::new(StreamInput::default());
        let registry: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
        let parts = serde_json::json!([
            { "type": "text", "text": "what is in this shot?" },
            { "type": "image_url",
              "image_url": { "url": "data:image/png;base64,QUJD", "detail": "high" } }
        ]);
        let line = serde_json::json!({ "type": "user", "content": parts }).to_string();
        let (lines_tx, lines) = mpsc::unbounded_channel();
        lines_tx
            .send(ClientLine {
                text: line,
                oversized: false,
            })
            .expect("reader is alive");
        drop(lines_tx);
        read_input_lines(
            lines,
            Arc::clone(&input),
            registry,
            crate::core::agent::host_tools::new_registry(),
            mpsc::unbounded_channel().0,
            OutputFormat::Json,
        )
        .await;

        let queued = input.take_queued();
        assert_eq!(queued.len(), 1, "the follow-up is queued as one turn");
        assert_eq!(queued[0]["role"], "user");
        assert_eq!(queued[0]["content"], parts);
    }

    /// A line over the cap is refused without being parsed, and what the reader
    /// keeps of it is bounded: the cap exists so the bytes are not carried on.
    #[test]
    fn a_line_over_the_cap_is_refused_and_its_echo_bounded() {
        let mut bytes = vec![b'x'; MAX_LINE_BYTES + 1024];
        bytes.push(b'\n');
        bytes.extend_from_slice(br#"{"type":"user","text":"after"}"#);
        let mut reader = std::io::BufReader::new(std::io::Cursor::new(bytes));

        let first = read_bounded_line(&mut reader).unwrap().expect("a line");
        assert!(first.oversized);
        assert_eq!(first.text.len(), MAX_ECHO_BYTES, "the echo, not the line");
        // Resynchronised on the next line rather than treating the overflow as
        // the end of input.
        let second = read_bounded_line(&mut reader)
            .unwrap()
            .expect("the line after the overflow");
        assert!(!second.oversized);
        assert_eq!(second.text, r#"{"type":"user","text":"after"}"#);
        assert!(read_bounded_line(&mut reader).unwrap().is_none());
    }

    /// The rejected echo the client sees is the bounded one, so a client that
    /// matches on `input_error.line` still can.
    #[test]
    fn an_over_cap_line_is_reported_with_a_truncated_echo() {
        let line = "x".repeat(MAX_ECHO_BYTES * 3);
        let record = serde_json::to_value(InputErrorRecord::new("line is over the cap", &line))
            .expect("a JSON record");
        assert_eq!(
            record["line"].as_str().expect("a string").len(),
            MAX_ECHO_BYTES
        );
        assert_eq!(record["line_truncated"], serde_json::json!(true));
    }

    /// A queued follow-up the run never reached is reported rather than
    /// vanishing, so the client knows to send it again.
    #[test]
    fn follow_ups_the_run_never_read_are_reported() {
        let input = StreamInput::default();
        input.queue_user("and the docs".to_string());
        report_dropped_follow_ups(&input, OutputFormat::StreamJson);
        assert!(
            input.take_queued().is_empty(),
            "reporting drains, so a second call cannot double-report"
        );
    }

    /// Signing in to Tokamak is what unlocks the desktop inherit. Without it the
    /// model stays unset so the TUI's sign-in notice fires, instead of the
    /// session silently starting on whatever the desktop app last had selected.
    #[test]
    fn desktop_model_is_inherited_only_when_signed_in() {
        let selection = crate::core::cli::providers::DesktopSelection {
            provider: Some("llamacpp".into()),
            model: Some("gemma-4-E2B-it-IQ4_XS".into()),
        };
        assert_eq!(
            inherit_desktop_model(true, selection.clone()).as_deref(),
            Some("gemma-4-E2B-it-IQ4_XS"),
        );
        assert_eq!(
            inherit_desktop_model(false, selection),
            None,
            "a signed-out session does not adopt the desktop's selection"
        );
    }

    /// Signed in but the desktop has no selection (or no desktop at all) is not
    /// an error -- it just contributes nothing to the chain.
    #[test]
    fn an_empty_desktop_selection_contributes_nothing() {
        assert_eq!(
            inherit_desktop_model(
                true,
                crate::core::cli::providers::DesktopSelection::default()
            ),
            None
        );
    }

    // ── resume ─────────────────────────────────────────────────────────────

    #[test]
    fn resume_target_from_flags() {
        assert_eq!(ResumeTarget::from_flags(None, false), None);
        assert_eq!(
            ResumeTarget::from_flags(None, true),
            Some(ResumeTarget::Latest)
        );
        assert_eq!(
            ResumeTarget::from_flags(Some(None), false),
            Some(ResumeTarget::Latest)
        );
        // A blank --resume value behaves like a bare --resume.
        assert_eq!(
            ResumeTarget::from_flags(Some(Some("  ".into())), false),
            Some(ResumeTarget::Latest)
        );
        assert_eq!(
            ResumeTarget::from_flags(Some(Some(" 3f7a ".into())), false),
            Some(ResumeTarget::Id("3f7a".into()))
        );
    }

    /// Write a thread with the given id/recency and a single user message.
    fn seed_thread(base: &std::path::Path, id: &str, updated: f64) {
        std::fs::create_dir_all(get_thread_dir(base, id)).unwrap();
        std::fs::write(
            get_thread_metadata_path(base, id),
            serde_json::json!({ "id": id, "title": id, "updated": updated }).to_string(),
        )
        .unwrap();
        std::fs::write(
            get_messages_path(base, id),
            serde_json::json!({
                "role": "user",
                "content": [{ "type": "text", "text": { "value": id, "annotations": [] } }],
            })
            .to_string()
                + "\n",
        )
        .unwrap();
    }

    #[test]
    fn find_resume_thread_latest_and_by_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        assert_eq!(
            find_resume_thread(base, &ResumeTarget::Latest).unwrap_err(),
            NO_SESSION_TO_RESUME
        );

        seed_thread(base, "aaaa1111", 100.0);
        seed_thread(base, "bbbb2222", 300.0);
        seed_thread(base, "bbbb3333", 200.0);

        let latest = find_resume_thread(base, &ResumeTarget::Latest).unwrap();
        assert_eq!(latest["id"], "bbbb2222");

        let by_prefix = find_resume_thread(base, &ResumeTarget::Id("aaaa".into())).unwrap();
        assert_eq!(by_prefix["id"], "aaaa1111");

        assert!(find_resume_thread(base, &ResumeTarget::Id("zz".into()))
            .unwrap_err()
            .contains("no thread matches"));
        assert!(find_resume_thread(base, &ResumeTarget::Id("bbbb".into()))
            .unwrap_err()
            .contains("ambiguous"));
    }

    #[test]
    fn find_resume_thread_skips_corrupted_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        seed_thread(base, "good1111", 100.0);
        let bad = "bad02222";
        std::fs::create_dir_all(get_thread_dir(base, bad)).unwrap();
        std::fs::write(get_thread_metadata_path(base, bad), "{not json").unwrap();

        let latest = find_resume_thread(base, &ResumeTarget::Latest).unwrap();
        assert_eq!(latest["id"], "good1111");
    }

    fn write_thread_files(base: &std::path::Path, id: &str, meta: &str, lines: &[&str]) {
        std::fs::create_dir_all(get_thread_dir(base, id)).unwrap();
        std::fs::write(get_thread_metadata_path(base, id), meta).unwrap();
        std::fs::write(get_messages_path(base, id), format!("{}\n", lines.join("\n"))).unwrap();
    }

    fn ids_of(v: &[serde_json::Value]) -> Vec<String> {
        v.iter().map(|m| m["id"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn list_messages_shows_the_active_versions_unless_all_are_asked_for() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        write_thread_files(
            base,
            "br000001",
            r#"{"id":"br000001","metadata":{}}"#,
            &[
                r#"{"id":"u1","created_at":1,"metadata":{"parentId":null}}"#,
                r#"{"id":"a1","created_at":2,"metadata":{"parentId":"u1"}}"#,
                r#"{"id":"a1b","created_at":3,"metadata":{"parentId":"u1"}}"#,
            ],
        );
        let shown = cli_list_messages_active_in(base, "br000001", false).unwrap();
        assert_eq!(ids_of(&shown), ["u1", "a1b"]);
        let all = cli_list_messages_active_in(base, "br000001", true).unwrap();
        assert_eq!(ids_of(&all), ["u1", "a1", "a1b"]);
    }

    #[test]
    fn list_messages_follows_the_threads_chosen_root() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        write_thread_files(
            base,
            "br000002",
            r#"{"id":"br000002","metadata":{"activeRootId":"r1"}}"#,
            &[
                r#"{"id":"r1","created_at":1,"metadata":{"parentId":null}}"#,
                r#"{"id":"r2","created_at":2,"metadata":{"parentId":null}}"#,
            ],
        );
        let shown = cli_list_messages_active_in(base, "br000002", false).unwrap();
        assert_eq!(ids_of(&shown), ["r1"]);
    }

    #[test]
    fn list_messages_leaves_a_legacy_linear_thread_whole() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        write_thread_files(
            base,
            "lin00001",
            r#"{"id":"lin00001"}"#,
            &[
                r#"{"id":"m1","role":"user"}"#,
                r#"{"id":"m2","role":"assistant"}"#,
            ],
        );
        let shown = cli_list_messages_active_in(base, "lin00001", false).unwrap();
        assert_eq!(ids_of(&shown), ["m1", "m2"]);
    }

    #[test]
    fn read_messages_lenient_skips_truncated_tail() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        seed_thread(base, "aaaa1111", 100.0);
        let mut raw = std::fs::read_to_string(get_messages_path(base, "aaaa1111")).unwrap();
        raw.push_str("{\"role\":\"assist");
        std::fs::write(get_messages_path(base, "aaaa1111"), raw).unwrap();

        let (messages, skipped) = cli_read_messages_lenient(base, "aaaa1111").unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(skipped, 1);
        // The shared reader accepts this shape too now: an unterminated final
        // line is what an interrupted append leaves, and refusing the whole
        // thread over it made a conversation unreadable (janhq/jan#8019).
        assert_eq!(cli_list_messages_in(base, "aaaa1111").unwrap().len(), 1);
    }

    #[test]
    fn the_shared_reader_still_rejects_corruption_before_the_tail() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        seed_thread(base, "bbbb2222", 100.0);
        let raw = std::fs::read_to_string(get_messages_path(base, "bbbb2222")).unwrap();
        std::fs::write(
            get_messages_path(base, "bbbb2222"),
            format!("not json\n{raw}"),
        )
        .unwrap();

        assert!(cli_list_messages_in(base, "bbbb2222").is_err());
    }

    #[test]
    fn read_messages_lenient_on_missing_thread_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let (messages, skipped) = cli_read_messages_lenient(dir.path(), "nope").unwrap();
        assert!(messages.is_empty());
        assert_eq!(skipped, 0);
    }

    #[test]
    fn resume_cycle_preserves_thread_id_and_history() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let history = vec![
            serde_json::json!({ "role": "user", "content": "first" }),
            serde_json::json!({ "role": "assistant", "content": "reply" }),
        ];
        let id = cli_save_thread(base, None, "m", &history, None).unwrap();

        let resumed =
            load_resume_history(base, &ResumeRequest::resume(ResumeTarget::Latest)).unwrap();
        assert_eq!(resumed.thread_id, id);
        assert_eq!(resumed.history, history);

        // Continue the session and save back: same thread, appended turns.
        let mut extended = resumed.history;
        extended.push(serde_json::json!({ "role": "user", "content": "second" }));
        let same = cli_save_thread(base, Some(&id), "m", &extended, None).unwrap();
        assert_eq!(same, id);
        assert_eq!(list_threads_in(base).unwrap().len(), 1);
        assert_eq!(
            load_resume_history(
                base,
                &ResumeRequest::resume(ResumeTarget::Id(id[..8].to_string())),
            )
            .unwrap()
            .history,
            extended
        );
    }

    fn call(id: &str, name: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "type": "function",
            "function": { "name": name, "arguments": "{\"path\":\"a.txt\"}" },
        })
    }

    #[test]
    fn tool_calls_and_results_survive_a_save_resume_cycle() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let history = vec![
            serde_json::json!({ "role": "user", "content": "do it" }),
            serde_json::json!({ "role": "assistant", "content": "", "tool_calls": [call("c1", "write")] }),
            serde_json::json!({ "role": "tool", "tool_call_id": "c1", "content": "wrote 1 line" }),
            serde_json::json!({ "role": "assistant", "content": "Done." }),
        ];
        let id = cli_save_thread(base, None, "m", &history, None).unwrap();

        let resumed =
            load_resume_history(base, &ResumeRequest::resume(ResumeTarget::Latest)).unwrap();
        assert_eq!(resumed.thread_id, id);
        assert_eq!(
            resumed.history, history,
            "the model must see the tools it ran, not just its own text"
        );
    }

    #[test]
    fn a_call_whose_result_was_never_saved_gets_one() {
        // A crash between the call and its result leaves the pair broken, and an
        // OpenAI-compatible upstream rejects an unanswered `tool_call_id`.
        let messages = vec![
            serde_json::json!({ "role": "assistant", "content": "", "tool_calls": [call("c1", "write"), call("c2", "read")] }),
            serde_json::json!({ "role": "tool", "tool_call_id": "c1", "content": "ok" }),
            serde_json::json!({ "role": "user", "content": "next" }),
        ];
        let out = rebuild_wire_history(&messages);
        assert_eq!(out.len(), 4);
        assert_eq!(out[2]["role"], "tool");
        assert_eq!(out[2]["tool_call_id"], "c2");
        assert!(
            out[2]["content"].as_str().unwrap().contains("not saved"),
            "the gap is stated, not invented: {}",
            out[2]["content"]
        );
        assert_eq!(out[3]["role"], "user");
    }

    #[test]
    fn an_orphan_tool_message_is_dropped() {
        let messages = vec![
            serde_json::json!({ "role": "tool", "tool_call_id": "gone", "content": "stale" }),
            serde_json::json!({ "role": "user", "content": "hi" }),
        ];
        let out = rebuild_wire_history(&messages);
        assert_eq!(out.len(), 1, "a result with no call would be rejected");
        assert_eq!(out[0]["role"], "user");
    }

    #[test]
    fn rebuild_drops_messages_that_carry_nothing() {
        let messages = vec![
            serde_json::json!({ "role": "assistant", "content": "" }),
            serde_json::json!({ "role": "user", "content": "hi" }),
            serde_json::json!({ "role": "system", "content": "ignored" }),
        ];
        let out = rebuild_wire_history(&messages);
        assert_eq!(
            out,
            vec![serde_json::json!({ "role": "user", "content": "hi" })]
        );
    }

    #[test]
    fn completion_text_extracts_assistant_content() {
        let completion = serde_json::json!({ "choices": [{ "message": { "content": "hello" } }] });
        assert_eq!(completion_text(&completion).as_deref(), Some("hello"));
        assert_eq!(completion_text(&serde_json::json!({})), None);
        assert_eq!(
            completion_text(&serde_json::json!({ "choices": [{ "message": { "content": "" } }] })),
            None
        );
    }

    // ── invocation_label / default_thread_title ────────────────────────────

    #[test]
    fn invocation_label_recognizes_skill_and_command_wrappers() {
        assert_eq!(
            invocation_label(
                "[IMPORTANT: You have invoked the \"deploy\" skill - follow its instructions. The full skill content is loaded below.]\n\nBody."
            ),
            Some("[skill:deploy]".to_string())
        );
        assert_eq!(
            invocation_label(
                "[IMPORTANT: You have invoked the \"feature-dev\" command - follow its instructions. The full command content is loaded below.]\n\nBuild: $ARGUMENTS"
            ),
            Some("[command:feature-dev]".to_string())
        );
        // Anything that is not the exact machine wrapper stays None.
        assert_eq!(invocation_label("deploy"), None);
        assert_eq!(
            invocation_label("[IMPORTANT: You have invoked the \"\" skill - x"),
            None
        );
        assert_eq!(
            invocation_label("[IMPORTANT: You have invoked the \"deploy\" skill"), // truncated wrapper
            None
        );
        assert_eq!(
            invocation_label("[IMPORTANT: You have invoked the \"deploy\""), // no kind
            None
        );
    }

    #[test]
    fn default_thread_title_uses_invocation_label_for_first_message() {
        let history = serde_json::json!([{
            "role": "user",
            "content": "[IMPORTANT: You have invoked the \"feature-dev\" command - follow its instructions. The full command content is loaded below.]\n\nBuild: auth"
        }]);
        assert_eq!(
            default_thread_title(history.as_array().unwrap()),
            "[command:feature-dev]"
        );
    }

    #[test]
    fn default_thread_title_uses_first_user_message() {
        let history = serde_json::json!([
            { "role": "user", "content": "Explain   the  buffer\nlogic" },
            { "role": "assistant", "content": "sure" },
        ]);
        assert_eq!(
            default_thread_title(history.as_array().unwrap()),
            "Explain the buffer logic"
        );
    }

    #[test]
    fn openai_content_text_reads_multimodal_array() {
        let content = serde_json::json!([
            { "type": "text", "text": "describe" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,AA" } },
        ]);
        assert_eq!(openai_content_text(Some(&content)), "describe");
        assert_eq!(
            openai_content_text(Some(&serde_json::json!("plain"))),
            "plain"
        );
    }

    #[test]
    fn default_thread_title_uses_multimodal_user_text() {
        let history = serde_json::json!([{
            "role": "user",
            "content": [
                { "type": "text", "text": "look at this" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AA" } },
            ],
        }]);
        assert_eq!(
            default_thread_title(history.as_array().unwrap()),
            "look at this"
        );
    }

    #[test]
    fn default_thread_title_truncates_and_falls_back() {
        let long = "x".repeat(80);
        let history = serde_json::json!([{ "role": "user", "content": long }]);
        let title = default_thread_title(history.as_array().unwrap());
        assert_eq!(title.chars().count(), 50);
        assert!(title.ends_with('…'));

        let no_user = serde_json::json!([{ "role": "assistant", "content": "hi" }]);
        assert_eq!(
            default_thread_title(no_user.as_array().unwrap()),
            "Agent chat"
        );
    }

    // ── cli_save_thread metadata (snapshot bookkeeping) ────────────────────

    #[test]
    fn save_thread_persists_and_preserves_snapshot_metadata() {
        let base = std::env::temp_dir().join(format!(
            "jan_savethread_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let history = serde_json::json!([
            { "role": "user", "content": "hi" },
            { "role": "assistant", "content": "hello" },
        ]);
        let meta = serde_json::json!({
            "base_snapshot": "abc",
            "checkpoints": [{ "user_index": 0, "preview": "hi", "sha": "def" }],
        });

        let id = cli_save_thread(
            &base,
            None,
            "m",
            history.as_array().unwrap(),
            Some(meta.clone()),
        )
        .expect("save");

        let raw = std::fs::read_to_string(get_thread_metadata_path(&base, &id)).expect("read");
        let stored: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(stored["metadata"]["base_snapshot"], "abc");
        assert_eq!(stored["metadata"]["checkpoints"][0]["sha"], "def");

        // A follow-up save with no metadata must preserve the prior snapshot block.
        cli_save_thread(&base, Some(&id), "m", history.as_array().unwrap(), None).expect("resave");
        let raw = std::fs::read_to_string(get_thread_metadata_path(&base, &id)).expect("read2");
        let stored: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(stored["metadata"]["base_snapshot"], "abc");

        let _ = std::fs::remove_dir_all(&base);
    }

    // ── prepare_agent_session model resolution ────────────────────────────

    /// A project's `agent.toml` naming a model must not paper over "nothing can
    /// actually serve it": with no provider configured (this repo's own
    /// agent.toml pins `tokamak-1-preview`, but a fresh `~/.jan` has no
    /// credentials for it), the TUI path must still come back with an empty
    /// model so its sign-in notice fires instead of a first-message failure.
    #[test]
    fn tui_session_ignores_a_project_model_with_no_usable_provider() {
        crate::core::agent::global_config::with_temp_home(|_| {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(
                dir.path().join("agent.toml"),
                "[agent]\nmodel = \"tokamak-1-preview\"\n",
            )
            .unwrap();

            let session = prepare_agent_session(
                dir.path().to_str().unwrap(),
                None,
                ProviderOverrides::default(),
                SessionFlags::default(),
                None,
            )
            .expect("TUI session prep must not fail with nothing configured");
            assert_eq!(session.model, "");
        });
    }

    /// End-to-end for the sign-in gate, arranged so the pre-existing
    /// "nothing usable is configured" guard cannot mask it: a usable non-Tokamak
    /// provider is present (so the guard passes) but names no models (so
    /// `default_model` contributes nothing), leaving the desktop inherit as the
    /// only thing that could supply a model. Signed out, it must not.
    #[test]
    fn a_signed_out_session_does_not_adopt_the_desktop_model() {
        crate::core::agent::global_config::with_temp_home(|home| {
            crate::core::agent::global_config::set_provider(
                "openai",
                crate::core::agent::global_config::ProviderUpdate {
                    api_key: Some("sk-test".into()),
                    base_url: Some("https://api.openai.com/v1".into()),
                    models: Some(vec![]),
                    ..Default::default()
                },
            )
            .expect("seed provider");

            let data = home.join("jan-data");
            std::fs::create_dir_all(&data).unwrap();
            std::fs::write(
                data.join("settings.json"),
                r#"{"model-provider":"{\"state\":{\"selectedProvider\":\"llamacpp\",\"selectedModel\":{\"id\":\"gemma-4-E2B-it-IQ4_XS\"}}}"}"#,
            )
            .unwrap();
            std::env::set_var("JAN_DATA_FOLDER", &data);

            // Sanity: the desktop selection really is readable, so a passing
            // assertion below means the gate fired, not that the fixture is dead.
            assert_eq!(
                crate::core::cli::providers::desktop_selection()
                    .model
                    .as_deref(),
                Some("gemma-4-E2B-it-IQ4_XS")
            );
            assert!(!crate::core::cli::tokamak::auth_status().signed_in);

            let dir = tempfile::tempdir().unwrap();
            let session = prepare_agent_session(
                dir.path().to_str().unwrap(),
                None,
                ProviderOverrides::default(),
                SessionFlags::default(),
                None,
            )
            .expect("session prep");
            std::env::remove_var("JAN_DATA_FOLDER");

            assert_eq!(
                session.model, "",
                "signed out, the desktop's last selection must not become the session model"
            );
        });
    }

    /// The same project config, once a provider is actually usable, must be
    /// trusted again.
    #[test]
    fn tui_session_honors_a_project_model_once_a_provider_is_usable() {
        crate::core::agent::global_config::with_temp_home(|_| {
            crate::core::agent::global_config::set_provider(
                "tokamak",
                crate::core::agent::global_config::ProviderUpdate {
                    api_key: Some("tk".into()),
                    clear_api_key: false,
                    base_url: Some(crate::core::cli::tokamak::BASE_URL.into()),
                    models: Some(vec!["tokamak-1-preview".into()]),
                    api_type: None,
                    ..Default::default()
                },
            )
            .unwrap();
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(
                dir.path().join("agent.toml"),
                "[agent]\nmodel = \"tokamak-1-preview\"\n",
            )
            .unwrap();

            let session = prepare_agent_session(
                dir.path().to_str().unwrap(),
                None,
                ProviderOverrides::default(),
                SessionFlags::default(),
                None,
            )
            .expect("session prep");
            assert_eq!(session.model, "tokamak-1-preview");
        });
    }

    // ── fork ───────────────────────────────────────────────────────────────

    /// Three user turns, each with a tool call and its result, plus the journal
    /// the TUI would have written for them.
    fn seed_forkable(base: &std::path::Path) -> String {
        let mut history = Vec::new();
        for n in 0..3 {
            history.push(serde_json::json!({ "role": "user", "content": format!("turn {n}") }));
            history.push(serde_json::json!({
                "role": "assistant", "content": "", "tool_calls": [call(&format!("c{n}"), "write")]
            }));
            history.push(serde_json::json!({
                "role": "tool", "tool_call_id": format!("c{n}"), "content": "ok"
            }));
            history
                .push(serde_json::json!({ "role": "assistant", "content": format!("done {n}") }));
        }
        let id = cli_save_thread(base, None, "m", &history, None).unwrap();
        let entries: Vec<journal::DisplayEntry> = (0..3)
            .flat_map(|n| {
                vec![
                    journal::DisplayEntry::User {
                        text: format!("turn {n}"),
                        images: Vec::new(),
                    },
                    journal::DisplayEntry::ToolCall {
                        id: format!("c{n}"),
                        name: "write".into(),
                        args: serde_json::json!({ "path": "a.txt" }),
                    },
                    journal::DisplayEntry::ToolResult {
                        id: format!("c{n}"),
                        content: "ok".into(),
                        is_error: false,
                        diff: None,
                    },
                    journal::DisplayEntry::Assistant {
                        text: format!("done {n}"),
                        reasoning: Vec::new(),
                        reasoning_ms: None,
                    },
                ]
            })
            .collect();
        journal::write_journal(&journal::journal_path(base, &id), &entries).unwrap();
        id
    }

    #[test]
    fn fork_carries_the_prefix_of_both_files_and_leaves_the_source_alone() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let source = seed_forkable(base);
        let before_messages = std::fs::read(get_messages_path(base, &source)).unwrap();
        let before_journal = std::fs::read(journal::journal_path(base, &source)).unwrap();

        let forked = fork_thread(base, &source, Some(2)).unwrap();
        assert_ne!(forked, source);

        // Two user turns, each still holding its call/result pair.
        let history = load_resume_history(
            base,
            &ResumeRequest::resume(ResumeTarget::Id(forked.clone())),
        )
        .unwrap()
        .history;
        assert_eq!(user_turn_count(&history), 2);
        assert_eq!(history.len(), 8);
        assert!(history
            .iter()
            .all(|m| !thread_message_text(m).contains("turn 2")));
        assert_eq!(
            history
                .iter()
                .filter(|m| m.get("role").and_then(|v| v.as_str()) == Some("tool"))
                .count(),
            2,
            "every carried call keeps its result"
        );

        let journal = journal::read_journal(&journal::journal_path(base, &forked));
        assert_eq!(
            journal.len(),
            8,
            "tool rows were carried, not just the wire history"
        );
        assert!(
            matches!(journal.last(), Some(journal::DisplayEntry::Assistant { text, .. }) if text == "done 1")
        );

        assert_eq!(
            std::fs::read(get_messages_path(base, &source)).unwrap(),
            before_messages,
            "a fork must not touch the thread it came from"
        );
        assert_eq!(
            std::fs::read(journal::journal_path(base, &source)).unwrap(),
            before_journal
        );
    }

    #[test]
    fn fork_records_its_immediate_parent() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let source = seed_forkable(base);

        let child = fork_thread(base, &source, Some(2)).unwrap();
        let grandchild = fork_thread(base, &child, Some(1)).unwrap();

        let meta =
            |id: &str| cli_get_thread_in(base, id).unwrap()["metadata"][FORKED_FROM_KEY].clone();
        assert_eq!(
            meta(&child),
            serde_json::json!({ "thread_id": source, "user_turn": 2 })
        );
        assert_eq!(
            meta(&grandchild),
            serde_json::json!({ "thread_id": child, "user_turn": 1 }),
            "forking a fork names the fork, not the root"
        );
    }

    #[test]
    fn a_whole_thread_fork_records_every_turn_and_keeps_them() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let source = seed_forkable(base);

        let forked = fork_thread(base, &source, None).unwrap();
        let thread = cli_get_thread_in(base, &forked).unwrap();
        assert_eq!(thread["metadata"][FORKED_FROM_KEY]["user_turn"], 3);
        assert_eq!(
            journal::read_journal(&journal::journal_path(base, &forked)).len(),
            12
        );
    }

    #[test]
    fn fork_refuses_a_cut_that_would_keep_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let source = seed_forkable(base);
        assert!(fork_thread(base, &source, Some(0)).is_err());
        assert!(fork_thread(base, &source, Some(9)).is_err());
        assert!(fork_thread(base, "nope", None).is_err());
        assert_eq!(
            list_threads_in(base).unwrap().len(),
            1,
            "a refused fork leaves no half-built thread behind"
        );
    }

    /// A fork drops the checkpoints for turns it does not have: restoring the
    /// workspace to one of them would put the branch in a state it never saw.
    #[test]
    fn fork_drops_checkpoints_past_the_cut() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let source = seed_forkable(base);
        let history = cli_read_messages_lenient(base, &source).unwrap().0;
        cli_save_thread(
            base,
            Some(&source),
            "m",
            &rebuild_wire_history(&history),
            Some(serde_json::json!({
                "base_snapshot": "aaa",
                "checkpoints": [
                    { "user_index": 0, "preview": "turn 0", "sha": "s0" },
                    { "user_index": 2, "preview": "turn 2", "sha": "s2" },
                ],
            })),
        )
        .unwrap();

        let forked = fork_thread(base, &source, Some(2)).unwrap();
        let meta = cli_get_thread_in(base, &forked).unwrap()["metadata"].clone();
        assert_eq!(
            meta["base_snapshot"], "aaa",
            "the branch shares the base commit"
        );
        assert_eq!(meta["checkpoints"].as_array().unwrap().len(), 1);
        assert_eq!(meta["checkpoints"][0]["sha"], "s0");
    }

    #[test]
    fn resume_request_from_flags() {
        assert_eq!(ResumeRequest::from_flags(None, false, false), None);
        assert_eq!(
            ResumeRequest::from_flags(None, false, true),
            Some(ResumeRequest::fork(ResumeTarget::Latest)),
            "--fork-session alone branches the most recent session"
        );
        assert_eq!(
            ResumeRequest::from_flags(Some(Some("3f7a".into())), false, true),
            Some(ResumeRequest::fork(ResumeTarget::Id("3f7a".into())))
        );
        assert_eq!(
            ResumeRequest::from_flags(None, true, false),
            Some(ResumeRequest::resume(ResumeTarget::Latest))
        );
    }

    #[test]
    fn resolve_resume_forks_into_a_new_id_and_leaves_the_source_resumable() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let source = seed_forkable(base);

        let opened = resolve_resume(base, &ResumeRequest::fork(ResumeTarget::Latest)).unwrap();
        let forked = opened["id"].as_str().unwrap().to_string();
        assert_ne!(forked, source);
        assert_eq!(opened["metadata"][FORKED_FROM_KEY]["thread_id"], source);
        assert_eq!(
            load_resume_history(
                base,
                &ResumeRequest::resume(ResumeTarget::Id(source.clone()))
            )
            .unwrap()
            .thread_id,
            source,
            "the source is still there to resume"
        );
    }

    #[test]
    fn thread_forest_nests_forks_and_keeps_orphans_as_roots() {
        let node = |id: &str, updated: f64, parent: Option<&str>| {
            let mut t = serde_json::json!({ "id": id, "updated": updated, "metadata": {} });
            if let Some(p) = parent {
                t["metadata"][FORKED_FROM_KEY] =
                    serde_json::json!({ "thread_id": p, "user_turn": 1 });
            }
            t
        };
        let rows = thread_forest(vec![
            node("root", 1.0, None),
            node("child-old", 2.0, Some("root")),
            node("child-new", 3.0, Some("root")),
            node("grandchild", 4.0, Some("child-new")),
            node("orphan", 5.0, Some("deleted")),
        ]);
        let shape: Vec<(String, usize)> = rows
            .iter()
            .map(|n| (n.thread["id"].as_str().unwrap().to_string(), n.depth))
            .collect();
        assert_eq!(
            shape,
            vec![
                ("orphan".into(), 0),
                ("root".into(), 0),
                ("child-new".into(), 1),
                ("grandchild".into(), 2),
                ("child-old".into(), 1),
            ]
        );
        assert!(
            rows.iter()
                .find(|n| n.thread["id"] == "child-old")
                .unwrap()
                .last
        );
    }

    /// A store with no forks is today's flat, most-recent-first list.
    #[test]
    fn thread_forest_of_unforked_threads_is_the_flat_list() {
        let threads = vec![
            serde_json::json!({ "id": "a", "updated": 1.0 }),
            serde_json::json!({ "id": "b", "updated": 2.0 }),
        ];
        let rows = thread_forest(threads);
        assert!(rows.iter().all(|n| n.depth == 0));
        assert_eq!(rows[0].thread["id"], "b");
    }

    /// A fork cycle is reachable from no root; listing it flat beats dropping
    /// the sessions from `/tree` entirely.
    #[test]
    fn thread_forest_survives_a_cycle() {
        let rows = thread_forest(vec![
            serde_json::json!({ "id": "a", "updated": 1.0, "metadata": { FORKED_FROM_KEY: { "thread_id": "b" } } }),
            serde_json::json!({ "id": "b", "updated": 2.0, "metadata": { FORKED_FROM_KEY: { "thread_id": "a" } } }),
        ]);
        assert_eq!(rows.len(), 2);
    }

    // ── worktree ───────────────────────────────────────────────────────────

    #[test]
    fn a_fork_never_inherits_the_parent_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let source = seed_forkable(base);
        let history = cli_read_messages_lenient(base, &source).unwrap().0;
        cli_save_thread(
            base,
            Some(&source),
            "m",
            &rebuild_wire_history(&history),
            Some(serde_json::json!({
                "base_snapshot": "aaa",
                worktree::WORKTREE_KEY: {
                    "path": "/home/u/.jan/worktrees/jan-abc/deadbeef",
                    "branch": "jan/agent/deadbeef",
                },
            })),
        )
        .unwrap();

        let forked = fork_thread(base, &source, Some(2)).unwrap();
        let meta = cli_get_thread_in(base, &forked).unwrap()["metadata"].clone();
        assert_eq!(
            worktree::from_metadata(Some(&meta)),
            None,
            "two conversations must not edit one checkout"
        );
        assert_eq!(
            meta["base_snapshot"], "aaa",
            "the rest of the bookkeeping is kept"
        );
        // The source still names its own.
        let source_meta = cli_get_thread_in(base, &source).unwrap()["metadata"].clone();
        assert!(worktree::from_metadata(Some(&source_meta)).is_some());
    }

    /// A fork branches from where the source conversation left off, so the
    /// files match the transcript it inherited.
    #[test]
    fn latest_snapshot_prefers_the_newest_checkpoint() {
        let thread = serde_json::json!({ "metadata": {
            "base_snapshot": "base",
            "checkpoints": [
                { "user_index": 0, "preview": "one", "sha": "s0" },
                { "user_index": 1, "preview": "two", "sha": "s1" },
            ],
        }});
        assert_eq!(latest_snapshot(Some(&thread)).as_deref(), Some("s1"));

        // No checkpoints yet: the base snapshot is still better than HEAD.
        let fresh = serde_json::json!({ "metadata": { "base_snapshot": "base" } });
        assert_eq!(latest_snapshot(Some(&fresh)).as_deref(), Some("base"));
        // Nothing recorded at all leaves the choice to the caller (HEAD).
        assert_eq!(latest_snapshot(None), None);
        assert_eq!(
            latest_snapshot(Some(&serde_json::json!({ "metadata": {} }))),
            None
        );
    }

    /// Off by default, and off costs nothing: no git call, no directory.
    #[test]
    fn no_worktree_is_resolved_when_nothing_asks_for_one() {
        let dir = tempfile::tempdir().unwrap();
        let (workspace, note) = resolve_workspace(dir.path(), None, None);
        assert_eq!(workspace, None);
        assert_eq!(note, None);
    }

    /// Asking for a worktree outside a repository is not fatal: the session runs
    /// in the project directory and is told why.
    #[test]
    fn a_worktree_outside_a_repository_falls_back_with_a_reason() {
        let dir = tempfile::tempdir().unwrap();
        let (workspace, note) = resolve_workspace(dir.path(), Some(true), None);
        assert_eq!(workspace, None);
        assert!(
            note.is_some_and(|n| n.contains("not a git repository")),
            "the fallback has to say why"
        );
    }

    /// The regression behind a real failure: a headless run recorded no
    /// checkout, so the next `--resume` branched a fresh worktree and the model
    /// read a pristine tree, losing everything the run it continued had done.
    #[test]
    fn a_saved_thread_names_the_checkout_the_run_worked_in() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let workspace = worktree::Worktree {
            path: std::path::PathBuf::from("/home/u/.jan/worktrees/p-abc/deadbeef"),
            branch: "jan/agent/deadbeef".to_string(),
        };
        let history = vec![serde_json::json!({ "role": "user", "content": "do it" })];

        let meta = worktree_metadata(base, None, Some(&workspace));
        let id = cli_save_thread(base, None, "m", &history, meta).unwrap();
        let saved = cli_get_thread_in(base, &id).unwrap();
        assert_eq!(
            worktree::from_metadata(saved.get("metadata")),
            Some(workspace.clone()),
            "a resume has to be able to find the checkout again"
        );

        // A second turn merges into what is already there rather than replacing
        // it, so the snapshot bookkeeping beside it survives.
        cli_save_thread(
            base,
            Some(&id),
            "m",
            &history,
            Some(serde_json::json!({
                "base_snapshot": "aaa",
                worktree::WORKTREE_KEY: worktree::to_metadata(&workspace),
            })),
        )
        .unwrap();
        let meta = worktree_metadata(base, Some(&id), Some(&workspace)).expect("some");
        assert_eq!(meta["base_snapshot"], "aaa");
        assert_eq!(
            worktree::from_metadata(Some(&meta)),
            Some(workspace),
            "and the pointer is still the one this run used"
        );

        // No worktree: `None` keeps `cli_save_thread`'s preserve-existing path.
        assert_eq!(worktree_metadata(base, Some(&id), None), None);
    }

    /// A headless run takes no snapshots, so without capturing the source's
    /// checkout a fork opens on a pristine `HEAD` while the transcript it
    /// inherited describes work that is not in it. Caught against a live model:
    /// the fork's first `wc -l` disagreed with the answer it had just read.
    #[test]
    fn a_fork_base_captures_the_source_checkout_when_there_is_no_snapshot() {
        fn git(args: &[&str]) -> Option<String> {
            let out = std::process::Command::new("git").args(args).output().ok()?;
            out.status
                .success()
                .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        }

        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let r = repo.to_string_lossy().to_string();
        // Skip on a box without git rather than failing the suite.
        if git(&["-C", &r, "init", "-q"]).is_none() {
            return;
        }
        git(&["-C", &r, "config", "user.email", "a@b.c"]);
        git(&["-C", &r, "config", "user.name", "t"]);
        std::fs::write(repo.join("notes.txt"), "one\n").unwrap();
        git(&["-C", &r, "add", "-A"]);
        git(&["-C", &r, "commit", "-q", "-m", "init", "--no-gpg-sign"]).expect("commit");

        // A session worked in its own checkout: one tracked edit, one new file.
        let wt = dir.path().join("wt");
        let head = crate::core::agent::git::head_sha(&repo).expect("HEAD");
        crate::core::agent::git::worktree_add(&repo, &wt, "jan/agent/testfb", &head).unwrap();
        std::fs::write(wt.join("notes.txt"), "one\ntwo\n").unwrap();
        std::fs::write(wt.join("added.txt"), "new\n").unwrap();

        let source = serde_json::json!({
            "id": "src-thread",
            "metadata": { worktree::WORKTREE_KEY: {
                "path": wt.to_string_lossy(), "branch": "jan/agent/testfb",
            }},
        });
        let base = fork_base(Some(&source)).expect("the source checkout is captured");
        assert_ne!(
            base, head,
            "a fork must not start at a HEAD the work predates"
        );

        let show = |path: &str| git(&["-C", &r, "show", &format!("{base}:{path}")]);
        assert_eq!(
            show("notes.txt").as_deref(),
            Some("one\ntwo"),
            "the branch starts from the work the conversation did"
        );
        assert_eq!(
            show("added.txt").as_deref(),
            Some("new"),
            "untracked files the agent created are carried too"
        );

        // A recorded checkout the user deleted leaves the choice to HEAD.
        std::fs::remove_dir_all(&wt).unwrap();
        assert_eq!(fork_base(Some(&source)), None);
        // A source that recorded a snapshot uses it, no capture needed.
        let snapped = serde_json::json!({ "id": "s", "metadata": { "base_snapshot": "cafe" } });
        assert_eq!(fork_base(Some(&snapped)).as_deref(), Some("cafe"));
    }

    /// `--max-session-tokens` outranks `[budget].max_tokens`, which outranks
    /// the built-in default; `0` from either source survives as the unbounded
    /// marker `body_session_budget` expects rather than falling through.
    /// The money ceiling resolves flag > config > none, and a run that asks
    /// for one it cannot price is refused rather than run uncapped.
    #[test]
    fn a_cost_ceiling_is_refused_rather_than_run_uncapped() {
        let none = std::collections::BTreeMap::new();
        let unpriced = "no-such-model/never-priced";
        assert_eq!(resolve_cost_ceiling(None, None, &none, unpriced), Ok(None));
        let refused = resolve_cost_ceiling(Some(2.0), None, &none, unpriced)
            .expect_err("an unpriceable ceiling must not silently run uncapped");
        assert!(refused.contains("no price is declared"), "{refused}");
        assert!(resolve_cost_ceiling(None, Some(2.0), &none, unpriced).is_err());
        let precedence = resolve_cost_ceiling(Some(2.0), Some(9.0), &none, unpriced)
            .expect_err("still unpriceable");
        assert!(precedence.contains("$2") && !precedence.contains("$9"), "{precedence}");
        let negative = resolve_cost_ceiling(Some(-1.0), None, &none, unpriced)
            .expect_err("a negative ceiling is rejected");
        assert!(negative.contains("non-negative"), "{negative}");
        assert!(resolve_cost_ceiling(Some(f64::NAN), None, &none, unpriced).is_err());

        // A declared price (dollars per million) becomes per-token rates, and
        // a provider-qualified id finds a bare declaration.
        let mut prices = std::collections::BTreeMap::new();
        prices.insert(
            "claude-x".to_string(),
            crate::core::agent::spend::Price {
                input: 3.0,
                output: 15.0,
                cached_input: Some(0.3),
            },
        );
        let ceiling = resolve_cost_ceiling(Some(0.0), None, &prices, "anthropic/claude-x")
            .expect("priced")
            .expect("a ceiling");
        assert_eq!(ceiling.max_usd, 0.0);
        assert!((ceiling.rates.prompt_usd - 3e-6).abs() < 1e-15);
        assert!((ceiling.rates.completion_usd - 15e-6).abs() < 1e-15);
        assert_eq!(ceiling.rates.cache_read_usd, Some(0.3 / 1_000_000.0));

        // It reaches the request body with its rates.
        let mut limits = limits_with(None, 0);
        limits.cost_ceiling = Some(ceiling);
        let body = request_body("m", &limits, true, serde_json::json!([]));
        assert_eq!(body["max_budget_usd"], 0.0);
        assert!(body["token_rates"]["prompt_usd"].as_f64().is_some());
    }

    #[test]
    fn session_budget_precedence_is_flag_then_config_then_default() {
        assert_eq!(
            resolve_session_budget(None, None),
            DEFAULT_MAX_SESSION_TOKENS
        );
        assert_eq!(resolve_session_budget(None, Some(50_000)), 50_000);
        assert_eq!(resolve_session_budget(Some(20_000), Some(50_000)), 20_000);
        assert_eq!(resolve_session_budget(Some(20_000), None), 20_000);
        assert_eq!(resolve_session_budget(Some(0), Some(50_000)), 0);
        assert_eq!(resolve_session_budget(None, Some(0)), 0);

        assert_eq!(session_budget_source(None, None), "default");
        assert_eq!(session_budget_source(None, Some(50_000)), "agent.toml");
        assert_eq!(session_budget_source(Some(0), Some(50_000)), "flag");
    }

    fn limits_with(max_turns: Option<u64>, max_session_tokens: u64) -> SessionLimits {
        SessionLimits {
            context_window: 128_000,
            context_window_source:
                crate::core::cli::model_capabilities::ContextWindowSource::Fallback,
            reserve_tokens: 16_384,
            compaction: Default::default(),
            max_tokens: None,
            max_session_tokens,
            max_turns,
            cost_ceiling: None,
        }
    }

    /// The write side of the caps: the limits have to reach the request body in
    /// the encoding `body_turn_cap` / `body_session_budget` read back, or the
    /// flags are inert. `max_turns` is absent (not `0`) when unset, so a caller
    /// that never passes it is byte-identical to before the flag existed.
    #[test]
    fn run_limits_reach_the_request_body() {
        let messages = serde_json::json!([]);

        let unset = request_body("m", &limits_with(None, 128_000), true, messages.clone());
        assert!(
            unset.get("max_turns").is_none(),
            "an unset cap must not write the field at all: {unset}"
        );
        assert_eq!(unset["max_session_tokens"], 128_000);

        // What `agent step` pins, and what `--max-turns 5` pins, by the same route.
        let stepped = request_body("m", &limits_with(Some(1), 128_000), true, messages.clone());
        assert_eq!(stepped["max_turns"], 1);
        let capped = request_body("m", &limits_with(Some(5), 20_000), true, messages.clone());
        assert_eq!(capped["max_turns"], 5);
        assert_eq!(capped["max_session_tokens"], 20_000);

        // An explicit 0 is the engine's "unbounded" encoding and must survive as
        // itself rather than being dropped back to the absent case.
        let zero = request_body("m", &limits_with(Some(0), 0), true, messages);
        assert_eq!(zero["max_turns"], 0);
        assert_eq!(zero["max_session_tokens"], 0);
    }

    /// A project without `.jan/agent/agent.toml` runs under the default
    /// policy, so exporting it yields that policy instead of a
    /// malformed-state error.
    #[test]
    fn policy_export_without_agent_toml_exports_the_default_policy() {
        let dir = tempfile::tempdir().unwrap();
        let document = super::cli_policy_export(dir.path().to_str().unwrap())
            .expect("a project without agent.toml exports the default policy");
        assert_eq!(document.default, "read-only");
        assert!(document.allow.is_empty());
        assert!(document.deny.is_empty());
    }

    /// An agent.toml that exists but cannot be parsed is still refused.
    #[test]
    fn policy_export_with_malformed_agent_toml_fails() {
        let dir = tempfile::tempdir().unwrap();
        let agent = dir.path().join(".jan").join("agent");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(agent.join("agent.toml"), "this is = = not toml").unwrap();
        assert!(super::cli_policy_export(dir.path().to_str().unwrap()).is_err());
    }
}
