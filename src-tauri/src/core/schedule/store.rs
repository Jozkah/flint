//! Scheduled tasks on disk.
//!
//! ```text
//! <data>/schedules/tasks.json            the tasks (schema-versioned)
//! <data>/schedules/state.json            per-task watermarks the engine reads
//! <data>/schedules/tick.lock             held while one process runs a tick
//! <data>/schedules/runs/<task>/<id>.json one record per run, newest sorts last
//! ```
//!
//! Every write is a temp file renamed into place, so a crash or a second
//! process never leaves half a file. A file whose version this build does not
//! know is refused, not rewritten.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::engine::FireKind;
use super::spec::{id_is_safe, ScheduleError, Task, SCHEMA_VERSION};

/// Run records kept per task; older ones are deleted when a new one is begun.
pub const DEFAULT_RETENTION: usize = 100;
/// A tick lock older than this belonged to a process that died.
pub const LOCK_STALE_SECS: u64 = 120;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StoreError {
    pub message: String,
}

impl StoreError {
    fn new(message: impl Into<String>) -> Self {
        StoreError { message: message.into() }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for StoreError {}

impl From<ScheduleError> for StoreError {
    fn from(e: ScheduleError) -> Self {
        StoreError { message: e.message }
    }
}

fn io_err(what: &str, e: io::Error) -> StoreError {
    StoreError::new(format!("{what}: {e}"))
}

#[derive(Debug, Serialize, Deserialize)]
struct TasksFile {
    version: u32,
    tasks: Vec<Task>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StateFile {
    version: u32,
    #[serde(default)]
    watermarks: BTreeMap<String, DateTime<Utc>>,
}

/// How a run ended, or that it has not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Succeeded,
    Failed,
    /// Stopped by a turn, token or time budget.
    BudgetStopped,
    /// Ended because a tool needed approval and the task is set to end.
    Blocked,
    Cancelled,
    /// Never started: a run was already in flight, or it was a missed run the
    /// task forgets.
    Skipped,
}

impl RunStatus {
    pub fn is_ended(self) -> bool {
        self != RunStatus::Running
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Trigger {
    Manual,
    OnTime,
    CatchUp,
}

impl From<FireKind> for Trigger {
    fn from(k: FireKind) -> Self {
        match k {
            FireKind::OnTime => Trigger::OnTime,
            FireKind::CatchUp => Trigger::CatchUp,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spend {
    pub turns: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// One run of one task.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub version: u32,
    /// File stem; sorts by start time.
    pub id: String,
    pub task_id: String,
    pub task_name: String,
    pub trigger: Trigger,
    /// The fire time this run answers (the start time for a manual run).
    pub scheduled_for: DateTime<Utc>,
    pub started_at_ms: u64,
    #[serde(default)]
    pub ended_at_ms: Option<u64>,
    pub status: RunStatus,
    /// The detached job (`worker` record) running it.
    #[serde(default)]
    pub job_id: Option<String>,
    /// The conversation holding the run's transcript.
    #[serde(default)]
    pub session_id: Option<String>,
    /// The run's final answer, trimmed.
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub spend: Spend,
    /// One line per tool call that needed approval nobody could give.
    #[serde(default)]
    pub blocked_on: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
    /// The branch a write-enabled run worked on.
    #[serde(default)]
    pub branch: Option<String>,
}

pub const MAX_SUMMARY_CHARS: usize = 4000;

pub fn trim_summary(text: &str) -> String {
    let t = text.trim();
    if t.chars().count() <= MAX_SUMMARY_CHARS {
        return t.to_string();
    }
    let cut: String = t.chars().take(MAX_SUMMARY_CHARS).collect();
    format!("{cut}...")
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The scheduler's folder inside a data folder.
#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn new(data_folder: &Path) -> Store {
        Store { root: data_folder.join("schedules") }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn tasks_path(&self) -> PathBuf {
        self.root.join("tasks.json")
    }

    fn state_path(&self) -> PathBuf {
        self.root.join("state.json")
    }

    fn runs_dir(&self, task_id: &str) -> Result<PathBuf, StoreError> {
        if !id_is_safe(task_id) {
            return Err(StoreError::new("not a task id"));
        }
        Ok(self.root.join("runs").join(task_id))
    }

    // ---- tasks ----

    pub fn load_tasks(&self) -> Result<Vec<Task>, StoreError> {
        let text = match fs::read_to_string(self.tasks_path()) {
            Ok(t) => t,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(io_err("the task list could not be read", e)),
        };
        let file: TasksFile = serde_json::from_str(&text)
            .map_err(|e| StoreError::new(format!("tasks.json is not valid: {e}")))?;
        if file.version != SCHEMA_VERSION {
            return Err(StoreError::new(format!(
                "tasks.json is version {}, this build reads version {SCHEMA_VERSION}",
                file.version
            )));
        }
        Ok(file.tasks)
    }

    fn write_tasks(&self, tasks: Vec<Task>) -> Result<(), StoreError> {
        write_json(&self.tasks_path(), &TasksFile { version: SCHEMA_VERSION, tasks })
    }

    pub fn get_task(&self, id: &str) -> Result<Option<Task>, StoreError> {
        Ok(self.load_tasks()?.into_iter().find(|t| t.id == id))
    }

    /// Validate and save a task, adding or replacing by id.
    pub fn save_task(&self, mut task: Task) -> Result<Task, StoreError> {
        task.validate()?;
        let mut tasks = self.load_tasks()?;
        let now = now_ms();
        task.name = task.name.trim().to_string();
        match tasks.iter_mut().find(|t| t.id == task.id) {
            Some(existing) => {
                task.created_at_ms = existing.created_at_ms;
                task.updated_at_ms = now;
                *existing = task.clone();
            }
            None => {
                task.created_at_ms = now;
                task.updated_at_ms = now;
                tasks.push(task.clone());
            }
        }
        self.write_tasks(tasks)?;
        Ok(task)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<Task, StoreError> {
        let mut tasks = self.load_tasks()?;
        let task = tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| StoreError::new(format!("no task '{id}'")))?;
        task.enabled = enabled;
        task.updated_at_ms = now_ms();
        let out = task.clone();
        self.write_tasks(tasks)?;
        Ok(out)
    }

    /// Delete a task, its watermark and its run history.
    pub fn delete_task(&self, id: &str) -> Result<bool, StoreError> {
        let mut tasks = self.load_tasks()?;
        let before = tasks.len();
        tasks.retain(|t| t.id != id);
        if tasks.len() == before {
            return Ok(false);
        }
        self.write_tasks(tasks)?;
        let mut state = self.load_state()?;
        if state.watermarks.remove(id).is_some() {
            write_json(&self.state_path(), &state)?;
        }
        let _ = fs::remove_dir_all(self.runs_dir(id)?);
        Ok(true)
    }

    // ---- watermarks ----

    fn load_state(&self) -> Result<StateFile, StoreError> {
        match fs::read_to_string(self.state_path()) {
            Ok(t) => {
                let s: StateFile = serde_json::from_str(&t).unwrap_or_default();
                Ok(if s.version == SCHEMA_VERSION { s } else { StateFile { version: SCHEMA_VERSION, ..Default::default() } })
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(StateFile { version: SCHEMA_VERSION, ..Default::default() }),
            Err(e) => Err(io_err("the schedule state could not be read", e)),
        }
    }

    /// An unreadable state file means "no history": the engine then starts each
    /// task from now rather than firing everything it ever missed.
    pub fn watermarks(&self) -> BTreeMap<String, DateTime<Utc>> {
        self.load_state().map(|s| s.watermarks).unwrap_or_default()
    }

    pub fn merge_watermarks(&self, new: &BTreeMap<String, DateTime<Utc>>) -> Result<(), StoreError> {
        if new.is_empty() {
            return Ok(());
        }
        let mut state = self.load_state()?;
        state.version = SCHEMA_VERSION;
        state.watermarks.extend(new.iter().map(|(k, v)| (k.clone(), *v)));
        write_json(&self.state_path(), &state)
    }

    // ---- runs ----

    /// Write a new run record in `running` state and prune old ones.
    pub fn begin_run(
        &self,
        task: &Task,
        trigger: Trigger,
        scheduled_for: DateTime<Utc>,
    ) -> Result<RunRecord, StoreError> {
        let dir = self.runs_dir(&task.id)?;
        let started = now_ms();
        let id = format!("{started:013}-{}", &uuid::Uuid::new_v4().simple().to_string()[..6]);
        let record = RunRecord {
            version: SCHEMA_VERSION,
            id,
            task_id: task.id.clone(),
            task_name: task.name.clone(),
            trigger,
            scheduled_for,
            started_at_ms: started,
            ended_at_ms: None,
            status: RunStatus::Running,
            job_id: None,
            session_id: None,
            summary: None,
            spend: Spend::default(),
            blocked_on: Vec::new(),
            error: None,
            branch: None,
        };
        write_json(&dir.join(format!("{}.json", record.id)), &record)?;
        self.prune_runs(&task.id, DEFAULT_RETENTION)?;
        Ok(record)
    }

    /// A record of a run that never started.
    pub fn record_skipped(
        &self,
        task: &Task,
        trigger: Trigger,
        scheduled_for: DateTime<Utc>,
        why: &str,
    ) -> Result<RunRecord, StoreError> {
        let mut r = self.begin_run(task, trigger, scheduled_for)?;
        r.status = RunStatus::Skipped;
        r.ended_at_ms = Some(now_ms());
        r.error = Some(why.to_string());
        self.update_run(&r)?;
        Ok(r)
    }

    pub fn update_run(&self, record: &RunRecord) -> Result<(), StoreError> {
        let dir = self.runs_dir(&record.task_id)?;
        if !id_is_safe(&record.id) {
            return Err(StoreError::new("not a run id"));
        }
        write_json(&dir.join(format!("{}.json", record.id)), record)
    }

    pub fn get_run(&self, task_id: &str, run_id: &str) -> Result<Option<RunRecord>, StoreError> {
        if !id_is_safe(run_id) {
            return Ok(None);
        }
        let path = self.runs_dir(task_id)?.join(format!("{run_id}.json"));
        match fs::read_to_string(&path) {
            Ok(t) => Ok(serde_json::from_str(&t).ok()),
            Err(_) => Ok(None),
        }
    }

    /// Run records for a task, newest first. Unreadable files are skipped.
    pub fn list_runs(&self, task_id: &str, limit: usize) -> Result<Vec<RunRecord>, StoreError> {
        let dir = self.runs_dir(task_id)?;
        let mut names: Vec<String> = match fs::read_dir(&dir) {
            Ok(rd) => rd
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.ends_with(".json"))
                .collect(),
            Err(_) => return Ok(Vec::new()),
        };
        names.sort();
        names.reverse();
        let mut out = Vec::new();
        for n in names.into_iter().take(limit.max(1)) {
            if let Ok(t) = fs::read_to_string(dir.join(&n)) {
                if let Ok(r) = serde_json::from_str::<RunRecord>(&t) {
                    out.push(r);
                }
            }
        }
        Ok(out)
    }

    /// Runs still marked `running`, across all tasks.
    pub fn running_runs(&self) -> Vec<RunRecord> {
        let Ok(tasks) = self.load_tasks() else { return Vec::new() };
        let mut out = Vec::new();
        for t in tasks {
            // A run is "running" only recently-started ones can be; newest 10 is plenty.
            if let Ok(rs) = self.list_runs(&t.id, 10) {
                out.extend(rs.into_iter().filter(|r| r.status == RunStatus::Running));
            }
        }
        out
    }

    /// Keep the newest `keep` records of a task.
    pub fn prune_runs(&self, task_id: &str, keep: usize) -> Result<usize, StoreError> {
        let dir = self.runs_dir(task_id)?;
        let mut names: Vec<String> = match fs::read_dir(&dir) {
            Ok(rd) => rd
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.ends_with(".json"))
                .collect(),
            Err(_) => return Ok(0),
        };
        if names.len() <= keep {
            return Ok(0);
        }
        names.sort();
        let drop = names.len() - keep;
        let mut removed = 0;
        for n in names.into_iter().take(drop) {
            if fs::remove_file(dir.join(n)).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }

    // ---- tick lock ----

    /// Take the lock for one tick, or `None` if another process holds it.
    pub fn try_lock_tick(&self) -> Option<TickLock> {
        fs::create_dir_all(&self.root).ok()?;
        let path = self.root.join("tick.lock");
        for _ in 0..2 {
            match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut f) => {
                    use std::io::Write;
                    let _ = write!(f, "{} {}", std::process::id(), now_ms());
                    return Some(TickLock { path });
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    let stale = fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| SystemTime::now().duration_since(t).ok())
                        .is_some_and(|age| age > Duration::from_secs(LOCK_STALE_SECS));
                    if !stale {
                        return None;
                    }
                    let _ = fs::remove_file(&path);
                }
                Err(_) => return None,
            }
        }
        None
    }
}

/// Released on drop.
#[derive(Debug)]
pub struct TickLock {
    path: PathBuf,
}

impl Drop for TickLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), StoreError> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| io_err("the schedules folder could not be created", e))?;
    }
    let body = serde_json::to_vec_pretty(value).map_err(|e| StoreError::new(e.to_string()))?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    fs::write(&tmp, body).map_err(|e| io_err("a schedule file could not be written", e))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        io_err("a schedule file could not be replaced", e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::schedule::spec::fixtures::task;

    fn store() -> (tempfile::TempDir, Store) {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path());
        (d, s)
    }

