//! `flint cli schedule`: list scheduled tasks, run one now, read its history,
//! and the hidden `run-spec` a supervisor starts for each run.
//!
//! A scheduled run has nobody watching. The child therefore:
//! * runs the task's frozen allow-list and nothing else (`allowed_tools`);
//! * has the auto-mode classifier forced on (`FLINT_UNATTENDED_RUN`);
//! * answers every permission prompt with a deny, writes the prompt into the
//!   run's "blocked on" lines, and tells `needs.attention` listeners that a run
//!   is waiting -- never what it was working on;
//! * edits only inside a fresh worktree on its own branch, and only when the
//!   task asked for that; otherwise nothing that changes the folder is ever
//!   approved;
//! * stops at the turn, token and wall-clock budgets the task was saved with.
//! The quota and spend ceilings the loop already enforces apply as for any run.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
use tauri_plugin_agent_tools::tools::gate::PermissionDecision;
use tokio::sync::mpsc;

use super::providers::ProviderOverrides;
use super::{agent_dir_for, cli_save_thread, completion_text, prepare_agent_run, PreparedRun, SessionFlags};
use crate::core::agent::events::StreamEvent;
use crate::core::agent::notify::{self, Moment, Notification};
use crate::core::agent::r#loop::run_orchestration_streamed;
use crate::core::schedule::runner::{self, Ending, Observer, SupervisorLauncher};
use crate::core::schedule::spec::{OnBlock, WriteMode};
use crate::core::schedule::store::{now_ms, RunRecord, RunStatus, Store, Trigger};

fn invalid(message: impl Into<String>) -> HarnessError {
    HarnessError::new(ErrorKind::InvalidInput, message).at(Stage::Startup)
}

fn store_err(e: crate::core::schedule::store::StoreError) -> HarnessError {
    HarnessError::new(ErrorKind::Io, e.message).at(Stage::Startup)
}

fn data_folder() -> PathBuf {
    crate::core::app::commands::resolve_jan_data_folder()
}

fn stamp(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "-".to_string())
}

/// `flint cli schedule list`
pub fn list(json: bool) -> Result<(), HarnessError> {
    let store = Store::new(&data_folder());
    let tasks = store.load_tasks().map_err(store_err)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&tasks).unwrap_or_default());
        return Ok(());
    }
    if tasks.is_empty() {
        println!("No scheduled tasks. Create one in Settings > Schedules.");
        return Ok(());
    }
    let now = chrono::Utc::now();
    for t in tasks {
        let next = t
            .next_fires(now, 1)
            .ok()
            .and_then(|f| f.first().copied())
            .map(|f| stamp(f.timestamp_millis() as u64))
            .unwrap_or_else(|| "-".to_string());
        println!(
            "{}  {:<8}  next {}  {}",
            t.id,
            if t.enabled { "enabled" } else { "disabled" },
            next,
            t.name
        );
    }
    Ok(())
}

/// `flint cli schedule runs <id>`
pub fn runs(task_id: &str, limit: usize, json: bool) -> Result<(), HarnessError> {
    let store = Store::new(&data_folder());
    let runs = store.list_runs(task_id, limit).map_err(store_err)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&runs).unwrap_or_default());
        return Ok(());
    }
    if runs.is_empty() {
        println!("No runs yet.");
    }
    for r in runs {
        println!(
            "{}  {}  {:?}  turns {}  tokens {}  {}",
            r.id,
            stamp(r.started_at_ms),
            r.status,
            r.spend.turns,
            r.spend.input_tokens + r.spend.output_tokens,
            if r.blocked_on.is_empty() { String::new() } else { format!("blocked on {}", r.blocked_on.join("; ")) }
        );
    }
    Ok(())
}

/// `flint cli schedule run <id>`: start a run now, detached. With `wait`, stay
/// until it ends and report how.
pub async fn run_now(task_id: &str, wait: bool) -> Result<(), HarnessError> {
    let data = data_folder();
    let store = Store::new(&data);
    let task = store
        .get_task(task_id)
        .map_err(store_err)?
        .ok_or_else(|| HarnessError::new(ErrorKind::NotFound, format!("no scheduled task '{task_id}'")).at(Stage::Startup))?;
    let record = runner::start_run(&store, &data, &SupervisorLauncher, &task, Trigger::Manual, chrono::Utc::now())
        .map_err(store_err)?;
    println!("{}", record.id);
    if record.status == RunStatus::Skipped {
        return Err(HarnessError::new(ErrorKind::InvalidInput, record.error.unwrap_or_default()).at(Stage::Startup));
    }
    if !wait {
        return Ok(());
    }
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        runner::settle(&store, &data);
        if let Some(r) = store.get_run(task_id, &record.id).map_err(store_err)? {
            if r.status.is_ended() {
                println!("{:?}", r.status);
                if let Some(s) = r.summary {
                    println!("{s}");
                }
                for b in r.blocked_on {
                    println!("blocked on: {b}");
                }
                return match r.status {
                    RunStatus::Succeeded => Ok(()),
                    _ => Err(HarnessError::new(ErrorKind::ChildFailed, r.error.unwrap_or_else(|| "the run did not succeed".into()))
                        .at(Stage::Child)),
                };
            }
        }
    }
}

