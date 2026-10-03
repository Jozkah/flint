//! User-configured commands run at defined points in a run. AH-127, AH-128,
//! AH-129.
//!
//! A hook is a shell command the *user* asks to be run when something happens:
//! before a tool call, after one, when a session starts, when a run ends. It is
//! the escape hatch for everything the harness does not do itself -- a linter
//! before every write, a notification when a run ends, a policy check that
//! refuses a command the project does not allow.
//!
//! The things that make a hook safe to have at all:
//!
//! * **The model cannot write one.** Hooks are read from
//!   `<project>/.jan/agent/hooks.toml`, and `.jan` is refused to every
//!   file-writing tool and to `bash` (see
//!   [`crate::tools::sandbox::is_hidden_jan_path`]). A model that decides it
//!   would like a hook cannot create one, and a hook file reached through a
//!   symlink out of the project is not read.
//! * **A hook is not more privileged than a tool.** It runs through the same
//!   shell, under the same jail policy and the same deadline discipline as
//!   `bash`: the project is the workspace, the network is open only if the run
//!   already allows it, and the time limit is bounded by the harness, not by
//!   the file.
//! * **A hook is told almost nothing.** The event, the tool's name and the
//!   project root. No prompt, no message, no provider key, no authorization
//!   header -- so a hook cannot become a way to read the conversation out of
//!   the process.
//! * **What it can do is declared.** `on_failure` says what a failing hook
//!   means: `block` refuses the thing the hook ran before, `warn` lets it
//!   proceed and says so, `ignore` is advisory. A `block` hook can only stop
//!   work; it can never grant any.
//!
//! Everything the file gets wrong is a typed refusal that names the file and
//! the line-level reason, and a malformed file disables hooks rather than
//! silently running a subset of them -- half a policy is not a policy.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// The most hooks one project may declare.
pub const MAX_HOOKS: usize = 32;
/// The most characters one hook command may be.
pub const MAX_COMMAND: usize = 4096;
/// The longest a hook may be given, whatever the file says.
pub const MAX_TIMEOUT_SECS: u64 = 120;
/// The default when the file does not say.
pub const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// The most hook output kept, per hook, in what is shown or recorded.
pub const MAX_OUTPUT: usize = 4096;

/// Where in a run a hook runs.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Event {
    /// Before a tool call is executed. The only event whose hook can block.
    PreTool,
    /// After a tool call has produced its result.
    PostTool,
    /// Once per assistant turn, after every tool call of that turn has its
    /// result and before the next model request. Observe-only: it is fired
    /// detached by [`fire_post_tool_batch`] and can neither block nor alter
    /// anything.
    PostToolBatch,
    /// Once, when a session begins.
    ///
    /// Declared and not yet fired: parsing refuses it rather than accepting a
    /// hook that would silently never run. See [`Event::parse`].
    SessionStart,
    /// Once, when a run ends, however it ended.
    RunEnd,
}

impl Event {
    pub fn as_str(self) -> &'static str {
        match self {
            Event::PreTool => "pre-tool",
            Event::PostTool => "post-tool",
            Event::PostToolBatch => "post-tool-batch",
            Event::SessionStart => "session-start",
            Event::RunEnd => "run-end",
        }
    }

    /// The events a hook may be declared for *and that something fires*.
    ///
    /// `session-start` is deliberately absent: nothing calls it yet, and a
    /// configuration file that accepts a hook which never runs is worse than
    /// one that refuses it -- the file reads as enforced and is not.
    fn parse(raw: &str) -> Option<Event> {
        match raw {
            "pre-tool" => Some(Event::PreTool),
            "post-tool" => Some(Event::PostTool),
            "post-tool-batch" => Some(Event::PostToolBatch),
            "run-end" => Some(Event::RunEnd),
            _ => None,
        }
    }

    /// Whether a failing hook at this point can stop anything.
    ///
    /// Only `pre-tool` can: by the time the other three run, the thing they
    /// would refuse has already happened, and a "block" there would be a
    /// refusal of something that cannot be taken back.
    pub fn can_block(self) -> bool {
        matches!(self, Event::PreTool)
    }
}

/// What a hook's failure means.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OnFailure {
    /// Refuse the work the hook ran before. `pre-tool` only.
    Block,
    /// Let the work proceed, and say the hook failed.
    Warn,
    /// Advisory: recorded, and nothing else.
    Ignore,
}

