//! What a session can actually do right now, component by component.
//!
//! The complaint this answers is that one broken thing stopped everything. A
//! shell that could not start inside the sandbox did not degrade to "no shell":
//! it read as "Jan could not start", and a model that was reachable, a project
//! that was readable and a set of filesystem tools that all worked were
//! withheld along with it.
//!
//! The fix is not a better error message. It is that readiness was one boolean
//! for a session made of eight independent things. Each of them is probed on
//! its own here, reports its own state, and grants its own capabilities. A tool
//! is advertised when the capabilities it needs are present, and withheld with
//! a reason when they are not -- never because something unrelated failed.
//!
//! Three rules shape everything below.
//!
//! **A component reports what it found, not what it assumes.** A shell that has
//! not been probed is [`State::Checking`], never "ready"; a shell whose probe
//! failed carries the probe's own words, not a guess at what usually goes
//! wrong. This is the same discipline that stopped a missing environment
//! variable being reported as a Git installed in the wrong place.
//!
//! **Degraded is not unavailable.** A machine whose only sandboxed shell is
//! `cmd` can still run shell-neutral commands, so `bash` stays advertised and a
//! POSIX-only command is refused with the reason. Collapsing that to
//! "unavailable" would withhold work that would have succeeded.
//!
//! **Diagnostics carry names, states and reason codes -- never values.** The
//! report is meant to be copied into a bug report by a user who should not have
//! to audit it for their own secrets first.

use std::collections::BTreeSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// One independently-probed part of a session's environment.
///
/// Independent is the whole point: these do not form a chain, and no component
/// is a precondition for reporting any other. A session with no model still
/// reports whether its shell works, because the person looking at the report is
/// often trying to find out exactly that.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Component {
    /// A provider that will accept a request for the selected model.
    Model,
    /// The context window in force for that model.
    Context,
    /// Reading and writing files inside the project.
    Filesystem,
    /// A shell that can run a command.
    Shell,
    /// OS-level confinement for anything the shell runs.
    Sandbox,
    /// Imported MCP servers and their tools.
    Mcp,
    /// The attached folder, checkout or worktree.
    Workspace,
    /// A local inference runtime (llama.cpp and friends).
    LocalRuntime,
}

impl Component {
    pub fn as_str(self) -> &'static str {
        match self {
            Component::Model => "model",
            Component::Context => "context",
            Component::Filesystem => "filesystem",
            Component::Shell => "shell",
            Component::Sandbox => "sandbox",
            Component::Mcp => "mcp",
            Component::Workspace => "workspace",
            Component::LocalRuntime => "local-runtime",
        }
    }

    /// Every component, in the order a report renders them. Deliberately fixed:
    /// a list that reordered itself as things broke would be unreadable.
    pub const ALL: &'static [Component] = &[
        Component::Model,
        Component::Context,
        Component::Filesystem,
        Component::Shell,
        Component::Sandbox,
        Component::Mcp,
        Component::Workspace,
        Component::LocalRuntime,
    ];
}

/// How a component is doing.
///
/// Five states rather than two, because the useful distinctions are all in the
/// middle. `Checking` is not a failure and must not read as one. `Degraded` is
/// working with less than usual and must not withhold what still works.
/// `Blocked` is a decision somebody made -- a policy, a setting, a refused
/// permission -- and is fixed by changing that decision, not by retrying.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    /// Not yet probed, or a probe is in flight.
    Checking,
    /// Everything this component offers is available.
    Ready,
    /// Working, with less than its full capability set.
    Degraded,
    /// Not working. Retrying might help.
    Unavailable,
    /// Deliberately off: policy, configuration, or a withheld permission.
    Blocked,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Checking => "checking",
            State::Ready => "ready",
            State::Degraded => "degraded",
            State::Unavailable => "unavailable",
            State::Blocked => "blocked",
        }
    }

    /// Can this component still be used for anything?
    ///
    /// `Degraded` counts. That is the point of having it: a shell that can only
    /// run `cmd` is worth more than no shell, and a session that treated the two
    /// the same would withhold every command that would have worked.
    pub fn usable(self) -> bool {
        matches!(self, State::Ready | State::Degraded)
    }
}

/// A stable machine-readable cause.
///
/// Stable is a promise: these strings end up in tests, in bug reports and in
/// whatever the UI keys its guidance off, so they are chosen to survive
/// rewording of the human message beside them. They are also deliberately
/// specific -- `shell-runtime-incompatible` and `shell-missing` demand
/// completely different things from the user, and one code for both would
/// re-create the problem this module exists to fix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    /// Nothing is wrong.
    Ok,
    /// A probe has not run yet.
    NotProbed,
    /// The project folder does not exist or is not a directory.
    WorkspaceMissing,
    /// No folder is attached to this session.
    WorkspaceUnattached,
    /// The project folder exists but cannot be read.
    FilesystemUnreadable,
    /// The project folder is readable but not writable.
    FilesystemReadOnly,
    /// No shell was found on this machine at all.
    ShellMissing,
    /// A shell exists and its runtime cannot start under the sandbox in force.
    /// The Windows case that motivated this: Git Bash is MSYS2, and MSYS2
    /// cannot initialise inside an AppContainer however it was installed.
    ShellRuntimeIncompatible,
    /// A shell exists and could not start, for a reason its probe reported.
    ShellProbeFailed,
    /// The only usable shell is not POSIX, so POSIX-only commands are refused.
    ShellNonPosixOnly,
    /// No OS confinement backend exists here, so no command may be run.
    SandboxUnavailable,
    /// Confinement exists and the user or policy turned it off.
    SandboxDisabled,
    /// No provider or model is selected.
    ModelUnselected,
    /// A provider is selected and rejected the request.
    ModelUnreachable,
    /// The model's context window could not be discovered from any source.
    ContextUnknown,
    /// No MCP server is configured. Not a fault.
    McpNoneConfigured,
    /// One or more configured MCP servers failed to start or connect.
    McpUnreachable,
    /// No local inference runtime is installed. Not a fault for a remote model.
    LocalRuntimeAbsent,
    /// A local runtime is installed and is not currently serving.
    LocalRuntimeStopped,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Ok => "ok",
            Reason::NotProbed => "not-probed",
            Reason::WorkspaceMissing => "workspace-missing",
            Reason::WorkspaceUnattached => "workspace-unattached",
            Reason::FilesystemUnreadable => "filesystem-unreadable",
            Reason::FilesystemReadOnly => "filesystem-read-only",
            Reason::ShellMissing => "shell-missing",
            Reason::ShellRuntimeIncompatible => "shell-runtime-incompatible",
            Reason::ShellProbeFailed => "shell-probe-failed",
            Reason::ShellNonPosixOnly => "shell-non-posix-only",
            Reason::SandboxUnavailable => "sandbox-unavailable",
            Reason::SandboxDisabled => "sandbox-disabled",
            Reason::ModelUnselected => "model-unselected",
            Reason::ModelUnreachable => "model-unreachable",
            Reason::ContextUnknown => "context-unknown",
            Reason::McpNoneConfigured => "mcp-none-configured",
            Reason::McpUnreachable => "mcp-unreachable",
            Reason::LocalRuntimeAbsent => "local-runtime-absent",
            Reason::LocalRuntimeStopped => "local-runtime-stopped",
        }
    }

    /// Would running the probe again plausibly give a different answer?
    ///
    /// A property of the cause, not of the component. Starting a server, fixing
    /// a permission or plugging in a network all change what a retry finds;
    /// MSYS2's incompatibility with AppContainer does not, and offering "Retry"
    /// for it would waste the user's time and imply the diagnosis is uncertain.
    pub fn retryable(self) -> bool {
        !matches!(
            self,
            Reason::Ok
                | Reason::ShellRuntimeIncompatible
                | Reason::ShellNonPosixOnly
                | Reason::McpNoneConfigured
                | Reason::LocalRuntimeAbsent
                | Reason::SandboxDisabled
        )
    }
}

