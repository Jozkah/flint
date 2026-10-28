//! The `agent` management commands: status, config, plugins, review and the
//! policy export/import. Moved verbatim out of `mod.rs`.

use super::*;

/// One line for a `Compaction` event: `finished (session_budget): 12 messages removed`.
pub(super) fn describe_compaction(
    phase: crate::core::agent::events::CompactionPhase,
    reason: crate::core::agent::events::CompactionReason,
    messages: Option<usize>,
) -> String {
    use crate::core::agent::events::{CompactionPhase, CompactionReason};
    let phase = match phase {
        CompactionPhase::Started => "started",
        CompactionPhase::Finished => "finished",
        CompactionPhase::Failed => "failed",
    };
    let reason = match reason {
        CompactionReason::Preflight => "preflight",
        CompactionReason::ContextOverflow => "context_overflow",
        CompactionReason::SessionBudget => "session_budget",
    };
    match messages {
        Some(n) => format!("{phase} ({reason}): {n} messages removed"),
        None => format!("{phase} ({reason})"),
    }
}

/// Resolved-config + provider snapshot for `flint cli agent status`.
pub fn cli_agent_status(
    project: &str,
    overrides: &ProviderOverrides,
) -> Result<serde_json::Value, String> {
    let project_root = resolve_project_root(project);
    ensure_project(&project_root)?;
    let cfg = load_agent_config(&project_root)?;
    let provider_configs = load_provider_configs(Some(&project_root), overrides)?;

    // Where every contributor to the system prompt lands relative to the cache
    // line, and why: "which of my writers sits in the leading bytes" is one
    // command, not an investigation. A `[prompt]` policy that cannot be honored
    // (a typo, or a contributor that changes while a run works) fails here with
    // the message a run would give.
    let prompt_policy = crate::core::agent::project::prompt_policy(&project_root);
    let prompt_components: Vec<serde_json::Value> = prompt_policy
        .placements()
        .map_err(|e| format!("[prompt] config: {e}"))?
        .into_iter()
        .map(|(composer, placement)| {
            serde_json::json!({
                "id": composer.id(),
                "placement": placement.as_str(),
                "constant": composer.constant(),
                "source": composer.source().as_str(),
                // True when `[prompt]` moved it below the line from where the
                // code would have put it.
                "demoted": placement != composer.declared(),
                "what": composer.what(),
            })
        })
        .collect();

    // Only providers this build can reach: local-engine entries inherited from
    // the desktop store have no upstream here (see `is_cli_reachable`).
    let mut providers: Vec<serde_json::Value> = provider_configs
        .values()
        .filter(|c| crate::core::cli::providers::is_cli_reachable(c))
        .map(|c| {
            serde_json::json!({
                "provider": c.provider,
                "base_url": c.base_url,
                "has_api_key": crate::core::cli::providers::has_credential(c),
                // How this route reuses a prompt prefix: `explicit` (the
                // request carries cache breakpoints), `implicit` (the provider
                // caches by itself) or `none`.
                "prompt_cache": crate::core::server::converters::CacheCapability::for_api_type(
                    c.api_type.as_deref(),
                )
                .as_str(),
                "models": c.models.len(),
            })
        })
        .collect();
    providers.sort_by(|a, b| a["provider"].as_str().cmp(&b["provider"].as_str()));

    // The window the configured model resolves to, when it is a known one: it
    // sets the session budget when nothing else does.
    let status_window = cfg.agent.model.as_deref().and_then(|model| {
        known_window(crate::core::cli::model_capabilities::resolve_context_window(
            model,
            cfg.agent.context_window,
        ))
    });

    Ok(serde_json::json!({
        "project": project_root.to_string_lossy(),
        "data_folder": resolve_jan_data_folder().to_string_lossy(),
        "model": cfg.agent.model,
        // The effective ceiling with the config files resolved. A
        // `--max-session-tokens` flag is per-invocation and so, like
        // `--sandbox` below, cannot be reflected in a config dump.
        "max_session_tokens": resolve_session_budget(None, cfg.budget.max_tokens, status_window),
        "max_session_tokens_source": session_budget_source(None, cfg.budget.max_tokens, status_window),
        // The configured money ceiling, or null when the project sets none.
        // Whether it can be enforced depends on the model a run resolves.
        "max_budget_usd": cfg.budget.max_usd,
        "tools": {
            "default": cfg.tools.default,
            "allow": cfg.tools.allow,
            "deny": cfg.tools.deny,
            "allow_write": cfg.tools.allow_write,
            "allow_network": cfg.tools.allow_network,
            "allow_home_read": cfg.tools.allow_home_read,
            "sandbox": cfg.tools.sandbox,
        },
        // What `bash` will actually do, with the config files already resolved
        // (the `--sandbox` flag is per-invocation and so cannot be reported
        // here). `backend` names the confinement that would be used and is
        // `none` where none can be established -- with `enabled` true that
        // combination is what withholds `bash` entirely.
        "sandbox": {
            "enabled": crate::core::agent::r#loop::effective_sandbox(&project_root),
            "backend": tauri_plugin_agent_tools::tools::jail::backend().as_str(),
        },
        // Who may write above the cache line: the configured lists and the
        // resolved placement of every contributor.
        "prompt": {
            "prefix_allow": prompt_policy.prefix_allow(),
            "prefix_deny": prompt_policy.prefix_deny(),
            "components": prompt_components,
        },
        "providers": providers,
    }))
}

