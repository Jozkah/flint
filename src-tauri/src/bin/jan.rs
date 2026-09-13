//! jan — headless CLI for Jan.
//!
//! Shares the Tauri-free core logic with the Jan desktop app; talks only to
//! remote providers (no local inference, no GUI dependencies).
//! Build with: cargo build --no-default-features --features cli --bin jan

use clap::{Args, CommandFactory, FromArgMatches, Parser, Subcommand};
use console::Style;

// Import the library crate so we can access core modules.
// The lib target is named "app_lib" (see [lib] section in Cargo.toml).
use app_lib::core::agent::plugins::InstalledPlugin;
use app_lib::core::cli::mcp::{self, split_kv, McpServerEntry};
use app_lib::core::cli::providers::{load_provider_configs, ProviderOverrides};
use app_lib::core::cli::run_report::OutputFormat;
use app_lib::core::cli::{
    cli_agent_config_list, cli_agent_config_path, cli_agent_config_set, cli_agent_config_unset,
    cli_agent_run, cli_agent_status, cli_agent_step, cli_agent_ui, cli_delete_thread,
    cli_get_thread, cli_list_messages, cli_list_threads, cli_plugin_install, cli_plugin_list,
    cli_plugin_remove, cli_plugin_search, ResumeTarget, SessionFlags,
};
use std::fmt::Write as _;

// ── Top-level CLI ──────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(
    name = "jan",
    about = "Chat with AI models in an interactive agent console",
    long_about = "Running `jan` with no arguments opens the interactive agent console (TUI),\n\
where you chat with a model that can run tools in your project.\n\n\
The `jan cli` subcommand is the non-interactive fallback: run folder-based\n\
agents headlessly and manage threads and providers.\n\n\
Models are served by remote providers configured in ~/.jan/config.toml\n\
(see `jan config set`), a project's agent.toml, or the Jan desktop app.\n\n\
Once every 24h this sends an anonymous usage ping (version, OS/arch, a random\n\
install id) to the same endpoint as the update check. Set JAN_CLI_NO_UPDATE_CHECK\n\
to opt out of both.",
    after_help = "Examples:\n  \
  jan                                                    # open the interactive agent console (TUI)\n  \
  jan --safe                                             # TUI that asks before writes and commands\n  \
  jan --task \"fix the failing test\"                      # seed the TUI with a first message\n  \
  jan -c                                                 # resume the most recent session\n  \
  jan --resume 3f7a91c2                                  # resume a session by id (or id prefix)\n  \
  jan cli agent run \"fix the failing test\"               # run the agent non-interactively\n  \
  jan cli models list                                    # show every configured provider model\n  \
  jan cli threads list                                   # list saved conversation threads\n  \
  jan cli mcp list                                      # list configured MCP servers\n  \
  jan cli mcp add my-server --command npx --arg -y --arg my-mcp \n  \
  jan update                                             # install the latest build of this channel"
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
    #[command(flatten)]
    resume: ResumeArgs,
    /// Start the default agent TUI in read-only plan mode (same as /plan).
    /// Ignored when a subcommand is given.
    #[arg(long)]
    plan: bool,
    #[command(flatten)]
    sandbox: SandboxArgs,
}

/// Whether this invocation confines the shell, shared by every surface that
/// starts an agent.
///
/// Two flags rather than one because the setting is also persistent
/// (`sandbox` in `~/.jan/config.toml`, `[tools].sandbox` in agent.toml): with
/// only `--sandbox` there would be no way to run unconfined once, and a user who
/// turned it on permanently would have to edit a file to get out of it.
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

/// Session-resume selection, shared by the bare TUI and `jan cli agent run`.
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
}

impl ResumeArgs {
    fn into_target(self) -> Option<ResumeTarget> {
        ResumeTarget::from_flags(self.resume, self.continue_session)
    }
}

/// Same flags for `jan cli agent run`, which has a required positional TASK: a
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
}

impl ResumeRunArgs {
    fn into_target(self) -> Option<ResumeTarget> {
        ResumeTarget::from_flags(self.resume, self.continue_session)
    }
}

/// Top-level commands. Bare `jan` opens the interactive TUI; everything else
/// lives under the non-interactive `cli` fallback.
#[derive(Subcommand)]
enum Commands {
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

/// The non-interactive command surface, reached via `jan cli <command>`.
#[derive(Subcommand)]
enum CliCommands {
    /// Background work that outlives this process (AH-101/AH-102)
    #[command(display_order = 9)]
    Job {
        #[command(subcommand)]
        cmd: JobCommands,
    },
    /// List and inspect conversation threads saved by the Jan app
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
        let provider = self
            .provider
            .or_else(|| app_lib::core::cli::providers::desktop_selection().provider);
        ProviderOverrides {
            provider,
            api_key: self.api_key,
        }
        .with_env()
    }
}

#[derive(Subcommand)]
enum AgentCommands {
    /// Run the agent loop to completion or the session token budget
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
        #[command(flatten)]
        providers: ProviderArgs,
        #[command(flatten)]
        sandbox: SandboxArgs,
        #[command(flatten)]
        resume: ResumeRunArgs,
        /// `text` streams the answer as it arrives; `json` prints one result
        /// object on stdout when the run finishes
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        output_format: OutputFormat,
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
    /// Import agent definitions written for OpenCode or Qwen Code into Jan's
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
        /// Send instead of read: the run the message is from.
        #[arg(long)]
        from: Option<String>,
        /// What to say. Requires `--from`.
        #[arg(long)]
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
}

