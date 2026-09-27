//! Pull-request status for a project folder, read through the GitHub CLI.
//!
//! The sidebar marks a chat or Cowork session whose folder is on a branch with
//! a pull request (open, draft, merged, closed) and shows its checks. Flint
//! stores no GitHub token for this: it asks `gh`, which uses the user's own
//! login. When `gh` is missing or signed out the answer is "unavailable" and
//! the UI simply shows nothing.
//!
//! Each check is also named and bound to the head commit it ran on, so a
//! failed one can be handed to the session that owns the pull request
//! ("Fix this check"). Its log is fetched on demand, bounded, and only while
//! the pull request's head is still the commit the check ran on: a check on a
//! commit that has since been replaced says nothing about the code now.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::github_recovery::{gh_status, on_path, GhAuth};

/// How long one `gh pr view` may take before the UI stops waiting for it.
const GH_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    Open,
    Draft,
    Merged,
    Closed,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct CheckSummary {
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
}

/// Where one check stands, collapsed to the three states the UI draws.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckVerdict {
    Passed,
    Failed,
    Pending,
}

/// One named check on the pull request's head commit.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CheckRun {
    /// The check run's name, or a commit status's context.
    pub name: String,
    /// The GitHub Actions workflow it belongs to, when it is one.
    pub workflow: Option<String>,
    pub verdict: CheckVerdict,
    /// The raw conclusion or state, upper-case (`FAILURE`, `TIMED_OUT`, ...).
    pub conclusion: String,
    /// The check's own page: a job log on GitHub, or an external CI's page.
    pub details_url: Option<String>,
    /// The GitHub Actions job id, when the details URL names one. Only these
    /// have a log `gh` can fetch; every other check keeps its link.
    pub job_id: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PrStatus {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: PrState,
    pub head: String,
    pub base: String,
    pub additions: u64,
    pub deletions: u64,
    pub checks: CheckSummary,
    /// The commit the pull request's head points at, which `check_runs` ran on.
    pub head_sha: String,
    /// The named checks, in the order GitHub lists them.
    pub check_runs: Vec<CheckRun>,
}

/// Why no status could be read. `NoPullRequest` is the ordinary case of a
/// branch without one; the others mean the CLI cannot answer.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum PrLookup {
    Found { pr: PrStatus },
    NoPullRequest,
    GhMissing,
    GhSignedOut,
    NotARepository,
    Failed { message: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPr {
    number: u64,
    title: String,
    url: String,
    state: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    head_ref_name: String,
    #[serde(default)]
    base_ref_name: String,
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
    #[serde(default)]
    head_ref_oid: String,
    #[serde(default)]
    status_check_rollup: Vec<GhCheck>,
}

/// `statusCheckRollup` mixes check runs (`status` + `conclusion`) and commit
/// statuses (`state`); both shapes are read.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhCheck {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    state: Option<String>,
    /// Check runs.
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    workflow_name: Option<String>,
    #[serde(default)]
    details_url: Option<String>,
    /// Commit statuses.
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    target_url: Option<String>,
}

impl GhCheck {
    fn conclusion(&self) -> String {
        self.conclusion
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(self.state.as_deref())
            .unwrap_or("")
            .to_ascii_uppercase()
    }

    fn verdict(&self) -> CheckVerdict {
        let running = matches!(
            self.status.as_deref().map(str::to_ascii_uppercase).as_deref(),
            Some("QUEUED" | "IN_PROGRESS" | "PENDING" | "WAITING" | "REQUESTED")
        );
        match self.conclusion().as_str() {
            _ if running => CheckVerdict::Pending,
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => CheckVerdict::Passed,
            "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED"
            | "STARTUP_FAILURE" => CheckVerdict::Failed,
            _ => CheckVerdict::Pending,
        }
    }
}