    #[test]
    fn tasks_round_trip_and_replace_by_id() {
        let (_d, s) = store();
        assert!(s.load_tasks().unwrap().is_empty());
        let a = s.save_task(task("a")).unwrap();
        assert!(a.created_at_ms > 0);
        let mut changed = task("a");
        changed.name = "Renamed".into();
        let b = s.save_task(changed).unwrap();
        assert_eq!(b.created_at_ms, a.created_at_ms);
        let all = s.load_tasks().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Renamed");
        let text = fs::read_to_string(s.root().join("tasks.json")).unwrap();
        assert!(text.contains("\"version\": 1"));
    }

    #[test]
    fn an_invalid_task_is_not_saved() {
        let (_d, s) = store();
        let mut t = task("a");
        t.budgets.max_turns = 0;
        assert!(s.save_task(t).is_err());
        assert!(!s.root().join("tasks.json").exists());
    }

    #[test]
    fn a_future_schema_is_refused_and_left_alone() {
        let (_d, s) = store();
        fs::create_dir_all(s.root()).unwrap();
        fs::write(s.root().join("tasks.json"), r#"{"version":99,"tasks":[]}"#).unwrap();
        assert!(s.load_tasks().unwrap_err().message.contains("version 99"));
        assert!(s.save_task(task("a")).is_err());
        assert!(fs::read_to_string(s.root().join("tasks.json")).unwrap().contains("99"));
    }

    #[test]
    fn enabling_and_deleting_clean_up_after_themselves() {
        let (_d, s) = store();
        s.save_task(task("a")).unwrap();
        assert!(!s.set_enabled("a", false).unwrap().enabled);
        assert!(s.set_enabled("nope", true).is_err());
        let t = s.get_task("a").unwrap().unwrap();
        s.begin_run(&t, Trigger::Manual, Utc::now()).unwrap();
        s.merge_watermarks(&[("a".to_string(), Utc::now())].into()).unwrap();
        assert!(s.delete_task("a").unwrap());
        assert!(!s.delete_task("a").unwrap());
        assert!(s.watermarks().is_empty());
        assert!(!s.root().join("runs").join("a").exists());
    }

    #[test]
    fn watermarks_merge_and_survive_a_corrupt_file() {
        let (_d, s) = store();
        let t0 = Utc::now();
        s.merge_watermarks(&[("a".to_string(), t0)].into()).unwrap();
        s.merge_watermarks(&[("b".to_string(), t0)].into()).unwrap();
        assert_eq!(s.watermarks().len(), 2);
        fs::write(s.root().join("state.json"), "{ not json").unwrap();
        assert!(s.watermarks().is_empty());
    }

    #[test]
    fn runs_are_listed_newest_first_and_updated_in_place() {
        let (_d, s) = store();
        let t = s.save_task(task("a")).unwrap();
        let mut ids = Vec::new();
        for _ in 0..3 {
            let r = s.begin_run(&t, Trigger::OnTime, Utc::now()).unwrap();
            ids.push(r.id);
            std::thread::sleep(Duration::from_millis(3));
        }
        let listed = s.list_runs("a", 10).unwrap();
        assert_eq!(listed.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), ids.iter().rev().cloned().collect::<Vec<_>>());
        let mut r = listed[0].clone();
        r.status = RunStatus::Succeeded;
        r.summary = Some(trim_summary("done"));
        r.blocked_on = vec!["bash: rm -rf build".into()];
        r.spend = Spend { turns: 3, input_tokens: 100, output_tokens: 20 };
        s.update_run(&r).unwrap();
        assert_eq!(s.get_run("a", &r.id).unwrap().unwrap(), r);
        assert_eq!(s.running_runs().len(), 2);
        assert_eq!(s.list_runs("a", 2).unwrap().len(), 2);
    }

