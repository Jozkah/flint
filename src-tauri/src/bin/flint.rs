//! jan — headless CLI for Flint.
//!
//! Shares the Tauri-free core logic with the Flint desktop app; talks only to
//! remote providers (no local inference, no GUI dependencies).
//! Build with: cargo build --no-default-features --features cli --bin jan

/// `println!` that treats a closed pipe (`flint ... | head`) as a normal end of
/// output instead of panicking. Shadows the std macro for this file.
macro_rules! println {
    () => { println!("") };
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let mut out = std::io::stdout().lock();
        if let Err(e) = writeln!(out, $($arg)*) {
            if e.kind() == std::io::ErrorKind::BrokenPipe {
                std::process::exit(0);
            }
            eprintln!("error: could not write to stdout: {e}");
            std::process::exit(1);
        }
    }};
}

#[path = "flint/agent_cmd.rs"]
mod agent_cmd;
#[path = "flint/inspect.rs"]
mod inspect;
#[path = "flint/run_cmd.rs"]
mod run_cmd;
use clap::{Args, CommandFactory, FromArgMatches, Parser, Subcommand};
use console::Style;

// Import the library crate so we can access core modules.
// The lib target is named "app_lib" (see [lib] section in Cargo.toml).
use app_lib::core::agent::plugins::InstalledPlugin;
use app_lib::core::cli::mcp::{self, split_kv, McpServerEntry};
use app_lib::core::cli::mcp_serve::{cli_mcp_serve, ServeFlags, ServeTransport};
use app_lib::core::cli::providers::{load_provider_configs, ProviderOverrides};
use app_lib::core::cli::run_report::OutputFormat;
use app_lib::core::cli::stream_input::InputFormat;
use app_lib::core::cli::{
    cli_agent_config_list, cli_agent_config_path, cli_agent_config_set, cli_agent_config_unset,
    cli_agent_run, cli_agent_status, cli_agent_step, cli_agent_ui,
    cli_get_thread, cli_list_messages, cli_list_threads, cli_plugin_install, cli_plugin_list,
    cli_plugin_remove, cli_plugin_search, cli_plugin_update, cli_review, ResumeRequest, SessionFlags,
};
use std::fmt::Write as _;

// ── Top-level CLI ──────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(
    name = "flint",
    about = "Chat with AI models in an interactive agent console",
    long_about = "Running `flint` with no arguments opens the interactive agent console (TUI),\n\
where you chat with a model that can run tools in your project.\n\n\
The `flint cli` subcommand is the non-interactive fallback: run folder-based\n\
agents headlessly and manage threads and providers.\n\n\
Models are served by remote providers configured in ~/.jan/config.toml\n\
(a legacy path kept for compatibility; see `flint config set`), a project's\n\
agent.toml, or the Flint desktop app.\n\n\
This is a local-only build: it makes no network calls of its own and sends no\n\
usage data.",
    after_help = "Examples:\n  \
  flint                                                  # open the interactive agent console (TUI)\n  \
  flint --safe                                           # TUI that asks before writes and commands\n  \
  flint --task \"fix the failing test\"                    # seed the TUI with a first message\n  \
  flint -c                                               # resume the most recent session\n  \
  flint --resume 3f7a91c2                                # resume a session by id (or id prefix)\n  \
  flint cli agent run \"fix the failing test\"             # run the agent non-interactively\n  \
  flint cli models list                                  # show every configured provider model\n  \
  flint cli threads list                                 # list saved conversation threads\n  \
  flint cli mcp list                                     # list configured MCP servers\n  \
  flint cli mcp add my-server --command npx --arg -y --arg my-mcp"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
    /// Project root containing .jan/agent/agent.toml (bare TUI only)
    #[arg(long, default_value = ".")]
    project: String,
    /// Optional first message to seed the chat with (bare TUI only)
    #[arg(long)]
    task: Option<String>,
    /// Model ID overriding [agent].model in agent.toml (bare TUI only)
    #[arg(long)]
    model: Option<String>,
    /// Image file to attach to the first message, repeatable (bare TUI only)
    #[arg(long = "image")]
    images: Vec<String>,
    #[command(flatten)]
    providers: ProviderArgs,
    /// Prompt for approval before writes, shell commands, and MCP tool calls in
    /// the default agent TUI. Ignored when a subcommand is given.
    #[arg(long)]
    safe: bool,
    /// How freely the session acts: review (read-only), ask, auto or bypass.
    /// Replaces --safe and --plan.
    #[arg(long, value_name = "MODE")]
    mode: Option<String>,
    #[command(flatten)]
    resume: ResumeArgs,
    /// Start the default agent TUI in read-only plan mode (same as /plan).
    /// Ignored when a subcommand is given.
    #[arg(long)]
    plan: bool,
    #[command(flatten)]
    sandbox: SandboxArgs,
    #[command(flatten)]
    worktree: WorktreeArgs,
    /// Log more: `info` on stderr instead of `warn`. Accepted before or after
    /// any subcommand. The logger reads it from the raw arguments before this
    /// parser runs; declaring it here keeps clap from rejecting it.
    #[arg(long, short = 'v', global = true)]
    verbose: bool,
    /// Start with hooks, skills, plugins, MCP servers and project instruction
    /// files off, to rule a customization out (also `FLINT_SAFE_MODE=1`).
    #[arg(long = "safe-mode", global = true)]
    safe_mode: bool,
}

/// Whether this invocation confines the shell, shared by every surface that
/// starts an agent.
///
/// Two flags rather than one because the setting is also persistent
/// (`sandbox` in `~/.jan/config.toml`, `[tools].sandbox` in agent.toml): with
/// only `--sandbox` there would be no way to run unconfined once, and a user who
/// turned it on permanently would have to edit a file to get out of it.
/// Per-invocation cost limits for `flint cli agent run`. Both mirror the
/// engine's own semantics: `0` means unbounded, and an unpassed flag leaves the
/// config files (or, for turns, nothing at all) in charge.
#[derive(Args, Clone, Copy)]
struct BudgetArgs {
    /// Fail the run after at most N agentic turns; bounds this run only, not
    /// its subagents (0 = unbounded, the default)
    #[arg(long, value_name = "N")]
    max_turns: Option<u64>,
    /// Token-spend ceiling for this run, overriding [budget].max_tokens
    /// (0 = no ceiling)
    #[arg(long, value_name = "N")]
    max_session_tokens: Option<u64>,
    /// Stop the run once it has spent this much in USD, overriding
    /// [budget].max_usd. Priced from prices.toml, so a model with no declared
    /// price is refused rather than run uncapped
    #[arg(long, value_name = "USD")]
    max_budget_usd: Option<f64>,
}

#[derive(Args, Clone, Copy)]
struct SandboxArgs {
    /// Run shell commands under OS confinement (bubblewrap, Seatbelt, AppContainer)
    #[arg(long)]
    sandbox: bool,
    /// Run shell commands unconfined, overriding a persistent sandbox setting
    #[arg(long, conflicts_with = "sandbox")]
    no_sandbox: bool,
}

impl SandboxArgs {
    /// `None` when neither flag was passed, so the config files decide.
    fn into_flag(self) -> Option<bool> {
        match (self.sandbox, self.no_sandbox) {
            (true, _) => Some(true),
            (_, true) => Some(false),
            _ => None,
        }
    }
}

/// Whether this run works in its own git worktree. `None` from neither flag
/// defers to `[agent].worktree`, then the global `worktree`, then off.
#[derive(Args, Clone, Copy)]
struct WorktreeArgs {
    /// Work in a dedicated git worktree instead of the project directory
    #[arg(long)]
    worktree: bool,
    /// Work in the project directory, overriding a persistent worktree setting
    #[arg(long, conflicts_with = "worktree")]
    no_worktree: bool,
}

impl WorktreeArgs {
    fn into_flag(self) -> Option<bool> {
        match (self.worktree, self.no_worktree) {
            (true, _) => Some(true),
            (_, true) => Some(false),
            _ => None,
        }
    }
}

/// Session-resume selection, shared by the bare TUI and `flint cli agent run`.
/// Threads are per-project (`<project>/.jan/agent/threads`), so resuming from a
/// different working directory simply finds nothing there.
#[derive(Args)]
struct ResumeArgs {
    /// Resume a saved session: the most recent one, or the thread whose id starts with ID
    #[arg(long, num_args = 0..=1, value_name = "ID")]
    resume: Option<Option<String>>,
    /// Resume the most recent session (alias for a bare --resume)
    #[arg(long = "continue", short = 'c', conflicts_with = "resume")]
    continue_session: bool,
    /// Branch the resumed session into a new one rather than continuing it in
    /// place; alone, forks the most recent session
    #[arg(long = "fork-session")]
    fork_session: bool,
}

impl ResumeArgs {
    fn into_request(self) -> Option<ResumeRequest> {
        ResumeRequest::from_flags(self.resume, self.continue_session, self.fork_session)
    }
}

/// Same flags for `flint cli agent run`, which has a required positional TASK: a
/// space-separated `--resume ID` would swallow the task, so the value form must
/// be written `--resume=ID`.
#[derive(Args)]
struct ResumeRunArgs {
    /// Resume a saved session: the most recent one, or (as --resume=ID) the thread whose id starts with ID
    #[arg(long, num_args = 0..=1, require_equals = true, value_name = "ID")]
    resume: Option<Option<String>>,
    /// Resume the most recent session (alias for a bare --resume)
    #[arg(long = "continue", short = 'c', conflicts_with = "resume")]
    continue_session: bool,
    /// When the resumed session's last run was cut off mid-turn: keep its
    /// unfinished reply (continue) or drop it (discard-partial). Required for
    /// such a session; completed tool calls are kept either way (AH-026)
    #[arg(long, value_enum, value_name = "CHOICE")]
    interrupted: Option<app_lib::core::cli::inflight::InterruptedChoice>,
    /// Branch the resumed session into a new one rather than continuing it in
    /// place; alone, forks the most recent session
    #[arg(long = "fork-session")]
    fork_session: bool,
}

impl ResumeRunArgs {
    fn into_request(self) -> Option<ResumeRequest> {
        ResumeRequest::from_flags(self.resume, self.continue_session, self.fork_session)
    }
}

/// Top-level commands. Bare `jan` opens the interactive TUI; everything else
/// lives under the non-interactive `cli` fallback.
#[derive(Subcommand)]
enum Commands {
    /// Bring data over from a JAN install: detect, plan, run, status, rollback
    Migrate {
        #[command(subcommand)]
        cmd: MigrateCommands,
    },
    /// Run the production browser server without a desktop session
    Serve {
        /// Loopback address; use a private-network HTTPS proxy for remote access
        #[arg(long, visible_alias = "bind", default_value = "127.0.0.1:1340")]
        listen: std::net::SocketAddr,
        /// Directory containing the production web bundle
        #[arg(long)]
        assets_dir: Option<std::path::PathBuf>,
        /// Shared Flint data directory
        #[arg(long)]
        data_dir: Option<std::path::PathBuf>,
        /// Exact DNS name used by the private-network HTTPS proxy
        #[arg(long)]
        public_host: Option<String>,
        /// Let browser sessions add and start stdio MCP servers (runs programs
        /// on this machine); http and sse servers are always allowed
        #[arg(long)]
        allow_mcp_stdio: bool,
        /// A folder the agent review plane may use: a signed-in client can then
        /// list campaigns and review, apply or reject proposals for projects
        /// under it. Repeatable. Off when none is given. It never runs a
        /// session, a build or a test, and may not contain the data folder
        #[arg(long = "agent-root")]
        agent_roots: Vec<std::path::PathBuf>,
        /// Let signed-in clients run agent sessions on this server (phase P1
        /// of the server runner; today it only turns the capability probe and
        /// the session views on). Needs --agent-root and a command sandbox
        #[arg(long = "agent-run")]
        agent_run: bool,
        /// Most agent sessions the runner keeps live at once
        #[arg(long = "agent-max-sessions", default_value_t = 4)]
        agent_max_sessions: u32,
        /// Let a session run unattended (modes auto and bypass: writes and
        /// shell commands without a prompt). Off: every session reads only or
        /// asks first
        #[arg(long = "agent-allow-bypass")]
        agent_allow_bypass: bool,
        /// Let a client grant a standing approval ("allow always"). Off: an
        /// approval covers one call
        #[arg(long = "agent-allow-always")]
        agent_allow_always: bool,
        /// Seconds an unanswered approval waits before it is denied
        #[arg(long = "agent-approval-timeout", default_value_t = 1800)]
        agent_approval_timeout: u64,
        /// Allow this server to run a project's own commands for a session
        /// (verification checks, a build or test gate). Off by default and
        /// reported to clients as `runsChecks`; worktree commit, merge and
        /// discard are plain git and do not need it
        #[arg(long = "agent-allow-checks")]
        agent_allow_checks: bool,
        /// Refuse to run sessions when commands cannot be sandboxed. Pass
        /// `--agent-require-sandbox=false` to run them unsandboxed anyway
        #[arg(long = "agent-require-sandbox", default_value_t = true, action = clap::ArgAction::Set)]
        agent_require_sandbox: bool,
        /// Exact host[:port] clients use to reach this server; repeatable.
        /// Required when --listen/--bind is beyond loopback
        #[arg(long = "allowed-host")]
        allowed_hosts: Vec<String>,
        /// Exact origin (http(s)://host[:port]) allowed to call the API
        /// cross-origin with a bearer token, such as a native app shell;
        /// repeatable, never a wildcard
        #[arg(long = "allowed-origin")]
        allowed_origins: Vec<String>,
        /// The flint-llama-worker binary that runs local models (defaults to
        /// FLINT_LLAMA_WORKER_BIN, then the file beside this executable)
        #[arg(long)]
        llama_worker: Option<std::path::PathBuf>,
        /// Run in the background, detached from this terminal, logging to
        /// <data folder>/web-server/server.log; stop it with `flint stop`
        #[arg(long, visible_alias = "detach")]
        background: bool,
        /// Where the background starter collects the first-run credential
        #[arg(long, hide = true)]
        credential_file: Option<std::path::PathBuf>,
        /// A reverse proxy on this machine (Tailscale Serve, Caddy) fronts the
        /// server: believe its X-Forwarded-For on loopback connections when
        /// rate-limiting sign-in. Off by default
        #[arg(long)]
        trust_proxy: bool,
        /// Replace the administrator credential (ending every browser
        /// session), print the new one and exit. Only while the server is
        /// stopped
        #[arg(long)]
        rotate_credential: bool,
    },
    /// Stop the `flint serve` running on this data folder
    Stop {
        /// Shared Flint data directory the server was started with
        #[arg(long)]
        data_dir: Option<std::path::PathBuf>,
    },
    /// Non-interactive CLI: launch agents, run headless agent tasks, manage models and threads
    #[command(display_order = 1)]
    Cli {
        #[command(subcommand)]
        cmd: CliCommands,
    },
    /// Start an installed coding CLI (claude, codex, aider) pointed at the local Flint API server
    #[command(display_order = 3)]
    Launch {
        /// The tool to start: claude, codex or aider
        tool: String,
        /// The model the tool should ask the server for
        #[arg(long)]
        model: Option<String>,
        /// The server to use (default: the address saved in Flint's settings, else http://127.0.0.1:1337/v1)
        #[arg(long)]
        base_url: Option<String>,
        /// The server's API key (default: $FLINT_API_KEY, else none)
        #[arg(long)]
        api_key: Option<String>,
        /// Print the command and environment that would run, and run nothing
        #[arg(long)]
        dry_run: bool,
        /// With --dry-run, print JSON
        #[arg(long)]
        json: bool,
        /// Arguments passed to the tool, after `--`
        #[arg(last = true)]
        args: Vec<String>,
    },
    /// Sign in to Tokamak and save the API key to ~/.jan/config.toml
    #[command(display_order = 2)]
    Login {
        /// Skip the browser approval and paste an API key instead (the legacy flow)
        #[arg(long)]
        paste_token: bool,
    },
    /// Show or manage the Tokamak sign-in
    #[command(display_order = 3)]
    Auth {
        #[command(subcommand)]
        cmd: AuthCommands,
    },
    /// Read recorded usage and spend from the Tokamak usage API
    #[command(display_order = 4)]
    Usage {
        // Optional so bare `flint usage` answers "what have I spent" with the
        // account summary.
        #[command(subcommand)]
        cmd: Option<UsageCommands>,
        /// Print the provider's response body verbatim instead of a table.
        /// Reshaping it would mean re-serializing money fields, which is how a
        /// figure loses digits, so this forwards the bytes as received.
        #[arg(long, global = true)]
        json: bool,
    },
    /// Manage provider credentials in ~/.jan/config.toml (used by the TUI and CLI)
    #[command(display_order = 4)]
    Config {
        #[command(subcommand)]
        cmd: AgentConfigCommands,
    },
    /// Review the current diff: ranked findings, each checked by a second pass
    Review {
        #[arg(long, default_value = ".")]
        project: String,
        /// Compare against this branch or commit instead of HEAD
        #[arg(long)]
        base: Option<String>,
        /// Also review as the security reviewer
        #[arg(long)]
        security: bool,
        #[arg(long)]
        model: Option<String>,
        /// Hand the findings to an agent run that fixes them (normal approvals)
        #[arg(long)]
        fix: bool,
        /// Print the findings as JSON
        #[arg(long)]
        json: bool,
    },
    /// Manage project-local plugins and their skills
    #[command(display_order = 5)]
    Plugin {
        #[command(subcommand)]
        cmd: PluginCommands,
    },
    /// Preview, then save, a redacted local diagnostic bundle (never uploaded)
    #[command(display_order = 6)]
    BugReport {
        /// Bundle this thread id (default: the most recently updated thread)
        #[arg(long)]
        thread: Option<String>,
        /// Print one member's redacted content (e.g. `logs/jan.log`) and exit
        /// without writing anything
        #[arg(long, value_name = "MEMBER")]
        show: Option<String>,
        /// Save without asking (required when stdin is not a terminal)
        #[arg(long)]
        yes: bool,
        /// Directory for the archive (default: <data folder>/diagnostics)
        #[arg(long, value_name = "DIR")]
        out: Option<std::path::PathBuf>,
    },
    /// Show system hardware info (CPU, memory, GPUs) and check readiness
    #[command(display_order = 7)]
    Doctor {
        /// Print as JSON instead of a human-readable table
        #[arg(long)]
        json: bool,
    },
    /// Serve Flint's built-in tools to another agent over MCP
    #[command(display_order = 8)]
    Mcp {
        #[command(subcommand)]
        cmd: McpServeCommands,
    },
}

