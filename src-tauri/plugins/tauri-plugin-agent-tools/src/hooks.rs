//! User-configured commands run at defined points in a run. AH-127, AH-128,
//! AH-129.
//!
//! A hook is a shell command the *user* asks to be run when something happens:
//! before a tool call, after one, around a compaction, when a run ends. It is
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

/// Environment variables a hook receives on top of the minimal set the bash
/// tool gets. These are locations, identity and platform facts a script
/// normally reads (`%APPDATA%`, `%USERNAME%`, `ProgramFiles(x86)`, `XDG_*`);
/// none of them carries a credential. Everything else in the host environment
/// stays out, so a provider key or `SSH_AUTH_SOCK` never reaches a hook.
const HOOK_ENV_EXTRA: &[&str] = &[
    "APPDATA",
    "USERNAME",
    "USERDOMAIN",
    "ALLUSERSPROFILE",
    "PUBLIC",
    "CommonProgramW6432",
    "COMPUTERNAME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LC_ALL",
    "LC_CTYPE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
];

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
    /// Just before the run summarizes its conversation to make room (a
    /// compaction). Observe-only like [`Event::PostToolBatch`]: fired detached
    /// by [`fire_compaction`], told nothing about the conversation, and unable
    /// to block or delay the compaction it runs before.
    PreCompact,
    /// Just after a compaction has replaced the conversation with a shorter
    /// one. Observe-only, fired the same way as [`Event::PreCompact`].
    PostCompact,
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
            Event::PreCompact => "pre-compact",
            Event::PostCompact => "post-compact",
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
            "pre-compact" => Some(Event::PreCompact),
            "post-compact" => Some(Event::PostCompact),
            "run-end" => Some(Event::RunEnd),
            _ => None,
        }
    }

    /// Whether a failing hook at this point can stop anything.
    ///
    /// Only `pre-tool` can: by the time the after-the-fact events run, the
    /// thing they would refuse has already happened, and a "block" there would
    /// be a refusal of something that cannot be taken back. `pre-compact` runs
    /// before its compaction but is observe-only by design: a compaction is
    /// what keeps a run inside its context window, and a hook that could stop
    /// it could wedge the run.
    pub fn can_block(self) -> bool {
        matches!(self, Event::PreTool | Event::RunEnd)
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
    /// Opt-in: hand the tool call to this hook as JSON on stdin
    /// (`pre-tool` / `post-tool` only). Off by default, so a hook written
    /// before this existed still sees an empty stdin.
    #[serde(default)]
    pub stdin_json: bool,
    /// `if = "bash(git push)"`: run only for a call whose tool matches and
    /// whose arguments match the regex in parentheses. `"bash"` alone is a tool
    /// match; the tool may be `*`. Checked on `pre-tool` and `post-tool`.
    #[serde(default, rename = "if")]
    pub if_filter: Option<String>,
}

/// Split `tool(pattern)` into its parts. `None` pattern means tool only.
fn split_if(spec: &str) -> Option<(&str, Option<&str>)> {
    let spec = spec.trim();
    match spec.find('(') {
        None => (!spec.is_empty()).then_some((spec, None)),
        Some(i) => {
            let tool = spec[..i].trim();
            let pat = spec[i + 1..].strip_suffix(')')?;
            (!tool.is_empty()).then_some((tool, Some(pat)))
        }
    }
}

/// The strings of a call's arguments a pattern is tested against: every string
/// value, so `command`, `path`, `url`, `pattern` all count.
fn arg_strings(v: &serde_json::Value, out: &mut Vec<String>) {
    match v {
        serde_json::Value::String(s) => out.push(s.clone()),
        serde_json::Value::Array(a) => a.iter().for_each(|x| arg_strings(x, out)),
        serde_json::Value::Object(m) => m.values().for_each(|x| arg_strings(x, out)),
        _ => {}
    }
}

