//! CLI adapter layer — thin wrappers that call core logic without an AppHandle.
//!
//! This module is only compiled when the `cli` feature is enabled.

mod agent_status;
pub mod auth;
pub mod approvals_cmd;
pub mod brand;
pub mod color;
pub(crate) mod display_safe;
pub mod browser;
#[cfg(test)]
mod contract_conformance;
pub mod device_auth;
pub mod doctor;
pub mod file_log;
pub mod inflight;
pub mod journal;
pub mod json_api;
pub mod bench;
pub mod login;
pub mod cc_import_cmd;
pub mod hf_cmd;
pub mod mcp;
pub mod memory_cmd;
pub mod migrate_cmd;
/// `jan mcp serve`: the other direction, Jan's toolset served over MCP.
pub mod mcp_serve;
pub(crate) mod model_capabilities;
mod path_refs;
pub(crate) mod pathnorm;
/// `jan cli agent schema`: the protocol's JSON Schema, generated from the types.
pub mod protocol_schema;
/// `jan cli agent rpc`: persistent, session-scoped JSON-RPC transport.
pub mod rpc;
/// `flint cli acp`: Agent Client Protocol server on stdin/stdout.
pub mod acp;
/// `jan cli agent rpc-schema`: the RPC request and event schemas.
pub mod rpc_schema;
/// The turn steps the stdio RPC loop and the HTTP session runner share.
pub(crate) mod turn_host;
pub mod providers;
pub mod run_report;
pub mod archive_cmd;
pub mod run_data_cmd;
pub mod automation_cmd;
pub mod launch_cmd;
pub mod schedule;
pub mod skills_cmd;
pub mod system_cmd;
pub mod thread_export;
pub mod schedule_manage;
pub mod secrets;
mod secret_input;
pub mod stream_input;
pub mod terminal_setup;
pub mod tokamak;
mod tui;
/// Renders reported usage from the Tokamak usage API (upstream #9034).
pub mod usage_view;
pub mod version;
/// The user-message wire shape, shared by the TUI and the headless channel.
mod user_message;
pub mod worktree;
pub mod worktree_cmd;

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

mod threads;
pub use threads::*;

mod output;
pub use output::*;

mod input;
use input::*;

mod agent_cmds;
pub use agent_cmds::*;

// ── Agent operations ───────────────────────────────────────────────────────

use crate::core::agent::events::StreamEvent;
use crate::core::agent::project::{
    ensure_project, load_agent_config, load_agent_config_with_profile, permissions_from,
    set_model_in_agent_toml,
};
use crate::core::agent::r#loop::{
    run_orchestration_steered, run_orchestration_streamed, OrchestrationArgs, PermissionRegistry,
    SteeringRequest,
};
use crate::core::cli::providers::{load_provider_configs, ProviderOverrides};
use crate::core::cli::run_report::{
    ndjson_line, Init, InputContentParts, OutputFormat, PermissionDecisionRecord, RunReport,
};
use crate::core::cli::stream_input::{
    parse_input_line, InputErrorRecord, InputFormat, InputMessage, StreamInput, INPUT_KINDS,
    MAX_ECHO_BYTES, MAX_LINE_BYTES,
};
use crate::core::mcp::models::McpSettings;
use std::collections::HashMap;
use std::io::Write as _;
use tauri_plugin_agent_tools::tools::gate::PermissionDecision;
use tauri_plugin_agent_tools::workspace;
use tokio::sync::{mpsc, Mutex};

/// Token-spend ceiling for one agent run when `agent.toml [budget].max_tokens`
/// is unset and the model's context window is not known (see
/// `resolve_session_budget`). `0` disables the ceiling entirely. Counted marginally by
/// `SessionBudget`, so it tracks real new spend, not the context replayed on
/// every turn.
///
/// Spending it stops the run (see `body_session_budget`); `--max-turns` adds a
/// turn cap on top.
const DEFAULT_MAX_SESSION_TOKENS: u64 = 128_000;

/// Where the session token ceiling in effect came from, so `agent status` can
/// say which source won.
///
/// `agent status` takes no budget flag and so always passes `None`, making
/// `"flag"` unreachable from the binary today. It is kept because the argument
/// mirrors `resolve_session_budget` below: a status surface that does accept
/// the flag (or any caller reporting an in-flight run's ceiling) would
/// otherwise report `agent.toml` for a value the flag had overridden.
fn session_budget_source(
    flag: Option<u64>,
    configured: Option<u64>,
    window: Option<u64>,
) -> &'static str {
    match (flag, configured, window) {
        (Some(_), _, _) => "flag",
        (None, Some(_), _) => "agent.toml",
        (None, None, Some(_)) => "context_window",
        (None, None, None) => "default",
    }
}

/// Session token ceiling for one run. Precedence is the per-invocation
/// `--max-session-tokens` flag, then `agent.toml [budget].max_tokens`, then
/// `DEFAULT_MAX_SESSION_TOKENS` - the same flag/config/default shape the
/// sandbox setting resolves with. `0` from either source means unbounded and is
/// carried through as-is (see `body_session_budget`).
/// The money ceiling for a run (upstream #9034): `--max-budget-usd`, then
/// `[budget].max_usd`, then none.
///
/// A ceiling is only meaningful if the run can be priced, and in this fork the
/// price is what a person declared in `<data folder>/prices.toml`. So a model
/// with no declared price is **refused** rather than run uncapped, and a
/// negative limit is refused as a typo. `0` is allowed and honest: it stops at
/// the first billed request. Refused at startup, before any paid request.
/// `[budget].pause_at_usd`, refused at startup when it is not a non-negative
/// amount, like a ceiling typo.
fn validate_pause_at_usd(pause: Option<f64>) -> Result<Option<f64>, String> {
    match pause {
        Some(usd) if !usd.is_finite() || usd < 0.0 => Err(format!(
            "[budget].pause_at_usd must be a non-negative amount in USD, not {usd}"
        )),
        other => Ok(other),
    }
}

