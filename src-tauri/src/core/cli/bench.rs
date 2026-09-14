//! A benchmark harness for the harness itself (AH-196).
//!
//! A change to the agent loop -- a new system prompt, a retry policy, a tool
//! description -- is judged by running it. `flint cli bench run` runs a fixed task
//! set through the real headless agent and records, per task, whether the result
//! passed its checks and what it cost; `flint cli bench compare` sets two reports
//! side by side and fails when a task that passed before fails now.
//!
//! ## The task set
//!
//! One TOML file:
//!
//! ```toml
//! name = "smoke"
//!
//! [[task]]
//! id = "write-greeting"
//! prompt = "Create hello.txt containing exactly: hello"
//! files = { "README.md" = "# fixture\n" }        # the project it starts from
//! checks = [
//!   { kind = "file_equals", path = "hello.txt", text = "hello" },
//! ]
//! ```
//!
//! Checks are objective and read-only: `file_equals`, `file_contains`,
//! `file_absent`, `result_contains` (the run's final answer). A check that needs
//! judgement is not a check.
//!
//! ## How a task runs
//!
//! In a fresh scratch copy of its project, as a separate `flint cli agent run
//! --output-format json` process -- the same binary, the same loop, nothing
//! mocked in-process -- with the model, provider settings and data folder of the
//! benchmark run. The child is owned (`tools::owned`): an interrupted benchmark
//! stops it and its tree, and the scratch copy is removed whatever happens.
//!
//! ## What is refused
//!
//! A task file that does not parse, has no tasks, repeats an id, names an
//! unknown check or a path that escapes the task's project, by kind, before
//! anything runs. `compare` refuses two reports of different task sets rather
//! than comparing unlike things.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError};

pub const REPORT_VERSION: u32 = 1;

/// The longest one task may run before it is stopped and recorded as timed out.
pub const DEFAULT_TASK_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TaskSet {
    pub name: String,
    #[serde(rename = "task")]
    pub tasks: Vec<Task>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub id: String,
    pub prompt: String,
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    #[serde(default)]
    pub checks: Vec<Check>,
    /// Seconds; the default is [`DEFAULT_TASK_TIMEOUT`].
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Check {
    FileEquals { path: String, text: String },
    FileContains { path: String, text: String },
    FileAbsent { path: String },
    ResultContains { text: String },
}

fn refuse(kind: ErrorKind, message: impl Into<String>) -> HarnessError {
    HarnessError::new(kind, message.into())
}

/// A path a task names, checked to stay inside the task's project.
fn inside(path: &str) -> Result<PathBuf, HarnessError> {
    let candidate = Path::new(path);
    let escapes = candidate.is_absolute()
        || candidate.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir));
    if path.trim().is_empty() || escapes {
        return Err(refuse(ErrorKind::InvalidInput, format!("the path {path:?} is not inside the task's project")));
    }
    Ok(candidate.to_path_buf())
}

/// Read and check a task set. Everything wrong with it is found before
/// anything runs.
pub fn load_tasks(path: &Path) -> Result<(TaskSet, String), HarnessError> {
    let raw = std::fs::read_to_string(path).map_err(|e| {
        let kind = if e.kind() == std::io::ErrorKind::NotFound { ErrorKind::NotFound } else { ErrorKind::Io };
        refuse(kind, format!("the task set {} cannot be read: {e}", path.display()))
    })?;
    let set: TaskSet = toml::from_str(&raw)
        .map_err(|e| refuse(ErrorKind::InvalidInput, format!("the task set {} is not valid: {}", path.display(), e.message())))?;
    if set.name.trim().is_empty() {
        return Err(refuse(ErrorKind::InvalidInput, "a task set needs a name"));
    }
    if set.tasks.is_empty() {
        return Err(refuse(ErrorKind::InvalidInput, "a task set needs at least one [[task]]"));
    }
    let mut ids = BTreeSet::new();
    for task in &set.tasks {
        let id_ok = !task.id.is_empty() && task.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !id_ok {
            return Err(refuse(ErrorKind::InvalidInput, format!("the task id {:?} may use only letters, digits, - and _", task.id)));
        }
        if !ids.insert(task.id.clone()) {
            return Err(refuse(ErrorKind::InvalidInput, format!("the task id {:?} is used twice", task.id)));
        }
        if task.prompt.trim().is_empty() {
            return Err(refuse(ErrorKind::InvalidInput, format!("task {:?} has no prompt", task.id)));
        }
        if task.checks.is_empty() {
            return Err(refuse(ErrorKind::InvalidInput, format!("task {:?} has no checks, so nothing could say whether it passed", task.id)));
        }
        for file in task.files.keys() {
            inside(file)?;
        }
        for check in &task.checks {
            match check {
                Check::FileEquals { path, .. } | Check::FileContains { path, .. } | Check::FileAbsent { path } => {
                    inside(path)?;
                }
                Check::ResultContains { .. } => {}
            }
        }
    }
    // The identity of the task set: its content, so two reports compare only
    // when they ran the same tasks with the same checks.
    let canonical = serde_json::to_vec(&set).unwrap_or_default();
    let digest = hex::encode(Sha256::digest(&canonical));
    Ok((set, digest))
}