fn summarize_checks(checks: &[GhCheck]) -> CheckSummary {
    let mut out = CheckSummary::default();
    for c in checks {
        match c.verdict() {
            CheckVerdict::Pending => out.pending += 1,
            CheckVerdict::Passed => out.passed += 1,
            CheckVerdict::Failed => out.failed += 1,
        }
    }
    out
}

/// The job id in a GitHub Actions details URL,
/// `https://github.com/<o>/<r>/actions/runs/<run>/job/<job>`. Anything else --
/// an external CI, a commit status -- has no log `gh` can fetch.
pub(crate) fn job_id_from_details_url(url: &str) -> Option<u64> {
    let rest = url.strip_prefix("https://github.com/")?;
    let (_, tail) = rest.split_once("/actions/runs/")?;
    let (_, job) = tail.split_once("/job/")?;
    let digits: String = job.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// A details link is only kept when it is a web page; a check's own URL is
/// set by whoever runs it and is opened in the user's browser.
fn web_link(url: Option<&str>) -> Option<String> {
    let url = url?.trim();
    (url.starts_with("https://") && !url.chars().any(char::is_whitespace))
        .then(|| url.to_string())
}

fn check_runs(checks: &[GhCheck]) -> Vec<CheckRun> {
    checks
        .iter()
        .map(|c| {
            let details_url = web_link(c.details_url.as_deref().or(c.target_url.as_deref()));
            let job_id = details_url.as_deref().and_then(job_id_from_details_url);
            CheckRun {
                name: c
                    .name
                    .clone()
                    .or_else(|| c.context.clone())
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| "(unnamed check)".to_string()),
                workflow: c.workflow_name.clone().filter(|w| !w.is_empty()),
                verdict: c.verdict(),
                conclusion: c.conclusion(),
                details_url,
                job_id,
            }
        })
        .collect()
}

/// Parse `gh pr view --json ...` output.
fn parse_pr(json: &str) -> Result<PrStatus, String> {
    let pr: GhPr = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let state = match (pr.state.to_ascii_uppercase().as_str(), pr.is_draft) {
        ("MERGED", _) => PrState::Merged,
        ("CLOSED", _) => PrState::Closed,
        (_, true) => PrState::Draft,
        _ => PrState::Open,
    };
    Ok(PrStatus {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state,
        head: pr.head_ref_name,
        base: pr.base_ref_name,
        additions: pr.additions,
        deletions: pr.deletions,
        checks: summarize_checks(&pr.status_check_rollup),
        head_sha: pr.head_ref_oid,
        check_runs: check_runs(&pr.status_check_rollup),
    })
}

/// `gh pr view` arguments: the folder's current branch, or one pull request
/// named by URL (a session's own, whatever the folder has checked out).
fn view_args(pr: Option<&str>) -> Vec<String> {
    let mut args = vec!["pr".to_string(), "view".to_string()];
    if let Some(pr) = pr {
        args.push(pr.to_string());
    }
    args.push("--json".to_string());
    args.push(
        "number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,additions,deletions,statusCheckRollup"
            .to_string(),
    );
    args
}

/// Only a GitHub pull-request URL is passed on to `gh`.
fn is_pr_url(pr: &str) -> bool {
    pr.starts_with("https://github.com/")
        && pr.contains("/pull/")
        && !pr.chars().any(|c| c.is_whitespace())
}

