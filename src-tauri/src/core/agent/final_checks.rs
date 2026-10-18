//! Checks a run must pass before it may hand back a final answer (`[agent]
//! final_checks`).
//!
//! The model's own claim that the work is done is the weakest evidence there
//! is, and independent verification (`verify_completion`) costs another model
//! call. A project usually already knows what "done" means in a form a machine
//! can test: this file exists, this command exits 0. Declared in `agent.toml`:
//!
//! ```toml
//! [agent]
//! final_checks = [
//!   { file = "dist/report.md" },
//!   { command = "cargo test", timeout_secs = 300 },
//! ]
//! ```
//!
//! When the model is about to answer, every check runs. If one fails the run
//! gets **one** retry turn carrying the failure, then finishes either way: a
//! second failure does not loop, it is reported on the completion and appended
//! to the answer so a reader never mistakes an unchecked claim for a verified
//! one.
//!
//! A `file` check stays inside the project: an absolute path or one that climbs
//! out of it is a failed check, not a probe of the machine. A `command` check
//! runs the way a hook does (the same shell selection and confinement as
//! `bash`) and, like a hook, only in a folder the user has trusted: a
//! repository that was just cloned cannot make Flint run its command by
//! declaring one here. An untrusted folder's command checks are reported as
//! skipped, never as passed.

use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Body key the orchestration layer sets on a top-level run. Private to the
/// loop like the other `jan_` keys; never forwarded upstream.
pub(crate) const BODY_FINAL_CHECKS: &str = "jan_final_checks";

/// Longest a command check may run, whatever the file says.
pub(crate) const MAX_TIMEOUT_SECS: u64 = 600;
/// Used when a command check names no timeout.
pub(crate) const DEFAULT_TIMEOUT_SECS: u64 = 120;
/// How much of one failure goes back to the model.
const MAX_DETAIL_CHARS: usize = 1_500;

/// One declared check. Exactly one of `file` and `command` is set.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct FinalCheck {
    /// A path, relative to the project, that must exist when the run ends.
    #[serde(default)]
    pub file: Option<String>,
    /// A command that must exit 0.
    #[serde(default)]
    pub command: Option<String>,
    /// Seconds a command may run (default 120, at most 600).
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

impl FinalCheck {
    pub(crate) fn label(&self) -> String {
        match (&self.file, &self.command) {
            (Some(file), _) => format!("file {file} exists"),
            (_, Some(command)) => format!("`{}` exits 0", command.trim()),
            _ => "an empty check".to_string(),
        }
    }
}

/// Refuse a declaration that cannot be evaluated, naming the entry, so a typo
/// is a startup error and not a check that silently never ran.
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
pub(crate) fn validate(checks: &[FinalCheck]) -> Result<(), String> {
    for (i, check) in checks.iter().enumerate() {
        let at = format!("[agent].final_checks[{i}]");
        match (&check.file, &check.command) {
            (Some(_), Some(_)) => return Err(format!("{at} sets both `file` and `command`; use one per check")),
            (None, None) => return Err(format!("{at} needs a `file` or a `command`")),
            (Some(file), None) if file.trim().is_empty() => return Err(format!("{at}: `file` is empty")),
            (None, Some(command)) if command.trim().is_empty() => return Err(format!("{at}: `command` is empty")),
            _ => {}
        }
        if let Some(secs) = check.timeout_secs {
            if secs == 0 || secs > MAX_TIMEOUT_SECS {
                return Err(format!("{at}: `timeout_secs` must be between 1 and {MAX_TIMEOUT_SECS}"));
            }
        }
    }
    Ok(())
}

/// Set or clear the body key for this run: only a top-level run checks its
/// answer (a child's answer is the parent's input, and the parent is checked).
#[cfg_attr(not(feature = "cli"), allow(dead_code))]
pub(crate) fn annotate(body: &mut Value, checks: &[FinalCheck], is_child: bool) {
    let Some(obj) = body.as_object_mut() else { return };
    if checks.is_empty() || is_child {
        obj.remove(BODY_FINAL_CHECKS);
    } else {
        obj.insert(
            BODY_FINAL_CHECKS.to_string(),
            serde_json::to_value(checks).unwrap_or(Value::Null),
        );
    }
}

/// The checks this run carries.
pub(crate) fn from_body(body: &Value) -> Vec<FinalCheck> {
    body.get(BODY_FINAL_CHECKS)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

/// How one check came out.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct Outcome {
    pub label: String,
    pub passed: bool,
    /// True when the check could not be run here (an untrusted folder, no
    /// shell). Never counted as passed, never a reason to retry.
    pub skipped: bool,
    pub detail: String,
}