/// What a component grants when it is working.
///
/// Capability strings rather than a closed enum, because this is the join
/// between two lists that change at different rates: what an environment
/// offers, and what a tool needs. A tool asks for `fs.write`; whichever
/// component can provide it, provides it.
pub mod capability {
    pub const FS_READ: &str = "fs.read";
    pub const FS_WRITE: &str = "fs.write";
    /// A shell that speaks POSIX. `bash` commands need this specifically.
    pub const SHELL_POSIX: &str = "shell.posix";
    /// Any shell at all, whatever language it speaks.
    pub const SHELL_ANY: &str = "shell.any";
    /// Commands will be OS-confined when they run.
    pub const SANDBOX_ENFORCED: &str = "sandbox.enforced";
    /// A provider will accept a request.
    pub const MODEL_DISPATCH: &str = "model.dispatch";
    /// That provider supports tool calls.
    pub const MODEL_TOOLS: &str = "model.tools";
    /// The context window is known, so it can be enforced rather than guessed.
    pub const CONTEXT_KNOWN: &str = "context.known";
    /// At least one MCP server is connected.
    pub const MCP_TOOLS: &str = "mcp.tools";
    /// A folder is attached.
    pub const WORKSPACE_ATTACHED: &str = "workspace.attached";
}

/// One component's answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentReport {
    pub component: Component,
    pub state: State,
    pub reason: Reason,
    /// One sentence a person can act on. Never contains a value, a path under
    /// the user's profile, a command, or a credential.
    pub message: String,
    /// Unix milliseconds. `None` when the component has not been probed.
    pub checked_at_ms: Option<i64>,
    /// Whether an explicit "Retry check" is worth offering.
    pub retryable: bool,
    /// What this component grants right now. Empty when it is not usable.
    pub capabilities: Vec<String>,
    /// Extra lines for a copied diagnostic. Same redaction rules as `message`.
    pub details: Vec<String>,
}

impl ComponentReport {
    /// A component that has not been probed. The honest starting state, and the
    /// reason a report never has to invent a value to have something to render.
    pub fn checking(component: Component) -> Self {
        Self {
            component,
            state: State::Checking,
            reason: Reason::NotProbed,
            message: "Still checking.".to_string(),
            checked_at_ms: None,
            retryable: true,
            capabilities: Vec::new(),
            details: Vec::new(),
        }
    }

    pub fn new(
        component: Component,
        state: State,
        reason: Reason,
        message: impl Into<String>,
        now_ms: i64,
    ) -> Self {
        Self {
            component,
            state,
            reason,
            message: message.into(),
            checked_at_ms: Some(now_ms),
            retryable: reason.retryable(),
            capabilities: Vec::new(),
            details: Vec::new(),
        }
    }

    pub fn granting(mut self, capabilities: &[&str]) -> Self {
        // A component that is not usable grants nothing, whatever it was
        // handed. Enforced here rather than trusted at every call site: a
        // capability leaking out of a failed component is exactly how an
        // unusable tool gets advertised.
        if self.state.usable() {
            self.capabilities = capabilities.iter().map(|c| c.to_string()).collect();
        }
        self
    }

    pub fn detailed(mut self, details: Vec<String>) -> Self {
        self.details = details;
        self
    }
}

/// Every component's answer, together.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentReadiness {
    pub components: Vec<ComponentReport>,
    pub generated_at_ms: i64,
}

impl EnvironmentReadiness {
    /// A report where nothing has been probed yet.
    pub fn checking(now_ms: i64) -> Self {
        Self {
            components: Component::ALL
                .iter()
                .map(|c| ComponentReport::checking(*c))
                .collect(),
            generated_at_ms: now_ms,
        }
    }

    pub fn get(&self, component: Component) -> Option<&ComponentReport> {
        self.components.iter().find(|c| c.component == component)
    }

    /// Replace one component's answer, keeping the fixed render order.
    pub fn set(&mut self, report: ComponentReport) {
        match self
            .components
            .iter_mut()
            .find(|c| c.component == report.component)
        {
            Some(slot) => *slot = report,
            None => self.components.push(report),
        }
        self.components.sort_by_key(|c| c.component);
    }

    /// Everything the session can do right now.
    pub fn capabilities(&self) -> BTreeSet<&str> {
        self.components
            .iter()
            .flat_map(|c| c.capabilities.iter().map(String::as_str))
            .collect()
    }

    /// Is the session usable at all?
    ///
    /// Deliberately narrow: a session is usable when a model will answer. Not
    /// when everything works -- that is the conflation this module exists to
    /// undo, and a machine with no shell is a perfectly good place to have a
    /// conversation.
    pub fn can_chat(&self) -> bool {
        self.capabilities().contains(capability::MODEL_DISPATCH)
    }
}

/// Whether a tool may be offered, and why not when it may not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ToolAvailability {
    Available,
    Unavailable {
        /// Which component's absence is responsible.
        component: Component,
        reason: Reason,
        /// What a tool call should return if one is attempted anyway.
        message: String,
    },
}