fn if_matches(spec: &str, input: Option<&HookInput>) -> bool {
    let Some(input) = input else { return false };
    let Some((tool, pat)) = split_if(spec) else { return false };
    if tool != "*" && tool != input.tool_name {
        return false;
    }
    let Some(pat) = pat else { return true };
    let Ok(re) = regex::Regex::new(pat) else { return false };
    let mut strings = Vec::new();
    arg_strings(&input.tool_input, &mut strings);
    strings.iter().any(|s| re.is_match(s))
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
    load_with(project_root, crate::folder_trust::is_trusted(project_root))
}

/// The note a run shows when a project's hooks are off because its folder is
/// not trusted. `None` when they are not off (or there are none).
pub fn untrusted_note(project_root: &Path) -> Option<String> {
    (config_path(project_root).is_file() && !crate::folder_trust::is_trusted(project_root)).then(|| {
        format!(
            "[hooks off] this project's .jan/agent/hooks.toml did not run because the folder is not trusted. \
             Trust it with `flint trust {}` (or the banner in the desktop app) to turn its hooks on.",
            project_root.display()
        )
    })
}

/// [`load`] with the trust decision made by the caller, so the gate can be
/// tested without the process-wide trust list.
pub fn load_with(project_root: &Path, trusted: bool) -> Result<Vec<Hook>, HookError> {
    let path = config_path(project_root);
    let raw = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(HookError::new(HookErrorKind::Io, format!("hooks.toml: {e}"))),
    };
    // A project the user has not trusted yet keeps its hooks off: the file may
    // have arrived with a clone, and what it runs is not the user's choice.
    // `folder_trust` says why and how to turn them on.
    if !trusted {
        return Ok(Vec::new());
    }
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
            let why = if event == Event::PreCompact {
                "is observe-only and cannot stop a compaction"
            } else {
                "runs after it"
            };
            return Err(HookError::new(
                HookErrorKind::CannotBlock,
                format!(
                    "hook {at}: `block` needs an event that runs before the work it refuses; \
                     `{}` {why}",
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
        let stdin_json = match item.get("stdin_json") {
            None => false,
            Some(toml::Value::Boolean(b)) => *b,
            Some(_) => {
                return Err(HookError::new(
                    HookErrorKind::Malformed,
                    format!("hook {at}: `stdin_json` must be true or false"),
                ))
            }
        };
        let if_filter = match item.get("if") {
            None => None,
            Some(toml::Value::String(spec)) => {
                let bad = |why: &str| {
                    HookError::new(HookErrorKind::Malformed, format!("hook {at}: `if` {why}"))
                };
                if !matches!(event, Event::PreTool | Event::PostTool) {
                    return Err(bad("only applies to pre-tool and post-tool hooks"));
                }
                let (_, pat) = split_if(spec).ok_or_else(|| bad("must look like `tool` or `tool(regex)`"))?;
                if let Some(pat) = pat {
                    regex::Regex::new(pat).map_err(|e| bad(&format!("has an invalid regex: {e}")))?;
                }
                Some(spec.trim().to_string())
            }
            Some(_) => {
                return Err(HookError::new(
                    HookErrorKind::Malformed,
                    format!("hook {at}: `if` must be a string"),
                ))
            }
        };
        hooks.push(Hook { event, command, on_failure, timeout_secs, tools, stdin_json, if_filter });
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
    /// Wall-clock time the hook took, including shell selection and spawn.
    #[serde(default)]
    pub duration_ms: u64,
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
    run_with_env(hooks, event, tool, ctx, &[], None).await
}

/// What a tool hook is handed as JSON on stdin: the call's name and
/// arguments, who is running it and where. Provider keys and the prompt are
/// never part of it.
#[derive(Serialize, Clone, Debug, Default)]
pub struct HookInput {
    pub tool_name: String,
    pub tool_input: serde_json::Value,
    /// `post-tool` only: the tool's result text, bounded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_response: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// `run-end` only: the answer the run is about to finish with.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_assistant_message: Option<String>,
}

impl HookInput {
    fn to_stdin(&self, event: Event, cwd: &Path) -> String {
        let mut value = serde_json::to_value(self).unwrap_or_default();
        if let Some(map) = value.as_object_mut() {
            map.insert("hook_event_name".into(), event.as_str().into());
            map.insert("cwd".into(), cwd.to_string_lossy().into_owned().into());
            if let Some(resp) = map.get_mut("tool_response") {
                if let Some(text) = resp.as_str() {
                    *resp = bound(&crate::harness_error::scrub(text)).into();
                }
            }
        }
        value.to_string()
    }
}

/// [`run`] that also writes the tool call as JSON on the hook's stdin.
pub async fn run_with_input(
    hooks: &[Hook],
    event: Event,
    tool: Option<&str>,
    ctx: &Context<'_>,
    input: &HookInput,
) -> Decision {
    run_with_env(hooks, event, tool, ctx, &[], Some(input)).await
}

/// [`run`] with extra environment variables for the hook (the batch event's
/// tool list). The names are the harness's, never the model's or the file's.
async fn run_with_env(
    hooks: &[Hook],
    event: Event,
    tool: Option<&str>,
    ctx: &Context<'_>,
    extra_env: &[(&str, String)],
    input: Option<&HookInput>,
) -> Decision {
    let mut decision = Decision::default();
    for hook in hooks.iter().filter(|h| h.applies_to(event, tool)) {
        if let Some(spec) = &hook.if_filter {
            if !if_matches(spec, input) {
                continue;
            }
        }
        let started = std::time::Instant::now();
        let (ok, output, error) = execute(hook, event, tool, ctx, extra_env, input.filter(|_| hook.stdin_json)).await;
        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        log::debug!(
            "hook finished: event={} command={:?} ok={} outcome={} duration_ms={}",
            event.as_str(),
            crate::harness_error::scrub(&hook.command),
            ok,
            error.as_ref().map_or_else(|| "ok".to_string(), |e| format!("{:?}", e.kind)),
            duration_ms
        );
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
            duration_ms,
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
    input: Option<&HookInput>,
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
    let stdin_payload = input.map(|i| i.to_stdin(event, ctx.project_root));
    let tool_name = tool.unwrap_or_default().to_string();
    let extra_env: Vec<(String, String)> =
        extra_env.iter().map(|(k, v)| ((*k).to_string(), v.clone())).collect();

    let work = async move {
        use jan_process::CommandConsole;
        let mut cmd = tokio::process::Command::new(shell.program.clone());
        // A hook gets the same minimal environment as the `bash` tool, never
        // the host's: a provider key or `SSH_AUTH_SOCK` in the app's
        // environment must not reach a script a repository chose.
        cmd.env_clear();
        for key in crate::tools::proc::SANDBOX_ENV_ALLOW
            .iter()
            .chain(HOOK_ENV_EXTRA)
        {
            if let Some(val) = jan_process::host_env_var(key) {
                cmd.env(key, val);
            }
        }
        cmd.args(shell.args.clone())
            .arg(&command)
            .current_dir(&root)
            // A hook runs on the app's behalf and is never shown; its own
            // children inherit the hidden console.
            .background_in_new_group()
            // What a hook is told, and all it is told. Not the prompt, not a
            // provider key. Tool hooks also get the call as JSON on stdin.
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
            .stdin(if stdin_payload.is_some() {
                std::process::Stdio::piped()
            } else {
                std::process::Stdio::null()
            })
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            // A hook that outlives its deadline is stopped, not backgrounded:
            // the deadline drops this future, and the child goes with it.
            .kill_on_drop(true);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return (
                    false,
                    String::new(),
                    Some(HookError::new(HookErrorKind::Io, format!("the hook could not start: {e}"))),
                )
            }
        };
        // The tool call goes in on stdin, then stdin closes. A hook that never
        // reads it is fine: a broken pipe is ignored.
        if let (Some(payload), Some(mut stdin)) = (stdin_payload, child.stdin.take()) {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(payload.as_bytes()).await;
            drop(stdin);
        }
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
    run_post_tool_batch_as(hooks, tool_names, "main", ctx).await
}

/// Which agent's turn a `post-tool-batch` hook is told about.
///
/// Anything but `subagent` is `main`: the value is set by the harness, never by
/// a model, and a hook only branches on these two spellings.
pub fn hook_agent(agent: &str) -> &'static str {
    if agent == "subagent" { "subagent" } else { "main" }
}

/// [`run_post_tool_batch`], telling the hook whether the turn was the main
/// agent's or a subagent's (`FLINT_HOOK_AGENT`). Observe-only either way.
pub async fn run_post_tool_batch_as(
    hooks: &[Hook],
    tool_names: &[String],
    agent: &str,
    ctx: &Context<'_>,
) -> Decision {
    let agent = hook_agent(agent).to_string();
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
        ("FLINT_HOOK_AGENT", agent.clone()),
        ("JAN_HOOK_AGENT", agent),
    ];
    let mut decision = run_with_env(&batch, Event::PostToolBatch, None, ctx, &extra, None).await;
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
    fire_post_tool_batch_as(project_root, tool_names, "main", allow_network, home_readonly, sandbox, mask_root)
}

