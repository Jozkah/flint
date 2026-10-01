//! Turning a due fire into a detached job, and settling what became of it.
//!
//! The app (or `flint cli schedule run <id>`) writes a run spec and a run
//! record, then asks a supervisor to run `flint cli schedule run-spec --spec
//! <file>` -- the same detached-job machinery durable subagents use, so a run
//! outlives the app that started it. The child (`cli::schedule`) is the only
//! thing that talks to a model; it folds the run's events through [`Observer`]
//! and writes the ending into the run record with [`finish`].
//!
//! Nothing here sends a prompt anywhere. What travels to the child is a spec:
//! the frozen task, the run it answers, the data folder. Never a credential --
//! the child resolves providers and keys the way any CLI run in that data
//! folder does.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri_plugin_agent_tools::job_record::JobState;

use super::engine::{self, Limits, SkipReason};
use super::spec::{looks_like_secret, OnBlock, Task};
use super::store::{now_ms, trim_summary, RunRecord, RunStatus, Spend, Store, StoreError, Trigger};

/// Marks a job record as a scheduled run.
pub const KIND: &str = "schedule";
pub const SPEC_VERSION: u16 = 1;
/// A run record that says `running` with no job after this long was abandoned
/// between being written and being launched.
const LAUNCH_GRACE_MS: u64 = 2 * 60 * 1000;
/// Blocked-on lines kept per run.
pub const MAX_BLOCKED_LINES: usize = 50;
const MAX_BLOCKED_LINE_CHARS: usize = 200;

/// Everything a scheduled child needs, and nothing secret.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunSpec {
    pub v: u16,
    /// The run record this answers.
    pub run_id: String,
    /// The task as it was when the run started; later edits do not change a
    /// run in flight.
    pub task: Task,
    pub trigger: Trigger,
    pub scheduled_for: DateTime<Utc>,
    pub data_folder: String,
}

impl RunSpec {
    pub fn validate(&self) -> Result<(), String> {
        if self.v != SPEC_VERSION {
            return Err(format!("a schedule spec of version {} is not one this build runs", self.v));
        }
        if self.run_id.trim().is_empty() {
            return Err("a schedule spec needs a run id".to_string());
        }
        self.task.validate().map_err(|e| e.message)
    }
}

pub fn specs_dir(store: &Store) -> PathBuf {
    store.root().join("specs")
}

pub fn spec_path(store: &Store, run_id: &str) -> PathBuf {
    let safe: String = run_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    specs_dir(store).join(format!("{safe}.json"))
}

pub fn write_spec(store: &Store, spec: &RunSpec) -> Result<PathBuf, String> {
    spec.validate()?;
    let path = spec_path(store, &spec.run_id);
    std::fs::create_dir_all(specs_dir(store)).map_err(|e| format!("the specs folder could not be created: {e}"))?;
    let body = serde_json::to_vec_pretty(spec).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("the run spec could not be written: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("the run spec could not be written: {e}"))?;
    Ok(path)
}

pub fn read_spec(path: &Path) -> Result<RunSpec, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("the run spec could not be read: {e}"))?;
    let spec: RunSpec = serde_json::from_str(&text).map_err(|e| format!("the run spec is not valid: {e}"))?;
    spec.validate()?;
    Ok(spec)
}

/// The argv a supervisor runs: this binary, never a shell.
pub fn child_argv(spec_file: &Path) -> Vec<String> {
    vec![
        "cli".to_string(),
        "schedule".to_string(),
        "run-spec".to_string(),
        "--spec".to_string(),
        spec_file.to_string_lossy().to_string(),
    ]
}

/// The owner a task's jobs are listed under.
pub fn owner_for(task_id: &str) -> String {
    format!("schedule-{task_id}")
}

/// How a job gets started; the real one hands it to a detached supervisor.
pub trait Launcher {
    /// Returns the job id.
    fn launch(&self, data_folder: &Path, owner: &str, argv: &[String], summary: &str, run: &str, name: &str)
        -> Result<String, String>;
}

pub struct SupervisorLauncher;

