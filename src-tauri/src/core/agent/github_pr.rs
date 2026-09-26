//! Pull-request status for a project folder, read through the GitHub CLI.
//!
//! The sidebar marks a chat or Cowork session whose folder is on a branch with
//! a pull request (open, draft, merged, closed) and shows its checks. Flint
//! stores no GitHub token for this: it asks `gh`, which uses the user's own
//! login. When `gh` is missing or signed out the answer is "unavailable" and
//! the UI simply shows nothing.

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
    status_check_rollup: Vec<GhCheck>,
}

/// `statusCheckRollup` mixes check runs (`status` + `conclusion`) and commit
/// statuses (`state`); both shapes are read.
#[derive(Deserialize)]
struct GhCheck {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

fn summarize_checks(checks: &[GhCheck]) -> CheckSummary {
    let mut out = CheckSummary::default();
    for c in checks {
        let verdict = c
            .conclusion
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(c.state.as_deref())
            .unwrap_or("")
            .to_ascii_uppercase();
        let running = matches!(
            c.status.as_deref().map(str::to_ascii_uppercase).as_deref(),
            Some("QUEUED" | "IN_PROGRESS" | "PENDING" | "WAITING" | "REQUESTED")
        );
        match verdict.as_str() {
            _ if running => out.pending += 1,
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => out.passed += 1,
            "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED"
            | "STARTUP_FAILURE" => out.failed += 1,
            _ => out.pending += 1,
        }
    }
    out
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
        "number,title,url,state,isDraft,headRefName,baseRefName,additions,deletions,statusCheckRollup"
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
}