/// What one task did.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskOutcome {
    pub id: String,
    pub passed: bool,
    /// `completed`, `failed_checks`, `run_error`, `timed_out` or `cancelled`.
    pub state: String,
    pub duration_ms: u64,
    pub turns: u32,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    /// One line per check that failed, and the run's own error when it had one.
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Report {
    pub version: u32,
    pub task_set: String,
    pub task_set_sha256: String,
    pub model: String,
    /// A label for what was being measured (a commit, a branch, a setting).
    pub label: String,
    pub started_at: String,
    /// False when the run was stopped before every task ran.
    pub complete: bool,
    pub tasks: Vec<TaskOutcome>,
}

impl Report {
    pub fn passed(&self) -> usize {
        self.tasks.iter().filter(|t| t.passed).count()
    }
}

/// Evaluate a task's checks against its project and the run's final answer.
pub fn evaluate(project: &Path, result: &str, checks: &[Check]) -> Vec<String> {
    let mut failures = Vec::new();
    for check in checks {
        match check {
            Check::FileEquals { path, text } => match std::fs::read_to_string(project.join(path)) {
                Ok(found) if found.trim_end_matches(['\r', '\n']) == text.trim_end_matches(['\r', '\n']) => {}
                Ok(found) => failures.push(format!("{path} holds {:?}, expected {:?}", truncate(&found), truncate(text))),
                Err(_) => failures.push(format!("{path} does not exist")),
            },
            Check::FileContains { path, text } => match std::fs::read_to_string(project.join(path)) {
                Ok(found) if found.contains(text.as_str()) => {}
                Ok(_) => failures.push(format!("{path} does not contain {:?}", truncate(text))),
                Err(_) => failures.push(format!("{path} does not exist")),
            },
            Check::FileAbsent { path } => {
                if project.join(path).exists() {
                    failures.push(format!("{path} exists and should not"));
                }
            }
            Check::ResultContains { text } => {
                if !result.contains(text.as_str()) {
                    failures.push(format!("the final answer does not contain {:?}", truncate(text)));
                }
            }
        }
    }
    failures
}

fn truncate(text: &str) -> String {
    text.chars().take(80).collect()
}

/// How one task is run. A trait so the orchestration -- scratch copies,
/// timeouts, cancellation, report assembly -- is tested without a model.
pub trait Runner {
    /// Run `prompt` in `project` and return the run's JSON result envelope, or
    /// why it could not be run.
    fn run(&self, project: &Path, prompt: &str, timeout: Duration, cancelled: &dyn Fn() -> bool) -> RunnerOutcome;
}

pub enum RunnerOutcome {
    Finished(serde_json::Value),
    TimedOut,
    Cancelled,
    CouldNotRun(String),
}