/// Read/write the user-wide `~/.jan/config.toml` provider store. This is the
/// self-sufficient config surface for a standalone Jan Agent: every command is
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
        /// Where Jan keeps its data. Defaults to the configured data folder
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
        #[arg(long)]
        command: String,
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
    /// Permanently delete a thread and all its messages
    Delete {
        /// Thread ID
        id: String,
    },
    /// Print all messages in a thread as JSON
    Messages {
        /// Thread ID
        thread_id: String,
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

async fn run() {
    // Exits early if invoked as the Windows sandbox helper for a `bash` tool
    // call: the helper's only job is to spawn the confined shell and wait, so it
    // must run before anything else -- starting the app first would run a second
    // copy per shell command.
    tauri_plugin_agent_tools::run_sandbox_helper_if_requested();

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
        if let Err(e) = cli_agent_ui(
            &cli.project,
            cli.task,
            cli.model,
            cli.images,
            overrides,
            SessionFlags {
                auto_approve: !cli.safe,
                plan: cli.plan,
                sandbox: cli.sandbox.into_flag(),
                ..Default::default()
            },
            cli.resume.into_target(),
        )
        .await
        {
            eprintln!("Error: {e}");
            std::process::exit(1);
        }
        return;
    };

    match command {
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
        CliCommands::Models { cmd } => handle_models(cmd).await,
        CliCommands::Agent { cmd } => handle_agent(cmd).await,
        CliCommands::Mcp { cmd } => {
            if let Err(e) = handle_mcp(cmd).await {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }
    }
}

// ── Agent handlers ───────────────────────────────────────────────────────

use tauri_plugin_agent_tools::harness_error::HarnessError;

/// `jan cli job`: work that outlives the process that started it.
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
                    "\x1b[2m[job {} started; it keeps running if this process exits]\x1b[0m",
                    record.id
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
        } => worker::supervise(std::path::Path::new(&data), &id, &owner, &token, &command)
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
            providers,
            sandbox,
            resume,
            output_format,
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
            cli_agent_run(
                &project,
                &task,
                model,
                providers.into_overrides(),
                SessionFlags {
                    auto_approve: !safe,
                    sandbox: sandbox.into_flag(),
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
                    ..Default::default()
                },
                resume.into_target(),
                output_format,
            )
            .await
        }
        AgentCommands::Step {
            project,
            task,
            model,
            safe,
            providers,
            sandbox,
            profile,
        } => {
            cli_agent_step(
                &project,
                &task,
                model,
                providers.into_overrides(),
                SessionFlags {
                    auto_approve: !safe,
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
        std::process::exit(e.exit_code());
    }
}

/// `jan cli agent prompts`: what a session sent to the model (AH-087).
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
                println!("Not signed in to Tokamak. Run `jan login`.");
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
                Some(false) => println!("  valid:        no (re-run `jan login`)"),
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

        ThreadsCommands::Delete { id } => match cli_delete_thread(&id) {
            Ok(()) => println!("{}", serde_json::json!({ "deleted": true, "id": id })),
            Err(e) => {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        },

        ThreadsCommands::Messages { thread_id } => match cli_list_messages(&thread_id) {
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
            let output =
                app_lib::core::cli::providers::model_listing(&configs, provider.as_deref());
            if !output.is_empty() && output.iter().all(|m| m["reachable"] == false) {
                eprintln!(
                    "None of these models is reachable from the CLI: they run inside the \
                     Jan app. Enable the app's Local API Server and point the CLI at it:\n  \
                     jan config set --provider jan --base-url http://localhost:1337/v1 --model <model>"
                );
            }
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
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
            active,
        } => {
            let config = build_mcp_config(command, args, env, &r#type, url, header, active)?;
            mcp::upsert_server(&name, &config)?;
            println!("saved server '{name}' to mcp_config.json");
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
fn build_mcp_config(
    command: Option<String>,
    args: Vec<String>,
    env: Vec<String>,
    r#type: &str,
    url: Option<String>,
    header: Vec<String>,
    active: bool,
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
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// Parse `jan cli agent run <task> <extra...>` and pull out its output format.
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
        assert!(cli.is_ok(), "`jan cli agent prompts <session> --show last` must parse");
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

    /// Parse a `jan cli mcp <cmd> <extra...>` argv and pull out the subcommand.
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
                active,
            } => {
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
        let err = build_mcp_config(None, vec![], vec![], "http", None, vec![], false).unwrap_err();
        assert!(err.contains("url"), "{err}");
        let err = build_mcp_config(None, vec![], vec![], "sse", None, vec![], false).unwrap_err();
        assert!(err.contains("url"), "{err}");
        assert!(build_mcp_config(None, vec![], vec![], "bogus", None, vec![], false).is_err());
        // stdio needs a command.
        assert!(build_mcp_config(None, vec![], vec![], "stdio", None, vec![], false).is_err());
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
            },
            InstalledPlugin {
                name: "beta".into(),
                description: "Another description".into(),
                version: "0.0.0".into(),
                repo: String::new(),
                skills: 0,
                commands: 0,
                agents: 0,
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