impl OnFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            OnFailure::Block => "block",
            OnFailure::Warn => "warn",
            OnFailure::Ignore => "ignore",
        }
    }

    fn parse(raw: &str) -> Option<OnFailure> {
        match raw {
            "block" => Some(OnFailure::Block),
            "warn" => Some(OnFailure::Warn),
            "ignore" => Some(OnFailure::Ignore),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HookErrorKind {
    /// The file is not valid TOML, or a hook is missing something it needs.
    Malformed,
    /// An event or failure policy this build does not have.
    Unknown,
    /// A limit in this file: too many hooks, too long a command, a timeout
    /// outside what the harness allows.
    TooBig,
    /// The file is not inside the project it claims to configure -- a symlink
    /// out of the workspace, most likely.
    Escapes,
    /// `block` asked for where nothing can be blocked.
    CannotBlock,
    /// The hook ran and failed.
    Failed,
    /// The hook outlived its limit and was stopped.
    TimedOut,
    /// The hook was cancelled with the work it belonged to.
    Cancelled,
    /// No shell that could be confined here can run this hook as written.
    ShellUnavailable,
    /// The file could not be read.
    Io,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HookError {
    pub kind: HookErrorKind,
    pub message: String,
}

impl HookError {
    pub fn new(kind: HookErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: crate::harness_error::scrub(&message.into()) }
    }
}

/// What this failure is in the harness's own vocabulary (AH-009).
///
/// Written case by case on purpose. A malformed hook file is the user's to
/// fix and must never be retried into working; a hook that failed is a policy
/// decision, not an internal error; a timeout is a timeout everywhere.
impl From<&HookError> for crate::harness_error::HarnessError {
    fn from(error: &HookError) -> Self {
        use crate::harness_error::{ErrorKind, HarnessError, Stage};
        let kind = match error.kind {
            HookErrorKind::Malformed | HookErrorKind::Unknown | HookErrorKind::TooBig => {
                ErrorKind::InvalidInput
            }
            // A hook file reached through a symlink out of the project is the
            // sandbox's business, not a configuration mistake.
            HookErrorKind::Escapes => ErrorKind::SandboxDenied,
            HookErrorKind::CannotBlock => ErrorKind::InvalidInput,
            HookErrorKind::Failed => ErrorKind::PolicyViolation,
            HookErrorKind::TimedOut => ErrorKind::Timeout,
            HookErrorKind::Cancelled => ErrorKind::Cancelled,
            // Not the user's mistake and not a failure of the hook: this
            // machine cannot run it under confinement at all.
            HookErrorKind::ShellUnavailable => ErrorKind::Unsupported,
            HookErrorKind::Io => ErrorKind::Io,
        };
        let harness = HarnessError::new(kind, error.message.clone()).at(Stage::Tool);
        match error.kind {
            // A hook that was stopped is never re-run on the harness's own
            // initiative. It already started, whatever it did to the project
            // is done, and running it again is a second side effect rather
            // than a second chance.
            HookErrorKind::TimedOut | HookErrorKind::Cancelled => {
                harness.with_retry(crate::harness_error::Retry::Never)
            }
            _ => harness,
        }
    }
}

/// One configured hook.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hook {
    pub event: Event,
    pub command: String,
    pub on_failure: OnFailure,
    pub timeout_secs: u64,
    /// Tool names this hook applies to. Empty means every tool. Ignored for
    /// events that are not about a tool.
    #[serde(default)]
    pub tools: Vec<String>,
}

impl Hook {
    fn applies_to(&self, event: Event, tool: Option<&str>) -> bool {
        if self.event != event {
            return false;
        }
        match (tool, self.tools.is_empty()) {
            (_, true) => true,
            (Some(name), false) => self.tools.iter().any(|t| t == name),
            (None, false) => false,
        }
    }
}

/// Where a project's hooks are declared.
pub fn config_path(project_root: &Path) -> PathBuf {
    project_root.join(".jan").join("agent").join("hooks.toml")
}

/// Read a project's hooks.
///
/// A project with no file has no hooks, which is not an error. A file that is
/// wrong is an error and leaves the project with *no* hooks rather than the
/// ones that happened to parse: a policy file that is half-applied is worse
/// than one that is refused out loud.
pub fn load(project_root: &Path) -> Result<Vec<Hook>, HookError> {
    let path = config_path(project_root);
    let raw = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(HookError::new(HookErrorKind::Io, format!("hooks.toml: {e}"))),
    };
    // The file has to be the project's own. A `.jan/agent/hooks.toml` that is
    // a symlink to somewhere else means someone outside the project decides
    // what runs inside it.
    if crate::tools::sandbox::symlink_escapes_root(project_root, None, &path) {
        return Err(HookError::new(
            HookErrorKind::Escapes,
            "hooks.toml resolves outside the project and was not read",
        ));
    }
    parse(&raw)
}

/// Parse a hooks file. Separate from [`load`] so the rules can be tested
/// without a filesystem.
pub fn parse(raw: &str) -> Result<Vec<Hook>, HookError> {
    let doc: toml::Value = toml::from_str(raw)
        .map_err(|e| HookError::new(HookErrorKind::Malformed, format!("hooks.toml: {e}")))?;
    let list = match doc.get("hook") {
        None => return Ok(Vec::new()),
        Some(toml::Value::Array(items)) => items.clone(),
        Some(_) => {
            return Err(HookError::new(
                HookErrorKind::Malformed,
                "hooks.toml: `hook` must be a list of [[hook]] tables",
            ))
        }
    };
    if list.len() > MAX_HOOKS {
        return Err(HookError::new(
            HookErrorKind::TooBig,
            format!("hooks.toml declares {} hooks; at most {MAX_HOOKS} are read", list.len()),
        ));
    }

    let mut hooks = Vec::with_capacity(list.len());
    for (index, item) in list.iter().enumerate() {
        let at = index + 1;
        let str_field = |name: &str| item.get(name).and_then(toml::Value::as_str);
        let event_raw = str_field("event").ok_or_else(|| {
            HookError::new(HookErrorKind::Malformed, format!("hook {at}: no `event`"))
        })?;
        let event = Event::parse(event_raw).ok_or_else(|| {
            HookError::new(
                HookErrorKind::Unknown,
                format!("hook {at}: `{event_raw}` is not an event this build runs"),
            )
        })?;
        let command = str_field("command")
            .ok_or_else(|| {
                HookError::new(HookErrorKind::Malformed, format!("hook {at}: no `command`"))
            })?
            .trim()
            .to_string();
        if command.is_empty() {
            return Err(HookError::new(
                HookErrorKind::Malformed,
                format!("hook {at}: `command` is empty"),
            ));
        }
        if command.chars().count() > MAX_COMMAND {
            return Err(HookError::new(
                HookErrorKind::TooBig,
                format!("hook {at}: `command` is longer than {MAX_COMMAND} characters"),
            ));
        }
        let policy_raw = str_field("on_failure").unwrap_or("warn");
        let on_failure = OnFailure::parse(policy_raw).ok_or_else(|| {
            HookError::new(
                HookErrorKind::Unknown,
                format!("hook {at}: `{policy_raw}` is not a failure policy"),
            )
        })?;
        if on_failure == OnFailure::Block && !event.can_block() {
            return Err(HookError::new(
                HookErrorKind::CannotBlock,
                format!(
                    "hook {at}: `block` needs an event that runs before the work it refuses; \
                     `{}` runs after it",
                    event.as_str()
                ),
            ));
        }
        let timeout_secs = match item.get("timeout_secs") {
            None => DEFAULT_TIMEOUT_SECS,
            Some(v) => {
                let secs = v.as_integer().filter(|n| *n > 0).ok_or_else(|| {
                    HookError::new(
                        HookErrorKind::Malformed,
                        format!("hook {at}: `timeout_secs` must be a positive whole number"),
                    )
                })? as u64;
                if secs > MAX_TIMEOUT_SECS {
                    return Err(HookError::new(
                        HookErrorKind::TooBig,
                        format!(
                            "hook {at}: `timeout_secs` {secs} is longer than the {MAX_TIMEOUT_SECS}s \
                             a hook may be given"
                        ),
                    ));
                }
                secs
            }
        };
        let tools = match item.get("tools") {
            None => Vec::new(),
            Some(toml::Value::Array(names)) => names
                .iter()
                .filter_map(toml::Value::as_str)
                .map(str::to_string)
                .collect(),
            Some(_) => {
                return Err(HookError::new(
                    HookErrorKind::Malformed,
                    format!("hook {at}: `tools` must be a list of tool names"),
                ))
            }
        };
        hooks.push(Hook { event, command, on_failure, timeout_secs, tools });
    }
    Ok(hooks)
}