fn resolve_cost_ceiling(
    flag: Option<f64>,
    configured: Option<f64>,
    prices: &std::collections::BTreeMap<String, crate::core::agent::spend::Price>,
    model: &str,
) -> Result<Option<crate::core::agent::session::CostCeiling>, String> {
    let Some(max_usd) = flag.or(configured) else {
        return Ok(None);
    };
    if !max_usd.is_finite() || max_usd < 0.0 {
        return Err(format!(
            "a cost ceiling must be a non-negative amount in USD, not {max_usd}"
        ));
    }
    let price = crate::core::agent::spend::price_for(prices, model).ok_or_else(|| {
        format!(
            "cannot cap spend for {model}: no price is declared for it in prices.toml, so \
             there is nothing to meter a ${max_usd} ceiling against. Remove the limit to run \
             uncapped, or declare the model's price (dollars per million tokens)."
        )
    })?;
    // prices.toml is dollars per million tokens.
    let per_token = |per_million: f64| per_million / 1_000_000.0;
    let (cache_read, cache_write) = price.cache_rates(model);
    Ok(Some(crate::core::agent::session::CostCeiling {
        rates: crate::core::agent::session::TokenRates {
            prompt_usd: per_token(price.input),
            completion_usd: per_token(price.output),
            cache_read_usd: Some(per_token(cache_read)),
            cache_write_usd: Some(per_token(cache_write)),
        },
        max_usd,
    }))
}

///
/// `window` is the model's context window, passed only when it is actually
/// known (configured or in the catalog, not the 128K fallback guess). With
/// neither flag nor config, it sets the ceiling: a fixed 128K made a run on a
/// 1M-context model hit its budget and compact long before the window did.
fn resolve_session_budget(flag: Option<u64>, configured: Option<u64>, window: Option<u64>) -> u64 {
    flag.or(configured)
        .or(window)
        .unwrap_or(DEFAULT_MAX_SESSION_TOKENS)
}

/// The context window to derive the session budget from: `Some` only when it
/// was configured or found in the catalog, so an unknown model keeps the
/// default rather than a guess.
fn known_window(window: crate::core::cli::model_capabilities::ResolvedContextWindow) -> Option<u64> {
    (window.source != crate::core::cli::model_capabilities::ContextWindowSource::Fallback)
        .then_some(window.tokens)
}

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

/// Autonomous run: as many turns as the task needs, bounded by a `max_turns`
/// cap when one is set, and by the session token budget.
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
    resume: Option<ResumeRequest>,
    format: OutputFormat,
    input_format: InputFormat,
    host_tools: Option<&str>,
    host_gate: bool,
) -> Result<(), tauri_plugin_agent_tools::harness_error::HarnessError> {
    run_agent_loop(
        project, task, model, false, overrides, flags, resume, format, input_format,
        host_tools,
        host_gate,
    )
    .await
}

/// Single-turn run for debugging: the turn cap is pinned to 1 here and
/// outranks any `--max-turns`.
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
        InputFormat::Text,
        // `step` is a debugging path with no client on stdin, so there is
        // nothing that could execute a host tool.
        None,
        false,
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
    host_tools: crate::core::agent::host_tools::HostToolSet,
    host_tool_requests: crate::core::agent::host_tools::HostToolRegistry,
    auto_approve: bool,
    bypass: bool,
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
        spend_ledger: None,
        dispatch_id: None,
        client: crate::core::agent::upstream::agent_http_client(),
        provider_configs: Arc::new(Mutex::new(provider_configs)),
        mcp_servers,
        mcp_settings: Arc::new(Mutex::new(mcp_settings)),
        jan_data_folder: resolve_jan_data_folder().to_string_lossy().into_owned(),
        permissions,
        project_root: Some(project_root),
        permission_requests,
        host_tools,
        host_tool_requests,
        host_owns_gate: false,
        host_tool_route: None,
        ask_requests: None,
        todo_registry: None,
        system_prompt_override: None,
        subagents_enabled: true,
        max_parallel_subagents,
        auto_approve,
        bypass,
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
        // The top-level run is not a child: no dispatch gave it an id.
        run_id: None,
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
    /// The checkout this run worked in, recorded on the thread so a later
    /// `--resume` reattaches to it.
    workspace: Option<worktree::Worktree>,
    /// `--ephemeral`: nothing about this run is written to the thread store.
    ephemeral: bool,
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
    /// `--max-session-tokens`, else `[budget].max_tokens`, else the model's
    /// known context window, else the default: marginal token-spend ceiling for
    /// one run. `0` is no ceiling.
    ///
    /// Spending it stops the run; `max_turns` is a separate turn cap.
    pub max_session_tokens: u64,
    /// `max_session_tokens` was set by the flag or by `[budget].max_tokens`, so
    /// a model switch leaves it alone. Otherwise it follows the model's window.
    pub max_session_tokens_pinned: bool,
    /// `--max-turns`: hard cap on agentic turns for this run. `None` omits the field from the request
    /// body, which the engine reads as unbounded; `0` means unbounded too (see
    /// `body_turn_cap`).
    pub max_turns: Option<u64>,
    /// `--max-budget-usd`, else `[budget].max_usd`: the run's money ceiling and
    /// the rates to meter it against, resolved once at startup by
    /// `resolve_cost_ceiling`. `None` leaves the run unmetered.
    pub cost_ceiling: Option<crate::core::agent::session::CostCeiling>,
    /// `[budget].pause_at_usd`: the spend at which the run asks once whether
    /// to go on. Metered by `cost_ceiling`'s rates (an infinite ceiling when
    /// only the pause is set). `None` never pauses.
    pub pause_at_usd: Option<f64>,
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
    /// The git worktree this session's tools work in, when it has one. `None`
    /// is the default: the agent edits the project directory itself.
    pub workspace: Option<worktree::Worktree>,
    /// Why a requested worktree could not be set up, for the surface to report.
    /// `Some` only when one was asked for and the session fell back to the
    /// project directory.
    pub workspace_note: Option<String>,
}