/// The server direction of MCP: Flint offered as a tool provider. The client
/// direction (managing the servers Flint *connects to*) stays under
/// `flint cli mcp`.
#[derive(Subcommand)]
enum McpServeCommands {
    /// Run an MCP server exposing Flint's built-in tools for one project
    Serve {
        /// Project root the served tools are confined to
        #[arg(long, default_value = ".")]
        project: String,
        /// Transport: stdio for a spawned child process, http for loopback Streamable HTTP
        #[arg(long, value_enum, default_value_t = ServeTransport::Stdio)]
        transport: ServeTransport,
        /// Also serve the mutating filesystem tools (write, edit), confined to the project root
        #[arg(long)]
        allow_write: bool,
        /// Also serve bash (runs under the same OS sandbox the agent's shell does)
        #[arg(long)]
        allow_exec: bool,
        /// Serve only these tools, repeatable; never widens what the allow flags permit
        #[arg(long = "tool")]
        tools: Vec<String>,
        /// Port for --transport http; 0 picks a free one
        #[arg(long, default_value_t = 0)]
        port: u16,
        /// Bearer token for --transport http; a random one is generated and printed if omitted
        /// (visible in the process list: prefer --token-file)
        #[arg(long)]
        token: Option<String>,
        /// Read the bearer token from a file (`-` for stdin) instead of the command line
        #[arg(long, value_name = "PATH", conflicts_with = "token")]
        token_file: Option<std::path::PathBuf>,
    },
}

/// Reads against the Tokamak usage API (upstream #9034). Every view reports
/// figures the provider recorded, never a local estimate.
#[derive(Subcommand)]
enum UsageCommands {
    /// Usage across this account's credentials, not only the key in use
    Account,
    /// Daily usage totals
    Daily,
    /// Recently recorded requests
    Requests,
    /// Current usage-limit status (separate from wallet credit)
    Limits,
    /// Inspect one execution by its X-Tokamak-Execution-Id
    Generation {
        /// The execution id, from the response header of an inference request
        id: String,
    },
    /// Find every execution tagged with an X-Client-Request-Id
    Correlate {
        /// The correlation id sent on the original request
        client_request_id: String,
    },
}

/// Tokamak sign-in inspection and control.
#[derive(Subcommand)]
enum AuthCommands {
    /// Show the current sign-in: account, endpoint, key id and expiry, plus a
    /// live validity check against the upstream
    Status,
    /// Sign out: revoke the stored key server-side and clear the local entry.
    Logout,
}

#[derive(Subcommand)]
enum PluginCommands {
    /// List plugins installed in a project
    List {
        #[arg(long, default_value = ".")]
        project: String,
        /// Print complete plugin metadata as JSON
        #[arg(long)]
        json: bool,
    },
    /// Install a git URL or marketplace plugin
    Install {
        spec: String,
        #[arg(long, default_value = ".")]
        project: String,
    },
    /// Remove an installed plugin by name
    Remove {
        name: String,
        #[arg(long, default_value = ".")]
        project: String,
    },
    /// Update a git or marketplace plugin if its source has a newer commit
    Update {
        name: String,
        #[arg(long, default_value = ".")]
        project: String,
    },
    /// Search the configured plugin marketplace
    Search {
        query: Option<String>,
        #[arg(long, default_value = ".")]
        project: String,
    },
}

/// The non-interactive command surface, reached via `flint cli <command>`.
#[derive(Subcommand)]
enum CliCommands {
    /// Background work that outlives this process (AH-101/AH-102)
    #[command(display_order = 9)]
    Job {
        #[command(subcommand)]
        cmd: JobCommands,
    },
    /// List and inspect conversation threads saved by the Flint app
    #[command(display_order = 10)]
    Threads {
        #[command(subcommand)]
        cmd: ThreadsCommands,
    },
    /// List the models exposed by the configured providers
    #[command(display_order = 11)]
    Models {
        #[command(subcommand)]
        cmd: ModelsCommands,
    },
    /// Run folder-based agents against a configured provider's models
    #[command(display_order = 12)]
    Agent {
        #[command(subcommand)]
        cmd: AgentCommands,
    },
    /// List and manage MCP servers in mcp_config.json
    #[command(display_order = 13)]
    Mcp {
        #[command(subcommand)]
        cmd: McpCommands,
    },
    /// Outbound network settings: extra certificate authorities (AH-190)
    #[command(display_order = 14)]
    Net {
        #[command(subcommand)]
        cmd: NetCommands,
    },
    /// Measure the agent harness against a fixed task set (AH-196)
    #[command(display_order = 15)]
    Bench {
        #[command(subcommand)]
        cmd: BenchCommands,
    },
    /// Scheduled tasks: prompts that run on a timetable with nobody watching
    #[command(display_order = 16)]
    Schedule {
        #[command(subcommand)]
        cmd: ScheduleCommands,
    },
    /// Automations: typed, validated runs with a trigger, tool profile, budget and folders
    #[command(display_order = 16)]
    Automation {
        #[command(subcommand)]
        cmd: AutomationCommands,
    },
    /// Where Flint keeps its data; `--set` moves it (copying what is there)
    #[command(display_order = 20)]
    DataFolder {
        /// Point Flint at this absolute folder
        #[arg(long)]
        set: Option<String>,
        /// With `--set`, do not copy the current folder's contents across
        #[arg(long)]
        no_copy: bool,
    },
    /// Trust a folder to run its own hooks and agent definitions, for good
    #[command(display_order = 21)]
    Trust {
        /// The folder to trust (default: the current one)
        folder: Option<std::path::PathBuf>,
        /// Stop trusting it instead
        #[arg(long)]
        revoke: bool,
        /// List the trusted folders and exit
        #[arg(long)]
        list: bool,
    },
    /// Bring Claude Code skills and plugins in from ~/.claude
    #[command(display_order = 22)]
    ImportClaude {
        #[command(subcommand)]
        cmd: ImportClaudeCommands,
    },
    /// What Flint remembers: list, read, pin, forget and export by scope
    #[command(display_order = 21)]
    Memory {
        #[command(subcommand)]
        cmd: MemoryCommands,
    },
    /// Worktrees made by `--worktree` sessions: list, merge, discard
    #[command(display_order = 19)]
    Worktree {
        #[command(subcommand)]
        cmd: WorktreeCommands,
    },
    /// Project skills: list, read, write, delete, enable, import from the hub
    #[command(display_order = 18)]
    Skills {
        #[command(subcommand)]
        cmd: SkillsCommands,
    },
    /// What delete moved aside: list, restore or purge it
    #[command(display_order = 17)]
    Archive {
        #[command(subcommand)]
        cmd: ArchiveCommands,
    },
    /// Speak the Agent Client Protocol on stdin/stdout, so an editor can run
    /// Flint as its agent
    #[command(display_order = 18)]
    Acp,
    /// Permission prompts put off to answer later, and the scoped rules
    /// saved with "allow always"
    #[command(display_order = 23)]
    Approvals {
        #[command(subcommand)]
        cmd: ApprovalsCommands,
    },
}