impl Launcher for SupervisorLauncher {
    fn launch(
        &self,
        data_folder: &Path,
        owner: &str,
        argv: &[String],
        summary: &str,
        run: &str,
        name: &str,
    ) -> Result<String, String> {
        let supervisor = tauri_plugin_agent_tools::worker::supervisor_binary().map_err(|e| e.message().to_string())?;
        tauri_plugin_agent_tools::worker::start_argv(
            data_folder,
            &supervisor,
            owner,
            argv,
            summary,
            KIND,
            (run, run, name),
        )
        .map(|r| r.id)
        .map_err(|e| e.message().to_string())
    }
}

/// Settle every run still marked `running` against its job, and return the
/// tasks that genuinely have a run in flight.
///
/// A job that ended without the child writing its ending (it was killed, the
/// machine slept through the wall clock, the app was force-closed) leaves a
/// record that says `running` forever; this is where it is closed honestly.
pub fn settle(store: &Store, data_folder: &Path) -> BTreeSet<String> {
    let mut live = BTreeSet::new();
    for mut run in store.running_runs() {
        let owner = owner_for(&run.task_id);
        let verdict = match run.job_id.as_deref() {
            None => {
                if now_ms().saturating_sub(run.started_at_ms) > LAUNCH_GRACE_MS {
                    Some((RunStatus::Failed, "the run was never launched".to_string()))
                } else {
                    live.insert(run.task_id.clone());
                    None
                }
            }
            Some(job) => {
                let _ = tauri_plugin_agent_tools::worker::reconcile(data_folder, &owner);
                match tauri_plugin_agent_tools::worker::find(data_folder, &owner, job) {
                    None => Some((RunStatus::Failed, "its job record is gone".to_string())),
                    Some(rec) if rec.state == JobState::Running => {
                        live.insert(run.task_id.clone());
                        None
                    }
                    Some(rec) => Some(match rec.state {
                        JobState::Cancelled => (RunStatus::Cancelled, "cancelled".to_string()),
                        JobState::Completed => (RunStatus::Failed, "the job ended without recording its result".to_string()),
                        other => (RunStatus::Failed, format!("the job ended: {}", other.tag())),
                    }),
                }
            }
        };
        if let Some((status, why)) = verdict {
            run.status = status;
            run.ended_at_ms = Some(now_ms());
            if status != RunStatus::Cancelled {
                run.error.get_or_insert(why);
            }
            let _ = store.update_run(&run);
        }
    }
    live
}

/// Start one run of a task now. Refuses (with a `skipped` record) when the
/// previous run is still going.
pub fn start_run(
    store: &Store,
    data_folder: &Path,
    launcher: &dyn Launcher,
    task: &Task,
    trigger: Trigger,
    scheduled_for: DateTime<Utc>,
) -> Result<RunRecord, StoreError> {
    if settle(store, data_folder).contains(&task.id) {
        return store.record_skipped(task, trigger, scheduled_for, "the previous run was still going");
    }
    let mut record = store.begin_run(task, trigger, scheduled_for)?;
    let spec = RunSpec {
        v: SPEC_VERSION,
        run_id: record.id.clone(),
        task: task.clone(),
        trigger,
        scheduled_for,
        data_folder: data_folder.to_string_lossy().to_string(),
    };
    let fail = |store: &Store, mut record: RunRecord, why: String| {
        record.status = RunStatus::Failed;
        record.ended_at_ms = Some(now_ms());
        record.error = Some(why);
        let _ = store.update_run(&record);
        record
    };
    let path = match write_spec(store, &spec) {
        Ok(p) => p,
        Err(why) => return Ok(fail(store, record, why)),
    };
    let summary = format!("scheduled task {}", task.name);
    match launcher.launch(data_folder, &owner_for(&task.id), &child_argv(&path), &summary, &record.id, &task.name) {
        Ok(job) => {
            record.job_id = Some(job);
            store.update_run(&record)?;
            Ok(record)
        }
        Err(why) => {
            let _ = std::fs::remove_file(&path);
            Ok(fail(store, record, why))
        }
    }
}