fn lookup_blocking(project: &Path, pr: Option<&str>) -> PrLookup {
    let Some(gh) = on_path(if cfg!(windows) { "gh.exe" } else { "gh" }) else {
        return PrLookup::GhMissing;
    };
    if let Some(pr) = pr {
        if !is_pr_url(pr) {
            return PrLookup::Failed { message: format!("not a pull request URL: {pr}") };
        }
    } else {
        if !project.is_dir() {
            return PrLookup::NotARepository;
        }
        if super::git::current_branch(project).is_none() {
            return PrLookup::NotARepository;
        }
    }
    let mut cmd = Command::new(&gh);
    // A URL names its repository; the folder is only a working directory.
    if project.is_dir() {
        cmd.current_dir(project);
    }
    cmd.args(view_args(pr));
    // Never prompt: a missing login must fail, not wait for input.
    cmd.env("GH_PROMPT_DISABLED", "1");
    jan_utils::system::hide_console_window(&mut cmd);
    let out = match cmd.output() {
        Ok(out) => out,
        Err(e) => return PrLookup::Failed { message: e.to_string() },
    };
    if out.status.success() {
        return match parse_pr(&String::from_utf8_lossy(&out.stdout)) {
            Ok(pr) => PrLookup::Found { pr },
            Err(message) => PrLookup::Failed { message },
        };
    }
    let err = String::from_utf8_lossy(&out.stderr).to_ascii_lowercase();
    if err.contains("no pull requests found") {
        PrLookup::NoPullRequest
    } else if err.contains("gh auth login") || err.contains("not logged") {
        PrLookup::GhSignedOut
    } else if err.contains("not a git repository") || err.contains("no git remotes") {
        PrLookup::NotARepository
    } else if matches!(gh_status(), (true, GhAuth::No)) {
        PrLookup::GhSignedOut
    } else {
        PrLookup::Failed {
            message: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        }
    }
}

/// The pull request for the branch checked out in `project`, or, given `pr`
/// (a pull-request URL a session recorded), that pull request.
#[tauri::command]
pub async fn agent_pr_status(project: String, pr: Option<String>) -> PrLookup {
    let path = std::path::PathBuf::from(project);
    let task = tokio::task::spawn_blocking(move || lookup_blocking(&path, pr.as_deref()));
    match tokio::time::timeout(GH_TIMEOUT, task).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => PrLookup::Failed { message: e.to_string() },
        Err(_) => PrLookup::Failed {
            message: "gh did not answer in time".to_string(),
        },
    }
}

/// The most failed-log output read from `gh` before it is cut off. A failed
/// job can print megabytes; only its end is shown, so reading on is waste.
const LOG_READ_CAP: usize = 4 * 1024 * 1024;
/// The excerpt a fix request carries: the last lines, then the last chars.
const EXCERPT_MAX_LINES: usize = 200;
const EXCERPT_MAX_CHARS: usize = 16_000;
/// How long fetching one failed log may take, all `gh` calls together.
const LOG_TIMEOUT: Duration = Duration::from_secs(30);

/// A failed check's log, fetched for a fix request.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum CheckLog {
    /// The end of the failed steps' log, with ANSI colour and credentials
    /// removed. It is still untrusted text: a test can print anything.
    Log { excerpt: String, truncated: bool, head_sha: String },
    /// The pull request's head is no longer the commit the check ran on (or
    /// the job ran on another commit): the check says nothing about the code
    /// now, so nothing is fetched.
    Stale { current_head_sha: String },
    /// No log to show: an external check, a log GitHub no longer keeps, or a
    /// `gh` failure. The check's own page is still linked.
    ///
    /// `head_verified` says whether GitHub confirmed the pull request's head
    /// is still `head_sha` before the log could not be had. Only then may a
    /// fix be requested without a log: "unavailable" also covers a head that
    /// could not be checked at all (gh missing, signed out, API error), and a
    /// check on a head nobody confirmed says nothing about the code now.
    Unavailable { reason: String, details_url: Option<String>, head_verified: bool },
}

/// What one bounded `gh` call printed.
#[derive(Debug, Clone, Default)]
pub(crate) struct GhOutput {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    /// Stdout reached `LOG_READ_CAP` and the rest was not read.
    pub truncated: bool,
}

fn is_head_sha(sha: &str) -> bool {
    (7..=64).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())
}

/// `owner/name` from a pull-request URL.
fn repo_of(pr_url: &str) -> Option<String> {
    let rest = pr_url.strip_prefix("https://github.com/")?;
    let mut parts = rest.split('/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let name = parts.next().filter(|s| !s.is_empty())?;
    let ok = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    (ok(owner) && ok(name)).then(|| format!("{owner}/{name}"))
}

fn strip_ansi(text: &str) -> String {
    static ANSI: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").expect("valid regex")
    });
    ANSI.replace_all(text, "").into_owned()
}