/// Run the file checks and hand each command to `run_command`, which answers
/// `Some((passed, output))` or `None` when it cannot run commands.
pub(crate) async fn evaluate<F, Fut>(
    checks: &[FinalCheck],
    root: Option<&Path>,
    mut run_command: F,
) -> Vec<Outcome>
where
    F: FnMut(String, u64) -> Fut,
    Fut: std::future::Future<Output = Option<(bool, String)>>,
{
    let mut out = Vec::with_capacity(checks.len());
    for check in checks {
        let label = check.label();
        let outcome = match (&check.file, &check.command) {
            (Some(file), _) => match root {
                None => Outcome { label, passed: false, skipped: true, detail: "no project folder to look in".into() },
                Some(root) => match file_exists(root, file) {
                    Ok(true) => Outcome { label, passed: true, skipped: false, detail: String::new() },
                    Ok(false) => Outcome { label, passed: false, skipped: false, detail: format!("{file} does not exist") },
                    Err(why) => Outcome { label, passed: false, skipped: false, detail: why },
                },
            },
            (_, Some(command)) => {
                let secs = check.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).min(MAX_TIMEOUT_SECS);
                match run_command(command.clone(), secs).await {
                    None => Outcome {
                        label,
                        passed: false,
                        skipped: true,
                        detail: "commands are not run in this folder (it is not trusted) or on this surface".into(),
                    },
                    Some((true, _)) => Outcome { label, passed: true, skipped: false, detail: String::new() },
                    Some((false, output)) => Outcome { label, passed: false, skipped: false, detail: bound(&output) },
                }
            }
            _ => Outcome { label, passed: false, skipped: true, detail: "nothing to check".into() },
        };
        out.push(outcome);
    }
    out
}

fn bound(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= MAX_DETAIL_CHARS {
        return text.to_string();
    }
    let head: String = text.chars().take(MAX_DETAIL_CHARS).collect();
    format!("{head}\n[output truncated]")
}

/// Whether `file` exists under `root`. A path that is absolute or climbs out of
/// the project is an error, not a look at the rest of the machine.
fn file_exists(root: &Path, file: &str) -> Result<bool, String> {
    let rel = Path::new(file.trim());
    let escapes = rel.is_absolute()
        || rel.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir));
    if escapes {
        return Err(format!("{file} is outside the project, so it cannot be checked"));
    }
    let joined = root.join(rel);
    // A symlink inside the project that points out of it is also outside.
    match (joined.canonicalize(), root.canonicalize()) {
        (Ok(found), Ok(base)) => {
            if found.starts_with(&base) {
                Ok(true)
            } else {
                Err(format!("{file} resolves outside the project, so it cannot be checked"))
            }
        }
        _ => Ok(false),
    }
}

/// The failures worth acting on: failed, and not merely skipped.
pub(crate) fn failures(outcomes: &[Outcome]) -> Vec<&Outcome> {
    outcomes.iter().filter(|o| !o.passed && !o.skipped).collect()
}

/// What the model is told when its answer did not pass.
pub(crate) fn retry_note(outcomes: &[Outcome]) -> String {
    let mut text = String::from(
        "Your answer was held back: these checks the project requires before a final answer did not pass.\n",
    );
    for o in failures(outcomes) {
        text.push_str(&format!("\n- {}", o.label));
        if !o.detail.is_empty() {
            text.push_str(&format!(":\n{}", o.detail));
        }
    }
    text.push_str(
        "\n\nFix what is failing and answer again. You get this one retry; the checks run once more afterwards.",
    );
    text
}

/// The line appended to an answer that finished without passing, so it is never
/// read as verified.
pub(crate) fn unresolved_note(outcomes: &[Outcome]) -> String {
    let names: Vec<String> = failures(outcomes).iter().map(|o| o.label.clone()).collect();
    format!("[final checks did not pass after one retry: {}]", names.join("; "))
}

