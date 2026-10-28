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

    fn bak_path(&self) -> PathBuf {
        self.root.join("tasks.json.bak")
    }

    pub fn load_tasks(&self) -> Result<Vec<Task>, StoreError> {
        let text = match fs::read_to_string(self.tasks_path()) {
            Ok(t) => t,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(io_err("the task list could not be read", e)),
        };
        match parse_tasks(&text) {
            Ok(tasks) => Ok(tasks),
            Err(ParseFail::Version(m)) => Err(StoreError::new(m)),
            Err(ParseFail::Invalid(m)) => {
                // Damaged file: the copy taken before the last save, if good.
                if let Ok(bak) = fs::read_to_string(self.bak_path()) {
                    if let Ok(tasks) = parse_tasks(&bak) {
                        set_recovery_notice(format!(
                            "tasks.json was damaged ({m}); the copy from before the last save was loaded"
                        ));
                        return Ok(tasks);
                    }
                }
                Err(StoreError::new(format!("tasks.json is not valid: {m}")))
            }
        }
    }

    fn write_tasks(&self, tasks: Vec<Task>) -> Result<(), StoreError> {
        // Keep the last good file as a fallback before replacing it.
        if let Ok(cur) = fs::read_to_string(self.tasks_path()) {
            if parse_tasks_strict(&cur) {
                let _ = fs::copy(self.tasks_path(), self.bak_path());
            }
        }
        write_json(&self.tasks_path(), &TasksFile { version: SCHEMA_VERSION, tasks })
    }

    /// Run `f` holding the tasks lock: in-process mutex first, then the
    /// cross-process `tasks.lock` file. Lock order: `tick.lock` then this.
    fn with_tasks_lock<R>(&self, f: impl FnOnce() -> Result<R, StoreError>) -> Result<R, StoreError> {
        let m = process_lock_for(&self.tasks_path());
        let _g = m.lock().unwrap_or_else(|e| e.into_inner());
        fs::create_dir_all(&self.root).map_err(|e| io_err("the schedules folder could not be created", e))?;
        let path = self.root.join("tasks.lock");
        let deadline = std::time::Instant::now() + TASKS_LOCK_WAIT;
        let _file = loop {
            if let Some(l) = acquire_lock_file(&path, TASKS_LOCK_STALE_SECS) {
                break l;
            }
            if std::time::Instant::now() >= deadline {
                return Err(StoreError::new("the task list is busy; try again"));
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        f()
    }

    /// One-shot notice that the task list was restored from its backup.
    pub fn take_recovery_notice() -> Option<String> {
        RECOVERY_NOTICE.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    pub fn get_task(&self, id: &str) -> Result<Option<Task>, StoreError> {
        Ok(self.load_tasks()?.into_iter().find(|t| t.id == id))
    }

    /// Validate and save a task, adding or replacing by id.
    pub fn save_task(&self, mut task: Task) -> Result<Task, StoreError> {
        task.validate()?;
        self.with_tasks_lock(|| self.save_task_locked(task))
    }

    fn save_task_locked(&self, mut task: Task) -> Result<Task, StoreError> {
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
        self.with_tasks_lock(|| self.set_enabled_locked(id, enabled))
    }

    fn set_enabled_locked(&self, id: &str, enabled: bool) -> Result<Task, StoreError> {
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
        let removed = self.with_tasks_lock(|| {
            let mut tasks = self.load_tasks()?;
            let before = tasks.len();
            tasks.retain(|t| t.id != id);
            if tasks.len() == before {
                return Ok(false);
            }
            self.write_tasks(tasks)?;
            Ok(true)
        })?;
        if !removed {
            return Ok(false);
        }
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
        // A mark far ahead of the real clock would silence its task; clamp it.
        let now = Utc::now();
        let limit = now + chrono::Duration::seconds(super::engine::MAX_FUTURE_SKEW_SECS);
        state.watermarks.extend(new.iter().map(|(k, v)| (k.clone(), if *v > limit { now } else { *v })));
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
            // Every record, not the newest few: skip records written while a
            // long run is still going would push it out of a short window and
            // let a second run start beside it. Retention bounds the count.
            if let Ok(rs) = self.list_runs(&t.id, usize::MAX) {
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
            // A run still going is never pruned: it is what stops a second one.
            let running = fs::read_to_string(dir.join(&n))
                .ok()
                .and_then(|t| serde_json::from_str::<RunRecord>(&t).ok())
                .is_some_and(|r| r.status == RunStatus::Running);
            if running {
                continue;
            }
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
        acquire_lock_file(&self.root.join("tick.lock"), LOCK_STALE_SECS).map(|l| TickLock { _lock: l })
    }
}

/// Released on drop.
#[derive(Debug)]
pub struct TickLock {
    _lock: LockFile,
}

/// A lock file removed on drop.
#[derive(Debug)]
struct LockFile {
    path: PathBuf,
}

impl Drop for LockFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// Wait at most this long for `tasks.lock`.
const TASKS_LOCK_WAIT: Duration = Duration::from_secs(3);
/// A `tasks.lock` older than this belonged to a dead writer (edits take ms).
const TASKS_LOCK_STALE_SECS: u64 = 10;

static RECOVERY_NOTICE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn set_recovery_notice(msg: String) {
    *RECOVERY_NOTICE.lock().unwrap_or_else(|e| e.into_inner()) = Some(msg);
}

fn process_lock_for(path: &Path) -> std::sync::Arc<std::sync::Mutex<()>> {
    static LOCKS: std::sync::Mutex<BTreeMap<PathBuf, std::sync::Arc<std::sync::Mutex<()>>>> =
        std::sync::Mutex::new(BTreeMap::new());
    let mut g = LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    g.entry(path.to_path_buf()).or_default().clone()
}

fn lock_age_exceeds(path: &Path, secs: u64) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age > Duration::from_secs(secs))
}

/// Create `path` exclusively. A stale one is taken over by renaming it to a
/// name unique to this caller (only one racer's rename can succeed) rather
/// than check-then-delete, which let two callers each delete the other's new
/// lock. If the renamed file turns out fresh, it is put back.
fn acquire_lock_file(path: &Path, stale_secs: u64) -> Option<LockFile> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    for _ in 0..3 {
        match fs::OpenOptions::new().write(true).create_new(true).open(path) {
            Ok(mut f) => {
                use std::io::Write;
                let _ = write!(f, "{} {}", std::process::id(), now_ms());
                return Some(LockFile { path: path.to_path_buf() });
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                if !lock_age_exceeds(path, stale_secs) {
                    return None;
                }
                let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let mut n = path.file_name()?.to_os_string();
                n.push(format!(".stale-{}-{seq}", std::process::id()));
                let grave = path.with_file_name(n);
                if fs::rename(path, &grave).is_err() {
                    continue; // someone else took it over first
                }
                if lock_age_exceeds(&grave, stale_secs) {
                    let _ = fs::remove_file(&grave);
                } else {
                    // We moved a lock a faster racer had just made: give it back.
                    let _ = fs::hard_link(&grave, path);
                    let _ = fs::remove_file(&grave);
                    return None;
                }
            }
            Err(_) => return None,
        }
    }
    None
}

