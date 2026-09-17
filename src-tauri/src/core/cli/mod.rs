//! CLI adapter layer — thin wrappers that call core logic without an AppHandle.
//!
//! This module is only compiled when the `cli` feature is enabled.

mod agent_status;
pub mod auth;
pub mod brand;
pub mod browser;
pub mod device_auth;
pub mod doctor;
pub mod file_log;
pub mod inflight;
pub mod journal;
pub mod json_api;
pub mod bench;
pub mod login;
pub mod mcp;
mod model_capabilities;
mod path_refs;
pub mod providers;
pub mod run_report;
pub mod secrets;
mod secret_input;
pub mod terminal_setup;
pub mod tokamak;
mod tui;
pub mod version;

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

/// List messages for a thread.
pub fn cli_list_messages(thread_id: &str) -> Result<Vec<serde_json::Value>, String> {
    let data_folder = resolve_jan_data_folder();
    read_messages_from_file(&data_folder, thread_id)
}

/// Delete a thread directory.
pub fn cli_delete_thread(thread_id: &str) -> Result<(), String> {
    use std::fs;

    let data_folder = resolve_jan_data_folder();
    let thread_dir = get_thread_dir(&data_folder, thread_id);
    if thread_dir.exists() {
        fs::remove_dir_all(thread_dir).map_err(|e| e.to_string())?;
    }
    crate::core::agent::git::cleanup_snapshot_index(thread_id);
    Ok(())
}

/// Get thread metadata by ID.
pub fn cli_get_thread(thread_id: &str) -> Result<serde_json::Value, String> {
    let data_folder = resolve_jan_data_folder();
    let path = get_thread_metadata_path(&data_folder, thread_id);
    if !path.exists() {
        return Err(format!("Thread '{thread_id}' not found"));
    }
    let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
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
    run_orchestration_streamed, OrchestrationArgs, PermissionRegistry,
};
use crate::core::cli::providers::{load_provider_configs, ProviderOverrides};
use crate::core::cli::run_report::{OutputFormat, RunReport};
use crate::core::mcp::models::McpSettings;
use std::collections::HashMap;
use std::io::Write as _;
use tauri_plugin_agent_tools::tools::gate::PermissionDecision;
use tauri_plugin_agent_tools::workspace;
use tokio::sync::{mpsc, Mutex};

/// Token-spend ceiling for one agent run when `agent.toml [budget].max_tokens`
/// is unset. There is no turn cap: the agent takes as many turns as the task
/// needs and this budget (or cancellation) is what stops a runaway loop. `0`
/// disables the ceiling entirely. Counted marginally by `SessionBudget`, so
/// this bounds real new spend, not the context replayed on every turn.
const DEFAULT_MAX_SESSION_TOKENS: u64 = 128_000;

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
        "max_session_tokens": cfg.budget.max_tokens.unwrap_or(DEFAULT_MAX_SESSION_TOKENS),
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

/// Autonomous run: as many turns as the task needs, bounded only by the
/// session token budget.
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
    resume: Option<ResumeTarget>,
    format: OutputFormat,
) -> Result<(), tauri_plugin_agent_tools::harness_error::HarnessError> {
    run_agent_loop(
        project, task, model, false, overrides, flags, resume, format,
    )
    .await
}

/// Single-turn run for debugging: the one place a turn cap is still applied,
/// and it is not user-configurable.
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
    /// `[budget].max_tokens`: marginal token-spend ceiling for one run, the
    /// only cap on run length. `0` is unbounded.
    pub max_session_tokens: u64,
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
}