/// [`fire_post_tool_batch`] for a turn of `agent` (`main` or `subagent`), so a
/// hook can tell them apart through `FLINT_HOOK_AGENT`.
pub fn fire_post_tool_batch_as(
    project_root: &Path,
    tool_names: Vec<String>,
    agent: &str,
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
    let agent = hook_agent(agent);
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
        let decision = run_post_tool_batch_as(&hooks, &tool_names, agent, &ctx).await;
        for failure in decision.runs.iter().filter_map(|r| r.error.as_ref()) {
            eprintln!("post-tool-batch hook failed (ignored): {}", failure.message);
        }
    }))
}

/// Run the `pre-compact` or `post-compact` hooks and say nothing back.
///
/// Observe-only, exactly like [`run_post_tool_batch_as`]: a `block` policy
/// cannot be parsed for either event and is cleared here regardless. The hook
/// is told the event, the project root and the agent (`FLINT_HOOK_AGENT`),
/// never anything from the conversation being compacted. A `tools` list means
/// nothing for a compaction and does not stop the hook from running. Any other
/// event runs nothing.
pub async fn run_compaction_as(
    hooks: &[Hook],
    event: Event,
    agent: &str,
    ctx: &Context<'_>,
) -> Decision {
    if !matches!(event, Event::PreCompact | Event::PostCompact) {
        return Decision::default();
    }
    let agent = hook_agent(agent).to_string();
    let matching: Vec<Hook> = hooks
        .iter()
        .filter(|h| h.event == event)
        .map(|h| Hook { tools: Vec::new(), ..h.clone() })
        .collect();
    if matching.is_empty() {
        return Decision::default();
    }
    let extra = [("FLINT_HOOK_AGENT", agent.clone()), ("JAN_HOOK_AGENT", agent)];
    let mut decision = run_with_env(&matching, event, None, ctx, &extra, None).await;
    decision.blocked = None;
    decision
}