/// The request body for one turn, as a free function of the parts that shape
/// it. Split out of [`AgentSession::body`] so the wire contract is testable
/// without standing up an orchestration handle (MCP maps, HTTP client, tool
/// permissions), none of which this assembly reads.
fn request_body(
    model: &str,
    limits: &SessionLimits,
    send_reasoning: bool,
    messages: serde_json::Value,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_session_tokens": limits.max_session_tokens,
        "stream": true,
    });
    // Forward the per-request output cap only when configured; it flows to
    // the upstream via `copy_optional_chat_params`.
    if let Some(max) = limits.max_tokens {
        body["max_tokens"] = serde_json::json!(max);
    }
    // Single place a turn cap enters the body: `agent step` pins 1 the same
    // way `--max-turns` pins N, so both go through `limits`. Absent rather
    // than 0 when unset, so the engine's own default applies.
    if let Some(turns) = limits.max_turns {
        body["max_turns"] = serde_json::json!(turns);
    }
    // The ceiling travels with the rates it is metered against: the loop is
    // not `cli`-gated, so prices resolved here are the only ones it sees.
    if let Some(ceiling) = limits.cost_ceiling {
        // Infinite when the run is metered only for its pause: JSON cannot
        // carry it, and absent is what "no ceiling" means on the body.
        if ceiling.max_usd.is_finite() {
            body["max_budget_usd"] = serde_json::json!(ceiling.max_usd);
        }
        body["token_rates"] = serde_json::json!({
            "prompt_usd": ceiling.rates.prompt_usd,
            "completion_usd": ceiling.rates.completion_usd,
            "cache_read_usd": ceiling.rates.cache_read_usd,
            "cache_write_usd": ceiling.rates.cache_write_usd,
        });
        if let Some(pause) = limits.pause_at_usd {
            body["pause_at_usd"] = serde_json::json!(pause);
        }
    }
    // Reasoning resend policy: the request-level flag the loop reads to
    // decide whether prior assistant `reasoning_content` goes back out.
    body["send_reasoning"] = serde_json::json!(send_reasoning);
    body
}

impl AgentSession {
    /// Build a streaming request body for the given conversation history.
    pub(crate) fn body(&self, messages: serde_json::Value) -> serde_json::Value {
        request_body(&self.model, &self.limits, self.send_reasoning, messages)
    }
}

/// How freely a session acts, named the way the desktop's Cowork modes are.
///
/// * `review`: read-only plan mode; leaving it needs the plan approved.
/// * `ask`: writes, shell commands and MCP calls prompt (`--safe`).
/// * `auto`: those run unprompted, inside the sandbox when it is on (default).
/// * `bypass`: as `auto`, and nothing a person could answer is asked:
///   `host_*`, `computer`, clipboard, destructive commands, writes outside the
///   project. Plan mode, deny rules and the judge still refuse, and say so.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    Review,
    Ask,
    Auto,
    Bypass,
}

impl PermissionMode {
    pub fn parse(s: &str) -> Result<PermissionMode, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "review" => Ok(PermissionMode::Review),
            "ask" => Ok(PermissionMode::Ask),
            "auto" => Ok(PermissionMode::Auto),
            "bypass" => Ok(PermissionMode::Bypass),
            other => Err(format!("unknown mode '{other}' (review, ask, auto, bypass)")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            PermissionMode::Review => "review",
            PermissionMode::Ask => "ask",
            PermissionMode::Auto => "auto",
            PermissionMode::Bypass => "bypass",
        }
    }

    /// Whether writes, shell commands and MCP calls run without a prompt.
    pub fn auto_approve(self) -> bool {
        matches!(self, PermissionMode::Auto | PermissionMode::Bypass)
    }

    /// Whether every prompt a person could answer is skipped.
    pub fn bypass(self) -> bool {
        self == PermissionMode::Bypass
    }

    /// Whether the session is read-only plan mode.
    pub fn plan(self) -> bool {
        self == PermissionMode::Review
    }

    /// Whether a start-up `--mode` names Bypass.
    pub fn requests_bypass(mode: Option<&str>) -> bool {
        mode.map(|m| PermissionMode::parse(m) == Ok(PermissionMode::Bypass)).unwrap_or(false)
    }

    /// `(auto_approve, plan)` for a start-up request: `--mode` when given,
    /// else the older `--safe` and `--plan` switches.
    pub fn resolve(mode: Option<&str>, safe: bool, plan: bool) -> Result<(bool, bool), String> {
        match mode {
            Some(m) => {
                if safe || plan {
                    return Err("--mode replaces --safe and --plan; give one or the other".to_string());
                }
                let m = PermissionMode::parse(m)?;
                // Review reads only, so what it would approve never comes up.
                Ok((m.auto_approve(), m.plan()))
            }
            None => Ok((!safe, plan)),
        }
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
    /// Bypass: also skip the prompts `auto_approve` leaves (host tools,
    /// destructive commands, writes outside the project). Implies `auto_approve`.
    pub bypass: bool,
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
    /// `--worktree`: work in a dedicated git checkout. `None` (not passed)
    /// defers to `[agent].worktree`, then the global `worktree`, then the CLI
    /// default of off.
    pub worktree: Option<bool>,
    /// `--max-turns`: hard cap on agentic turns. `None` (not passed) leaves the run unbounded by turns; `0`
    /// is unbounded as well.
    pub max_turns: Option<u64>,
    /// `--max-session-tokens`: session token ceiling, outranking
    /// `[budget].max_tokens`. `None` (not passed) defers to that, then to
    /// `DEFAULT_MAX_SESSION_TOKENS`.
    pub max_session_tokens: Option<u64>,
    /// `--max-budget-usd`: hard USD ceiling for the run, outranking
    /// `[budget].max_usd`. A run that asks for one but cannot be priced is
    /// refused (see `resolve_cost_ceiling`).
    pub max_budget_usd: Option<f64>,
    /// `--append-system-prompt[-file]`: text added to this run's system prompt.
    pub append_system_prompt: Option<String>,
    /// `--allow-tool`: the run may use only these tools (empty: no restriction).
    pub allow_tools: Vec<String>,
    /// `--deny-tool`: tools withheld from this run, on top of the project's denies.
    pub deny_tools: Vec<String>,
    /// `--effort`: reasoning effort for this run.
    pub effort: Option<String>,
    /// `--ephemeral`: do not write the session to disk.
    pub ephemeral: bool,
    /// `--json-schema`: the final answer must validate against this schema.
    pub json_schema: Option<serde_json::Value>,
    /// `--json-schema-attempts`: repair attempts before giving up.
    pub json_schema_attempts: Option<u64>,
}