#[derive(Subcommand)]
enum AutomationCommands {
    /// List the saved automations
    List {
        #[arg(long)]
        json: bool,
    },
    /// Print one automation's definition
    Show { id: String },
    /// Check a definition file and list every problem, without saving it
    Validate {
        #[arg(long)]
        file: std::path::PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Validate a definition file and save it (replacing an automation with the same id)
    Add {
        #[arg(long)]
        file: std::path::PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Start a run now, detached; `--wait` stays until it ends
    Run {
        /// The automation id (see `list`)
        id: String,
        /// Work in this one of the automation's folders (default: the first)
        #[arg(long)]
        folder: Option<String>,
        #[arg(long)]
        wait: bool,
    },
    /// Delete an automation, its schedule entry and its run history
    Remove {
        id: String,
        /// Confirm: the run history goes with it
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Subcommand)]
enum ScheduleCommands {
    /// List the scheduled tasks and when each runs next
    List {
        #[arg(long)]
        json: bool,
    },
    /// Start a task's run now, detached; `--wait` stays until it ends
    Run {
        /// The task id (see `list`)
        id: String,
        #[arg(long)]
        wait: bool,
    },
    /// Start whatever is due, once, then exit. For an OS scheduler entry that
    /// runs while the app is closed; safe alongside the app's own ticking.
    Tick {
        /// The Flint data folder to work on (an OS scheduler carries no
        /// environment, so the installed entry passes it)
        #[arg(long)]
        data: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// A task's run history, newest first
    Runs {
        /// The task id (see `list`)
        id: String,
        #[arg(long, default_value_t = 10)]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
    /// Add a scheduled task
    Add {
        #[command(flatten)]
        task: ScheduleTaskArgs,
        #[arg(long)]
        json: bool,
    },
    /// Change a scheduled task; only the flags you give are changed
    Edit {
        /// The task id (see `list`)
        id: String,
        #[command(flatten)]
        task: ScheduleTaskArgs,
        #[arg(long)]
        json: bool,
    },
    /// Delete a task and its run history
    Delete {
        id: String,
        /// Confirm: the run history goes with it
        #[arg(long)]
        yes: bool,
    },
    /// Turn a task on
    Enable {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Turn a task off without deleting it
    Disable {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Show the next fire times of a task, or of a schedule not yet saved
    Preview {
        /// A task id; omit it to preview the schedule flags instead
        id: Option<String>,
        #[command(flatten)]
        task: ScheduleTaskArgs,
        #[arg(long, default_value_t = 5)]
        count: usize,
        #[arg(long)]
        json: bool,
    },
    /// Stop a run that is in flight
    Cancel { id: String, run: String },
    /// The built-in tools a task can be allowed
    Tools {
        #[arg(long)]
        json: bool,
    },
    /// The time zone names a task can use
    TimeZones,
    /// The entry that runs `schedule tick` while Flint is closed
    Os {
        /// status, enable or disable
        action: String,
        #[arg(long)]
        interval_minutes: Option<u32>,
        /// Confirm that `enable` may write the entry it previewed
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        json: bool,
    },
    /// Run one scheduled run from its spec, as a job supervisor starts it. Not
    /// meant to be run by hand.
    #[command(hide = true)]
    RunSpec {
        #[arg(long)]
        spec: String,
    },
}

/// What a scheduled task is. `add` needs name, prompt, model, a schedule and at
/// least one `--allow-tool`; `edit` changes only what is given.
#[derive(Args, Default)]
struct ScheduleTaskArgs {
    #[arg(long)]
    name: Option<String>,
    /// What the task should do each time it runs
    #[arg(long)]
    prompt: Option<String>,
    /// `provider/model`
    #[arg(long)]
    model: Option<String>,
    /// The project folder the run works in (default: the current folder)
    #[arg(long)]
    project: Option<String>,
    /// IANA zone name, e.g. Europe/Berlin (default: $TZ, else UTC)
    #[arg(long)]
    timezone: Option<String>,
    /// A Cowork profile to run under
    #[arg(long)]
    profile: Option<String>,
    /// Every day at these times, e.g. 09:00,17:30
    #[arg(long)]
    daily: Option<String>,
    /// Monday to Friday at these times
    #[arg(long)]
    weekdays: Option<String>,
    /// On these days at these times, e.g. mon,wed@09:00
    #[arg(long)]
    weekly: Option<String>,
    /// A cron expression
    #[arg(long)]
    cron: Option<String>,
    /// A tool the task may use (repeat; see `schedule tools`)
    #[arg(long = "allow-tool")]
    allow_tools: Vec<String>,
    /// read-only or worktree
    #[arg(long)]
    write: Option<String>,
    /// continue or end, when a tool call would need approval
    #[arg(long)]
    on_block: Option<String>,
    /// skip, once or all-capped, for runs missed while closed
    #[arg(long)]
    catch_up: Option<String>,
    #[arg(long)]
    max_turns: Option<u32>,
    #[arg(long)]
    max_tokens: Option<u64>,
    #[arg(long)]
    max_wall_clock_secs: Option<u64>,
    #[arg(long)]
    max_cost_usd: Option<f64>,
    /// Save the task turned off
    #[arg(long)]
    disabled: bool,
}

impl ScheduleTaskArgs {
    fn into_input(self) -> Result<app_lib::core::cli::schedule_manage::TaskInput, HarnessError> {
        use app_lib::core::schedule::spec::{CatchUp, OnBlock, WriteMode};
        use tauri_plugin_agent_tools::harness_error::{ErrorKind, Stage};
        let bad = |flag: &str, v: &str, ok: &str| {
            HarnessError::new(ErrorKind::InvalidInput, format!("--{flag} '{v}' is not one of: {ok}")).at(Stage::Startup)
        };
        let write = match self.write.as_deref() {
            None => None,
            Some("read-only") => Some(WriteMode::ReadOnly),
            Some("worktree") => Some(WriteMode::Worktree),
            Some(v) => return Err(bad("write", v, "read-only, worktree")),
        };
        let on_block = match self.on_block.as_deref() {
            None => None,
            Some("continue") => Some(OnBlock::Continue),
            Some("end") => Some(OnBlock::End),
            Some(v) => return Err(bad("on-block", v, "continue, end")),
        };
        let catch_up = match self.catch_up.as_deref() {
            None => None,
            Some("skip") => Some(CatchUp::Skip),
            Some("once") => Some(CatchUp::Once),
            Some("all-capped") => Some(CatchUp::AllCapped),
            Some(v) => return Err(bad("catch-up", v, "skip, once, all-capped")),
        };
        Ok(app_lib::core::cli::schedule_manage::TaskInput {
            name: self.name,
            prompt: self.prompt,
            model: self.model,
            project: self.project,
            timezone: self.timezone,
            profile: self.profile,
            daily: self.daily,
            weekdays: self.weekdays,
            weekly: self.weekly,
            cron: self.cron,
            allow_tools: self.allow_tools,
            write,
            on_block,
            catch_up,
            max_turns: self.max_turns,
            max_tokens: self.max_tokens,
            max_wall_clock_secs: self.max_wall_clock_secs,
            max_cost_usd: self.max_cost_usd,
            disabled: self.disabled,
        })
    }
}

#[derive(Subcommand)]
enum BenchCommands {
    /// Run every task in a task set through the real headless agent and write
    /// a report
    Run {
        /// The task set (TOML)
        #[arg(long)]
        tasks: String,
        /// Model ID to run the tasks with
        #[arg(long)]
        model: String,
        /// Where to write the JSON report
        #[arg(long)]
        out: String,
        /// What is being measured: a commit, a branch, a setting
        #[arg(long, default_value = "")]
        label: String,
    },
    /// Compare two reports of the same task set; exits non-zero when a task that
    /// passed before fails now
    Compare {
        /// The earlier report
        before: String,
        /// The later report
        after: String,
    },
}

#[derive(Subcommand)]
enum NetCommands {
    /// Extra certificate authorities trusted for outbound HTTPS
    Ca {
        #[command(subcommand)]
        cmd: CaCommands,
    },
    /// How a provider host resolves and which address is dialled first
    Endpoint {
        host: String,
        #[arg(default_value_t = 443)]
        port: u16,
    },
}

#[derive(Subcommand)]
enum CaCommands {
    /// Show which CA bundle is in force, where it was named, and what it holds
    Status,
    /// Trust the certificates in a PEM bundle, in addition to the platform's.
    /// The bundle is checked first; one that cannot be used is refused
    Set {
        /// Path to a PEM file of CA certificates
        path: String,
    },
    /// Check a bundle without saving it: what it holds and whether it can be used
    Check {
        /// Path to a PEM file of CA certificates
        path: String,
    },
    /// Stop trusting the configured bundle (JAN_CA_BUNDLE, if set, still applies)
    Clear,
}

// ── Agent subcommands ──────────────────────────────────────────────────────

/// Cloud/local credential source shared by `agent run/step/status`. Overrides
/// the persisted desktop provider store; env vars fill any remaining gaps.
#[derive(Args)]
struct ProviderArgs {
    /// Target a single provider (e.g. anthropic); required to synthesize creds from flags alone
    #[arg(long)]
    provider: Option<String>,
    /// API key for the target provider (else JAN_API_KEY / <PROVIDER>_API_KEY).
    /// `-` reads the key from stdin
    #[arg(long)]
    api_key: Option<String>,
    /// Read the API key from a file instead of the command line (trailing whitespace is dropped)
    #[arg(long, value_name = "PATH", conflicts_with = "api_key")]
    api_key_file: Option<std::path::PathBuf>,
}

/// The key stored in `path`, trimmed. An empty file is an error rather than an
/// empty key.
fn read_api_key_file(path: &std::path::Path) -> Result<String, String> {
    read_secret_file(path, "--api-key-file")
}

/// A secret read from `path` (`-` is stdin), trimmed; empty is an error.
fn read_secret_file(path: &std::path::Path, flag: &str) -> Result<String, String> {
    let raw = if path.as_os_str() == "-" {
        read_stdin_secret().map_err(|e| format!("{flag} -: {e}"))?
    } else {
        std::fs::read_to_string(path).map_err(|e| format!("{flag} {}: {e}", path.display()))?
    };
    let key = raw.trim();
    if key.is_empty() {
        return Err(format!("{flag} {} is empty", path.display()));
    }
    Ok(key.to_string())
}

fn read_stdin_secret() -> std::io::Result<String> {
    use std::io::Read;
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text)?;
    Ok(text)
}

/// The API key the flags name: inline (warned about), `-` for stdin, or a file.
/// `stdin` is injected so the `-` form can be tested.
fn resolve_api_key(
    inline: Option<String>,
    file: Option<&std::path::Path>,
    stdin: impl FnOnce() -> std::io::Result<String>,
) -> Result<Option<String>, String> {
    match (inline, file) {
        (Some(key), _) if key == "-" => {
            let key = stdin().map_err(|e| format!("--api-key -: {e}"))?.trim().to_string();
            if key.is_empty() {
                return Err("--api-key - read nothing from stdin".to_string());
            }
            Ok(Some(key))
        }
        (Some(key), _) => {
            eprintln!("warning: --api-key is visible in the process list; prefer --api-key-file, --api-key - (stdin) or JAN_API_KEY");
            Ok(Some(key))
        }
        (None, Some(path)) => read_api_key_file(path).map(Some),
        (None, None) => Ok(None),
    }
}

impl ProviderArgs {
    fn into_overrides(self) -> ProviderOverrides {
        // Default the target provider to the desktop app's current selection so
        // env-key fallback (<PROVIDER>_API_KEY) works without an explicit flag.
        let pin = self.provider.is_some();
        let provider = self
            .provider
            .or_else(|| app_lib::core::cli::providers::desktop_selection().provider);
        let api_key = match resolve_api_key(self.api_key, self.api_key_file.as_deref(), read_stdin_secret) {
            Ok(key) => key,
            Err(message) => {
                eprintln!("{message}");
                std::process::exit(2);
            }
        };
        ProviderOverrides {
            provider,
            api_key,
            pin,
        }
        .with_env()
    }
}

#[derive(Subcommand)]
enum AgentCommands {
    /// Run the agent loop to completion, the session token budget, or a --max-turns cap
    Run {
        /// Project root containing .jan/agent/agent.toml
        #[arg(long, default_value = ".")]
        project: String,
        /// The task/prompt for the agent
        task: String,
        /// Model ID (overrides [agent].model in agent.toml)
        #[arg(long)]
        model: Option<String>,
        /// Prompt for approval before writes, shell commands, and MCP tool calls
        #[arg(long)]
        safe: bool,
        /// review (read-only), ask, auto or bypass. Replaces --safe.
        #[arg(long, value_name = "MODE")]
        mode: Option<String>,
        #[command(flatten)]
        providers: ProviderArgs,
        #[command(flatten)]
        sandbox: SandboxArgs,
        #[command(flatten)]
        budget: BudgetArgs,
        #[command(flatten)]
        worktree: WorktreeArgs,
        #[command(flatten)]
        resume: ResumeRunArgs,
        /// `text` streams the answer as it arrives; `json` prints one result
        /// object on stdout when the run finishes
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        output_format: OutputFormat,
        /// `stream-json` reads newline-delimited `user`, `permission`,
        /// `abort` and `tool_result` messages on stdin while the run is in
        /// flight, and requires `--output-format stream-json`; `text` (the
        /// default) does not read stdin at all
        #[arg(long, value_enum, default_value_t = InputFormat::Text)]
        input_format: InputFormat,
        /// JSON file declaring tools this host executes: a list of
        /// `{"name", "description", "parameters", "capability"}`. The model
        /// calls them as `host__<name>` (a name outside `[A-Za-z0-9_-]` is
        /// mapped to a safe one); each call arrives as a `tool_request` on stdout and
        /// must be answered with a `tool_result` on stdin, so this requires
        /// `--input-format stream-json`
        #[arg(long, value_name = "FILE")]
        host_tools: Option<String>,
        /// The host approves its own tool calls: no `permission_request` is
        /// raised for any host tool (built-ins are unaffected). For a host
        /// whose `tool_request` handler is itself the approval step; requires
        /// `--host-tools`
        #[arg(long, requires = "host_tools")]
        host_gate: bool,
        /// Stream this run's canonical events as JSON lines, as they happen:
        /// a path, or `-` for stdout (AH-183)
        #[arg(long, value_name = "PATH")]
        events: Option<String>,
        /// A named profile from agent.toml's [profiles.<name>] (AH-186)
        #[arg(long, value_name = "NAME")]
        profile: Option<String>,
        /// How much this run says about itself: compact, normal or verbose
        /// (AH-181). Overrides [output].density.
        #[arg(long, value_name = "DENSITY")]
        output_density: Option<String>,
        /// Text added to this run's system prompt
        #[arg(long, value_name = "TEXT")]
        append_system_prompt: Option<String>,
        /// A file whose contents are added to this run's system prompt
        #[arg(long, value_name = "FILE")]
        append_system_prompt_file: Option<String>,
        /// Limit this run to these tools (repeat); names as in `schedule tools`
        #[arg(long = "allow-tool", value_name = "TOOL")]
        allow_tools: Vec<String>,
        /// Withhold these tools from this run (repeat), on top of the project's denies
        #[arg(long = "deny-tool", value_name = "TOOL")]
        deny_tools: Vec<String>,
        /// Reasoning effort for this run: low, medium or high
        #[arg(long, value_name = "LEVEL")]
        effort: Option<String>,
        /// Do not save this run's session to disk (it cannot be resumed)
        #[arg(long)]
        ephemeral: bool,
        /// The final answer must be one JSON value valid against this JSON
        /// Schema, given inline or as a file path. An invalid answer goes back
        /// to the model with the error; the validated value is printed alone
        /// (text mode) or as `structured_output` in the JSON result.
        #[arg(long, value_name = "FILE|JSON")]
        json_schema: Option<String>,
        /// Repair attempts for --json-schema before the run fails (default 3)
        #[arg(long, value_name = "N", requires = "json_schema")]
        json_schema_attempts: Option<u64>,
    },
    /// Run one durable subagent from its spec, as a job's supervisor starts it
    /// (AH-101). Not meant to be run by hand.
    #[command(hide = true)]
    RunSubagent {
        #[arg(long)]
        spec: String,
    },
    /// Serve a JSON-lines API on stdin/stdout: start runs, stream their events,
    /// answer their approvals, report status and cancel them (AH-182)
    Serve,
    /// Run a single turn (debugging)
    Step {
        /// Project root containing .jan/agent/agent.toml
        #[arg(long, default_value = ".")]
        project: String,
        /// The task/prompt for the agent
        task: String,
        /// Model ID (overrides [agent].model in agent.toml)
        #[arg(long)]
        model: Option<String>,
        /// Prompt for approval before writes, shell commands, and MCP tool calls
        #[arg(long)]
        safe: bool,
        /// review (read-only), ask, auto or bypass. Replaces --safe.
        #[arg(long, value_name = "MODE")]
        mode: Option<String>,
        #[command(flatten)]
        providers: ProviderArgs,
        #[command(flatten)]
        sandbox: SandboxArgs,
        /// A named profile from agent.toml's [profiles.<name>] (AH-186)
        #[arg(long, value_name = "NAME")]
        profile: Option<String>,
    },
    /// Print resolved project config and available providers as JSON
    Status {
        /// Project root containing .jan/agent/agent.toml
        #[arg(long, default_value = ".")]
        project: String,
        #[command(flatten)]
        providers: ProviderArgs,
    },
    /// What a session's runs started, as a tree (AH-173)
    Tree {
        /// The session to read.
        #[arg(long)]
        session: String,
        /// Print the tree as JSON instead of lines.
        #[arg(long)]
        json: bool,
    },
    /// Run the tests, group the failures by what they said, and re-run each to
    /// see which happen twice (AH-152, AH-153)
    TestTriage {
        /// Project root to run in.
        #[arg(long, default_value = ".")]
        project: String,
        /// The test command, program first. Defaults to `cargo test`.
        #[arg(long, value_name = "ARG", num_args = 1..)]
        command: Vec<String>,
        /// Do not re-run the failures; then nothing is called flaky.
        #[arg(long)]
        no_retry: bool,
        /// Print the triage as JSON instead of lines.
        #[arg(long)]
        json: bool,
    },
    /// Run the project's own build, test and lint checks once and report (AH-072)
    Health {
        /// Project root to scan.
        #[arg(long, default_value = ".")]
        project: String,
        /// Only these checks: build, test, lint, dependencies.
        #[arg(long, value_name = "CHECK", num_args = 1..)]
        only: Vec<String>,
        /// List what would run, and run nothing.
        #[arg(long)]
        dry_run: bool,
        /// Print the scan as JSON instead of lines.
        #[arg(long)]
        json: bool,
    },
    /// Check dependencies against the licences the project allows (AH-158)
    Licenses {
        /// Project root to scan.
        #[arg(long, default_value = ".")]
        project: String,
        /// Licences to allow, overriding [licenses].allow.
        #[arg(long, value_name = "SPDX", num_args = 1..)]
        allow: Vec<String>,
        /// Write down what is here now, so a later scan can say what is new.
        #[arg(long)]
        record: bool,
        /// Print the scan as JSON instead of lines.
        #[arg(long)]
        json: bool,
    },
    /// Search past runs' transcripts by content (AH-178)
    Search {
        /// What to look for.
        query: String,
        /// Project root whose transcripts are searched alongside the data
        /// folder's.
        #[arg(long, default_value = ".")]
        project: String,
        /// Treat the query as a regular expression.
        #[arg(long)]
        regex: bool,
        /// Only this session.
        #[arg(long)]
        session: Option<String>,
        /// Only this role: user, assistant or tool.
        #[arg(long)]
        role: Option<String>,
        /// Stop after this many matches (0: every match).
        #[arg(long, default_value_t = 50)]
        limit: usize,
        /// Print the matches as JSON instead of lines.
        #[arg(long)]
        json: bool,
    },
    /// Write one session's transcript out (AH-178)
    Transcript {
        /// The session to export.
        session: String,
        /// Project root to look in, alongside the data folder.
        #[arg(long, default_value = ".")]
        project: String,
        /// text, markdown or json (the stored lines themselves).
        #[arg(long, default_value = "text")]
        format: String,
        /// Write to this file instead of stdout.
        #[arg(long, value_name = "PATH")]
        out: Option<String>,
    },
    /// Where use stands against the ceilings in quotas.toml (AH-191, AH-192)
    Quota {
        /// Print the standings as JSON instead of lines.
        #[arg(long)]
        json: bool,
    },
    /// Show the effective compaction policy and where each value came from (AH-076)
    Compaction {
        #[arg(long, default_value = ".")]
        project: String,
    },
    /// Write this project's agents, skills, commands and policy as one bundle (AH-145)
    BundleExport {
        #[arg(long, default_value = ".")]
        project: String,
        /// Where to write the bundle (JSON).
        out: String,
    },
    /// Bring a bundle's agents, skills, commands and policy into this project (AH-145)
    BundleImport {
        #[arg(long, default_value = ".")]
        project: String,
        /// The bundle file.
        file: String,
        /// Replace components that exist with different content.
        #[arg(long)]
        overwrite: bool,
        /// Apply a policy that allows more than the project does now.
        #[arg(long)]
        accept_widening: bool,
        /// Check and report, writing nothing.
        #[arg(long)]
        dry_run: bool,
    },
    /// Import agent definitions written for OpenCode or Qwen Code into Flint's
    /// own subagent format (AH-118, AH-119)
    ImportAgents {
        /// A definition file, a directory of them (`.opencode/agent`,
        /// `.qwen/agents`), or an `opencode.json`.
        path: String,
        /// Where the imported subagents are written: `user` (~/.jan) or
        /// `project` (<project>/.jan).
        #[arg(long, default_value = "user")]
        scope: String,
        /// Project root, when importing into the project scope.
        #[arg(long, default_value = ".")]
        project: String,
        /// Replace a subagent of the same name in that scope.
        #[arg(long)]
        overwrite: bool,
        /// Read and report, writing nothing.
        #[arg(long)]
        dry_run: bool,
    },
    /// Read this project's permission policy as a reviewable document (AH-052)
    PolicyExport {
        #[arg(long, default_value = ".")]
        project: String,
        /// Write it here instead of to stdout.
        #[arg(long)]
        out: Option<String>,
    },
    /// Replace this project's permission policy with a reviewed document (AH-052)
    PolicyImport {
        /// The document to apply, or `-` to read it from stdin.
        file: String,
        #[arg(long, default_value = ".")]
        project: String,
        /// Apply it even though it widens what the agent may do. Without
        /// this, an import that lifts a denial, adds a permission or opens
        /// the default is refused, and says exactly what it would open.
        #[arg(long)]
        accept_widening: bool,
    },
    /// Build or update this project's index, and look symbols up in it
    /// (AH-053/054/055/056)
    Index {
        /// The project to index. Omitted: the working directory.
        #[arg(long)]
        project: Option<String>,
        /// Look this name up instead of printing what the update did.
        #[arg(long)]
        symbol: Option<String>,
        /// The most matches to print.
        #[arg(long, default_value_t = 20)]
        limit: usize,
        /// Print it as JSON instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Tokens and, where a price is declared, what they cost (AH-175)
    Spend {
        /// A window like 7d, 24h or 30m. Omitted: everything recorded.
        #[arg(long)]
        since: Option<String>,
        /// One conversation only.
        #[arg(long)]
        session: Option<String>,
        /// Print it as JSON instead of text.
        #[arg(long)]
        json: bool,
        /// Attribute calls and subagent tokens to skills, MCP servers, plugins
        /// and subagents, and list what is configured but unused.
        #[arg(long)]
        by_item: bool,
    },
    /// What this harness writes to disk, at which version (AH-010)
    State {
        /// Print it as JSON instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Read or write a run's mailbox (AH-103)
    Mail {
        /// The run whose mailbox this is about.
        #[arg(long)]
        run: String,
        /// The session it belongs to. Needed to send; a read does not use it.
        #[arg(long)]
        session: Option<String>,
        /// Send instead of read: the run the message is from. Requires
        /// `--body`: half a send must be refused, not read as a read (#150).
        #[arg(long, requires = "body")]
        from: Option<String>,
        /// What to say. Requires `--from`.
        #[arg(long, requires = "from")]
        body: Option<String>,
        #[arg(long, default_value = "")]
        subject: String,
        /// Read without recording delivery, so a person can look without
        /// consuming what the run has not seen.
        #[arg(long)]
        peek: bool,
    },
    /// Where this branch stands against its remote, and what a stopped merge
    /// says (AH-171/AH-165). Reads only; fetches nothing, resolves nothing.
    Vcs {
        /// The repository to read. Omitted: the working directory.
        #[arg(long)]
        project: Option<String>,
        /// Print it as JSON instead of text.
        #[arg(long)]
        json: bool,
    },
    /// What a change can affect, and which tests cover it (AH-065/066/067/151)
    Impact {
        /// The files that changed, relative to the project, `/`-separated.
        /// Repeat the flag, or separate with commas.
        #[arg(long, value_delimiter = ',', required = true)]
        changed: Vec<String>,
        /// The project to read. Omitted: the working directory.
        #[arg(long)]
        project: Option<String>,
        /// Print the answer as JSON instead of text.
        #[arg(long)]
        json: bool,
    },
    /// What a session's last request was made of, by category (AH-087)
    Context {
        /// The session to read. Required: a breakdown belongs to one
        /// conversation, and reading another's is not a default.
        #[arg(long)]
        session: String,
        /// A specific request, by snapshot id. Omitted: the most recent one.
        #[arg(long)]
        snapshot: Option<String>,
        /// The model's context window, when you know it. Omitted, the window
        /// is reported as unknown rather than guessed at.
        #[arg(long)]
        window: Option<u64>,
        /// Print the breakdown as JSON instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Export a session's (or one run's) events under <data>/exports; metadata
    /// only unless `--include-content`
    EventsExport {
        session: String,
        #[arg(long)]
        run: Option<String>,
        #[arg(long)]
        include_content: bool,
    },
    /// Check an event export and count what it holds
    EventsInspect { file: std::path::PathBuf },
    /// List a session's finished runs that can be stepped through
    Replays { session: String },
    /// Print a finished run's recorded events in order
    Replay { session: String, run: String },
    /// Permission decisions recorded for approvals (newest last)
    Audit {
        #[arg(long)]
        session: Option<String>,
        #[arg(long)]
        run: Option<String>,
        #[arg(long)]
        agent: Option<String>,
        #[arg(long)]
        tool: Option<String>,
        /// allow, deny, prompt, granted, refused or expired
        #[arg(long)]
        decision: Option<String>,
        #[arg(long, default_value_t = 100)]
        limit: usize,
    },
    /// List the exact requests a session sent to the model, or print one as
    /// text (what the model saw: every message, tool call and tool offered)
    Prompts {
        /// The session whose requests to list
        session: String,
        /// Print one request in full: a snapshot id, or `last`
        #[arg(long)]
        show: Option<String>,
    },
    /// Print what a run changed: every side-effecting tool call it made (file
    /// writes with the file's hash before and after, commands, network calls),
    /// in order, from the session's record
    Ledger {
        /// A run id (`<session>#run-N`), or a session id for all of its runs
        run: String,
        /// Print the entries as a JSON array
        #[arg(long)]
        json: bool,
    },
    /// Print the protocol's JSON Schema, generated from the types that define
    /// the channel (see `protocol/schema.json`)
    Schema {
        /// Write to this file instead of stdout
        #[arg(long)]
        out: Option<std::path::PathBuf>,
    },
    /// Serve addressable sessions over JSON-RPC on stdin/stdout
    Rpc,
    /// Print the RPC request and event schemas, generated from the types that
    /// define the envelope (see `protocol/rpc-schema.json`)
    RpcSchema {
        /// Write to this file instead of stdout
        #[arg(long)]
        out: Option<std::path::PathBuf>,
    },
}

/// Read/write the user-wide `~/.jan/config.toml` provider store. This is the
/// self-sufficient config surface for a standalone Flint Agent: every command is
/// headless and persists across runs.
#[derive(Subcommand)]
enum AgentConfigCommands {
    /// Set or update a provider's API key, base URL, models, or API type
    Set {
        /// Provider id (e.g. openai, anthropic, groq)
        #[arg(long)]
        provider: String,
        /// API key for the provider
        #[arg(long)]
        api_key: Option<String>,
        /// Base URL (e.g. https://api.openai.com/v1)
        #[arg(long)]
        base_url: Option<String>,
        /// Model id to expose (repeatable; replaces any existing list)
        #[arg(long = "model")]
        models: Vec<String>,
        /// Wire API type (e.g. openai, anthropic); defaults to OpenAI-compatible
        #[arg(long)]
        api_type: Option<String>,
    },
    /// Remove a provider entry
    Unset {
        /// Provider id to remove
        #[arg(long)]
        provider: String,
    },
    /// List configured providers as JSON (API keys redacted)
    List,
    /// Print the config file path (scaffolding a template if absent)
    Path,
}

// ── Threads subcommands ────────────────────────────────────────────────────

/// Background jobs: start one that survives this process, see what it has
/// done, and stop it from anywhere.
#[derive(Subcommand)]
enum JobCommands {
    /// Start a command as a job that keeps running after this process exits
    Start {
        /// The conversation the job belongs to; only it can see or stop the job
        #[arg(long)]
        owner: String,
        /// The command to run, as the host shell would run it
        command: String,
        /// Where Flint keeps its data. Defaults to the configured data folder
        #[arg(long)]
        data: Option<String>,
    },
    /// This conversation's jobs, newest first
    List {
        #[arg(long)]
        owner: String,
        #[arg(long)]
        data: Option<String>,
    },
    /// What one job has produced so far
    Output {
        #[arg(long)]
        owner: String,
        id: String,
        #[arg(long)]
        data: Option<String>,
        /// How much of the end to show
        #[arg(long, default_value_t = 8192)]
        bytes: usize,
    },
    /// Stop one job and the work it is running
    Cancel {
        #[arg(long)]
        owner: String,
        id: String,
        #[arg(long)]
        data: Option<String>,
    },
    /// Run one job to its end and write down what happened. Started by
    /// `job start`; not meant to be run by hand.
    #[command(hide = true)]
    Supervise {
        #[arg(long)]
        data: String,
        #[arg(long)]
        id: String,
        #[arg(long)]
        owner: String,
        /// Normally absent: the token arrives on stdin so it is not on the
        /// command line. Kept for callers that still pass it.
        #[arg(long)]
        token: Option<String>,
        /// A line the host shell runs
        #[arg(long, conflicts_with = "argv_json")]
        command: Option<String>,
        /// Arguments for this program, as a JSON array (never a shell line)
        #[arg(long)]
        argv_json: Option<String>,
    },
}

#[derive(Subcommand)]
enum ImportClaudeCommands {
    /// List the Claude Code skills and plugins found
    Scan {
        /// Also look in `.claude` folders one level under this folder
        #[arg(long)]
        root: Option<String>,
    },
    /// Import them (a live link: later edits at the source come across)
    Run {
        #[arg(long)]
        root: Option<String>,
        /// An item to import by name (repeatable)
        #[arg(long = "name")]
        names: Vec<String>,
        /// Import everything found
        #[arg(long)]
        all: bool,
        /// Replace items that already exist in Flint
        #[arg(long)]
        overwrite: bool,
        /// Keep running a plugin's hooks from its Claude Code source
        #[arg(long)]
        link_hooks: bool,
    },
}

/// `scope` is project, user or chat (chat needs `--session`).
#[derive(Subcommand)]
enum MemoryCommands {
    /// List the memories in a scope
    List {
        scope: String,
        #[arg(long)]
        query: Option<String>,
        #[arg(long, default_value_t = 0)]
        offset: usize,
        #[arg(long, default_value_t = 50)]
        limit: usize,
        #[command(flatten)]
        place: MemoryPlace,
    },
    /// Show one memory with its source
    Show {
        scope: String,
        id: String,
        #[command(flatten)]
        place: MemoryPlace,
    },
    /// Forget one memory (the text also leaves saved requests)
    Forget {
        scope: String,
        id: String,
        #[command(flatten)]
        place: MemoryPlace,
    },
    /// Forget every memory in a scope
    Clear {
        scope: String,
        #[arg(long)]
        yes: bool,
        #[command(flatten)]
        place: MemoryPlace,
    },
    /// Keep a memory from expiring
    Pin {
        scope: String,
        id: String,
        #[command(flatten)]
        place: MemoryPlace,
    },
    /// Let a pinned memory expire again
    Unpin {
        scope: String,
        id: String,
        #[command(flatten)]
        place: MemoryPlace,
    },
    /// Read-only report: counts, near-duplicates, superseded leftovers,
    /// never-recalled and stale memories, and what they cost in a prompt
    Audit {
        /// Print the report as JSON
        #[arg(long)]
        json: bool,
        /// Report memories untouched for more than this many days
        #[arg(long, default_value_t = 90)]
        stale_days: u32,
        /// The project folder whose memory is audited
        #[arg(long, default_value = ".")]
        project: String,
    },
    /// Write a scope's memories, with provenance, to a file
    Export {
        scope: String,
        path: String,
        #[command(flatten)]
        place: MemoryPlace,
    },
}

#[derive(Args)]
struct MemoryPlace {
    /// The project folder whose memory is meant
    #[arg(long, default_value = ".")]
    project: String,
    /// The chat whose memory is meant (for the chat scope)
    #[arg(long)]
    session: Option<String>,
}

#[derive(Subcommand)]
enum MigrateCommands {
    /// Look for a JAN install and say what it holds
    Detect,
    /// Show what a migration would copy, move or reuse (changes nothing)
    Plan {
        /// copy, reuse, move or fresh
        #[arg(long, default_value = "copy")]
        mode: String,
        /// Only these categories (repeat; default: all)
        #[arg(long = "category")]
        categories: Vec<String>,
        /// keep_flint, use_jan or keep_both, for items on both sides
        #[arg(long, default_value = "keep_flint")]
        conflict: String,
    },
    /// Run the migration
    Run {
        #[arg(long, default_value = "copy")]
        mode: String,
        #[arg(long = "category")]
        categories: Vec<String>,
        #[arg(long, default_value = "keep_flint")]
        conflict: String,
        /// Do it; without this the plan is printed and nothing is changed
        #[arg(long)]
        yes: bool,
    },
    /// The record of the last migration
    Status,
    /// Remove what a migration copied (a move is restored from its backup)
    Rollback {
        #[arg(long)]
        yes: bool,
    },
    /// Stop offering the first-launch migration
    Dismiss,
}

#[derive(Subcommand)]
enum WorktreeCommands {
    /// List this repository's agent worktrees, with uncommitted and unmerged work
    List {
        #[arg(long, default_value = ".")]
        project: String,
        #[arg(long)]
        json: bool,
    },
    /// Merge a worktree's branch into the checked-out branch
    Merge {
        /// The worktree id (see `list`)
        id: String,
        #[arg(long, default_value = ".")]
        project: String,
        /// The branch to merge into; must be the one checked out
        #[arg(long)]
        into: Option<String>,
        #[arg(long)]
        message: Option<String>,
    },
    /// Remove a worktree and its branch; refuses while it holds unmerged work
    Discard {
        id: String,
        #[arg(long, default_value = ".")]
        project: String,
        /// Remove it even with uncommitted or unmerged work
        #[arg(long)]
        force: bool,
    },
}

#[derive(Subcommand)]
enum SkillsCommands {
    /// List the project's skills and whether each is enabled
    List {
        #[arg(long, default_value = ".")]
        project: String,
        #[arg(long)]
        json: bool,
    },
    /// Print a skill's SKILL.md
    Show {
        name: String,
        #[arg(long, default_value = ".")]
        project: String,
    },
    /// Create or replace a skill from a file, or from stdin with `--file -`
    Write {
        name: String,
        #[arg(long)]
        file: String,
        #[arg(long, default_value = ".")]
        project: String,
    },
    /// Delete a skill
    Delete {
        name: String,
        #[arg(long, default_value = ".")]
        project: String,
    },
    /// Show or set which skills are enabled (`--all` enables every skill)
    Enabled {
        names: Vec<String>,
        #[arg(long)]
        all: bool,
        #[arg(long, default_value = ".")]
        project: String,
    },
    /// List the skills on Anthropic's public skill hub (uses the network)
    HubList {
        #[arg(long)]
        json: bool,
    },
    /// Import a skill from the hub into the project (uses the network)
    HubImport {
        name: String,
        #[arg(long, default_value = ".")]
        project: String,
    },
}

#[derive(Subcommand)]
enum ApprovalsCommands {
    /// List the permission prompts a run put off (`[approvals] defer = true`)
    List {
        /// Only this project folder
        #[arg(long)]
        project: Option<std::path::PathBuf>,
        /// Include answered, applied, expired and voided ones
        #[arg(long)]
        all: bool,
        #[arg(long)]
        json: bool,
    },
    /// Allow a put-off call; the resumed session's identical call then runs once
    Allow { id: String },
    /// Deny a put-off call
    Deny { id: String },
    /// Drop a record from the list
    Discard { id: String },
    /// List the scoped rules saved with "allow always" (folder, command prefix)
    Rules {
        #[arg(long)]
        project: Option<std::path::PathBuf>,
        #[arg(long)]
        json: bool,
    },
    /// Revoke a scoped rule by its id
    Revoke { id: String },
}

#[derive(Subcommand)]
enum ArchiveCommands {
    /// List archived threads, rooms, sessions and so on
    List {
        /// thread, room, cowork, project, assistant or studio
        #[arg(long)]
        kind: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Put an archived thread or room back (use the archive id from `list`)
    Restore { kind: String, archive_id: String },
    /// Delete one archived item for good
    Purge {
        kind: String,
        archive_id: String,
        #[arg(long)]
        yes: bool,
    },
    /// Delete everything archived, or one kind
    Empty {
        #[arg(long)]
        kind: Option<String>,
        #[arg(long)]
        yes: bool,
    },
    /// Show or change the archive settings
    Settings {
        /// Whether delete moves to the archive at all
        #[arg(long)]
        enabled: Option<bool>,
        /// Purge items older than this many days (0 keeps them)
        #[arg(long)]
        auto_delete_days: Option<u32>,
        /// Archive threads idle this many days (0 is off)
        #[arg(long)]
        auto_archive_days: Option<u32>,
    },
}

#[derive(Subcommand)]
enum ThreadsCommands {
    /// Print all threads as JSON
    List,
    /// Print a single thread's metadata as JSON
    Get {
        /// Thread ID
        id: String,
    },
    /// Delete a thread: it moves to the archive unless `--permanent` is given
    Delete {
        /// Thread ID
        id: String,
        /// Skip the archive and remove the thread and its records for good
        #[arg(long)]
        permanent: bool,
        /// Confirm `--permanent`, which cannot be undone
        #[arg(long)]
        yes: bool,
    },
    /// Start an empty thread and print it
    Create {
        #[arg(long)]
        title: Option<String>,
    },
    /// Change a thread's title
    Rename { id: String, title: String },
    /// Mark a thread as a favourite
    Favorite { id: String },
    /// Remove the favourite mark
    Unfavorite { id: String },
    /// Write a thread as Markdown, Obsidian Markdown or JSON
    Export {
        /// Thread ID
        id: String,
        /// markdown, obsidian or json
        #[arg(long, default_value = "markdown")]
        format: String,
        /// Include tool input and output, reasoning and full paths
        #[arg(long)]
        verbose: bool,
        /// With `--format json`, every stored version of an edited message
        #[arg(long)]
        all_versions: bool,
        /// A file, or a folder to get a file named after the thread
        #[arg(long)]
        out: Option<String>,
        /// Read a thread saved by the terminal console for this project
        /// (default: the threads the desktop app saved)
        #[arg(long)]
        project: Option<String>,
    },
    /// Delete one message from a thread
    DeleteMessage { thread_id: String, message_id: String },
    /// Print a thread's messages as JSON (the conversation as shown)
    Messages {
        /// Thread ID
        thread_id: String,
        /// Include every stored version of an edited or regenerated message
        #[arg(long)]
        all_versions: bool,
    },
}

// ── Models subcommands ─────────────────────────────────────────────────────

#[derive(Subcommand)]
enum ModelsCommands {
    /// Print every configured provider's models as JSON (API keys redacted)
    List {
        /// Only show models from this provider (e.g. anthropic)
        #[arg(long)]
        provider: Option<String>,
        /// Project root whose agent.toml [provider] override is applied
        #[arg(long, default_value = ".")]
        project: String,
        /// Only models matching every word, case-insensitively (a long remote
        /// list narrows the way the app's model search does)
        #[arg(long)]
        filter: Option<String>,
    },
    /// Search Hugging Face for models (uses the network; HF_TOKEN is read if set)
    Search {
        query: String,
        /// gguf, mlx or all
        #[arg(long, default_value = "gguf")]
        format: String,
    },
    /// List a Hugging Face repository's files with their sizes
    Files { repo: String },
    /// Download one file from Hugging Face, resumable and checked against its SHA-256
    Download {
        /// owner/name
        repo: String,
        /// The file path inside the repository
        file: String,
    },
    /// Copy a GGUF into the local models folder so the local server finds it
    Import {
        /// Path to a .gguf file
        file: String,
        /// The model id to give it
        #[arg(long)]
        id: String,
    },
    /// List locally downloaded models (in the llamacpp/models directory)
    ListLocal {
        /// Print as JSON instead of a table
        #[arg(long)]
        json: bool,
    },
    /// Show metadata for a local model directory
    Info {
        /// Model ID (directory name in llamacpp/models/) or path to a .gguf file
        path: String,
        /// Print as JSON
        #[arg(long)]
        json: bool,
    },
    /// Delete a locally downloaded model
    Delete {
        /// Model ID (directory name in llamacpp/models/)
        id: String,
        /// Skip confirmation prompt
        #[arg(long)]
        yes: bool,
    },
}

// ── MCP subcommands ────────────────────────────────────────────────────────

/// Manage MCP servers in the shared <jan_data>/mcp_config.json, the same store
/// the desktop app and the TUI `/mcp` picker read. Every command is headless
/// and persists across runs.
#[derive(Subcommand)]
enum McpCommands {
    /// List every configured server as JSON, excluding the desktop-only browser bridge
    List {
        /// Show env/header values (they may contain secrets); redacted by default
        #[arg(long)]
        show_secrets: bool,
    },
    /// Print a single server's full config as JSON
    Get {
        /// Server name
        name: String,
    },
    /// Add a server, or replace an existing one with the same name (edit)
    Add {
        /// Server name (the key in mcpServers)
        name: String,
        /// Command for a stdio server (e.g. npx, uvx)
        #[arg(long)]
        command: Option<String>,
        /// Argument for the command, repeatable
        #[arg(long = "arg", allow_hyphen_values = true)]
        args: Vec<String>,
        /// Environment variable KEY=VALUE for a stdio server, repeatable
        #[arg(long = "env")]
        env: Vec<String>,
        /// Transport type: stdio (default), http, or sse
        #[arg(long, default_value = "stdio")]
        r#type: String,
        /// URL for an http/sse server (required unless stdio)
        #[arg(long)]
        url: Option<String>,
        /// Header KEY=VALUE for an http/sse server, repeatable
        #[arg(long = "header")]
        header: Vec<String>,
        /// OAuth scope an http/sse server's sign-in asks for, repeatable (AH-135)
        #[arg(long = "scope")]
        scope: Vec<String>,
        /// Mark the server active immediately; defaults to inactive
        #[arg(long)]
        active: bool,
    },
    /// List the prompts a server offers (AH-138)
    Prompts {
        /// Server name
        name: String,
    },
    /// Fetch one of a server's prompts, filled in (AH-138)
    Prompt {
        /// Server name
        name: String,
        /// Prompt name
        prompt: String,
        /// Argument KEY=VALUE, repeatable
        #[arg(long = "arg")]
        args: Vec<String>,
    },
    /// Remove a server entry from mcp_config.json
    Remove {
        /// Server name
        name: String,
    },
    /// Mark a server active (so the next session connects it)
    Enable {
        /// Server name
        name: String,
    },
    /// Mark a server inactive
    Disable {
        /// Server name
        name: String,
    },
    /// List the tools a server offers (connects to it)
    Tools {
        /// Server name
        name: String,
    },
    /// Standing trust grants, and approvals that stopped applying
    TrustReport {
        #[arg(long)]
        json: bool,
    },
    /// Trust a server as currently configured, for every conversation, until revoked
    Trust {
        name: String,
        /// Confirm: this lets the server's tools run without asking each time
        #[arg(long)]
        yes: bool,
    },
    /// Withdraw trust from a server
    Revoke { name: String },
    /// Print a server's own stderr log, newest last (AH-140)
    Logs {
        /// Server name
        name: String,
        /// How many lines
        #[arg(long, default_value_t = 100)]
        lines: usize,
    },
    /// Sign in to a server's OAuth provider (AH-135). Prints the scopes it asks
    /// for and the consent url, then waits for the redirect. Never opens a
    /// browser, so it works over SSH and in scripts
    Auth {
        /// Server name
        name: String,
    },
    /// Show a server's OAuth state as JSON, without touching the network (AH-134)
    AuthStatus {
        /// Server name
        name: String,
    },
    /// Forget a server's stored OAuth tokens (AH-134)
    AuthClear {
        /// Server name
        name: String,
    },
}

// ── ASCII logo ─────────────────────────────────────────────────────────────

/// Build a left-aligned, bright-yellow ASCII logo for the help header.
fn make_logo() -> String {
    let yellow = Style::new().yellow().bold();
    let mut out = vec![String::new(), String::new()];
    for l in app_lib::core::cli::brand::LOGO {
        out.push(format!("  {}", yellow.apply_to(l)));
    }
    out.join("\n")
}

// ── Entry point ────────────────────────────────────────────────────────────

/// Windows gives a process's main thread a 1 MB stack, and this CLI's command
/// tree is now deep enough that building it there overflows: every subcommand
/// added to the tree costs stack in a debug build, and the failure is a bare
/// "thread 'main' has overflowed its stack" with no other output at all.
///
/// So the whole program runs on a thread with room. The alternative -- keeping
/// the tree small enough to fit -- would mean deciding which of a person's
/// commands to remove.
fn main() {
    install_closed_pipe_hook();
    // `serve`/`stop --data-dir` must point every data-folder lookup at that
    // folder, including the grants, exclusions and log set up before the
    // command is parsed; and the variable is set before any thread exists.
    // Safe mode is read from the raw arguments before any thread exists, so
    // every loader sees one process-wide answer.
    if std::env::args().skip(1).take_while(|a| a != "--").any(|a| a == "--safe-mode") {
        tauri_plugin_agent_tools::safe_mode::enable();
    }
    if let Some(dir) = pre_parse_data_dir(std::env::args().skip(1)) {
        std::env::set_var("JAN_DATA_FOLDER", dir);
    }
    // `schedule tick --data` and `schedule run-spec` need the same, plus the
    // unattended flag; applied here, not inside the async command.
    let raw: Vec<String> = std::env::args().skip(1).collect();
    for (key, value) in app_lib::core::cli::schedule::process_env_for(&raw) {
        std::env::set_var(key, value);
    }
    let worker = std::thread::Builder::new()
        .name("jan-main".to_string())
        .stack_size(32 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("a tokio runtime")
                .block_on(run())
        })
        .expect("a thread to run on");
    // A panic inside has already printed; exiting non-zero keeps a caller from
    // reading a crash as success.
    if worker.join().is_err() {
        std::process::exit(70);
    }
}

/// `--append-system-prompt` and `--append-system-prompt-file`, joined. Giving
/// both is allowed (text first); an unreadable or empty file is an error.
fn resolve_append_prompt(text: Option<String>, file: Option<&str>) -> Result<Option<String>, String> {
    let from_file = match file {
        None => None,
        Some(path) => {
            let body = std::fs::read_to_string(path)
                .map_err(|e| format!("cannot read --append-system-prompt-file '{path}': {e}"))?;
            if body.trim().is_empty() {
                return Err(format!("--append-system-prompt-file '{path}' is empty"));
            }
            Some(body)
        }
    };
    Ok(match (text, from_file) {
        (Some(a), Some(b)) => Some(format!("{a}\n\n{b}")),
        (a, b) => a.or(b),
    })
}

/// `--json-schema`: inline JSON when it looks like JSON, else a file path. The
/// schema is checked for keywords the validator cannot enforce.
fn resolve_json_schema(arg: &str) -> Result<serde_json::Value, String> {
    let trimmed = arg.trim();
    let raw = if trimmed.starts_with('{') || trimmed == "true" || trimmed == "false" {
        trimmed.to_string()
    } else {
        std::fs::read_to_string(trimmed)
            .map_err(|e| format!("cannot read --json-schema file '{trimmed}': {e}"))?
    };
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("--json-schema is not valid JSON: {e}"))?;
    app_lib::core::agent::structured_output::load(value).map_err(|e| format!("--json-schema: {e}"))
}

/// The `--data-dir` value from raw args (only `serve` and `stop` accept it),
/// stopping at `--` so a task text can never be mistaken for it.
fn pre_parse_data_dir(args: impl Iterator<Item = String>) -> Option<String> {
    let args: Vec<String> = args.take_while(|a| a != "--").collect();
    // Another command's own `--data-dir` (or a task text naming one) must not
    // move the data folder, so only `serve` and `stop` are looked at.
    if !matches!(args.iter().find(|a| !a.starts_with('-')).map(String::as_str), Some("serve" | "stop")) {
        return None;
    }
    let mut args = args.into_iter();
    let mut found = None;
    while let Some(arg) = args.next() {
        if arg == "--data-dir" {
            found = args.next();
        } else if let Some(v) = arg.strip_prefix("--data-dir=") {
            found = Some(v.to_string());
        }
    }
    // A value shaped like a flag is the next option, not a directory.
    found.filter(|v| !v.is_empty() && !v.starts_with('-'))
}

/// Whether a panic message is the standard library giving up on a write to
/// stdout or stderr. `println!` panics with "failed printing to stdout" when the
/// reader has gone away -- `flint cli agent vcs | head` closes the pipe after
/// ten lines -- and there is nobody left to tell about it.
fn is_closed_output_panic(message: &str) -> bool {
    message.starts_with("failed printing to stdout")
        || message.starts_with("failed printing to stderr")
}

/// Exit quietly, instead of printing a panic, when a command's output stream
/// has been closed under it. Every other panic keeps the default report.
fn install_closed_pipe_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let message = payload
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| payload.downcast_ref::<&str>().copied())
            .unwrap_or_default();
        if is_closed_output_panic(message) {
            std::process::exit(0);
        }
        default_hook(info);
    }));
}

async fn run() {
    // Exits early if invoked as the Windows sandbox helper for a `bash` tool
    // call: the helper's only job is to spawn the confined shell and wait, so it
    // must run before anything else -- starting the app first would run a second
    // copy per shell command.
    tauri_plugin_agent_tools::run_sandbox_helper_if_requested();

    // The same trusted-folder list the desktop app keeps, so a folder trusted
    // there is trusted here, and one that is not stays off.
    tauri_plugin_agent_tools::folder_trust::set_store(
        app_lib::core::app::commands::resolve_jan_data_folder().join("trusted-folders.json"),
    );
    tauri_plugin_agent_tools::folder_trust::close_migration_if_fresh(
        &app_lib::core::app::commands::resolve_jan_data_folder(),
    );

    // The same toolchain grants the desktop app records, so a CLI run's
    // sandbox can use what the user allowed there.
    tauri_plugin_agent_tools::tools::toolchain_grants::set_store(
        tauri_plugin_agent_tools::tools::toolchain_grants::store_path(
            &app_lib::core::app::commands::resolve_jan_data_folder(),
        ),
    );

    // The off-limits regions and app allowlist the user saved in the desktop
    // app apply to the `computer` tool here too.
    tauri_plugin_agent_tools::tools::computer::set_active_exclusions(
        tauri_plugin_agent_tools::tools::computer::load_exclusions(
            &app_lib::core::app::commands::resolve_jan_data_folder(),
        ),
    );

    // Pre-scan raw args for --verbose / -v before full parse so we can set
    // the log level before any logging happens. stderr keeps its `warn`
    // default (`info` under -v); every info+ record also goes to a rotating
    // local file under the data folder, so a hung run leaves a trail without
    // the user having to rerun with -v (janhq/jan#8713).
    let verbose = std::env::args().any(|a| a == "--verbose" || a == "-v");
    app_lib::core::cli::file_log::init(
        app_lib::core::app::commands::resolve_jan_data_folder(),
        verbose,
    );

    // Inject the logo at runtime so we can use ANSI styling.
    let logo = make_logo();
    let matches = Cli::command()
        .version(app_lib::core::cli::version::build_version())
        .before_help(logo.clone())
        .before_long_help(logo)
        .get_matches();
    let cli = Cli::from_arg_matches(&matches).unwrap_or_else(|e| e.exit());

    let Some(command) = cli.command else {
        // No stderr notice on this path: the TUI's alternate screen would wipe
        // it, and blocking on the check here would delay the first frame. The
        // TUI runs the same check itself and notes it in the transcript.
        // The usage ping is likewise deferred to the TUI's own background task.
        let overrides = cli.providers.into_overrides();
        let mode_switches =
            match app_lib::core::cli::PermissionMode::resolve(cli.mode.as_deref(), cli.safe, cli.plan) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("Error: {e}");
                    std::process::exit(2);
                }
            };
        if let Err(e) = cli_agent_ui(
            &cli.project,
            cli.task,
            cli.model,
            cli.images,
            overrides,
            SessionFlags {
                auto_approve: mode_switches.0,
                bypass: app_lib::core::cli::PermissionMode::requests_bypass(cli.mode.as_deref()),
                plan: mode_switches.1,
                sandbox: cli.sandbox.into_flag(),
                worktree: cli.worktree.into_flag(),
                ..Default::default()
            },
            cli.resume.into_request(),
        )
        .await
        {
            eprintln!("Error: {e}");
            std::process::exit(1);
        }
        return;
    };