impl ToolAvailability {
    pub fn available(&self) -> bool {
        matches!(self, ToolAvailability::Available)
    }
}

/// What each built-in tool needs before it can be offered.
///
/// Read off the tool registry's capability classification rather than restated,
/// so a tool added there cannot silently arrive here with no requirement at all.
/// `bash` is the only one that needs two: a shell to run in and confinement to
/// run it under, and it is unavailable if either is missing.
pub fn required_capabilities(tool: &str) -> Vec<&'static str> {
    match tool {
        "bash" => vec![capability::SHELL_ANY, capability::SANDBOX_ENFORCED],
        "write" | "edit" | "memory_write" | "memory_propose" | "skill_write"
        // A message is written to a mailbox on disk, so it needs the same
        // thing writing a file needs.
        | "message_send"
        // Clones in-process (no shell) into a directory it creates, so a
        // writable disk is all it needs; the network is the gate's call, as
        // for the web tools.
        | "git_clone" => {
            vec![capability::FS_WRITE]
        }
        "read" | "ls" | "find" | "grep" | "screenshot" | "memory_list" | "memory_read"
        | "skill_list" | "skill_read" | "message_check" | "git_inspect" | "windows_events" | "host_query" | "local_http" | "docker" | "host_action" | "host_build" | "clipboard" | "open_path" | "host_powershell" | "host_package" | "host_wsl" | "host_ssh" | "notify_user" => vec![capability::FS_READ],
        // Runs the host's git/gh directly (no shell, no sandbox); each call is
        // confined and classified by the tool itself and the gate.
        "git" => vec![capability::FS_READ],
        // Runs an installed browser against a local app with a temporary
        // profile: no project file is read or written, and whether a browser
        // is installed is answered by the tool itself, with how to fix it.
        "browser" => vec![capability::FS_READ],
        // The mailbox is files under the data folder; nothing beyond a usable
        // local disk is needed. Scope (session only) is decided separately.
        "list_sessions" | "send_message" | "read_messages" | "wait_for_reply" => {
            vec![capability::FS_READ]
        }
        // Writes a stop request under the data folder, never into the
        // project, so a session with review-only access to its folder still
        // has it. What fences it is the per-call approval, not the disk.
        "stop_session" => vec![capability::FS_READ],
        // Answered by the desktop: a prompt, and Flint's plugin state.
        "request_access" | "list_plugins" | "open_in_browser" | "generate_image" => vec![capability::FS_READ],
        // Answered by the desktop's web layer, or refused plainly elsewhere.
        n if crate::tools::is_browser_tool(n) => vec![capability::FS_READ],
        // The web tools reach the network, which is a per-run policy decision
        // rather than an environment fact, and is enforced by the gate. Nothing
        // about the environment withholds them.
        _ => Vec::new(),
    }
}

/// May this tool be advertised to the model?
///
/// Advertising a tool that every call will refuse costs a model turn and reads
/// as a bug, so the tool list is built from this. The refusal message is
/// produced here too, so the list and the executor cannot disagree about why.
pub fn tool_availability(readiness: &EnvironmentReadiness, tool: &str) -> ToolAvailability {
    let have = readiness.capabilities();
    for needed in required_capabilities(tool) {
        if have.contains(needed) {
            continue;
        }
        // Name the component that would have granted it. Reporting "some
        // capability is missing" would put the user back where they started.
        let blame = readiness
            .components
            .iter()
            .filter(|c| !c.state.usable())
            .find(|c| grants_when_ready(c.component).contains(&needed))
            .or_else(|| {
                readiness
                    .components
                    .iter()
                    .find(|c| grants_when_ready(c.component).contains(&needed))
            });
        return match blame {
            Some(report) => ToolAvailability::Unavailable {
                component: report.component,
                reason: report.reason,
                message: format!(
                    "`{tool}` needs {} and it is {}. {}",
                    report.component.as_str(),
                    report.state.as_str(),
                    report.message
                ),
            },
            None => ToolAvailability::Unavailable {
                component: Component::Filesystem,
                reason: Reason::NotProbed,
                message: format!("`{tool}` needs {needed}, which nothing has reported on yet."),
            },
        };
    }
    ToolAvailability::Available
}

/// Which capabilities a component grants when it is working. Used to answer
/// "who was supposed to provide this?" when one is missing.
fn grants_when_ready(component: Component) -> &'static [&'static str] {
    match component {
        Component::Filesystem => &[capability::FS_READ, capability::FS_WRITE],
        Component::Shell => &[capability::SHELL_ANY, capability::SHELL_POSIX],
        Component::Sandbox => &[capability::SANDBOX_ENFORCED],
        Component::Model => &[capability::MODEL_DISPATCH, capability::MODEL_TOOLS],
        Component::Context => &[capability::CONTEXT_KNOWN],
        Component::Mcp => &[capability::MCP_TOOLS],
        Component::Workspace => &[capability::WORKSPACE_ATTACHED],
        Component::LocalRuntime => &[],
    }
}

/// Unix milliseconds, or 0 on a clock that cannot be read. Only used for
/// "last checked", where a wrong-but-monotonic answer is better than refusing
/// to produce a report.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Probes for the components the backend owns
// ---------------------------------------------------------------------------

/// Probe the workspace: is a folder attached, and does it exist?
pub fn probe_workspace(project_root: Option<&Path>, now_ms: i64) -> ComponentReport {
    let Some(root) = project_root else {
        return ComponentReport::new(
            Component::Workspace,
            State::Unavailable,
            Reason::WorkspaceUnattached,
            "No folder is attached to this session. Attach one to give the tools \
             something to work on.",
            now_ms,
        );
    };
    if !root.is_dir() {
        return ComponentReport::new(
            Component::Workspace,
            State::Unavailable,
            Reason::WorkspaceMissing,
            "The attached folder no longer exists. Re-attach it, or pick another.",
            now_ms,
        );
    }
    ComponentReport::new(
        Component::Workspace,
        State::Ready,
        Reason::Ok,
        "A folder is attached.",
        now_ms,
    )
    .granting(&[capability::WORKSPACE_ATTACHED])
}