/// The record attached to the completion.
pub(crate) fn report(outcomes: &[Outcome], retried: bool) -> Value {
    serde_json::json!({
        "passed": failures(outcomes).is_empty(),
        "retried": retried,
        "checks": outcomes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str) -> FinalCheck {
        FinalCheck { file: Some(path.into()), ..Default::default() }
    }
    fn command(cmd: &str) -> FinalCheck {
        FinalCheck { command: Some(cmd.into()), ..Default::default() }
    }
    async fn none(_: String, _: u64) -> Option<(bool, String)> {
        None
    }

    #[test]
    fn a_declaration_that_cannot_be_evaluated_is_refused_by_name() {
        assert!(validate(&[file("a"), command("true")]).is_ok());
        let both = FinalCheck { file: Some("a".into()), command: Some("b".into()), timeout_secs: None };
        assert!(validate(&[both]).unwrap_err().contains("final_checks[0]"));
        assert!(validate(&[file("a"), FinalCheck::default()]).unwrap_err().contains("final_checks[1]"));
        assert!(validate(&[file("  ")]).is_err());
        let slow = FinalCheck { command: Some("x".into()), timeout_secs: Some(601), ..Default::default() };
        assert!(validate(&[slow]).is_err());
    }

    #[test]
    fn the_body_carries_checks_to_a_top_level_run_only() {
        let mut body = serde_json::json!({});
        annotate(&mut body, &[file("a")], false);
        assert_eq!(from_body(&body), vec![file("a")]);
        annotate(&mut body, &[file("a")], true);
        assert!(from_body(&body).is_empty(), "a child never inherits them");
        annotate(&mut body, &[], false);
        assert!(body.get(BODY_FINAL_CHECKS).is_none());
    }

    #[tokio::test]
    async fn a_missing_required_file_fails_and_a_present_one_passes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("out.md"), "x").unwrap();
        let outcomes = evaluate(&[file("out.md"), file("missing.md")], Some(dir.path()), none).await;
        assert!(outcomes[0].passed);
        assert!(!outcomes[1].passed && !outcomes[1].skipped);
        assert!(outcomes[1].detail.contains("missing.md"));
        assert_eq!(failures(&outcomes).len(), 1);
    }

    #[tokio::test]
    async fn a_file_check_cannot_look_outside_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        let abs = outside.path().to_string_lossy().to_string();
        let outcomes = evaluate(&[file(&abs), file("../secret"), file("a/../../b")], Some(dir.path()), none).await;
        for o in &outcomes {
            assert!(!o.passed, "{}", o.label);
            assert!(o.detail.contains("outside the project"), "{}", o.detail);
        }
    }

    #[tokio::test]
    async fn a_command_check_reports_its_exit_and_an_unrunnable_one_is_skipped_not_passed() {
        let dir = tempfile::tempdir().unwrap();
        let ran = evaluate(&[command("good"), command("bad")], Some(dir.path()), |cmd, _| async move {
            Some((cmd == "good", format!("output of {cmd}")))
        })
        .await;
        assert!(ran[0].passed);
        assert!(!ran[1].passed);
        assert_eq!(ran[1].detail, "output of bad");
        let skipped = evaluate(&[command("anything")], Some(dir.path()), none).await;
        assert!(skipped[0].skipped && !skipped[0].passed);
        assert!(failures(&skipped).is_empty(), "a skipped check is not a reason to retry");
    }

    #[tokio::test]
    async fn a_command_gets_the_default_and_the_capped_timeout() {
        let seen = std::sync::Mutex::new(Vec::new());
        let checks = [
            command("a"),
            FinalCheck { command: Some("b".into()), timeout_secs: Some(5), ..Default::default() },
            FinalCheck { command: Some("c".into()), timeout_secs: Some(10_000), ..Default::default() },
        ];
        evaluate(&checks, None, |_, secs| {
            seen.lock().unwrap().push(secs);
            async { Some((true, String::new())) }
        })
        .await;
        assert_eq!(*seen.lock().unwrap(), vec![DEFAULT_TIMEOUT_SECS, 5, MAX_TIMEOUT_SECS]);
    }

    #[test]
    fn the_notes_name_what_failed() {
        let outcomes = vec![
            Outcome { label: "file a exists".into(), passed: true, skipped: false, detail: String::new() },
            Outcome { label: "`cargo test` exits 0".into(), passed: false, skipped: false, detail: "1 test failed".into() },
        ];
        let retry = retry_note(&outcomes);
        assert!(retry.contains("`cargo test` exits 0") && retry.contains("1 test failed"));
        assert!(!retry.contains("file a exists"), "passing checks are not repeated");
        assert!(unresolved_note(&outcomes).contains("did not pass after one retry"));
        assert_eq!(report(&outcomes, true)["passed"], false);
    }
}
