//! Built-in agent tools: the capability classification and the `BUILTIN_TOOLS`
//! registry every other module in this crate keys off.

use std::path::{Path, PathBuf};

/// Windows-only confinement backend for [`jail`]. Present on every platform so
/// the argv it builds stays unit-testable.
pub mod appcontainer;
pub mod cmdscan;
pub mod fuzzy_edit;
pub mod gate;
pub mod git_native;
pub mod handlers;
pub mod host_tools;
pub mod image;
pub mod jail;
pub mod mcp_confine;
pub mod owned;
pub mod proc;
/// Path containment for the filesystem tools. Distinct from [`jail`], which is
/// kernel-level confinement for spawned commands.
pub mod sandbox;
pub mod schema;
pub mod shell_diag;
pub mod web;
/// Windows sandbox environment construction. Compiled on every host so its
/// rules stay unit-testable off Windows; only the AppContainer backend calls it.
pub mod win_env;

/// A single OpenAI `image_url` content part: the `data:<mime>;base64,<bytes>`
/// URL plus a display name. This is what the `read` tool returns for an image
/// file, and the agent loop threads into the tool-result message so a vision
/// model sees the image.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ImageContentPart {
    /// `data:image/png;base64,...` URL, ready to embed in an `image_url` part.
    pub data_url: String,
    /// Basename shown to the model and in the transcript.
    pub name: String,
}

