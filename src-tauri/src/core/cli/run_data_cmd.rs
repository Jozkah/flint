//! `flint cli agent events-export | events-inspect | replays | replay | audit`:
//! the run record the desktop's Cowork pages show (event export, run replay,
//! permission decisions), from the terminal.
//!
//! Everything reads the data folder the app and the CLI share. Nothing is sent
//! anywhere; an export is a file under `<data>/exports`.

use std::path::Path;
use std::sync::atomic::AtomicBool;

use tauri_plugin_agent_tools::audit::{self, Outcome, Query};
use tauri_plugin_agent_tools::event_export;
use tauri_plugin_agent_tools::run_replay;

fn print<T: serde::Serialize>(value: &T) -> Result<(), String> {
    println!("{}", serde_json::to_string_pretty(value).map_err(|e| e.to_string())?);
    Ok(())
}

/// `agent events-export <session> [--run R] [--include-content]`
pub fn events_export(data: &Path, session: &str, run: Option<&str>, include_content: bool) -> Result<(), String> {
    let cancel = AtomicBool::new(false);
    let report = event_export::export(data, session, run, include_content, &cancel).map_err(|e| e.message)?;
    print(&report)
}

/// `agent events-inspect <file>`: what an export holds, without interpreting it.
pub fn events_inspect(path: &Path) -> Result<(), String> {
    let report = event_export::inspect(path).map_err(|e| e.message)?;
    print(&report)
}

/// `agent replays <session>`: the finished runs that can be stepped through.
pub fn replays(data: &Path, session: &str) -> Result<(), String> {
    let runs = run_replay::finished_runs(data, session).map_err(|e| e.message().to_string())?;
    print(&runs)
}

/// `agent replay <session> <run>`: a finished run's events in order.
pub fn replay(data: &Path, session: &str, run: &str) -> Result<(), String> {
    let recording = run_replay::recording(data, session, run).map_err(|e| e.message().to_string())?;
    print(&recording)
}

fn outcome(text: &str) -> Result<Outcome, String> {
    serde_json::from_value(serde_json::Value::String(text.trim().to_ascii_lowercase()))
        .map_err(|_| format!("unknown decision '{text}'"))
}

/// `agent audit [--session S] [--run R] [--agent A] [--tool T] [--decision D] [--limit N]`:
/// the permission decisions recorded for approvals, newest last.
pub fn audit_cmd(
    data: &Path,
    session: Option<String>,
    run: Option<String>,
    agent: Option<String>,
    tool: Option<String>,
    decision: Option<String>,
    limit: usize,
) -> Result<(), String> {
    let query = Query {
        session,
        run,
        agent,
        tool,
        decision: decision.as_deref().map(outcome).transpose()?,
        resource_contains: None,
    };
    let mut records = audit::query(data, &query);
    let skip = records.len().saturating_sub(limit.max(1));
    records.drain(..skip);
    print(&records)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_data_folder_has_no_events_runs_or_decisions() {
        let dir = tempfile::tempdir().unwrap();
        let err = events_export(dir.path(), "no-such-session", None, false).unwrap_err();
        assert!(!err.is_empty());
        assert!(replays(dir.path(), "").is_err(), "a replay needs a session");
        audit_cmd(dir.path(), None, None, None, None, None, 10).unwrap();
        assert!(audit_cmd(dir.path(), None, None, None, None, Some("sideways".into()), 10).is_err());
        assert!(events_inspect(&dir.path().join("missing.zip")).is_err());
    }
}