/// What one hook did.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HookRun {
    pub event: Event,
    pub on_failure: OnFailure,
    /// The tool this ran around, when it ran around one.
    #[serde(default)]
    pub tool: Option<String>,
    pub ok: bool,
    /// Bounded and scrubbed. A hook's output is a diagnostic, not a channel.
    pub output: String,
    #[serde(default)]
    pub error: Option<HookError>,
}

/// What the hooks for one point decided.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    /// Set when a `block` hook failed: the work must not proceed.
    #[serde(default)]
    pub blocked: Option<HookError>,
    /// Failures the run should be told about but not stopped for.
    #[serde(default)]
    pub warnings: Vec<HookError>,
    pub runs: Vec<HookRun>,
}

impl Decision {
    pub fn allowed(&self) -> bool {
        self.blocked.is_none()
    }
}

/// How a hook is run. Given rather than read from the environment so the
/// caller's jail decisions are the ones that apply, and so tests can run a
/// hook without a project.
pub struct Context<'a> {
    pub project_root: &'a Path,
    pub allow_network: bool,
    pub home_readonly: bool,
    /// Whether this surface confines tool execution. A hook is confined
    /// exactly when `bash` would be on the same surface -- AH-128 is that a
    /// hook is never the more privileged way to run a command.
    pub sandbox: bool,
    /// The Jan data folder, masked from the hook exactly as it is masked from
    /// `bash`. Without this a repository's hook could read `settings.json` and
    /// the provider keys in it on a surface where the shell tool cannot --
    /// which would make a hook the more privileged way to run a command, the
    /// one thing AH-128 says it must never be.
    pub mask_root: Option<&'a Path>,
    /// Stops the hook when the work it belongs to is stopped.
    pub cancel: Option<crate::lifecycle::Token>,
}

/// Run every hook configured for this point, in the order the file declares.
///
/// A `block` hook that fails stops the remaining hooks too: the decision is
/// already made, and running more commands after refusing the work is just
/// more side effects.
pub async fn run(hooks: &[Hook], event: Event, tool: Option<&str>, ctx: &Context<'_>) -> Decision {
    run_with_env(hooks, event, tool, ctx, &[]).await
}

/// [`run`] with extra environment variables for the hook (the batch event's
/// tool list). The names are the harness's, never the model's or the file's.
async fn run_with_env(
    hooks: &[Hook],
    event: Event,
    tool: Option<&str>,
    ctx: &Context<'_>,
    extra_env: &[(&str, String)],
) -> Decision {
    let mut decision = Decision::default();
    for hook in hooks.iter().filter(|h| h.applies_to(event, tool)) {
        let (ok, output, error) = execute(hook, event, tool, ctx, extra_env).await;
        if !ok {
            let error = error.clone().unwrap_or_else(|| {
                HookError::new(HookErrorKind::Failed, "the hook failed with no output")
            });
            match hook.on_failure {
                OnFailure::Block => decision.blocked = Some(error.clone()),
                OnFailure::Warn => decision.warnings.push(error.clone()),
                OnFailure::Ignore => {}
            }
        }
        decision.runs.push(HookRun {
            event,
            on_failure: hook.on_failure,
            tool: tool.map(str::to_string),
            ok,
            output,
            error,
        });
        if decision.blocked.is_some() {
            break;
        }
    }
    decision
}