/// Ambient context a tool call executes against.
///
/// The two roots are separate because they have different lifetimes.
/// `project_root` is the sandbox the filesystem tools are confined to, which the
/// desktop makes ephemeral and per-thread; `store_root` holds `memory/` and
/// `skills/`, which must survive every conversation. Keeping the store outside
/// `project_root` is also what stops the general filesystem tools from reaching
/// it -- `escapes_project` refuses the path, with no extra rule needed.
///
/// A project that co-locates its store (dev's layout, and the CLI agent) simply
/// passes `workspace::project_store(project_root)` as `store_root`.
///
/// `enabled_skills` is the `[skills].enabled` whitelist from the project's
/// `agent.toml` (empty = every skill enabled). It is passed in rather than read
/// here so this crate owns no config-file format: the desktop app and the CLI
/// already parse `agent.toml` themselves.
/// `allow_network` opens the sandboxed shell's network namespace. It defaults to
/// off and is a field rather than a `new` parameter so existing callers keep the
/// safe default without being rewritten.
/// Not `Copy`: the output sink is an `Arc`. Cloning is cheap either way (every
/// other field is a borrow or a bool), so callers that relied on implicit copies
/// clone explicitly.
#[derive(Clone)]
pub struct ToolContext<'a> {
    /// Stops this call, and says whether it was a deadline or a person.
    ///
    /// `None` means "not cancellable", which is what the CLI and the tests
    /// use; the desktop dispatcher supplies a token scoped to the call so a
    /// stopped run does not leave a tool running behind it.
    pub cancel: Option<crate::lifecycle::Token>,
    pub project_root: &'a Path,
    pub store_root: &'a Path,
    pub enabled_skills: &'a [String],
    /// An attached project's store (`<folder>/.jan/agent`), read by the skill
    /// tools as a read-only layer in front of `store_root`: the project's own
    /// skills and its enabled plugins' skills, filtered by that project's
    /// `agent.toml`. `None` everywhere a project is not attached, and on the
    /// CLI, whose `store_root` already is the project store.
    pub skill_project: Option<&'a Path>,
    pub allow_network: bool,
    /// When set, `write`/`edit` re-canonicalize the target and refuse a path
    /// that escapes `project_root`, closing the check/use race between the
    /// gate's decision-time canonicalization and the handler's raw-path write.
    /// The CLI leaves it off so a user-approved escaping write still works.
    pub confine_writes: bool,
    /// The Jan data-folder root, masked from the sandboxed shell on surfaces
    /// where it sits outside the workspace (the desktop). `None` on the CLI,
    /// where the project itself is the workspace.
    pub mask_root: Option<&'a Path>,
    /// Expose `$HOME` to the sandboxed shell read-only (the CLI) instead of
    /// hiding it (the desktop). Passed through to the `bash` sandbox policy.
    pub home_readonly: bool,
    /// A session-scoped host directory the shell and the filesystem tools share
    /// for temporary work, so scratch files persist across `bash` calls in the
    /// run. See [`Policy::scratch_root`] for how each backend exposes it, and
    /// [`crate::workspace::scratch_dir`] for where it lives. `None` keeps the
    /// default throwaway per-command tmpfs. Cleaned up with the session (run end
    /// on the CLI, thread teardown on the desktop).
    pub scratch_root: Option<&'a Path>,
    /// Which conversation this call belongs to.
    ///
    /// Needed by anything that records something against the chat it came
    /// from -- `memory_propose` scopes and attributes by it. `None` on a
    /// surface with no conversation, such as a one-shot CLI run.
    pub session_id: Option<&'a str>,
    /// Which run this call belongs to, as the harness knows it (AH-008).
    ///
    /// Supplied by the loop, never by the model: it is the sender's identity
    /// where one run writes to another (AH-103), so a value a model could
    /// choose would be no identity at all.
    pub run_id: Option<&'a str>,
    /// The Jan data folder, where a run's mailbox is stored. `None` on a
    /// surface that keeps no durable state.
    pub data_folder: Option<&'a std::path::Path>,
    /// What this run may do, and who it is doing it as (AH-040).
    ///
    /// Carried so a skill that declares the tools it needs can be withheld
    /// where those tools are denied, instead of handing over instructions
    /// whose every step will be refused. It can only withhold: nothing here
    /// grants a tool.
    pub permissions: Option<&'a crate::permissions::ToolPermissions>,
    pub subject: Option<&'a crate::subject::Subject>,
    /// Whether a file this run edits is handed to the project's own formatter
    /// before its diff is shown (AH-149). Off unless the surface says
    /// otherwise: running a program the user did not ask for is a thing to opt
    /// into, and a formatter is still a program.
    pub format_on_edit: bool,
    /// Every tool this run could call, built-in and MCP alike (AH-124).
    ///
    /// Carried so a skill that declares a tool nothing here provides is
    /// withheld, rather than handing over instructions whose first step names
    /// something that does not exist. `None` means the surface did not say,
    /// and the check is skipped: an unrecognised name is not evidence of
    /// absence when nobody supplied the list.
    pub available_tools: Option<&'a [String]>,
    /// A temporary chat neither reads nor records memory.
    ///
    /// Carried rather than inferred from a missing session id: an unsaved chat
    /// and a deliberately temporary one are different things, and only the
    /// second should be denied its own memory.
    pub temporary: bool,
    /// Whether `bash` runs under OS confinement. On by default, and the desktop
    /// keeps it that way: there, `bash` is either sandboxed or withheld.
    ///
    /// The CLI turns it off (see its `--sandbox` flag and the `sandbox` config
    /// key), which runs the shell exactly as the user's own terminal would --
    /// no mounts, no policy, the user's real `$HOME` and `/tmp`. The permission
    /// gate is then the only thing between the model and the machine, which is
    /// why nothing else about the gate changes when this is off.
    pub sandbox: bool,
    /// Where a tool sends output as it is produced, when the caller wants to
    /// show it live. `None` means "collect and return only", which is what every
    /// non-interactive caller wants.
    ///
    /// `Arc` and not a borrow because `bash` hands its child to a detached task:
    /// the sink has to outlive the call that created it, which is also what makes
    /// a backgrounded command keep reporting after the tool has returned its
    /// `job_id`.
    pub on_output: Option<OutputSink>,
    /// Folders attached read-only: readable by the file tools and the shell,
    /// never writable. Empty on every surface that has not attached one.
    ///
    /// Owned paths rather than borrows because they are canonicalized once at
    /// attach time; re-canonicalizing per call would be both slower and a
    /// check/use race of its own.
    pub read_roots: &'a [PathBuf],
    /// Project roots this run may write to, beyond the workspace.
    ///
    /// The same list the gate was given. Held here so the handlers' own
    /// re-check asks the identical question: a gate that widened writes while
    /// the handler still measured against the workspace would refuse every
    /// authorized write, and the reverse would be worse.
    pub write_roots: &'a [PathBuf],
    /// Correlation id echoed on every streamed output chunk.
    ///
    /// Needed because `bash` with `timeout: 0` backgrounds and keeps streaming
    /// after the tool has returned: without an id the caller cannot route late
    /// chunks to the tool call that produced them. Minted by the caller (the
    /// frontend's tool-call id) rather than inside `bash`, so the sink can carry
    /// it from the first chunk.
    pub call_id: Option<&'a str>,
    /// The Jan data folder whose `mailbox/` the session-messaging tools use.
    ///
    /// Set only by the desktop dispatcher for a Cowork (session-scoped) call,
    /// together with `session_id`. `None` everywhere else -- chat threads, the
    /// CLI, subagent children -- and the mailbox tools refuse without it.
    pub mailbox_root: Option<&'a Path>,
    /// Who owns the background commands this call starts or touches: the
    /// conversation. `bash` job listing, status, collection and cancellation
    /// are confined to it, so a job id learned from one session is useless in
    /// another. Kept apart from `session_id`, which also decides what memory a
    /// call may read and write.
    pub job_owner: Option<&'a str>,
    /// Where a background job's durable record is written (AH-101/AH-102).
    ///
    /// The in-memory registry dies with the app, so a job that was running is
    /// a job nobody has any record of. `None` records nothing, which is what
    /// a surface with no data folder wants.
    pub job_record_to: Option<&'a Path>,
    /// The user's own skills, shared by every project (AH-121). `skill_list`
    /// and `skill_read` consult it after `store_root`, which shadows it. `None`
    /// where the store already is the user store (the desktop) or none exists.
    pub user_skills_root: Option<&'a Path>,
}