/// Set (create or merge) a provider entry in the global `~/.jan/config.toml`,
/// the standalone-agent credential store. Returns the config path so the caller
/// can report where the value landed. Headless: no Desktop app required.
pub fn cli_agent_config_set(
    provider: &str,
    api_key: Option<String>,
    base_url: Option<String>,
    models: Option<Vec<String>>,
    api_type: Option<String>,
) -> Result<PathBuf, String> {
    crate::core::agent::global_config::set_provider(
        provider,
        crate::core::agent::global_config::ProviderUpdate {
            api_key,
            clear_api_key: false,
            base_url,
            models,
            api_type,
            ..Default::default()
        },
    )
}

/// Remove a provider entry from `~/.jan/config.toml`. `Ok(false)` means it was
/// already absent.
pub fn cli_agent_config_unset(provider: &str) -> Result<bool, String> {
    crate::core::agent::global_config::remove_provider(provider)
}

/// The global config file path, scaffolding a commented template if it doesn't
/// exist yet so `jan config path` always points at a real file.
pub fn cli_agent_config_path() -> Result<PathBuf, String> {
    crate::core::agent::global_config::ensure_global_config()
}

/// Providers configured in `~/.jan/config.toml`, as JSON with API keys redacted.
/// Reflects only the global store (what the user set), not Desktop inherit.
pub fn cli_agent_config_list() -> Result<serde_json::Value, String> {
    let configs = crate::core::agent::global_config::load_global_config()?;
    let mut providers: Vec<serde_json::Value> = configs
        .values()
        .map(|c| {
            serde_json::json!({
                "provider": c.provider,
                "base_url": c.base_url,
                "has_api_key": c.api_key.is_some(),
                "api_type": c.api_type,
                "models": c.models,
            })
        })
        .collect();
    providers.sort_by(|a, b| a["provider"].as_str().cmp(&b["provider"].as_str()));
    Ok(serde_json::json!({
        "config_path": crate::core::agent::global_config::global_config_path()?.to_string_lossy(),
        "providers": providers,
    }))
}

/// List plugins installed for a project.
pub fn cli_plugin_list(project: &str) -> Vec<crate::core::agent::plugins::InstalledPlugin> {
    crate::core::agent::plugins::installed(&resolve_project_root(project))
}

/// Install git or marketplace plugin(s) for a project.
///
/// This is the interactive CLI path: a multi-plugin collection prompts the user
/// to choose which plugins to install (it has an owning terminal, unlike the
/// TUI render loop which reads stdin itself and so uses the non-interactive
/// listing-error behavior). Returns every plugin actually installed.
pub async fn cli_plugin_install(
    project: &str,
    spec: &str,
) -> Result<Vec<crate::core::agent::plugins::InstalledPlugin>, String> {
    crate::core::agent::plugins::install_interactive(&resolve_project_root(project), spec).await
}

/// Remove a plugin from a project.
pub fn cli_plugin_remove(project: &str, name: &str) -> Result<(), String> {
    crate::core::agent::plugins::remove(&resolve_project_root(project), name)
}

/// Update a git or marketplace plugin when its source moved to a new commit.
pub async fn cli_plugin_update(
    project: &str,
    name: &str,
) -> Result<crate::core::agent::plugins::UpdateReport, String> {
    crate::core::agent::plugins::update(&resolve_project_root(project), name).await
}

/// Model calls for the diff review go through the same provider path a turn
/// uses, with no tools.
pub(super) struct ReviewInvoker<'a> {
    pub(super) args: &'a OrchestrationArgs,
    pub(super) model: String,
}

#[async_trait::async_trait]
impl crate::core::agent::r#loop::ModelInvoker for ReviewInvoker<'_> {
    async fn invoke(
        &self,
        request: &serde_json::Value,
        _events: &tokio::sync::mpsc::UnboundedSender<crate::core::agent::events::StreamEvent>,
    ) -> Result<serde_json::Value, tauri_plugin_agent_tools::harness_error::HarnessError> {
        crate::core::agent::r#loop::utility_completion(self.args, &self.model, "reviewer", request)
            .await
    }
}