/// Probe the filesystem tools: can the project be read, and written?
///
/// Writability is tested by actually creating and removing a file, because the
/// alternatives all lie on Windows: the read-only attribute does not mean what
/// it says on a directory, and an ACL that denies writes is not visible in
/// metadata the way a Unix mode bit is.
pub fn probe_filesystem(project_root: Option<&Path>, now_ms: i64) -> ComponentReport {
    // No folder attached is not "no filesystem". The desktop runs the file
    // tools in the conversation's own private workspace, created on demand by
    // `execute_tool`, and the memory and skill tools use the permanent store;
    // neither needs a folder. Reporting this as unavailable withheld every one
    // of those tools from a Cowork session with no folder: the model asked for
    // `ls`, the SDK refused an unadvertised tool, and the run ended with
    // nothing done and nothing said. The Workspace component still reports the
    // folder as unattached, which is the true part.
    let Some(root) = project_root else {
        return ComponentReport::new(
            Component::Filesystem,
            State::Ready,
            Reason::Ok,
            "No folder is attached, so the file tools work in this conversation's own private workspace. Attach a folder to work on your own files.",
            now_ms,
        )
        .granting(&[capability::FS_READ, capability::FS_WRITE]);
    };
    if std::fs::read_dir(root).is_err() {
        return ComponentReport::new(
            Component::Filesystem,
            State::Unavailable,
            Reason::FilesystemUnreadable,
            "The attached folder cannot be read. Check that it still exists and that \
             you have access to it.",
            now_ms,
        );
    }
    let probe = root.join(format!(".jan-write-probe-{}", std::process::id()));
    let writable = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    if !writable {
        return ComponentReport::new(
            Component::Filesystem,
            State::Degraded,
            Reason::FilesystemReadOnly,
            "The attached folder is readable but not writable, so reading and \
             searching work and editing does not.",
            now_ms,
        )
        .granting(&[capability::FS_READ]);
    }
    ComponentReport::new(
        Component::Filesystem,
        State::Ready,
        Reason::Ok,
        "The attached folder can be read and written.",
        now_ms,
    )
    .granting(&[capability::FS_READ, capability::FS_WRITE])
}

/// Probe the sandbox: is there a backend that can confine a command here?
///
/// Separate from the shell on purpose. "No confinement" and "no shell" both
/// stop `bash`, and they are fixed by completely different things -- one by a
/// setting or a kernel feature, the other by installing a shell -- so a report
/// that merged them would send half its readers to the wrong place.
pub fn probe_sandbox(now_ms: i64) -> ComponentReport {
    let backend = crate::tools::jail::backend();
    if !backend.enforces() {
        return ComponentReport::new(
            Component::Sandbox,
            State::Unavailable,
            Reason::SandboxUnavailable,
            "No OS sandbox is available on this system, so commands cannot be \
             confined and the shell tool is withheld. Reading and searching are \
             unaffected.",
            now_ms,
        )
        .detailed(vec![format!("backend={}", backend.as_str())]);
    }
    ComponentReport::new(
        Component::Sandbox,
        State::Ready,
        Reason::Ok,
        "Commands will be confined to this session's workspace.",
        now_ms,
    )
    .granting(&[capability::SANDBOX_ENFORCED])
    .detailed(vec![format!("backend={}", backend.as_str())])
}

/// Probe the shell by starting one.
///
/// The only honest way to answer. A path that exists, a file that is
/// executable and an ACL that grants read+execute are each necessary and none
/// of them is sufficient: Git Bash under `C:\Program Files` satisfies all three
/// and still cannot start inside an AppContainer, because the MSYS2 runtime it
/// is built on needs the global object namespace the container withholds.
///
/// The report says which shell was chosen, where it came from, and -- when the
/// chosen one is not POSIX -- why the POSIX one was not used, in that shell's
/// own words rather than a guess.
/// Where a shell is probed when no folder is attached: an empty directory of
/// Jan's own under the temporary directory, never the temporary directory
/// itself.
///
/// On Windows the sandbox grants the container its workspace by rewriting that
/// directory's ACL. For all of `%TEMP%` (thousands of entries, some held open
/// by other programs) that took longer than the probe is given, so every shell
/// "failed to start" and `bash` was withheld from every run asked about with no
/// project root. That includes every Cowork run, whose tool list is built that
/// way. A folder-scoped probe on the same machine found PowerShell in a third
/// of a second. Falls back to the temporary directory only if the empty one
/// cannot be made.
fn unattached_probe_root() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("jan-shell-probe");
    match std::fs::create_dir_all(&dir) {
        Ok(()) => dir,
        Err(_) => std::env::temp_dir(),
    }
}