impl std::fmt::Debug for ToolContext<'_> {
    /// Hand-written because a sink is a closure: reported as present or absent,
    /// which is the only thing about it worth printing.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolContext")
            .field("project_root", &self.project_root)
            .field("store_root", &self.store_root)
            .field("enabled_skills", &self.enabled_skills)
            .field("skill_project", &self.skill_project)
            .field("allow_network", &self.allow_network)
            .field("confine_writes", &self.confine_writes)
            .field("mask_root", &self.mask_root)
            .field("home_readonly", &self.home_readonly)
            .field("scratch_root", &self.scratch_root)
            .field("sandbox", &self.sandbox)
            .field("on_output", &self.on_output.is_some())
            .field("read_roots", &self.read_roots)
            .field("write_roots", &self.write_roots)
            .field("call_id", &self.call_id)
            .field("mailbox_root", &self.mailbox_root)
            .field("job_owner", &self.job_owner)
            .field("job_record_to", &self.job_record_to)
            .field("user_skills_root", &self.user_skills_root)
            .finish()
    }
}

/// A tool's live-output channel: called with each chunk as it arrives, in order.
/// Chunks are raw fragments, not lines -- a caller that wants lines buffers them.
pub type OutputSink = std::sync::Arc<dyn Fn(String) + Send + Sync>;

impl<'a> ToolContext<'a> {
    pub fn new(project_root: &'a Path, store_root: &'a Path, enabled_skills: &'a [String]) -> Self {
        Self {
            // Not cancellable unless a caller supplies one; see the field.
            cancel: None,
            project_root,
            store_root,
            enabled_skills,
            skill_project: None,
            allow_network: false,
            confine_writes: false,
            mask_root: None,
            home_readonly: false,
            scratch_root: None,
            session_id: None,
            run_id: None,
            data_folder: None,
            permissions: None,
            subject: None,
            format_on_edit: false,
            available_tools: None,
            temporary: false,
            sandbox: true,
            on_output: None,
            read_roots: &[],
            write_roots: &[],
            call_id: None,
            mailbox_root: None,
            job_owner: None,
            job_record_to: None,
            user_skills_root: None,
        }
    }