    match command {
        Commands::Serve { listen, assets_dir, data_dir, public_host, allow_mcp_stdio, agent_roots, agent_run, agent_max_sessions, agent_allow_bypass, agent_allow_always, agent_approval_timeout, agent_allow_checks, agent_require_sandbox, allowed_hosts, allowed_origins, llama_worker, background, credential_file, trust_proxy, rotate_credential } => {
            // `--data-dir` was applied in `main`, before any thread started.
            let _ = data_dir;
            let assets = assets_dir.unwrap_or_else(|| {
                std::env::current_exe()
                    .ok()
                    .and_then(|exe| exe.parent().map(|dir| dir.join("web")))
                    .unwrap_or_else(|| std::path::PathBuf::from("web"))
            });
            let data_folder = app_lib::core::app::commands::resolve_jan_data_folder();
            if rotate_credential {
                if app_lib::core::web_server::control::running(&data_folder).is_some() {
                    eprintln!("Error: a Flint server is running on this data folder; stop it with `flint stop`, then rotate the credential.");
                    std::process::exit(1);
                }
                let auth_file = data_folder.join("web-server").join("auth.json");
                let result = app_lib::core::web_server::auth::AuthStore::open(auth_file)
                    .and_then(|(mut store, created)| match created {
                        Some(credential) => Ok(credential),
                        None => store.rotate(),
                    });
                match result {
                    Ok(credential) => {
                        println!("New administrator credential: {credential}");
                        println!("Store this credential securely; it is shown only once. Every browser session was signed out.");
                        return;
                    }
                    Err(error) => {
                        eprintln!("Error: {error}");
                        std::process::exit(1);
                    }
                }
            }
            if background {
                // The same command again, without the flag, detached.
                let args: Vec<String> = std::env::args()
                    .skip(1)
                    .filter(|a| a != "--background" && a != "--detach")
                    .collect();
                let exe = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("flint"));
                match app_lib::core::web_server::control::start_background(
                    &exe,
                    &args,
                    &data_folder,
                    std::time::Duration::from_secs(30),
                ) {
                    Ok(started) => {
                        println!("Flint server running in the background (pid {}) on http://{}", started.pid, started.listen);
                        println!("Log: {}", started.log.display());
                        println!("Stop it with: flint stop");
                        if let Some(credential) = started.credential {
                            println!("First-run administrator credential: {credential}");
                            println!("Store this credential securely; it is shown only once.");
                        }
                        return;
                    }
                    Err(message) => {
                        eprintln!("Error: {message}");
                        std::process::exit(1);
                    }
                }
            }
            let auth_file = data_folder.join("web-server").join("auth.json");
            if let Err(error) = app_lib::core::web_server::server::serve(
                app_lib::core::web_server::server::Options {
                    bind: listen,
                    assets,
                    data_folder,
                    auth_file,
                    public_host,
                    allow_mcp_stdio,
                    agent_roots,
                    agent_run,
                    agent_runner: app_lib::core::web_server::runner::RunnerOptions {
                        max_sessions: agent_max_sessions.max(1),
                        allow_bypass: agent_allow_bypass,
                        allow_always: agent_allow_always,
                        approval_timeout: std::time::Duration::from_secs(agent_approval_timeout.max(1)),
                        require_sandbox: agent_require_sandbox,
                        allow_checks: agent_allow_checks,
                    },
                    allowed_hosts,
                    allowed_origins,
                    llama_worker,
                    credential_file,
                    trust_proxy,
                },
            ).await {
                eprintln!("Error: {error}");
                std::process::exit(1);
            }
        }
        Commands::Stop { data_dir } => {
            // `--data-dir` was applied in `main`, before any thread started.
            let _ = data_dir;
            let data_folder = app_lib::core::app::commands::resolve_jan_data_folder();
            match app_lib::core::web_server::control::stop(&data_folder, std::time::Duration::from_secs(20)) {
                Ok(app_lib::core::web_server::control::Stopped::Clean) => println!("Flint server stopped."),
                Ok(app_lib::core::web_server::control::Stopped::Forced) => {
                    println!("Flint server did not stop when asked, so its process was ended.")
                }
                Ok(app_lib::core::web_server::control::Stopped::NotRunning) => {
                    println!("No Flint server is running on {}.", data_folder.display())
                }
                Ok(app_lib::core::web_server::control::Stopped::Foreign) => {
                    eprintln!("Something else is using the recorded server address and did not accept the stop request; nothing was ended.");
                    std::process::exit(1);
                }
                Err(error) => {
                    eprintln!("Error: {error}");
                    std::process::exit(1);
                }
            }
        }
        Commands::Cli { cmd } => handle_cli(cmd).await,
        Commands::Launch { tool, model, base_url, api_key, dry_run, json, args } => {
            if let Err(e) = app_lib::core::cli::launch_cmd::run(
                &tool,
                model.as_deref(),
                base_url.as_deref(),
                api_key.as_deref(),
                dry_run,
                json,
                &args,
            ) {
                eprintln!("Error [{}]: {}", e.kind().tag(), e.message());
                std::process::exit(e.exit_code());
            }
        }
        Commands::Login { paste_token } => {
            if let Err(e) = app_lib::core::cli::login::run_login(paste_token).await {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }
        Commands::Auth { cmd } => {
            if let Err(e) = handle_auth(cmd).await {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }
        Commands::Usage { cmd, json } => {
            if let Err(e) = handle_usage(cmd, json).await {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }
        Commands::Config { cmd } => {
            if let Err(e) = handle_agent_config(cmd) {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }
        Commands::Plugin { cmd } => handle_plugin(cmd).await,
        Commands::Review {
            project,
            base,
            security,
            model,
            fix,
            json,
        } => {
            if let Err(e) = cli_review(&project, base.as_deref(), security, model, fix, json).await {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }
        Commands::BugReport {
            thread,
            show,
            yes,
            out,
        } => handle_bug_report(thread, show, yes, out),
        Commands::Doctor { json } => handle_doctor(json),
        Commands::Migrate { cmd } => {
            use app_lib::core::cli::migrate_cmd as m;
            exit_on_error(match cmd {
                MigrateCommands::Detect => m::detect_cmd(),
                MigrateCommands::Plan { mode, categories, conflict } => m::plan_cmd(&mode, &categories, &conflict),
                MigrateCommands::Run { mode, categories, conflict, yes } => {
                    m::run_cmd(&mode, &categories, &conflict, yes)
                }
                MigrateCommands::Status => m::status_cmd(),
                MigrateCommands::Rollback { yes } => m::rollback_cmd(yes),
                MigrateCommands::Dismiss => m::dismiss_cmd(),
            });
        }
        Commands::Mcp { cmd } => handle_mcp_serve(cmd).await,
    }
}

/// `flint usage` handler: read recorded spend from the Tokamak usage API.
///
/// Every view goes through one fetch so failures, timeouts and the
/// not-signed-in case are reported identically. A failed lookup exits non-zero
/// so a script cannot read it as a zero charge.
async fn handle_usage(cmd: Option<UsageCommands>, json: bool) -> Result<(), String> {
    use app_lib::core::cli::tokamak::usage::{self, Query};

    let query = match &cmd {
        None | Some(UsageCommands::Account) => Query::Summary,
        Some(UsageCommands::Daily) => Query::Daily,
        Some(UsageCommands::Requests) => Query::Requests,
        Some(UsageCommands::Limits) => Query::Limits,
        Some(UsageCommands::Generation { id }) => Query::Generation(id.clone()),
        Some(UsageCommands::Correlate { client_request_id }) => {
            Query::Correlated(client_request_id.clone())
        }
    };
    let payload = usage::fetch(&query).await.map_err(|e| e.to_string())?;
    if json {
        println!("{}", payload.as_str());
        return Ok(());
    }
    // `Fixed`: nothing is folded in a pipe, and there is no key to unfold it.
    for line in app_lib::core::cli::usage_view::reported_usage_lines(
        &query,
        &payload,
        app_lib::core::cli::usage_view::Fold::Fixed,
    ) {
        println!("{line}");
    }
    Ok(())
}

// ── MCP server handler ─────────────────────────────────────────────────────

async fn handle_mcp_serve(cmd: McpServeCommands) {
    let McpServeCommands::Serve {
        project,
        transport,
        allow_write,
        allow_exec,
        tools,
        port,
        token,
        token_file,
    } = cmd;
    let token = match token_file {
        Some(path) => match read_secret_file(&path, "--token-file") {
            Ok(token) => Some(token),
            Err(message) => {
                eprintln!("{message}");
                std::process::exit(2);
            }
        },
        None => {
            if token.is_some() {
                eprintln!("warning: --token is visible in the process list; prefer --token-file");
            }
            token
        }
    };
    let flags = ServeFlags {
        allow_write,
        allow_exec,
        only: tools,
        port,
        token,
    };
    if let Err(e) = cli_mcp_serve(&project, transport, flags).await {
        eprintln!("Error: {e}");
        std::process::exit(1);
    }
}

/// `jan bug-report`: show what the bundle would hold, then write it only when
/// the user agrees. Writing the local archive is the last thing it does --
/// nothing is uploaded, opened, or sent.
fn handle_bug_report(
    thread: Option<String>,
    show: Option<String>,
    yes: bool,
    out: Option<std::path::PathBuf>,
) {
    use std::io::IsTerminal;

    let data_folder = app_lib::core::app::commands::resolve_jan_data_folder();
    // Agent runs persist threads to the project's `.jan/agent`; the desktop
    // app uses the data folder. Prefer the project store when the cwd has one,
    // so running this where the run misbehaved reports on that run.
    let project = app_lib::core::cli::agent_dir_for(std::path::Path::new("."));
    let threads_base = if project.join("threads").is_dir() {
        project
    } else {
        data_folder.clone()
    };
    let preview = match app_lib::core::cli::doctor::prepare(
        &threads_base,
        &data_folder,
        thread.as_deref(),
        out.as_deref(),
    ) {
        Ok(preview) => preview,
        Err(e) => {
            eprintln!("Error: {e}");
            std::process::exit(1);
        }
    };

    if let Some(member) = show {
        match preview.member(&member) {
            Some(content) => {
                print!("{content}");
                if !content.ends_with('\n') {
                    println!();
                }
            }
            None => {
                eprintln!("Error: no member named '{member}'. Members:");
                for (name, _) in &preview.members {
                    eprintln!("  {name}");
                }
                std::process::exit(1);
            }
        }
        return;
    }

    for line in preview.summary() {
        println!("{line}");
    }
    println!("Review a member with: jan bug-report --show <member>");

    let confirmed = if yes {
        true
    } else if std::io::stdin().is_terminal() {
        use std::io::Write;
        print!("Save this bundle? [y/N] ");
        let _ = std::io::stdout().flush();
        let mut answer = String::new();
        let _ = std::io::stdin().read_line(&mut answer);
        matches!(answer.trim(), "y" | "Y" | "yes" | "YES")
    } else {
        false
    };
    if !confirmed {
        println!("Nothing written. Re-run with --yes to save it.");
        return;
    }
    match preview.save() {
        Ok(path) => println!("Saved: {}", path.display()),
        Err(e) => {
            eprintln!("Error: {e}");
            std::process::exit(1);
        }
    }
}

async fn handle_plugin(cmd: PluginCommands) {
    let result =
        match cmd {
            PluginCommands::List { project, json } => {
                let plugins = cli_plugin_list(&project);
                if json {
                    println!("{}", serde_json::to_string_pretty(&plugins).unwrap());
                } else {
                    print!("{}", format_plugin_list(&plugins));
                }
                Ok(())
            }
            PluginCommands::Install { spec, project } => cli_plugin_install(&project, &spec)
                .await
                .map(|plugins| match plugins.as_slice() {
                    // A single install keeps the original JSON-object output so
                    // existing scripts parsing it are unaffected; a batch install
                    // (plugin collection) prints the JSON array.
                    [plugin] => println!("{}", serde_json::to_string_pretty(plugin).unwrap()),
                    many => println!("{}", serde_json::to_string_pretty(many).unwrap()),
                }),
            PluginCommands::Remove { name, project } => {
                cli_plugin_remove(&project, &name).map(|()| println!("Removed plugin '{name}'"))
            }
            PluginCommands::Update { name, project } => cli_plugin_update(&project, &name)
                .await
                .map(|report| println!("{}", report.message)),
            PluginCommands::Search { query, project } => {
                cli_plugin_search(&project, query.as_deref().unwrap_or(""))
                    .await
                    .map(|entries| println!("{}", serde_json::to_string_pretty(&entries).unwrap()))
            }
        };
    if let Err(e) = result {
        eprintln!("Error: {e}");
        std::process::exit(1);
    }
}

fn format_plugin_list(plugins: &[InstalledPlugin]) -> String {
    if plugins.is_empty() {
        return "No plugins installed.\n".into();
    }

    let name_width = plugins
        .iter()
        .map(|plugin| plugin.name.len())
        .max()
        .unwrap_or(0)
        .max("PLUGIN".len());
    let version_width = plugins
        .iter()
        .map(|plugin| plugin.version.len())
        .max()
        .unwrap_or(0)
        .max("VERSION".len());
    let skills_width = plugins
        .iter()
        .map(|plugin| plugin.skills.to_string().len())
        .max()
        .unwrap_or(0)
        .max("SKILLS".len());
    let commands_width = plugins
        .iter()
        .map(|plugin| plugin.commands.to_string().len())
        .max()
        .unwrap_or(0)
        .max("COMMANDS".len());
    let agents_width = plugins
        .iter()
        .map(|plugin| plugin.agents.to_string().len())
        .max()
        .unwrap_or(0)
        .max("AGENTS".len());

    let mut output = String::new();
    writeln!(
        output,
        "{:<name_width$}  {:<version_width$}  {:>skills_width$}  {:>commands_width$}  {:>agents_width$}",
        "PLUGIN", "VERSION", "SKILLS", "COMMANDS", "AGENTS"
    )
    .unwrap();
    for plugin in plugins {
        writeln!(
            output,
            "{:<name_width$}  {:<version_width$}  {:>skills_width$}  {:>commands_width$}  {:>agents_width$}",
            plugin.name, plugin.version, plugin.skills, plugin.commands, plugin.agents
        )
        .unwrap();
    }
    output
}

// ── CLI dispatch ─────────────────────────────────────────────────────────

/// `flint trust`: the list of folders allowed to run their own hooks and
/// agent definitions. Trusting is kept for good; `--revoke` undoes it.
fn handle_trust(folder: Option<std::path::PathBuf>, revoke: bool, list: bool) {
    use tauri_plugin_agent_tools::folder_trust;
    if list {
        for entry in folder_trust::list() {
            println!("{entry}");
        }
        return;
    }
    let folder = folder
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| {
            eprintln!("Error: no folder given and the current folder is unknown");
            std::process::exit(1);
        });
    let outcome = if revoke {
        folder_trust::revoke(&folder).map(|was| {
            if was { "no longer trusted" } else { "was not in the trusted list" }
        })
    } else if !folder.is_dir() {
        Err(format!("{} is not a folder", folder.display()))
    } else {
        folder_trust::trust(&folder).map(|_| "trusted for good")
    };
    match outcome {
        Ok(what) => println!("{}: {what}", folder.display()),
        Err(e) => {
            eprintln!("Error: {e}");
            std::process::exit(1);
        }
    }
}

async fn handle_cli(cmd: CliCommands) {
    match cmd {
        CliCommands::Job { cmd } => handle_job(cmd),
        CliCommands::Threads { cmd } => handle_threads(cmd).await,
        CliCommands::Archive { cmd } => handle_archive(cmd).await,
        CliCommands::Acp => {
            if let Err(e) = app_lib::core::cli::acp::serve().await {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }
        CliCommands::Skills { cmd } => handle_skills(cmd).await,
        CliCommands::Worktree { cmd } => handle_worktree(cmd),
        CliCommands::Memory { cmd } => handle_memory(cmd),
        CliCommands::Approvals { cmd } => handle_approvals(cmd),
        CliCommands::ImportClaude { cmd } => handle_import_claude(cmd).await,
        CliCommands::DataFolder { set, no_copy } => {
            let result = match set {
                Some(folder) => app_lib::core::cli::system_cmd::set_data_folder(&folder, !no_copy),
                None => Ok(app_lib::core::cli::system_cmd::data_folder_info()),
            };
            print_or_exit(result);
        }
        CliCommands::Trust { folder, revoke, list } => handle_trust(folder, revoke, list),
        CliCommands::Models { cmd } => handle_models(cmd).await,
        CliCommands::Agent { cmd } => agent_cmd::handle_agent(cmd).await,
        CliCommands::Mcp { cmd } => {
            if let Err(e) = handle_mcp(cmd).await {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }
        CliCommands::Net { cmd } => handle_net(cmd),
        CliCommands::Bench { cmd } => handle_bench(cmd),
        CliCommands::Automation { cmd } => {
            use app_lib::core::cli::automation_cmd as auto;
            let result = match cmd {
                AutomationCommands::List { json } => auto::list(json),
                AutomationCommands::Show { id } => auto::show(&id),
                AutomationCommands::Validate { file, json } => auto::validate(&file, json),
                AutomationCommands::Add { file, json } => auto::add(&file, json),
                AutomationCommands::Run { id, folder, wait } => auto::run(&id, folder.as_deref(), wait).await,
                AutomationCommands::Remove { id, yes } => {
                    if yes {
                        auto::remove(&id)
                    } else {
                        Err(HarnessError::new(
                            tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
                            "this deletes the automation and its run history; run again with --yes",
                        ))
                    }
                }
            };
            if let Err(e) = result {
                eprintln!("Error [{}]: {}", e.kind().tag(), e.message());
                std::process::exit(e.exit_code());
            }
        }
        CliCommands::Schedule { cmd } => {
            use app_lib::core::cli::{schedule, schedule_manage};
            let result = match cmd {
                ScheduleCommands::List { json } => schedule::list(json),
                ScheduleCommands::Run { id, wait } => schedule::run_now(&id, wait).await,
                ScheduleCommands::Tick { data, json } => schedule::tick(data.as_deref(), json),
                ScheduleCommands::Runs { id, limit, json } => schedule::runs(&id, limit, json),
                ScheduleCommands::Add { task, json } => {
                    task.into_input().and_then(|i| schedule_manage::add(i, json))
                }
                ScheduleCommands::Edit { id, task, json } => {
                    task.into_input().and_then(|i| schedule_manage::edit(&id, i, json))
                }
                ScheduleCommands::Delete { id, yes } => {
                    if yes {
                        schedule_manage::delete(&id)
                    } else {
                        Err(HarnessError::new(
                            tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
                            "this deletes the task and its run history; run again with --yes",
                        ))
                    }
                }
                ScheduleCommands::Enable { id, json } => schedule_manage::set_enabled(&id, true, json),
                ScheduleCommands::Disable { id, json } => schedule_manage::set_enabled(&id, false, json),
                ScheduleCommands::Preview { id, task, count, json } => task
                    .into_input()
                    .and_then(|i| schedule_manage::preview(id.as_deref(), i, count, json)),
                ScheduleCommands::Cancel { id, run } => schedule_manage::cancel_run(&id, &run),
                ScheduleCommands::Tools { json } => schedule_manage::tools(json),
                ScheduleCommands::TimeZones => {
                    schedule_manage::time_zones();
                    Ok(())
                }
                ScheduleCommands::Os { action, interval_minutes, yes, json } => {
                    schedule_manage::os(&action, interval_minutes, yes, json)
                }
                ScheduleCommands::RunSpec { spec } => schedule::run_spec(std::path::Path::new(&spec)).await,
            };
            if let Err(e) = result {
                eprintln!("Error [{}]: {}", e.kind().tag(), e.message());
                std::process::exit(e.exit_code());
            }
        }
    }
}

/// `flint cli bench`: measure the harness against a fixed task set (AH-196).
fn handle_bench(cmd: BenchCommands) {
    use app_lib::core::cli::bench;
    use tauri_plugin_agent_tools::harness_error::ErrorKind;
    let result: Result<i32, HarnessError> = match cmd {
        BenchCommands::Run { tasks, model, out, label } => (|| {
            let (set, digest) = bench::load_tasks(std::path::Path::new(&tasks))?;
            let program = std::env::current_exe()
                .map_err(|e| HarnessError::new(ErrorKind::Io, format!("this program cannot find itself: {e}")))?;
            let temp = std::env::temp_dir();
            // What an earlier benchmark that was killed outright left behind.
            for swept in bench::sweep_stale_scratch(&temp) {
                eprintln!("  removed scratch left by an earlier benchmark: {}", swept.display());
            }
            let scratch = bench::scratch_dir(&temp, std::process::id());
            bench::claim_scratch(&scratch)
                .map_err(|e| HarnessError::new(ErrorKind::Io, format!("the scratch folder is not usable: {e}")))?;
            // The first Ctrl-C stops the task in flight -- its whole process
            // tree -- and the report is written as incomplete.
            let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            {
                let stop = stop.clone();
                std::thread::spawn(move || {
                    if let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() {
                        if runtime.block_on(tokio::signal::ctrl_c()).is_ok() {
                            eprintln!("  stopping: the task in flight is being ended and the report written");
                            stop.store(true, std::sync::atomic::Ordering::SeqCst);
                        }
                    }
                });
            }
            let runner = bench::ProcessRunner { program, model: model.clone() };
            let report = bench::run_tasks(
                &set,
                &digest,
                &model,
                &label,
                &scratch,
                &runner,
                &|| stop.load(std::sync::atomic::Ordering::SeqCst),
                &mut |t| eprintln!("  {:<24} {:<14} {:>6} ms  {}  {}", t.id, t.state, t.duration_ms, t.efficiency(), t.notes.first().map(String::as_str).unwrap_or("")),
            );
            let _ = std::fs::remove_dir_all(&scratch);
            let report = report?;
            let body = serde_json::to_string_pretty(&report).unwrap_or_default();
            std::fs::write(&out, body)
                .map_err(|e| HarnessError::new(ErrorKind::Io, format!("the report could not be written to {out}: {e}")))?;
            println!(
                "{} of {} tasks passed{} -- report written to {out}",
                report.passed(),
                set.tasks.len(),
                if report.complete { "" } else { " (stopped before every task ran)" }
            );
            Ok(if report.complete { 0 } else { 130 })
        })(),
        BenchCommands::Compare { before, after } => (|| {
            let b = bench::load_report(std::path::Path::new(&before))?;
            let a = bench::load_report(std::path::Path::new(&after))?;
            let comparison = bench::compare(&b, &a)?;
            println!("{}", serde_json::to_string_pretty(&comparison).unwrap_or_default());
            if !comparison.regressions.is_empty() {
                eprintln!("Regressed: {}", comparison.regressions.join(", "));
                return Ok(1);
            }
            Ok(0)
        })(),
    };
    match result {
        Ok(0) => {}
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("Error [{}]: {}", e.kind().tag(), e.message());
            std::process::exit(e.exit_code());
        }
    }
}

/// `flint cli net`: outbound network settings (AH-190).
fn handle_net(cmd: NetCommands) {
    use app_lib::core::net::tls;
    let cmd = match cmd {
        NetCommands::Ca { cmd } => cmd,
        NetCommands::Endpoint { host, port } => {
            match app_lib::core::cli::system_cmd::endpoint(&host, port) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default()),
                Err(e) => {
                    eprintln!("Error: {e}");
                    std::process::exit(1);
                }
            }
            return;
        }
    };
    let result: Result<(), HarnessError> = match cmd {
        CaCommands::Status => {
            println!("{}", serde_json::to_string_pretty(&tls::status()).unwrap_or_default());
            Ok(())
        }
        CaCommands::Set { path } => {
            // Made absolute against the working directory, but not resolved:
            // resolving would quietly trust whatever a link in the path points
            // to, which `load` refuses by name.
            let given = std::path::Path::new(&path);
            let absolute = if given.is_absolute() {
                path.clone()
            } else {
                std::env::current_dir()
                    .map(|d| d.join(given).to_string_lossy().to_string())
                    .unwrap_or(path.clone())
            };
            match tls::load(std::path::Path::new(&absolute), tls::Source::CliConfig) {
                Ok(bundle) => app_lib::core::agent::global_config::set_ca_bundle(Some(&absolute))
                    .map(|written| {
                        println!(
                            "Trusting {} certificate(s) from {} in addition to the platform's roots ({}).",
                            bundle.fingerprints.len(),
                            absolute,
                            written.display()
                        );
                        if std::env::var_os(tls::ENV).is_some() {
                            eprintln!("Note: {} is set in this environment and takes precedence.", tls::ENV);
                        }
                    })
                    .map_err(|e| HarnessError::new(tauri_plugin_agent_tools::harness_error::ErrorKind::Io, e)),
                Err(e) => Err(HarnessError::from(&e)),
            }
        }
        CaCommands::Check { path } => {
            println!(
                "{}",
                serde_json::to_string_pretty(&app_lib::core::cli::system_cmd::ca_check(&path)).unwrap_or_default()
            );
            Ok(())
        }
        CaCommands::Clear => app_lib::core::agent::global_config::set_ca_bundle(None)
            .map(|written| println!("No CA bundle is named in {} any more.", written.display()))
            .map_err(|e| HarnessError::new(tauri_plugin_agent_tools::harness_error::ErrorKind::Io, e)),
    };
    if let Err(e) = result {
        eprintln!("Error [{}]: {}", e.kind().tag(), e.message());
        std::process::exit(e.exit_code());
    }
}

// ── Agent handlers ───────────────────────────────────────────────────────

use tauri_plugin_agent_tools::harness_error::HarnessError;

/// `flint cli job`: work that outlives the process that started it.
fn handle_job(cmd: JobCommands) {
    use tauri_plugin_agent_tools::worker;
    let folder = |given: Option<String>| -> std::path::PathBuf {
        given
            .map(std::path::PathBuf::from)
            .unwrap_or_else(app_lib::core::app::commands::resolve_jan_data_folder)
    };
    let result = match cmd {
        JobCommands::Start {
            owner,
            command,
            data,
        } => {
            let data = folder(data);
            // This binary is the supervisor: the same one that is already
            // installed, so nothing new has to be shipped or found.
            let me = std::env::current_exe().unwrap_or_else(|_| "jan".into());
            worker::start(&data, &me, &owner, &command, ("", "", "")).map(|record| {
                println!("{}", record.id);
                eprintln!(
                    "{}",
                    app_lib::core::cli::color::paint(
                        "2",
                        format_args!(
                            "[job {} started; it keeps running if this process exits]",
                            record.id,
                        ),
                    ),
                );
            })
        }
        JobCommands::List { owner, data } => {
            let data = folder(data);
            // What an earlier process left is settled before it is listed, so
            // a job nobody is running is not shown as running.
            worker::reconcile(&data, &owner);
            let mut jobs = tauri_plugin_agent_tools::job_record::read_owner(&data, &owner);
            jobs.reverse();
            if jobs.is_empty() {
                println!("No background jobs.");
            }
            for job in jobs {
                println!(
                    "{}  {:<12} {}",
                    job.id,
                    job.state.tag(),
                    job.summary
                );
            }
            Ok(())
        }
        JobCommands::Output {
            owner,
            id,
            data,
            bytes,
        } => {
            let data = folder(data);
            worker::output(&data, &owner, &id, bytes).map(|text| print!("{text}"))
        }
        JobCommands::Cancel { owner, id, data } => {
            let data = folder(data);
            worker::cancel(&data, &owner, &id).map(|state| {
                println!("{}", state.tag());
            })
        }
        JobCommands::Supervise {
            data,
            id,
            owner,
            token,
            command,
            argv_json,
        } => {
            let token = match token {
                Some(t) => t,
                None => {
                    let mut line = String::new();
                    let _ = std::io::stdin().read_line(&mut line);
                    line.trim().to_string()
                }
            };
            match (command, argv_json) {
            (_, Some(argv)) => worker::supervise_argv(std::path::Path::new(&data), &id, &owner, &token, &argv),
            (Some(command), None) => worker::supervise(std::path::Path::new(&data), &id, &owner, &token, &command),
            (None, None) => Err(HarnessError::new(
                tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
                "a job needs --command or --argv-json",
            )),
            }
            .map(|state| {
                // Nothing is printed on the happy path: the supervisor has no
                // console, and what it has to say is in the record.
                let _ = state;
            })
        }
    };
    if let Err(e) = result {
        eprintln!("Error [{}]: {}", e.kind().tag(), e.message());
        std::process::exit(e.exit_code());
    }
}

/// Classify a failed agent run for the shell (upstream janhq/jan 5ae763e2e8).
///
/// Running out of turns with the model still calling tools is not the same
/// outcome as a crash or a usage error: the run stopped where the caller asked
/// it to stop, but it has no final answer, so a pipeline that only reads the
/// exit code would take an unfinished task for a finished one. It exits `53`;
/// every other ending has its own typed reason (`end_reason`), and a plain
/// failure keeps the kind's own code.
fn run_exit_code(e: &HarnessError) -> i32 {
    app_lib::core::agent::end_reason::EndReason::from_error(e).exit_code(Some(e))
}

/// `flint cli agent prompts`: what a session sent to the model (AH-087).
///
/// Without `show`, one line per recorded request. With `show`, that request as
/// text -- `last` for the most recent. The session is required and must match
/// the record: a snapshot id alone is not enough to read one.
fn agent_prompts_text(
    data_folder: &std::path::Path,
    session: &str,
    show: Option<&str>,
) -> Result<String, String> {
    use tauri_plugin_agent_tools::snapshot::scoped_lookup;
    if session.trim().is_empty() {
        return Err("name the session whose requests to show".to_string());
    }
    let one = match show {
        Some("last") | None => None,
        Some(id) => Some(id),
    };
    let found = scoped_lookup(data_folder, one, None, Some(session))?;
    if found.is_empty() {
        return Err(match one {
            Some(id) => format!("no request {id} is recorded for session {session}"),
            None => format!("no requests are recorded for session {session}"),
        });
    }
    if show.is_some() {
        // `last` is the newest record; an id matched exactly one.
        return Ok(found.last().map(|s| s.render_text()).unwrap_or_default());
    }
    let mut out = format!("{} request(s) for session {session}\n", found.len());
    for s in &found {
        let _ = writeln!(
            out,
            "{}  {}  {:?}  {}  {} message(s)  {}",
            s.id,
            s.at,
            s.kind,
            if s.model.is_empty() { "unknown" } else { &s.model },
            s.message_count(),
            s.hash
        );
    }
    Ok(out)
}

/// `jan auth` handler: report sign-in state or sign out.
async fn handle_auth(cmd: AuthCommands) -> Result<(), String> {
    use app_lib::core::cli::tokamak;
    match cmd {
        AuthCommands::Status => {
            let status = tokamak::auth_status();
            if !status.signed_in {
                println!("Not signed in to Tokamak. Run `flint login`.");
                return Ok(());
            }
            println!("Signed in to Tokamak");
            match &status.account {
                Some(account) => println!("  account:      {account}"),
                // A legacy paste login never learns the account; that is not the
                // same as failing to look one up.
                None => println!("  account:      not recorded"),
            }
            println!("  endpoint:     {}", status.endpoint);
            if let Some(key_id) = &status.key_id {
                println!("  key id:       {key_id}");
            }
            match status.key_expires_at {
                Some(ts) if ts != 0 => println!("  key expires:  {}", format_ts(ts)),
                // A legacy paste login records no expiry; that is not the same
                // as a key that never expires, so don't claim it does.
                _ => println!("  key expires:  not recorded"),
            }
            match tokamak::live_valid().await {
                Some(true) => println!("  valid:        yes"),
                Some(false) => println!("  valid:        no (re-run `flint login`)"),
                None => println!("  valid:        could not reach upstream"),
            }
            if let Some(warning) = tokamak::expiry_warning() {
                println!();
                println!("Warning: {warning}");
            }
            Ok(())
        }
        AuthCommands::Logout => {
            match tokamak::logout().await? {
                tokamak::Logout::ClearedAndRevoked => {
                    println!("Signed out of Tokamak (key revoked).")
                }
                tokamak::Logout::ClearedOnly => println!(
                    "Signed out of Tokamak locally. The key could not be revoked upstream - \
                     remove it at {}",
                    tokamak::API_KEYS_URL
                ),
                tokamak::Logout::NothingToDo => println!("Not signed in to Tokamak."),
            }
            Ok(())
        }
    }
}

/// Render a unix timestamp as a UTC date/time for `auth status`.
fn format_ts(ts: u64) -> String {
    let secs = i64::try_from(ts).unwrap_or(0);
    match chrono::DateTime::from_timestamp(secs, 0) {
        Some(dt) => dt.format("%Y-%m-%d %H:%M UTC").to_string(),
        None => format!("unix {ts}"),
    }
}

fn handle_agent_config(cmd: AgentConfigCommands) -> Result<(), String> {
    match cmd {
        AgentConfigCommands::Set {
            provider,
            api_key,
            base_url,
            models,
            api_type,
        } => {
            let models = (!models.is_empty()).then_some(models);
            let path = cli_agent_config_set(&provider, api_key, base_url, models, api_type)?;
            println!("Updated provider '{provider}' in {}", path.display());
            Ok(())
        }
        AgentConfigCommands::Unset { provider } => {
            if cli_agent_config_unset(&provider)? {
                println!("Removed provider '{provider}'");
            } else {
                println!("Provider '{provider}' was not configured");
            }
            Ok(())
        }
        AgentConfigCommands::List => {
            let list = cli_agent_config_list()?;
            println!("{}", serde_json::to_string_pretty(&list).unwrap());
            Ok(())
        }
        AgentConfigCommands::Path => {
            let path = cli_agent_config_path()?;
            println!("{}", path.display());
            Ok(())
        }
    }
}

// ── Threads handlers ───────────────────────────────────────────────────────

fn print_or_exit(result: Result<serde_json::Value, String>) {
    match result {
        Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default()),
        Err(e) => {
            eprintln!("Error: {e}");
            std::process::exit(1);
        }
    }
}

fn exit_on_error(result: Result<(), String>) {
    if let Err(e) = result {
        eprintln!("Error: {e}");
        std::process::exit(1);
    }
}

fn handle_worktree(cmd: WorktreeCommands) {
    use app_lib::core::cli::worktree_cmd as w;
    exit_on_error(match cmd {
        WorktreeCommands::List { project, json } => w::list(&project, json),
        WorktreeCommands::Merge { id, project, into, message } => {
            w::merge(&project, &id, into.as_deref(), message.as_deref())
        }
        WorktreeCommands::Discard { id, project, force } => w::discard(&project, &id, force),
    });
}

async fn handle_import_claude(cmd: ImportClaudeCommands) {
    use app_lib::core::cli::cc_import_cmd as c;
    exit_on_error(match cmd {
        ImportClaudeCommands::Scan { root } => c::scan(root).await,
        ImportClaudeCommands::Run { root, names, all, overwrite, link_hooks } => {
            c::run(root, &names, all, overwrite, link_hooks).await
        }
    });
}

fn handle_approvals(cmd: ApprovalsCommands) {
    use app_lib::core::cli::approvals_cmd as a;
    exit_on_error(match cmd {
        ApprovalsCommands::List { project, all, json } => a::list(project.as_deref(), all, json),
        ApprovalsCommands::Allow { id } => a::answer(&id, true),
        ApprovalsCommands::Deny { id } => a::answer(&id, false),
        ApprovalsCommands::Discard { id } => a::discard(&id),
        ApprovalsCommands::Rules { project, json } => a::rules(project.as_deref(), json),
        ApprovalsCommands::Revoke { id } => a::revoke(&id),
    });
}

fn handle_memory(cmd: MemoryCommands) {
    use app_lib::core::cli::memory_cmd as m;
    exit_on_error(match cmd {
        MemoryCommands::List { scope, query, offset, limit, place } => {
            m::list(&place.project, place.session.as_deref(), &scope, query.as_deref(), offset, limit)
        }
        MemoryCommands::Show { scope, id, place } => m::show(&place.project, place.session.as_deref(), &scope, &id),
        MemoryCommands::Forget { scope, id, place } => m::forget(&place.project, place.session.as_deref(), &scope, &id),
        MemoryCommands::Clear { scope, yes, place } => m::clear(&place.project, place.session.as_deref(), &scope, yes),
        MemoryCommands::Pin { scope, id, place } => m::pin(&place.project, place.session.as_deref(), &scope, &id, true),
        MemoryCommands::Unpin { scope, id, place } => m::pin(&place.project, place.session.as_deref(), &scope, &id, false),
        MemoryCommands::Audit { json, stale_days, project } => m::audit(&project, json, stale_days),
        MemoryCommands::Export { scope, path, place } => m::export(&place.project, place.session.as_deref(), &scope, &path),
    });
}

async fn handle_skills(cmd: SkillsCommands) {
    use app_lib::core::cli::skills_cmd as k;
    exit_on_error(match cmd {
        SkillsCommands::List { project, json } => k::list(&project, json),
        SkillsCommands::Show { name, project } => k::show(&project, &name),
        SkillsCommands::Write { name, file, project } => {
            let content = if file == "-" {
                let mut buf = String::new();
                std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf)
                    .map(|_| buf)
                    .map_err(|e| e.to_string())
            } else {
                std::fs::read_to_string(&file).map_err(|e| format!("read {file}: {e}"))
            };
            content.and_then(|c| k::write(&project, &name, &c))
        }
        SkillsCommands::Delete { name, project } => k::delete(&project, &name),
        SkillsCommands::Enabled { names, all, project } => k::enabled(&project, &names, all),
        SkillsCommands::HubList { json } => k::hub_list(json).await,
        SkillsCommands::HubImport { name, project } => k::hub_import(&project, &name).await,
    });
}