/// `flint cli schedule run-spec --spec <file>`: one run, as a supervisor starts
/// it. Always writes its ending into the run record, whatever happened.
pub async fn run_spec(spec_file: &Path) -> Result<(), HarnessError> {
    let spec = runner::read_spec(spec_file).map_err(invalid)?;
    std::env::set_var("JAN_DATA_FOLDER", &spec.data_folder);
    std::env::set_var(crate::core::agent::auto_mode::UNATTENDED_ENV, "1");
    let data = PathBuf::from(&spec.data_folder);
    let store = Store::new(&data);
    let mut record = store
        .get_run(&spec.task.id, &spec.run_id)
        .map_err(store_err)?
        .ok_or_else(|| HarnessError::new(ErrorKind::NotFound, "this run has no record").at(Stage::Startup))?;

    let mut obs = Observer::new(spec.task.on_block);
    let ending = execute(&spec, &store, &mut record, &mut obs).await;
    runner::finish(&mut record, &obs, ending, now_ms());
    store.update_run(&record).map_err(store_err)?;
    let _ = std::fs::remove_file(spec_file);

    // Who asked to be told hears how it ended, and nothing of what it did.
    let root = PathBuf::from(&spec.task.project);
    if let Ok(cfg) = crate::core::agent::project::load_agent_config(&root) {
        if let Ok(Some(n)) = notify::check(&cfg.notify) {
            let session = record.session_id.clone().unwrap_or_default();
            let note = Notification::new(Moment::RunEnded, &session, None, runner::notification_line(record.status));
            for outcome in notify::deliver(&n, &note, &root, Moment::RunEnded).await {
                if let notify::Delivered::Failed(why) = outcome {
                    log::warn!("notify: {why}");
                }
            }
        }
    }
    match record.status {
        RunStatus::Succeeded => Ok(()),
        _ => Err(HarnessError::new(ErrorKind::ChildFailed, record.error.clone().unwrap_or_else(|| "the run did not succeed".into()))
            .at(Stage::Child)),
    }
}