/// What one tick did.
#[derive(Debug, Default)]
pub struct TickReport {
    pub started: Vec<RunRecord>,
    pub skipped: Vec<RunRecord>,
    /// The tick did not run because another process held the lock.
    pub locked_out: bool,
    pub errors: Vec<String>,
}

/// One scheduler pass: lock, settle, ask the engine what is due, start it,
/// store the new watermarks. Safe to call as often as wanted and from several
/// processes; also the startup catch-up pass.
pub fn tick(store: &Store, data_folder: &Path, launcher: &dyn Launcher, now: DateTime<Utc>) -> TickReport {
    let mut report = TickReport::default();
    let Some(_lock) = store.try_lock_tick() else {
        report.locked_out = true;
        return report;
    };
    let tasks = match store.load_tasks() {
        Ok(t) => t,
        Err(e) => {
            report.errors.push(e.message);
            return report;
        }
    };
    if tasks.is_empty() {
        return report;
    }
    let running = settle(store, data_folder);
    let due = engine::due(now, &tasks, &store.watermarks(), &running, Limits::default());
    // Watermarks first: a crash after this point loses a fire rather than
    // doubling one, which is the right way round for a job that costs money.
    if let Err(e) = store.merge_watermarks(&due.watermarks) {
        report.errors.push(e.message);
        return report;
    }
    for skip in &due.skipped {
        let Some(task) = tasks.iter().find(|t| t.id == skip.task_id) else { continue };
        let why = match skip.reason {
            SkipReason::StillRunning => "the previous run was still going",
            SkipReason::CatchUpSkipped => "missed while the app was closed; this task skips missed runs",
            SkipReason::Superseded => "missed; a later run covers it",
            SkipReason::InvalidSchedule => "the schedule is not valid",
        };
        // Superseded fires are noise; the covering run says enough.
        if skip.reason == SkipReason::Superseded {
            continue;
        }
        match store.record_skipped(task, Trigger::OnTime, skip.scheduled_for, why) {
            Ok(r) => report.skipped.push(r),
            Err(e) => report.errors.push(e.message),
        }
    }
    for fire in &due.fires {
        let Some(task) = tasks.iter().find(|t| t.id == fire.task_id) else { continue };
        match start_run(store, data_folder, launcher, task, fire.kind.into(), fire.scheduled_for) {
            Ok(r) => report.started.push(r),
            Err(e) => report.errors.push(e.message),
        }
    }
    report
}

// ---- the child's side, kept free of I/O so it can be tested ----

fn blocked_line(tool: &str, capability: &str, path: Option<&str>, command: Option<&str>) -> String {
    let what = command.or(path).unwrap_or("").trim().replace(['\n', '\r'], " ");
    let what = if looks_like_secret(&what) { "<redacted>".to_string() } else { what };
    let line = if what.is_empty() { format!("{tool} ({capability})") } else { format!("{tool} ({capability}): {what}") };
    if line.chars().count() > MAX_BLOCKED_LINE_CHARS {
        let cut: String = line.chars().take(MAX_BLOCKED_LINE_CHARS).collect();
        format!("{cut}...")
    } else {
        line
    }
}

/// Folds a run's events into what its record keeps.
#[derive(Debug, Clone)]
pub struct Observer {
    on_block: OnBlock,
    pub turns: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub blocked_on: Vec<String>,
    /// Set once a prompt was denied and the task is set to end on that.
    pub should_end: bool,
}

impl Observer {
    pub fn new(on_block: OnBlock) -> Observer {
        Observer { on_block, turns: 0, input_tokens: 0, output_tokens: 0, blocked_on: Vec::new(), should_end: false }
    }

    /// A permission prompt nobody can answer. Always denied by the caller;
    /// this records it, and says whether the run should now end.
    pub fn blocked(&mut self, tool: &str, capability: &str, path: Option<&str>, command: Option<&str>) -> bool {
        if self.blocked_on.len() < MAX_BLOCKED_LINES {
            self.blocked_on.push(blocked_line(tool, capability, path, command));
        }
        if self.on_block == OnBlock::End {
            self.should_end = true;
        }
        self.should_end
    }

