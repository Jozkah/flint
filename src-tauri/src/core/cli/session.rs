//! Agent session setup: budgets, flags, permission mode, workspace and
//! resume resolution, and the interactive console entry point. Moved
//! verbatim out of `mod.rs`.

use super::*;

/// Token-spend ceiling for one agent run when `agent.toml [budget].max_tokens`
/// is unset and the model's context window is not known (see
/// `resolve_session_budget`). `0` disables the ceiling entirely. Counted marginally by
/// `SessionBudget`, so it tracks real new spend, not the context replayed on
/// every turn.
///
/// Spending it stops the run (see `body_session_budget`); `--max-turns` adds a
/// turn cap on top.
pub(super) const DEFAULT_MAX_SESSION_TOKENS: u64 = 128_000;

/// Where the session token ceiling in effect came from, so `agent status` can
/// say which source won.
///
/// `agent status` takes no budget flag and so always passes `None`, making
/// `"flag"` unreachable from the binary today. It is kept because the argument
/// mirrors `resolve_session_budget` below: a status surface that does accept
/// the flag (or any caller reporting an in-flight run's ceiling) would
/// otherwise report `agent.toml` for a value the flag had overridden.
pub(super) fn session_budget_source(
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
pub(super) fn validate_pause_at_usd(pause: Option<f64>) -> Result<Option<f64>, String> {
    match pause {
        Some(usd) if !usd.is_finite() || usd < 0.0 => Err(format!(
            "[budget].pause_at_usd must be a non-negative amount in USD, not {usd}"
        )),
        other => Ok(other),
    }
}

pub(super) fn resolve_cost_ceiling(
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
pub(super) fn resolve_session_budget(flag: Option<u64>, configured: Option<u64>, window: Option<u64>) -> u64 {
    flag.or(configured)
        .or(window)
        .unwrap_or(DEFAULT_MAX_SESSION_TOKENS)
}

/// The context window to derive the session budget from: `Some` only when it
/// was configured or found in the catalog, so an unknown model keeps the
/// default rather than a guess.
pub(super) fn known_window(window: crate::core::cli::model_capabilities::ResolvedContextWindow) -> Option<u64> {
    (window.source != crate::core::cli::model_capabilities::ContextWindowSource::Fallback)
        .then_some(window.tokens)
}

/// Resolve the `--project` flag (default `"."`) to an absolute path. The raw
/// value is what the model would otherwise see verbatim in the system prompt's
/// working-directory block, so a bare "." must become the real cwd rather than
/// being sent to the model as-is. Falls back to the raw (possibly relative)
/// path if canonicalization fails (e.g. the directory doesn't exist yet).
pub(super) fn resolve_project_root(project: &str) -> PathBuf {
    PathBuf::from(project)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(project))
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
    pub(super) persist: PersistTarget,
}

/// Bookkeeping for writing a non-interactive run to the project's thread store,
/// so `--resume` can pick it up later. `thread_id` is `None` for a new session.
pub(super) struct PersistTarget {
    pub(super) agent_dir: PathBuf,
    pub(super) thread_id: Option<String>,
    pub(super) model: String,
    pub(super) history: Vec<serde_json::Value>,
    /// The checkout this run worked in, recorded on the thread so a later
    /// `--resume` reattaches to it.
    pub(super) workspace: Option<worktree::Worktree>,
    /// `--ephemeral`: nothing about this run is written to the thread store.
    pub(super) ephemeral: bool,
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
pub(super) fn request_body(
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
    /// Build the session without starting its MCP servers: the caller hands it
    /// servers that are already connected (an RPC model switch reuses the
    /// session's own), so starting a second copy of every stdio server only to
    /// abort it would be wasted spawns (F2b-004).
    pub skip_mcp: bool,
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
pub(super) fn inherit_desktop_model(
    signed_in: bool,
    selection: crate::core::cli::providers::DesktopSelection,
) -> Option<String> {
    signed_in.then_some(selection.model).flatten()
}

/// The newest workspace snapshot a thread recorded, which is where a fork of it
/// should start its own checkout: the files as that conversation last left them,
/// rather than a `HEAD` its whole transcript predates.
pub(super) fn latest_snapshot(thread: Option<&serde_json::Value>) -> Option<String> {
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
pub(super) fn worktree_metadata(
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
pub(super) fn fork_base(source: Option<&serde_json::Value>) -> Option<String> {
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
pub(super) fn resolve_workspace(
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

/// Pick the session's model: --model, then agent.toml, then the server's
/// browser selection, the user-wide default and the desktop app's selection
/// (see the notes below), or an empty model when nothing can serve one.
fn resolve_model(
    model_override: Option<String>,
    cfg: &crate::core::agent::project::AgentToml,
    overrides: &ProviderOverrides,
    flags: &SessionFlags,
    project_root: &std::path::Path,
) -> Result<String, String> {
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
        && !crate::core::cli::providers::has_usable_provider(Some(project_root))
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
    Ok(model)
}

/// Apply the project's routing rules to the main model and to the `smol` role
/// (used by /goal evaluation). Returns `(model, smol_model)`.
fn route_models(model: String, cfg: &crate::core::agent::project::AgentToml) -> Result<(String, String), String> {
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
    Ok((model, smol_model))
}

/// Connect the MCP servers marked `active` in mcp_config.json off-thread, so
/// setup and rendering are not blocked on a cold stdio spawn. The caller awaits
/// the returned task before the first turn (tools are collected once per run),
/// so a race with the first message cannot leave the model without its MCP
/// tools. The task is `None` when no server is active.
fn connect_mcp(skip: bool) -> (
    crate::core::state::SharedMcpServers,
    McpSettings,
    Option<tokio::task::JoinHandle<mcp::ConnectOutcome>>,
) {
    let mcp_servers: crate::core::state::SharedMcpServers = Arc::new(Mutex::new(HashMap::new()));
    let mcp_settings = mcp::read_settings();
    let mcp_task = if !skip && mcp::active_count() > 0 && !tauri_plugin_agent_tools::safe_mode::active() {
        let servers = mcp_servers.clone();
        Some(tokio::spawn(
            async move { mcp::connect_active(&servers).await },
        ))
    } else {
        None
    };
    (mcp_servers, mcp_settings, mcp_task)
}

/// Resolve the run's limits: context window, compaction policy, token and
/// money ceilings. A run that asked for a ceiling it cannot be priced against
/// is refused here, before any paid request.
fn resolve_limits(
    cfg: &crate::core::agent::project::AgentToml,
    flags: &SessionFlags,
    project: &str,
    model: &str,
) -> Result<SessionLimits, String> {
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
    Ok(SessionLimits {
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
    })
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

    let model = resolve_model(model_override, &cfg, &overrides, &flags, &project_root)?;
    // AH-194: the project's own rules about which model answers what. Read
    // here, where the model has been resolved and before anything is sent, and
    // refused at startup when a rule cannot be honoured.
    let (model, smol_model) = route_models(model, &cfg)?;

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

    let (mcp_servers, mcp_settings, mcp_task) = connect_mcp(flags.skip_mcp);

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

    let limits = resolve_limits(&cfg, &flags, project, &model)?;

    Ok(AgentSession {
        args,
        permission_requests,
        model,
        smol_model,
        limits,
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
pub(super) struct ResumedSession {
    pub(super) thread_id: String,
    pub(super) history: Vec<serde_json::Value>,
}

/// Load a saved thread's conversation for continuation, tool calls and results
/// included (see `rebuild_wire_history`), matching `/resume` in the TUI. Errors
/// describe why nothing could be resumed; the caller starts fresh.
pub(super) fn load_resume_history(
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
pub(super) fn recover_interrupted(
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
            // The checkpoint stays until the resumed run replaces it
            // (`Writer::begin` writes the recovered conversation over it): a
            // process killed between here and that point must still find the
            // interrupted turn on the next resume (CLIA-012).
            Ok(ResumedSession { thread_id: resumed.thread_id, history: recovered })
        }
    }
}

pub(super) fn prepare_agent_run(
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
mod tests {
    /// F2b-004: a session built to receive servers that are already connected
    /// starts no connect of its own, whatever MCP servers are configured.
    #[tokio::test]
    async fn a_session_that_reuses_servers_starts_no_mcp_connect() {
        let (_, _, task) = super::connect_mcp(true);
        assert!(task.is_none(), "no connect task when the caller supplies servers");
    }
}
