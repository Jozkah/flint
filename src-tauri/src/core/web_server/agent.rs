//! The agent's review and control plane, for a client that has no agent of its
//! own (the Android build, a browser) and is signed in to `flint serve`.
//!
//! Off unless the server was started with `--agent-root <folder>`. What it
//! answers is deliberately small and runs no command on the host:
//!
//! - campaigns: list, read, context, event log, cancel, pause and resume;
//! - proposals: list, apply, reject (the same stored, hash-approved path the
//!   desktop uses);
//! - `agent_server_info` and `agent_server_folders`, so a client can tell
//!   whether any of this is on and browse the folders it may use.
//!
//! Not here, on purpose: running a Cowork turn or a campaign task. Those need
//! the tool executor, which sits behind the agent plugin's `tauri` feature and
//! is absent from this headless build by design, and the loop itself is driven
//! by a renderer. Also not here: anything that spawns a process (verification
//! checks, the final build and test gate). A server session's own worktree
//! (state, commit, merge, discard) is the runner's, by session id, in
//! `session_worktree.rs`.
//!
//! Every path a request names must resolve inside one of the roots the
//! operator listed. The data folder is never a root, and a root may not
//! contain it.

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use std::sync::Arc;

use super::agent_runs;
use super::campaign_driver::{self, Driver, DriverConfig, Host as _, RunnerHost, TaskCommand};
use super::runner::{self, Caller, Runner, RunnerOptions};
use crate::core::agent::campaign;
use crate::core::agent::campaign_integration;
use crate::core::agent::git;
use tauri_plugin_agent_tools::folder_trust;
use tauri_plugin_agent_tools::proposal;
use tauri_plugin_agent_tools::tools::jail;

/// A refusal: an HTTP status and a body (a string, or the object the page's
/// error handling reads).
#[derive(Debug)]
pub struct Fail {
    pub status: u16,
    pub body: Value,
}

fn fail(status: u16, message: impl Into<String>) -> Fail {
    Fail {
        status,
        body: Value::String(message.into()),
    }
}

/// The shape the desktop commands reject with: a message and the conflicts.
fn failure(message: impl Into<String>) -> Fail {
    Fail {
        status: 422,
        body: json!({ "message": message.into(), "conflicts": [] }),
    }
}

fn proposal_failure(error: proposal::ProposalError) -> Fail {
    let conflicts = match &error {
        proposal::ProposalError::Conflicts(list) => {
            serde_json::to_value(list).unwrap_or_else(|_| json!([]))
        }
        _ => json!([]),
    };
    let unacknowledged = match &error {
        proposal::ProposalError::Unacknowledged(paths) => paths.clone(),
        _ => Vec::new(),
    };
    Fail {
        status: 422,
        body: json!({
            "message": error.message(),
            "conflicts": conflicts,
            "unacknowledged": unacknowledged,
        }),
    }
}

/// The commands this module answers. Everything else is the caller's to refuse.
pub fn handles(command: &str) -> bool {
    matches!(
        command,
        "agent_server_info"
            | "agent_server_folders"
            | "agent_list_folders"
            | "agent_run_list"
            | "agent_run_get"
            | "agent_campaign_list"
            | "agent_campaign_get"
            | "agent_campaign_context"
            | "agent_campaign_events"
            | "agent_campaign_transition"
            | "agent_campaign_cancel"
            | "agent_campaign_delete"
            | "agent_campaign_plan_update"
            | "agent_campaign_diff"
            | "agent_campaign_task_diff"
            | "agent_campaign_claim_notice"
            | "agent_campaign_gate_plan"
            | "agent_campaign_refresh"
            | "agent_campaign_orphans"
            | "agent_proposal_list"
            | "agent_proposal_apply"
            | "agent_proposal_reject"
    ) || is_project_read(command)
}

/// Read-only questions about a project under the agent roots: its trust, its
/// tooling and its git state. Each is confined like `agent_list_folders`.
pub fn is_project_read(command: &str) -> bool {
    matches!(
        command,
        "folder_trust_status"
            | "project_tooling"
            | "agent_is_git_repo"
            | "agent_git_branch"
            | "agent_git_status"
            | "agent_git_file_diff"
            | "agent_git_head_file"
            | "agent_git_blame"
    )
}

#[derive(Clone)]
pub struct Agent {
    data_folder: PathBuf,
    roots: Vec<PathBuf>,
    /// `--agent-run`: the operator asked this server to run agent sessions.
    run: bool,
    /// The session runner, present once [`Agent::with_runner`] built it.
    runner: Option<Arc<Runner>>,
    options: RunnerOptions,
    /// The campaign driver (P3), built with the runner.
    driver: Option<Arc<Driver<RunnerHost>>>,
    /// Shared cap on `agent_list_folders` calls (a browser's folder chooser).
    browse_budget: Arc<Budget>,
}

/// A fixed-window request cap: `LIMIT` calls per `WINDOW`, across clients.
#[derive(Default)]
struct Budget {
    window: std::sync::Mutex<Option<(std::time::Instant, u32)>>,
}

impl Budget {
    const LIMIT: u32 = 240;
    const WINDOW: std::time::Duration = std::time::Duration::from_secs(60);

    fn take(&self) -> bool {
        let mut slot = self.window.lock().unwrap_or_else(|e| e.into_inner());
        let now = std::time::Instant::now();
        match slot.as_mut() {
            Some((start, count)) if now.duration_since(*start) < Self::WINDOW => {
                if *count >= Self::LIMIT {
                    return false;
                }
                *count += 1;
            }
            _ => *slot = Some((now, 1)),
        }
        true
    }
}

/// Most folders one listing returns.
const MAX_FOLDER_ENTRIES: usize = 500;

/// Longest path the folder chooser accepts.
const MAX_BROWSE_PATH: usize = 1024;