/// Fire the `pre-compact` or `post-compact` hooks without making the run wait
/// for them.
///
/// The same contract as [`fire_post_tool_batch_as`]: returns immediately, a
/// project with no hooks file costs one metadata call, and the hooks are read
/// (through [`load`], so an untrusted folder runs none) and run on a detached
/// task that owns everything it uses. A slow, failing or malformed hook is
/// logged and dropped and can never delay or alter the compaction. Any event
/// other than the two compaction events fires nothing. The handle is for
/// tests; callers ignore it.
#[allow(clippy::too_many_arguments)]
pub fn fire_compaction(
    project_root: &Path,
    event: Event,
    agent: &str,
    allow_network: bool,
    home_readonly: bool,
    sandbox: bool,
    mask_root: Option<&Path>,
) -> Option<tokio::task::JoinHandle<()>> {
    if !matches!(event, Event::PreCompact | Event::PostCompact)
        || !config_path(project_root).is_file()
    {
        return None;
    }
    let runtime = tokio::runtime::Handle::try_current().ok()?;
    let root = project_root.to_path_buf();
    let mask = mask_root.map(Path::to_path_buf);
    let agent = hook_agent(agent);
    let name = event.as_str();
    Some(runtime.spawn(async move {
        let hooks = match load(&root) {
            Ok(hooks) => hooks,
            Err(e) => {
                eprintln!("{name} hooks skipped: {}", e.message);
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
        let decision = run_compaction_as(&hooks, event, agent, &ctx).await;
        for failure in decision.runs.iter().filter_map(|r| r.error.as_ref()) {
            eprintln!("{name} hook failed (ignored): {}", failure.message);
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
        let d = crate::test_temp_root().join(format!(
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

    /// A finished hook reports how long it took, and serializes it.
    #[tokio::test]
    async fn a_finished_hook_reports_its_duration() {
        let root = dir("duration");
        write_config(
            &root,
            &format!("[[hook]]\nevent = \"post-tool\"\ncommand = \"{OK}\"\n"),
        );
        let hooks = load(&root).unwrap();
        let decision = run(&hooks, Event::PostTool, Some("bash"), &ctx(&root)).await;
        assert_eq!(decision.runs.len(), 1);
        let run0 = &decision.runs[0];
        assert!(run0.ok);
        assert!(run0.duration_ms < 60_000, "duration {} is not a plausible hook time", run0.duration_ms);
        let json = serde_json::to_value(run0).unwrap();
        assert!(json.get("durationMs").is_some(), "durationMs missing from {json}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Opt-in stdin: the hook sees the call as JSON, a hook without the flag
    /// still sees nothing.
    #[tokio::test]
    async fn stdin_json_hands_the_tool_call_to_an_opted_in_hook_only() {
        let root = dir("stdin");
        write_config(
            &root,
            "[[hook]]
event = \"pre-tool\"
command = \"grep -q git-push-marker\"
on_failure = \"block\"
stdin_json = true

             [[hook]]
event = \"pre-tool\"
command = \"grep -q git-push-marker\"
on_failure = \"warn\"
",
        );
        let hooks = load(&root).unwrap();
        assert!(hooks[0].stdin_json && !hooks[1].stdin_json);
        let input = HookInput {
            tool_name: "bash".into(),
            tool_input: serde_json::json!({"command": "git-push-marker origin"}),
            ..HookInput::default()
        };
        let decision = run_with_input(&hooks, Event::PreTool, Some("bash"), &ctx(&root), &input).await;
        assert!(decision.runs[0].ok, "opted-in hook did not see stdin: {:?}", decision.runs[0]);
        assert!(!decision.runs[1].ok, "hook without the flag must see empty stdin");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn an_if_filter_matches_tool_and_argument_pattern() {
        let root = dir("iffilter");
        write_config(
            &root,
            &format!("[[hook]]
event = \"pre-tool\"
command = \"{OK}\"
if = \"bash(git[ ]+push)\"
"),
        );
        let hooks = load(&root).unwrap();
        let call = |tool: &str, cmd: &str| HookInput {
            tool_name: tool.into(),
            tool_input: serde_json::json!({ "command": cmd }),
            ..HookInput::default()
        };
        let ran = |d: Decision| d.runs.len();
        let c = ctx(&root);
        assert_eq!(ran(run_with_input(&hooks, Event::PreTool, Some("bash"), &c, &call("bash", "git push origin")).await), 1);
        assert_eq!(ran(run_with_input(&hooks, Event::PreTool, Some("bash"), &c, &call("bash", "git status")).await), 0);
        assert_eq!(ran(run_with_input(&hooks, Event::PreTool, Some("write"), &c, &call("write", "git push")).await), 0);
        assert!(parse("[[hook]]
event=\"pre-tool\"
command=\"x\"
if=\"bash(\"
").is_err());
        assert!(parse("[[hook]]
event=\"run-end\"
command=\"x\"
if=\"bash\"
").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_failing_run_end_block_hook_blocks_with_its_reason() {
        let root = dir("runend");
        write_config(
            &root,
            &format!("[[hook]]
event = \"run-end\"
command = \"{FAIL}\"
on_failure = \"block\"
"),
        );
        let hooks = load(&root).unwrap();
        let input = HookInput { last_assistant_message: Some("done".into()), ..HookInput::default() };
        let d = run_with_input(&hooks, Event::RunEnd, None, &ctx(&root), &input).await;
        assert!(d.blocked.is_some_and(|e| e.message.contains("the linter says no")));
        // block is still refused for events that cannot gate.
        assert!(parse("[[hook]]
event=\"post-tool\"
command=\"x\"
on_failure=\"block\"
").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

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
    fn compaction_events_parse_round_trip_and_cannot_block() {
        for (raw, event) in [("pre-compact", Event::PreCompact), ("post-compact", Event::PostCompact)] {
            let hooks = parse(&format!("[[hook]]\nevent = \"{raw}\"\ncommand = \"x\"\n")).unwrap();
            assert_eq!(hooks[0].event, event);
            assert_eq!(hooks[0].on_failure, OnFailure::Warn);
            assert_eq!(event.as_str(), raw);
            assert_eq!(Event::parse(event.as_str()), Some(event));
            assert!(!event.can_block());
            let err = parse(&format!(
                "[[hook]]\nevent = \"{raw}\"\ncommand = \"x\"\non_failure = \"block\"\n"
            ))
            .unwrap_err();
            assert_eq!(err.kind, HookErrorKind::CannotBlock, "{raw}");
            assert!(err.message.contains(raw), "{}", err.message);
            // `ignore` is accepted like any observe-only event.
            parse(&format!("[[hook]]\nevent = \"{raw}\"\ncommand = \"x\"\non_failure = \"ignore\"\n"))
                .unwrap();
        }
    }

    #[test]
    fn a_compaction_hook_applies_only_to_its_own_event() {
        let hooks = parse(
            "[[hook]]\nevent = \"pre-compact\"\ncommand = \"x\"\n\
             [[hook]]\nevent = \"post-compact\"\ncommand = \"y\"\n",
        )
        .unwrap();
        assert!(hooks[0].applies_to(Event::PreCompact, None));
        assert!(!hooks[0].applies_to(Event::PostCompact, None));
        assert!(!hooks[0].applies_to(Event::PostToolBatch, None));
        assert!(hooks[1].applies_to(Event::PostCompact, None));
        assert!(!hooks[1].applies_to(Event::PreCompact, None));
    }

    #[test]
    fn no_compaction_hook_is_a_cheap_no_op() {
        let root = dir("compact-none");
        let _ = std::fs::remove_file(config_path(&root));
        assert!(fire_compaction(&root, Event::PreCompact, "main", false, true, false, None).is_none());
        // Only the two compaction events fire through this path.
        write_config(&root, &format!("[[hook]]\nevent = \"post-tool\"\ncommand = \"{OK}\"\n"));
        assert!(fire_compaction(&root, Event::PostTool, "main", false, true, false, None).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn compaction_hooks_are_told_their_event_and_agent_only() {
        let root = dir("compact-env");
        let out = root.join("seen");
        let out_path = out.display().to_string().replace('\\', "/");
        let line = "echo $FLINT_HOOK_EVENT:$JAN_HOOK_EVENT:$FLINT_HOOK_AGENT:$FLINT_HOOK_TOOL:$FLINT_HOOK_TOOL_COUNT";
        write_config(
            &root,
            &format!(
                "[[hook]]\nevent = \"pre-compact\"\ncommand = \"{line} >> '{out_path}'\"\ntools = [\"read\"]\n\
                 [[hook]]\nevent = \"post-compact\"\ncommand = \"{line} >> '{out_path}'\"\n\
                 [[hook]]\nevent = \"post-tool-batch\"\ncommand = \"echo batch >> '{out_path}'\"\n"
            ),
        );
        let hooks = load(&root).unwrap();
        let d = run_compaction_as(&hooks, Event::PreCompact, "main", &ctx(&root)).await;
        assert_eq!(d.runs.len(), 1);
        assert!(d.runs[0].ok, "{:?}", d.runs[0].error);
        let d = run_compaction_as(&hooks, Event::PostCompact, "subagent", &ctx(&root)).await;
        assert_eq!(d.runs.len(), 1);
        assert!(d.runs[0].ok, "{:?}", d.runs[0].error);
        // Not a compaction event: nothing runs, not even the batch hook.
        let d = run_compaction_as(&hooks, Event::PostToolBatch, "main", &ctx(&root)).await;
        assert!(d.runs.is_empty());
        let seen = std::fs::read_to_string(&out).unwrap();
        let lines: Vec<&str> = seen.lines().map(str::trim).collect();
        assert_eq!(
            lines,
            vec!["pre-compact:pre-compact:main::", "post-compact:post-compact:subagent::"]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_failing_or_slow_compaction_hook_never_blocks_or_waits() {
        let root = dir("compact-fail");
        write_config(
            &root,
            &format!(
                "[[hook]]\nevent = \"pre-compact\"\ncommand = \"{FAIL}\"\n\
                 [[hook]]\nevent = \"post-compact\"\ncommand = \"sleep 5\"\ntimeout_secs = 1\n"
            ),
        );
        let hooks = load(&root).unwrap();
        let d = run_compaction_as(&hooks, Event::PreCompact, "main", &ctx(&root)).await;
        assert!(d.allowed());
        assert_eq!(d.runs.len(), 1);
        assert!(!d.runs[0].ok);
        let started = std::time::Instant::now();
        let d = run_compaction_as(&hooks, Event::PostCompact, "main", &ctx(&root)).await;
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(d.allowed());
        assert_eq!(d.runs[0].error.as_ref().map(|e| e.kind), Some(HookErrorKind::TimedOut));
        // The detached path completes without panicking or surfacing.
        let handle = fire_compaction(&root, Event::PreCompact, "main", false, true, false, None).unwrap();
        handle.await.expect("the detached compaction task must not panic");
        // And the caller is never made to wait for a slow hook.
        let before = std::time::Instant::now();
        let handle = fire_compaction(&root, Event::PostCompact, "main", false, true, false, None).unwrap();
        assert!(before.elapsed() < Duration::from_millis(500));
        handle.abort();
        let _ = std::fs::remove_dir_all(&root);
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

    #[tokio::test]
    async fn a_batch_hook_is_told_whether_the_turn_was_the_main_agents_or_a_subagents() {
        let root = dir("batch-agent");
        let out = root.join("seen");
        let out_path = out.display().to_string().replace('\\', "/");
        write_config(
            &root,
            &format!(
                "[[hook]]\nevent = \"post-tool-batch\"\ncommand = \"echo $FLINT_HOOK_AGENT:$JAN_HOOK_AGENT:$FLINT_HOOK_TOOL_COUNT >> '{out_path}'\"\n"
            ),
        );
        let hooks = load(&root).unwrap();
        let names = vec!["read".to_string()];
        // The default is the main agent, so existing callers are unchanged.
        let d = run_post_tool_batch(&hooks, &names, &ctx(&root)).await;
        assert!(d.runs[0].ok, "{:?}", d.runs[0].error);
        let d = run_post_tool_batch_as(&hooks, &names, "subagent", &ctx(&root)).await;
        assert!(d.runs[0].ok && d.blocked.is_none());
        // Only the two spellings exist: anything else is the main agent.
        run_post_tool_batch_as(&hooks, &names, "../etc", &ctx(&root)).await;
        let seen = std::fs::read_to_string(&out).unwrap();
        let lines: Vec<&str> = seen.lines().map(str::trim).collect();
        assert_eq!(lines, vec!["main:main:1", "subagent:subagent:1", "main:main:1"]);
        assert_eq!(hook_agent("subagent"), "subagent");
        assert_eq!(hook_agent("main"), "main");
        assert_eq!(hook_agent(""), "main");
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

    /// The host's secrets stay out of a hook's environment.
    #[tokio::test]
    async fn a_hook_does_not_inherit_the_host_environment() {
        let root = dir("env-secret");
        let out = root.join("secret.txt");
        let out_path = out.display().to_string().replace('\\', "/");
        // A unique name no other test reads.
        std::env::set_var("FLINT_TEST_HOOK_SECRET", "hunter2");
        write_config(
            &root,
            &format!(
                "[[hook]]\nevent = \"pre-tool\"\ncommand = \"echo \\\"[$FLINT_TEST_HOOK_SECRET]\\\" > '{out_path}'\"\n"
            ),
        );
        let hooks = load(&root).unwrap();
        let decision = run(&hooks, Event::PreTool, Some("bash"), &ctx(&root)).await;
        assert!(decision.allowed());
        let seen = std::fs::read_to_string(&out).unwrap_or_default();
        assert!(!seen.contains("hunter2"), "{seen:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The plain, credential-free variables a script reads do reach a hook.
    #[tokio::test]
    async fn a_hook_keeps_the_plain_platform_variables_scripts_read() {
        let root = dir("env-extra");
        let out = root.join("extra.txt");
        let out_path = out.display().to_string().replace('\\', "/");
        std::env::set_var("XDG_CACHE_HOME", "kept-cache");
        write_config(
            &root,
            &format!(
                "[[hook]]\nevent = \"pre-tool\"\ncommand = \"echo \\\"[$XDG_CACHE_HOME]\\\" > '{out_path}'\"\n"
            ),
        );
        let hooks = load(&root).unwrap();
        let decision = run(&hooks, Event::PreTool, Some("bash"), &ctx(&root)).await;
        assert!(decision.allowed());
        let seen = std::fs::read_to_string(&out).unwrap_or_default();
        assert!(seen.contains("kept-cache"), "{seen:?}");
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

    /// Runs a confined `post-tool-batch` hook that writes `out` by a relative
    /// path, in a project folder named `tag`, and checks the file lands there.
    ///
    /// It cannot pass by not running: whether a shell can be confined is
    /// decided up front. A host that cannot says so and returns; a host that
    /// can must have run the hook, and any error from it fails the test.
    /// Returns whether the hook ran, so the caller can say so.
    async fn confined_relative_hook_lands_in_project(tag: &str, out: &str) -> bool {
        let root = dir(tag);
        write_config(
            &root,
            &format!(
                "[[hook]]\nevent = \"post-tool-batch\"\ncommand = \"echo here > {out}\"\non_failure = \"warn\"\n"
            ),
        );
        let hooks = load(&root).unwrap();
        let policy = crate::tools::jail::Policy::new(&root, false).with_home_readonly(true);
        if let Err(detail) = crate::tools::jail::select_shell(&policy) {
            eprintln!("SKIPPED {out}: no shell can be confined on this host: {detail}");
            let _ = std::fs::remove_dir_all(&root);
            return false;
        }
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
        let run = decision.runs.first().expect("a confinable host runs the hook");
        if let Some(e) = &run.error {
            panic!("a shell can be confined here, so the hook must have run: {}", e.message);
        }
        assert!(
            root.join(out).is_file(),
            "a relative path in a confined hook must land in the project"
        );
        eprintln!("RAN {out}: the confined hook started in the project");
        let _ = std::fs::remove_dir_all(&root);
        true
    }

    /// A confined PowerShell opens in System32 whatever directory it was
    /// started in, so a relative path in a hook used to land (or fail) there.
    /// A hook starts in the project, confined or not.
    #[tokio::test]
    async fn a_confined_hook_starts_in_the_project() {
        confined_relative_hook_lands_in_project("confined-cwd", "relative-hook-output.txt").await;
    }

    /// The project's path reaches a confined PowerShell inside a quoted literal.
    /// A folder named with quote, space, `&`, `^` and `%` characters must be a
    /// place to start in, never code.
    #[tokio::test]
    async fn a_confined_hook_starts_in_a_project_with_awkward_characters() {
        confined_relative_hook_lands_in_project("it's a & b ^ 100% $x `t", "awkward-output.txt").await;
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

    #[test]
    fn an_untrusted_folder_keeps_its_hooks_off_and_a_trusted_one_runs_them() {
        let dir = tempfile::tempdir().unwrap();
        let agent = dir.path().join(".jan").join("agent");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(
            agent.join("hooks.toml"),
            "[[hook]]
event = \"pre-tool\"
command = \"exit 1\"
on_failure = \"block\"
",
        )
        .unwrap();
        assert!(load_with(dir.path(), false).unwrap().is_empty(), "untrusted: nothing loads");
        assert_eq!(load_with(dir.path(), true).unwrap().len(), 1, "trusted: the hook loads");
        // And a malformed file is still reported once the folder is trusted.
        std::fs::write(agent.join("hooks.toml"), "[[hook]
").unwrap();
        assert!(load_with(dir.path(), true).is_err());
    }
}