/// The end of a failed log, bounded by lines and then by chars, with colour
/// codes and credentials removed. Returns the excerpt and whether it was cut.
pub(crate) fn excerpt_failed_log(raw: &str, already_cut: bool) -> (String, bool) {
    let clean = strip_ansi(raw);
    let lines: Vec<&str> = clean.lines().collect();
    let mut cut = already_cut || lines.len() > EXCERPT_MAX_LINES;
    let tail = lines[lines.len().saturating_sub(EXCERPT_MAX_LINES)..].join("\n");
    let tail = if tail.chars().count() > EXCERPT_MAX_CHARS {
        cut = true;
        let skip = tail.chars().count() - EXCERPT_MAX_CHARS;
        tail.chars().skip(skip).collect()
    } else {
        tail
    };
    (
        tauri_plugin_agent_tools::secrets::redact_secrets(tail.trim_end()),
        cut,
    )
}

/// Fetch a failed check's log, `run` standing in for one `gh` invocation so
/// the whole decision is testable without GitHub.
///
/// In order: the pull request's head must still be `head_sha`; the check must
/// be a GitHub Actions job; the job must have run on `head_sha`; then its
/// failed steps' log is read, bounded, and cut to an excerpt.
pub(crate) fn check_log_with(
    run: &mut dyn FnMut(&[String]) -> GhOutput,
    pr_url: &str,
    head_sha: &str,
    job_id: Option<u64>,
    details_url: Option<String>,
) -> CheckLog {
    // Before the head is confirmed, nothing may be queued on this answer.
    let unavailable = |reason: &str, details_url: Option<String>| CheckLog::Unavailable {
        reason: reason.to_string(),
        details_url,
        head_verified: false,
    };
    // After: the pull request still points at `head_sha`; only the log is missing.
    let verified_unavailable = |reason: &str, details_url: Option<String>| CheckLog::Unavailable {
        reason: reason.to_string(),
        details_url,
        head_verified: true,
    };
    let details_url = web_link(details_url.as_deref());
    if !is_pr_url(pr_url) {
        return unavailable("not a pull request URL", details_url);
    }
    let Some(repo) = repo_of(pr_url) else {
        return unavailable("not a pull request URL", details_url);
    };
    if !is_head_sha(head_sha) {
        return unavailable("no head commit recorded for this check", details_url);
    }
    let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();

    // 1. The pull request still points at the commit the check ran on.
    let head = run(&args(&["pr", "view", pr_url, "--json", "headRefOid"]));
    if !head.ok {
        return unavailable(
            &format!("could not read the pull request: {}", head.stderr.trim()),
            details_url,
        );
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Head {
        head_ref_oid: String,
    }
    let current = match serde_json::from_str::<Head>(&head.stdout) {
        Ok(h) => h.head_ref_oid,
        Err(e) => return unavailable(&format!("unreadable pull request: {e}"), details_url),
    };
    if !current.eq_ignore_ascii_case(head_sha) {
        return CheckLog::Stale { current_head_sha: current };
    }

    // 2. Only a GitHub Actions job has a log `gh` can read.
    let Some(job_id) = job_id.or_else(|| details_url.as_deref().and_then(job_id_from_details_url))
    else {
        return verified_unavailable("this check runs outside GitHub Actions", details_url);
    };

    // 3. The job ran on this commit, not on an earlier push of the branch.
    let job = run(&args(&[
        "api",
        &format!("repos/{repo}/actions/jobs/{job_id}"),
        "--jq",
        ".head_sha",
    ]));
    if !job.ok {
        return verified_unavailable(
            &format!("could not read the job: {}", job.stderr.trim()),
            details_url,
        );
    }
    let job_sha = job.stdout.trim();
    if !job_sha.eq_ignore_ascii_case(head_sha) {
        return CheckLog::Stale { current_head_sha: current };
    }

    // 4. The failed steps' log.
    let log = run(&args(&[
        "run",
        "view",
        "--repo",
        &repo,
        "--job",
        &job_id.to_string(),
        "--log-failed",
    ]));
    if !log.ok {
        let why = log.stderr.trim();
        return verified_unavailable(
            if why.is_empty() { "GitHub returned no log for this job" } else { why },
            details_url,
        );
    }
    let (excerpt, truncated) = excerpt_failed_log(&log.stdout, log.truncated);
    if excerpt.trim().is_empty() {
        return verified_unavailable("the job has no failed-step log", details_url);
    }
    CheckLog::Log { excerpt, truncated, head_sha: current }
}

/// Run `gh` with `args`, reading at most `cap` bytes of stdout and stopping
/// the process at `deadline`. A child still running then is killed, so a
/// timed-out fetch leaves nothing behind.
pub(crate) fn run_gh_bounded(
    gh: &Path,
    cwd: Option<&Path>,
    args: &[String],
    cap: usize,
    deadline: std::time::Instant,
) -> GhOutput {
    let mut cmd = Command::new(gh);
    if let Some(cwd) = cwd.filter(|p| p.is_dir()) {
        cmd.current_dir(cwd);
    }
    cmd.args(args);
    cmd.env("GH_PROMPT_DISABLED", "1");
    cmd.env("NO_COLOR", "1");
    run_bounded(cmd, cap, deadline)
}

pub(crate) fn run_bounded(
    mut cmd: Command,
    cap: usize,
    deadline: std::time::Instant,
) -> GhOutput {
    use std::io::Read;
    use std::process::Stdio;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    jan_utils::system::hide_console_window(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return GhOutput { stderr: e.to_string(), ..GhOutput::default() },
    };
    let full = Arc::new(AtomicBool::new(false));
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let full_flag = full.clone();
    // Readers hand back what they have over channels: a grandchild that keeps
    // a pipe open after `gh` is killed must not keep this call waiting.
    let (out_tx, out_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let (err_tx, err_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(out) = stdout.as_mut() {
            let mut chunk = [0u8; 16 * 1024];
            while let Ok(n) = out.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let room = cap.saturating_sub(buf.len());
                buf.extend_from_slice(&chunk[..n.min(room)]);
                if n >= room {
                    full_flag.store(true, Ordering::SeqCst);
                    break;
                }
            }
        }
        let _ = out_tx.send(buf);
    });
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(err) = stderr.as_mut() {
            let _ = err.take(64 * 1024).read_to_end(&mut buf);
        }
        let _ = err_tx.send(buf);
    });
    let mut timed_out = false;
    let mut killed = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if full.load(Ordering::SeqCst) || std::time::Instant::now() >= deadline {
            timed_out = !full.load(Ordering::SeqCst);
            killed = true;
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    // A process that exited normally has closed its pipes; one that was killed
    // may have left a grandchild holding them, so the wait is bounded.
    let grace = if killed { Duration::from_millis(500) } else { Duration::from_secs(5) };
    let stdout = out_rx.recv_timeout(grace).unwrap_or_default();
    let stderr = err_rx.recv_timeout(grace).unwrap_or_default();
    let truncated = full.load(Ordering::SeqCst);
    GhOutput {
        // Cut off at the cap is still a log worth showing the end of.
        ok: truncated || status.is_some_and(|s| s.success()),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: if timed_out {
            "gh did not answer in time".to_string()
        } else {
            String::from_utf8_lossy(&stderr).into_owned()
        },
        truncated,
    }
}