/// Run every task, in order, each in a fresh copy of its project under
/// `scratch`. Stops early -- and says so -- when `cancelled` turns true.
pub fn run_tasks(
    set: &TaskSet,
    digest: &str,
    model: &str,
    label: &str,
    scratch: &Path,
    runner: &dyn Runner,
    cancelled: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(&TaskOutcome),
) -> Result<Report, HarnessError> {
    std::fs::create_dir_all(scratch).map_err(|e| refuse(ErrorKind::Io, format!("the scratch folder is not usable: {e}")))?;
    let mut report = Report {
        version: REPORT_VERSION,
        task_set: set.name.clone(),
        task_set_sha256: digest.to_string(),
        model: model.to_string(),
        label: label.to_string(),
        started_at: tauri_plugin_agent_tools::audit::now(),
        complete: false,
        tasks: Vec::new(),
    };
    for task in &set.tasks {
        if cancelled() {
            return Ok(report);
        }
        let project = scratch.join(&task.id);
        let _ = std::fs::remove_dir_all(&project);
        std::fs::create_dir_all(project.join(".jan").join("agent"))
            .map_err(|e| refuse(ErrorKind::Io, format!("task {:?}: the project could not be made: {e}", task.id)))?;
        for (name, body) in &task.files {
            let path = project.join(inside(name)?);
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&path, body).map_err(|e| refuse(ErrorKind::Io, format!("task {:?}: {name} could not be written: {e}", task.id)))?;
        }
        if !task.files.contains_key(".jan/agent/agent.toml") {
            let _ = std::fs::write(project.join(".jan/agent/agent.toml"), "[tools]\ndefault = \"allow\"\n");
        }
        let started = Instant::now();
        let timeout = task.timeout_secs.map(Duration::from_secs).unwrap_or(DEFAULT_TASK_TIMEOUT);
        let outcome = runner.run(&project, &task.prompt, timeout, cancelled);
        let duration_ms = started.elapsed().as_millis() as u64;
        let mut entry = TaskOutcome {
            id: task.id.clone(),
            passed: false,
            state: String::new(),
            duration_ms,
            turns: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            notes: Vec::new(),
        };
        match outcome {
            RunnerOutcome::Finished(result) => {
                entry.turns = result["num_turns"].as_u64().unwrap_or(0) as u32;
                entry.prompt_tokens = result["usage"]["prompt_tokens"].as_u64().unwrap_or(0);
                entry.completion_tokens = result["usage"]["completion_tokens"].as_u64().unwrap_or(0);
                if result["is_error"].as_bool().unwrap_or(true) {
                    entry.state = "run_error".to_string();
                    entry.notes.push(format!(
                        "the run failed: {}",
                        truncate(result["error"]["message"].as_str().unwrap_or("no message"))
                    ));
                } else {
                    let failures = evaluate(&project, result["result"].as_str().unwrap_or(""), &task.checks);
                    entry.passed = failures.is_empty();
                    entry.state = if entry.passed { "completed" } else { "failed_checks" }.to_string();
                    entry.notes = failures;
                }
            }
            RunnerOutcome::TimedOut => {
                entry.state = "timed_out".to_string();
                entry.notes.push(format!("stopped after {}s", timeout.as_secs()));
            }
            RunnerOutcome::Cancelled => {
                entry.state = "cancelled".to_string();
                let _ = std::fs::remove_dir_all(&project);
                report.tasks.push(entry.clone());
                progress(&entry);
                return Ok(report);
            }
            RunnerOutcome::CouldNotRun(why) => {
                entry.state = "run_error".to_string();
                entry.notes.push(why);
            }
        }
        let _ = std::fs::remove_dir_all(&project);
        progress(&entry);
        report.tasks.push(entry);
    }
    report.complete = true;
    Ok(report)
}

/// One task's change between two reports.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Delta {
    pub id: String,
    pub before: Option<bool>,
    pub after: Option<bool>,
    pub duration_ms_change: i64,
    pub tokens_change: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Comparison {
    pub task_set: String,
    pub before_label: String,
    pub after_label: String,
    pub passed_before: usize,
    pub passed_after: usize,
    /// Tasks that passed before and do not now. Non-empty fails `compare`.
    pub regressions: Vec<String>,
    pub fixed: Vec<String>,
    pub deltas: Vec<Delta>,
}

