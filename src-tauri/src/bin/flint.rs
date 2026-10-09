//! jan — headless CLI for Flint.
//!
//! Shares the Tauri-free core logic with the Flint desktop app; talks only to
//! remote providers (no local inference, no GUI dependencies).
//! Build with: cargo build --no-default-features --features cli --bin jan

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
    cli_plugin_remove, cli_plugin_search, ResumeRequest, SessionFlags,
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
    /// Log more: `info` on stderr instead of `warn`. Accepted before or after
    /// any subcommand. The logger reads it from the raw arguments before this
    /// parser runs; declaring it here keeps clap from rejecting it.
    #[arg(long, short = 'v', global = true)]
    verbose: bool,
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
        #[arg(long)]
        token: Option<String>,
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
    Delete { id: String },
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
    /// API key for the target provider (else JAN_API_KEY / <PROVIDER>_API_KEY)
    #[arg(long)]
    api_key: Option<String>,
}

impl ProviderArgs {
    fn into_overrides(self) -> ProviderOverrides {
        // Default the target provider to the desktop app's current selection so
        // env-key fallback (<PROVIDER>_API_KEY) works without an explicit flag.
        let pin = self.provider.is_some();
        let provider = self
            .provider
            .or_else(|| app_lib::core::cli::providers::desktop_selection().provider);
        ProviderOverrides {
            provider,
            api_key: self.api_key,
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
    /// List the exact requests a session sent to the model, or print one as
    /// text (what the model saw: every message, tool call and tool offered)
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
    Prompts {
        /// The session whose requests to list
        session: String,
        /// Print one request in full: a snapshot id, or `last`
        #[arg(long)]
        show: Option<String>,
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
        #[arg(long)]
        token: String,
        /// A line the host shell runs
        #[arg(long, conflicts_with = "argv_json")]
        command: Option<String>,
        /// Arguments for this program, as a JSON array (never a shell line)
        #[arg(long)]
        argv_json: Option<String>,
    },
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
                plan: mode_switches.1,
                sandbox: cli.sandbox.into_flag(),
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
        Commands::Serve { listen, assets_dir, data_dir, public_host, allow_mcp_stdio, allowed_hosts, allowed_origins, llama_worker, background, credential_file } => {
            if let Some(data_dir) = data_dir {
                std::env::set_var("JAN_DATA_FOLDER", data_dir);
            }
            let assets = assets_dir.unwrap_or_else(|| {
                std::env::current_exe()
                    .ok()
                    .and_then(|exe| exe.parent().map(|dir| dir.join("web")))
                    .unwrap_or_else(|| std::path::PathBuf::from("web"))
            });
            let data_folder = app_lib::core::app::commands::resolve_jan_data_folder();
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
                    allowed_hosts,
                    allowed_origins,
                    llama_worker,
                    credential_file,
                },
            ).await {
                eprintln!("Error: {error}");
                std::process::exit(1);
            }
        }
        Commands::Stop { data_dir } => {
            if let Some(data_dir) = data_dir {
                std::env::set_var("JAN_DATA_FOLDER", data_dir);
            }
            let data_folder = app_lib::core::app::commands::resolve_jan_data_folder();
            match app_lib::core::web_server::control::stop(&data_folder, std::time::Duration::from_secs(20)) {
                Ok(app_lib::core::web_server::control::Stopped::Clean) => println!("Flint server stopped."),
                Ok(app_lib::core::web_server::control::Stopped::Forced) => {
                    println!("Flint server did not stop when asked, so its process was ended.")
                }
                Ok(app_lib::core::web_server::control::Stopped::NotRunning) => {
                    println!("No Flint server is running on {}.", data_folder.display())
                }
                Err(error) => {
                    eprintln!("Error: {error}");
                    std::process::exit(1);
                }
            }
        }
        Commands::Cli { cmd } => handle_cli(cmd).await,
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
        Commands::BugReport {
            thread,
            show,
            yes,
            out,
        } => handle_bug_report(thread, show, yes, out),
        Commands::Doctor { json } => handle_doctor(json),
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
    } = cmd;
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

async fn handle_cli(cmd: CliCommands) {
    match cmd {
        CliCommands::Job { cmd } => handle_job(cmd),
        CliCommands::Threads { cmd } => handle_threads(cmd).await,
        CliCommands::Archive { cmd } => handle_archive(cmd).await,
        CliCommands::Skills { cmd } => handle_skills(cmd).await,
        CliCommands::Worktree { cmd } => handle_worktree(cmd),
        CliCommands::Models { cmd } => handle_models(cmd).await,
        CliCommands::Agent { cmd } => handle_agent(cmd).await,
        CliCommands::Mcp { cmd } => {
            if let Err(e) = handle_mcp(cmd).await {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }
        CliCommands::Net { cmd } => handle_net(cmd),
        CliCommands::Bench { cmd } => handle_bench(cmd),
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
                ScheduleCommands::Delete { id } => schedule_manage::delete(&id),
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
                &mut |t| eprintln!("  {:<24} {:<14} {:>6} ms  {}", t.id, t.state, t.duration_ms, t.notes.first().map(String::as_str).unwrap_or("")),
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
    let NetCommands::Ca { cmd } = cmd;
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
        } => match (command, argv_json) {
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
            }),
    };
    if let Err(e) = result {
        eprintln!("Error [{}]: {}", e.kind().tag(), e.message());
        std::process::exit(e.exit_code());
    }
}