    pub fn observe(&mut self, ev: &crate::core::agent::events::StreamEvent) {
        use crate::core::agent::events::StreamEvent as E;
        match ev {
            E::Step { index, .. } => self.turns = self.turns.max(*index),
            E::TurnUsage { usage, .. } => {
                self.input_tokens += usage.prompt_tokens.unwrap_or(0);
                self.output_tokens += usage.completion_tokens.unwrap_or(0);
            }
            _ => {}
        }
    }

    pub fn spend(&self) -> Spend {
        Spend { turns: self.turns, input_tokens: self.input_tokens, output_tokens: self.output_tokens }
    }
}

/// How a run ended, as far as the child can tell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ending {
    Answered(String),
    /// A turn, token or money budget ran out.
    BudgetStopped(String),
    WallClock,
    /// A prompt was denied and the task is set to end on that.
    Blocked,
    Failed(String),
}

/// Write the ending into the record.
pub fn finish(record: &mut RunRecord, obs: &Observer, ending: Ending, ended_ms: u64) {
    record.ended_at_ms = Some(ended_ms);
    record.spend = obs.spend();
    record.blocked_on = obs.blocked_on.clone();
    match ending {
        Ending::Answered(text) => {
            record.status = RunStatus::Succeeded;
            record.summary = Some(trim_summary(&text));
        }
        Ending::BudgetStopped(why) => {
            record.status = RunStatus::BudgetStopped;
            record.error = Some(why);
        }
        Ending::WallClock => {
            record.status = RunStatus::BudgetStopped;
            record.error = Some("stopped: the time limit ran out".to_string());
        }
        Ending::Blocked => {
            record.status = RunStatus::Blocked;
            record.error = Some("ended: a tool needed approval and nobody could give it".to_string());
        }
        Ending::Failed(why) => {
            record.status = RunStatus::Failed;
            record.error = Some(trim_summary(&why));
        }
    }
}

/// Whether a finished completion was cut short by the cost ceiling, and the
/// reason to record if so. The loop ends such a run with an answer and
/// `finish_reason: "budget_exceeded"`, not an error, so it is read here.
pub fn cost_stop(completion: &serde_json::Value, limit: Option<f64>) -> Option<String> {
    let reason = completion.pointer("/choices/0/finish_reason").and_then(|v| v.as_str())?;
    if reason != "budget_exceeded" {
        return None;
    }
    Some(match limit {
        Some(usd) => format!("stopped: the ${usd:.2} cost limit was reached"),
        None => "stopped: the cost limit was reached".to_string(),
    })
}

/// A setup failure, with what a person needs to fix it when the cost limit is
/// the reason: a limit cannot be metered for a model with no price.
pub fn explain_setup_failure(error: &str, limit: Option<f64>) -> String {
    if limit.is_some() && error.contains("no price is declared") {
        format!(
            "the task has a cost limit but its model has no price, so spend cannot be metered.              Set the model's price in prices.toml, or remove the limit. ({error})"
        )
    } else {
        error.to_string()
    }
}