/// Set two reports of the same task set side by side.
pub fn compare(before: &Report, after: &Report) -> Result<Comparison, HarnessError> {
    if before.task_set_sha256 != after.task_set_sha256 {
        return Err(refuse(
            ErrorKind::InvalidInput,
            format!(
                "these reports ran different task sets ({} {} vs {} {}); comparing them would compare unlike things",
                before.task_set,
                &before.task_set_sha256[..12.min(before.task_set_sha256.len())],
                after.task_set,
                &after.task_set_sha256[..12.min(after.task_set_sha256.len())]
            ),
        ));
    }
    let index = |r: &Report| r.tasks.iter().map(|t| (t.id.clone(), t.clone())).collect::<BTreeMap<_, _>>();
    let (b, a) = (index(before), index(after));
    let ids: BTreeSet<String> = b.keys().chain(a.keys()).cloned().collect();
    let mut comparison = Comparison {
        task_set: before.task_set.clone(),
        before_label: before.label.clone(),
        after_label: after.label.clone(),
        passed_before: before.passed(),
        passed_after: after.passed(),
        regressions: Vec::new(),
        fixed: Vec::new(),
        deltas: Vec::new(),
    };
    for id in ids {
        let (was, now) = (b.get(&id), a.get(&id));
        if was.is_some_and(|t| t.passed) && !now.is_some_and(|t| t.passed) {
            comparison.regressions.push(id.clone());
        }
        if !was.is_some_and(|t| t.passed) && now.is_some_and(|t| t.passed) {
            comparison.fixed.push(id.clone());
        }
        let tokens = |t: Option<&TaskOutcome>| t.map(|t| (t.prompt_tokens + t.completion_tokens) as i64).unwrap_or(0);
        let millis = |t: Option<&TaskOutcome>| t.map(|t| t.duration_ms as i64).unwrap_or(0);
        comparison.deltas.push(Delta {
            id,
            before: was.map(|t| t.passed),
            after: now.map(|t| t.passed),
            duration_ms_change: millis(now) - millis(was),
            tokens_change: tokens(now) - tokens(was),
        });
    }
    Ok(comparison)
}

/// Where one benchmark process keeps its scratch copies.
pub fn scratch_dir(temp: &Path, pid: u32) -> PathBuf {
    temp.join(format!("jan-bench-{pid}"))
}

/// Remove scratch left by benchmarks whose process is gone. A benchmark
/// stopped with Ctrl-C removes its own; one killed outright cannot, and this is
/// what keeps that from accumulating. A directory whose process is still
/// running -- another benchmark in flight -- is left alone.
pub fn sweep_stale_scratch(temp: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(temp) else { return Vec::new() };
    let mut swept = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|n| n.strip_prefix("jan-bench-")).and_then(|p| p.parse::<u32>().ok()) else {
            continue;
        };
        if pid == std::process::id() || tauri_plugin_agent_tools::tools::owned::process_exists(pid) {
            continue;
        }
        if entry.path().is_dir() && std::fs::remove_dir_all(entry.path()).is_ok() {
            swept.push(entry.path());
        }
    }
    swept
}

/// Read a report written by `run`, refusing one this build cannot read.
pub fn load_report(path: &Path) -> Result<Report, HarnessError> {
    let raw = std::fs::read_to_string(path).map_err(|e| {
        let kind = if e.kind() == std::io::ErrorKind::NotFound { ErrorKind::NotFound } else { ErrorKind::Io };
        refuse(kind, format!("the report {} cannot be read: {e}", path.display()))
    })?;
    let report: Report = serde_json::from_str(&raw)
        .map_err(|e| refuse(ErrorKind::InvalidInput, format!("{} is not a benchmark report: {e}", path.display())))?;
    if report.version != REPORT_VERSION {
        return Err(refuse(ErrorKind::InvalidInput, format!("{} is a version {} report; this build reads version {REPORT_VERSION}", path.display(), report.version)));
    }
    Ok(report)
}

/// The real runner: this binary's own `cli agent run --output-format json`, as
/// an owned child, with a deadline and cancellation that stop its whole tree.
pub struct ProcessRunner {
    pub program: PathBuf,
    pub model: String,
}