/// The failed log of one check on a pull request, for "Fix this check". Read
/// through the user's own `gh` login, bounded in size and time, and only
/// while the pull request's head is still `head_sha`.
#[tauri::command]
pub async fn agent_pr_check_log(
    project: String,
    pr_url: String,
    head_sha: String,
    job_id: Option<u64>,
    details_url: Option<String>,
) -> CheckLog {
    let task = tokio::task::spawn_blocking(move || {
        let Some(gh) = on_path(if cfg!(windows) { "gh.exe" } else { "gh" }) else {
            return CheckLog::Unavailable {
                reason: "the GitHub CLI (gh) is not installed".to_string(),
                details_url: web_link(details_url.as_deref()),
                head_verified: false,
            };
        };
        let cwd = std::path::PathBuf::from(project);
        let deadline = std::time::Instant::now() + LOG_TIMEOUT;
        let mut run =
            |args: &[String]| run_gh_bounded(&gh, Some(&cwd), args, LOG_READ_CAP, deadline);
        check_log_with(&mut run, &pr_url, &head_sha, job_id, details_url)
    });
    match task.await {
        Ok(result) => result,
        Err(e) => CheckLog::Unavailable {
            reason: e.to_string(),
            details_url: None,
            head_verified: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_open_pr_with_mixed_checks() {
        let pr = parse_pr(
            r#"{"number":418,"title":"Fix tool args","url":"https://github.com/o/r/pull/418",
                "state":"OPEN","isDraft":false,"headRefName":"fix/args","baseRefName":"main",
                "additions":120,"deletions":8,"statusCheckRollup":[
                  {"status":"COMPLETED","conclusion":"SUCCESS"},
                  {"status":"COMPLETED","conclusion":"FAILURE"},
                  {"status":"IN_PROGRESS","conclusion":""},
                  {"state":"SUCCESS"}]}"#,
        )
        .unwrap();
        assert_eq!(pr.state, PrState::Open);
        assert_eq!(pr.number, 418);
        assert_eq!(
            pr.checks,
            CheckSummary { passed: 2, failed: 1, pending: 1 }
        );
    }

    #[test]
    fn distinguishes_draft_merged_and_closed() {
        let base = |state: &str, draft: bool| {
            format!(
                r#"{{"number":1,"title":"t","url":"u","state":"{state}","isDraft":{draft}}}"#
            )
        };
        assert_eq!(parse_pr(&base("OPEN", true)).unwrap().state, PrState::Draft);
        assert_eq!(parse_pr(&base("MERGED", false)).unwrap().state, PrState::Merged);
        assert_eq!(parse_pr(&base("CLOSED", true)).unwrap().state, PrState::Closed);
    }

    #[test]
    fn views_a_named_pull_request_by_url_only() {
        let url = "https://github.com/stockpath/KewScraper/pull/34";
        assert!(is_pr_url(url));
        assert!(!is_pr_url("--web"));
        assert!(!is_pr_url("https://github.com/o/r/pull/1 --web"));
        assert_eq!(view_args(Some(url))[2], url);
        assert_eq!(view_args(None)[2], "--json");
    }

    #[test]
    fn rejects_unreadable_output() {
        assert!(parse_pr("not json").is_err());
    }

    #[test]
    fn names_each_check_and_binds_it_to_the_head_commit() {
        let pr = parse_pr(
            r#"{"number":7,"title":"t","url":"https://github.com/o/r/pull/7","state":"OPEN",
                "headRefOid":"0123456789abcdef0123456789abcdef01234567",
                "statusCheckRollup":[
                  {"__typename":"CheckRun","name":"test (ubuntu)","workflowName":"CI",
                   "status":"COMPLETED","conclusion":"FAILURE",
                   "detailsUrl":"https://github.com/o/r/actions/runs/111/job/222"},
                  {"__typename":"StatusContext","context":"ci/circleci","state":"ERROR",
                   "targetUrl":"https://circleci.com/gh/o/r/9"},
                  {"__typename":"CheckRun","name":"lint","status":"IN_PROGRESS","conclusion":""}]}"#,
        )
        .unwrap();
        assert_eq!(pr.head_sha, "0123456789abcdef0123456789abcdef01234567");
        assert_eq!(pr.check_runs.len(), 3);
        let gha = &pr.check_runs[0];
        assert_eq!(gha.name, "test (ubuntu)");
        assert_eq!(gha.workflow.as_deref(), Some("CI"));
        assert_eq!(gha.verdict, CheckVerdict::Failed);
        assert_eq!(gha.job_id, Some(222));
        let external = &pr.check_runs[1];
        assert_eq!(external.name, "ci/circleci");
        assert_eq!(external.verdict, CheckVerdict::Failed);
        assert_eq!(external.job_id, None);
        assert_eq!(external.details_url.as_deref(), Some("https://circleci.com/gh/o/r/9"));
        assert_eq!(pr.check_runs[2].verdict, CheckVerdict::Pending);
        assert_eq!(pr.checks, CheckSummary { passed: 0, failed: 2, pending: 1 });
    }

    #[test]
    fn reads_a_job_id_only_from_a_github_actions_url() {
        assert_eq!(
            job_id_from_details_url("https://github.com/o/r/actions/runs/1/job/42?pr=3"),
            Some(42)
        );
        assert_eq!(job_id_from_details_url("https://github.com/o/r/runs/42"), None);
        assert_eq!(job_id_from_details_url("https://ci.example.com/actions/runs/1/job/42"), None);
        assert_eq!(web_link(Some("javascript:alert(1)")), None);
    }

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";
    const URL: &str = "https://github.com/o/r/pull/7";

    fn ok(stdout: &str) -> GhOutput {
        GhOutput { ok: true, stdout: stdout.to_string(), ..GhOutput::default() }
    }

    #[test]
    fn a_moved_pull_request_head_fetches_no_log() {
        let mut calls: Vec<Vec<String>> = Vec::new();
        let mut run = |a: &[String]| {
            calls.push(a.to_vec());
            ok(r#"{"headRefOid":"ffffffffffffffffffffffffffffffffffffffff"}"#)
        };
        let got = check_log_with(&mut run, URL, SHA, Some(222), None);
        assert_eq!(
            got,
            CheckLog::Stale { current_head_sha: "ffffffffffffffffffffffffffffffffffffffff".into() }
        );
        assert_eq!(calls.len(), 1, "only the head is read: {calls:?}");
    }

    #[test]
    fn a_job_from_an_earlier_push_is_stale_too() {
        let mut n = 0;
        let mut run = |_: &[String]| {
            n += 1;
            match n {
                1 => ok(&format!(r#"{{"headRefOid":"{SHA}"}}"#)),
                _ => ok("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"),
            }
        };
        assert!(matches!(
            check_log_with(&mut run, URL, SHA, Some(222), None),
            CheckLog::Stale { .. }
        ));
        assert_eq!(n, 2);
    }

    #[test]
    fn an_external_check_keeps_its_link_and_fetches_nothing_more() {
        let mut n = 0;
        let mut run = |_: &[String]| {
            n += 1;
            ok(&format!(r#"{{"headRefOid":"{SHA}"}}"#))
        };
        let got = check_log_with(
            &mut run,
            URL,
            SHA,
            None,
            Some("https://circleci.com/gh/o/r/9".into()),
        );
        assert_eq!(
            got,
            CheckLog::Unavailable {
                reason: "this check runs outside GitHub Actions".into(),
                details_url: Some("https://circleci.com/gh/o/r/9".into()),
                head_verified: true,
            }
        );
        assert_eq!(n, 1);
    }

    #[test]
    fn a_current_failed_job_returns_a_bounded_redacted_excerpt() {
        let mut calls: Vec<Vec<String>> = Vec::new();
        let long: String = (0..500)
            .map(|i| format!("test\tstep\t\x1b[31mline {i}\x1b[0m\n"))
            .collect::<String>()
            + "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n";
        let mut run = |a: &[String]| {
            calls.push(a.to_vec());
            match calls.len() {
                1 => ok(&format!(r#"{{"headRefOid":"{SHA}"}}"#)),
                2 => ok(&format!("{SHA}\n")),
                _ => ok(&long),
            }
        };
        let got = check_log_with(&mut run, URL, SHA, Some(222), None);
        let CheckLog::Log { excerpt, truncated, head_sha } = got else {
            panic!("expected a log, got {got:?}");
        };
        assert!(truncated);
        assert_eq!(head_sha, SHA);
        assert!(excerpt.lines().count() <= EXCERPT_MAX_LINES);
        assert!(!excerpt.contains('\x1b'), "colour codes are stripped");
        assert!(excerpt.contains("line 499"));
        assert!(!excerpt.contains("line 0\n"));
        assert!(!excerpt.contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
        assert_eq!(calls[1][1], "repos/o/r/actions/jobs/222");
        assert_eq!(
            calls[2],
            ["run", "view", "--repo", "o/r", "--job", "222", "--log-failed"]
        );
    }

    #[test]
    fn refuses_a_malformed_head_or_url_before_calling_gh() {
        let mut n = 0;
        let mut run = |_: &[String]| {
            n += 1;
            ok("")
        };
        assert!(matches!(
            check_log_with(&mut run, URL, "HEAD --web", Some(1), None),
            CheckLog::Unavailable { .. }
        ));
        assert!(matches!(
            check_log_with(&mut run, "https://github.com/o/r/pull/7 --web", SHA, Some(1), None),
            CheckLog::Unavailable { .. }
        ));
        assert_eq!(n, 0);
    }

    #[test]
    fn excerpt_is_capped_by_chars_as_well_as_lines() {
        let one = "x".repeat(EXCERPT_MAX_CHARS * 2);
        let (excerpt, cut) = excerpt_failed_log(&one, false);
        assert!(cut);
        assert_eq!(excerpt.chars().count(), EXCERPT_MAX_CHARS);
        let (short, cut) = excerpt_failed_log("a\nb\n", false);
        assert_eq!((short.as_str(), cut), ("a\nb", false));
    }

    #[cfg(unix)]
    #[test]
    fn a_bounded_read_stops_a_process_that_prints_too_much() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "yes flint"]);
        let started = std::time::Instant::now();
        let out = run_bounded(cmd, 64 * 1024, started + Duration::from_secs(10));
        assert!(out.truncated);
        assert_eq!(out.stdout.len(), 64 * 1024);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn a_bounded_read_kills_a_process_at_its_deadline() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30"]);
        let started = std::time::Instant::now();
        let out = run_bounded(cmd, 1024, started + Duration::from_millis(300));
        assert!(!out.ok);
        assert_eq!(out.stderr, "gh did not answer in time");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_head_github_could_not_confirm_is_never_reported_as_verified() {
        // gh fails on the head read itself (signed out, API down, rate limit).
        let mut n = 0;
        let mut run = |_: &[String]| {
            n += 1;
            GhOutput { ok: false, stderr: "HTTP 502".into(), ..GhOutput::default() }
        };
        let got = check_log_with(&mut run, URL, SHA, Some(222), None);
        assert!(
            matches!(got, CheckLog::Unavailable { head_verified: false, .. }),
            "{got:?}"
        );
        assert_eq!(n, 1, "nothing past the head read is attempted");
        // An unreadable answer is no confirmation either.
        let mut run = |_: &[String]| ok("not json");
        assert!(matches!(
            check_log_with(&mut run, URL, SHA, Some(222), None),
            CheckLog::Unavailable { head_verified: false, .. }
        ));
    }

    #[test]
    fn a_missing_log_after_a_confirmed_head_says_the_head_was_verified() {
        let mut calls = 0;
        let mut run = |_: &[String]| {
            calls += 1;
            match calls {
                1 => ok(&format!(r#"{{"headRefOid":"{SHA}"}}"#)),
                2 => ok(&format!("{SHA}\n")),
                _ => GhOutput { ok: false, stderr: "log expired".into(), ..GhOutput::default() },
            }
        };
        assert!(matches!(
            check_log_with(&mut run, URL, SHA, Some(222), None),
            CheckLog::Unavailable { head_verified: true, .. }
        ));
    }
}