    /// Give the session-messaging tools a mailbox. See [`Self::mailbox_root`].
    pub fn with_mailbox(mut self, data_folder: &'a Path) -> Self {
        self.mailbox_root = Some(data_folder);
        self
    }

    /// Offer the user's own skills beside the store's. See
    /// [`Self::user_skills_root`].
    pub fn with_user_skills(mut self, user_skills_root: Option<&'a Path>) -> Self {
        self.user_skills_root = user_skills_root;
        self
    }

    /// Confine the background commands this call starts or touches to
    /// Where a background job's durable record goes. See
    /// [`Self::job_record_to`].
    pub fn with_job_record_to(mut self, data_folder: &'a Path) -> Self {
        self.job_record_to = Some(data_folder);
        self
    }

    /// `owner`. See [`Self::job_owner`].
    /// Say what this run may do, so a skill can be checked against it.
    pub fn with_permissions(
        mut self,
        permissions: &'a crate::permissions::ToolPermissions,
        subject: &'a crate::subject::Subject,
    ) -> Self {
        self.permissions = Some(permissions);
        self.subject = Some(subject);
        self
    }

    /// Hand an edited file to the project's formatter before showing its diff
    /// (AH-149).
    pub fn with_format_on_edit(mut self, on: bool) -> Self {
        self.format_on_edit = on;
        self
    }

    /// Say which tools this run actually has, so a skill naming one nothing
    /// provides is withheld rather than loaded (AH-124).
    pub fn with_available_tools(mut self, tools: &'a [String]) -> Self {
        self.available_tools = Some(tools);
        self
    }

    /// Say which run is executing this call, and where its mail lives.
    pub fn with_run(mut self, run_id: &'a str, data_folder: &'a std::path::Path) -> Self {
        self.run_id = Some(run_id);
        self.data_folder = Some(data_folder);
        self
    }

    /// The run this call belongs to, for attributing what its command uses
    /// (AH-174), on a surface that keeps no mailbox. Never replaces a run id
    /// already set by [`Self::with_run`].
    pub fn with_measured_run(mut self, run_id: &'a str) -> Self {
        if self.run_id.is_none() {
            self.run_id = Some(run_id);
        }
        self
    }

    pub fn with_job_owner(mut self, owner: &'a str) -> Self {
        self.job_owner = Some(owner);
        self
    }

    /// Attach a cancellation token scoped to this call.
    pub fn with_cancel(mut self, token: crate::lifecycle::Token) -> Self {
        self.cancel = Some(token);
        self
    }

    /// Attach folders the tools may read but never write. Callers pass the
    /// canonical form from [`crate::workspace::validate_read_root`].
    /// Bind this context to a conversation, and say whether it is temporary.
    ///
    /// Both together, because both decide what may be remembered and a caller
    /// that set one and forgot the other would change that silently.
    pub fn in_session(mut self, session_id: Option<&'a str>, temporary: bool) -> Self {
        self.session_id = session_id;
        self.temporary = temporary;
        self
    }

    pub fn with_write_roots(mut self, write_roots: &'a [PathBuf]) -> Self {
        self.write_roots = write_roots;
        self
    }

    pub fn with_read_roots(mut self, read_roots: &'a [PathBuf]) -> Self {
        self.read_roots = read_roots;
        self
    }

    /// Layer an attached project's skills in front of the store's. See
    /// [`Self::skill_project`].
    pub fn with_skill_project(mut self, project_store: Option<&'a Path>) -> Self {
        self.skill_project = project_store;
        self
    }

    /// Tag streamed output with `call_id`. See [`Self::call_id`].
    pub fn with_call_id(mut self, call_id: &'a str) -> Self {
        self.call_id = Some(call_id);
        self
    }