/// Check the names `--allow-tool`/`--deny-tool` carry, by the rule a schedule's
/// allow-list uses (`Policy::validate`), except that a deny list may be empty.
pub fn validate_tool_flags(allow: &[String], deny: &[String]) -> Result<(), String> {
    use crate::core::schedule::spec::{Policy, WriteMode};
    if !allow.is_empty() {
        Policy { allow_tools: allow.to_vec(), write: WriteMode::ReadOnly }
            .validate()
            .map_err(|e| format!("--allow-tool: {e}"))?;
    }
    if !deny.is_empty() {
        Policy { allow_tools: deny.to_vec(), write: WriteMode::ReadOnly }
            .validate()
            .map_err(|e| format!("--deny-tool: {e}"))?;
    }
    Ok(())
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

/// The newest workspace snapshot a thread recorded, which is where a fork of it
/// should start its own checkout: the files as that conversation last left them,
/// rather than a `HEAD` its whole transcript predates.
fn latest_snapshot(thread: Option<&serde_json::Value>) -> Option<String> {
    let metadata = thread?.get("metadata")?;
    metadata
        .get("checkpoints")
        .and_then(|c| c.as_array())
        .and_then(|c| c.last())
        .and_then(|c| c.get("sha"))
        .or_else(|| metadata.get("base_snapshot"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// The metadata to save a thread with so it names the checkout the run worked
/// in, merged into whatever that thread already recorded rather than replacing
/// it. `None` when there is no worktree, which is `cli_save_thread`'s "keep the
/// existing metadata" case.
///
/// Without this a resumed session branches a *fresh* worktree and the model
/// reads a pristine tree, silently losing everything the run it is continuing
/// did in there.
fn worktree_metadata(
    agent_dir: &std::path::Path,
    thread_id: Option<&str>,
    workspace: Option<&worktree::Worktree>,
) -> Option<serde_json::Value> {
    let workspace = workspace?;
    let mut meta = thread_id
        .and_then(|id| cli_get_thread_in(agent_dir, id).ok())
        .and_then(|thread| thread.get("metadata")?.as_object().cloned())
        .unwrap_or_default();
    meta.insert(
        worktree::WORKTREE_KEY.to_string(),
        worktree::to_metadata(workspace),
    );
    Some(serde_json::Value::Object(meta))
}

/// The commit a fork's checkout starts from.
///
/// The newest snapshot the source thread recorded is the best answer: it is the
/// tree that conversation last left. A headless run takes no snapshots (they are
/// the TUI's per-turn checkpoints), so fall back to capturing the source's
/// worktree as it stands -- otherwise the branch opens on a pristine `HEAD`
/// while the transcript it inherited describes work that is not in it, and the
/// model's first act is to re-read files that disagree with what it just said.
///
/// `None` leaves the choice to `HEAD`, which is right when the source never had
/// a checkout of its own.
fn fork_base(source: Option<&serde_json::Value>) -> Option<String> {
    use crate::core::agent::git;

    if let Some(sha) = latest_snapshot(source) {
        return Some(sha);
    }
    let source = source?;
    let workspace = worktree::from_metadata(source.get("metadata"))?;
    if !workspace.path.is_dir() {
        return None;
    }
    // Keyed per source thread and cleaned up: this index is a one-shot, unlike
    // the per-thread one a session keeps warm across its turns.
    let key = format!("fork-base-{}", source.get("id")?.as_str()?);
    let changed: Vec<PathBuf> = git::changed_paths(&workspace.path)
        .into_iter()
        .map(PathBuf::from)
        .collect();
    let sha = git::snapshot(&workspace.path, None, "jan agent fork base", &key, &changed).ok();
    git::cleanup_snapshot_index(&key);
    sha
}

/// Decide the checkout this session's tools work in.
///
/// A plain resume reattaches to the worktree its thread recorded. A fork is a
/// *different* thread, so it branches its own from where the source left off --
/// two conversations editing one checkout is the thing a worktree exists to
/// prevent. A session that cannot get the worktree it asked for runs in the
/// project directory and says why, because that fallback is exactly how every
/// session behaved before worktrees existed.
fn resolve_workspace(
    project_root: &std::path::Path,
    flag: Option<bool>,
    resume: Option<&ResumeRequest>,
) -> (Option<worktree::Worktree>, Option<String>) {
    let configured = crate::core::agent::project::run_settings(project_root).worktree;
    if !worktree::resolve_enabled(flag, configured) {
        return (None, None);
    }
    let forking = resume.is_some_and(|request| request.fork);
    let source = resume
        .and_then(|request| find_resume_thread(&agent_dir_for(project_root), &request.target).ok());
    let recorded = if forking {
        None
    } else {
        worktree::from_metadata(source.as_ref().and_then(|t| t.get("metadata")))
    };
    let base = forking.then(|| fork_base(source.as_ref())).flatten();
    match worktree::for_session(project_root, recorded.as_ref(), base.as_deref()) {
        // A different path than the one recorded means the checkout was gone and
        // a fresh one was branched from HEAD: nothing was committed there, so the
        // resumed conversation now describes edits this tree does not have.
        Ok(workspace) => {
            let note = recorded
                .filter(|old| old.path != workspace.path)
                .map(|old| {
                    format!(
                        "the checkout this thread recorded ({}) is gone; starting fresh from HEAD",
                        old.path.display()
                    )
                });
            (Some(workspace), note)
        }
        Err(e) => (None, Some(format!("no worktree for this session: {e}"))),
    }
}

/// Resolve project config + credentials into a ready-to-run engine handle.
/// Shared by `run_agent_loop` (plain CLI) and `cli_agent_ui` (TUI).
pub(crate) fn prepare_agent_session(
    project: &str,
    model_override: Option<String>,
    overrides: ProviderOverrides,
    flags: SessionFlags,
    resume: Option<&ResumeRequest>,
) -> Result<AgentSession, String> {
    let project_root = resolve_project_root(project);
    ensure_project(&project_root)?;
    if let Err(e) = crate::core::agent::global_config::ensure_global_config() {
        log::warn!("Agent: could not scaffold ~/.jan/config.toml: {e}");
    }
    // AH-186: the run's settings are the project's, with the chosen profile
    // folded in. An unknown profile is refused here -- before a provider, a
    // tool or a model is resolved from settings nobody asked for.
    let mut cfg = load_agent_config_with_profile(&project_root, flags.profile.as_deref())?;
    validate_tool_flags(&flags.allow_tools, &flags.deny_tools)?;
    // `--deny-tool` only adds to the project's denies; it can never lift one.
    cfg.tools.deny.extend(flags.deny_tools.iter().cloned());
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
        // Under `flint serve`, the model its browser selected outranks the
        // user-wide default, as the browser's providers outrank `~/.jan`.
        .or_else(crate::core::cli::providers::server_selected_model)
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
        .map_err(|e| e.message().to_string())?;
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

    let mut provider_configs = load_provider_configs(Some(&project_root), &overrides)?;

    // `--provider` names the provider the run goes to, by id or by the name
    // the desktop app shows. Without pinning, upstream resolution picks
    // whichever provider serves the model id first, which may be another one.
    if let Some(requested) = overrides.provider.as_deref().filter(|_| overrides.pin) {
        crate::core::cli::providers::pin_provider(&mut provider_configs, requested, &model)?;
    }

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
    let mcp_task = if mcp::active_count() > 0 && !tauri_plugin_agent_tools::safe_mode::active() {
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
    // The tools work in the worktree when there is one; everything else about
    // the session (agent.toml, credentials, the thread store) stays keyed to the
    // project, which is where the user configured it.
    let (workspace, workspace_note) = resolve_workspace(&project_root, flags.worktree, resume);
    let tool_root = workspace
        .as_ref()
        .map(|w| w.path.clone())
        .unwrap_or_else(|| project_root.clone());
    let args = build_cli_orchestration_args(
        tool_root,
        permissions,
        provider_configs,
        mcp_servers.clone(),
        mcp_settings,
        permission_requests.clone(),
        // Host tools are declared per *run*, by a client on stdin, so the
        // session is built without them and the duplex headless path installs
        // the declared set before orchestration starts. The TUI leaves this
        // empty, and `run_subagent` clears it for a child, so neither emits a
        // `tool_request` -- only a run with a client that can answer one does.
        crate::core::agent::host_tools::HostToolSet::new(),
        crate::core::agent::host_tools::new_registry(),
        flags.auto_approve,
        flags.bypass,
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

    // Resolved before the session is built: a run that asked for a ceiling it
    // cannot be priced against is refused here, before any paid request.
    let pause_at_usd = validate_pause_at_usd(cfg.budget.pause_at_usd)?;
    let cost_ceiling = match flags.max_budget_usd.or(cfg.budget.max_usd).or(pause_at_usd) {
        None => None,
        Some(_) => {
            let prices = crate::core::agent::spend::prices(
                &crate::core::app::commands::resolve_jan_data_folder(),
            )
            .map_err(|e| e.message)?;
            match flags.max_budget_usd.or(cfg.budget.max_usd) {
                Some(_) => resolve_cost_ceiling(flags.max_budget_usd, cfg.budget.max_usd, &prices, &model)?,
                // Only a pause: priced the same way, against no ceiling.
                None => resolve_cost_ceiling(None, pause_at_usd, &prices, &model)?.map(|c| {
                    crate::core::agent::session::CostCeiling { max_usd: f64::INFINITY, ..c }
                }),
            }
        }
    };

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
            max_session_tokens: resolve_session_budget(
                flags.max_session_tokens,
                cfg.budget.max_tokens,
                known_window(resolved_window),
            ),
            max_session_tokens_pinned: flags.max_session_tokens.is_some()
                || cfg.budget.max_tokens.is_some(),
            max_turns: flags.max_turns,
            cost_ceiling,
            pause_at_usd,
        },
        show_reasoning: cfg.agent.show_reasoning.unwrap_or(false),
        stream_reasoning: crate::core::agent::global_config::stream_reasoning_enabled(),
        send_reasoning: cfg.agent.send_reasoning.unwrap_or(true),
        mcp_servers,
        mcp_task,
        workspace,
        workspace_note,
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
    request: &ResumeRequest,
) -> Result<ResumedSession, String> {
    let thread = resolve_resume(agent_dir, request)?;
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
    resume: Option<ResumeRequest>,
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
            // `agent step` is a single turn by definition and outranks any
            // flag; `agent run` carries whatever `--max-turns` asked for.
            max_turns: if single_turn { Some(1) } else { flags.max_turns },
            ..flags.clone()
        },
        resume.as_ref(),
    )?;
    let project_root = resolve_project_root(project);
    if let Some(note) = session.workspace_note.as_deref() {
        eprintln!("({note})");
    }
    if let Some(workspace) = session.workspace.as_ref() {
        eprintln!(
            "(working in {} on {})",
            workspace.path.display(),
            workspace.branch
        );
    }
    // `@path` names a file the agent is about to work on, so it resolves against
    // the checkout the tools see rather than the project directory.
    let read_root = session
        .workspace
        .as_ref()
        .map(|w| w.path.clone())
        .unwrap_or_else(|| project_root.clone());
    let (clean_task, injected) = path_refs::resolve_references_with(task, &read_root, false);
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
    if !flags.allow_tools.is_empty() {
        body["allowed_tools"] = serde_json::json!(flags.allow_tools);
    }
    if let Some(effort) = flags.effort.as_deref() {
        body["reasoning_effort"] = serde_json::json!(effort);
    }
    let mut append = flags.append_system_prompt.clone().unwrap_or_default();
    if let Some(schema) = flags.json_schema.as_ref() {
        body["jan_json_schema"] = schema.clone();
        if let Some(n) = flags.json_schema_attempts {
            body["jan_json_schema_attempts"] = serde_json::json!(n);
        }
        if !append.is_empty() {
            append.push_str("\n\n");
        }
        append.push_str(&format!(
            "Your final answer must be a single JSON value that validates against this JSON Schema, with no prose and no code fence:\n{schema}"
        ));
    }
    if !append.trim().is_empty() {
        body["jan_append_system_prompt"] = serde_json::json!(append);
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
            workspace: session.workspace,
            ephemeral: flags.ephemeral,
        },
    })
}

/// First 8 chars of a thread id, the form the TUI shows in `/threads`.
fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

/// Read a host's tool declarations from the file `--host-tools` names.
///
/// Every failure is the host's to fix and is reported with the path, since a
/// host that mistyped one is otherwise left guessing which of its tools the run
/// disagreed with.
fn load_host_tools(path: &str) -> Result<crate::core::agent::host_tools::HostToolSet, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read --host-tools file '{path}': {e}"))?;
    let decls: Vec<crate::core::agent::host_tools::HostToolDecl> = serde_json::from_str(&raw)
        .map_err(|e| format!("--host-tools file '{path}' is not a list of tool declarations: {e}"))?;
    crate::core::agent::host_tools::HostToolSet::declare(decls)
        .map_err(|e| format!("--host-tools file '{path}': {e}"))
}