    #[test]
    fn the_retention_cap_deletes_the_oldest_records() {
        let (_d, s) = store();
        let t = s.save_task(task("a")).unwrap();
        for _ in 0..6 {
            s.begin_run(&t, Trigger::Manual, Utc::now()).unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
        let before = s.list_runs("a", 50).unwrap();
        assert_eq!(before.len(), 6);
        assert_eq!(s.prune_runs("a", 4).unwrap(), 2);
        let after = s.list_runs("a", 50).unwrap();
        assert_eq!(after.len(), 4);
        assert_eq!(after[0].id, before[0].id, "the newest survive");
    }

    #[test]
    fn a_skipped_run_leaves_a_record_with_the_reason() {
        let (_d, s) = store();
        let t = s.save_task(task("a")).unwrap();
        let r = s.record_skipped(&t, Trigger::OnTime, Utc::now(), "the previous run was still going").unwrap();
        assert_eq!(r.status, RunStatus::Skipped);
        assert!(s.get_run("a", &r.id).unwrap().unwrap().error.unwrap().contains("still going"));
    }

    #[test]
    fn ids_cannot_escape_the_runs_folder() {
        let (_d, s) = store();
        assert!(s.list_runs("../x", 5).is_err());
        assert!(s.get_run("a", "../../tasks").unwrap().is_none());
    }

    #[test]
    fn only_one_process_holds_the_tick_lock() {
        let (_d, s) = store();
        let first = s.try_lock_tick().expect("first caller gets it");
        assert!(s.try_lock_tick().is_none(), "a second caller does not");
        drop(first);
        assert!(s.try_lock_tick().is_some(), "released on drop");
    }

    #[test]
    fn a_stale_lock_from_a_dead_process_is_taken_over() {
        let (_d, s) = store();
        fs::create_dir_all(s.root()).unwrap();
        let path = s.root().join("tick.lock");
        fs::write(&path, "1 0").unwrap();
        let old = SystemTime::now() - Duration::from_secs(LOCK_STALE_SECS + 30);
        fs::File::options().write(true).open(&path).unwrap().set_modified(old).unwrap();
        assert!(s.try_lock_tick().is_some());
    }

    #[test]
    fn a_long_summary_is_trimmed() {
        let long = "x".repeat(MAX_SUMMARY_CHARS + 50);
        let t = trim_summary(&long);
        assert_eq!(t.chars().count(), MAX_SUMMARY_CHARS + 3);
        assert!(t.ends_with("..."));
    }
}