impl AgentSession {
    /// Build a streaming request body for the given conversation history.
    pub(crate) fn body(&self, messages: serde_json::Value) -> serde_json::Value {
        let mut body = serde_json::json!({
            "model": self.model,
            "messages": messages,
            "max_session_tokens": self.limits.max_session_tokens,
            "stream": true,
        });
        // Forward the per-request output cap only when configured; it flows to
        // the upstream via `copy_optional_chat_params`.
        if let Some(max) = self.limits.max_tokens {
            body["max_tokens"] = serde_json::json!(max);
        }
        // Reasoning resend policy: the request-level flag the loop reads to
        // decide whether prior assistant `reasoning_content` goes back out.
        body["send_reasoning"] = serde_json::json!(self.send_reasoning);
        body
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

/// Resolve project config + credentials into a ready-to-run engine handle.
/// Shared by `run_agent_loop` (plain CLI) and `cli_agent_ui` (TUI).
fn prepare_agent_session(
    project: &str,
    model_override: Option<String>,
    overrides: ProviderOverrides,
    flags: SessionFlags,
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
        .map_err(|e| format!("{}", e.message()))?;
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

    let provider_configs = load_provider_configs(Some(&project_root), &overrides)?;

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
    let args = build_cli_orchestration_args(
        project_root,
        permissions,
        provider_configs,
        mcp_servers.clone(),
        mcp_settings,
        permission_requests.clone(),
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
            max_session_tokens: cfg.budget.max_tokens.unwrap_or(DEFAULT_MAX_SESSION_TOKENS),
        },
        show_reasoning: cfg.agent.show_reasoning.unwrap_or(false),
        stream_reasoning: crate::core::agent::global_config::stream_reasoning_enabled(),
        send_reasoning: cfg.agent.send_reasoning.unwrap_or(true),
        mcp_servers,
        mcp_task,
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
    target: &ResumeTarget,
) -> Result<ResumedSession, String> {
    let thread = find_resume_thread(agent_dir, target)?;
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
    resume: Option<ResumeTarget>,
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
            ..flags
        },
    )?;
    let project_root = resolve_project_root(project);
    let (clean_task, injected) = path_refs::resolve_references(task, &project_root);
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
    let mut body = session.body(serde_json::json!(history.clone()));
    if single_turn {
        body["max_turns"] = serde_json::json!(1);
    }
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
        },
    })
}

/// First 8 chars of a thread id, the form the TUI shows in `/threads`.
fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