impl Runner for ProcessRunner {
    fn run(&self, project: &Path, prompt: &str, timeout: Duration, cancelled: &dyn Fn() -> bool) -> RunnerOutcome {
        use std::io::Read;
        let mut cmd = std::process::Command::new(&self.program);
        cmd.args(["cli", "agent", "run", "--output-format", "json", "--model", &self.model, "--project"])
            .arg(project)
            .arg(prompt)
            .current_dir(project)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        tauri_plugin_agent_tools::tools::owned::configure(&mut cmd);
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => return RunnerOutcome::CouldNotRun(format!("the agent could not be started: {e}")),
        };
        let owned = match tauri_plugin_agent_tools::tools::owned::OwnedChild::own(child.id()) {
            Ok(owned) => owned,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return RunnerOutcome::CouldNotRun(format!("the agent could not be tied to the benchmark: {e}"));
            }
        };
        let mut stdout = child.stdout.take().expect("stdout was piped");
        let reader = std::thread::spawn(move || {
            let mut out = String::new();
            let _ = stdout.read_to_string(&mut out);
            out
        });
        let deadline = Instant::now() + timeout;
        let stop = loop {
            match child.try_wait() {
                Ok(Some(_)) => break None,
                Ok(None) => {}
                Err(e) => break Some(RunnerOutcome::CouldNotRun(format!("the agent could not be waited on: {e}"))),
            }
            if cancelled() {
                break Some(RunnerOutcome::Cancelled);
            }
            if Instant::now() >= deadline {
                break Some(RunnerOutcome::TimedOut);
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        drop(owned);
        let _ = child.wait();
        let out = reader.join().unwrap_or_default();
        if let Some(stopped) = stop {
            return stopped;
        }
        match serde_json::from_str::<serde_json::Value>(&out) {
            Ok(result) => RunnerOutcome::Finished(result),
            Err(_) => RunnerOutcome::CouldNotRun(format!("the agent printed no result envelope: {}", truncate(out.trim()))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    const SET: &str = r#"
name = "smoke"

[[task]]
id = "greet"
prompt = "Create hello.txt containing hello"
files = { "README.md" = "fixture" }
checks = [{ kind = "file_equals", path = "hello.txt", text = "hello" }]

[[task]]
id = "answer"
prompt = "Say 42"
checks = [{ kind = "result_contains", text = "42" }, { kind = "file_absent", path = "junk.txt" }]
"#;

    #[test]
    fn the_committed_task_set_loads() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/bench/harness-smoke.toml");
        let (set, digest) = load_tasks(&path).expect("the committed benchmark task set loads");
        assert_eq!(set.name, "harness-smoke");
        assert_eq!(set.tasks.len(), 3);
        assert_eq!(digest.len(), 64);
    }

    #[test]
    fn a_task_set_is_checked_before_anything_runs() {
        let dir = tempfile::tempdir().unwrap();
        let (set, digest) = load_tasks(&write(dir.path(), "ok.toml", SET)).unwrap();
        assert_eq!(set.tasks.len(), 2);
        assert_eq!(digest.len(), 64);

        let kind = |body: &str| load_tasks(&write(dir.path(), "bad.toml", body)).unwrap_err().kind();
        assert_eq!(load_tasks(&dir.path().join("missing.toml")).unwrap_err().kind(), ErrorKind::NotFound);
        assert_eq!(kind("not toml ["), ErrorKind::InvalidInput);
        assert_eq!(kind("name = \"x\"\n"), ErrorKind::InvalidInput, "no tasks");
        assert_eq!(kind(&SET.replace("id = \"answer\"", "id = \"greet\"")), ErrorKind::InvalidInput, "duplicate id");
        assert_eq!(kind(&SET.replace("file_equals", "looks_right")), ErrorKind::InvalidInput, "unknown check");
        assert_eq!(kind(&SET.replace("path = \"hello.txt\"", "path = \"../outside.txt\"")), ErrorKind::InvalidInput, "escaping path");
        assert_eq!(kind(&SET.replace("\"README.md\"", "\"C:/Windows/x\"")), ErrorKind::InvalidInput, "absolute file");
        assert_eq!(kind(&SET.replace("prompt = \"Say 42\"", "prompt = \" \"")), ErrorKind::InvalidInput, "empty prompt");
        assert_eq!(kind(&SET.replace("checks = [{ kind = \"result_contains\", text = \"42\" }, { kind = \"file_absent\", path = \"junk.txt\" }]", "checks = []")), ErrorKind::InvalidInput, "no checks");
        assert_eq!(kind(&format!("{SET}\nsurprise = true\n")), ErrorKind::InvalidInput, "unknown field");
        // The digest follows the content, not the file name.
        let (_, again) = load_tasks(&write(dir.path(), "copy.toml", SET)).unwrap();
        assert_eq!(digest, again);
        let (_, changed) = load_tasks(&write(dir.path(), "changed.toml", &SET.replace("hello\" }", "hi\" }"))).unwrap();
        assert_ne!(digest, changed);
    }

    /// A runner that plays the model's part: writes what it is told to and
    /// answers from a table, so the orchestration is tested without one.
    struct Scripted {
        answers: BTreeMap<&'static str, (Option<(&'static str, &'static str)>, &'static str, bool)>,
        seen: RefCell<Vec<PathBuf>>,
    }

    impl Runner for Scripted {
        fn run(&self, project: &Path, prompt: &str, _timeout: Duration, _cancelled: &dyn Fn() -> bool) -> RunnerOutcome {
            self.seen.borrow_mut().push(project.to_path_buf());
            let (file, answer, error) = self.answers.iter().find(|(k, _)| prompt.contains(*k)).map(|(_, v)| *v).unwrap();
            assert!(project.join(".jan/agent/agent.toml").is_file(), "the project is a Jan project");
            if let Some((name, body)) = file {
                std::fs::write(project.join(name), body).unwrap();
            }
            RunnerOutcome::Finished(serde_json::json!({
                "is_error": error,
                "result": answer,
                "error": if error { serde_json::json!({ "message": "provider down" }) } else { serde_json::Value::Null },
                "num_turns": 2,
                "usage": { "prompt_tokens": 100, "completion_tokens": 10 },
            }))
        }
    }

    #[test]
    fn tasks_run_in_fresh_copies_are_checked_and_leave_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let (set, digest) = load_tasks(&write(dir.path(), "set.toml", SET)).unwrap();
        let scratch = dir.path().join("scratch");
        let good = Scripted {
            answers: BTreeMap::from([("hello", (Some(("hello.txt", "hello\n")), "done", false)), ("42", (None, "It is 42.", false))]),
            seen: RefCell::new(Vec::new()),
        };
        let mut shown = Vec::new();
        let report = run_tasks(&set, &digest, "m", "baseline", &scratch, &good, &|| false, &mut |t| shown.push(t.id.clone())).unwrap();
        assert!(report.complete);
        assert_eq!(report.passed(), 2, "{report:?}");
        assert_eq!(shown, vec!["greet", "answer"]);
        assert_eq!(report.tasks[0].turns, 2);
        assert_eq!(report.tasks[0].prompt_tokens, 100);
        assert!(good.seen.borrow().iter().all(|p| !p.exists()), "a scratch copy was left behind");

        // The same tasks, now failing one check and one run.
        let worse = Scripted {
            answers: BTreeMap::from([("hello", (Some(("hello.txt", "goodbye")), "done", false)), ("42", (None, "", true))]),
            seen: RefCell::new(Vec::new()),
        };
        let after = run_tasks(&set, &digest, "m", "changed", &scratch, &worse, &|| false, &mut |_| {}).unwrap();
        assert_eq!(after.passed(), 0);
        assert_eq!(after.tasks[0].state, "failed_checks");
        assert!(after.tasks[0].notes[0].contains("expected \"hello\""), "{:?}", after.tasks[0].notes);
        assert_eq!(after.tasks[1].state, "run_error");

        let comparison = compare(&report, &after).unwrap();
        assert_eq!(comparison.regressions, vec!["answer".to_string(), "greet".to_string()]);
        assert!(comparison.fixed.is_empty());
        assert_eq!((comparison.passed_before, comparison.passed_after), (2, 0));

        // Reports round-trip through the file a later compare reads.
        let path = dir.path().join("report.json");
        std::fs::write(&path, serde_json::to_string(&report).unwrap()).unwrap();
        assert_eq!(load_report(&path).unwrap(), report);
    }

    #[test]
    fn reports_of_different_task_sets_are_not_compared() {
        let dir = tempfile::tempdir().unwrap();
        let (set, digest) = load_tasks(&write(dir.path(), "set.toml", SET)).unwrap();
        let (_, other) = load_tasks(&write(dir.path(), "other.toml", &SET.replace("smoke", "other"))).unwrap();
        let empty = |d: &str| Report {
            version: REPORT_VERSION,
            task_set: set.name.clone(),
            task_set_sha256: d.to_string(),
            model: "m".into(),
            label: "x".into(),
            started_at: String::new(),
            complete: true,
            tasks: Vec::new(),
        };
        assert_eq!(compare(&empty(&digest), &empty(&other)).unwrap_err().kind(), ErrorKind::InvalidInput);
        let path = write(dir.path(), "future.json", &serde_json::to_string(&Report { version: 99, ..empty(&digest) }).unwrap());
        assert_eq!(load_report(&path).unwrap_err().kind(), ErrorKind::InvalidInput);
        assert_eq!(load_report(&write(dir.path(), "junk.json", "{}")).unwrap_err().kind(), ErrorKind::InvalidInput);
    }

    /// Cancellation after the fact: scratch left by a benchmark that was killed
    /// outright is removed by the next one; a running benchmark's is not.
    #[test]
    fn scratch_left_by_a_dead_benchmark_is_swept_and_a_live_ones_is_kept() {
        let temp = tempfile::tempdir().unwrap();
        // A pid that is certainly not running: a process that has exited.
        let mut exited = std::process::Command::new(if cfg!(windows) { "cmd" } else { "true" });
        if cfg!(windows) {
            exited.args(["/c", "exit"]);
        }
        let mut child = exited.spawn().unwrap();
        let dead = child.id();
        child.wait().unwrap();
        drop(child);
        let stale = scratch_dir(temp.path(), dead);
        std::fs::create_dir_all(stale.join("task-a")).unwrap();
        let mine = scratch_dir(temp.path(), std::process::id());
        std::fs::create_dir_all(&mine).unwrap();
        let unrelated = temp.path().join("jan-bench-notapid");
        std::fs::create_dir_all(&unrelated).unwrap();
        let file = temp.path().join("jan-bench-999999999");
        std::fs::write(&file, "not a directory").unwrap();

        let swept = sweep_stale_scratch(temp.path());
        assert_eq!(swept, vec![stale.clone()], "swept the wrong things");
        assert!(!stale.exists());
        assert!(mine.exists(), "a running benchmark's scratch was removed");
        assert!(unrelated.exists() && file.exists(), "something that is not benchmark scratch was removed");
    }

    /// Cancellation: a benchmark stopped part-way says it is incomplete, runs
    /// nothing more, and leaves no scratch copy.
    #[test]
    fn a_cancelled_benchmark_is_marked_incomplete_and_leaves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (set, digest) = load_tasks(&write(dir.path(), "set.toml", SET)).unwrap();
        let scratch = dir.path().join("scratch");
        struct StopsFirst;
        impl Runner for StopsFirst {
            fn run(&self, project: &Path, _: &str, _: Duration, _: &dyn Fn() -> bool) -> RunnerOutcome {
                std::fs::write(project.join("partial.txt"), "half").unwrap();
                RunnerOutcome::Cancelled
            }
        }
        let report = run_tasks(&set, &digest, "m", "x", &scratch, &StopsFirst, &|| false, &mut |_| {}).unwrap();
        assert!(!report.complete);
        assert_eq!(report.tasks.len(), 1);
        assert_eq!(report.tasks[0].state, "cancelled");
        assert_eq!(std::fs::read_dir(&scratch).unwrap().count(), 0, "a scratch copy was left behind");

        let already = run_tasks(&set, &digest, "m", "x", &scratch, &StopsFirst, &|| true, &mut |_| {}).unwrap();
        assert!(!already.complete && already.tasks.is_empty(), "a stopped benchmark started a task");
    }

    /// The real runner stops a child that outlives its deadline, and the child's
    /// whole tree with it.
    #[cfg(windows)]
    #[test]
    fn the_process_runner_stops_a_task_past_its_deadline() {
        let dir = tempfile::tempdir().unwrap();
        // `cmd` stands in for the agent: it ignores the arguments and waits.
        let runner = ProcessRunner { program: PathBuf::from("cmd"), model: "m".into() };
        let script = dir.path().join("wait.cmd");
        std::fs::write(&script, "@ping -n 60 127.0.0.1 >NUL\r\n").unwrap();
        let runner = ProcessRunner { program: script, ..runner };
        let started = Instant::now();
        let outcome = runner.run(dir.path(), "task", Duration::from_millis(800), &|| false);
        assert!(matches!(outcome, RunnerOutcome::TimedOut));
        assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
        let cancelled = runner.run(dir.path(), "task", Duration::from_secs(30), &|| true);
        assert!(matches!(cancelled, RunnerOutcome::Cancelled));
    }
}
