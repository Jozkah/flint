//! `flint agent` subcommands that run or serve an agent. The arm bodies moved
//! verbatim out of `handle_agent`.

use super::*;

/// `flint agent run`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run(project: String, task: String, model: Option<String>, safe: bool, mode: Option<String>, providers: ProviderArgs, sandbox: SandboxArgs, budget: BudgetArgs, worktree: WorktreeArgs, resume: ResumeRunArgs, output_format: OutputFormat, input_format: InputFormat, host_tools: Option<String>, host_gate: bool, events: Option<String>, profile: Option<String>, output_density: Option<String>, append_system_prompt: Option<String>, append_system_prompt_file: Option<String>, allow_tools: Vec<String>, deny_tools: Vec<String>, effort: Option<String>, ephemeral: bool, json_schema: Option<String>, json_schema_attempts: Option<u64>) -> Result<(), HarnessError> {
    let json_schema = match json_schema.as_deref().map(resolve_json_schema).transpose() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("Error: {e}");
            std::process::exit(2);
        }
    };
    let append_system_prompt = match resolve_append_prompt(
        append_system_prompt,
        append_system_prompt_file.as_deref(),
    ) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("Error: {e}");
            std::process::exit(2);
        }
    };
    if let Some(level) = effort.as_deref() {
        if !matches!(level, "low" | "medium" | "high") {
            eprintln!("Error: --effort '{level}' is not one of: low, medium, high");
            std::process::exit(2);
        }
    }
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
            bypass: app_lib::core::cli::PermissionMode::requests_bypass(mode.as_deref()),
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
            append_system_prompt,
            allow_tools,
            deny_tools,
            effort,
            ephemeral,
            json_schema,
            json_schema_attempts,
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

/// `flint agent run-subagent`.
pub(crate) async fn run_subagent(spec: String) -> Result<(), HarnessError> {
    app_lib::core::cli::run_durable_subagent(std::path::Path::new(&spec)).await
}

/// `flint agent serve`.
pub(crate) async fn serve(max_runs: usize, retention_days: u64) -> Result<(), HarnessError> {
    app_lib::core::cli::json_api::serve_stdio(app_lib::core::cli::json_api::ServeLimits {
        max_runs,
        retention: std::time::Duration::from_secs(retention_days.saturating_mul(24 * 60 * 60)),
    })
    .await;
    Ok(())
}

/// `flint agent step`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn step(project: String, task: String, model: Option<String>, safe: bool, mode: Option<String>, providers: ProviderArgs, sandbox: SandboxArgs, profile: Option<String>) -> Result<(), HarnessError> {
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
            bypass: app_lib::core::cli::PermissionMode::requests_bypass(mode.as_deref()),
            plan: mode_switches.1,
            sandbox: sandbox.into_flag(),
            profile,
            ..Default::default()
        },
    )
    .await
}

/// `flint agent status`.
pub(crate) fn status(project: String, providers: ProviderArgs) -> Result<(), HarnessError> {
    match cli_agent_status(&project, &providers.into_overrides()) {
        Ok(status) => {
            println!("{}", serde_json::to_string_pretty(&status).unwrap());
            Ok(())
        }
        Err(e) => Err(HarnessError::legacy(e)),
    }
}

/// `flint agent schema`.
pub(crate) fn schema(out: Option<std::path::PathBuf>) -> Result<(), HarnessError> {
    // No project and no provider: the schema comes from the types alone, so
    // it is the same document on any machine and in any directory.
    app_lib::core::cli::protocol_schema::run(out.as_deref()).map_err(HarnessError::legacy)
}

/// `flint agent rpc`.
pub(crate) async fn rpc() -> Result<(), HarnessError> {
    app_lib::core::cli::rpc::serve().await.map_err(HarnessError::legacy)
}

/// `flint agent rpc-schema`.
pub(crate) fn rpc_schema(out: Option<std::path::PathBuf>) -> Result<(), HarnessError> {
    // Like `schema`: no project root and no provider are involved, so the
    // artifact is the same one on any machine. `--out` is what CI and
    // `make protocol-rpc-schema` use.
    app_lib::core::cli::rpc_schema::run(out.as_deref()).map_err(HarnessError::legacy)
}