#[allow(clippy::too_many_arguments)]
async fn run_agent_loop(
    project: &str,
    task: &str,
    model_override: Option<String>,
    single_turn: bool,
    overrides: ProviderOverrides,
    flags: SessionFlags,
    resume: Option<ResumeRequest>,
    format: OutputFormat,
    input_format: InputFormat,
    host_tools: Option<&str>,
    host_gate: bool,
) -> Result<(), tauri_plugin_agent_tools::harness_error::HarnessError> {
    // A duplex run switches off both of the CLI's own answer paths, so the
    // client is the only thing that can resolve a permission request -- and it
    // can only do that if it is being told the request ids. `text` prints them
    // to stderr and `json` prints nothing at all until the run ends, so either
    // pairing leaves a gated call unanswerable. Rejected rather than silently
    // upgraded: a caller parsing plain text should not have the format changed
    // under it.
    let started = std::time::Instant::now();
    // Read before the flags are handed on: this is the run's own answer about
    // how much to say, and it is wanted after the run as well as during it.
    let asked_density = flags.density;
    // Every refusal below is a setup failure like any other, so it is reported
    // the way `prepare_agent_run`'s is: one `result` record with
    // `error.code: "setup_error"`. Returning early instead would leave a
    // machine consumer an empty stdout and a human string on stderr, which is
    // the one thing this channel promises never to do -- and a mistyped
    // `--host-tools` path is the first failure a host is likely to hit.
    let setup = (|| {
        if input_format.is_stream_json() && !format.is_stream_json() {
            return Err(
                "--input-format stream-json requires --output-format stream-json (the client \
                 answers permission requests, so it must be reading them)"
                    .to_string(),
            );
        }
        // Declared before anything is spent: a malformed or unacceptable tool
        // set is the host's own mistake, and finding out at the first call --
        // mid-task, after paid requests -- is worse than refusing to start.
        // Handing the gate to a host that declared no tools would be a no-op
        // the caller probably did not mean; say so rather than ignore it.
        if host_gate && host_tools.is_none() {
            return Err("--host-gate requires --host-tools".to_string());
        }
        match host_tools {
            Some(path) => {
                if !input_format.is_stream_json() {
                    return Err(
                        "--host-tools requires --input-format stream-json (a host tool call is \
                         answered with a tool_result message on stdin)"
                            .to_string(),
                    );
                }
                load_host_tools(path)
            }
            None => Ok(crate::core::agent::host_tools::HostToolSet::new()),
        }
    })();
    let host_tools = match setup {
        Ok(host_tools) => host_tools,
        Err(e) => {
            if format.is_machine() {
                print_report(
                    format,
                    RunReport::setup_failure(&e).finish(
                        None,
                        "",
                        started.elapsed().as_millis(),
                        None,
                    ),
                );
            }
            return Err(tauri_plugin_agent_tools::harness_error::HarnessError::new(
                tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
                e,
            )
            .at(tauri_plugin_agent_tools::harness_error::Stage::Startup));
        }
    };
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
        mut args,
        body,
        limits,
        permission_requests,
        mcp_task,
        persist,
    } = match prepared {
        Ok(prepared) => prepared,
        Err(e) => {
            if format.is_machine() {
                print_report(
                    format,
                    RunReport::setup_failure(&e).finish(
                        None,
                        "",
                        started.elapsed().as_millis(),
                        None,
                    ),
                );
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
    // Installed after the session is built, since host tools are declared per
    // run rather than per project: the same session config serves a run with
    // them and one without.
    args.host_tools = host_tools;
    // `--host-gate`: the host's own callback is the approval step, so Jan
    // raises no `permission_request` for a host tool of any class.
    args.host_owns_gate = host_gate;

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
    // The session this run saves under, decided here rather than at save time
    // so the `init` record can name it: a client learns the id it can `--resume`
    // from the first line of the stream, and a run killed mid-flight still told
    // it which id to look for.
    let session_id = persist
        .thread_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    // The run's own id becomes the session id, so the one a client is handed,
    // the one its requests are correlated under, and the one a provenance
    // record names are the same id: three spellings of a session would only
    // ever be a way to lose the thread between them.
    args.session_id = Some(session_id.clone());

    // The handshake, before anything else can reach stdout. Printed here rather
    // than from the printer task for exactly that reason: nothing has been
    // spawned yet, so "first line" is a property of the code's order rather than
    // a race against the run's own events.
    if format.is_stream_json() {
        print_json_line(&init_record(&args, &session_id, &persist.model, input_format).await);
    }

    // The client on stdin, when there is one: it owns every permission decision
    // and can steer or stop the run while it is in flight.
    let input = input_format
        .is_stream_json()
        .then(|| Arc::new(StreamInput::default()));
    // Created before the reader so it can report the host requests it releases
    // on the same channel as the run's events: the printer then orders those
    // records before the final result, which it prints only once every sender
    // (the reader's included) has dropped.
    let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
    let reader = input.as_ref().map(|input| {
        spawn_input_reader(
            Arc::clone(input),
            Arc::clone(&permission_requests),
            Arc::clone(&args.host_tool_requests),
            tx.clone(),
            format,
        )
    });
    let client = input.clone();
    let host_tool_requests = Arc::clone(&args.host_tool_requests);

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
    if let Some(thread) = persist.thread_id.as_deref().filter(|_| !persist.ephemeral) {
        let meta = worktree_metadata(&persist.agent_dir, Some(thread), persist.workspace.as_ref());
        if let Err(e) = cli_save_thread(&persist.agent_dir, Some(thread), &persist.model, &persist.history, meta) {
            eprintln!("(could not save session before the run: {e})");
        }
    }
    let writer = match persist.thread_id.as_deref().filter(|_| !persist.ephemeral) {
        Some(thread) => match inflight::Writer::begin(
            &get_thread_dir(&persist.agent_dir, thread),
            &persist.model,
            persist.history.clone(),
        ) {
            Ok(w) => Some(w),
            Err(e) => {
                // The init line is already out: close the stream with a result
                // line so a JSON consumer is not left waiting for one.
                if format.is_machine() {
                    print_report(
                        format,
                        RunReport::setup_failure(&e.to_string()).finish(
                            None,
                            "",
                            started.elapsed().as_millis(),
                            None,
                        ),
                    );
                }
                return Err(e);
            }
        },
        None => None,
    };
    let checkpoint = std::sync::Arc::new(std::sync::Mutex::new(writer));
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
            if let StreamEvent::TurnUsage { usage, .. } = &ev {
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
                            "\n{}",
                            color::paint(
                                "33",
                                format_args!(
                                    "[context] {}",
                                    crate::core::agent::context_pressure::line(&found),
                                ),
                            ),
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
            // Asked per event, not once per run: the client owns the decision
            // only while it is still reading. Once stdin has closed, the CLI
            // takes its own path back, which on a pipe is an auto-deny.
            let duplex = client.as_ref().is_some_and(|c| !c.client_gone());
            // Only the client can answer a host tool call. If it has already
            // left, the call is failed here: `strand_all` fired when stdin
            // closed, so nothing else will ever release this one and the turn
            // would park forever.
            if let StreamEvent::ToolRequest { request_id, .. } = &ev {
                if !duplex {
                    // The request is already on stdout, so its withdrawal is
                    // too; printed here because this task is the stream's order.
                    if crate::core::agent::host_tools::strand(&host_tool_requests, request_id)
                        .await
                    {
                        let cancelled = request_cancelled(request_id, CANCEL_CLIENT_GONE);
                        report.observe(&cancelled);
                        if format.is_stream_json() {
                            print_json_line(&cancelled);
                        }
                    }
                    continue;
                }
            }
            match format {
                OutputFormat::Text => {
                    print_event(ev, &permission_requests, density, duplex).await
                }
                OutputFormat::Json => {
                    resolve_permission_silently(ev, &permission_requests, duplex).await;
                }
                OutputFormat::StreamJson => {
                    print_json_line(&ev);
                    if let Some((request_id, decision)) =
                        resolve_permission_silently(ev, &permission_requests, duplex).await
                    {
                        print_json_line(&PermissionDecisionRecord::new(&request_id, decision));
                    }
                }
            }
        }
        (report, conversation)
    });

    // `None` when the client aborted: the run produced no completion, but a
    // deliberate stop is an outcome rather than a failure, so it is reported on
    // the stream and the process still exits 0.
    let outcome = match input.as_ref() {
        Some(input) => run_steered(&tx, &body, &args, input).await,
        None => Some(run_orchestration_streamed(&tx, &body, &args).await),
    };
    if let Some(reader) = reader {
        reader.abort();
    }
    // A request still registered now belongs to a call the run dropped (it
    // failed or stopped mid-batch); nothing will await its answer, so the host
    // is told to stop working on it before the result record closes the stream.
    for id in crate::core::agent::host_tools::cancel_all(&args.host_tool_requests).await {
        let _ = tx.send(request_cancelled(&id, CANCEL_ABORTED));
    }
    let aborted = outcome.is_none();
    let result = outcome.unwrap_or_else(|| Err(ABORTED_BY_CLIENT.into()));
    drop(tx);
    let (mut report, conversation) = printer.await.unwrap_or_default();
    if let Some(input) = input.as_ref() {
        report_dropped_follow_ups(input, format);
    }

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
    let structured = result.as_ref().ok().and_then(|c| c.get("structured_output").cloned());
    let structured_error = result
        .as_ref()
        .ok()
        .and_then(|c| c.get("structured_output_error"))
        .and_then(|v| v.as_str().map(str::to_string));
    report.set_structured(structured.clone(), structured_error.clone());
    let persisted = persist_headless_run(persist, &result, conversation, Some(&session_id));
    let (session_id, final_text) = (persisted.session_id, persisted.final_text);
    // Saved, so nothing is in flight any more. A run that failed before its
    // thread could be written keeps its checkpoint: its completed steps are
    // still the only copy.
    if persisted.saved || result.is_ok() {
        if let Some(writer) = checkpoint.lock().ok().and_then(|mut g| g.take()) {
            writer.finish();
        }
    }
    if persisted.saved && !format.is_machine() {
        if let Some(id) = session_id.as_deref() {
            eprintln!(
                "{}",
                color::paint(
                    "2",
                    format_args!(
                        "[session {} - resume with `flint --resume={}`]",
                        short_id(id),
                        short_id(id),
                    ),
                ),
            );
        }
    }
    if format.is_machine() {
        print_report(
            format,
            report.finish(
                session_id.as_deref().map(short_id).as_deref(),
                &model,
                started.elapsed().as_millis(),
                final_text.as_deref(),
            ),
        );
    }
    // The validated value on its own line, for a caller reading stdout in text
    // mode. Machine formats carry it as `structured_output` in the result.
    if !format.is_machine() {
        if let Some(value) = structured.as_ref() {
            println!("{value}");
        }
    }
    if let Some(reason) = structured_error.as_deref() {
        eprintln!("Error: the final answer never validated against --json-schema: {reason}");
    }
    // The stream belongs to this run (AH-183); a later command in the same
    // process is not it.
    tauri_plugin_agent_tools::event_log::unwatch();
    // The one-shot CLI runs exactly one turn, so its session ends here: wipe
    // the persistent bash `/tmp` scratch this run used.
    if let Some(session) = args.session_id.as_deref() {
        let _ = workspace::remove_scratch_dir(session).await;
    }
    if aborted {
        return Ok(());
    }
    if let Some(reason) = structured_error {
        return Err(tauri_plugin_agent_tools::harness_error::HarnessError::new(
            tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
            format!("the final answer never validated against --json-schema: {reason}"),
        ));
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
    save_as: Option<&str>,
) -> PersistedRun {
    let PersistTarget {
        agent_dir,
        thread_id,
        model,
        mut history,
        workspace,
        ephemeral,
    } = persist;
    let mut session_id = thread_id.clone();
    let mut final_text = None;
    let mut saved = false;
    if ephemeral {
        // Not written anywhere, and not resumable: the answer is all there is.
        return PersistedRun {
            session_id: None,
            final_text: result.as_ref().ok().and_then(completion_text),
            saved: false,
        };
    }
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
        let save_id = thread_id.as_deref().or(save_as);
        let meta = worktree_metadata(&agent_dir, save_id, workspace.as_ref());
        match cli_save_thread(&agent_dir, save_id, &model, &history, meta) {
            Ok(id) => {
                session_id = Some(id);
                saved = true;
            }
            Err(e) => eprintln!("(could not save session: {e})"),
        }
    }
    PersistedRun { session_id, final_text, saved }
}

