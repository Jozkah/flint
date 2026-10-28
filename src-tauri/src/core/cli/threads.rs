//! Thread storage for the CLI: listing, reading, saving, resuming, forking
//! and the text/wire conversions between a saved thread and a conversation.
//! Re-exported from `core::cli`, so every `core::cli::X` path is unchanged.

use super::*;

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
    crate::core::threads::helpers::read_messages_lossy(base, thread_id).map(|r| r.messages)
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

pub(crate) fn delete_thread_at(data_folder: &std::path::Path, thread_id: &str) -> Result<(), String> {
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
    if let Err(e) = tauri_plugin_agent_tools::retention::delete_session(data_folder, thread_id) {
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

    // A re-save keeps the id and timestamps of every record that did not change,
    // so deep links and delete-by-id stay stable; the first record that differs
    // starts the new tail.
    let previous = read_messages_from_file(base, &id).unwrap_or_default();
    let mut reuse = true;
    let mut position = 0usize;
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
            // The copy on disk goes through the shared redactor; the in-memory
            // history the model sees is untouched.
            secrets::scrub_json(&mut record["content"]);
            if let Some(calls) = record.get_mut("tool_calls") {
                secrets::scrub_json(calls);
            }
            // Images ride next to the text in the shape the desktop already
            // stores (`image_url` content entries), so a resume still shows
            // them to the model. Not scrubbed: a data URL is not a secret and
            // the redactor must not touch its bytes.
            if let Some(parts) = record["content"].as_array_mut() {
                parts.extend(image_parts(m.get("content")));
            }
            if reuse {
                match previous.get(position) {
                    Some(old) if same_message(old, &record) => {
                        for key in ["id", "created_at", "completed_at"] {
                            if let Some(v) = old.get(key) {
                                record[key] = v.clone();
                            }
                        }
                    }
                    _ => reuse = false,
                }
            }
            position += 1;
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

/// Whether a saved record and a freshly built one carry the same message: role,
/// text and the tool fields, ignoring id and timestamps.
pub(super) fn same_message(old: &serde_json::Value, new: &serde_json::Value) -> bool {
    ["role", "content", "tool_calls", "tool_call_id"].iter().all(|k| old.get(k) == new.get(k))
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
        let images = image_parts(m.get("content"));
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
        if text.is_empty() && calls.is_none() && images.is_empty() {
            continue;
        }
        let mut msg = serde_json::json!({ "role": role, "content": text });
        if !images.is_empty() {
            let mut parts = Vec::new();
            if !text.is_empty() {
                parts.push(serde_json::json!({ "type": "text", "text": text }));
            }
            parts.extend(images);
            msg["content"] = serde_json::Value::Array(parts);
        }
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
pub(super) fn fork_metadata(
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

pub(super) fn push_children(stack: &mut Vec<(usize, usize, bool)>, kids: &[usize], depth: usize) {
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

/// The `image_url` parts of a message `content` array, as `{type, image_url}`
/// entries (the form both the wire and the desktop's stored messages use).
/// Anything else, and an image part with no URL, is left out.
pub(super) fn image_parts(content: Option<&serde_json::Value>) -> Vec<serde_json::Value> {
    let Some(serde_json::Value::Array(parts)) = content else {
        return Vec::new();
    };
    parts
        .iter()
        .filter(|p| p.get("type").and_then(|v| v.as_str()) == Some("image_url"))
        .filter(|p| p.get("image_url").and_then(|i| i.get("url")).and_then(|u| u.as_str()).is_some())
        .map(|p| serde_json::json!({ "type": "image_url", "image_url": p["image_url"].clone() }))
        .collect()
}

/// Text of an OpenAI-shaped message `content`: the string as-is, or the joined
/// `text` parts of a multimodal content array (image parts contribute nothing).
pub(super) fn openai_content_text(content: Option<&serde_json::Value>) -> String {
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
pub(super) fn default_thread_title(history: &[serde_json::Value]) -> String {
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
