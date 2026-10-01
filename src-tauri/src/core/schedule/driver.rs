//! The app's side of the scheduler: a startup catch-up pass, then a tick every
//! [`TICK_SECS`] while the app is open.
//!
//! A tick only decides and starts (`runner::tick`); the runs themselves are
//! detached jobs, so closing the app never stops one. A per-tick lock in the
//! schedules folder keeps two app instances (or the app and `flint cli`) from
//! starting the same fire twice. There is no OS-scheduler install: a task whose
//! time passes while the app is closed is handled by its catch-up policy the
//! next time the app starts.
//!
//! The page learns what happened from a `schedule-event` event, which names the
//! task and run and how it ended -- ids and a status, never what the run said.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use super::runner::{self, SupervisorLauncher};
use super::store::{RunStatus, Store};
use crate::core::app::commands::get_jan_data_folder_path;

pub const TICK_SECS: u64 = 30;
pub const EVENT: &str = "schedule-event";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEvent {
    /// `started`, `skipped` or `ended`.
    pub kind: &'static str,
    pub task_id: String,
    pub task_name: String,
    pub run_id: String,
    pub status: RunStatus,
}

/// What changed between two looks at the running runs: the ended ones, with
/// the task each belonged to. Pure so it can be tested.
pub fn ended_since(
    before: &BTreeMap<String, String>,
    now_running: &BTreeMap<String, String>,
) -> Vec<(String, String)> {
    before
        .iter()
        .filter(|(run, _)| !now_running.contains_key(*run))
        .map(|(run, task)| (task.clone(), run.clone()))
        .collect()
}

/// Spawn the driver: one pass at once (the catch-up), then one per tick.
pub fn start<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut running: BTreeMap<String, String> = BTreeMap::new();
        loop {
            let data = get_jan_data_folder_path(app.clone());
            let seen = running.clone();
            let outcome = tauri::async_runtime::spawn_blocking(move || pass(&data, seen)).await;
            match outcome {
                Ok((events, now_running)) => {
                    running = now_running;
                    for e in events {
                        let _ = app.emit(EVENT, e);
                    }
                }
                Err(e) => log::warn!("schedule tick failed: {e}"),
            }
            tokio::time::sleep(Duration::from_secs(TICK_SECS)).await;
        }
    });
}

/// One tick, plus the bookkeeping to say what started and ended.
fn pass(data: &Path, seen_running: BTreeMap<String, String>) -> (Vec<ScheduleEvent>, BTreeMap<String, String>) {
    let store = Store::new(data);
    let mut events = Vec::new();
    let report = runner::tick(&store, data, &SupervisorLauncher, Utc::now());
    for e in &report.errors {
        log::warn!("schedule: {e}");
    }
    for (kind, runs) in [("started", &report.started), ("skipped", &report.skipped)] {
        for r in runs {
            events.push(ScheduleEvent {
                kind,
                task_id: r.task_id.clone(),
                task_name: r.task_name.clone(),
                run_id: r.id.clone(),
                status: r.status,
            });
        }
    }
    // A locked-out tick did not settle anything; look anyway, it is read-only
    // apart from closing runs whose job is gone.
    runner::settle(&store, data);
    let now_running: BTreeMap<String, String> =
        store.running_runs().into_iter().map(|r| (r.id, r.task_id)).collect();
    for (task_id, run_id) in ended_since(&seen_running, &now_running) {
        if let Ok(Some(r)) = store.get_run(&task_id, &run_id) {
            events.push(ScheduleEvent {
                kind: "ended",
                task_id: r.task_id,
                task_name: r.task_name,
                run_id: r.id,
                status: r.status,
            });
        }
    }
    (events, now_running)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_that_stopped_running_is_reported_once() {
        let before: BTreeMap<String, String> =
            [("r1".to_string(), "a".to_string()), ("r2".to_string(), "b".to_string())].into();
        let now: BTreeMap<String, String> = [("r2".to_string(), "b".to_string())].into();
        assert_eq!(ended_since(&before, &now), vec![("a".to_string(), "r1".to_string())]);
        assert!(ended_since(&now, &now).is_empty());
        assert!(ended_since(&BTreeMap::new(), &now).is_empty(), "a run seen for the first time did not just end");
    }
}