async fn handle_agent(cmd: AgentCommands) {
    let result = match cmd {
        AgentCommands::Run {
            project,
            task,
            model,
            safe,
            mode,
            providers,
            sandbox,
            budget,
            worktree,
            resume,
            output_format,
            input_format,
            host_tools,
            host_gate,
            events,
            profile,
            output_density,
        } => {
            // AH-183: before the run, so a destination that cannot be written
            // fails the command instead of silently streaming nowhere.
            if let Some(destination) = events.as_deref() {
                if let Err(e) = app_lib::core::cli::stream_events_to(destination) {
                    eprintln!("Error [{}]: {}", e.kind().tag(), e.message());
                    std::process::exit(e.exit_code());
                }
            }
            let mode_switches =
                match app_lib::core::cli::PermissionMode::resolve(mode.as_deref(), safe, false) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("Error: {e}");
                        std::process::exit(2);
                    }
                };
            cli_agent_run(
                &project,
                &task,
                model,
                providers.into_overrides(),
                SessionFlags {
                    auto_approve: mode_switches.0,
                    plan: mode_switches.1,
                    sandbox: sandbox.into_flag(),
                    worktree: worktree.into_flag(),
                    profile,
                    density: match output_density
                        .as_deref()
                        .map(app_lib::core::cli::Density::parse)
                    {
                        Some(Ok(density)) => Some(density),
                        Some(Err(e)) => {
                            let refusal = HarnessError::new(
                                tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
                                e,
                            );
                            eprintln!(
                                "Error [{}]: {}",
                                refusal.kind().tag(),
                                refusal.message()
                            );
                            std::process::exit(refusal.exit_code());
                        }
                        None => None,
                    },
                    interrupted: resume.interrupted,
                    max_turns: budget.max_turns,
                    max_session_tokens: budget.max_session_tokens,
                    max_budget_usd: budget.max_budget_usd,
                    ..Default::default()
                },
                resume.into_request(),
                output_format,
                input_format,
                host_tools.as_deref(),
                host_gate,
            )
            .await
        }
        AgentCommands::RunSubagent { spec } => {
            app_lib::core::cli::run_durable_subagent(std::path::Path::new(&spec)).await
        }
        AgentCommands::Serve => {
            app_lib::core::cli::json_api::serve_stdio().await;
            Ok(())
        }
        AgentCommands::Step {
            project,
            task,
            model,
            safe,
            mode,
            providers,
            sandbox,
            profile,
        } => {
            let mode_switches =
                match app_lib::core::cli::PermissionMode::resolve(mode.as_deref(), safe, false) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("Error: {e}");
                        std::process::exit(2);
                    }
                };
            cli_agent_step(
                &project,
                &task,
                model,
                providers.into_overrides(),
                SessionFlags {
                    auto_approve: mode_switches.0,
                    plan: mode_switches.1,
                    sandbox: sandbox.into_flag(),
                    profile,
                    ..Default::default()
                },
            )
            .await
        }
        AgentCommands::Tree { session, json } => {
            let data = app_lib::core::app::commands::resolve_jan_data_folder();
            tauri_plugin_agent_tools::run_tree::of_session(&data, &session).map(|tree| {
                if json {
                    println!("{}", serde_json::to_string_pretty(&tree).unwrap_or_default());
                } else {
                    print!("{}", tauri_plugin_agent_tools::run_tree::render(&tree));
                }
            })
        }
        AgentCommands::TestTriage {
            project,
            command,
            no_retry,
            json,
        } => {
            use app_lib::core::agent::test_triage;
            let root = std::path::PathBuf::from(&project);
            let command = if command.is_empty() {
                vec!["cargo".to_string(), "test".to_string()]
            } else {
                command
            };
            test_triage::triage(&root, &command, !no_retry).and_then(|triage| {
                if json {
                    println!("{}", serde_json::to_string_pretty(&triage).unwrap_or_default());
                } else {
                    print!("{}", test_triage::render(&triage));
                }
                // A suite with failures that happened twice is a suite with
                // failures; one whose only failures did not reproduce is not
                // the same thing, and the exit code says which.
                let real = triage.reproduced.values().any(|r| {
                    *r == test_triage::Reproduced::Yes || *r == test_triage::Reproduced::NotChecked
                }) && !triage.failures.is_empty();
                if real || triage.unreadable {
                    Err(HarnessError::new(
                        tauri_plugin_agent_tools::harness_error::ErrorKind::ToolFailed,
                        if triage.unreadable {
                            "the test run failed and its output could not be read".to_string()
                        } else {
                            format!(
                                "{} failure(s) in {} group(s)",
                                triage.failures.len(),
                                triage.clusters.len()
                            )
                        },
                    ))
                } else {
                    Ok(())
                }
            })
        }
        AgentCommands::Health {
            project,
            only,
            dry_run,
            json,
        } => {
            use app_lib::core::agent::health;
            let root = std::path::PathBuf::from(&project);
            let selected: std::result::Result<Vec<health::Kind>, String> =
                only.iter().map(|o| health::Kind::parse(o)).collect();
            selected
                .map_err(|e| {
                    HarnessError::new(
                        tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
                        e,
                    )
                })
                .and_then(|selected| {
                    if dry_run {
                        let planned: Vec<health::Check> = health::checks(&root)
                            .into_iter()
                            .filter(|c| selected.is_empty() || selected.contains(&c.kind))
                            .collect();
                        if json {
                            println!(
                                "{}",
                                serde_json::to_string_pretty(&planned).unwrap_or_default()
                            );
                        } else {
                            print!("{}", health::render_plan(&planned));
                        }
                        return Ok(());
                    }
                    let report = health::scan(&root, &selected)?;
                    if json {
                        println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
                    } else {
                        print!("{}", health::render(&report));
                    }
                    // A scan that found something broken says so in its exit
                    // code: this is the thing somebody runs before starting
                    // work, and "it printed a failure and exited 0" is how a
                    // broken tree gets worked in anyway.
                    if health::healthy(&report) {
                        Ok(())
                    } else {
                        Err(HarnessError::new(
                            tauri_plugin_agent_tools::harness_error::ErrorKind::ToolFailed,
                            "at least one of this project's own checks did not pass",
                        ))
                    }
                })
        }
        AgentCommands::Licenses {
            project,
            allow,
            record,
            json,
        } => {
            use app_lib::core::agent::licenses;
            let root = std::path::PathBuf::from(&project);
            let allow = if allow.is_empty() {
                app_lib::core::agent::project::allowed_licenses(&root)
            } else {
                allow
            };
            licenses::scan(&root, &allow).and_then(|report| {
                if json {
                    println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
                } else {
                    print!("{}", licenses::render(&report));
                }
                if record {
                    let path = licenses::record(&root, &report.dependencies)?;
                    println!("recorded {} dependenc(ies) in {}", report.dependencies.len(), path.display());
                }
                // A dependency the project does not allow is a finding, and a
                // command that finds something says so in its exit code.
                if report.disallowed.is_empty() {
                    Ok(())
                } else {
                    Err(HarnessError::new(
                        tauri_plugin_agent_tools::harness_error::ErrorKind::PolicyViolation,
                        format!(
                            "{} dependenc(ies) are not licensed under anything this project allows",
                            report.disallowed.len()
                        ),
                    ))
                }
            })
        }
        AgentCommands::Search {
            query,
            project,
            regex,
            session,
            role,
            limit,
            json,
        } => {
            use app_lib::core::agent::transcript;
            let data = app_lib::core::app::commands::resolve_jan_data_folder();
            transcript::search(
                Some(std::path::Path::new(&project)),
                (!data.as_os_str().is_empty()).then_some(data.as_path()),
                &transcript::Query {
                    text: query,
                    regex,
                    session,
                    role,
                    limit,
                },
            )
            .map(|found| {
                if json {
                    println!("{}", serde_json::to_string_pretty(&found).unwrap_or_default());
                } else {
                    print!("{}", transcript::render(&found));
                }
            })
        }
        AgentCommands::Transcript {
            session,
            project,
            format,
            out,
        } => {
            use app_lib::core::agent::transcript;
            let data = app_lib::core::app::commands::resolve_jan_data_folder();
            let format = match format.as_str() {
                "text" => Ok(transcript::Format::Text),
                "markdown" | "md" => Ok(transcript::Format::Markdown),
                "json" => Ok(transcript::Format::Json),
                other => Err(HarnessError::new(
                    tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
                    format!("{other:?} is not a format; use text, markdown or json"),
                )),
            };
            format
                .and_then(|format| {
                    transcript::export(
                        Some(std::path::Path::new(&project)),
                        (!data.as_os_str().is_empty()).then_some(data.as_path()),
                        &session,
                        format,
                    )
                })
                .and_then(|text| match out {
                    Some(path) => std::fs::write(&path, &text)
                        .map(|()| println!("wrote {path}"))
                        .map_err(|e| {
                            HarnessError::new(
                                tauri_plugin_agent_tools::harness_error::ErrorKind::Io,
                                format!("the transcript could not be written to {path}: {e}"),
                            )
                        }),
                    None => {
                        print!("{text}");
                        Ok(())
                    }
                })
        }
        AgentCommands::Quota { json } => {
            let data = app_lib::core::app::commands::resolve_jan_data_folder();
            use app_lib::core::agent::quota;
            quota::quotas(&data)
                .and_then(|declared| quota::standing(&data, &declared))
                .map_err(|e| HarnessError::from(&e))
                .map(|standings| {
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&standings).unwrap_or_default()
                        );
                    } else {
                        print!("{}", quota::render(&standings));
                    }
                })
        }
        AgentCommands::Compaction { project } => {
            tauri_plugin_agent_tools::compaction_policy::Policy::resolve(
                Some(&app_lib::core::app::commands::resolve_jan_data_folder()),
                Some(std::path::Path::new(&project)),
                None,
            )
            .map(|p| println!("{}", serde_json::to_string_pretty(&p).unwrap_or_default()))
        }
        AgentCommands::BundleExport { project, out } => {
            use app_lib::core::agent::agent_bundle;
            agent_bundle::export(std::path::Path::new(&project)).and_then(|(bundle, report)| {
                let text = serde_json::to_string_pretty(&bundle).unwrap_or_default();
                let tmp = format!("{out}.partial");
                std::fs::write(&tmp, format!("{text}\n"))
                    .and_then(|()| std::fs::rename(&tmp, &out))
                    .map_err(|e| {
                        let _ = std::fs::remove_file(&tmp);
                        HarnessError::new(
                            tauri_plugin_agent_tools::harness_error::ErrorKind::Io,
                            format!("the bundle could not be written to {out}: {e}"),
                        )
                    })?;
                println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
                Ok(())
            })
        }
        AgentCommands::BundleImport { project, file, overwrite, accept_widening, dry_run } => {
            use app_lib::core::agent::agent_bundle;
            std::fs::read_to_string(&file)
                .map_err(|e| {
                    HarnessError::new(
                        tauri_plugin_agent_tools::harness_error::ErrorKind::NotFound,
                        format!("{file} could not be read: {e}"),
                    )
                })
                .and_then(|text| agent_bundle::parse(&text))
                .and_then(|bundle| {
                    agent_bundle::import(std::path::Path::new(&project), &bundle, overwrite, accept_widening, dry_run)
                })
                .map(|report| println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default()))
        }
        AgentCommands::ImportAgents {
            path,
            scope,
            project,
            overwrite,
            dry_run,
        } => {
            use app_lib::core::agent::subagent::SubagentScope;
            let resolved = match scope.as_str() {
                "user" => app_lib::core::agent::subagent::user_subagents_dir()
                    .map(|dir| (SubagentScope::User, dir))
                    .ok_or_else(|| {
                        HarnessError::new(
                            tauri_plugin_agent_tools::harness_error::ErrorKind::NotFound,
                            "the home directory could not be resolved, so there is no user scope to import into",
                        )
                    }),
                "project" => Ok((
                    SubagentScope::Project,
                    app_lib::core::agent::subagent::project_subagents_dir(std::path::Path::new(
                        &project,
                    )),
                )),
                other => Err(HarnessError::new(
                    tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
                    format!("'{other}' is not a scope; use 'user' or 'project'"),
                )),
            };
            resolved.and_then(|(scope, dir)| {
                app_lib::core::agent::agent_import::import(
                    std::path::Path::new(&path),
                    &dir,
                    scope,
                    overwrite,
                    dry_run,
                )
                .map(|report| {
                    print!("{}", app_lib::core::agent::agent_import::render(&report));
                    if !report.dry_run {
                        println!("written to {}", dir.display());
                    }
                })
            })
        }
        AgentCommands::PolicyExport { project, out } => {
            app_lib::core::cli::cli_policy_export(&project).and_then(|document| {
                let text = tauri_plugin_agent_tools::policy_transfer::render(&document);
                match out {
                    Some(path) => std::fs::write(&path, format!("{text}\n")).map_err(|e| {
                        HarnessError::new(
                            tauri_plugin_agent_tools::harness_error::ErrorKind::Io,
                            format!("the policy could not be written to {path}: {e}"),
                        )
                    }),
                    None => {
                        println!("{text}");
                        Ok(())
                    }
                }
            })
        }
        AgentCommands::PolicyImport {
            file,
            project,
            accept_widening,
        } => {
            let text = if file == "-" {
                use std::io::Read;
                let mut buffer = String::new();
                std::io::stdin().read_to_string(&mut buffer).map(|_| buffer).map_err(|e| {
                    HarnessError::new(
                        tauri_plugin_agent_tools::harness_error::ErrorKind::Io,
                        format!("the policy could not be read from stdin: {e}"),
                    )
                })
            } else {
                std::fs::read_to_string(&file).map_err(|e| {
                    HarnessError::new(
                        tauri_plugin_agent_tools::harness_error::ErrorKind::Io,
                        format!("{file} could not be read: {e}"),
                    )
                })
            };
            text.and_then(|text| {
                app_lib::core::cli::cli_policy_import(&project, &text, accept_widening)
            })
            .map(|change| {
                if change.is_empty() {
                    println!("The policy is already what this document says.");
                    return;
                }
                println!("Policy updated.");
                for (label, rules) in [
                    ("added allow", &change.allow_added),
                    ("added deny", &change.deny_added),
                    ("added allow_write", &change.allow_write_added),
                    ("removed allow", &change.allow_removed),
                    ("removed deny", &change.deny_removed),
                    ("removed allow_write", &change.allow_write_removed),
                ] {
                    for rule in rules {
                        println!("  {label}: {rule}");
                    }
                }
                if let Some(default) = change.default_changed_to.as_deref() {
                    println!("  default is now: {default}");
                }
            })
        }
        AgentCommands::Context {
            session,
            snapshot,
            window,
            json,
        } => {
            let data = app_lib::core::app::commands::resolve_jan_data_folder();
            tauri_plugin_agent_tools::context_report::of_snapshot(
                &data,
                &session,
                snapshot.as_deref(),
                window,
                0,
            )
            .map(|breakdown| {
                if json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&breakdown).unwrap_or_default()
                    );
                } else {
                    print!(
                        "{}",
                        tauri_plugin_agent_tools::context_report::render(&breakdown)
                    );
                }
            })
        }
        AgentCommands::Index {
            project,
            symbol,
            limit,
            json,
        } => {
            let root = project
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
            let data = app_lib::core::app::commands::resolve_jan_data_folder();
            // Nothing cancels a one-shot command, but the index takes the flag
            // rather than assuming: the same call is made from a run, where
            // stopping it has to leave no half index behind.
            let cancel = std::sync::atomic::AtomicBool::new(false);
            app_lib::core::agent::index::refresh(&data, &root, &cancel)
                .map_err(|e| HarnessError::from(&e))
                .map(|(index, update)| {
                    if let Some(name) = symbol {
                        let found = app_lib::core::agent::index::find_symbol(&index, &name, limit);
                        if json {
                            println!(
                                "{}",
                                serde_json::to_string_pretty(&found).unwrap_or_default()
                            );
                            return;
                        }
                        if found.is_empty() {
                            println!("nothing named {name:?} is defined in {} files", index.files.len());
                        }
                        for hit in found {
                            println!("{}:{} {:?} {}", hit.path, hit.line, hit.kind, hit.name);
                        }
                        return;
                    }
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&serde_json::json!({
                                "files": index.files.len(),
                                "symbols": index.files.values().map(|f| f.symbols.len()).sum::<usize>(),
                                "commit": index.commit,
                                "truncated": index.truncated,
                                "update": update,
                            }))
                            .unwrap_or_default()
                        );
                        return;
                    }
                    println!(
                        "{} files, {} symbols{}",
                        index.files.len(),
                        index.files.values().map(|f| f.symbols.len()).sum::<usize>(),
                        if index.truncated { " (a bound stopped the walk)" } else { "" }
                    );
                    println!(
                        "  read {} new, {} changed; reused {} without reading; {} gone{}",
                        update.added,
                        update.changed,
                        update.unchanged,
                        update.removed,
                        if update.reconciled { "; the checkout moved, so every entry was re-checked" } else { "" }
                    );
                })
        }
        AgentCommands::Spend {
            since,
            session,
            json,
        } => {
            let data = app_lib::core::app::commands::resolve_jan_data_folder();
            app_lib::core::agent::spend::report(&data, since.as_deref(), session.as_deref())
                .map_err(|e| HarnessError::from(&e))
                .map(|report| {
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&report).unwrap_or_default()
                        );
                    } else {
                        print!("{}", app_lib::core::agent::spend::render(&report));
                    }
                })
        }
        AgentCommands::State { json } => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&app_lib::core::agent::state_schema::stores())
                        .unwrap_or_default()
                );
            } else {
                print!("{}", app_lib::core::agent::state_schema::render());
            }
            Ok(())
        }
        AgentCommands::Mail {
            run,
            session,
            from,
            body,
            subject,
            peek,
        } => {
            use tauri_plugin_agent_tools::identity::{RunId, SessionId};
            let data = app_lib::core::app::commands::resolve_jan_data_folder();
            let to = RunId::parse(run);
            match (to, from, body) {
                (Err(e), _, _) => Err(e),
                (Ok(to), Some(from), Some(body)) => session
                    .ok_or_else(|| {
                        HarnessError::new(
                            tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
                            "sending needs --session: a message belongs to one conversation",
                        )
                    })
                    .and_then(SessionId::parse)
                    .and_then(|session| RunId::parse(from).map(|from| (session, from)))
                    .and_then(|(session, from)| {
                        tauri_plugin_agent_tools::mailbox::send(
                            &data, &session, &from, &to, &subject, &body,
                        )
                        .map_err(|e| HarnessError::from(&e))
                    })
                    .map(|message| {
                        println!("delivered to {} as message {}", message.to, message.seq);
                    }),
                (Ok(to), _, _) => {
                    tauri_plugin_agent_tools::mailbox::read(&data, &to, !peek)
                        .map_err(|e| HarnessError::from(&e))
                        .map(|messages| {
                            if messages.is_empty() {
                                println!("no messages");
                            }
                            for message in messages {
                                println!(
                                    "{} from {}{} [{}]",
                                    message.at,
                                    message.from,
                                    if message.subject.is_empty() {
                                        String::new()
                                    } else {
                                        format!(" -- {}", message.subject)
                                    },
                                    if message.delivered_at.is_some() { "read" } else { "unread" }
                                );
                                println!("  {}", message.body);
                            }
                        })
                }
            }
        }
        AgentCommands::Vcs { project, json } => {
            let root = project
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
            app_lib::core::agent::vcs::divergence(&root)
                .and_then(|divergence| {
                    app_lib::core::agent::vcs::conflicts(&root).map(|merge| (divergence, merge))
                })
                .map_err(|e| HarnessError::from(&e))
                .map(|(divergence, merge)| {
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&serde_json::json!({
                                "divergence": divergence,
                                "merge": merge,
                            }))
                            .unwrap_or_default()
                        );
                        return;
                    }
                    match (&divergence.branch, &divergence.upstream) {
                        (Some(branch), Some(upstream)) => println!(
                            "{branch} vs {upstream}: {} ahead, {} behind",
                            divergence.ahead, divergence.behind
                        ),
                        (Some(branch), None) => println!("{branch}: tracks nothing"),
                        _ => println!("HEAD is detached"),
                    }
                    for option in &divergence.options {
                        println!("  - {option}");
                    }
                    if divergence.needs_a_person {
                        println!("  this needs a decision, not a command");
                    }
                    println!();
                    match app_lib::core::agent::vcs::branches(&root) {
                        Ok(branches) => {
                            for b in &branches {
                                println!(
                                    "{}{}{}{}",
                                    if b.current { "* " } else { "  " },
                                    b.name,
                                    b.upstream.as_ref().map(|u| format!(" -> {u}")).unwrap_or_default(),
                                    if b.checked_out_elsewhere { " (held by another worktree)" } else { "" }
                                );
                            }
                        }
                        Err(e) => println!("branches: {}", e.message),
                    }
                    if merge.in_progress {
                        println!(
                            "a merge is stopped, with {} file(s) unresolved:",
                            merge.files.len()
                        );
                        for file in &merge.files {
                            println!(
                                "  {} ({:?}, {} region(s))",
                                file.path,
                                file.kind,
                                file.hunks.len()
                            );
                        }
                        println!("  {}", merge.note);
                    }
                })
        }
        AgentCommands::Impact {
            changed,
            project,
            json,
        } => {
            let root = project
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
            let runner = app_lib::core::agent::impact::detected_runner(&root);
            app_lib::core::agent::impact::selection(&root, &changed, runner.as_deref())
                .map_err(|e| HarnessError::from(&e))
                .map(|selection| {
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&selection).unwrap_or_default()
                        );
                    } else {
                        println!("{}", selection.reason);
                        for test in &selection.impact.tests {
                            println!("  test: {test}");
                        }
                        for unknown in &selection.impact.unknown {
                            println!("  not seen: {unknown}");
                        }
                        match selection.command.as_deref() {
                            // Printed, never run: what to do about it is the
                            // caller's decision, not this command's.
                            Some(command) => println!("run: {command}"),
                            None => println!("run: (this project does not say)"),
                        }
                    }
                })
        }
        AgentCommands::Prompts { session, show } => agent_prompts_text(
            &app_lib::core::app::commands::resolve_jan_data_folder(),
            &session,
            show.as_deref(),
        )
        .map(|text| print!("{text}"))
        .map_err(HarnessError::legacy),
        AgentCommands::Status { project, providers } => {
            match cli_agent_status(&project, &providers.into_overrides()) {
                Ok(status) => {
                    println!("{}", serde_json::to_string_pretty(&status).unwrap());
                    Ok(())
                }
                Err(e) => Err(HarnessError::legacy(e)),
            }
        }
        // No project and no provider: the schema comes from the types alone, so
        // it is the same document on any machine and in any directory.
        AgentCommands::Schema { out } => {
            app_lib::core::cli::protocol_schema::run(out.as_deref()).map_err(HarnessError::legacy)
        }
        AgentCommands::Rpc => app_lib::core::cli::rpc::serve().await.map_err(HarnessError::legacy),
        // Like `schema`: no project root and no provider are involved, so the
        // artifact is the same one on any machine. `--out` is what CI and
        // `make protocol-rpc-schema` use.
        AgentCommands::RpcSchema { out } => {
            app_lib::core::cli::rpc_schema::run(out.as_deref()).map_err(HarnessError::legacy)
        }
    };
    if let Err(e) = result {
        // AH-009: what ended the run decides how it is reported and what the
        // process exits with. A run the user stopped is not a failure, and a
        // rejected credential is not an outage -- a script reading the status
        // can tell them apart without parsing this line.
        if e.is_cancellation() {
            eprintln!("Stopped: {}", e.message());
        } else {
            eprintln!("Error [{}]: {}", e.kind().tag(), e.message());
            for cause in e.chain().into_iter().skip(1) {
                eprintln!("  caused by [{}]: {}", cause.kind().tag(), cause.message());
            }
        }
        std::process::exit(run_exit_code(&e));
    }
}

