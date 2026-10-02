//! Tauri commands for the Schedules settings page. Thin: validation, the next
//! fire times and every file write live in `spec` / `store` / `runner`, which
//! the `flint cli schedule` commands share.
//!
//! Disk work runs on the blocking pool. Errors are the plain message the page
//! shows beside the field it came from.

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tauri::{AppHandle, Runtime};

use super::os_scheduler;
use super::runner::{self, SupervisorLauncher};
use super::spec::{new_task_id, parse_timezone, Schedule, Task};
use super::store::{RunRecord, Store, Trigger};
use crate::core::app::commands::get_jan_data_folder_path;

/// A task as the page lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub task: Task,
    /// The next few fire times, RFC 3339 in UTC.
    pub next_fires: Vec<DateTime<Utc>>,
    pub last_run: Option<RunRecord>,
    pub running: bool,
}

/// A built-in tool the policy editor can offer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolView {
    pub name: String,
    /// `read`, `write`, `exec` or `net`.
    pub capability: String,
}

fn data_folder<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    get_jan_data_folder_path(app.clone())
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("the schedule task failed: {e}"))?
}

fn view(store: &Store, task: Task, running: &std::collections::BTreeSet<String>) -> TaskView {
    let next_fires = task.next_fires(Utc::now(), 1).unwrap_or_default();
    let last_run = store.list_runs(&task.id, 1).ok().and_then(|mut r| r.pop());
    let running = running.contains(&task.id);
    TaskView { task, next_fires, last_run, running }
}

#[tauri::command]
pub async fn schedules_list<R: Runtime>(app_handle: AppHandle<R>) -> Result<Vec<TaskView>, String> {
    let data = data_folder(&app_handle);
    blocking(move || {
        let store = Store::new(&data);
        let tasks = store.load_tasks().map_err(|e| e.message)?;
        let running = runner::settle(&store, &data);
        Ok(tasks.into_iter().map(|t| view(&store, t, &running)).collect())
    })
    .await
}

/// Create (empty `id`) or replace a task. The page cannot save one the engine
/// would refuse: budgets, tool list, time zone and cron are checked here.
#[tauri::command]
pub async fn schedule_save<R: Runtime>(app_handle: AppHandle<R>, task: Task) -> Result<TaskView, String> {
    let data = data_folder(&app_handle);
    blocking(move || {
        let store = Store::new(&data);
        let mut task = task;
        if task.id.trim().is_empty() {
            task.id = new_task_id();
        }
        let saved = store.save_task(task).map_err(|e| e.message)?;
        Ok(view(&store, saved, &Default::default()))
    })
    .await
}

#[tauri::command]
pub async fn schedule_delete<R: Runtime>(app_handle: AppHandle<R>, task_id: String) -> Result<bool, String> {
    let data = data_folder(&app_handle);
    blocking(move || Store::new(&data).delete_task(&task_id).map_err(|e| e.message)).await
}

#[tauri::command]
pub async fn schedule_set_enabled<R: Runtime>(
    app_handle: AppHandle<R>,
    task_id: String,
    enabled: bool,
) -> Result<TaskView, String> {
    let data = data_folder(&app_handle);
    blocking(move || {
        let store = Store::new(&data);
        let task = store.set_enabled(&task_id, enabled).map_err(|e| e.message)?;
        Ok(view(&store, task, &Default::default()))
    })
    .await
}

/// Start a run now, whatever the timetable says. Refused (recorded as skipped)
/// while the task's previous run is still going.
#[tauri::command]
pub async fn schedule_run_now<R: Runtime>(app_handle: AppHandle<R>, task_id: String) -> Result<RunRecord, String> {
    let data = data_folder(&app_handle);
    blocking(move || {
        let store = Store::new(&data);
        let task = store
            .get_task(&task_id)
            .map_err(|e| e.message)?
            .ok_or_else(|| format!("no scheduled task '{task_id}'"))?;
        runner::start_run(&store, &data, &SupervisorLauncher, &task, Trigger::Manual, Utc::now())
            .map_err(|e| e.message)
    })
    .await
}

#[tauri::command]
pub async fn schedule_runs<R: Runtime>(
    app_handle: AppHandle<R>,
    task_id: String,
    limit: Option<usize>,
) -> Result<Vec<RunRecord>, String> {
    let data = data_folder(&app_handle);
    blocking(move || {
        let store = Store::new(&data);
        runner::settle(&store, &data);
        store.list_runs(&task_id, limit.unwrap_or(30).min(200)).map_err(|e| e.message)
    })
    .await
}

/// Stop a run in flight. Its record ends as cancelled the next time it is read.
#[tauri::command]
pub async fn schedule_cancel_run<R: Runtime>(
    app_handle: AppHandle<R>,
    task_id: String,
    run_id: String,
) -> Result<(), String> {
    let data = data_folder(&app_handle);
    blocking(move || {
        let store = Store::new(&data);
        let run = store
            .get_run(&task_id, &run_id)
            .map_err(|e| e.message)?
            .ok_or_else(|| "no such run".to_string())?;
        if let Some(job) = run.job_id.as_deref() {
            tauri_plugin_agent_tools::worker::cancel(&data, &runner::owner_for(&task_id), job)
                .map_err(|e| e.message().to_string())?;
        }
        runner::settle(&store, &data);
        Ok(())
    })
    .await
}