#[allow(clippy::too_many_arguments)]
async fn run_agent_loop(
    project: &str,
    task: &str,
    model_override: Option<String>,
    single_turn: bool,
    overrides: ProviderOverrides,
    flags: SessionFlags,
    resume: Option<ResumeTarget>,
    format: OutputFormat,
) -> Result<(), tauri_plugin_agent_tools::harness_error::HarnessError> {
    let started = std::time::Instant::now();
    // Read before the flags are handed on: this is the run's own answer about
    // how much to say, and it is wanted after the run as well as during it.
    let asked_density = flags.density;
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
        args,
        body,
        limits,
        permission_requests,
        mcp_task,
        persist,
    } = match prepared {
        Ok(prepared) => prepared,
        Err(e) => {
            if format.is_json() {
                print_report(RunReport::setup_failure(&e).finish(
                    None,
                    "",
                    started.elapsed().as_millis(),
                    None,
                ));
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
    let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
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
            if let StreamEvent::TurnUsage { usage } = &ev {
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
                            "\n\x1b[33m[context] {}\x1b[0m",
                            crate::core::agent::context_pressure::line(&found)
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
            if format.is_json() {
                resolve_permission_silently(ev, &permission_requests).await;
            } else {
                print_event(ev, &permission_requests, density).await;
            }
        }
        (report, conversation)
    });

    let result = run_orchestration_streamed(&tx, &body, &args).await;
    drop(tx);
    let (report, conversation) = printer.await.unwrap_or_default();

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
    let persisted = persist_headless_run(persist, &result, conversation);
    let (session_id, final_text) = (persisted.session_id, persisted.final_text);
    // Saved, so nothing is in flight any more. A run that failed before its
    // thread could be written keeps its checkpoint: its completed steps are
    // still the only copy.
    if persisted.saved || result.is_ok() {
        if let Some(writer) = checkpoint.lock().ok().and_then(|mut g| g.take()) {
            writer.finish();
        }
    }
    if persisted.saved && !format.is_json() {
        if let Some(id) = session_id.as_deref() {
            eprintln!(
                "\x1b[2m[session {} - resume with `flint --resume={}`]\x1b[0m",
                short_id(id),
                short_id(id)
            );
        }
    }
    if format.is_json() {
        print_report(report.finish(
            session_id.as_deref().map(short_id).as_deref(),
            &model,
            started.elapsed().as_millis(),
            final_text.as_deref(),
        ));
    }
    // The stream belongs to this run (AH-183); a later command in the same
    // process is not it.
    tauri_plugin_agent_tools::event_log::unwatch();
    // The one-shot CLI runs exactly one turn, so its session ends here: wipe
    // the persistent bash `/tmp` scratch this run used.
    if let Some(session) = args.session_id.as_deref() {
        let _ = workspace::remove_scratch_dir(session).await;
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
) -> PersistedRun {
    let PersistTarget {
        agent_dir,
        thread_id,
        model,
        mut history,
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
        match cli_save_thread(&agent_dir, thread_id.as_deref(), &model, &history, None) {
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
    let config = crate::core::agent::project::load_agent_config(&root).map_err(|e| {
        HarnessError::new(ErrorKind::MalformedState, format!("this project's configuration cannot be read: {e}"))
            .at(Stage::Startup)
    })?;
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

/// Write the result envelope to stdout, the only thing `--output-format json`
/// puts there. Pretty-printed: these are read by people at least as often as by
/// programs, and `jq` does not care either way.
fn print_report(report: run_report::RunResult) {
    println!(
        "{}",
        serde_json::to_string_pretty(&report).unwrap_or_default()
    );
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
    };
    let mut body = sub::child_body(&resolved, &spec.description, &parent, None);
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

/// Answer a permission request without printing progress, for the JSON format.
/// Leaving it unanswered would wedge the run: the loop waits on the reply.
/// Every other event is silent -- stdout belongs to the envelope.
async fn resolve_permission_silently(ev: StreamEvent, registry: &PermissionRegistry) {
    if let StreamEvent::PermissionRequest {
        request_id,
        tool_name,
        capability,
        path,
        command,
        ..
    } = ev
    {
        let detail = command
            .map(|c| format!(" ({c})"))
            .or_else(|| path.map(|p| format!(" on {p}")))
            .unwrap_or_default();
        let decision = prompt_permission(tool_name, capability, detail).await;
        if let Some(sender) = registry.lock().await.remove(&request_id) {
            let _ = sender.send(decision);
        }
    }
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
    resume: Option<ResumeTarget>,
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

async fn print_event(ev: StreamEvent, registry: &PermissionRegistry, density: Density) {
    if crate::core::cli::auth::account::take_claude_alias_engaged() {
        eprintln!(
            "\x1b[33m[warning] {}\x1b[0m",
            crate::core::cli::auth::account::CLAUDE_ALIAS_NOTICE
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
                eprint!("\x1b[2m{delta}\x1b[0m");
                let _ = std::io::stderr().flush();
            }
        }
        // Reasoning is progress, not answer: dimmed on stderr so piping stdout
        // yields only the real completion.
        StreamEvent::Reasoning { text } => {
            if density != Density::Compact {
                eprint!("\x1b[2m{text}\x1b[0m");
                let _ = std::io::stderr().flush();
            }
        }
        StreamEvent::Step { index, max } => {
            if density != Density::Compact {
                match max {
                    0 => eprintln!("\n\x1b[2m[turn {index}]\x1b[0m"),
                    m => eprintln!("\n\x1b[2m[turn {index}/{m}]\x1b[0m"),
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
        StreamEvent::TurnUsage { usage } => {
            if density == Density::Verbose {
                let (input, output, total) = (
                    usage.prompt_tokens.unwrap_or(0),
                    usage.completion_tokens.unwrap_or(0),
                    usage.total_tokens.unwrap_or(0),
                );
                eprintln!(
                    "\x1b[2m[turn-usage] in={input} out={output} total={total}\x1b[0m"
                );
            }
        }
        StreamEvent::ToolCall { name, args, .. } => eprintln!(
            "\x1b[2m[tool] {}\x1b[0m",
            crate::core::agent::events::describe_tool_call(&name, &args)
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
                eprintln!("\x1b[2m[{tag}] {content}\x1b[0m");
            }
        }
        StreamEvent::SubagentStart { name, .. } => {
            eprintln!("\x1b[2m[subagent:{name}] started (background)\x1b[0m")
        }
        StreamEvent::SubagentQueued { name, waiting, .. } => {
            eprintln!("\x1b[2m[subagent:{name}] queued ({waiting} waiting)\x1b[0m")
        }
        StreamEvent::SubagentEnd { name, .. } => {
            eprintln!("\x1b[2m[subagent:{name}] finished\x1b[0m")
        }
        StreamEvent::Subagent { name, event, .. } => {
            if let StreamEvent::ToolCall {
                name: tool, args, ..
            } = *event
            {
                eprintln!(
                    "\x1b[2m[subagent:{name}] {}\x1b[0m",
                    crate::core::agent::events::describe_tool_call(&tool, &args)
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
                    "[2m[resources] {figures} ({} of {} commands measured)[0m",
                    resources.measured_commands, resources.commands
                );
            }
        }
        StreamEvent::Done { stop_reason, usage } => {
            let tokens = usage.and_then(|u| u.total_tokens).unwrap_or(0);
            eprintln!("\n\x1b[2m[done] stop_reason={stop_reason} tokens={tokens}\x1b[0m");
        }
        StreamEvent::Error { code, message } => {
            // AH-009: the event already carries the classification, so the
            // line says what kind of failure it was once, and a cancellation
            // does not read as a crash.
            if code == "cancelled" {
                eprintln!("
[2m[stopped] {message}[0m");
            } else {
                eprintln!("
[31m[error:{code}] {message}[0m");
            }
        }
        StreamEvent::AskRequest { .. } => {
            eprintln!("\n\x1b[31m[error] interactive ask requires `flint agent ui`\x1b[0m")
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
            ..
        } => {
            let detail = command
                .map(|c| format!(" ({c})"))
                .or_else(|| path.map(|p| format!(" on {p}")))
                .unwrap_or_default();
            if let Some(diff) = diff {
                eprintln!("\x1b[2m{diff}\x1b[0m");
            }
            let decision = prompt_permission(tool_name, capability, detail).await;
            if let Some(sender) = registry.lock().await.remove(&request_id) {
                let _ = sender.send(decision);
            }
        }
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
        eprintln!("\x1b[33m[permission] auto-denied {capability} via '{tool_name}' (non-interactive)\x1b[0m");
        return PermissionDecision::Deny;
    }
    tokio::task::spawn_blocking(move || {
        eprint!("\x1b[33m[permission] allow {capability} via '{tool_name}'{detail}? [y/N] \x1b[0m");
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

        let resumed = load_resume_history(&base, &ResumeTarget::Id(id.clone()))
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

        let resumed = load_resume_history(base, &ResumeTarget::Latest).unwrap();
        assert_eq!(resumed.thread_id, id);
        assert_eq!(resumed.history, history);

        // Continue the session and save back: same thread, appended turns.
        let mut extended = resumed.history;
        extended.push(serde_json::json!({ "role": "user", "content": "second" }));
        let same = cli_save_thread(base, Some(&id), "m", &extended, None).unwrap();
        assert_eq!(same, id);
        assert_eq!(list_threads_in(base).unwrap().len(), 1);
        assert_eq!(
            load_resume_history(base, &ResumeTarget::Id(id[..8].to_string()))
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

        let resumed = load_resume_history(base, &ResumeTarget::Latest).unwrap();
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
            )
            .expect("session prep");
            assert_eq!(session.model, "tokamak-1-preview");
        });
    }
}