pub fn probe_shell(project_root: Option<&Path>, now_ms: i64) -> ComponentReport {
    use crate::tools::jail;
    use crate::tools::proc::{ProbeOutcome, ShellFlavor};

    // Same premise as the filesystem: with no folder attached, `bash` runs in
    // the conversation's private workspace, so there is somewhere to start a
    // shell. Probed from the temporary directory, which always exists, rather
    // than refused -- refusing withheld `bash` from every session without a
    // folder.
    let Some(root) = project_root else {
        return probe_shell(Some(&unattached_probe_root()), now_ms);
    };
    if !root.is_dir() {
        return ComponentReport::new(
            Component::Shell,
            State::Unavailable,
            Reason::WorkspaceMissing,
            "The attached folder no longer exists, so no shell can be started in it.",
            now_ms,
        );
    }

    // Network off for the probe regardless of the run's policy: starting a
    // shell must not be the thing that opens a socket.
    let policy = jail::Policy::new(root, false);
    let reports = jail::shell_reports(&policy);
    // Names and outcomes only. A shell's path is not a secret, but the report
    // is copied verbatim into bug reports, so it carries the shell's basename
    // and its classification rather than a full path under someone's profile.
    let details: Vec<String> = reports
        .iter()
        .map(|r| {
            format!(
                "{} ({}, {}): {}",
                r.cfg
                    .program
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "?".to_string()),
                r.cfg.description,
                r.origin.as_str(),
                r.outcome.as_str()
            )
        })
        .collect();

    let Some(chosen) = reports.iter().find(|r| r.outcome.usable()) else {
        // Nothing started. Report the most specific thing any candidate said,
        // preferring a runtime incompatibility, because that is the one the
        // user cannot fix by installing anything.
        let incompatible = reports.iter().find(|r| match &r.outcome {
            ProbeOutcome::Unusable { reason } => reason.contains("MSYS2"),
            _ => false,
        });
        if let Some(r) = incompatible {
            return ComponentReport::new(
                Component::Shell,
                State::Unavailable,
                Reason::ShellRuntimeIncompatible,
                format!(
                    "{} is installed and cannot run inside the sandbox: the MSYS2 \
                     runtime it is built on cannot start in a Windows AppContainer. \
                     Installing Git somewhere else will not change this. Chat, file \
                     reading and editing are unaffected.",
                    r.cfg.description
                ),
                now_ms,
            )
            .detailed(details);
        }
        let nothing_installed = reports
            .iter()
            .all(|r| matches!(r.outcome, ProbeOutcome::Missing));
        let (reason, message) = if reports.is_empty() || nothing_installed {
            (
                Reason::ShellMissing,
                "No shell is installed on this machine, so the shell tool is \
                 withheld. Chat and the file tools are unaffected."
                    .to_string(),
            )
        } else {
            (
                Reason::ShellProbeFailed,
                "No shell on this machine could be started inside the sandbox. \
                 Chat and the file tools are unaffected."
                    .to_string(),
            )
        };
        return ComponentReport::new(
            Component::Shell,
            State::Unavailable,
            reason,
            message,
            now_ms,
        )
        .detailed(details);
    };

    if chosen.cfg.flavor == ShellFlavor::Posix {
        return ComponentReport::new(
            Component::Shell,
            State::Ready,
            Reason::Ok,
            format!("{} starts inside the sandbox.", chosen.cfg.description),
            now_ms,
        )
        .granting(&[capability::SHELL_ANY, capability::SHELL_POSIX])
        .detailed(details);
    }

    // A shell that runs, in a language the tool's commands are not written in.
    // Degraded rather than unavailable: shell-neutral commands still work, and
    // a POSIX-only one is refused per command where the construct can be named.
    let posix_note = reports
        .iter()
        .find(|r| r.cfg.flavor == ShellFlavor::Posix)
        .map(|r| match &r.outcome {
            ProbeOutcome::Unusable { reason } => {
                format!(" No POSIX shell is being used because {reason}")
            }
            ProbeOutcome::Missing => " No POSIX shell is installed.".to_string(),
            _ => String::new(),
        })
        .unwrap_or_else(|| " No POSIX shell is installed.".to_string());
    ComponentReport::new(
        Component::Shell,
        State::Degraded,
        Reason::ShellNonPosixOnly,
        format!(
            "Only {} could be started in the sandbox, so commands written in POSIX \
             syntax are refused rather than reinterpreted.{posix_note}",
            chosen.cfg.description
        ),
        now_ms,
    )
    .granting(&[capability::SHELL_ANY])
    .detailed(details)
}

/// Probe every component the backend owns.
///
/// The provider-side components -- model, context, MCP, local runtime -- are
/// facts the backend does not hold, so they stay [`State::Checking`] here and
/// are filled in by whoever does hold them. That is deliberate: a component
/// nobody has answered for reads as unanswered, never as ready.
pub fn probe_backend(project_root: Option<&Path>) -> EnvironmentReadiness {
    let now = now_ms();
    let mut readiness = EnvironmentReadiness::checking(now);
    readiness.set(probe_workspace(project_root, now));
    readiness.set(probe_filesystem(project_root, now));
    readiness.set(probe_sandbox(now));
    readiness.set(probe_shell(project_root, now));
    readiness
}

// ---------------------------------------------------------------------------
// The readiness service
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Cached readiness, keyed by the project root it was probed for.
///
/// Cached because probing starts processes: the shell probe launches a
/// sandboxed shell, and doing that on every dispatch would put a process
/// launch in front of every model turn. Keyed by root because the answers are
/// about a particular folder -- a shell that starts in one project's workspace
/// says nothing about a folder that has since been deleted.
///
/// Invalidation is per component rather than wholesale ([`invalidate`]), so
/// retrying a failed MCP connection does not throw away a shell probe that
/// cost a process launch and has not changed.
fn cache() -> &'static Mutex<HashMap<String, EnvironmentReadiness>> {
    static CACHE: OnceLock<Mutex<HashMap<String, EnvironmentReadiness>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The cache key for a project root. Case-folded on Windows only, where two