enum ParseFail {
    /// Valid JSON of a schema this build does not read.
    Version(String),
    Invalid(String),
}

/// Parse tasks.json. A task that does not parse is skipped, the rest load; a
/// file that is not JSON at all, or has no `tasks` array, is Invalid.
fn parse_tasks(text: &str) -> Result<Vec<Task>, ParseFail> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| ParseFail::Invalid(e.to_string()))?;
    let version = v.get("version").and_then(|x| x.as_u64()).ok_or_else(|| ParseFail::Invalid("no version".into()))?;
    if version != u64::from(SCHEMA_VERSION) {
        return Err(ParseFail::Version(format!(
            "tasks.json is version {version}, this build reads version {SCHEMA_VERSION}"
        )));
    }
    let arr = v.get("tasks").and_then(|x| x.as_array()).ok_or_else(|| ParseFail::Invalid("no tasks list".into()))?;
    Ok(arr.iter().filter_map(|t| serde_json::from_value::<Task>(t.clone()).ok()).collect())
}

/// True when every task in the text parses (so it is worth keeping as backup).
fn parse_tasks_strict(text: &str) -> bool {
    serde_json::from_str::<TasksFile>(text).is_ok_and(|f| f.version == SCHEMA_VERSION)
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), StoreError> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| io_err("the schedules folder could not be created", e))?;
    }
    let body = serde_json::to_vec_pretty(value).map_err(|e| StoreError::new(e.to_string()))?;
    crate::core::threads::helpers::write_file_atomically(path, &body)
        .map_err(|e| StoreError::new(format!("a schedule file could not be written: {e}")))
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
    fn merge_watermarks_clamps_future() {
        let (_d, s) = store();
        let far = Utc::now() + chrono::Duration::days(30);
        s.merge_watermarks(&[("a".to_string(), far)].into()).unwrap();
        assert!(s.watermarks()["a"] < Utc::now() + chrono::Duration::hours(1));
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
        for r in &before {
            let mut r = r.clone();
            r.status = RunStatus::Succeeded;
            s.update_run(&r).unwrap();
        }
        assert_eq!(s.prune_runs("a", 4).unwrap(), 2);
        let after = s.list_runs("a", 50).unwrap();
        assert_eq!(after.len(), 4);
        assert_eq!(after[0].id, before[0].id, "the newest survive");
    }

    #[test]
    fn a_long_run_stays_running_behind_many_newer_records() {
        let (_d, s) = store();
        let t = s.save_task(task("a")).unwrap();
        let long = s.begin_run(&t, Trigger::OnTime, Utc::now()).unwrap();
        for _ in 0..12 {
            std::thread::sleep(Duration::from_millis(2));
            s.record_skipped(&t, Trigger::OnTime, Utc::now(), "still going").unwrap();
        }
        assert_eq!(s.running_runs().iter().map(|r| r.id.clone()).collect::<Vec<_>>(), vec![long.id.clone()]);
        // Pruning past it keeps the running record.
        s.prune_runs("a", 3).unwrap();
        assert!(s.get_run("a", &long.id).unwrap().is_some());
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
    fn concurrent_save_and_set_enabled_lose_nothing() {
        let (_d, s) = store();
        s.save_task(task("base")).unwrap();
        let s = std::sync::Arc::new(s);
        let mut hs = Vec::new();
        for i in 0..8 {
            let s = s.clone();
            hs.push(std::thread::spawn(move || {
                s.save_task(task(&format!("t{i}"))).unwrap();
                s.set_enabled("base", i % 2 == 0).unwrap();
            }));
        }
        for h in hs {
            h.join().unwrap();
        }
        assert_eq!(s.load_tasks().unwrap().len(), 9);
    }

    #[test]
    fn once_task_self_disable_does_not_revert_edit() {
        let (_d, s) = store();
        s.save_task(task("a")).unwrap();
        // An edit lands between the tick's load and its disable.
        let mut edited = task("a");
        edited.name = "Edited".into();
        s.save_task(edited).unwrap();
        s.set_enabled("a", false).unwrap();
        let t = s.get_task("a").unwrap().unwrap();
        assert_eq!(t.name, "Edited");
        assert!(!t.enabled);
    }

    #[test]
    fn lock_is_stale_after_timeout() {
        let (_d, s) = store();
        fs::create_dir_all(s.root()).unwrap();
        let path = s.root().join("tasks.lock");
        fs::write(&path, "1 0").unwrap();
        let old = SystemTime::now() - Duration::from_secs(TASKS_LOCK_STALE_SECS + 5);
        fs::File::options().write(true).open(&path).unwrap().set_modified(old).unwrap();
        s.save_task(task("a")).unwrap();
        assert!(!path.exists(), "lock released");
    }

    #[test]
    fn stale_takeover_lets_only_one_racer_in() {
        let (_d, s) = store();
        fs::create_dir_all(s.root()).unwrap();
        let path = s.root().join("tick.lock");
        fs::write(&path, "1 0").unwrap();
        let old = SystemTime::now() - Duration::from_secs(LOCK_STALE_SECS + 30);
        fs::File::options().write(true).open(&path).unwrap().set_modified(old).unwrap();
        let s = std::sync::Arc::new(s);
        let hs: Vec<_> = (0..8)
            .map(|_| {
                let s = s.clone();
                std::thread::spawn(move || {
                    let l = s.try_lock_tick();
                    std::thread::sleep(Duration::from_millis(100));
                    l.is_some()
                })
            })
            .collect();
        let winners = hs.into_iter().map(|h| h.join().unwrap()).filter(|w| *w).count();
        assert_eq!(winners, 1);
    }

    #[test]
    fn corrupt_tasks_falls_back_to_bak() {
        let (_d, s) = store();
        s.save_task(task("a")).unwrap();
        s.save_task(task("b")).unwrap(); // bak now holds [a]
        fs::write(s.root().join("tasks.json"), "{ torn").unwrap();
        let tasks = s.load_tasks().unwrap();
        assert_eq!(tasks.len(), 1);
        assert!(Store::take_recovery_notice().is_some());
        // No backup and no JSON: error stays.
        fs::remove_file(s.root().join("tasks.json.bak")).unwrap();
        assert!(s.load_tasks().is_err());
    }

    #[test]
    fn one_bad_task_is_skipped_others_load() {
        let (_d, s) = store();
        s.save_task(task("a")).unwrap();
        let mut v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(s.root().join("tasks.json")).unwrap()).unwrap();
        v["tasks"].as_array_mut().unwrap().push(serde_json::json!({"id": 5, "junk": true}));
        fs::write(s.root().join("tasks.json"), v.to_string()).unwrap();
        let tasks = s.load_tasks().unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "a");
    }

    #[test]
    fn bak_written_before_each_save() {
        let (_d, s) = store();
        s.save_task(task("a")).unwrap();
        assert!(!s.root().join("tasks.json.bak").exists());
        s.save_task(task("b")).unwrap();
        let bak = fs::read_to_string(s.root().join("tasks.json.bak")).unwrap();
        assert!(bak.contains("\"a\"") && !bak.contains("\"b\""));
    }

    #[test]
    fn a_long_summary_is_trimmed() {
        let long = "x".repeat(MAX_SUMMARY_CHARS + 50);
        let t = trim_summary(&long);
        assert_eq!(t.chars().count(), MAX_SUMMARY_CHARS + 3);
        assert!(t.ends_with("..."));
    }
}