    /// Stream this call's output to `sink` as it is produced, as well as
    /// returning it. See [`Self::on_output`].
    pub fn with_output_sink(mut self, sink: OutputSink) -> Self {
        self.on_output = Some(sink);
        self
    }

    pub fn with_network(mut self, allow: bool) -> Self {
        self.allow_network = allow;
        self
    }

    pub fn with_confined_writes(mut self, confine: bool) -> Self {
        self.confine_writes = confine;
        self
    }

    pub fn with_mask_root(mut self, mask_root: &'a Path) -> Self {
        self.mask_root = Some(mask_root);
        self
    }

    /// Expose `$HOME` to the sandboxed shell read-only. See [`Self::home_readonly`].
    pub fn with_home_readonly(mut self, home_readonly: bool) -> Self {
        self.home_readonly = home_readonly;
        self
    }

    /// Bind `scratch_root` over the sandbox's `/tmp` so scratch files survive
    /// across `bash` calls. See [`Self::scratch_root`].
    /// Ignored when the sandbox is off, so the two builders commute (see
    /// [`Self::with_sandbox`] for why an unconfined run has no scratch).
    pub fn with_scratch_root(mut self, scratch_root: &'a Path) -> Self {
        if self.sandbox {
            self.scratch_root = Some(scratch_root);
        }
        self
    }