async fn handle_archive(cmd: ArchiveCommands) {
    use app_lib::core::cli::archive_cmd as a;
    exit_on_error(match cmd {
        ArchiveCommands::List { kind, json } => a::list(kind.as_deref(), json),
        ArchiveCommands::Restore { kind, archive_id } => a::restore(&kind, &archive_id),
        ArchiveCommands::Purge { kind, archive_id, yes } => a::purge(&kind, &archive_id, yes),
        ArchiveCommands::Empty { kind, yes } => a::empty(kind.as_deref(), yes),
        ArchiveCommands::Settings { enabled, auto_delete_days, auto_archive_days } => {
            a::settings(enabled, auto_delete_days, auto_archive_days)
        }
    });
}

async fn handle_threads(cmd: ThreadsCommands) {
    match cmd {
        ThreadsCommands::List => match cli_list_threads().await {
            Ok(threads) => {
                println!("{}", serde_json::to_string_pretty(&threads).unwrap());
            }
            Err(e) => {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        },

        ThreadsCommands::Get { id } => match cli_get_thread(&id) {
            Ok(thread) => println!("{}", serde_json::to_string_pretty(&thread).unwrap()),
            Err(e) => {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        },

        ThreadsCommands::Delete { id, permanent, yes } => {
            if permanent && !yes {
                eprintln!("Error: --permanent cannot be undone; run again with --yes");
                std::process::exit(1);
            }
            match app_lib::core::cli::archive_cmd::delete_thread(&id, permanent).await {
                Ok(archived) => {
                    println!("{}", serde_json::json!({ "deleted": true, "archived": archived, "id": id }))
                }
                Err(e) => {
                    eprintln!("Error: {e}");
                    std::process::exit(1);
                }
            }
        }
        ThreadsCommands::Create { title } => {
            print_or_exit(app_lib::core::cli::archive_cmd::create_thread(title.as_deref()))
        }
        ThreadsCommands::Rename { id, title } => {
            print_or_exit(app_lib::core::cli::archive_cmd::rename_thread(&id, &title))
        }
        ThreadsCommands::Favorite { id } => {
            print_or_exit(app_lib::core::cli::archive_cmd::favorite_thread(&id, true))
        }
        ThreadsCommands::Unfavorite { id } => {
            print_or_exit(app_lib::core::cli::archive_cmd::favorite_thread(&id, false))
        }
        ThreadsCommands::Export { id, format, verbose, all_versions, out, project } => {
            let result = app_lib::core::cli::thread_export::Format::parse(&format).and_then(|f| {
                app_lib::core::cli::thread_export::export_thread(
                    &match project.as_deref() {
                        Some(p) => app_lib::core::cli::agent_dir_for(std::path::Path::new(p)),
                        None => app_lib::core::app::commands::resolve_jan_data_folder(),
                    },
                    &id,
                    f,
                    verbose,
                    all_versions,
                    out.as_deref().map(std::path::Path::new),
                )
            });
            match result {
                Ok(Some(path)) => eprintln!("Wrote {}", path.display()),
                Ok(None) => {}
                Err(e) => {
                    eprintln!("Error: {e}");
                    std::process::exit(1);
                }
            }
        }
        ThreadsCommands::DeleteMessage { thread_id, message_id } => {
            match app_lib::core::cli::archive_cmd::delete_message(&thread_id, &message_id).await {
                Ok(()) => println!("{}", serde_json::json!({ "deleted": true, "id": message_id })),
                Err(e) => {
                    eprintln!("Error: {e}");
                    std::process::exit(1);
                }
            }
        }

        ThreadsCommands::Messages {
            thread_id,
            all_versions,
        } => match cli_list_messages(&thread_id, all_versions) {
            Ok(messages) => println!("{}", serde_json::to_string_pretty(&messages).unwrap()),
            Err(e) => {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        },
    }
}

// ── Models handlers ────────────────────────────────────────────────────────

async fn handle_models(cmd: ModelsCommands) {
    match cmd {
        ModelsCommands::List { provider, project, filter } => {
            let configs = match load_provider_configs(
                Some(std::path::Path::new(&project)),
                &ProviderOverrides::default().with_env(),
            ) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Error: {e}");
                    std::process::exit(1);
                }
            };
            use app_lib::core::cli::providers::{
                find_provider, model_listing, probe_providers, REACHABILITY_TIMEOUT,
            };
            if let Some(p) = provider.as_deref() {
                if find_provider(&configs, p).is_none() {
                    eprintln!("Error: unknown provider '{p}'");
                    std::process::exit(1);
                }
            }
            // Probe each server rather than trusting a configured base_url: a
            // provider whose server is down is not reachable, whatever its
            // config says.
            let probed = probe_providers(&configs, REACHABILITY_TIMEOUT).await;
            let output = model_listing(&configs, provider.as_deref(), &probed);
            if !output.is_empty()
                && output.iter().all(|m| m["reachable"] == false && m["base_url"].is_null())
            {
                eprintln!(
                    "None of these models is reachable from the CLI: they run inside the \
                     Jan app. Enable the app's Local API Server and point the CLI at it:\n  \
                     flint config set --provider jan --base-url http://localhost:1337/v1 --model <model>"
                );
            }
            let output: Vec<_> = match filter.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
                // Every word must appear somewhere in the entry, so a long
                // remote list narrows the way the app's model search does.
                Some(f) => {
                    let terms: Vec<String> = f.split_whitespace().map(str::to_lowercase).collect();
                    output
                        .into_iter()
                        .filter(|m| {
                            let hay = m.to_string().to_lowercase();
                            terms.iter().all(|t| hay.contains(t))
                        })
                        .collect()
                }
                None => output,
            };
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
        }
        ModelsCommands::Search { query, format } => {
            match app_lib::core::cli::hf_cmd::search(&query, &format).await {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default()),
                Err(e) => {
                    eprintln!("Error: {e}");
                    std::process::exit(1);
                }
            }
        }
        ModelsCommands::Files { repo } => match app_lib::core::cli::hf_cmd::files(&repo).await {
            Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default()),
            Err(e) => {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        },
        ModelsCommands::Download { repo, file } => {
            let data = app_lib::core::app::commands::resolve_jan_data_folder();
            match app_lib::core::cli::hf_cmd::download(&data, &repo, &file, false).await {
                Ok(path) => println!("{}", serde_json::json!({ "path": path })),
                Err(e) => {
                    eprintln!("Error: {e}");
                    std::process::exit(1);
                }
            }
        }
        ModelsCommands::Import { file, id } => {
            let data = app_lib::core::app::commands::resolve_jan_data_folder();
            match app_lib::core::cli::hf_cmd::import(&data, std::path::Path::new(&file), &id) {
                Ok(path) => println!("{}", serde_json::json!({ "imported": id, "path": path })),
                Err(e) => {
                    eprintln!("Error: {e}");
                    std::process::exit(1);
                }
            }
        }
        ModelsCommands::ListLocal { json } => handle_models_list_local(json),
        ModelsCommands::Info { path, json } => handle_models_info(&path, json),
        ModelsCommands::Delete { id, yes } => handle_models_delete(&id, yes),
    }
}