/// Run one hook and say how it went.
async fn execute(
    hook: &Hook,
    event: Event,
    tool: Option<&str>,
    ctx: &Context<'_>,
    extra_env: &[(&str, String)],
) -> (bool, String, Option<HookError>) {
    use crate::tools::{jail, proc};

    let mut policy = jail::Policy::new(ctx.project_root, ctx.allow_network)
        .with_home_readonly(ctx.home_readonly);
    if let Some(mask) = ctx.mask_root {
        policy = policy.with_mask_root(mask);
    }
    if ctx.sandbox {
        // The project's own `.jan` is hidden from a confined hook for the same
        // reason it is hidden from a confined shell: it is where the harness
        // keeps what it was told to do.
        policy = policy.with_hide_root(&ctx.project_root.join(".jan"));
    }
    // Which shell can be confined is probed, not assumed -- the same decision
    // `bash` makes, for the same reason: on Windows the MSYS runtime cannot
    // start inside an AppContainer, and running the hook unconfined instead
    // would hand it the whole machine.
    let shell = if ctx.sandbox {
        let mut selected = match jail::select_shell(&policy) {
            Ok(selected) => selected,
            Err(detail) => {
                return (
                    false,
                    String::new(),
                    Some(HookError::new(
                        HookErrorKind::ShellUnavailable,
                        format!("no shell could be started in a sandbox on this system: {detail}"),
                    )),
                )
            }
        };
        // A hook written for a POSIX shell is refused rather than handed to
        // PowerShell or cmd, which would run *something* -- just not what the
        // file asked for, and a policy hook that silently runs something else
        // is worse than one that does not run.
        if selected.report.cfg.flavor != proc::ShellFlavor::Posix {
            if let Some(construct) = proc::requires_posix_shell_for(&hook.command, selected.report.cfg.flavor) {
                return (
                    false,
                    String::new(),
                    Some(HookError::new(
                        HookErrorKind::ShellUnavailable,
                        format!(
                            "this hook uses {construct}, which needs a POSIX shell, and none could \
                             be started in the sandbox here"
                        ),
                    )),
                );
            }
        }
        // `&&`/`||` are a parse error in Windows PowerShell 5.1. A hook that
        // chains is re-selected onto a shell that keeps their short-circuit
        // semantics (cmd), the same way the bash tool is, and only refused when
        // no usable shell can chain. Safe because a POSIX-only hook was already
        // refused just above.
        if proc::requires_and_or_chaining(&hook.command).is_some()
            && !proc::supports_and_or_chaining(&selected.report.cfg)
        {
            match jail::select_chaining_capable(&policy) {
                Some(capable) => selected = capable,
                None => {
                    let operator = proc::requires_and_or_chaining(&hook.command).unwrap_or("&&");
                    return (
                        false,
                        String::new(),
                        Some(HookError::new(
                            HookErrorKind::ShellUnavailable,
                            proc::chaining_unavailable_error(operator, &selected.report.cfg),
                        )),
                    );
                }
            }
        }
        selected.wrapped
    } else {
        proc::shell().clone()
    };
    // A confined PowerShell ignores the directory it was started in (it opens
    // at System32), so a relative path in a hook meant somewhere else. The
    // `bash` tool fixes this by wrapping the command to open in the workspace
    // (`proc::located`); a hook is no less entitled to its own project, so it
    // gets the same wrapper. Unconfined shells already honour `current_dir`.
    let command = if ctx.sandbox {
        proc::located(shell.flavor, &hook.command, ctx.project_root)
    } else {
        hook.command.clone()
    };
    let root = ctx.project_root.to_path_buf();
    // The shell's pid, shared out of the future so a deadline can kill the
    // tree it started. Killing the shell alone is not enough: the work is in
    // its children, and `sh -c "sleep 4; ..."` would carry on and finish
    // after the hook had been declared stopped.
    let running: std::sync::Arc<std::sync::Mutex<Option<u32>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    let spawned = running.clone();
    let event_name = event.as_str();
    let tool_name = tool.unwrap_or_default().to_string();
    let extra_env: Vec<(String, String)> =
        extra_env.iter().map(|(k, v)| ((*k).to_string(), v.clone())).collect();

    let work = async move {
        use jan_process::CommandConsole;
        let mut cmd = tokio::process::Command::new(shell.program.clone());
        cmd.args(shell.args.clone())
            .arg(&command)
            .current_dir(&root)
            // A hook runs on the app's behalf and is never shown; its own
            // children inherit the hidden console.
            .background_in_new_group()
            // What a hook is told, and all it is told. Not the prompt, not the
            // tool's arguments, not a provider key: a hook is a trigger, not a
            // window into the conversation.
            //
            // Both the new `FLINT_` names and the legacy `JAN_` names carry the
            // same values, so hook scripts written against either keep working
            // through the rebrand.
            .env("FLINT_HOOK_EVENT", event_name)
            .env("FLINT_HOOK_TOOL", &tool_name)
            .env("FLINT_PROJECT_ROOT", &root)
            .env("JAN_HOOK_EVENT", event_name)
            .env("JAN_HOOK_TOOL", &tool_name)
            .env("JAN_PROJECT_ROOT", &root)
            .envs(extra_env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            // A hook that outlives its deadline is stopped, not backgrounded:
            // the deadline drops this future, and the child goes with it.
            .kill_on_drop(true);
        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return (
                    false,
                    String::new(),
                    Some(HookError::new(HookErrorKind::Io, format!("the hook could not start: {e}"))),
                )
            }
        };
        // Registered so shutdown reaps it like any other child the harness
        // started; a hook must not outlive the app that ran it.
        if let Some(pid) = child.id() {
            proc::register(pid);
            if let Ok(mut slot) = spawned.lock() {
                *slot = Some(pid);
            }
        }
        let pid = child.id();
        let out = child.wait_with_output().await;
        if let Some(pid) = pid {
            proc::unregister(pid);
        }
        if let Ok(mut slot) = spawned.lock() {
            *slot = None;
        }
        match out {
            Ok(out) => {
                let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
                text.push_str(&String::from_utf8_lossy(&out.stderr));
                let text = bound(&crate::harness_error::scrub(&text));
                if out.status.success() {
                    (true, text, None)
                } else {
                    let code = out
                        .status
                        .code()
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "a signal".to_string());
                    let detail = if text.trim().is_empty() {
                        String::new()
                    } else {
                        format!(": {}", text.trim())
                    };
                    (
                        false,
                        text.clone(),
                        Some(HookError::new(
                            HookErrorKind::Failed,
                            format!("the {event_name} hook exited with {code}{detail}"),
                        )),
                    )
                }
            }
            Err(e) => (
                false,
                String::new(),
                Some(HookError::new(HookErrorKind::Io, format!("the hook could not be waited on: {e}"))),
            ),
        }
    };

    let token = ctx.cancel.clone().unwrap_or_else(crate::lifecycle::Token::detached);
    let limit = Duration::from_secs(hook.timeout_secs.min(MAX_TIMEOUT_SECS));
    match crate::lifecycle::run_with_deadline(&token, limit, work).await {
        Ok(result) => result,
        Err(reason) => {
            // The future is gone, so the shell died with it; its children did
            // not, so they are killed here by the same tree kill `bash` uses.
            if let Some(pid) = running.lock().ok().and_then(|slot| *slot) {
                proc::kill_tree(pid);
                proc::unregister(pid);
            }
            let (kind, why) = match reason {
                crate::lifecycle::StopReason::Timeout => (
                    HookErrorKind::TimedOut,
                    format!(
                        "the {} hook outlived its {}s limit and was stopped",
                        event.as_str(),
                        hook.timeout_secs
                    ),
                ),
                crate::lifecycle::StopReason::Cancelled => (
                    HookErrorKind::Cancelled,
                    format!("the {} hook was cancelled with the work it belonged to", event.as_str()),
                ),
            };
            (false, String::new(), Some(HookError::new(kind, why)))
        }
    }
}

/// Run the `post-tool-batch` hooks for a finished batch and say nothing back.
///
/// Observe-only by construction: the returned [`Decision`] never carries a
/// block (a `block` policy cannot even be parsed for this event, and is
/// cleared here regardless), and the caller in the tool path does not use it.
/// `tool_names` is the batch's tool names in call order; a hook with a `tools`
/// list runs when any of them is in it.
pub async fn run_post_tool_batch(
    hooks: &[Hook],
    tool_names: &[String],
    ctx: &Context<'_>,
) -> Decision {
    let batch: Vec<Hook> = hooks
        .iter()
        .filter(|h| {
            h.event == Event::PostToolBatch
                && (h.tools.is_empty() || tool_names.iter().any(|n| h.tools.contains(n)))
        })
        .map(|h| Hook { tools: Vec::new(), ..h.clone() })
        .collect();
    if batch.is_empty() {
        return Decision::default();
    }
    let joined = tool_names.join(",");
    let count = tool_names.len().to_string();
    let extra = [
        ("FLINT_HOOK_TOOL_NAMES", joined.clone()),
        ("FLINT_HOOK_TOOL_COUNT", count.clone()),
        ("JAN_HOOK_TOOL_NAMES", joined),
        ("JAN_HOOK_TOOL_COUNT", count),
    ];
    let mut decision = run_with_env(&batch, Event::PostToolBatch, None, ctx, &extra).await;
    decision.blocked = None;
    decision
}