/// Refuse what a folder chooser never sends: relative paths, `..` or `.`
/// segments, UNC and device paths, control characters and over-long input.
/// What passes is still canonicalised and confined.
///
/// `raw` arrives already decoded (a JSON string) and is never decoded again,
/// so `%` is just a name character: `pct%20dir` and `%2e%2e` are folder names,
/// not escapes, and a name that is not on disk fails canonicalisation.
fn browse_request(raw: &str) -> Result<(), Fail> {
    let bad = || fail(400, "invalid path");
    if raw.is_empty() {
        return Ok(());
    }
    if raw.len() > MAX_BROWSE_PATH || raw.chars().any(char::is_control) {
        return Err(bad());
    }
    if raw.starts_with("//") {
        return Err(bad());
    }
    // `Path::components` silently drops interior `.` segments, so `/root/./app`
    // would pass the component check below; refuse `.` and `..` segments in the
    // raw text instead.
    if raw.split(['/', '\\']).any(|s| s == "." || s == "..") {
        return Err(bad());
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(bad());
    }
    use std::path::Component;
    for part in path.components() {
        match part {
            Component::ParentDir | Component::CurDir => return Err(bad()),
            Component::Prefix(prefix) => {
                use std::path::Prefix;
                // A drive, or the verbatim drive form canonical paths take on
                // Windows; never a share, a device or a verbatim UNC path.
                if !matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) {
                    return Err(bad());
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Whether the session runner is built into this release (P1: `runner.rs`).
const RUNNER_READY: bool = true;

/// What the Rust loop on the server does not match yet, said to the client
/// instead of left to be discovered.
const PARITY_GAPS: &[&str] = &[
    "worktree dependency links, sparse checkout and tool-cache optimisations",
    "plan-review UX",
    "goal evaluation",
    "TS-side compaction",
    "agent teams",
    "browser and computer panes",
];

/// A folder worth listing: skips what a person would not pick a project from.
fn listable(name: &str) -> bool {
    !name.starts_with('.') && name != "node_modules" && name != "target"
}

impl Agent {
    /// `None` when no root was given (the feature is off). Roots are made
    /// canonical here, once; a root that is missing, is not a folder, is the
    /// filesystem root, or overlaps the data folder is an error the operator
    /// sees at start-up rather than a silently narrower server.
    pub fn open(data_folder: &Path, roots: &[PathBuf]) -> Result<Option<Agent>, String> {
        Self::open_with(data_folder, roots, false)
    }

    /// As [`Agent::open`], with `--agent-run`. Running sessions needs roots to
    /// confine them to, so the flag without one is an error.
    pub fn open_with(
        data_folder: &Path,
        roots: &[PathBuf],
        run: bool,
    ) -> Result<Option<Agent>, String> {
        if roots.is_empty() {
            if run {
                return Err("--agent-run needs at least one --agent-root <folder>".into());
            }
            return Ok(None);
        }
        let data = data_folder
            .canonicalize()
            .map_err(|e| format!("data folder {} is unreadable: {e}", data_folder.display()))?;
        let mut canonical = Vec::new();
        for root in roots {
            let path = root
                .canonicalize()
                .map_err(|e| format!("--agent-root {} is unreadable: {e}", root.display()))?;
            if !path.is_dir() {
                return Err(format!("--agent-root {} is not a folder", path.display()));
            }
            if path.parent().is_none() {
                return Err("--agent-root cannot be the filesystem root".into());
            }
            if data.starts_with(&path) || path.starts_with(&data) {
                return Err(format!(
                    "--agent-root {} overlaps the data folder, which holds the server's credentials",
                    path.display()
                ));
            }
            if !canonical.contains(&path) {
                canonical.push(path);
            }
        }
        Ok(Some(Agent {
            data_folder: data_folder.to_path_buf(),
            roots: canonical,
            run,
            runner: None,
            options: RunnerOptions::default(),
            driver: None,
            browse_budget: Arc::new(Budget::default()),
        }))
    }

    /// Build the session runner when `--agent-run` is on. A separate step so
    /// the plain review plane needs none of its options.
    pub fn with_runner(mut self, options: RunnerOptions, bus: super::events::Bus) -> Agent {
        self.options = options.clone();
        if self.run {
            let runner = Arc::new(Runner::new(&self.data_folder, &self.roots, options.clone(), bus));
            let host = RunnerHost::new(
                runner.clone(),
                DriverConfig {
                    allow_checks: options.allow_checks,
                    allow_bypass: options.allow_bypass,
                    max_sessions: options.max_sessions,
                    approval_timeout: options.approval_timeout,
                },
            );
            let driver = Driver::new(host);
            runner.set_coordinator_backend(super::coordinator::DriverBackend::new(driver.clone()));
            self.driver = Some(driver);
            self.runner = Some(runner);
        }
        self
    }

    /// Start the campaign driver's loop, when this server runs sessions. The
    /// loop reads the campaign records, so campaigns left running by an earlier
    /// life of the server continue without a client.
    pub fn start_driver(&self) {
        if let (Some(driver), true) = (&self.driver, self.missing().is_empty()) {
            driver.spawn();
        }
    }

    /// Why this server will not run a session, in words a person can act on;
    /// empty when it will.
    fn missing(&self) -> Vec<&'static str> {
        let backend = jail::backend();
        let mut missing: Vec<&'static str> = Vec::new();
        if !self.run {
            missing.push("start the server with --agent-run");
        }
        if !RUNNER_READY {
            missing.push("the session runner is not in this release");
        }
        if self.options.require_sandbox && !backend.enforces() {
            missing.push(if cfg!(target_os = "linux") {
                "install bubblewrap (bwrap) so commands run in a sandbox"
            } else if cfg!(target_os = "macos") {
                "the macOS sandbox (sandbox-exec) is unavailable"
            } else {
                "the Windows AppContainer sandbox helper is unavailable"
            });
        }
        missing
    }

    /// The runner when sessions may run here (flag on, sandbox ready).
    fn ready_runner(&self) -> Result<&Arc<Runner>, Fail> {
        let missing = self.missing();
        match (&self.runner, missing.is_empty()) {
            (Some(runner), true) => Ok(runner),
            _ => Err(fail(
                403,
                format!("this server does not run agent sessions: {}", missing.join("; ")),
            )),
        }
    }

    /// The live event stream of a session, when it is live here.
    pub fn tail(&self, id: &str, after: u64) -> Option<super::server::Resp> {
        self.runner.as_ref()?.tail(id, after)
    }

    /// A runner command (`agent_run_create` and the rest). Async, unlike
    /// [`Agent::call`]: it waits for the session's task.
    pub async fn call_run(
        &self,
        command: &str,
        args: &Value,
        caller: &Caller,
    ) -> Result<Value, Fail> {
        if !runner::handles(command) {
            return Err(fail(404, "Unknown agent command"));
        }
        let runner = self.ready_runner()?.clone();
        let confined = match command {
            "agent_run_create" => Some(self.confine(text(args, "folder")?)?),
            // The repository a worktree listing is about.
            "agent_worktree_list" => Some(self.confine(text(args, "project")?)?),
            _ => None,
        };
        runner.call(command, args, caller, confined).await
    }

    /// The driver, when sessions may run here.
    fn ready_driver(&self) -> Result<&Arc<Driver<RunnerHost>>, Fail> {
        self.ready_runner()?;
        self.driver.as_ref().ok_or_else(|| fail(403, "this server does not run campaigns"))
    }

    /// A campaign this server drives; anything else is refused.
    fn server_campaign(&self, id: &str) -> Result<campaign::Campaign, Fail> {
        let c = campaign::get(&self.data_folder, id).map_err(|e| failure(e.message))?;
        if c.driver != campaign::DRIVER_SERVER {
            return Err(fail(403, "that campaign is not run by this server"));
        }
        Ok(c)
    }

    /// The campaign commands that need the runner or wait on a model or a
    /// project command (`campaign_driver::handles`). Signed-in clients only,
    /// like every other command.
    pub async fn call_campaign(&self, command: &str, args: &Value, caller: &Caller) -> Result<Value, Fail> {
        match command {
            "agent_campaign_cancel" => {
                let id = text(args, "id")?.to_owned();
                let detail = args.get("detail").and_then(Value::as_str).unwrap_or_default().to_owned();
                if let Some(driver) = self.driver.as_ref().filter(|_| self.runner.is_some()) {
                    let c = campaign::get(&self.data_folder, &id).map_err(|e| failure(e.message))?;
                    if c.driver == campaign::DRIVER_SERVER {
                        return to_json(driver.cancel(&id, &detail).await.map_err(failure)?);
                    }
                }
                to_json(campaign::cancel(&self.data_folder, &id, &detail).map_err(|e| failure(e.message))?)
            }
            "agent_campaign_approvals" => {
                let driver = self.ready_driver()?;
                Ok(json!({ "approvals": driver.approvals() }))
            }
            "agent_campaign_start_server" => {
                let driver = self.ready_driver()?.clone();
                let folder = self.confine(text(args, "folder")?)?;
                let goal = text(args, "goal")?.to_owned();
                let options: campaign_driver::StartOptions = match args.get("options") {
                    Some(v) if !v.is_null() => serde_json::from_value(v.clone())
                        .map_err(|e| fail(400, format!("options are not valid: {e}")))?,
                    _ => Default::default(),
                };
                // A coordinator conversation instead of the one-shot planner,
                // when asked for. It falls back to the planner when the
                // session cannot be started for a runtime reason (the session
                // cap, no model); a refusal (bad folder, not allowed) is final.
                let wants_coordinator = args.get("coordinator").and_then(Value::as_bool).unwrap_or(false)
                    || args
                        .pointer("/options/coordinator")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                let mut fell_back: Option<String> = None;
                if wants_coordinator {
                    let runner = self.ready_runner()?.clone();
                    if runner.coordinator_ready() {
                        match self.start_coordinator(&runner, driver.host().as_ref(), &folder, &goal, &options, caller).await {
                            Ok(started) => return Ok(started),
                            Err(f) if matches!(f.status, 400 | 403 | 404) => return Err(f),
                            Err(f) => {
                                fell_back = Some(match f.body {
                                    Value::String(s) => s,
                                    other => other.to_string(),
                                });
                            }
                        }
                    } else {
                        fell_back = Some("this server cannot run a coordinator".to_owned());
                    }
                }
                let made = campaign_driver::start_server(driver.host().as_ref(), &folder, &goal, options).await?;
                driver.poke();
                let mut out = to_json(made)?;
                if let Some(reason) = fell_back {
                    out["coordinatorError"] = json!(reason);
                }
                Ok(out)
            }
            "agent_campaign_approve" => {
                let driver = self.ready_driver()?.clone();
                let id = text(args, "id")?.to_owned();
                let access = args.get("access").and_then(Value::as_str).unwrap_or("ask").to_owned();
                self.server_campaign(&id)?;
                let (data, roots, cfg) = (self.data_folder.clone(), self.roots.clone(), driver.host().config());
                let approved = tokio::task::spawn_blocking(move || {
                    campaign_driver::approve_plan(&data, &roots, &cfg, &id, &access)
                })
                .await
                .map_err(|_| fail(500, "the approval did not finish"))??;
                driver.poke();
                to_json(approved)
            }
            "agent_campaign_finalize" | "agent_campaign_retry_gate" => {
                let driver = self.ready_driver()?.clone();
                let id = text(args, "id")?.to_owned();
                self.server_campaign(&id)?;
                let retry = command == "agent_campaign_retry_gate";
                let seconds = args
                    .get("seconds")
                    .and_then(Value::as_u64)
                    .unwrap_or(600)
                    .clamp(1, campaign_integration::MAX_COMMAND_SECS);
                let (data, owned) =
                    (self.data_folder.clone(), super::session_worktree::owned_root(&self.data_folder)?);
                let allow_checks = self.options.allow_checks;
                let id2 = id.clone();
                if retry {
                    driver.record_client_command(&id, "retry gate", caller);
                }
                let report = tokio::task::spawn_blocking(move || {
                    let plan = campaign_integration::gate_plan(&data, &owned, &id2).map_err(|e| failure(e.message))?;
                    // The gate runs the repository's own build or test command.
                    if plan.command.is_some() && !allow_checks {
                        return Err(fail(
                            403,
                            "this server does not run a project command; start it with --agent-allow-checks to run the gate",
                        ));
                    }
                    if retry {
                        campaign_integration::retry_gate(&data, &owned, &id2, seconds)
                    } else {
                        campaign_integration::finalize(&data, &owned, &id2, seconds)
                    }
                    .map_err(|e| failure(e.message))
                })
                .await
                .map_err(|_| fail(500, "the gate did not finish"))??;
                if let (Some(proposal), Some(runner)) = (&report.proposal_id, &self.runner) {
                    runner.ping("agent-proposal-created", &json!({ "campaignId": id, "proposalId": proposal }));
                }
                driver.poke();
                to_json(report)
            }
            "agent_campaign_gate_repair" => {
                let driver = self.ready_driver()?.clone();
                let id = text(args, "id")?.to_owned();
                self.server_campaign(&id)?;
                let made = driver.gate_repair(&id, caller).await.map_err(failure)?;
                driver.poke();
                to_json(made)
            }
            command if campaign_driver::is_task_command(command) => {
                let driver = self.ready_driver()?.clone();
                let id = text(args, "id")?.to_owned();
                self.server_campaign(&id)?;
                let tid = text(args, "taskId")?.to_owned();
                let task_command = match command {
                    "agent_campaign_skip_task" => {
                        let dependants = match args.get("dependants") {
                            Some(v) if !v.is_null() => serde_json::from_value(v.clone())
                                .map_err(|_| fail(400, "dependants is leave, cascade or release"))?,
                            _ => campaign::SkipDependants::Leave,
                        };
                        TaskCommand::Skip { dependants }
                    }
                    "agent_campaign_retry_task" => TaskCommand::Retry {
                        hint: args.get("hint").and_then(Value::as_str).unwrap_or_default().to_owned(),
                    },
                    "agent_campaign_accept_task" => TaskCommand::Accept {
                        reason: args.get("reason").and_then(Value::as_str).unwrap_or_default().to_owned(),
                    },
                    "agent_campaign_verify_again" => TaskCommand::VerifyAgain,
                    "agent_campaign_resolve" => TaskCommand::Resolve,
                    _ => return Err(fail(404, "Unknown agent command")),
                };
                let done = driver.task_command(&id, &tid, task_command, caller).await.map_err(failure)?;
                driver.poke();
                Ok(done)
            }
            _ => Err(fail(404, "Unknown agent command")),
        }
    }

    /// Start a coordinator conversation for `goal`: a runner session that has
    /// the campaign tools and is told to plan. The campaign exists once it
    /// calls `campaign_plan`, and still waits for a person's approval.
    async fn start_coordinator(
        &self,
        runner: &Arc<Runner>,
        host: &RunnerHost,
        folder: &Path,
        goal: &str,
        options: &campaign_driver::StartOptions,
        caller: &Caller,
    ) -> Result<Value, Fail> {
        let goal = campaign_driver::checked_goal(goal)?;
        campaign_driver::check_repository(host, folder).await?;
        let title = options.title.trim().to_string();
        let title = if title.is_empty() {
            format!("Coordinator: {}", goal.lines().next().unwrap_or(goal).chars().take(60).collect::<String>())
        } else {
            title
        };
        let created = runner
            .call(
                "agent_run_create",
                &json!({
                    "folder": folder.to_string_lossy(),
                    "access": "ask",
                    "role": "coordinator",
                    "model": options.model,
                    "title": title,
                    "worktree": false,
                }),
                caller,
                Some(folder.to_path_buf()),
            )
            .await?;
        let id = created.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
        let seed = format!(
            "You coordinate a campaign on this server. The person's goal is below.\n\n\
Split the work into independent tasks with campaign_plan (up to 12; tasks that run at the same time must not touch \
the same paths). The plan is put to the person for approval and nothing starts before they approve it. After that, \
follow it with campaign_status and campaign_collect, correct a task with campaign_steer, record shared decisions \
with campaign_decide, and tell the person how it went. Do not do the tasks' work yourself.\n\n\
<<<goal\n{}\ngoal>>>",
            campaign_driver::defang(goal)
        );
        if let Err(f) = runner.start_text(&id, seed).await {
            // A session that cannot take its first turn is not left behind.
            let _ = runner.call("agent_run_delete", &json!({ "id": id }), caller, None).await;
            return Err(f);
        }
        Ok(json!({ "coordinator": created, "campaign": Value::Null }))
    }

    /// The canonical form of `raw` when it names an existing path inside a root.
    fn confine(&self, raw: &str) -> Result<PathBuf, Fail> {
        if raw.is_empty() || raw.contains('\0') {
            return Err(fail(400, "invalid path"));
        }
        let path = Path::new(raw)
            .canonicalize()
            .map_err(|_| fail(404, "that folder does not exist on this server"))?;
        if self.roots.iter().any(|root| path.starts_with(root)) {
            Ok(path)
        } else {
            Err(fail(403, "that folder is outside the folders this server allows"))
        }
    }

    /// The chooser lists no hidden, system or dependency folder, so it does
    /// not open one by name either: every step below the root must be one it
    /// would have listed.
    fn browsable(&self, dir: &Path) -> Result<(), Fail> {
        let Some(root) = self.roots.iter().find(|root| dir.starts_with(root)) else {
            return Err(fail(403, "that folder is outside the folders this server allows"));
        };
        let mut at = root.clone();
        for part in dir.strip_prefix(root).unwrap_or(Path::new("")).components() {
            at.push(part);
            let name = part.as_os_str().to_str().unwrap_or(".");
            if !listable(name) || hidden_path(&at) {
                return Err(fail(403, "that folder is not offered"));
            }
        }
        Ok(())
    }

    /// A project folder a read-only question may be about: under a root and
    /// one the folder chooser would offer.
    fn project(&self, args: &Value, key: &str) -> Result<PathBuf, Fail> {
        let dir = self.confine(text(args, key)?)?;
        self.browsable(&dir)?;
        Ok(dir)
    }

    /// The repository `dir` is in, when there is one, refused when it reaches
    /// above the agent roots (a root inside a larger repository would
    /// otherwise show that repository's other files).
    fn repo(&self, dir: &Path) -> Result<Option<PathBuf>, Fail> {
        let Some(root) = git::repo_root(dir) else {
            return Ok(None);
        };
        let root = Path::new(&root).canonicalize().map_err(|_| fail(404, "that repository is not readable"))?;
        if self.roots.iter().any(|r| root.starts_with(r)) {
            Ok(Some(root))
        } else {
            Err(fail(403, "that repository reaches outside the folders this server allows"))
        }
    }

    fn project_read(&self, command: &str, args: &Value) -> Result<Value, Fail> {
        let ui = |e: String| fail(400, e);
        match command {
            "folder_trust_status" => {
                let dir = self.project(args, "folder")?;
                Ok(json!({
                    "folder": text(args, "folder")?,
                    "trusted": folder_trust::is_trusted(&dir),
                    "carries": folder_trust::carries(&dir),
                }))
            }
            "project_tooling" => {
                let dir = self.project(args, "folder")?;
                let never = std::sync::atomic::AtomicBool::new(false);
                match crate::core::agent::tooling::detect(&dir, &never) {
                    Ok(tooling) => {
                        let mut out = to_json(&tooling)?;
                        if let Some(map) = out.as_object_mut() {
                            map.insert("prompt".into(), json!(tooling.render()));
                        }
                        Ok(out)
                    }
                    Err(e) => Err(Fail {
                        status: 422,
                        body: json!({ "kind": e.kind(), "message": e.to_string() }),
                    }),
                }
            }
            "agent_is_git_repo" => {
                let dir = self.project(args, "folder")?;
                Ok(json!(self.repo(&dir)?.is_some()))
            }
            "agent_git_branch" => {
                let dir = self.project(args, "project")?;
                Ok(match self.repo(&dir)? {
                    Some(_) => json!(git::current_branch(&dir)),
                    None => Value::Null,
                })
            }
            "agent_git_status" => {
                let dir = self.project(args, "project")?;
                if self.repo(&dir)?.is_none() {
                    return Ok(Value::Null);
                }
                let scope = git::DiffScope::parse(args.get("scope").and_then(Value::as_str).unwrap_or("all"));
                to_json(git::status(&dir, scope).map_err(ui)?)
            }
            _ => {
                let dir = self.project(args, "project")?;
                if self.repo(&dir)?.is_none() {
                    return Err(fail(400, "that folder is not a git repository"));
                }
                let path = text(args, "path")?;
                match command {
                    "agent_git_file_diff" => {
                        let scope = git::DiffScope::parse(args.get("scope").and_then(Value::as_str).unwrap_or("all"));
                        to_json(git::file_diff(&dir, path, scope, 512 * 1024).map_err(ui)?)
                    }
                    "agent_git_head_file" => to_json(git::head_file(&dir, path).map_err(ui)?),
                    "agent_git_blame" => Ok(json!({
                        "porcelain": git::blame(&dir, path).map_err(ui)?,
                        "webUrl": git::github_web_url(&dir),
                    })),
                    _ => Err(fail(404, "Unknown agent command")),
                }
            }
        }
    }

    pub fn call(&self, command: &str, args: &Value) -> Result<Value, Fail> {
        if is_project_read(command) {
            return self.project_read(command, args);
        }
        match command {
            "agent_server_info" => Ok(self.info()),
            "agent_run_list" => {
                let mut listed = agent_runs::list(&self.data_folder, &self.roots);
                if let (Some(runner), Some(rows)) =
                    (&self.runner, listed.get_mut("sessions").and_then(Value::as_array_mut))
                {
                    rows.iter_mut().for_each(|row| runner.overlay(row));
                }
                Ok(listed)
            }
            "agent_run_get" => {
                let id = text(args, "id")?;
                let mut row = agent_runs::get(&self.data_folder, &self.roots, id)?;
                if let Some(runner) = &self.runner {
                    runner.overlay(&mut row);
                }
                Ok(row)
            }
            "agent_server_folders" => self.folders(args),
            "agent_list_folders" => {
                if !self.browse_budget.take() {
                    return Err(fail(429, "too many folder requests; wait a moment"));
                }
                if let Some(raw) = args.get("path").and_then(Value::as_str) {
                    browse_request(raw)?;
                    if !raw.is_empty() {
                        self.browsable(&self.confine(raw)?)?;
                    }
                }
                self.folders(args)
            }
            "agent_campaign_list" => to_json(campaign::list(&self.data_folder)),
            "agent_campaign_get" => {
                let id = text(args, "id")?;
                to_json(campaign::get(&self.data_folder, id).map_err(|e| failure(e.message))?)
            }
            "agent_campaign_context" => {
                let id = text(args, "id")?;
                let tasks: Vec<String> = field(args, "taskIds")?;
                to_json(
                    campaign::context(&self.data_folder, id, &tasks)
                        .map_err(|e| failure(e.message))?,
                )
            }
            "agent_campaign_events" => {
                let id = text(args, "id")?;
                to_json(campaign::events(&self.data_folder, id).map_err(|e| failure(e.message))?)
            }
            "agent_campaign_transition" => {
                let id = text(args, "id")?;
                let input: campaign::TransitionInput = field(args, "input")?;
                // Pause, resume and cancel only. A task move would skip the
                // verification step, a plan approval would start work, and an
                // integration record names a branch and worktree on this
                // machine; none of those are a remote client's to set.
                if input.task.is_some() || input.integration.is_some() {
                    return Err(fail(403, "this server only pauses, resumes and cancels a campaign"));
                }
                match input.campaign {
                    Some(campaign::CampaignStatus::Paused | campaign::CampaignStatus::Cancelled) => {}
                    Some(campaign::CampaignStatus::Running) => {
                        let current = campaign::get(&self.data_folder, id)
                            .map_err(|e| failure(e.message))?;
                        if current.status != campaign::CampaignStatus::Paused {
                            return Err(fail(403, "only a paused campaign can be resumed from here"));
                        }
                    }
                    _ => {
                        return Err(fail(403, "this server only pauses, resumes and cancels a campaign"));
                    }
                }
                to_json(
                    campaign::transition(&self.data_folder, id, input)
                        .map_err(|e| failure(e.message))?,
                )
            }
            "agent_campaign_cancel" => {
                let id = text(args, "id")?;
                let detail = args.get("detail").and_then(Value::as_str).unwrap_or_default();
                to_json(
                    campaign::cancel(&self.data_folder, id, detail)
                        .map_err(|e| failure(e.message))?,
                )
            }
            "agent_campaign_delete" => {
                let id = text(args, "id")?;
                campaign::delete(&self.data_folder, id).map_err(|e| failure(e.message))?;
                Ok(Value::Null)
            }
            "agent_campaign_plan_update" => {
                let id = text(args, "id")?;
                self.ready_runner()?;
                self.server_campaign(id)?;
                let edit: campaign::PlanEdit = field(args, "edit")?;
                to_json(campaign::plan_update(&self.data_folder, id, edit).map_err(|e| failure(e.message))?)
            }
            "agent_campaign_claim_notice" => {
                let id = text(args, "id")?;
                let key = text(args, "key")?;
                to_json(campaign::claim_notice(&self.data_folder, id, key).map_err(|e| failure(e.message))?)
            }
            "agent_campaign_diff" => {
                let id = text(args, "id")?;
                self.ready_runner()?;
                let owned = super::session_worktree::owned_root(&self.data_folder)?;
                let patches = args.get("patches").and_then(Value::as_bool).unwrap_or(true);
                to_json(
                    campaign_integration::campaign_diff(&self.data_folder, &owned, id, patches)
                        .map_err(|e| failure(e.message))?,
                )
            }
            "agent_campaign_task_diff" => {
                let id = text(args, "id")?;
                let task = text(args, "taskId")?;
                self.ready_runner()?;
                let owned = super::session_worktree::owned_root(&self.data_folder)?;
                let patches = args.get("patches").and_then(Value::as_bool).unwrap_or(true);
                to_json(
                    campaign_integration::task_diff(&self.data_folder, &owned, id, task, patches)
                        .map_err(|e| failure(e.message))?,
                )
            }
            "agent_campaign_gate_plan" => {
                let id = text(args, "id")?;
                self.ready_runner()?;
                let owned = super::session_worktree::owned_root(&self.data_folder)?;
                to_json(
                    campaign_integration::gate_plan(&self.data_folder, &owned, id)
                        .map_err(|e| failure(e.message))?,
                )
            }
            "agent_campaign_refresh" => {
                let id = text(args, "id")?;
                to_json(campaign_integration::refresh(&self.data_folder, id).map_err(|e| failure(e.message))?)
            }
            "agent_campaign_orphans" => {
                self.ready_runner()?;
                let owned = super::session_worktree::owned_root(&self.data_folder)?;
                to_json(campaign_integration::orphans(&self.data_folder, &owned))
            }
            "agent_proposal_list" => {
                let project = self.confine(text(args, "project")?)?;
                to_json(proposal::list(&self.data_folder, &project.to_string_lossy()))
            }
            "agent_proposal_apply" => {
                let approval: proposal::Approval = field(args, "approval")?;
                let stored = proposal::load(&self.data_folder, &approval.proposal_id)
                    .map_err(proposal_failure)?;
                // The destination is the stored proposal's project, never a
                // path from the request; it must still be a folder this
                // server allows.
                let destination = self.confine(&stored.scope.project)?;
                let report = proposal::apply(&self.data_folder, &destination, &approval)
                    .map_err(proposal_failure)?;
                to_json(report)
            }
            "agent_proposal_reject" => {
                let id = text(args, "id")?;
                let scope: proposal::ProposalScope = field(args, "scope")?;
                let stored = proposal::load(&self.data_folder, id).map_err(proposal_failure)?;
                self.confine(&stored.scope.project)?;
                to_json(
                    proposal::reject(&self.data_folder, id, &scope).map_err(proposal_failure)?,
                )
            }
            _ => Err(fail(404, "Unknown agent command")),
        }
    }

    /// The server-sent-events replay of one session (`GET
    /// /api/v1/agent/sessions/<id>/events?after=<seq>`), as a finite body.
    pub fn replay(&self, id: &str, after: u64) -> Result<String, Fail> {
        agent_runs::replay(&self.data_folder, &self.roots, id, after)
    }

    /// What this server will and will not do, for the client's probe. `missing`
    /// is in words a person can act on.
    fn info(&self) -> Value {
        let backend = jail::backend();
        let missing = self.missing();
        let ready = missing.is_empty() && self.runner.is_some();
        let folders: Vec<_> = self.roots.iter().map(|r| r.to_string_lossy()).collect();
        json!({
            "agent": true,
            "folders": folders,
            "roots": folders,
            // What this server will not do, so a client can say so rather
            // than offer a button that fails.
            "runsSessions": ready,
            // Whether this server may run a project's own commands. P2 has no
            // such runner; the operator's switch is reported as it stands.
            "runsChecks": self.options.allow_checks,
            "runsWorktrees": ready,
            // Campaigns whose driver is this server (P3): created here,
            // planned by the server's model, run with no client connected.
            "runsCampaigns": ready && self.driver.is_some(),
            // The task and gate moves a client may ask of a campaign this
            // server drives (retry, skip, accept anyway, verify again,
            // resolve, gate repair and retry). Empty when it drives none.
            "campaignCommands": if ready && self.driver.is_some() {
                json!(campaign_driver::TASK_COMMANDS)
            } else {
                json!([])
            },
            "runRequested": self.run,
            "runnerPlanned": true,
            "sandbox": backend.as_str(),
            "enforces": backend.enforces(),
            "maxSessions": self.options.max_sessions,
            "allowBypass": self.options.allow_bypass,
            "allowAlways": self.options.allow_always,
            "approvalTimeoutSecs": self.options.approval_timeout.as_secs(),
            "liveSessions": self.runner.as_ref().map_or(0, |r| r.live_count()),
            "missing": missing,
            "parityGaps": PARITY_GAPS,
        })
    }

    fn folders(&self, args: &Value) -> Result<Value, Fail> {
        let wanted = args.get("path").and_then(Value::as_str).filter(|p| !p.is_empty());
        let Some(wanted) = wanted else {
            let entries: Vec<Value> = self.roots.iter().map(|p| entry(p)).collect();
            return Ok(json!({ "path": null, "parent": null, "entries": entries }));
        };
        let dir = self.confine(wanted)?;
        if !dir.is_dir() {
            return Err(fail(400, "that is not a folder"));
        }
        let parent = dir
            .parent()
            .filter(|p| self.roots.iter().any(|r| p.starts_with(r)))
            .map(|p| p.to_string_lossy().into_owned());
        let mut entries: Vec<Value> = std::fs::read_dir(&dir)
            .map_err(|_| fail(403, "that folder cannot be read"))?
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter(|e| e.file_name().to_str().is_some_and(listable))
            .filter(|e| !hidden_or_system(e))
            // A link is listed only when it stays inside the roots.
            .filter_map(|e| e.path().canonicalize().ok())
            .filter(|p| self.roots.iter().any(|r| p.starts_with(r)))
            .map(|p| entry(&p))
            .collect();
        entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        let truncated = entries.len() > MAX_FOLDER_ENTRIES;
        entries.truncate(MAX_FOLDER_ENTRIES);
        Ok(json!({
            "path": dir.to_string_lossy(),
            "parent": parent,
            "entries": entries,
            "truncated": truncated,
        }))
    }
}

/// Windows marks some folders hidden or system without a leading dot.
fn hidden_or_system(entry: &std::fs::DirEntry) -> bool {
    hidden_path(&entry.path())
}

#[cfg(windows)]
fn hidden_path(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    std::fs::symlink_metadata(path)
        .map(|m| m.file_attributes() & (HIDDEN | SYSTEM) != 0)
        .unwrap_or(true)
}

#[cfg(not(windows))]
fn hidden_path(_path: &Path) -> bool {
    false
}

fn entry(path: &Path) -> Value {
    json!({
        "name": path.file_name().map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
        "path": path.to_string_lossy(),
        "git": path.join(".git").exists(),
    })
}

fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str, Fail> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| fail(400, format!("{key} is required")))
}

fn field<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, Fail> {
    let value = args
        .get(key)
        .cloned()
        .ok_or_else(|| fail(400, format!("{key} is required")))?;
    serde_json::from_value(value).map_err(|e| fail(400, format!("{key} is not valid: {e}")))
}

fn to_json<T: serde::Serialize>(value: T) -> Result<Value, Fail> {
    serde_json::to_value(value).map_err(|_| fail(500, "could not encode the answer"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_in_a_folder_name_is_a_name_character() {
        let (data, work) = pair();
        for name in ["100%done", "pct%20dir", "%2e%2e", "pct%2520dir"] {
            std::fs::create_dir_all(work.path().join(name)).unwrap();
        }
        let agent = Agent::open(data.path(), &[work.path().to_path_buf()]).unwrap().unwrap();
        let root = agent.roots[0].to_string_lossy().into_owned();
        let sep = std::path::MAIN_SEPARATOR;
        let list = |p: String| agent.call("agent_list_folders", &json!({ "path": p }));
        // Real folders whose names hold `%`, escapes included, open as named.
        for name in ["100%done", "pct%20dir", "%2e%2e", "pct%2520dir"] {
            assert!(list(format!("{root}{sep}{name}")).is_ok(), "{name}");
        }
        // Encoded traversal is not decoded into one: no such folder exists.
        for p in [
            format!("{root}{sep}%2e%2e{sep}%2e%2e"),
            format!("{root}{sep}..%2f..%2f"),
            format!("{root}{sep}app%2f..%2f.."),
            format!("{root}{sep}%252e%252e"),
        ] {
            let err = list(p.clone()).unwrap_err();
            assert_eq!(err.status, 404, "{p}");
        }
    }

    fn pair() -> (tempfile::TempDir, tempfile::TempDir) {
        (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap())
    }

    #[test]
    fn off_without_a_root() {
        let (data, _) = pair();
        assert!(Agent::open(data.path(), &[]).unwrap().is_none());
    }

    #[test]
    fn a_root_may_not_overlap_the_data_folder() {
        let (data, _) = pair();
        let inside = data.path().join("projects");
        std::fs::create_dir_all(&inside).unwrap();
        assert!(Agent::open(data.path(), &[inside]).is_err());
        let parent = data.path().parent().unwrap().to_path_buf();
        assert!(Agent::open(data.path(), &[parent]).is_err());
    }

    #[test]
    fn a_missing_root_is_an_error_not_a_narrower_server() {
        let (data, work) = pair();
        let gone = work.path().join("nope");
        assert!(Agent::open(data.path(), &[gone]).is_err());
    }

    #[test]
    fn paths_stay_inside_the_roots() {
        let (data, work) = pair();
        let project = work.path().join("app");
        std::fs::create_dir_all(&project).unwrap();
        let agent = Agent::open(data.path(), &[work.path().to_path_buf()])
            .unwrap()
            .unwrap();
        assert!(agent.confine(&project.to_string_lossy()).is_ok());
        let outside = agent.confine(&data.path().to_string_lossy()).unwrap_err();
        assert_eq!(outside.status, 403);
        let climbing = work.path().join("app").join("..").join("..");
        assert!(agent.confine(&climbing.to_string_lossy()).is_err());
        assert_eq!(agent.confine("").unwrap_err().status, 400);
    }

    #[test]
    fn list_folders_refuses_traversal_and_foreign_paths() {
        let (data, work) = pair();
        std::fs::create_dir_all(work.path().join("app/src")).unwrap();
        let agent = Agent::open(data.path(), &[work.path().to_path_buf()])
            .unwrap()
            .unwrap();
        assert!(handles("agent_list_folders"));
        let list = |p: &str| agent.call("agent_list_folders", &json!({ "path": p }));
        let root = agent.roots[0].to_string_lossy().into_owned();
        let name = agent.roots[0].file_name().unwrap().to_string_lossy().into_owned();
        let sep = std::path::MAIN_SEPARATOR;
        assert!(list(&root).is_ok());
        assert!(list(&format!("{root}{sep}app{sep}src")).is_ok());
        assert!(agent.call("agent_list_folders", &json!({})).is_ok());
        for p in [
            format!("{root}{sep}app{sep}.."),
            format!("{root}{sep}..{sep}{name}"),
            format!("{root}{sep}.{sep}app"),
            "app".to_owned(),
            "..".to_owned(),
            r"\\server\share\x".to_owned(),
            "//server/share/x".to_owned(),
            r"\\?\UNC\server\share".to_owned(),
            r"\\.\PhysicalDrive0".to_owned(),
            format!("{root}\u{0}x"),
            format!("{root}{sep}{}", "a".repeat(2000)),
        ] {
            assert_eq!(list(&p).unwrap_err().status, 400, "{p}");
        }
        // Hidden and dependency folders are not listed, nor opened by name.
        std::fs::create_dir_all(work.path().join(".secret/inner")).unwrap();
        std::fs::create_dir_all(work.path().join("node_modules/pkg")).unwrap();
        for p in [
            format!("{root}{sep}.secret"),
            format!("{root}{sep}.secret{sep}inner"),
            format!("{root}{sep}node_modules{sep}pkg"),
        ] {
            assert_eq!(list(&p).unwrap_err().status, 403, "{p}");
        }
        let foreign = data.path().canonicalize().unwrap();
        let foreign = foreign.to_string_lossy().trim_start_matches(r"\\?\").to_owned();
        assert_eq!(list(&foreign).unwrap_err().status, 403);
        #[cfg(windows)]
        for p in [r"C:\Windows", r"\\?\C:\Windows"] {
            assert_eq!(list(p).unwrap_err().status, 403, "{p}");
        }
    }

    #[test]
    fn list_folders_skips_links_that_leave_the_roots() {
        let (data, work) = pair();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(work.path().join("app")).unwrap();
        let link = work.path().join("escape");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(outside.path(), &link).is_ok()
            || std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(outside.path())
                .output()
                .is_ok_and(|o| o.status.success());
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(outside.path(), &link).is_ok();
        assert!(made, "could not create a link to test with");
        let agent = Agent::open(data.path(), &[work.path().to_path_buf()])
            .unwrap()
            .unwrap();
        let root = agent.roots[0].to_string_lossy().into_owned();
        let listed = agent.call("agent_list_folders", &json!({ "path": root })).unwrap();
        let names: Vec<&str> = listed["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["app"]);
        let through = format!("{root}{}escape", std::path::MAIN_SEPARATOR);
        assert_eq!(
            agent
                .call("agent_list_folders", &json!({ "path": through }))
                .unwrap_err()
                .status,
            403
        );
    }

    #[test]
    fn list_folders_is_rate_limited() {
        let budget = Budget::default();
        for _ in 0..Budget::LIMIT {
            assert!(budget.take());
        }
        assert!(!budget.take());
    }

    #[test]
    fn folders_lists_roots_then_children_and_hides_the_rest() {
        let (data, work) = pair();
        std::fs::create_dir_all(work.path().join("app/.git")).unwrap();
        std::fs::create_dir_all(work.path().join("node_modules")).unwrap();
        std::fs::create_dir_all(work.path().join(".hidden")).unwrap();
        let agent = Agent::open(data.path(), &[work.path().to_path_buf()])
            .unwrap()
            .unwrap();
        let roots = agent.call("agent_server_folders", &json!({})).unwrap();
        assert_eq!(roots["entries"].as_array().unwrap().len(), 1);
        let root = roots["entries"][0]["path"].as_str().unwrap().to_owned();
        let listed = agent
            .call("agent_server_folders", &json!({ "path": root }))
            .unwrap();
        let names: Vec<&str> = listed["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["app"]);
        assert_eq!(listed["entries"][0]["git"], true);
    }

    #[test]
    fn run_flag_needs_a_root_and_is_reported_not_ready() {
        let (data, work) = pair();
        assert!(Agent::open_with(data.path(), &[], true).is_err());
        assert!(Agent::open_with(data.path(), &[], false).unwrap().is_none());
        let agent = Agent::open_with(data.path(), &[work.path().to_path_buf()], true)
            .unwrap()
            .unwrap();
        let info = agent.call("agent_server_info", &json!({})).unwrap();
        assert_eq!(info["runRequested"], true);
        // No runner built (`with_runner` not called): never advertised.
        assert_eq!(info["runsSessions"], false);
        assert_eq!(info["runnerPlanned"], true);
        assert!(info["sandbox"].is_string());
        assert!(info["enforces"].is_boolean());
        assert_eq!(info["maxSessions"], 4);
        assert_eq!(info["allowBypass"], false);
        assert_eq!(info["allowAlways"], false);
        assert!(!info["parityGaps"].as_array().unwrap().is_empty());
        // With the runner built, readiness follows the sandbox alone.
        let built = Agent::open_with(data.path(), &[work.path().to_path_buf()], true)
            .unwrap()
            .unwrap()
            .with_runner(RunnerOptions::default(), super::super::events::Bus::new());
        let info = built.call("agent_server_info", &json!({})).unwrap();
        assert_eq!(info["runsSessions"], jail::backend().enforces());
        let lax = Agent::open_with(data.path(), &[work.path().to_path_buf()], true)
            .unwrap()
            .unwrap()
            .with_runner(
                RunnerOptions { require_sandbox: false, ..Default::default() },
                super::super::events::Bus::new(),
            );
        assert_eq!(lax.call("agent_server_info", &json!({})).unwrap()["runsSessions"], true);
        let off = Agent::open(data.path(), &[work.path().to_path_buf()]).unwrap().unwrap();
        assert_eq!(off.call("agent_server_info", &json!({})).unwrap()["runRequested"], false);
    }

    #[test]
    fn run_views_are_confined_and_require_an_id() {
        let (data, work) = pair();
        let agent = Agent::open(data.path(), &[work.path().to_path_buf()]).unwrap().unwrap();
        let listed = agent.call("agent_run_list", &json!({})).unwrap();
        assert!(listed["sessions"].as_array().unwrap().is_empty());
        assert_eq!(agent.call("agent_run_get", &json!({})).unwrap_err().status, 400);
        assert_eq!(
            agent.call("agent_run_get", &json!({ "id": "missing" })).unwrap_err().status,
            404
        );
        assert!(agent.replay("../etc", 0).is_err());
        assert!(handles("agent_run_list") && handles("agent_run_get"));
    }

    #[test]
    fn only_the_listed_commands_are_handled() {
        assert!(handles("agent_campaign_list"));
        assert!(handles("agent_proposal_apply"));
        // The runners, the tool executor and anything that spawns stay out.
        for refused in [
            "agent_campaign_finalize",
            "agent_campaign_verify_prepare",
            "agent_campaign_merge_task",
            "agent_campaign_create",
            "agent_worktree_discard",
            "agent_worktree_merge",
            "plugin:agent-tools|execute_tool",
            "plugin:agent-tools|direct_edit_authorize",
        ] {
            assert!(!handles(refused), "{refused}");
        }
    }

    #[test]
    fn a_proposal_for_an_outside_project_is_not_listed() {
        let (data, work) = pair();
        let agent = Agent::open(data.path(), &[work.path().to_path_buf()])
            .unwrap()
            .unwrap();
        let answer = agent
            .call("agent_proposal_list", &json!({ "project": data.path().to_string_lossy() }))
            .unwrap_err();
        assert_eq!(answer.status, 403);
    }

    #[test]
    fn a_client_can_only_pause_resume_or_cancel() {
        let (data, work) = pair();
        let agent = Agent::open(data.path(), &[work.path().to_path_buf()])
            .unwrap()
            .unwrap();
        for input in [
            json!({ "campaign": "paused", "integration": { "branch": "flint/x", "worktree": "C:/elsewhere" } }),
            json!({ "task": { "taskId": "t1", "to": "verified" } }),
            json!({ "campaign": "approved" }),
        ] {
            let outcome =
                agent.call("agent_campaign_transition", &json!({ "id": "c1", "input": input }));
            // Refused by shape or by policy; it never reaches the store.
            assert!(outcome.is_err(), "{input}");
        }
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    #[test]
    fn project_reads_stay_inside_the_roots() {
        let (data, work) = pair();
        let app = work.path().join("app");
        std::fs::create_dir_all(&app).unwrap();
        git(&app, &["init", "-q"]);
        std::fs::write(app.join("a.txt"), "one
").unwrap();
        let agent = Agent::open(data.path(), &[work.path().to_path_buf()]).unwrap().unwrap();
        for c in ["folder_trust_status", "project_tooling", "agent_git_status", "agent_git_blame"] {
            assert!(handles(c), "{c}");
        }
        let app_s = app.to_string_lossy().into_owned();
        let status = agent.call("agent_git_status", &json!({ "project": app_s, "scope": "all" })).unwrap();
        assert!(status.to_string().contains("a.txt"), "{status}");
        assert_eq!(agent.call("agent_is_git_repo", &json!({ "folder": app_s })).unwrap(), json!(true));
        assert!(agent.call("folder_trust_status", &json!({ "folder": app_s })).is_ok());
        assert!(agent.call("project_tooling", &json!({ "folder": app_s })).is_ok());
        // A path that climbs out of the repository is refused.
        let climb = agent.call("agent_git_head_file", &json!({ "project": app_s, "path": "../x" }));
        assert_eq!(climb.unwrap_err().status, 400);
        // A folder outside the roots is refused.
        let outside = data.path().to_string_lossy().into_owned();
        let refused = agent.call("agent_git_status", &json!({ "project": outside, "scope": "all" }));
        assert_eq!(refused.unwrap_err().status, 403);
        // A root inside a larger repository does not show that repository.
        let (data2, outer) = pair();
        git(outer.path(), &["init", "-q"]);
        let inner = outer.path().join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        let nested = Agent::open(data2.path(), std::slice::from_ref(&inner)).unwrap().unwrap();
        let inner_s = inner.to_string_lossy().into_owned();
        let above = nested.call("agent_git_status", &json!({ "project": inner_s, "scope": "all" }));
        assert_eq!(above.unwrap_err().status, 403);
    }
}