fn models_dir() -> std::path::PathBuf {
    app_lib::core::app::commands::resolve_jan_data_folder()
        .join("llamacpp")
        .join("models")
}

fn handle_models_list_local(json: bool) {
    let dir = models_dir();
    if !dir.is_dir() {
        if json {
            println!("[]");
        } else {
            eprintln!("No local models directory: {}", dir.display());
        }
        return;
    }
    let Ok(readdir) = std::fs::read_dir(&dir) else {
        eprintln!("Error: cannot read {}", dir.display());
        std::process::exit(1);
    };
    let mut entries: Vec<serde_json::Value> = Vec::new();
    for entry in readdir.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let gguf = path.join("model.gguf");
        let (size_bytes, modified) = if gguf.is_file() {
            let meta = std::fs::metadata(&gguf).ok();
            (
                meta.as_ref().map(|m| m.len()),
                meta.and_then(|m| m.modified().ok()).map(|t| {
                    chrono::DateTime::<chrono::Utc>::from(t)
                        .format("%Y-%m-%d %H:%M:%S")
                        .to_string()
                }),
            )
        } else {
            (None, None)
        };
        entries.push(serde_json::json!({
            "id": id,
            "path": path.to_string_lossy(),
            "has_gguf": gguf.is_file(),
            "size_bytes": size_bytes,
            "modified": modified,
        }));
    }
    entries.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));

    if json {
        println!("{}", serde_json::to_string_pretty(&entries).unwrap());
    } else if entries.is_empty() {
        println!("No local models found in {}", dir.display());
    } else {
        let bold = Style::new().bold();
        println!("{}", bold.apply_to("Local models:"));
        for e in &entries {
            let id = e["id"].as_str().unwrap_or("?");
            let size = e["size_bytes"]
                .as_u64()
                .map(|b| format!("{:.1} GB", b as f64 / 1_073_741_824.0))
                .unwrap_or_else(|| "no .gguf".into());
            let modified = e["modified"].as_str().unwrap_or("-");
            println!("  {id}  ({size}, {modified})");
        }
    }
}