/// The contentless line a notification carries.
pub fn notification_line(status: RunStatus) -> String {
    let tag = match status {
        RunStatus::Succeeded => "succeeded",
        RunStatus::Failed => "failed",
        RunStatus::BudgetStopped => "stopped at its limit",
        RunStatus::Blocked => "ended, a tool needed approval",
        RunStatus::Cancelled => "cancelled",
        RunStatus::Skipped => "skipped",
        RunStatus::Running => "running",
    };
    format!("a scheduled run ended: {tag}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::events::{StreamEvent, Usage};
    use crate::core::schedule::spec::fixtures::task;
    use crate::core::schedule::spec::{CatchUp, Schedule, TimeOfDay};
    use std::cell::RefCell;
    use tauri_plugin_agent_tools::job_record::{self, JobRecord, ProcessIdentity};

    struct FakeLauncher {
        calls: RefCell<Vec<(String, Vec<String>)>>,
        fail: bool,
    }

    impl FakeLauncher {
        fn new() -> Self {
            FakeLauncher { calls: RefCell::new(Vec::new()), fail: false }
        }
    }

    impl Launcher for FakeLauncher {
        fn launch(
            &self,
            data_folder: &Path,
            owner: &str,
            argv: &[String],
            summary: &str,
            _run: &str,
            _name: &str,
        ) -> Result<String, String> {
            if self.fail {
                return Err("no supervisor beside the app".into());
            }
            let id = format!("job-{}", self.calls.borrow().len() + 1);
            self.calls.borrow_mut().push((owner.to_string(), argv.to_vec()));
            // A job whose process is this test process: alive, and checkable.
            let pid = std::process::id();
            let identity = ProcessIdentity { pid, created: job_record::creation_time_of(pid).unwrap_or(0) };
            let mut rec = JobRecord::started(id.clone(), owner, summary, identity);
            rec.kind = KIND.to_string();
            job_record::save(data_folder, &rec).map_err(|e| e.to_string())?;
            Ok(id)
        }
    }

    fn setup() -> (tempfile::TempDir, Store) {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path());
        (d, s)
    }

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn a_spec_round_trips_and_carries_no_credential_field() {
        let (d, s) = setup();
        let spec = RunSpec {
            v: SPEC_VERSION,
            run_id: "r-1".into(),
            task: task("a"),
            trigger: Trigger::Manual,
            scheduled_for: utc("2026-05-02T09:00:00Z"),
            data_folder: d.path().to_string_lossy().to_string(),
        };
        let path = write_spec(&s, &spec).unwrap();
        assert_eq!(read_spec(&path).unwrap(), spec);
        let text = std::fs::read_to_string(&path).unwrap().to_lowercase();
        for k in ["apikey", "api_key", "authorization", "password"] {
            assert!(!text.contains(k), "{k}");
        }
    }

    #[test]
    fn a_spec_for_an_unsafe_task_is_refused() {
        let (d, s) = setup();
        let mut t = task("a");
        t.budgets.max_turns = 0;
        let spec = RunSpec {
            v: SPEC_VERSION,
            run_id: "r-1".into(),
            task: t,
            trigger: Trigger::Manual,
            scheduled_for: Utc::now(),
            data_folder: d.path().to_string_lossy().to_string(),
        };
        assert!(write_spec(&s, &spec).is_err());
        assert!(read_spec(&s.root().join("nope.json")).is_err());
    }

    #[test]
    fn the_child_is_this_binary_with_arguments_never_a_shell_line() {
        let argv = child_argv(Path::new("C:/x/spec.json"));
        assert_eq!(&argv[..4], ["cli", "schedule", "run-spec", "--spec"]);
        assert_eq!(argv.len(), 5);
    }

    #[test]
    fn starting_a_run_writes_the_record_the_spec_and_a_job() {
        let (d, s) = setup();
        let t = s.save_task(task("a")).unwrap();
        let l = FakeLauncher::new();
        let r = start_run(&s, d.path(), &l, &t, Trigger::Manual, Utc::now()).unwrap();
        assert_eq!(r.status, RunStatus::Running);
        assert_eq!(r.job_id.as_deref(), Some("job-1"));
        let calls = l.calls.borrow();
        assert_eq!(calls[0].0, "schedule-a");
        assert!(read_spec(Path::new(&calls[0].1[4])).is_ok());
        assert_eq!(s.get_run("a", &r.id).unwrap().unwrap().job_id.as_deref(), Some("job-1"));
    }

    #[test]
    fn a_second_run_while_one_is_in_flight_is_recorded_as_skipped() {
        let (d, s) = setup();
        let t = s.save_task(task("a")).unwrap();
        let l = FakeLauncher::new();
        start_run(&s, d.path(), &l, &t, Trigger::Manual, Utc::now()).unwrap();
        let second = start_run(&s, d.path(), &l, &t, Trigger::OnTime, Utc::now()).unwrap();
        assert_eq!(second.status, RunStatus::Skipped);
        assert_eq!(l.calls.borrow().len(), 1, "no second job was started");
    }

    #[test]
    fn a_launch_failure_is_recorded_not_lost() {
        let (d, s) = setup();
        let t = s.save_task(task("a")).unwrap();
        let l = FakeLauncher { calls: RefCell::new(Vec::new()), fail: true };
        let r = start_run(&s, d.path(), &l, &t, Trigger::Manual, Utc::now()).unwrap();
        assert_eq!(r.status, RunStatus::Failed);
        assert!(r.error.unwrap().contains("supervisor"));
        assert!(!settle(&s, d.path()).contains("a"), "a failed launch is not in flight");
    }

    #[test]
    fn a_job_that_ended_without_writing_its_ending_is_closed_as_failed() {
        let (d, s) = setup();
        let t = s.save_task(task("a")).unwrap();
        let l = FakeLauncher::new();
        let r = start_run(&s, d.path(), &l, &t, Trigger::Manual, Utc::now()).unwrap();
        assert!(settle(&s, d.path()).contains("a"));
        let mut job = tauri_plugin_agent_tools::worker::find(d.path(), "schedule-a", "job-1").unwrap();
        job.state = JobState::Interrupted;
        job.ended_at_ms = Some(job_record::now_ms());
        job_record::save(d.path(), &job).unwrap();
        assert!(settle(&s, d.path()).is_empty());
        let after = s.get_run("a", &r.id).unwrap().unwrap();
        assert_eq!(after.status, RunStatus::Failed);
        assert!(after.error.unwrap().contains("interrupted"));
    }

    #[test]
    fn a_tick_starts_what_is_due_once_and_a_locked_tick_does_nothing() {
        let (d, s) = setup();
        let mut t = task("a");
        t.schedule = Schedule::Daily { times: vec![TimeOfDay { hour: 9, minute: 0 }] };
        t.catch_up = CatchUp::Skip;
        s.save_task(t).unwrap();
        let l = FakeLauncher::new();
        // First sight of the task: the watermark is set, nothing runs.
        let first = tick(&s, d.path(), &l, utc("2026-05-02T08:59:30Z"));
        assert!(first.started.is_empty());
        let at = tick(&s, d.path(), &l, utc("2026-05-02T09:00:20Z"));
        assert_eq!(at.started.len(), 1);
        assert_eq!(at.started[0].trigger, Trigger::OnTime);
        let again = tick(&s, d.path(), &l, utc("2026-05-02T09:00:50Z"));
        assert!(again.started.is_empty(), "the same fire does not run twice");
        assert_eq!(l.calls.borrow().len(), 1);

        let held = s.try_lock_tick().unwrap();
        let blocked = tick(&s, d.path(), &l, utc("2026-05-03T09:00:20Z"));
        assert!(blocked.locked_out && blocked.started.is_empty());
        drop(held);
    }

    #[test]
    fn a_tick_that_finds_the_task_running_records_a_skip() {
        let (d, s) = setup();
        let mut t = task("a");
        t.catch_up = CatchUp::Skip;
        s.save_task(t).unwrap();
        let l = FakeLauncher::new();
        tick(&s, d.path(), &l, utc("2026-05-02T08:59:30Z"));
        tick(&s, d.path(), &l, utc("2026-05-02T09:00:20Z"));
        let next_day = tick(&s, d.path(), &l, utc("2026-05-03T09:00:20Z"));
        assert!(next_day.started.is_empty());
        assert_eq!(next_day.skipped.len(), 1);
        assert_eq!(next_day.skipped[0].status, RunStatus::Skipped);
    }

    #[test]
    fn the_observer_counts_spend_and_records_what_was_blocked() {
        let mut o = Observer::new(OnBlock::Continue);
        o.observe(&StreamEvent::Step { index: 1, max: 0 });
        o.observe(&StreamEvent::Step { index: 2, max: 0 });
        let usage = |p, c| Usage { prompt_tokens: Some(p), completion_tokens: Some(c), ..Default::default() };
        o.observe(&StreamEvent::TurnUsage { usage: usage(10, 3), execution_id: None });
        o.observe(&StreamEvent::TurnUsage { usage: usage(20, 4), execution_id: None });
        assert!(!o.blocked("bash", "exec", None, Some("rm -rf build")));
        assert_eq!(o.spend(), Spend { turns: 2, input_tokens: 30, output_tokens: 7 });
        assert_eq!(o.blocked_on, vec!["bash (exec): rm -rf build"]);
    }

    #[test]
    fn on_block_end_ends_the_run_and_continue_does_not() {
        let mut end = Observer::new(OnBlock::End);
        assert!(end.blocked("write", "write", Some("src/a.rs"), None));
        assert!(end.should_end);
        let mut go = Observer::new(OnBlock::Continue);
        assert!(!go.blocked("write", "write", Some("src/a.rs"), None));
    }

    #[test]
    fn a_blocked_line_never_repeats_a_credential_and_stays_short() {
        let mut o = Observer::new(OnBlock::Continue);
        o.blocked("bash", "exec", None, Some("curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' x"));
        assert!(o.blocked_on[0].contains("<redacted>"));
        assert!(!o.blocked_on[0].contains("abcdefghij"));
        o.blocked("bash", "exec", None, Some(&"x".repeat(900)));
        assert!(o.blocked_on[1].chars().count() <= MAX_BLOCKED_LINE_CHARS + 3);
        for _ in 0..80 {
            o.blocked("read", "read", Some("a"), None);
        }
        assert_eq!(o.blocked_on.len(), MAX_BLOCKED_LINES);
    }

    #[test]
    fn each_ending_maps_to_a_status_and_keeps_the_blocked_lines() {
        let (_d, s) = setup();
        let t = s.save_task(task("a")).unwrap();
        let mut o = Observer::new(OnBlock::Continue);
        o.blocked("write", "write", Some("a.txt"), None);
        let cases = [
            (Ending::Answered("all good".into()), RunStatus::Succeeded),
            (Ending::BudgetStopped("reached the 3-turn limit".into()), RunStatus::BudgetStopped),
            (Ending::WallClock, RunStatus::BudgetStopped),
            (Ending::Blocked, RunStatus::Blocked),
            (Ending::Failed("boom".into()), RunStatus::Failed),
        ];
        for (ending, status) in cases {
            let mut r = s.begin_run(&t, Trigger::Manual, Utc::now()).unwrap();
            finish(&mut r, &o, ending, now_ms());
            assert_eq!(r.status, status);
            assert!(r.ended_at_ms.is_some());
            assert_eq!(r.blocked_on, vec!["write (write): a.txt"]);
        }
    }

    #[test]
    fn a_cost_ceiling_stop_is_told_from_a_finished_answer() {
        let stopped = serde_json::json!({"choices":[{"finish_reason":"budget_exceeded","message":{"content":"partial"}}]});
        let done = serde_json::json!({"choices":[{"finish_reason":"stop","message":{"content":"done"}}]});
        assert_eq!(cost_stop(&stopped, Some(0.5)).unwrap(), "stopped: the $0.50 cost limit was reached");
        assert!(cost_stop(&done, Some(0.5)).is_none());
        assert!(cost_stop(&serde_json::json!({}), None).is_none());
    }

    #[test]
    fn an_unpriced_model_with_a_cost_limit_gets_a_clear_reason() {
        let raw = "cannot cap spend for m: no price is declared for it in prices.toml";
        let msg = explain_setup_failure(raw, Some(1.0));
        assert!(msg.contains("no price") && msg.contains("prices.toml") && msg.contains("remove the limit"));
        assert_eq!(explain_setup_failure(raw, None), raw, "without a limit the error is untouched");
        assert_eq!(explain_setup_failure("other", Some(1.0)), "other");
    }

    #[test]
    fn notifications_say_how_it_ended_and_nothing_else() {
        let line = notification_line(RunStatus::Succeeded);
        assert_eq!(line, "a scheduled run ended: succeeded");
        assert!(notification_line(RunStatus::Blocked).contains("approval"));
    }
}