async fn execute(
    spec: &runner::RunSpec,
    store: &Store,
    record: &mut RunRecord,
    obs: &mut Observer,
) -> Ending {
    let task = &spec.task;
    let worktree = task.policy.write == WriteMode::Worktree;
    let flags = SessionFlags {
        // Writes are approved only inside a worktree of their own; a read-only
        // task approves nothing, so its write and shell prompts are denied.
        auto_approve: worktree,
        require_model: true,
        worktree: Some(worktree),
        profile: task.profile.clone(),
        max_turns: Some(u64::from(task.budgets.max_turns)),
        max_session_tokens: Some(task.budgets.max_tokens),
        ..Default::default()
    };
    let prepared = prepare_agent_run(
        &task.project,
        &task.prompt,
        Some(task.model.clone()),
        false,
        ProviderOverrides::default(),
        flags,
        None,
    );
    let PreparedRun { args, mut body, permission_requests, mcp_task, persist, .. } = match prepared {
        Ok(p) => p,
        Err(e) => return Ending::Failed(e),
    };
    body["allowed_tools"] = serde_json::json!(task.policy.allow_tools);
    let session_id = persist.thread_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    record.session_id = Some(session_id.clone());
    record.branch = persist.workspace.as_ref().map(|w| w.branch.clone());
    let _ = store.update_run(record);

    if let Some(task) = mcp_task {
        let _ = task.await;
    }

    let notify_cfg = crate::core::agent::project::load_agent_config(Path::new(&task.project))
        .ok()
        .and_then(|cfg| notify::check(&cfg.notify).ok().flatten());
    let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
    let stop = std::sync::Arc::new(tokio::sync::Notify::new());
    let stop_for_drain = stop.clone();
    let on_block = task.on_block;
    let project_root = PathBuf::from(&task.project);
    let session_for_notify = session_id.clone();
    let registry = permission_requests.clone();
    let drain = tokio::spawn(async move {
        let mut observer = Observer::new(on_block);
        let mut conversation: Option<Vec<serde_json::Value>> = None;
        while let Some(ev) = rx.recv().await {
            observer.observe(&ev);
            match &ev {
                StreamEvent::MessagesUpdated { messages } => conversation = Some(messages.clone()),
                StreamEvent::PermissionRequest { request_id, tool_name, capability, path, command, .. } => {
                    eprintln!("(scheduled run: {tool_name} needs approval and nobody is attached; denied)");
                    let end = observer.blocked(tool_name, capability, path.as_deref(), command.as_deref());
                    if let Some(sender) = registry.lock().await.remove(request_id) {
                        let _ = sender.send(PermissionDecision::Deny);
                    }
                    if let Some(n) = notify_cfg.as_ref() {
                        let note = Notification::new(
                            Moment::NeedsAttention,
                            &session_for_notify,
                            None,
                            format!("a scheduled run was blocked on a {tool_name} call"),
                        );
                        let _ = notify::deliver(n, &note, &project_root, Moment::NeedsAttention).await;
                    }
                    if end {
                        stop_for_drain.notify_one();
                    }
                }
                _ => {}
            }
        }
        (observer, conversation)
    });

    let wall = Duration::from_secs(task.budgets.max_wall_clock_secs);
    enum Stopped {
        Done(Result<serde_json::Value, HarnessError>),
        TimedOut,
        Blocked,
    }
    let outcome = {
        let run = run_orchestration_streamed(&tx, &body, &args);
        tokio::select! {
            r = run => Stopped::Done(r),
            _ = tokio::time::sleep(wall) => Stopped::TimedOut,
            _ = stop.notified() => Stopped::Blocked,
        }
    };
    drop(tx);
    let (observed, conversation) = drain.await.unwrap_or_else(|_| (Observer::new(OnBlock::Continue), None));
    *obs = observed;

    // Keep the transcript whatever the ending: a run that stopped at a limit
    // is the one somebody most wants to read.
    let history = conversation.filter(|m| !m.is_empty());
    if let Some(messages) = history {
        let mut messages = messages;
        if let Stopped::Done(Ok(completion)) = &outcome {
            if let Some(text) = completion_text(completion) {
                let last_is_it = messages
                    .last()
                    .and_then(|m| m.get("content"))
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|c| c == text);
                if !last_is_it {
                    messages.push(serde_json::json!({ "role": "assistant", "content": text }));
                }
            }
        }
        if let Err(e) = cli_save_thread(&agent_dir_for(Path::new(&task.project)), Some(&session_id), &persist.model, &messages, None) {
            eprintln!("(could not save the transcript: {e})");
        }
        // And a copy in the app's own thread store, so the run history can open
        // it as an ordinary conversation.
        save_app_copy(&PathBuf::from(&spec.data_folder), &session_id, &persist.model, &messages, spec, record);
    }
    let _ = tauri_plugin_agent_tools::workspace::remove_scratch_dir(&session_id).await;

    match outcome {
        Stopped::Done(Ok(completion)) => Ending::Answered(completion_text(&completion).unwrap_or_default()),
        Stopped::Done(Err(e)) if e.kind() == ErrorKind::BudgetExhausted => Ending::BudgetStopped(e.message().to_string()),
        Stopped::Done(Err(e)) => Ending::Failed(e.message().to_string()),
        Stopped::TimedOut => Ending::WallClock,
        Stopped::Blocked => Ending::Blocked,
    }
}

/// Save the transcript where the app lists conversations, titled for the task
/// and marked as scheduled so it can be told from a chat.
fn save_app_copy(
    data: &Path,
    session_id: &str,
    model: &str,
    messages: &[serde_json::Value],
    spec: &runner::RunSpec,
    record: &RunRecord,
) {
    let when = chrono::DateTime::from_timestamp_millis(record.started_at_ms as i64)
        .map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default();
    let metadata = serde_json::json!({
        "scheduled": { "taskId": spec.task.id, "runId": spec.run_id },
    });
    if let Err(e) = cli_save_thread(data, Some(session_id), model, messages, Some(metadata)) {
        eprintln!("(could not save the transcript for the app: {e})");
        return;
    }
    let path = crate::core::threads::utils::get_thread_metadata_path(data, session_id);
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let Ok(mut thread) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    thread["title"] = serde_json::json!(format!("{} - {when}", spec.task.name));
    let _ = crate::core::threads::helpers::update_thread_metadata(data, session_id, &thread);
}