/// The next fire times for a schedule that is still being edited, so the page
/// can show them before anything is saved. Fails with the reason the schedule
/// would be refused.
#[tauri::command]
pub fn schedule_preview(schedule: Schedule, timezone: String, count: Option<usize>) -> Result<Vec<DateTime<Utc>>, String> {
    let tz = parse_timezone(&timezone).map_err(|e| e.message)?;
    let exprs = schedule.compile().map_err(|e| e.message)?;
    let count = count.unwrap_or(5).clamp(1, 20);
    let now = Utc::now();
    let mut all: Vec<DateTime<Utc>> = Vec::new();
    for e in exprs {
        all.extend(e.next_fires(tz, now, count));
    }
    all.sort();
    all.dedup();
    all.truncate(count);
    if all.is_empty() {
        return Err("this schedule never fires".to_string());
    }
    Ok(all)
}

/// The cron expressions a preset compiles to, for the page's cron-text toggle.
#[tauri::command]
pub fn schedule_to_cron(schedule: Schedule) -> Result<Vec<String>, String> {
    schedule.to_cron().map_err(|e| e.message)
}

#[tauri::command]
pub fn schedule_time_zones() -> Vec<String> {
    chrono_tz::TZ_VARIANTS.iter().map(|tz| tz.name().to_string()).collect()
}

/// The built-in tools a task can be allowed.
#[tauri::command]
pub fn schedule_tools() -> Vec<ToolView> {
    use tauri_plugin_agent_tools::tools::{Capability, BUILTIN_TOOLS};
    BUILTIN_TOOLS
        .iter()
        .map(|t| ToolView {
            name: t.name.to_string(),
            capability: match t.capability {
                Capability::Read => "read",
                Capability::Write => "write",
                Capability::Exec => "exec",
                Capability::Net => "net",
            }
            .to_string(),
        })
        .collect()
}

// ---- run when the app is closed ----

fn os_install<R: Runtime>(app: &AppHandle<R>, interval: Option<u32>) -> Result<(os_scheduler::Install, PathBuf), String> {
    let exe = tauri_plugin_agent_tools::worker::supervisor_binary().map_err(|e| e.message().to_string())?;
    let home = dirs::home_dir().ok_or_else(|| "this user has no home folder".to_string())?;
    let install = os_scheduler::Install::new(
        exe,
        data_folder(app),
        interval.unwrap_or(os_scheduler::DEFAULT_INTERVAL_MINUTES),
    )
    .with_headless_host(os_scheduler::headless_host(
        os_scheduler::Platform::current(),
        &os_scheduler::SystemInstaller,
        &os_scheduler::system_root(),
    ));
    Ok((install, home))
}

/// Whether the OS-scheduler entry is installed, and what installing it would
/// do. Never changes anything.
#[tauri::command]
pub async fn schedule_os_status<R: Runtime>(
    app_handle: AppHandle<R>,
    interval_minutes: Option<u32>,
) -> Result<os_scheduler::OsStatus, String> {
    let (install, home) = os_install(&app_handle, interval_minutes)?;
    blocking(move || Ok(os_scheduler::status(os_scheduler::Platform::current(), &install, &home, &os_scheduler::SystemInstaller, None)))
        .await
}

/// Install the entry (opt-in; the page asks first and shows the preview).
#[tauri::command]
pub async fn schedule_os_enable<R: Runtime>(
    app_handle: AppHandle<R>,
    interval_minutes: Option<u32>,
) -> Result<os_scheduler::OsStatus, String> {
    let (install, home) = os_install(&app_handle, interval_minutes)?;
    blocking(move || {
        let platform = os_scheduler::Platform::current();
        let installer = os_scheduler::SystemInstaller;
        let result = os_scheduler::enable(platform, &install, &home, &installer);
        let detail = result.err();
        Ok(os_scheduler::status(platform, &install, &home, &installer, detail))
    })
    .await
}

/// Remove the entry and every file it wrote.
#[tauri::command]
pub async fn schedule_os_disable<R: Runtime>(
    app_handle: AppHandle<R>,
    interval_minutes: Option<u32>,
) -> Result<os_scheduler::OsStatus, String> {
    let (install, home) = os_install(&app_handle, interval_minutes)?;
    blocking(move || {
        let platform = os_scheduler::Platform::current();
        let installer = os_scheduler::SystemInstaller;
        let result = os_scheduler::disable(platform, &install, &home, &installer);
        let detail = result.err();
        Ok(os_scheduler::status(platform, &install, &home, &installer, detail))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::schedule::spec::TimeOfDay;

    #[test]
    fn the_preview_matches_what_would_be_saved() {
        let s = Schedule::Weekdays { times: vec![TimeOfDay { hour: 9, minute: 0 }, TimeOfDay { hour: 17, minute: 30 }] };
        let f = schedule_preview(s, "Europe/Berlin".into(), Some(5)).unwrap();
        assert_eq!(f.len(), 5);
        assert!(f.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn the_preview_explains_a_schedule_it_would_refuse() {
        assert!(schedule_preview(Schedule::Cron { expr: "99 * * * *".into() }, "UTC".into(), None)
            .unwrap_err()
            .contains("minute"));
        assert!(schedule_preview(Schedule::Cron { expr: "0 0 31 2 *".into() }, "UTC".into(), None)
            .unwrap_err()
            .contains("never"));
        assert!(schedule_preview(Schedule::Cron { expr: "* * * * *".into() }, "Mars/Base".into(), None)
            .unwrap_err()
            .contains("time zone"));
    }

    #[test]
    fn the_zone_and_tool_lists_are_not_empty() {
        assert!(schedule_time_zones().iter().any(|z| z == "Europe/Berlin"));
        let tools = schedule_tools();
        assert!(tools.iter().any(|t| t.name == "read" && t.capability == "read"));
        assert!(tools.iter().any(|t| t.name == "bash" && t.capability == "exec"));
    }
}