fn handle_models_info(path_or_id: &str, json: bool) {
    let path = if path_or_id.contains('/')
        || path_or_id.contains('\\')
        || path_or_id.ends_with(".gguf")
    {
        std::path::PathBuf::from(path_or_id)
    } else {
        models_dir().join(path_or_id)
    };

    if !path.exists() {
        eprintln!("Error: not found: {}", path.display());
        std::process::exit(1);
    }

    let gguf = if path.is_dir() {
        path.join("model.gguf")
    } else {
        path.clone()
    };

    let meta = std::fs::metadata(&gguf).ok();
    let info = serde_json::json!({
        "path": path.to_string_lossy(),
        "gguf_path": gguf.to_string_lossy(),
        "exists": gguf.is_file(),
        "size_bytes": meta.as_ref().map(|m| m.len()),
        "modified": meta.and_then(|m| m.modified().ok())
            .map(|t| chrono::DateTime::<chrono::Utc>::from(t).format("%Y-%m-%d %H:%M:%S").to_string()),
    });

    if json {
        println!("{}", serde_json::to_string_pretty(&info).unwrap());
    } else {
        println!("Path:     {}", info["path"].as_str().unwrap_or("?"));
        println!(
            "GGUF:     {}",
            if gguf.is_file() { "present" } else { "missing" }
        );
        if let Some(size) = info["size_bytes"].as_u64() {
            println!("Size:     {:.1} GB", size as f64 / 1_073_741_824.0);
        }
        if let Some(modified) = info["modified"].as_str() {
            println!("Modified: {modified}");
        }
    }
}

