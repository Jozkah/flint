//! `flint agent` subcommands over recorded run data: events, replays, audit,
//! prompts and the ledger. The arm bodies moved verbatim out of `handle_agent`.

use super::*;

/// `flint agent events-export`.
pub(crate) fn events_export(session: String, run: Option<String>, include_content: bool) -> Result<(), HarnessError> {
    app_lib::core::cli::run_data_cmd::events_export(
        &app_lib::core::app::commands::resolve_jan_data_folder(),
        &session,
        run.as_deref(),
        include_content,
    )
    .map_err(HarnessError::legacy)
}

/// `flint agent events-inspect`.
pub(crate) fn events_inspect(file: std::path::PathBuf) -> Result<(), HarnessError> {
    app_lib::core::cli::run_data_cmd::events_inspect(&file).map_err(HarnessError::legacy)
}

/// `flint agent replays`.
pub(crate) fn replays(session: String) -> Result<(), HarnessError> {
    app_lib::core::cli::run_data_cmd::replays(
    &app_lib::core::app::commands::resolve_jan_data_folder(),
    &session,
)
.map_err(HarnessError::legacy)
}

/// `flint agent replay`.
pub(crate) fn replay(session: String, run: String) -> Result<(), HarnessError> {
    app_lib::core::cli::run_data_cmd::replay(
    &app_lib::core::app::commands::resolve_jan_data_folder(),
    &session,
    &run,
)
.map_err(HarnessError::legacy)
}

/// `flint agent audit`.
pub(crate) fn audit(session: Option<String>, run: Option<String>, agent: Option<String>, tool: Option<String>, decision: Option<String>, limit: usize) -> Result<(), HarnessError> {
    app_lib::core::cli::run_data_cmd::audit_cmd(
        &app_lib::core::app::commands::resolve_jan_data_folder(),
        session,
        run,
        agent,
        tool,
        decision,
        limit,
    )
    .map_err(HarnessError::legacy)
}

/// `flint agent prompts`.
pub(crate) fn prompts(session: String, show: Option<String>) -> Result<(), HarnessError> {
    agent_prompts_text(
    &app_lib::core::app::commands::resolve_jan_data_folder(),
    &session,
    show.as_deref(),
)
.map(|text| print!("{text}"))
.map_err(HarnessError::legacy)
}

/// `flint agent ledger`.
pub(crate) fn ledger(run: String, json: bool) -> Result<(), HarnessError> {
    let data = app_lib::core::app::commands::resolve_jan_data_folder();
    match app_lib::core::agent::ledger::read(&data, &run) {
        Ok(entries) if json => {
            println!("{}", serde_json::to_string_pretty(&entries).unwrap_or_else(|_| "[]".to_string()));
            Ok(())
        }
        Ok(entries) => {
            print!("{}", app_lib::core::agent::ledger::render_text(&entries));
            Ok(())
        }
        Err(e) => Err(HarnessError::legacy(e)),
    }
}
