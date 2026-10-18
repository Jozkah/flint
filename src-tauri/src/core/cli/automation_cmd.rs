//! `flint cli automation list | show | validate | add | run | remove`.
//!
//! The definition (trigger, prompt, tool profile, budget, folders) lives in
//! `core::automation`, which refuses a bad one with every problem listed by
//! field. `run` hands the compiled task to the scheduled-run machinery, so an
//! automation runs under the same unattended rules as a scheduled task.

use std::path::Path;

use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};

use super::schedule::{data_folder, invalid, stamp};
use crate::core::automation::{self, Automation, AutomationStore, Trigger};

fn store() -> AutomationStore {
    AutomationStore::new(&data_folder())
}

fn io(message: String) -> HarnessError {
    HarnessError::new(ErrorKind::Io, message).at(Stage::Startup)
}

fn read_definition(file: &Path) -> Result<Automation, HarnessError> {
    let text = std::fs::read_to_string(file).map_err(|e| invalid(format!("cannot read {}: {e}", file.display())))?;
    automation::parse(&text).map_err(|p| invalid(automation::describe(&p)))
}

fn trigger_label(t: &Trigger) -> String {
    match t {
        Trigger::Manual => "manual".to_string(),
        Trigger::Schedule { schedule, timezone } => match schedule.to_cron() {
            Ok(c) => format!("schedule {} ({timezone})", c.join(" | ")),
            Err(_) => format!("schedule ({timezone})"),
        },
    }
}

/// `flint cli automation list`
pub fn list(json: bool) -> Result<(), HarnessError> {
    let all = store().load().map_err(io)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&all).unwrap_or_default());
        return Ok(());
    }
    if all.is_empty() {
        println!("No automations. Define one in a JSON file and add it with `flint cli automation add --file <path>`.");
        return Ok(());
    }
    for a in all {
        println!(
            "{}  {:<8}  {}  {}",
            a.id,
            if a.enabled { "enabled" } else { "disabled" },
            trigger_label(&a.trigger),
            a.name
        );
    }
    Ok(())
}

/// `flint cli automation show <id>`
pub fn show(id: &str) -> Result<(), HarnessError> {
    let a = store()
        .get(id)
        .map_err(io)?
        .ok_or_else(|| HarnessError::new(ErrorKind::NotFound, format!("no automation '{id}'")).at(Stage::Startup))?;
    println!("{}", serde_json::to_string_pretty(&a).unwrap_or_default());
    Ok(())
}

/// `flint cli automation validate --file <path>`: check a definition without saving it.
pub fn validate(file: &Path, json: bool) -> Result<(), HarnessError> {
    let a = read_definition(file)?;
    let problems = a.problems();
    if json {
        println!("{}", serde_json::json!({ "ok": problems.is_empty(), "problems": problems }));
    } else if problems.is_empty() {
        println!("ok: {} ({})", a.id, trigger_label(&a.trigger));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(invalid(automation::describe(&problems)))
    }
}

/// `flint cli automation add --file <path>`: validate and save (replacing by id).
pub fn add(file: &Path, json: bool) -> Result<(), HarnessError> {
    let a = read_definition(file)?;
    let saved = store().save(a).map_err(|p| invalid(automation::describe(&p)))?;
    if json {
        println!("{}", serde_json::to_string_pretty(&saved).unwrap_or_default());
    } else {
        println!("saved {} ({})", saved.id, trigger_label(&saved.trigger));
    }
    Ok(())
}

/// `flint cli automation remove <id> --yes`
pub fn remove(id: &str) -> Result<(), HarnessError> {
    if store().remove(id).map_err(io)? {
        println!("removed {id}");
        Ok(())
    } else {
        Err(HarnessError::new(ErrorKind::NotFound, format!("no automation '{id}'")).at(Stage::Startup))
    }
}

/// `flint cli automation run <id> [--folder <dir>] [--wait]`
pub async fn run(id: &str, folder: Option<&str>, wait: bool) -> Result<(), HarnessError> {
    let a = store()
        .get(id)
        .map_err(io)?
        .ok_or_else(|| HarnessError::new(ErrorKind::NotFound, format!("no automation '{id}'")).at(Stage::Startup))?;
    // A definition edited by hand after it was saved is checked again before it runs.
    let problems = a.problems();
    if !problems.is_empty() {
        return Err(invalid(format!("the automation no longer validates:\n{}", automation::describe(&problems))));
    }
    let task = a.task_for_run(folder).map_err(invalid)?;
    println!("{} ({})", a.name, stamp(crate::core::schedule::store::now_ms()));
    super::schedule::run_task(task, wait).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bad_definition_file_is_refused_with_the_problems_named() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("a.json");
        std::fs::write(&f, r#"{"id":"","prompt":"","folders":[]}"#).unwrap();
        let err = validate(&f, false).unwrap_err();
        assert!(err.message().contains("missing field"), "{}", err.message());
        // Nothing is saved by validate, and a missing file is a clear error.
        assert!(validate(&d.path().join("missing.json"), false).unwrap_err().message().contains("cannot read"));
    }
}