/// Classify a failed agent run for the shell (upstream janhq/jan 5ae763e2e8).
///
/// Running out of turns with the model still calling tools is not the same
/// outcome as a crash or a usage error: the run stopped where the caller asked
/// it to stop, but it has no final answer, so a pipeline that only reads the
/// exit code would take an unfinished task for a finished one. It exits `53`;
/// every other failure keeps the kind's own code.
fn run_exit_code(e: &HarnessError) -> i32 {
    if is_turn_limit_exhaustion(e) {
        53
    } else {
        e.exit_code()
    }
}

/// Whether the run ended because `--max-turns` ran out with tool calls still in
/// flight. The message is the only marker that separates it from the other
/// budget exhaustions, so the match is anchored at both ends.
fn is_turn_limit_exhaustion(e: &HarnessError) -> bool {
    const TURN_LIMIT: &str = "-turn limit while the model was still calling tools";
    e.chain().into_iter().any(|cause| {
        matches!(
            cause.kind(),
            tauri_plugin_agent_tools::harness_error::ErrorKind::BudgetExhausted
        ) && cause.message().starts_with("reached the ")
            && cause.message().ends_with(TURN_LIMIT)
    })
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

        ThreadsCommands::Delete { id, permanent } => {
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
        ThreadsCommands::Export { id, format, verbose, all_versions, out } => {
            let result = app_lib::core::cli::thread_export::Format::parse(&format).and_then(|f| {
                app_lib::core::cli::thread_export::export_thread(
                    &app_lib::core::app::commands::resolve_jan_data_folder(),
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
        ModelsCommands::List { provider, project } => {
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
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
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

fn handle_models_delete(id: &str, yes: bool) {
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
    if json {
        println!("{}", serde_json::to_string_pretty(&info).unwrap());
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
mod tests {
    /// A closed stdout/stderr pipe is recognised; nothing else is.
    #[test]
    fn closed_output_panics_are_recognised() {
        assert!(super::is_closed_output_panic(
            "failed printing to stdout: Broken pipe (os error 32)"
        ));
        assert!(super::is_closed_output_panic(
            "failed printing to stdout: The pipe is being closed. (os error 232)"
        ));
        assert!(super::is_closed_output_panic("failed printing to stderr: Broken pipe (os error 32)"));
        assert!(!super::is_closed_output_panic("index out of bounds"));
        assert!(!super::is_closed_output_panic(""));
    }

    /// Running out of turns while the model is still calling tools is the one
    /// failure the shell can read as a limit rather than a crash. The message is
    /// the only marker it has, so the classifier must match that message and not
    /// some phrase inside a different one.
    #[test]
    fn turn_limit_exhaustion_has_its_own_exit_code() {
        use tauri_plugin_agent_tools::harness_error::ErrorKind;
        let limit = super::HarnessError::new(
            ErrorKind::BudgetExhausted,
            "reached the 8-turn limit while the model was still calling tools",
        );
        assert_eq!(super::run_exit_code(&limit), 53);
        let tokens = super::HarnessError::new(ErrorKind::BudgetExhausted, "session token budget spent");
        assert_eq!(super::run_exit_code(&tokens), tokens.exit_code());
        let upstream = super::HarnessError::new(ErrorKind::Upstream, "upstream returned 500");
        assert_eq!(super::run_exit_code(&upstream), upstream.exit_code());
    }

    #[test]
    fn usage_subcommands_parse() {
        let view = |argv: &[&str]| {
            let mut full = vec!["flint", "usage"];
            full.extend_from_slice(argv);
            match Cli::parse_from(full).command {
                Some(Commands::Usage { cmd, .. }) => cmd,
                other => panic!("expected a usage command, got {:?}", other.is_some()),
            }
        };
        assert!(matches!(view(&["account"]), Some(UsageCommands::Account)));
        assert!(matches!(view(&["daily"]), Some(UsageCommands::Daily)));
        assert!(matches!(view(&["requests"]), Some(UsageCommands::Requests)));
        assert!(matches!(view(&["limits"]), Some(UsageCommands::Limits)));
        match view(&["generation", "exec-1"]) {
            Some(UsageCommands::Generation { id }) => assert_eq!(id, "exec-1"),
            _ => panic!("expected a generation lookup"),
        }
        match view(&["correlate", "my-app-request-001"]) {
            Some(UsageCommands::Correlate { client_request_id }) => {
                assert_eq!(client_request_id, "my-app-request-001");
            }
            _ => panic!("expected a correlation lookup"),
        }
        assert!(view(&[]).is_none(), "the subcommand is optional");
        assert!(Cli::try_parse_from(["flint", "usage", "generation"]).is_err());
        assert!(Cli::try_parse_from(["flint", "usage", "correlate"]).is_err());
        assert!(matches!(
            Cli::parse_from(["flint", "usage", "account", "--json"]).command,
            Some(Commands::Usage {
                cmd: Some(UsageCommands::Account),
                json: true
            })
        ));
    }

    /// Parse `flint cli agent run <task> <extra...>` and pull out its budget args.
    fn parsed_budget(extra: &[&str]) -> BudgetArgs {
        let mut argv = vec!["flint", "cli", "agent", "run", "task"];
        argv.extend_from_slice(extra);
        match Cli::parse_from(argv).command {
            Some(Commands::Cli {
                cmd:
                    CliCommands::Agent {
                        cmd: AgentCommands::Run { budget, .. },
                    },
            }) => budget,
            _ => panic!("expected `cli agent run`"),
        }
    }

    /// An unpassed limit is `None` so the config files (or nothing, for turns)
    /// decide; `0` must survive parsing as the engine's unbounded marker.
    #[test]
    fn run_limits_parse_and_default_to_unset() {
        let none = parsed_budget(&[]);
        assert_eq!(none.max_turns, None);
        assert_eq!(none.max_session_tokens, None);

        let set = parsed_budget(&["--max-turns", "5", "--max-session-tokens", "20000"]);
        assert_eq!(set.max_turns, Some(5));
        assert_eq!(set.max_session_tokens, Some(20_000));

        let zero = parsed_budget(&["--max-turns", "0", "--max-session-tokens", "0"]);
        assert_eq!(zero.max_turns, Some(0));
        assert_eq!(zero.max_session_tokens, Some(0));

        // A decimal amount, not a token count, and `0` is a real ceiling.
        assert_eq!(parsed_budget(&[]).max_budget_usd, None);
        assert_eq!(
            parsed_budget(&["--max-budget-usd", "2.50"]).max_budget_usd,
            Some(2.50)
        );
        assert_eq!(
            parsed_budget(&["--max-budget-usd", "0"]).max_budget_usd,
            Some(0.0)
        );
    }

    #[test]
    fn mcp_serve_parses_and_defaults_to_read_only_stdio() {
        let cli = Cli::parse_from(["flint", "mcp", "serve"]);
        let Some(Commands::Mcp {
            cmd:
                McpServeCommands::Serve {
                    project,
                    transport,
                    allow_write,
                    allow_exec,
                    tools,
                    port,
                    token,
                },
        }) = cli.command
        else {
            panic!("expected mcp serve");
        };
        assert_eq!(project, ".");
        assert_eq!(transport, ServeTransport::Stdio);
        assert!(!allow_write);
        assert!(!allow_exec);
        assert!(tools.is_empty());
        assert_eq!(port, 0);
        assert!(token.is_none());
    }

    #[test]
    fn mcp_serve_http_flags_parse() {
        let cli = Cli::parse_from([
            "flint",
            "mcp",
            "serve",
            "--transport",
            "http",
            "--port",
            "7331",
            "--token",
            "abc",
            "--allow-write",
            "--allow-exec",
            "--tool",
            "read",
            "--tool",
            "grep",
        ]);
        let Some(Commands::Mcp {
            cmd:
                McpServeCommands::Serve {
                    transport,
                    allow_write,
                    allow_exec,
                    tools,
                    port,
                    token,
                    ..
                },
        }) = cli.command
        else {
            panic!("expected mcp serve");
        };
        assert_eq!(transport, ServeTransport::Http);
        assert!(allow_write);
        assert!(allow_exec);
        assert_eq!(tools, vec!["read".to_string(), "grep".to_string()]);
        assert_eq!(port, 7331);
        assert_eq!(token.as_deref(), Some("abc"));
    }

    /// The client direction keeps its own place; `flint mcp` must not shadow it.
    #[test]
    fn mcp_client_subcommand_still_lives_under_cli() {
        let cli = Cli::parse_from(["flint", "cli", "mcp", "list"]);
        assert!(matches!(
            cli.command,
            Some(Commands::Cli {
                cmd: CliCommands::Mcp {
                    cmd: McpCommands::List { .. }
                }
            })
        ));
    }

    use super::*;

    #[test]
    fn verbose_flag_is_accepted_bare_and_after_a_subcommand() {
        for args in [
            vec!["jan", "--verbose"],
            vec!["jan", "-v"],
            vec!["jan", "plugin", "list", "--verbose"],
            vec!["jan", "-v", "plugin", "list"],
        ] {
            let cli = Cli::try_parse_from(&args)
                .unwrap_or_else(|e| panic!("{args:?} should parse: {e}"));
            assert!(cli.verbose, "{args:?} should set verbose");
        }
        assert!(!Cli::try_parse_from(["jan", "plugin", "list"]).unwrap().verbose);
    }

    #[test]
    fn bug_report_parses_its_flags_and_nothing_else() {
        let cli = Cli::parse_from([
            "jan",
            "bug-report",
            "--thread",
            "abc123",
            "--show",
            "logs/jan.log",
        ]);
        assert!(matches!(
            cli.command,
            Some(Commands::BugReport { thread, show, yes: false, out: None })
                if thread.as_deref() == Some("abc123") && show.as_deref() == Some("logs/jan.log")
        ));
        let cli = Cli::parse_from(["jan", "bug-report", "--yes", "--out", "."]);
        assert!(matches!(
            cli.command,
            Some(Commands::BugReport { yes: true, out: Some(_), .. })
        ));
        // There is deliberately no flag that sends the bundle anywhere.
        for flag in ["--upload", "--submit", "--send", "--open-issue"] {
            assert!(
                Cli::try_parse_from(["jan", "bug-report", flag]).is_err(),
                "{flag} must not exist"
            );
        }
    }

    /// `--from` without `--body` (or the reverse) is half a send; it must be
    /// refused rather than fall through to reading the mailbox (#150).
    #[test]
    fn agent_mail_refuses_half_a_send() {
        let base = ["jan", "cli", "agent", "mail", "--run", "r1"];
        let with = |extra: &[&'static str]| {
            let mut args = base.to_vec();
            args.extend_from_slice(extra);
            Cli::try_parse_from(args)
        };
        assert!(with(&["--from", "r2"]).is_err(), "--from alone was accepted");
        assert!(with(&["--body", "hi"]).is_err(), "--body alone was accepted");
        assert!(with(&[]).is_ok(), "a plain read must still parse");
        assert!(with(&["--from", "r2", "--body", "hi", "--session", "s"]).is_ok());
    }

    // `--plan` is a per-invocation startup toggle mirroring `--safe`; it must
    // parse on the top-level `jan` command and default off.
    #[test]
    fn top_level_plan_flag_parses() {
        let cli = Cli::parse_from(["jan", "--plan"]);
        assert!(cli.plan);
        assert!(!cli.safe);
        assert!(cli.command.is_none());

        let cli = Cli::parse_from(["jan"]);
        assert!(!cli.plan);
    }

    // Permission prompts are opt-in: auto-approval inside the OS sandbox is the
    // default, and `--safe` is what turns the gate back on.
    #[test]
    fn safe_flag_parses_and_defaults_off() {
        assert!(!Cli::parse_from(["jan"]).safe);
        assert!(Cli::parse_from(["jan", "--safe"]).safe);
    }

    /// Parse `flint cli agent run <task> <extra...>` and pull out its output format.
    fn parsed_output_format(extra: &[&str]) -> OutputFormat {
        let mut argv = vec!["jan", "cli", "agent", "run", "task"];
        argv.extend_from_slice(extra);
        match Cli::parse_from(argv).command {
            Some(Commands::Cli {
                cmd:
                    CliCommands::Agent {
                        cmd: AgentCommands::Run { output_format, .. },
                    },
            }) => output_format,
            _ => panic!("expected `cli agent run`"),
        }
    }

    /// AH-087: a session's requests are listed, the last or a named one is
    /// printed in full, and another session's request is not readable by id.
    #[test]
    fn agent_prompts_lists_and_prints_a_sessions_requests_only() {
        use tauri_plugin_agent_tools::snapshot::{append, capture, Identity};
        let data = std::env::temp_dir().join(format!("jan-prompts-cli-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(&data).unwrap();
        let ident = |session: &str| Identity { session: session.into(), ..Default::default() };
        let first = capture(
            &serde_json::json!({ "model": "m", "messages": [{ "role": "user", "content": "first question" }] }),
            &ident("s1"),
        );
        let second = capture(
            &serde_json::json!({ "model": "m", "messages": [{ "role": "user", "content": "second question" }] }),
            &ident("s1"),
        );
        let other = capture(
            &serde_json::json!({ "model": "m", "messages": [{ "role": "user", "content": "someone else's" }] }),
            &ident("s2"),
        );
        for s in [&first, &second, &other] {
            append(&data, s);
        }

        let list = agent_prompts_text(&data, "s1", None).unwrap();
        assert!(list.starts_with("2 request(s) for session s1"), "{list}");
        assert!(list.contains(&first.id) && list.contains(&second.id) && !list.contains(&other.id));

        let last = agent_prompts_text(&data, "s1", Some("last")).unwrap();
        assert!(last.contains("second question") && !last.contains("first question"), "{last}");
        let named = agent_prompts_text(&data, "s1", Some(&first.id)).unwrap();
        assert!(named.contains("first question"), "{named}");

        assert!(agent_prompts_text(&data, "s1", Some(&other.id)).is_err(), "another session's request was readable");
        assert!(agent_prompts_text(&data, "s3", None).unwrap_err().contains("no requests"));
        assert!(agent_prompts_text(&data, " ", None).is_err());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn prompts_is_a_cli_agent_command() {
        let cli = Cli::try_parse_from(["jan", "cli", "agent", "prompts", "s1", "--show", "last"]);
        assert!(cli.is_ok(), "`flint cli agent prompts <session> --show last` must parse");
    }

    #[test]
    fn output_format_parses_and_defaults_to_text() {
        assert_eq!(parsed_output_format(&[]), OutputFormat::Text);
        assert_eq!(
            parsed_output_format(&["--output-format", "json"]),
            OutputFormat::Json
        );
        assert_eq!(
            parsed_output_format(&["--output-format=text"]),
            OutputFormat::Text
        );
        assert!(Cli::try_parse_from([
            "jan",
            "cli",
            "agent",
            "run",
            "task",
            "--output-format",
            "yaml"
        ])
        .is_err());
    }

    #[test]
    fn login_command_parses_and_takes_no_args() {
        let cli = Cli::parse_from(["jan", "login"]);
        assert!(matches!(
            cli.command,
            Some(Commands::Login { paste_token: false })
        ));
        assert!(Cli::try_parse_from(["jan", "login", "sk-key"]).is_err());
    }

    #[test]
    fn login_command_accepts_paste_token_flag() {
        let cli = Cli::parse_from(["jan", "login", "--paste-token"]);
        assert!(matches!(
            cli.command,
            Some(Commands::Login { paste_token: true })
        ));
    }

    #[test]
    fn auth_subcommands_parse() {
        let cli = Cli::parse_from(["jan", "auth", "status"]);
        assert!(matches!(
            cli.command,
            Some(Commands::Auth {
                cmd: AuthCommands::Status
            })
        ));
        let cli = Cli::parse_from(["jan", "auth", "logout"]);
        assert!(matches!(
            cli.command,
            Some(Commands::Auth {
                cmd: AuthCommands::Logout
            })
        ));
    }

    /// Parse a `flint cli mcp <cmd> <extra...>` argv and pull out the subcommand.
    fn parsed_mcp(extra: &[&str]) -> McpCommands {
        let mut argv = vec!["jan", "cli", "mcp"];
        argv.extend_from_slice(extra);
        match Cli::parse_from(argv).command {
            Some(Commands::Cli {
                cmd: CliCommands::Mcp { cmd },
            }) => cmd,
            _ => panic!("expected `cli mcp`"),
        }
    }

    #[test]
    fn mcp_list_parses_and_redacts_by_default() {
        let cmd = parsed_mcp(&["list"]);
        assert!(matches!(
            cmd,
            McpCommands::List {
                show_secrets: false
            }
        ));
        let cmd = parsed_mcp(&["list", "--show-secrets"]);
        assert!(matches!(cmd, McpCommands::List { show_secrets: true }));
    }

    #[test]
    fn mcp_add_parses_stdio_fields() {
        let cmd = parsed_mcp(&[
            "add",
            "files",
            "--command",
            "npx",
            "--arg",
            "-y",
            "--arg",
            "my-mcp",
            "--env",
            "K=V",
            "--active",
        ]);
        match cmd {
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
                assert!(scope.is_empty(), "no --scope was given");
                assert_eq!(name, "files");
                assert_eq!(command.as_deref(), Some("npx"));
                assert_eq!(args, vec!["-y", "my-mcp"]);
                assert_eq!(env, vec!["K=V"]);
                assert_eq!(r#type, "stdio");
                assert!(url.is_none());
                assert!(header.is_empty());
                assert!(active);
            }
            _ => panic!("expected add"),
        }
    }

    #[test]
    fn mcp_build_rejects_http_without_url() {
        let err = build_mcp_config(None, vec![], vec![], "http", None, vec![], false, Vec::new()).unwrap_err();
        assert!(err.contains("url"), "{err}");
        let err = build_mcp_config(None, vec![], vec![], "sse", None, vec![], false, Vec::new()).unwrap_err();
        assert!(err.contains("url"), "{err}");
        assert!(build_mcp_config(None, vec![], vec![], "bogus", None, vec![], false, Vec::new()).is_err());
        // stdio needs a command.
        assert!(build_mcp_config(None, vec![], vec![], "stdio", None, vec![], false, Vec::new()).is_err());
    }

    #[test]
    fn mcp_remove_enable_disable_take_one_name() {
        assert!(matches!(
            parsed_mcp(&["remove", "files"]),
            McpCommands::Remove { name } if name == "files"
        ));
        assert!(matches!(
            parsed_mcp(&["enable", "files"]),
            McpCommands::Enable { name } if name == "files"
        ));
        assert!(matches!(
            parsed_mcp(&["disable", "files"]),
            McpCommands::Disable { name } if name == "files"
        ));
    }
    #[test]
    fn plugin_list_defaults_to_compact_output_and_supports_json() {
        let cli = Cli::try_parse_from(["jan", "plugin", "list"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Commands::Plugin {
                cmd: PluginCommands::List { project, json }
            }) if project == "." && !json
        ));

        let cli = Cli::try_parse_from(["jan", "plugin", "list", "--json"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Commands::Plugin {
                cmd: PluginCommands::List { json, .. }
            }) if json
        ));
    }

    #[test]
    fn split_kv_rejects_without_separator() {
        assert_eq!(
            split_kv("K=V", "env").unwrap(),
            ("K".to_string(), "V".to_string())
        );
        assert!(split_kv("novalue", "env").is_err());
        assert!(split_kv("=V", "header").is_err());
    }

    #[test]
    fn compact_plugin_list_omits_long_metadata() {
        let plugins = vec![
            InstalledPlugin {
                name: "alpha".into(),
                description: "A long description that should not appear".into(),
                version: "1.2.3".into(),
                repo: "https://example.com/alpha".into(),
                skills: 2,
                commands: 1,
                agents: 3,
                ..Default::default()
            },
            InstalledPlugin {
                name: "beta".into(),
                description: "Another description".into(),
                version: "0.0.0".into(),
                repo: String::new(),
                skills: 0,
                commands: 0,
                agents: 0,
                ..Default::default()
            },
        ];

        let output = format_plugin_list(&plugins);
        assert_eq!(output.lines().count(), 3);
        assert!(output.lines().next().unwrap().contains("PLUGIN"));
        assert!(output.lines().next().unwrap().contains("COMMANDS"));
        assert!(output.lines().next().unwrap().contains("AGENTS"));
        assert!(output.contains("alpha"));
        assert!(output.contains("1.2.3"));
        assert!(output.contains("2"));
        assert!(output.contains("1"));
        assert!(output.contains("3"));
        assert!(!output.contains("long description"));
        assert!(!output.contains("example.com"));
    }
}