/// `flint review`: review the current diff (staged, unstaged and untracked
/// changes against `base`, default HEAD) with a fresh-context reviewer, try to
/// refute each finding, and print what survives, ranked. With `fix`, hand the
/// findings to an ordinary agent run, so every edit goes through the normal
/// tools and approvals.
pub async fn cli_review(
    project: &str,
    base: Option<&str>,
    security: bool,
    model: Option<String>,
    fix: bool,
    json: bool,
) -> Result<(), String> {
    let root = resolve_project_root(project);
    let input = crate::core::agent::review::collect_diff(&root, base)?;
    let mut session = prepare_agent_session(
        project,
        model.clone(),
        ProviderOverrides::default(),
        SessionFlags {
            plan: true,
            require_model: true,
            worktree: Some(false),
            ..Default::default()
        },
        None,
    )?;
    if let Some(task) = session.mcp_task.take() {
        task.abort();
    }
    let invoker = ReviewInvoker {
        args: &session.args,
        model: session.model.clone(),
    };
    let review = crate::core::agent::review::review_diff(&session.model, &input, security, &invoker)
        .await
        .map_err(|e| e.message().to_string())?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&review).map_err(|e| e.to_string())?
        );
    } else {
        print!("{}", crate::core::agent::review::render_findings(&review));
    }
    if fix && !review.findings.is_empty() {
        let task = crate::core::agent::review::fix_task(&review);
        cli_agent_run(
            project,
            &task,
            model,
            ProviderOverrides::default(),
            SessionFlags::default(),
            None,
            OutputFormat::Text,
            InputFormat::Text,
            None,
            false,
        )
        .await
        .map_err(|e| e.message().to_string())?;
    }
    Ok(())
}

/// Search the configured plugin marketplace for a project.
pub async fn cli_plugin_search(
    project: &str,
    query: &str,
) -> Result<Vec<crate::core::agent::plugins::MarketEntry>, String> {
    crate::core::agent::plugins::search(&resolve_project_root(project), query).await
}

/// This project's permission policy, as a document somebody can review
/// (AH-052).
pub fn cli_policy_export(
    project: &str,
) -> Result<
    tauri_plugin_agent_tools::policy_transfer::PolicyDocument,
    tauri_plugin_agent_tools::harness_error::HarnessError,
> {
    use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
    let root = resolve_project_root(project);
    // A project with no agent.toml runs under the default policy, so that is
    // the policy to export; only a file that exists and cannot be read is an
    // error.
    let path = crate::core::agent::project::agent_toml_path(&root);
    let config = if path.exists() {
        crate::core::agent::project::load_agent_config(&root).map_err(|e| {
            HarnessError::new(ErrorKind::MalformedState, format!("this project's configuration cannot be read: {e}"))
                .at(Stage::Startup)
        })?
    } else {
        crate::core::agent::project::AgentToml::default()
    };
    Ok(tauri_plugin_agent_tools::policy_transfer::export(
        config.tools.default.as_deref().unwrap_or(tauri_plugin_agent_tools::permissions::PermissionDefault::UNSET.as_str()),
        &config.tools.allow,
        &config.tools.deny,
        &config.tools.allow_write,
    ))
}

/// Replace this project's permission policy with a reviewed document
/// (AH-052).
///
/// Refuses anything that would let the agent do more than it can now, unless
/// `accept_widening` says the caller has seen exactly what it opens.
pub fn cli_policy_import(
    project: &str,
    text: &str,
    accept_widening: bool,
) -> Result<
    tauri_plugin_agent_tools::policy_transfer::PolicyChange,
    tauri_plugin_agent_tools::harness_error::HarnessError,
> {
    use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
    use tauri_plugin_agent_tools::policy_transfer::{plan_import, to_toml, Widening};
    let current = cli_policy_export(project)?;
    let (document, change) = plan_import(
        &current,
        text,
        if accept_widening { Widening::Accept } else { Widening::Refuse },
    )?;
    if change.is_empty() {
        return Ok(change);
    }
    let root = resolve_project_root(project);
    let path = crate::core::agent::project::agent_toml_path(&root);
    // Only a missing file starts empty. Any other read failure (permissions,
    // invalid UTF-8) must stop here: treating it as empty would rewrite the
    // file with the `[tools]` section alone and lose the model, budget and
    // skills settings.
    let existing = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            return Err(HarnessError::new(
                ErrorKind::MalformedState,
                format!("{} cannot be read, so the policy was not changed: {e}", path.display()),
            )
            .at(Stage::Persistence));
        }
    };
    let rewritten = crate::core::agent::project::replace_tools_section(&existing, &to_toml(&document));
    std::fs::create_dir_all(agent_dir_for(&root)).map_err(|e| {
        HarnessError::new(ErrorKind::Io, format!("the project's config directory is not writable: {e}"))
            .at(Stage::Persistence)
    })?;
    // Temp file then rename, so an interrupted write leaves the old file whole.
    let tmp = path.with_extension("toml.flint-tmp");
    std::fs::write(&tmp, rewritten)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            HarnessError::new(ErrorKind::Io, format!("the policy could not be written: {e}"))
                .at(Stage::Persistence)
        })?;
    Ok(change)
}