    /// Run `bash` under OS confinement (the default). See [`Self::sandbox`].
    ///
    /// Turning it off also drops the scratch: the scratch only makes sense as
    /// the thing bound over the sandbox's `/tmp`. Unconfined, the shell sees the
    /// real `/tmp`, and leaving the scratch set would have the filesystem tools
    /// still rewriting `/tmp/...` into a directory the shell never looks at --
    /// two tools disagreeing about what one path means.
    pub fn with_sandbox(mut self, sandbox: bool) -> Self {
        self.sandbox = sandbox;
        if !sandbox {
            self.scratch_root = None;
        }
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capability {
    Read,
    Write,
    Exec,
    /// Network egress (native web tools). Distinct from `Read`/`Exec` so the
    /// gate can treat outbound web access as its own auto-allowed class rather
    /// than a filesystem or shell operation.
    Net,
}

#[derive(Debug, Clone, Copy)]
pub struct BuiltinTool {
    pub name: &'static str,
    pub capability: Capability,
    /// JSON argument keys that carry a filesystem path to sandbox-check.
    pub path_args: &'static [&'static str],
}

/// The 7 tools mirror pi's coding-agent set exactly (read/ls/find/grep/write/edit/bash).
pub const BUILTIN_TOOLS: &[BuiltinTool] = &[
    BuiltinTool {
        name: "read",
        capability: Capability::Read,
        path_args: &["path"],
    },
    BuiltinTool {
        name: "ls",
        capability: Capability::Read,
        path_args: &["path"],
    },
    BuiltinTool {
        name: "find",
        capability: Capability::Read,
        path_args: &["path"],
    },
    BuiltinTool {
        name: "grep",
        capability: Capability::Read,
        path_args: &["path"],
    },
    // Read: it renders a file that is already reachable and writes nothing back.
    BuiltinTool {
        name: "screenshot",
        capability: Capability::Read,
        path_args: &["path"],
    },
    BuiltinTool {
        name: "write",
        capability: Capability::Write,
        path_args: &["path"],
    },
    BuiltinTool {
        name: "edit",
        capability: Capability::Write,
        path_args: &["path"],
    },
    BuiltinTool {
        name: "bash",
        capability: Capability::Exec,
        path_args: &[],
    },
    // Dedicated skill/memory tools. They operate on `.jan/agent/{skills,memory}/`
    // by name (never a path), so they are always workspace-scoped and never
    // prompt. `path_args` is empty: there is no path to sandbox-check.
    // AH-103: one run saying something to another while both are still
    // running. `message_send` writes to a mailbox and `message_check` reads
    // this run's own; neither touches the filesystem, so `path_args` is empty
    // and there is nothing to sandbox-check.
    BuiltinTool {
        name: "message_send",
        capability: Capability::Write,
        path_args: &[],
    },
    BuiltinTool {
        name: "message_check",
        capability: Capability::Read,
        path_args: &[],
    },
    BuiltinTool {
        name: "memory_list",
        capability: Capability::Read,
        path_args: &[],
    },
    BuiltinTool {
        name: "memory_read",
        capability: Capability::Read,
        path_args: &[],
    },
    BuiltinTool {
        name: "memory_write",
        capability: Capability::Write,
        path_args: &[],
    },
    BuiltinTool {
        // A typed proposal, not prose the app parses out of a reply. The model
        // says "this is worth remembering" by calling something; whether it is
        // stored is decided by `memory::inferred`, which the model cannot
        // reach or influence.
        name: "memory_propose",
        capability: Capability::Write,
        path_args: &[],
    },
    BuiltinTool {
        name: "skill_list",
        capability: Capability::Read,
        path_args: &[],
    },
    BuiltinTool {
        name: "skill_read",
        capability: Capability::Read,
        path_args: &[],
    },
    BuiltinTool {
        name: "skill_write",
        capability: Capability::Write,
        path_args: &[],
    },
    // Native, provider-neutral web tools. They are compiled into the agent
    // core (NOT provided by an MCP server); Exa is only the default backend
    // behind an adapter. They take no filesystem path, so `path_args` is empty.
    BuiltinTool {
        name: "web_search",
        capability: Capability::Net,
        path_args: &[],
    },
    BuiltinTool {
        name: "web_fetch",
        capability: Capability::Net,
        path_args: &[],
    },
    // Read-only: inspects an already-attached local clone with native Git and
    // writes nothing. Scoped to the run's read roots inside the handler; it
    // takes a repository URL, not a filesystem path, so there is no `path_args`.
    BuiltinTool {
        name: "git_inspect",
        capability: Capability::Read,
        path_args: &[],
    },
    // Write: clones a GitHub repository into the workspace with host Git (git
    // cannot run in the bash sandbox). Gated and approved like `write`; the
    // destination is checked against the write roots here and in the handler.
    BuiltinTool {
        name: "git_clone",
        capability: Capability::Write,
        path_args: &["dest"],
    },
    // Cross-session messaging (docs/SESSION_MESSAGING.md). They touch only the
    // mailbox under the Jan data folder -- no project file, no network -- so
    // they are `Read` with no path arguments, and always allowed by the gate.
    // Advertised only to session-scoped calls and never to subagents.
    BuiltinTool {
        name: "list_sessions",
        capability: Capability::Read,
        path_args: &[],
    },
    BuiltinTool {
        name: "send_message",
        capability: Capability::Read,
        path_args: &[],
    },
    BuiltinTool {
        name: "read_messages",
        capability: Capability::Read,
        path_args: &[],
    },
    BuiltinTool {
        name: "wait_for_reply",
        capability: Capability::Read,
        path_args: &[],
    },
    // Acts on another session, so `Write`. The gate lets it through like the
    // other messaging tools (a deny rule still wins); what fences it is the
    // per-call user approval the handler requires, plus the same-project,
    // running-target and run-id rules in `session_mailbox/stop.rs`.
    BuiltinTool {
        name: "stop_session",
        capability: Capability::Write,
        path_args: &[],
    },
    // Asks the user for a folder. `path` is deliberately not a path argument:
    // the gate must not refuse the request for naming a path outside the
    // workspace, which is the whole point of it. The path is vetted by
    // `access::prepare` instead, and nothing is reachable until the user says
    // yes.
    BuiltinTool {
        name: "request_access",
        capability: Capability::Read,
        path_args: &[],
    },
    // Reads Flint's plugin state; touches no project file.
    BuiltinTool {
        name: "list_plugins",
        capability: Capability::Read,
        path_args: &[],
    },
];

/// Tools the desktop answers itself (a prompt, or a store only the app can
/// read). Auto-allowed by the gate like the workspace tools.
pub fn is_host_tool(name: &str) -> bool {
    matches!(name, "request_access" | "list_plugins")
}

/// The session-messaging tools. Auto-allowed by the gate (an agent.toml deny
/// still wins), offered only in session scope, and withheld from subagents.
pub fn is_mailbox_tool(name: &str) -> bool {
    crate::session_mailbox::TOOL_NAMES.contains(&name)
}

/// Whether a built-in may be advertised to a call in this scope. Only the
/// mailbox tools depend on it: a chat thread is not a messaging participant.
pub fn advertised_in_scope(name: &str, session_scope: bool) -> bool {
    session_scope || !is_mailbox_tool(name)
}

/// Tools that act only on the agent's own `.jan/agent/{skills,memory}/`
/// workspace. They are auto-allowed by the gate (no prompt), since a sanitized
/// name can never escape the workspace. `deny` in agent.toml still overrides.
pub fn is_workspace_tool(name: &str) -> bool {
    matches!(
        name,
        "memory_list"
            | "memory_read"
            | "memory_write"
            | "skill_list"
            | "skill_read"
            | "skill_write"
    )
}

pub fn lookup(name: &str) -> Option<&'static BuiltinTool> {
    BUILTIN_TOOLS.iter().find(|t| t.name == name)
}