/// spellings are one folder and must not probe twice. Elsewhere `Proj` and
/// `proj` are two folders and must not share an answer (Jozkah/jan#285).
fn key(project_root: Option<&Path>) -> String {
    project_root
        .map(|p| {
            let text = p.to_string_lossy();
            if cfg!(windows) {
                text.to_lowercase()
            } else {
                text.into_owned()
            }
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod key_tests {
    #[test]
    fn two_spellings_share_a_key_only_where_they_are_one_folder() {
        let a = super::key(Some(std::path::Path::new("/home/u/Proj")));
        let b = super::key(Some(std::path::Path::new("/home/u/proj")));
        assert_eq!(a == b, cfg!(windows));
    }
}

/// The readiness for `project_root`, probing only if it is not already known.
///
/// This is what a dispatch calls. It must be cheap on the common path, which is
/// why the probe result is kept rather than recomputed.
pub fn current(project_root: Option<&Path>) -> EnvironmentReadiness {
    let cache_key = key(project_root);
    if let Ok(cache) = cache().lock() {
        if let Some(hit) = cache.get(&cache_key) {
            return hit.clone();
        }
    }
    let fresh = probe_backend(project_root);
    if let Ok(mut cache) = cache().lock() {
        cache.insert(cache_key, fresh.clone());
    }
    fresh
}

/// Re-probe one component and store the result.
///
/// The other components keep their existing answers and timestamps: a user
/// pressing "Retry" on the shell row is asking about the shell, and silently
/// re-probing everything else would make the timestamps beside them lie about
/// when they were last checked.
pub fn retry(project_root: Option<&Path>, component: Component) -> EnvironmentReadiness {
    let mut readiness = current(project_root);
    let now = now_ms();
    let fresh = match component {
        Component::Workspace => probe_workspace(project_root, now),
        Component::Filesystem => probe_filesystem(project_root, now),
        Component::Sandbox => probe_sandbox(now),
        Component::Shell => {
            // A shell probe is cached in `jail` as well, keyed by backend and
            // path. Retrying has to reach past that or it would return the
            // failure it is being asked to re-test.
            crate::tools::jail::invalidate_probe_cache();
            probe_shell(project_root, now)
        }
        // The backend does not hold these; re-probing them here would replace a
        // real answer from whoever does with an invented one.
        Component::Model | Component::Context | Component::Mcp | Component::LocalRuntime => {
            return readiness
        }
    };
    readiness.set(fresh);
    readiness.generated_at_ms = now;
    if let Ok(mut cache) = cache().lock() {
        cache.insert(key(project_root), readiness.clone());
    }
    readiness
}

/// Re-probe every component the backend owns.
pub fn retry_all(project_root: Option<&Path>) -> EnvironmentReadiness {
    crate::tools::jail::invalidate_probe_cache();
    let fresh = probe_backend(project_root);
    if let Ok(mut cache) = cache().lock() {
        cache.insert(key(project_root), fresh.clone());
    }
    fresh
}

/// Forget what is known about one project root, so the next read re-probes.
/// Called when something that could change the answers changes -- a settings
/// edit, a different shell, a folder re-attached.
pub fn invalidate(project_root: Option<&Path>) {
    if let Ok(mut cache) = cache().lock() {
        cache.remove(&key(project_root));
    }
}

/// Forget everything. For a settings change whose blast radius is every root.
pub fn invalidate_all() {
    crate::tools::jail::invalidate_probe_cache();
    if let Ok(mut cache) = cache().lock() {
        cache.clear();
    }
}

/// Merge in the components only the renderer's own stores can answer for.
///
/// Provider reachability, the resolved context window and MCP connection state
/// live in the frontend's stores, so they arrive with the request rather than
/// being probed here. They are merged into the same record, judged by the same
/// state machine and gated through the same capability lookup -- so "the
/// renderer must not decide readiness" holds where it matters: the renderer
/// supplies facts, this module decides what they mean.
pub fn merge_reported(readiness: &mut EnvironmentReadiness, reported: Vec<ComponentReport>) {
    for report in reported {
        match report.component {
            // Backend-owned components are not overridable from outside. A
            // caller claiming the shell works would re-open exactly the hole
            // this module was written to close.
            Component::Workspace
            | Component::Filesystem
            | Component::Shell
            | Component::Sandbox => continue,
            _ => readiness.set(report),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(component: Component, caps: &[&str]) -> ComponentReport {
        ComponentReport::new(component, State::Ready, Reason::Ok, "fine", 1).granting(caps)
    }

    fn broken(component: Component, reason: Reason, message: &str) -> ComponentReport {
        ComponentReport::new(component, State::Unavailable, reason, message, 1)
    }

    /// The shape of the machine the bug report came from: a reachable model, a
    /// readable project, and a shell that cannot start in the sandbox.
    fn windows_without_bash() -> EnvironmentReadiness {
        let mut r = EnvironmentReadiness::checking(1);
        r.set(ready(
            Component::Model,
            &[capability::MODEL_DISPATCH, capability::MODEL_TOOLS],
        ));
        r.set(ready(
            Component::Filesystem,
            &[capability::FS_READ, capability::FS_WRITE],
        ));
        r.set(ready(
            Component::Workspace,
            &[capability::WORKSPACE_ATTACHED],
        ));
        r.set(ready(Component::Sandbox, &[capability::SANDBOX_ENFORCED]));
        r.set(broken(
            Component::Shell,
            Reason::ShellRuntimeIncompatible,
            "Git Bash cannot start inside the sandbox.",
        ));
        r
    }

    #[test]
    fn nothing_is_ready_before_it_is_probed() {
        let r = EnvironmentReadiness::checking(7);
        assert_eq!(r.components.len(), Component::ALL.len());
        for report in &r.components {
            assert_eq!(report.state, State::Checking);
            assert_eq!(report.reason, Reason::NotProbed);
            assert!(report.capabilities.is_empty());
            assert_eq!(report.checked_at_ms, None);
        }
        assert!(!r.can_chat());
    }

    /// The headline behaviour. A dead shell must not take the conversation with
    /// it.
    #[test]
    fn a_model_still_answers_when_the_shell_cannot_start() {
        let r = windows_without_bash();
        assert!(r.can_chat(), "a working model must not be withheld");
        assert_eq!(r.get(Component::Shell).unwrap().state, State::Unavailable);
        assert_eq!(r.get(Component::Model).unwrap().state, State::Ready);
    }

    /// An unknown context window is not a reason to refuse to start.
    #[test]
    fn a_model_still_answers_when_the_context_window_is_unknown() {
        let mut r = windows_without_bash();
        r.set(broken(
            Component::Context,
            Reason::ContextUnknown,
            "This provider does not report a context window.",
        ));
        assert!(r.can_chat());
        assert!(!r.capabilities().contains(capability::CONTEXT_KNOWN));
    }

    /// The other half: filesystem tools survive a dead shell, because they
    /// never needed it.
    #[test]
    fn the_file_tools_survive_a_shell_that_cannot_start() {
        let r = windows_without_bash();
        for tool in ["read", "ls", "find", "grep", "write", "edit"] {
            assert!(
                tool_availability(&r, tool).available(),
                "{tool} should still be offered"
            );
        }
        assert!(!tool_availability(&r, "bash").available());
    }

    /// And a tool that is withheld says which component is responsible, in the
    /// words that component used.
    #[test]
    fn a_withheld_tool_names_the_component_and_its_own_reason() {
        let r = windows_without_bash();
        match tool_availability(&r, "bash") {
            ToolAvailability::Unavailable {
                component,
                reason,
                message,
            } => {
                assert_eq!(component, Component::Shell);
                assert_eq!(reason, Reason::ShellRuntimeIncompatible);
                assert!(message.contains("shell"), "{message}");
                assert!(message.contains("Git Bash cannot start"), "{message}");
            }
            ToolAvailability::Available => panic!("bash cannot run without a shell"),
        }
    }

    /// A read-only project is degraded, not unavailable: searching still works.
    #[test]
    fn a_read_only_project_keeps_the_read_tools() {
        let mut r = windows_without_bash();
        r.set(
            ComponentReport::new(
                Component::Filesystem,
                State::Degraded,
                Reason::FilesystemReadOnly,
                "readable, not writable",
                1,
            )
            .granting(&[capability::FS_READ]),
        );
        assert!(tool_availability(&r, "read").available());
        assert!(tool_availability(&r, "grep").available());
        assert!(!tool_availability(&r, "write").available());
        assert!(!tool_availability(&r, "edit").available());
    }

    /// MCP going down must not touch the built-in tools.
    #[test]
    fn losing_mcp_leaves_the_built_in_tools_alone() {
        let mut r = windows_without_bash();
        r.set(broken(
            Component::Mcp,
            Reason::McpUnreachable,
            "A configured MCP server did not start.",
        ));
        for tool in ["read", "write", "edit", "grep"] {
            assert!(tool_availability(&r, tool).available(), "{tool}");
        }
        assert!(r.can_chat());
    }

    /// No confinement means no shell tool, and the reason is the sandbox's, not
    /// the shell's -- they are fixed by different things.
    #[test]
    fn bash_needs_confinement_as_well_as_a_shell() {
        let mut r = EnvironmentReadiness::checking(1);
        r.set(ready(Component::Shell, &[capability::SHELL_ANY]));
        r.set(broken(
            Component::Sandbox,
            Reason::SandboxUnavailable,
            "No OS sandbox backend is available on this system.",
        ));
        match tool_availability(&r, "bash") {
            ToolAvailability::Unavailable {
                component, reason, ..
            } => {
                assert_eq!(component, Component::Sandbox);
                assert_eq!(reason, Reason::SandboxUnavailable);
            }
            ToolAvailability::Available => panic!("an unconfined shell must not be offered"),
        }
    }

    /// A degraded shell still runs commands. Withholding `bash` because the
    /// only shell is `cmd` would refuse work that would have succeeded; the
    /// POSIX-only refusal happens per command, where it can name the construct.
    #[test]
    fn a_non_posix_shell_still_offers_bash() {
        let mut r = windows_without_bash();
        r.set(
            ComponentReport::new(
                Component::Shell,
                State::Degraded,
                Reason::ShellNonPosixOnly,
                "Only cmd could be started in the sandbox.",
                1,
            )
            .granting(&[capability::SHELL_ANY]),
        );
        assert!(tool_availability(&r, "bash").available());
        assert!(!r.capabilities().contains(capability::SHELL_POSIX));
    }

    /// A failed component must not keep granting what it granted before.
    #[test]
    fn an_unusable_component_grants_nothing() {
        let report = broken(Component::Shell, Reason::ShellMissing, "no shell")
            .granting(&[capability::SHELL_ANY, capability::SHELL_POSIX]);
        assert!(report.capabilities.is_empty());
    }

    #[test]
    fn retryability_is_a_property_of_the_cause() {
        // Retrying cannot make MSYS2 work inside an AppContainer, and offering
        // the button would imply the diagnosis is a guess.
        assert!(!Reason::ShellRuntimeIncompatible.retryable());
        assert!(!Reason::McpNoneConfigured.retryable());
        assert!(!Reason::LocalRuntimeAbsent.retryable());
        assert!(!Reason::SandboxDisabled.retryable());
        // These can all change without Jan restarting.
        assert!(Reason::ShellProbeFailed.retryable());
        assert!(Reason::ModelUnreachable.retryable());
        assert!(Reason::McpUnreachable.retryable());
        assert!(Reason::WorkspaceMissing.retryable());
        assert!(Reason::ContextUnknown.retryable());
    }

    #[test]
    fn every_component_and_state_has_a_stable_name() {
        let names: BTreeSet<&str> = Component::ALL.iter().map(|c| c.as_str()).collect();
        assert_eq!(names.len(), Component::ALL.len(), "names must be unique");
        for state in [
            State::Checking,
            State::Ready,
            State::Degraded,
            State::Unavailable,
            State::Blocked,
        ] {
            assert!(!state.as_str().is_empty());
        }
        assert!(State::Ready.usable());
        assert!(State::Degraded.usable());
        assert!(!State::Checking.usable());
        assert!(!State::Unavailable.usable());
        assert!(!State::Blocked.usable());
    }

    /// Every built-in tool the registry knows about must have an answer here,
    /// or a tool added later would be advertised with no requirement checked.
    #[test]
    fn every_builtin_tool_is_classified() {
        for tool in crate::tools::BUILTIN_TOOLS {
            let required = required_capabilities(tool.name);
            let expected_empty = matches!(tool.capability, crate::tools::Capability::Net);
            assert_eq!(
                required.is_empty(),
                expected_empty,
                "{} has no environment requirement",
                tool.name
            );
        }
    }

    #[test]
    fn a_report_keeps_its_components_in_render_order() {
        let mut r = EnvironmentReadiness::checking(1);
        r.set(ready(Component::LocalRuntime, &[]));
        r.set(ready(Component::Model, &[capability::MODEL_DISPATCH]));
        let order: Vec<Component> = r.components.iter().map(|c| c.component).collect();
        assert_eq!(order, Component::ALL.to_vec());
    }

    #[test]
    fn an_unattached_session_says_so_rather_than_reporting_a_broken_disk() {
        let workspace = probe_workspace(None, 5);
        assert_eq!(workspace.reason, Reason::WorkspaceUnattached);
        assert!(workspace.capabilities.is_empty());
    }

    /// The regression. This test used to assert the opposite -- that with no
    /// folder attached the filesystem was unusable -- and that is what stripped
    /// every file, memory and skill tool from a Cowork session with no folder.
    /// The files the tools reach then are the conversation's private
    /// workspace, which exists whether or not a folder is attached.
    #[test]
    fn an_unattached_session_still_has_its_private_workspace() {
        let fs = probe_filesystem(None, 5);
        assert!(fs.state.usable());
        assert!(fs.capabilities.contains(&capability::FS_READ.to_string()));
        assert!(fs.capabilities.contains(&capability::FS_WRITE.to_string()));
    }

    /// And at the level that decides what the model is offered.
    #[test]
    fn an_unattached_session_is_offered_its_file_and_memory_tools() {
        let mut r = EnvironmentReadiness::checking(1);
        r.set(probe_filesystem(None, 5));
        for tool in ["read", "ls", "find", "grep", "write", "edit", "memory_read", "memory_write"] {
            assert!(
                matches!(tool_availability(&r, tool), ToolAvailability::Available),
                "{tool} must be advertised with no folder attached"
            );
        }
    }

    /// The shell is probed rather than refused when no folder is attached.
    #[test]
    fn an_unattached_session_probes_a_shell_instead_of_refusing_one() {
        let shell = probe_shell(None, 5);
        assert_ne!(shell.reason, Reason::WorkspaceUnattached);
    }

    /// Without a folder, the shell is found exactly as it is with one.
    ///
    /// The regression: with no folder the probe used the temporary directory
    /// itself as the sandbox's workspace, and on Windows the sandbox grants its
    /// workspace by rewriting that directory's ACL -- all of `%TEMP%`, which on
    /// a machine in use is far more than the probe's ten seconds. Every shell
    /// "timed out", and `bash` was withheld from every Cowork run (whose tool
    /// list is asked for with no project root) while a folder-scoped probe on
    /// the same machine found PowerShell in a third of a second.
    #[test]
    fn an_unattached_session_finds_the_shell_a_folder_would() {
        let dir = std::env::temp_dir().join(format!("jan-readiness-shell-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        crate::tools::jail::invalidate_probe_cache();
        let with_folder = probe_shell(Some(&dir), 5);
        crate::tools::jail::invalidate_probe_cache();
        let started = std::time::Instant::now();
        let without = probe_shell(None, 5);
        assert_eq!(
            without.state, with_folder.state,
            "no folder: {} / folder: {}",
            without.message, with_folder.message
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(8),
            "the unattached probe took {:?}",
            started.elapsed()
        );
        assert_ne!(
            unattached_probe_root(),
            std::env::temp_dir(),
            "the whole temporary directory must never be the probe's workspace"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_real_directory_probes_readable_and_writable() {
        let dir = std::env::temp_dir().join(format!("jan-readiness-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let workspace = probe_workspace(Some(&dir), 9);
        assert_eq!(workspace.state, State::Ready);
        assert!(workspace
            .capabilities
            .contains(&capability::WORKSPACE_ATTACHED.to_string()));

        let fs = probe_filesystem(Some(&dir), 9);
        assert_eq!(fs.state, State::Ready);
        assert!(fs.capabilities.contains(&capability::FS_WRITE.to_string()));
        assert_eq!(fs.checked_at_ms, Some(9));
        // The probe cleans up after itself.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .expect("read back")
            .filter_map(Result::ok)
            .collect();
        assert!(leftovers.is_empty(), "the write probe left a file behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_directory_is_reported_as_missing_not_unreadable() {
        let gone = std::env::temp_dir().join("jan-readiness-definitely-not-here");
        let _ = std::fs::remove_dir_all(&gone);
        assert_eq!(
            probe_workspace(Some(&gone), 3).reason,
            Reason::WorkspaceMissing
        );
        assert_eq!(
            probe_filesystem(Some(&gone), 3).reason,
            Reason::FilesystemUnreadable
        );
    }

    /// The report is meant to be pasted into a bug report. Nothing in it may
    /// need auditing first.
    #[test]
    fn no_message_carries_a_path_or_a_value() {
        let dir = std::env::temp_dir().join(format!("jan-readiness-redact-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let reports = [
            probe_workspace(Some(&dir), 1),
            probe_filesystem(Some(&dir), 1),
            probe_workspace(None, 1),
            probe_filesystem(None, 1),
        ];
        for report in reports {
            let text = format!("{} {}", report.message, report.details.join(" "));
            assert!(!text.contains(&dir.to_string_lossy().to_string()), "{text}");
            assert!(!text.contains(':'), "a path or value leaked: {text}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole report survives the IPC boundary, since the UI reads it there.
    #[test]
    fn a_report_round_trips_through_json() {
        let r = windows_without_bash();
        let json = serde_json::to_string(&r).expect("serialise");
        assert!(json.contains("\"shell-runtime-incompatible\""), "{json}");
        assert!(json.contains("\"checkedAtMs\""), "{json}");
        let back: EnvironmentReadiness = serde_json::from_str(&json).expect("deserialise");
        assert_eq!(back, r);
    }

    /// The real machine, through the real probes. Asserts the relationships
    /// rather than a fixed verdict, so it stays true on a host with a different
    /// shell -- what must hold everywhere is that a shell failure never takes
    /// the file tools with it, and that the reported reason matches the state.
    #[test]
    fn the_backend_probe_answers_for_a_real_directory() {
        let dir = std::env::temp_dir().join(format!("jan-readiness-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let readiness = probe_backend(Some(&dir));

        let workspace = readiness.get(Component::Workspace).expect("workspace");
        assert_eq!(workspace.state, State::Ready);
        let fs = readiness.get(Component::Filesystem).expect("filesystem");
        assert_eq!(fs.state, State::Ready, "{}", fs.message);
        assert!(tool_availability(&readiness, "read").available());
        assert!(tool_availability(&readiness, "write").available());

        let shell = readiness.get(Component::Shell).expect("shell");
        // Whatever the shell answered, it answered for itself.
        assert!(shell.checked_at_ms.is_some());
        assert_eq!(shell.retryable, shell.reason.retryable());
        if shell.state.usable() {
            assert!(shell
                .capabilities
                .contains(&capability::SHELL_ANY.to_string()));
        } else {
            assert!(shell.capabilities.is_empty());
        }

        // The provider-side components were not probed here and must not claim
        // to have been.
        for component in [Component::Model, Component::Context, Component::Mcp] {
            let report = readiness.get(component).expect("present");
            assert_eq!(report.state, State::Checking, "{:?}", component);
            assert_eq!(report.checked_at_ms, None);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// On Windows the shell answer must be the true one: Git Bash under
    /// Program Files is installed and system-installed, and the reason it
    /// cannot be used is its runtime, never its install location.
    #[cfg(windows)]
    #[test]
    fn the_windows_shell_answer_never_blames_the_install_location() {
        let dir = std::env::temp_dir().join(format!("jan-readiness-win-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let shell = probe_shell(Some(&dir), now_ms());
        let text = format!("{} {}", shell.message, shell.details.join(" "));
        assert!(!text.contains("user profile"), "{text}");
        assert!(
            !text.contains("install Git for Windows system-wide"),
            "{text}"
        );
        if shell.reason == Reason::ShellRuntimeIncompatible {
            assert!(text.contains("MSYS2"), "{text}");
            assert!(
                text.contains("will not change this"),
                "the message must say reinstalling is not a remedy: {text}"
            );
            assert!(
                !shell.retryable,
                "a runtime incompatibility is not retryable"
            );
        }
        // Whatever happened, the classification of where each shell lives is a
        // fact about its path and is reported as such.
        if !shell.details.is_empty() {
            assert!(
                shell.details.iter().any(|d| d.contains("system-install")
                    || d.contains("windows-system")
                    || d.contains("user-install")
                    || d.contains("elsewhere")
                    || d.contains("configured")
                    || d.contains("bundled")),
                "{:?}",
                shell.details
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The sandbox component reports the backend that will actually confine
    /// commands, so the card and the executor cannot disagree.
    #[test]
    fn the_sandbox_component_matches_the_backend_execution_uses() {
        let report = probe_sandbox(now_ms());
        let enforces = crate::tools::jail::backend().enforces();
        assert_eq!(report.state.usable(), enforces);
        assert_eq!(
            report
                .capabilities
                .contains(&capability::SANDBOX_ENFORCED.to_string()),
            enforces
        );
        assert!(report.details.iter().any(|d| d.starts_with("backend=")));
    }
}