/// Whether `id` names a direct child of the models folder: one plain path
/// component, so `..`, separators or an absolute path cannot reach outside it.
fn is_model_dir_name(id: &str) -> bool {
    let mut parts = std::path::Path::new(id).components();
    matches!(
        (parts.next(), parts.next()),
        (Some(std::path::Component::Normal(_)), None)
    ) && !id.contains(['/', '\\', ':'])
}

fn handle_models_delete(id: &str, yes: bool) {
    if !is_model_dir_name(id) {
        eprintln!("Error: '{id}' is not a model id (expected a name from `models list`)");
        std::process::exit(1);
    }
    let dir = models_dir().join(id);
    if !dir.is_dir() {
        eprintln!("Error: model directory not found: {}", dir.display());
        std::process::exit(1);
    }
    if !yes {
        eprint!("Delete model '{}' at {}? [y/N] ", id, dir.display());
        let mut answer = String::new();
        std::io::stdin().read_line(&mut answer).ok();
        if !answer.trim().eq_ignore_ascii_case("y") {
            println!("Aborted.");
            return;
        }
    }
    if let Err(e) = std::fs::remove_dir_all(&dir) {
        eprintln!("Error deleting {}: {e}", dir.display());
        std::process::exit(1);
    }
    println!("Deleted model '{id}'.");
}

// ── Doctor handler ──────────────────────────────────────────────────────

fn handle_doctor(json: bool) {
    let info = tauri_plugin_hardware::get_system_info();
    // A mistyped rule is dropped when the policy loads, so a `deny` typo
    // silently removes the protection it was written for. Doctor says so.
    let root = std::env::current_dir().unwrap_or_default();
    let rule_warnings = app_lib::core::agent::project::policy_rule_warnings(&root);
    if json {
        let mut value = serde_json::to_value(&info).unwrap();
        if let Some(map) = value.as_object_mut() {
            map.insert(
                "permission_rule_warnings".into(),
                serde_json::to_value(&rule_warnings).unwrap(),
            );
        }
        println!("{}", serde_json::to_string_pretty(&value).unwrap());
    } else {
        let bold = Style::new().bold();
        println!("{}", bold.apply_to("System Information"));
        println!("  OS:     {} ({})", info.os_name, info.os_type);
        println!(
            "  CPU:    {} ({} cores, {})",
            info.cpu.name, info.cpu.core_count, info.cpu.arch
        );
        if !info.cpu.extensions.is_empty() {
            println!("  ISA:    {}", info.cpu.extensions.join(", "));
        }
        println!("  Memory: {} MiB", info.total_memory);
        if info.gpus.is_empty() {
            println!("  GPUs:   none detected");
        } else {
            println!("{}", bold.apply_to("GPUs"));
            for gpu in &info.gpus {
                let vram = if gpu.total_memory > 0 {
                    format!("{} MiB", gpu.total_memory)
                } else {
                    "unknown".into()
                };
                println!(
                    "  {} ({:?}, VRAM {}, driver {})",
                    gpu.name, gpu.vendor, vram, gpu.driver_version
                );
            }
        }
        let bold_warn = Style::new().bold().yellow();
        if rule_warnings.is_empty() {
            println!("{}", bold.apply_to("Permission rules"));
            println!("  no problems found in agent.toml");
        } else {
            println!("{}", bold_warn.apply_to("Permission rules: PROBLEMS"));
            for w in &rule_warnings {
                println!(
                    "  [{}] `{}`: {}{}",
                    w.list,
                    w.rule,
                    w.reason,
                    if w.weakens_restriction() {
                        " (this restriction is NOT in effect as written)"
                    } else {
                        ""
                    }
                );
            }
        }
    }
}

/// Render one server entry for `list`: transport summary plus (redacted by
/// default) env/header keys. Secret values are masked unless `--show-secrets`.
fn mcp_list_entry(entry: &McpServerEntry, show_secrets: bool) -> serde_json::Value {
    let cfg = &entry.config;
    let transport_type = cfg.get("type").and_then(serde_json::Value::as_str);
    let redact = |v: &serde_json::Value| -> serde_json::Value {
        if show_secrets {
            v.clone()
        } else {
            serde_json::Value::String("<redacted>".to_string())
        }
    };
    let redact_map = |m: Option<&serde_json::Map<String, serde_json::Value>>| -> serde_json::Value {
        match m {
            Some(map) => {
                let out: serde_json::Map<String, serde_json::Value> =
                    map.iter().map(|(k, v)| (k.clone(), redact(v))).collect();
                serde_json::Value::Object(out)
            }
            None => serde_json::json!({}),
        }
    };
    serde_json::json!({
        "name": entry.name,
        "active": entry.active,
        "type": transport_type.unwrap_or("stdio"),
        "command": cfg.get("command").and_then(serde_json::Value::as_str).unwrap_or(""),
        "args": cfg.get("args").cloned().unwrap_or_else(|| serde_json::json!([])),
        "url": cfg.get("url").cloned().unwrap_or(serde_json::Value::Null),
        "env": redact_map(cfg.get("env").and_then(serde_json::Value::as_object)),
        "headers": redact_map(cfg.get("headers").and_then(serde_json::Value::as_object)),
        // The OAuth scopes a sign-in asks for (AH-135). Not a secret, and the
        // authority the server's token will carry, so it is never redacted.
        "oauth": cfg.get("oauth").cloned().unwrap_or(serde_json::Value::Null),
    })
}

/// Manage MCP servers in mcp_config.json.
async fn handle_mcp(cmd: McpCommands) -> Result<(), String> {
    match cmd {
        McpCommands::List { show_secrets } => {
            let servers = mcp::list_servers();
            let out: Vec<serde_json::Value> = servers
                .iter()
                .map(|s| mcp_list_entry(s, show_secrets))
                .collect();
            println!("{}", serde_json::to_string_pretty(&out).unwrap());
            Ok(())
        }
        McpCommands::Get { name } => match mcp::get_server(&name) {
            Some(entry) => {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&mcp_list_entry(&entry, true)).unwrap()
                );
                Ok(())
            }
            None => Err(format!("server '{name}' not found")),
        },
        McpCommands::Add {
            name,
            command,
            args,
            env,
            r#type,
            url,
            header,
            scope,
            active,
        } => {
            let config = build_mcp_config(command, args, env, &r#type, url, header, active, scope)?;
            mcp::upsert_server(&name, &config)?;
            println!("saved server '{name}' to mcp_config.json");
            Ok(())
        }
        McpCommands::AuthStatus { name } => {
            let entry = app_lib::core::cli::mcp::get_server(&name)
                .ok_or_else(|| format!("no MCP server named '{name}'"))?;
            let info = app_lib::core::cli::mcp::auth_status_info(&name, &entry.config);
            println!("{}", serde_json::to_string_pretty(&info).unwrap_or_default());
            Ok(())
        }
        McpCommands::Auth { name } => {
            let pending = app_lib::core::cli::mcp::begin_auth(&name).await?;
            eprintln!(
                "Signing in to '{name}'. Asking for scopes: {}",
                if pending.scopes.is_empty() { "(none declared)".to_string() } else { pending.scopes.join(" ") }
            );
            eprintln!("Open this address to consent; waiting for the redirect to {}", pending.redirect_uri);
            println!("{}", pending.authorization_url);
            let creds = app_lib::core::cli::mcp::finish_auth(pending).await?;
            eprintln!(
                "Signed in to '{name}'. Granted scopes: {}",
                if creds.granted_scopes.is_empty() { "(none)".to_string() } else { creds.granted_scopes.join(" ") }
            );
            Ok(())
        }
        McpCommands::AuthClear { name } => {
            if app_lib::core::cli::mcp::clear_auth(&name)? {
                println!("Forgot the stored tokens for '{name}'");
            } else {
                println!("No tokens were stored for '{name}'");
            }
            Ok(())
        }
        McpCommands::Tools { name } => {
            let Some(entry) = mcp::get_server(&name) else {
                return Err(format!("no server named '{name}'"));
            };
            let servers: app_lib::core::state::SharedMcpServers = Default::default();
            mcp::connect(&name, &entry.config, &servers)
                .await
                .map_err(|e| e.to_string())?;
            let listed = mcp::list_tools(&name, &servers).await;
            mcp::disconnect(&name, &servers).await;
            let listed = listed?;
            if listed.is_empty() {
                println!("'{name}' offers no tools");
            }
            for line in listed {
                println!("{line}");
            }
            Ok(())
        }
        McpCommands::TrustReport { json } => {
            let data = app_lib::core::app::commands::resolve_jan_data_folder();
            let (rows, invalidated) = mcp::trust_report(&data);
            if json {
                let inv: Vec<_> = invalidated
                    .iter()
                    .map(|(n, r, a)| serde_json::json!({ "name": n, "reason": r, "at": a }))
                    .collect();
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({ "trusted": rows, "invalidated": inv }))
                        .unwrap_or_default()
                );
            } else {
                if rows.is_empty() {
                    println!("No standing grants.");
                }
                for r in &rows {
                    println!("{:<24} {:<8} since {}", r.name, r.state, r.granted_at);
                }
                for (n, reason, at) in &invalidated {
                    println!("{n:<24} needs renewing ({reason}) at {at}");
                }
            }
            Ok(())
        }
        McpCommands::Trust { name, yes } => {
            if !yes {
                return Err(format!(
                    "this lets '{name}' run its tools without asking, in every conversation, until revoked; run again with --yes"
                ));
            }
            let data = app_lib::core::app::commands::resolve_jan_data_folder();
            mcp::trust_server(&data, &name).map(|fp| println!("Trusted {name} (definition {fp})"))
        }
        McpCommands::Revoke { name } => {
            let data = app_lib::core::app::commands::resolve_jan_data_folder();
            mcp::revoke_server(&data, &name).map(|removed| {
                println!("{}", if removed { "Trust withdrawn." } else { "There was no grant." })
            })
        }
        McpCommands::Logs { name, lines } => {
            let found = app_lib::core::mcp::server_log::tail(
                &app_lib::core::app::commands::resolve_jan_data_folder(),
                &name,
                lines,
            );
            if found.is_empty() {
                println!("'{name}' has not printed anything");
            }
            for line in found {
                println!("{line}");
            }
            Ok(())
        }
        McpCommands::Prompts { name } => {
            let Some(entry) = mcp::get_server(&name) else {
                return Err(format!("no server named '{name}'"));
            };
            let servers: app_lib::core::state::SharedMcpServers = Default::default();
            mcp::connect(&name, &entry.config, &servers)
                .await
                .map_err(|e| e.to_string())?;
            let listed = mcp::list_prompts(&name, &servers).await;
            mcp::disconnect(&name, &servers).await;
            let listed = listed?;
            if listed.is_empty() {
                println!("'{name}' offers no prompts");
            }
            for line in listed {
                println!("{line}");
            }
            Ok(())
        }
        McpCommands::Prompt { name, prompt, args } => {
            let Some(entry) = mcp::get_server(&name) else {
                return Err(format!("no server named '{name}'"));
            };
            let mut arguments = serde_json::Map::new();
            for kv in &args {
                let (k, v) = split_kv(kv, "arg")?;
                arguments.insert(k, serde_json::json!(v));
            }
            let servers: app_lib::core::state::SharedMcpServers = Default::default();
            mcp::connect(&name, &entry.config, &servers)
                .await
                .map_err(|e| e.to_string())?;
            let fetched = mcp::get_prompt(&name, &prompt, arguments, &servers).await;
            mcp::disconnect(&name, &servers).await;
            print!("{}", fetched?);
            Ok(())
        }
        McpCommands::Remove { name } => {
            mcp::remove_server(&name)?;
            println!("removed server '{name}' from mcp_config.json");
            Ok(())
        }
        McpCommands::Enable { name } => {
            mcp::set_active(&name, true)?;
            println!("enabled server '{name}'");
            Ok(())
        }
        McpCommands::Disable { name } => {
            mcp::set_active(&name, false)?;
            println!("disabled server '{name}'");
            Ok(())
        }
    }
}

/// Build the server config object for `mcp add` from the CLI flags. Funnels
/// through the shared `core::cli::mcp::build_server_config` so the TUI form and
/// the headless flags can never diverge on the config shape or validation.
// One argument per `mcp add` flag, as clap hands them over.
#[allow(clippy::too_many_arguments)]
fn build_mcp_config(
    command: Option<String>,
    args: Vec<String>,
    env: Vec<String>,
    r#type: &str,
    url: Option<String>,
    header: Vec<String>,
    active: bool,
    scopes: Vec<String>,
) -> Result<serde_json::Value, String> {
    let mut env_map = serde_json::Map::new();
    for kv in &env {
        let (k, v) = split_kv(kv, "env")?;
        env_map.insert(k, serde_json::json!(v));
    }
    let mut header_map = serde_json::Map::new();
    for kv in &header {
        let (k, v) = split_kv(kv, "header")?;
        header_map.insert(k, serde_json::json!(v));
    }
    mcp::build_server_config(
        r#type,
        command.as_deref(),
        args,
        env_map,
        url.as_deref(),
        header_map,
        active,
        scopes,
    )
}

#[cfg(test)]
#[path = "flint/tests.rs"]
mod tests;