/// The `init` handshake of a `--output-format stream-json` run, assembled from
/// the same parts the run itself uses: the session it saves under, the model it
/// dispatches to, and the tools its first turn will advertise, so the record
/// cannot describe a run other than this one.
async fn init_record(
    args: &OrchestrationArgs,
    session_id: &str,
    model: &str,
    input_format: InputFormat,
) -> Init {
    let tools: Vec<String> = crate::core::agent::r#loop::context_advertised_tools(
        &args.mcp_servers,
        &args.mcp_settings,
        &args.permissions,
        args.project_root.as_deref(),
        args.run_mode,
        args.subagents_enabled,
        args.max_parallel_subagents,
        args.ask_requests.is_some(),
        args.todo_registry.is_some(),
        &args.host_tools,
    )
    .await
    .iter()
    .filter_map(tool_name)
    .collect();
    // Only the host tools' schemas are echoed, not every advertised tool's: the
    // host is comparing these against what it sent, and a built-in's schema is
    // this process's own business.
    //
    // Filtered to what `tools` actually advertises rather than to everything
    // declared. A deny list, an allowlist or Plan mode can withhold a host tool,
    // and a host that saw its schema echoed anyway would conclude the tool was
    // live and wait for a call that is never coming. Echoing the advertised set
    // lets it detect the suppression instead.
    let tool_specs = args
        .host_tools
        .schemas()
        .into_iter()
        .filter(|spec| {
            tool_name(spec).is_some_and(|name| tools.iter().any(|t| t == &name))
        })
        .collect();
    // The project root the run's tools are confined to, as the run itself sees
    // it. A caller that built these args without one gets `null`: any path
    // substituted here would claim a confinement the run does not have.
    let cwd = args
        .project_root
        .as_deref()
        .map(|root| root.to_string_lossy().into_owned());
    // A run that does not read stdin accepts nothing, and says so: an empty
    // list is a client's answer that there is no reply path, which is more use
    // than an absent field or a list of kinds the run will ignore.
    let input_kinds = if input_format.is_stream_json() {
        INPUT_KINDS.to_vec()
    } else {
        Vec::new()
    };
    // The caps go with the kinds: a client that can send an image should learn
    // the limits from the handshake rather than by having a message rejected.
    let input_content_parts = input_format
        .is_stream_json()
        .then(InputContentParts::current);
    Init::new(
        session_id,
        model,
        cwd,
        tools,
        tool_specs,
        input_kinds,
        input_content_parts,
    )
}