/// Fire the `post-tool-batch` hooks for a turn that has all its results,
/// without making the turn wait for them.
///
/// Returns immediately. A project with no hooks file costs one metadata call
/// and nothing else. Otherwise the hooks are read and run on a detached task
/// that owns everything it uses, so nothing it does -- a slow hook (bounded by
/// the hook's own timeout, at most [`MAX_TIMEOUT_SECS`]), a failing one, a
/// malformed file, a panic -- can reach the caller or the results it already
/// holds. Failures are logged and dropped. The handle is for tests; callers
/// ignore it.
pub fn fire_post_tool_batch(
    project_root: &Path,
    tool_names: Vec<String>,
    allow_network: bool,
    home_readonly: bool,
    sandbox: bool,
    mask_root: Option<&Path>,
) -> Option<tokio::task::JoinHandle<()>> {
    if tool_names.is_empty() || !config_path(project_root).is_file() {
        return None;
    }
    let runtime = tokio::runtime::Handle::try_current().ok()?;
    let root = project_root.to_path_buf();
    let mask = mask_root.map(Path::to_path_buf);
    Some(runtime.spawn(async move {
        let hooks = match load(&root) {
            Ok(hooks) => hooks,
            Err(e) => {
                eprintln!("post-tool-batch hooks skipped: {}", e.message);
                return;
            }
        };
        let ctx = Context {
            project_root: &root,
            allow_network,
            home_readonly,
            sandbox,
            mask_root: mask.as_deref(),
            cancel: None,
        };
        let decision = run_post_tool_batch(&hooks, &tool_names, &ctx).await;
        for failure in decision.runs.iter().filter_map(|r| r.error.as_ref()) {
            eprintln!("post-tool-batch hook failed (ignored): {}", failure.message);
        }
    }))
}