pub fn is_builtin(name: &str) -> bool {
    lookup(name).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_read_is_read_capability() {
        let t = lookup("read").expect("read is builtin");
        assert_eq!(t.capability, Capability::Read);
        assert_eq!(t.path_args, &["path"]);
    }

    #[test]
    fn lookup_bash_is_exec_no_paths() {
        let t = lookup("bash").expect("bash is builtin");
        assert_eq!(t.capability, Capability::Exec);
        assert!(t.path_args.is_empty());
    }

    #[test]
    fn unknown_is_not_builtin() {
        assert!(lookup("nope").is_none());
        assert!(!is_builtin("nope"));
    }

    #[test]
    fn builtin_count_matches_expected() {
        // 8 coding tools + 7 dedicated skill/memory tools + 2 native web tools
        // + 2 run-to-run message tools (AH-103) + 5 session-messaging tools.
        // The seventh memory tool is `memory_propose`: the typed path by which
        // a model says a fact is worth remembering, so that Jan decides rather
        // than the app parsing an intention out of prose.
        // + request_access and list_plugins, which the desktop answers itself.
        // + git_inspect and git_clone, host Git the bash sandbox cannot run.
        assert_eq!(BUILTIN_TOOLS.len(), 28);
    }

    #[test]
    fn mailbox_tools_are_read_with_no_paths_and_session_only() {
        for name in crate::session_mailbox::TOOL_NAMES {
            let t = lookup(name).expect("mailbox tool is builtin");
            let expected = if *name == "stop_session" {
                Capability::Write
            } else {
                Capability::Read
            };
            assert_eq!(t.capability, expected, "{name}");
            assert!(t.path_args.is_empty());
            assert!(is_mailbox_tool(name));
            assert!(!is_workspace_tool(name));
            assert!(advertised_in_scope(name, true));
            assert!(!advertised_in_scope(name, false), "{name} offered to a thread");
        }
        assert!(advertised_in_scope("read", false));
        assert!(!is_mailbox_tool("read"));
    }

    #[test]
    fn web_tools_are_net_capability() {
        let s = lookup("web_search").expect("web_search is builtin");
        assert_eq!(s.capability, Capability::Net);
        assert!(s.path_args.is_empty());
        let f = lookup("web_fetch").expect("web_fetch is builtin");
        assert_eq!(f.capability, Capability::Net);
        assert!(f.path_args.is_empty());
    }

    #[test]
    fn workspace_tools_are_classified() {
        assert!(is_workspace_tool("memory_write"));
        assert!(is_workspace_tool("skill_list"));
        assert!(!is_workspace_tool("write"));
        assert!(!is_workspace_tool("bash"));
    }
}