/// A rendered tool schema's name, out of the OpenAI `{"type":"function",
/// "function":{"name":…}}` shape the advertised array carries.
fn tool_name(tool: &serde_json::Value) -> Option<String> {
    Some(tool.get("function")?.get("name")?.as_str()?.to_string())
}

/// Stop reason reported for a run the client ended with an `abort` message, and
/// the error the run itself returns -- never printed, since an abort exits 0.
const ABORTED_BY_CLIENT: &str = "aborted by client";

/// Drive the run against a duplex client: the orchestration loop's steering
/// handshake is answered from the queue the reader fills, and an `abort`
/// message drops the run. `None` is that abort.
///
/// Dropping the orchestration future is what stops the run, so anything it was
/// awaiting (an upstream request, a tool) is cancelled where it stands; a child
/// process a `bash` call had already spawned outlives it, as it does on the
/// TUI's cancel path.
async fn run_steered(
    tx: &mpsc::UnboundedSender<StreamEvent>,
    body: &serde_json::Value,
    args: &OrchestrationArgs,
    input: &Arc<StreamInput>,
) -> Option<Result<serde_json::Value, tauri_plugin_agent_tools::harness_error::HarnessError>> {
    let (steering_tx, mut steering_rx) = mpsc::unbounded_channel::<SteeringRequest>();
    let queue = Arc::clone(input);
    let steerer = tokio::spawn(async move {
        while let Some(request) = steering_rx.recv().await {
            // Empty is the normal answer: the loop asks at every turn boundary.
            let _ = request.reply.send(queue.take_queued());
        }
    });
    let outcome = tokio::select! {
        result = run_orchestration_steered(tx, body, args, Some(&steering_tx)) => Some(result),
        _ = input.aborted() => {
            // A host still holding a request must be told to drop it: the run
            // it would answer is gone. Released here, not by the reader, so
            // the records land before `done` and cannot race the reader's
            // shutdown; `cancel_all` rather than `strand_all` so a child still
            // awaiting one is told it was cancelled, not that the host left.
            for id in crate::core::agent::host_tools::cancel_all(&args.host_tool_requests).await {
                let _ = tx.send(request_cancelled(&id, CANCEL_ABORTED));
            }
            // The loop emits its own terminal event; an abort pre-empts it, so
            // the report is given one here or it would read as a clean stop.
            let _ = tx.send(StreamEvent::Done {
                stop_reason: "aborted".to_string(),
                usage: None,
            });
            None
        }
    };
    steerer.abort();
    outcome
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
        None,
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
    // The parent checked the project's spawn allowlist; a spec written by
    // anything else is held to it here too.
    sub::check_project_spawn_allowed(&project_root, &spec.subagent_name)
        .map_err(|e| HarnessError::new(ErrorKind::PolicyViolation, e.to_string()).at(Stage::Child))?;
    let registry = SubagentRegistry::load(&project_root);
    let request = SubagentRequest {
        subagent_name: spec.subagent_name.clone(),
        description: spec.description.clone(),
        allowed_tools: spec.allowed_tools.clone(),
        system_prompt: spec.system_prompt.clone(),
        isolate: Some(false),
        fork_context: false,
        durable: true,
        max_turns: spec.max_turns,
        title: None,
    };
    let resolved = sub::resolve_dispatch(&registry, &request, &args.permissions)
        .map_err(|e| HarnessError::new(ErrorKind::InvalidInput, e.to_string()).at(Stage::Child))?;
    let child_args = sub::configure_child_args(args, &resolved, &spec.dispatch_id);
    let parent = sub::ParentRun {
        routing: Vec::new(),
        conversation: None,
        model: spec.model.clone(),
        budget_remaining: spec.max_session_tokens,
        token_rates: None,
        usd_remaining: None,
        send_reasoning: spec.send_reasoning,
        model_settings: sub::load_model_settings(),
    };
    let mut body = sub::child_body(&resolved, &spec.description, &parent, None, spec.max_turns);
    if spec.max_turns.is_none() {
        // A durable job that asked for no limit is unbounded, as it always was.
        body["max_turns"] = serde_json::json!(0);
    }
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
/// `tool_request_cancelled` reasons this surface raises: the client stopped the
/// run, or it can no longer answer (stdin closed).
const CANCEL_ABORTED: &str = "aborted";
const CANCEL_CLIENT_GONE: &str = "client_gone";

fn request_cancelled(request_id: &str, reason: &str) -> StreamEvent {
    StreamEvent::ToolRequestCancelled {
        request_id: request_id.to_string(),
        reason: reason.to_string(),
    }
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
    resume: Option<ResumeRequest>,
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
        resume.as_ref(),
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

#[cfg(test)]
mod tests;