fn bound(text: &str) -> String {
    if text.chars().count() <= MAX_OUTPUT {
        return text.to_string();
    }
    let kept: String = text.chars().take(MAX_OUTPUT).collect();
    format!("{kept}\n[hook output truncated]")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jan-hooks-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".jan").join("agent")).unwrap();
        d
    }

    fn write_config(root: &Path, body: &str) {
        std::fs::write(config_path(root), body).unwrap();
    }

    /// The CLI's shape: the project is the workspace and tool execution is
    /// not separately confined.
    fn ctx(root: &Path) -> Context<'_> {
        Context {
            project_root: root,
            allow_network: false,
            home_readonly: true,
            sandbox: false,
            mask_root: None,
            cancel: None,
        }
    }

    /// A shell command that succeeds and one that does not, written the same
    /// way on every host this runs on.
    const OK: &str = "exit 0";
    const FAIL: &str = "echo the linter says no 1>&2; exit 3";

    #[test]
    fn a_project_with_no_file_has_no_hooks() {
        let root = dir("none");
        assert_eq!(load(&root).unwrap(), Vec::new());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_hook_says_when_it_runs_what_it_runs_and_what_failing_means() {
        let hooks = parse(
            r#"
            [[hook]]
            event = "pre-tool"
            command = "cargo fmt --check"
            on_failure = "block"
            tools = ["write", "edit"]

            [[hook]]
            event = "run-end"
            command = "notify-send done"
            "#,
        )
        .unwrap();
        assert_eq!(hooks.len(), 2);
        assert_eq!(hooks[0].event, Event::PreTool);
        assert_eq!(hooks[0].on_failure, OnFailure::Block);
        assert_eq!(hooks[0].tools, ["write", "edit"]);
        assert_eq!(hooks[0].timeout_secs, DEFAULT_TIMEOUT_SECS);
        // The default is the one that lets work proceed: a hook nobody said
        // was mandatory must not silently become mandatory.
        assert_eq!(hooks[1].on_failure, OnFailure::Warn);
        assert!(hooks[1].tools.is_empty(), "no `tools` means every tool");
    }

    #[test]
    fn post_tool_batch_is_a_parsed_event_that_cannot_block() {
        let hooks = parse("[[hook]]\nevent = \"post-tool-batch\"\ncommand = \"x\"\n").unwrap();
        assert_eq!(hooks[0].event, Event::PostToolBatch);
        assert_eq!(Event::PostToolBatch.as_str(), "post-tool-batch");
        assert!(!Event::PostToolBatch.can_block());
        let err = parse(
            "[[hook]]\nevent = \"post-tool-batch\"\ncommand = \"x\"\non_failure = \"block\"\n",
        )
        .unwrap_err();
        assert_eq!(err.kind, HookErrorKind::CannotBlock);
        // Still refused, still unfired.
        assert!(Event::parse("session-start").is_none());
    }

    #[test]
    fn no_batch_hook_is_a_cheap_no_op() {
        let root = dir("batch-none");
        // No hooks file: nothing is spawned.
        let _ = std::fs::remove_file(config_path(&root));
        assert!(fire_post_tool_batch(&root, vec!["bash".into()], false, true, false, None).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_file_without_a_batch_hook_runs_nothing() {
        let root = dir("batch-other");
        write_config(&root, &format!("[[hook]]\nevent = \"post-tool\"\ncommand = \"{FAIL}\"\n"));
        let hooks = load(&root).unwrap();
        let names = vec!["bash".to_string()];
        let decision = run_post_tool_batch(&hooks, &names, &ctx(&root)).await;
        assert!(decision.runs.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_failing_batch_hook_is_reported_and_never_blocks() {
        let root = dir("batch-fail");
        write_config(
            &root,
            &format!("[[hook]]\nevent = \"post-tool-batch\"\ncommand = \"{FAIL}\"\n"),
        );
        let hooks = load(&root).unwrap();
        let names = vec!["bash".to_string(), "read".to_string()];
        let decision = run_post_tool_batch(&hooks, &names, &ctx(&root)).await;
        assert!(decision.allowed());
        assert_eq!(decision.runs.len(), 1);
        assert!(!decision.runs[0].ok);
        // The fire-and-forget path completes without panicking or surfacing.
        let handle = fire_post_tool_batch(&root, names, false, true, false, None).unwrap();
        handle.await.expect("the detached batch task must not panic");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_timed_out_batch_hook_is_bounded_and_does_not_block() {
        let root = dir("batch-timeout");
        write_config(
            &root,
            "[[hook]]\nevent = \"post-tool-batch\"\ncommand = \"sleep 5\"\ntimeout_secs = 1\n",
        );
        let hooks = load(&root).unwrap();
        let names = vec!["bash".to_string()];
        let started = std::time::Instant::now();
        let decision = run_post_tool_batch(&hooks, &names, &ctx(&root)).await;
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(decision.allowed());
        assert_eq!(decision.runs[0].error.as_ref().map(|e| e.kind), Some(HookErrorKind::TimedOut));
        // The caller is never made to wait: fire returns before the hook ends.
        let before = std::time::Instant::now();
        let handle = fire_post_tool_batch(&root, names, false, true, false, None).unwrap();
        assert!(before.elapsed() < Duration::from_millis(500));
        handle.abort();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_batch_hook_is_told_the_tools_and_their_count() {
        let root = dir("batch-env");
        let out = root.join("seen");
        let out_path = out.display().to_string().replace('\\', "/");
        write_config(
            &root,
            &format!(
                "[[hook]]\nevent = \"post-tool-batch\"\ncommand = \"echo $FLINT_HOOK_EVENT:$FLINT_HOOK_TOOL_NAMES:$FLINT_HOOK_TOOL_COUNT > '{out_path}'\"\ntools = [\"read\"]\n"
            ),
        );
        let hooks = load(&root).unwrap();
        let names = vec!["bash".to_string(), "read".to_string()];
        let decision = run_post_tool_batch(&hooks, &names, &ctx(&root)).await;
        assert!(decision.runs[0].ok, "{:?}", decision.runs[0].error);
        let seen = std::fs::read_to_string(&out).unwrap();
        assert_eq!(seen.trim(), "post-tool-batch:bash,read:2");
        // A batch with none of the hook's tools does not run it.
        let skipped = run_post_tool_batch(&hooks, &["bash".to_string()], &ctx(&root)).await;
        assert!(skipped.runs.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Everything the file can get wrong is a typed refusal, and a wrong file
    /// leaves the project with no hooks rather than the ones that parsed.
    #[test]
    fn a_file_that_is_wrong_is_refused_whole() {
        let cases: &[(&str, HookErrorKind)] = &[
            ("[[hook]]\nevent = \"pre-tool\"\n", HookErrorKind::Malformed),
            ("[[hook]]\ncommand = \"x\"\n", HookErrorKind::Malformed),
            ("[[hook]]\nevent = \"pre-tool\"\ncommand = \"  \"\n", HookErrorKind::Malformed),
            ("[[hook]]\nevent = \"whenever\"\ncommand = \"x\"\n", HookErrorKind::Unknown),
            // Declared in the type and not yet fired anywhere: refused, so a
            // hook that would never run is never accepted.
            (
                "[[hook]]\nevent = \"session-start\"\ncommand = \"x\"\n",
                HookErrorKind::Unknown,
            ),
            (
                "[[hook]]\nevent = \"pre-tool\"\ncommand = \"x\"\non_failure = \"explode\"\n",
                HookErrorKind::Unknown,
            ),
            // `block` after the fact would refuse something already done.
            (
                "[[hook]]\nevent = \"post-tool\"\ncommand = \"x\"\non_failure = \"block\"\n",
                HookErrorKind::CannotBlock,
            ),
            (
                "[[hook]]\nevent = \"pre-tool\"\ncommand = \"x\"\ntimeout_secs = 9999\n",
                HookErrorKind::TooBig,
            ),
            (
                "[[hook]]\nevent = \"pre-tool\"\ncommand = \"x\"\ntimeout_secs = 0\n",
                HookErrorKind::Malformed,
            ),
            ("hook = \"not a list\"\n", HookErrorKind::Malformed),
            ("this is not toml", HookErrorKind::Malformed),
        ];
        for (body, want) in cases {
            let err = parse(body).expect_err(&format!("should be refused: {body:?}"));
            assert_eq!(err.kind, *want, "{body:?} -> {err:?}");
        }

        // One good hook beside one bad one leaves no hooks at all.
        let mixed = format!(
            "[[hook]]\nevent = \"pre-tool\"\ncommand = \"{OK}\"\n\n\
             [[hook]]\nevent = \"never\"\ncommand = \"x\"\n"
        );
        assert!(parse(&mixed).is_err());
    }

    #[test]
    fn a_file_with_more_hooks_than_are_read_is_refused_rather_than_cut_short() {
        let body = "[[hook]]\nevent = \"run-end\"\ncommand = \"x\"\n".repeat(MAX_HOOKS + 1);
        let err = parse(&body).unwrap_err();
        assert_eq!(err.kind, HookErrorKind::TooBig);
        // At the limit it is read.
        let body = "[[hook]]\nevent = \"run-end\"\ncommand = \"x\"\n".repeat(MAX_HOOKS);
        assert_eq!(parse(&body).unwrap().len(), MAX_HOOKS);
    }

    #[tokio::test]
    async fn a_failing_pre_tool_hook_blocks_the_call_it_ran_before() {
        let root = dir("block");
        write_config(
            &root,
            &format!(
                "[[hook]]\nevent = \"pre-tool\"\ncommand = \"{FAIL}\"\non_failure = \"block\"\ntools = [\"write\"]\n"
            ),
        );
        let hooks = load(&root).unwrap();
        let decision = run(&hooks, Event::PreTool, Some("write"), &ctx(&root)).await;
        assert!(!decision.allowed(), "a failing block hook must stop the call");
        let blocked = decision.blocked.unwrap();
        assert_eq!(blocked.kind, HookErrorKind::Failed);
        assert!(blocked.message.contains("the linter says no"), "{}", blocked.message);
        // And a tool it does not name is not affected.
        let other = run(&hooks, Event::PreTool, Some("read"), &ctx(&root)).await;
        assert!(other.allowed() && other.runs.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn warn_and_ignore_let_the_work_proceed_and_differ_in_what_is_said() {
        let root = dir("warn");
        write_config(
            &root,
            &format!(
                "[[hook]]\nevent = \"post-tool\"\ncommand = \"{FAIL}\"\non_failure = \"warn\"\n\n\
                 [[hook]]\nevent = \"post-tool\"\ncommand = \"{FAIL}\"\non_failure = \"ignore\"\n"
            ),
        );
        let hooks = load(&root).unwrap();
        let decision = run(&hooks, Event::PostTool, Some("bash"), &ctx(&root)).await;
        assert!(decision.allowed());
        assert_eq!(decision.warnings.len(), 1, "only the warn hook is reported");
        assert_eq!(decision.runs.len(), 2, "both still ran and are both recorded");
        assert!(decision.runs.iter().all(|r| !r.ok));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_block_that_fails_does_not_run_the_hooks_after_it() {
        let root = dir("stop-after-block");
        let marker = root.join("second-ran");
        write_config(
            &root,
            &format!(
                "[[hook]]\nevent = \"pre-tool\"\ncommand = \"{FAIL}\"\non_failure = \"block\"\n\n\
                 [[hook]]\nevent = \"pre-tool\"\ncommand = \"echo x > '{}'\"\n",
                marker.display().to_string().replace('\\', "/")
            ),
        );
        let hooks = load(&root).unwrap();
        let decision = run(&hooks, Event::PreTool, Some("write"), &ctx(&root)).await;
        assert!(!decision.allowed());
        assert_eq!(decision.runs.len(), 1, "the decision was made; nothing else ran");
        assert!(!marker.exists(), "a hook after a block must not have run");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_hook_that_outlives_its_limit_is_stopped_and_named_a_timeout() {
        let root = dir("timeout");
        write_config(
            &root,
            "[[hook]]\nevent = \"pre-tool\"\ncommand = \"sleep 30\"\non_failure = \"block\"\ntimeout_secs = 1\n",
        );
        let hooks = load(&root).unwrap();
        let started = std::time::Instant::now();
        let decision = run(&hooks, Event::PreTool, Some("write"), &ctx(&root)).await;
        assert!(started.elapsed() < Duration::from_secs(20), "it was not waited out");
        let blocked = decision.blocked.expect("a block hook that timed out blocks");
        assert_eq!(blocked.kind, HookErrorKind::TimedOut);
        // AH-009: a timeout is a timeout everywhere, and is not retried
        // behind anyone's back.
        let harness: crate::harness_error::HarnessError = (&blocked).into();
        assert_eq!(harness.kind(), crate::harness_error::ErrorKind::Timeout);
        assert_eq!(harness.retry(), crate::harness_error::Retry::Never);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_cancelled_run_cancels_its_hooks() {
        use crate::lifecycle::{Scope, StopReason, Token};
        let root = dir("cancel");
        write_config(
            &root,
            "[[hook]]\nevent = \"pre-tool\"\ncommand = \"sleep 30\"\non_failure = \"block\"\ntimeout_secs = 60\n",
        );
        let hooks = load(&root).unwrap();
        let token = Token::new(Scope {
            session: "s-hook".into(),
            run: "r-hook".into(),
            call: "c-hook".into(),
        });
        let stopper = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            stopper.stop(StopReason::Cancelled);
        });
        let started = std::time::Instant::now();
        let decision = run(
            &hooks,
            Event::PreTool,
            Some("write"),
            &Context {
                project_root: &root,
                allow_network: false,
                home_readonly: true,
                sandbox: false,
                mask_root: None,
                cancel: Some(token),
            },
        )
        .await;
        assert!(started.elapsed() < Duration::from_secs(20), "it waited out the sleep");
        let blocked = decision.blocked.expect("a cancelled block hook blocks");
        assert_eq!(blocked.kind, HookErrorKind::Cancelled);
        assert_ne!(blocked.kind, HookErrorKind::TimedOut, "a person stopping it is not a timeout");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A hook is told the event, the tool and the project. Nothing else the
    /// harness knows reaches it.
    #[tokio::test]
    async fn a_hook_is_told_the_event_and_the_tool_and_nothing_else() {
        let root = dir("env");
        let out = root.join("env.txt");
        let out_path = out.display().to_string().replace('\\', "/");
        write_config(
            &root,
            &format!(
                "[[hook]]\nevent = \"pre-tool\"\ncommand = \"echo \\\"$JAN_HOOK_EVENT $JAN_HOOK_TOOL\\\" > '{out_path}'\"\n"
            ),
        );
        let hooks = load(&root).unwrap();
        let decision = run(&hooks, Event::PreTool, Some("bash"), &ctx(&root)).await;
        assert!(decision.allowed());
        let seen = std::fs::read_to_string(&out).unwrap_or_default();
        assert!(seen.contains("pre-tool bash"), "{seen:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A hook's own output cannot carry a credential out of the process.
    #[tokio::test]
    async fn what_a_hook_prints_is_scrubbed_and_bounded() {
        let root = dir("scrub");
        write_config(
            &root,
            "[[hook]]\nevent = \"post-tool\"\ncommand = \"echo Authorization: Bearer sk-not-a-real-key-1234567890\"\n",
        );
        let hooks = load(&root).unwrap();
        let decision = run(&hooks, Event::PostTool, Some("bash"), &ctx(&root)).await;
        let printed = &decision.runs[0].output;
        assert!(
            !printed.contains("sk-not-a-real-key-1234567890"),
            "a hook's output must be scrubbed: {printed:?}"
        );
        assert!(bound(&"x".repeat(MAX_OUTPUT * 2)).contains("[hook output truncated]"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A hook that is stopped is actually stopped: the work it was doing does
    /// not carry on unowned after the deadline says it ended.
    #[tokio::test]
    async fn a_stopped_hook_leaves_nothing_running_behind_it() {
        let root = dir("no-orphan");
        let marker = root.join("finished");
        let marker_path = marker.display().to_string().replace('\\', "/");
        write_config(
            &root,
            &format!(
                "[[hook]]\nevent = \"post-tool\"\ncommand = \"sleep 4; echo done > '{marker_path}'\"\ntimeout_secs = 1\n"
            ),
        );
        let hooks = load(&root).unwrap();
        let decision = run(&hooks, Event::PostTool, Some("bash"), &ctx(&root)).await;
        assert_eq!(decision.runs[0].error.as_ref().map(|e| e.kind), Some(HookErrorKind::TimedOut));
        // Long enough that a surviving hook would have written its marker.
        tokio::time::sleep(Duration::from_secs(6)).await;
        assert!(
            !marker.exists(),
            "the hook kept running after it was stopped and finished its work"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A confined hook gets the same shell decision a confined `bash` call
    /// gets, and a hook written for a shell that cannot be confined here is
    /// refused rather than handed to a different one.
    #[tokio::test]
    async fn a_confined_hook_is_never_run_by_a_shell_that_was_not_asked_for() {
        use crate::tools::{jail, proc};
        let root = dir("confined");
        write_config(
            &root,
            "[[hook]]\nevent = \"pre-tool\"\ncommand = \"export UID_NOW=$(id -u)\"\non_failure = \"block\"\n",
        );
        let hooks = load(&root).unwrap();
        let policy = jail::Policy::new(&root, false).with_home_readonly(true);
        let posix = jail::select_shell(&policy)
            .map(|s| s.report.cfg.flavor == proc::ShellFlavor::Posix)
            .unwrap_or(false);
        let decision = run(
            &hooks,
            Event::PreTool,
            Some("write"),
            &Context {
                project_root: &root,
                allow_network: false,
                home_readonly: true,
                sandbox: true,
                mask_root: None,
                cancel: None,
            },
        )
        .await;
        if !posix {
            // No POSIX shell can be confined here, so `export` is refused --
            // (`$(...)` alone is valid PowerShell and no longer refused there)
            // not quietly run by cmd or PowerShell, which would do something
            // else entirely.
            let blocked = decision.blocked.expect("a hook that cannot be run as written blocks");
            assert_eq!(blocked.kind, HookErrorKind::ShellUnavailable);
            let harness: crate::harness_error::HarnessError = (&blocked).into();
            assert_eq!(harness.kind(), crate::harness_error::ErrorKind::Unsupported);
        } else {
            // Where one can, the hook ran inside it.
            assert_eq!(decision.runs.len(), 1);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A confined PowerShell opens in System32 whatever directory it was
    /// started in, so a relative path in a hook used to land (or fail) there.
    /// A hook starts in the project, confined or not.
    #[tokio::test]
    async fn a_confined_hook_starts_in_the_project() {
        let root = dir("confined-cwd");
        write_config(
            &root,
            "[[hook]]\nevent = \"post-tool-batch\"\ncommand = \"echo here > relative-hook-output.txt\"\non_failure = \"warn\"\n",
        );
        let hooks = load(&root).unwrap();
        let decision = run_post_tool_batch(
            &hooks,
            &["ls".to_string()],
            &Context {
                project_root: &root,
                allow_network: false,
                home_readonly: true,
                sandbox: true,
                mask_root: None,
                cancel: None,
            },
        )
        .await;
        let run = decision.runs.first().expect("the hook ran or was refused");
        match &run.error {
            // No shell can be confined on this host: nothing to check here.
            Some(e) if e.kind == HookErrorKind::ShellUnavailable => {}
            Some(e) => panic!("the confined hook failed: {}", e.message),
            None => assert!(
                root.join("relative-hook-output.txt").is_file(),
                "a relative path in a confined hook must land in the project"
            ),
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The project's path reaches a confined PowerShell inside a quoted literal.
    /// A folder named with quote, space, `&`, `^` and `%` characters must be a
    /// place to start in, never code: the hook still lands its file there.
    #[tokio::test]
    async fn a_confined_hook_starts_in_a_project_with_awkward_characters() {
        let root = dir("it's a & b ^ 100% $x `t");
        write_config(
            &root,
            "[[hook]]\nevent = \"post-tool-batch\"\ncommand = \"echo here > awkward-output.txt\"\non_failure = \"warn\"\n",
        );
        let hooks = load(&root).unwrap();
        let decision = run_post_tool_batch(
            &hooks,
            &["ls".to_string()],
            &Context {
                project_root: &root,
                allow_network: false,
                home_readonly: true,
                sandbox: true,
                mask_root: None,
                cancel: None,
            },
        )
        .await;
        let run = decision.runs.first().expect("the hook ran or was refused");
        match &run.error {
            Some(e) if e.kind == HookErrorKind::ShellUnavailable => {}
            Some(e) => panic!("the confined hook failed: {}", e.message),
            None => assert!(
                root.join("awkward-output.txt").is_file(),
                "the hook must start in the awkwardly named project"
            ),
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The security property: a hook file the model could have written is not
    /// read, because the path it must live at is one no tool can write.
    #[test]
    fn the_model_cannot_introduce_a_hook() {
        let root = dir("authority");
        let path = config_path(&root);
        let relative = path
            .strip_prefix(&root)
            .unwrap()
            .display()
            .to_string()
            .replace('\\', "/");
        assert!(
            crate::tools::sandbox::is_hidden_jan_path(&root, &relative),
            "the hooks file must sit where the file tools refuse to write: {relative}"
        );
        assert!(crate::tools::sandbox::command_touches_hidden_jan_path(
            &root,
            &format!("echo x > {relative}")
        ));
        // And the same for the directory it lives in, so a hook cannot be
        // dropped beside it either.
        assert!(crate::tools::sandbox::is_hidden_jan_path(&root, ".jan/agent"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A hook cannot be smuggled in from outside the project.
    #[test]
    #[cfg(windows)]
    fn a_hooks_file_that_resolves_outside_the_project_is_not_read() {
        let root = dir("escape");
        let outside = dir("escape-source");
        std::fs::write(outside.join("hooks.toml"), "[[hook]]\nevent = \"run-end\"\ncommand = \"x\"\n")
            .unwrap();
        let path = config_path(&root);
        let _ = std::fs::remove_file(&path);
        // A symlink needs privilege on Windows; when it cannot be made, the
        // test has nothing to say rather than a false pass.
        if std::os::windows::fs::symlink_file(outside.join("hooks.toml"), &path).is_err() {
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&outside);
            return;
        }
        let err = load(&root).expect_err("a hooks file from outside the project is not read");
        assert_eq!(err.kind, HookErrorKind::Escapes);
        let harness: crate::harness_error::HarnessError = (&err).into();
        assert_eq!(harness.kind(), crate::harness_error::ErrorKind::SandboxDenied);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// Every hook failure crosses into the harness taxonomy as itself.
    #[test]
    fn a_hook_failure_keeps_its_meaning() {
        use crate::harness_error::ErrorKind;
        let cases = [
            (HookErrorKind::Malformed, ErrorKind::InvalidInput),
            (HookErrorKind::Unknown, ErrorKind::InvalidInput),
            (HookErrorKind::TooBig, ErrorKind::InvalidInput),
            (HookErrorKind::Escapes, ErrorKind::SandboxDenied),
            (HookErrorKind::CannotBlock, ErrorKind::InvalidInput),
            (HookErrorKind::Failed, ErrorKind::PolicyViolation),
            (HookErrorKind::TimedOut, ErrorKind::Timeout),
            (HookErrorKind::Cancelled, ErrorKind::Cancelled),
            (HookErrorKind::ShellUnavailable, ErrorKind::Unsupported),
            (HookErrorKind::Io, ErrorKind::Io),
        ];
        for (from, want) in cases {
            let harness: crate::harness_error::HarnessError =
                (&HookError::new(from, "why")).into();
            assert_eq!(harness.kind(), want, "{from:?}");
            assert_eq!(harness.stage(), crate::harness_error::Stage::Tool);
        }
        // A configuration mistake is never retried into working, and never
        // sends the run looking for another provider.
        let config: crate::harness_error::HarnessError =
            (&HookError::new(HookErrorKind::Malformed, "why")).into();
        assert_eq!(
            config.retry(),
            crate::harness_error::Retry::Never,
            "a wrong hooks file does not fix itself"
        );
        assert!(!crate::harness_error::may_try_another(&config));
    }

    /// What is written down about a hook carries no credential either.
    #[test]
    fn a_hook_error_is_scrubbed_when_it_is_made() {
        let err = HookError::new(
            HookErrorKind::Failed,
            "Authorization: Bearer sk-not-a-real-key-1234567890 was rejected",
        );
        assert!(!err.message.contains("sk-not-a-real-key-1234567890"), "{}", err.message);
    }
}
