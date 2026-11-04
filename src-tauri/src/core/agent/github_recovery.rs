//! Recovery for a GitHub URL that an anonymous web fetch cannot read.
//!
//! When `web_fetch` hits a GitHub URL and fails (`CRAWL_NOT_FOUND`, 404, an auth
//! failure -- all the shapes a *private* repository produces for a crawler with
//! no credentials), retrying the crawl or switching web-search providers cannot
//! help: the barrier is authentication, not the provider. This module drives the
//! useful alternative -- find the repository locally and inspect it with native
//! Git -- and, when that is impossible, reports exactly which recovery options
//! remain so the caller can ask the user rather than declaring the repo
//! unreachable.
//!
//! Everything here runs Git as a direct process (an argument array, no
//! `bash -c`, no `cmd /C`, no PowerShell), preserves spaces and Unicode in
//! paths, and hides the console window on Windows. `gh` is never required for
//! ordinary local inspection.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

// One implementation of the GitHub-repo coordinate and native-tool discovery,
// shared with the `git_inspect` tool (Q1-034). `parse_github_repo` stays here:
// this side accepts only URL and scp spellings, not a bare `owner/repo`.
pub use tauri_plugin_agent_tools::tools::git_native::{discover_git, on_path, two_segments, RepoRef, GITHUB_HOSTS};

/// Parse an owner/repo out of any GitHub URL or git remote spelling, or `None`
/// when the string does not name a GitHub repository.
///
/// Handles: `https://github.com/o/r`, `.../o/r.git`, `http://github.com/o/r/...`,
/// `https://api.github.com/repos/o/r`, `https://raw.githubusercontent.com/o/r/...`,
/// `git@github.com:o/r.git` (scp form) and `ssh://git@github.com/o/r.git`.
pub fn parse_github_repo(input: &str) -> Option<RepoRef> {
    let s = input.trim();
    if s.is_empty() {
        return None;
    }

    // scp-like syntax: `[user@]host:owner/repo(.git)` -- no `://`, a single
    // colon separating host from path. Detected before URL parsing because it
    // has no scheme.
    if !s.contains("://") {
        if let Some((host_part, path)) = s.split_once(':') {
            let host = host_part.rsplit('@').next().unwrap_or(host_part).to_ascii_lowercase();
            if host == "github.com" {
                return two_segments(path).map(|(o, r)| RepoRef::new(o, r));
            }
            // Not a code host we recognise; fall through (it may still be a URL).
        }
    }

    // Scheme form: strip `scheme://`, then any `user@`, then split host / path.
    let after_scheme = s.split_once("://").map(|(_, rest)| rest)?;
    // Split authority from path first; userinfo is only valid inside the
    // authority, so `github.com/x@evil.com/..` cannot pose as a github host.
    let (authority, path) = match after_scheme.split_once('/') {
        Some((a, p)) => (a.rsplit('@').next().unwrap_or(a), p),
        None => return None,
    };
    let host = authority.split(':').next().unwrap_or(authority).to_ascii_lowercase();
    if !GITHUB_HOSTS.contains(&host.as_str()) {
        return None;
    }
    // `api.github.com/repos/o/r` carries an extra leading `repos` segment.
    let path = if host == "api.github.com" {
        path.strip_prefix("repos/").unwrap_or(path)
    } else {
        path
    };
    two_segments(path).map(|(o, r)| RepoRef::new(o, r))
}

/// Whether two remote spellings name the same GitHub repository.
pub fn remotes_match(a: &str, b: &str) -> bool {
    match (parse_github_repo(a), parse_github_repo(b)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// Run native Git with the given args against `repo_dir`, direct (no shell),
/// window hidden, and return trimmed stdout on success.
fn run_git(git: &Path, repo_dir: &Path, args: &[&str]) -> Option<String> {
    let out = crate::core::agent::git_exec::GitCmd::new()
        .program(git)
        .dir(repo_dir)
        .args(args)
        .run()
        .ok()?;
    if !out.success {
        return None;
    }
    Some(out.stdout_lossy().trim().to_string())
}

/// Every remote URL configured in `repo_dir`, via native Git.
pub fn git_remote_urls(git: &Path, repo_dir: &Path) -> Vec<String> {
    // `config --get-regexp` gives one `remote.<name>.url <url>` per line and,
    // unlike `remote -v`, never doubles fetch/push or localises its output.
    let Some(text) = run_git(git, repo_dir, &["config", "--get-regexp", "^remote\\..*\\.url$"])
    else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| line.split_once(char::is_whitespace))
        .map(|(_, url)| url.trim().to_string())
        .filter(|u| !u.is_empty())
        .collect()
}

/// Whether `repo_dir` is the top of a Git working tree, via native Git.
pub fn is_git_toplevel(git: &Path, repo_dir: &Path) -> bool {
    match run_git(git, repo_dir, &["rev-parse", "--show-toplevel"]) {
        Some(top) => same_path(Path::new(&top), repo_dir),
        None => false,
    }
}

fn same_path(a: impl AsRef<Path>, b: impl AsRef<Path>) -> bool {
    let norm = |p: &Path| {
        std::fs::canonicalize(p)
            .unwrap_or_else(|_| p.to_path_buf())
            .to_string_lossy()
            .trim_end_matches(['/', '\\'])
            .to_ascii_lowercase()
            .replace('\\', "/")
    };
    norm(a.as_ref()) == norm(b.as_ref())
}

/// A candidate folder to search for a matching clone.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub path: PathBuf,
    /// Where this candidate came from, for the user-facing report.
    pub source: &'static str,
}

/// Search `candidates` for a Git repository whose remote matches `target`.
///
/// Only the folders passed in are inspected -- attached/authorized workspaces,
/// never a blind scan of the drive. Returns every match (more than one means the
/// user must choose).
pub fn find_local_clones(git: &Path, target: &RepoRef, candidates: &[Candidate]) -> Vec<PathBuf> {
    let mut hits = Vec::new();
    for cand in candidates {
        if !cand.path.is_dir() {
            continue;
        }
        let matches = git_remote_urls(git, &cand.path)
            .iter()
            .filter_map(|u| parse_github_repo(u))
            .any(|r| &r == target);
        if matches && !hits.iter().any(|p| same_path(p, &cand.path)) {
            hits.push(cand.path.clone());
        }
    }
    hits
}

/// Is `gh` installed, and is it authenticated? Native, no shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GhAuth {
    Yes,
    No,
    Unknown,
}

/// `(gh available, gh authenticated)`.
pub fn gh_status() -> (bool, GhAuth) {
    let Some(gh) = on_path(if cfg!(windows) { "gh.exe" } else { "gh" }) else {
        return (false, GhAuth::Unknown);
    };
    let mut cmd = Command::new(&gh);
    cmd.args(["auth", "status"]);
    cmd.env("GH_PROMPT_DISABLED", "1");
    // Bounded like every other `gh` call: a hung credential helper or network
    // check must not stall the caller.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let out = run_bounded(cmd, 64 * 1024, deadline);
    if out.ok {
        (true, GhAuth::Yes)
    } else if out.timed_out {
        (true, GhAuth::Unknown)
    } else {
        (true, GhAuth::No)
    }
}

/// Why a GitHub fetch could not be completed anonymously.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    PrivateRepositoryOrNotFound,
}

/// Structured recovery metadata for the model and the UI, so neither has to
/// parse prose. Mirrors the shape agreed with the caller.
#[derive(Debug, Clone, Serialize)]
pub struct RecoveryReport {
    pub reason: Reason,
    pub repository: String,
    /// The crawl that failed was anonymous.
    pub anonymous_web: bool,
    /// A matching local clone, if exactly the search folders held one.
    pub local_clone_match: Option<String>,
    /// Extra matches beyond the first, when several folders matched.
    pub additional_clone_matches: Vec<String>,
    pub git_available: bool,
    pub gh_available: bool,
    pub gh_authenticated: GhAuth,
    /// Ordered, machine-readable next steps.
    pub recommended_actions: Vec<&'static str>,
}

/// Build the recovery report for a failed GitHub fetch of `url`, searching only
/// `candidates` for a local clone. `None` when the URL is not a GitHub
/// repository (the caller should keep normal web behaviour).
pub fn build_report(url: &str, candidates: &[Candidate]) -> Option<RecoveryReport> {
    let target = parse_github_repo(url)?;
    let git = discover_git();
    let git_available = git.is_some();
    let clones = match &git {
        Some(g) => find_local_clones(g, &target, candidates),
        None => Vec::new(),
    };
    let (gh_available, gh_authenticated) = gh_status();

    let mut recommended_actions = Vec::new();
    if !clones.is_empty() {
        recommended_actions.push("use_matching_local_clone");
    }
    if clones.len() > 1 {
        recommended_actions.push("ask_user_to_choose_clone");
    }
    if clones.is_empty() {
        if git_available {
            recommended_actions.push("ask_user_to_attach_or_select_clone");
            recommended_actions.push("ask_user_to_clone_with_native_git");
        }
        if gh_available && gh_authenticated == GhAuth::Yes {
            recommended_actions.push("use_gh_authenticated");
        } else {
            recommended_actions.push("offer_install_or_auth_gh");
        }
        recommended_actions.push("ask_user_for_another_source");
    }
    // Never a recommendation: retrying the anonymous crawl or switching provider.

    Some(RecoveryReport {
        reason: Reason::PrivateRepositoryOrNotFound,
        repository: target.slug(),
        anonymous_web: true,
        local_clone_match: clones.first().map(|p| p.to_string_lossy().to_string()),
        additional_clone_matches: clones
            .iter()
            .skip(1)
            .map(|p| p.to_string_lossy().to_string())
            .collect(),
        git_available,
        gh_available,
        gh_authenticated,
        recommended_actions,
    })
}

/// Whether a fetch error looks like the anonymous-access wall a private repo
/// puts up (as opposed to an unrelated failure). Kept liberal: the cost of a
/// false positive is one extra structured note; the recovery it triggers is
/// harmless when the repo turns out to be public-but-flaky.
pub fn looks_like_private_access_failure(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("crawl_not_found")
        || e.contains("not found")
        || has_word(&e, "404")
        || has_word(&e, "403")
        || e.contains("unauthorized")
        || e.contains("forbidden")
        || e.contains("authentication")
}

/// Whether `needle` appears in `hay` not touching another digit or letter, so
/// a port, id or byte count that merely contains "404" is not an HTTP status.
fn has_word(hay: &str, needle: &str) -> bool {
    hay.match_indices(needle).any(|(i, _)| {
        let before = hay[..i].chars().next_back();
        let after = hay[i + needle.len()..].chars().next();
        !before.is_some_and(|c| c.is_ascii_alphanumeric())
            && !after.is_some_and(|c| c.is_ascii_alphanumeric())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn userinfo_trick_in_path_is_not_a_github_host() {
        assert!(parse_github_repo("https://evil.com/github.com@x/o/r").is_none());
        assert!(parse_github_repo("https://user@github.com/o/r").is_some());
    }

    #[test]
    fn status_match_respects_word_boundaries() {
        assert!(looks_like_private_access_failure("HTTP 404 Not Found"));
        assert!(looks_like_private_access_failure("status:403"));
        assert!(!looks_like_private_access_failure("connect to 10.0.0.4040 failed"));
        assert!(!looks_like_private_access_failure("read 14035 bytes"));
    }

    #[test]
    fn parses_every_github_remote_spelling_to_the_same_repo() {
        let want = RepoRef::new("Jozkah", "streamer");
        for form in [
            "https://github.com/Jozkah/streamer",
            "https://github.com/Jozkah/streamer.git",
            "http://github.com/Jozkah/streamer/pull/7",
            "https://api.github.com/repos/Jozkah/streamer",
            "https://raw.githubusercontent.com/Jozkah/streamer/main/README.md",
            "git@github.com:Jozkah/streamer.git",
            "ssh://git@github.com/Jozkah/streamer.git",
            // Case-insensitive owner/repo.
            "https://github.com/JOZKAH/Streamer.git",
        ] {
            assert_eq!(parse_github_repo(form).as_ref(), Some(&want), "form: {form}");
        }
    }

    #[test]
    fn non_github_and_malformed_urls_are_rejected() {
        for form in [
            "https://example.com/Jozkah/streamer",
            "https://gitlab.com/Jozkah/streamer",
            "https://github.com/onlyowner",
            "not a url",
            "",
            // Look-alike host must not match.
            "https://mygithub.com.evil.test/Jozkah/streamer",
        ] {
            assert_eq!(parse_github_repo(form), None, "form: {form}");
        }
    }

    #[test]
    fn remotes_match_across_syntaxes_and_case() {
        assert!(remotes_match(
            "git@github.com:Jozkah/streamer.git",
            "https://github.com/jozkah/Streamer"
        ));
        assert!(!remotes_match(
            "https://github.com/Jozkah/streamer",
            "https://github.com/Jozkah/other"
        ));
    }

    /// A repo whose remote matches -- in a path containing spaces -- is found
    /// via native Git, and public-vs-private plays no part in local inspection.
    #[test]
    fn finds_a_matching_clone_in_a_path_with_spaces() {
        let Some(git) = discover_git() else {
            eprintln!("git not installed; skipping");
            return;
        };
        let base = std::env::temp_dir().join(format!("jan gh rec {}", std::process::id()));
        let repo = base.join("OBS Project");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |args: &[&str]| {
            let mut c = Command::new(&git);
            c.arg("-C").arg(&repo).args(args);
            jan_utils::system::hide_console_window(&mut c);
            assert!(c.output().unwrap().status.success(), "git {args:?}");
        };
        run(&["init", "-q"]);
        run(&["remote", "add", "origin", "git@github.com:Jozkah/streamer.git"]);

        // The remote is discovered and normalized.
        let urls = git_remote_urls(&git, &repo);
        assert!(
            urls.iter().any(|u| parse_github_repo(u) == Some(RepoRef::new("Jozkah", "streamer"))),
            "remotes: {urls:?}"
        );
        assert!(is_git_toplevel(&git, &repo), "toplevel with spaces");

        // The resolver picks it out of a candidate set, and ignores a
        // non-matching sibling repo.
        let other = base.join("unrelated");
        std::fs::create_dir_all(&other).unwrap();
        let mut c = Command::new(&git);
        c.arg("-C").arg(&other).args(["init", "-q"]);
        jan_utils::system::hide_console_window(&mut c);
        c.output().unwrap();

        let target = RepoRef::new("jozkah", "STREAMER"); // case-insensitive
        let hits = find_local_clones(
            &git,
            &target,
            &[
                Candidate { path: other.clone(), source: "attached" },
                Candidate { path: repo.clone(), source: "attached" },
                Candidate { path: base.join("does-not-exist"), source: "attached" },
            ],
        );
        assert_eq!(hits.len(), 1, "exactly the matching clone: {hits:?}");
        assert!(same_path(&hits[0], &repo));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn report_recommends_the_clone_when_one_matches_and_never_a_provider_retry() {
        let Some(git) = discover_git() else {
            eprintln!("git not installed; skipping");
            return;
        };
        let base = std::env::temp_dir().join(format!("jan gh rpt {}", std::process::id()));
        let repo = base.join("clone here");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |args: &[&str]| {
            let mut c = Command::new(&git);
            c.arg("-C").arg(&repo).args(args);
            jan_utils::system::hide_console_window(&mut c);
            c.output().unwrap();
        };
        run(&["init", "-q"]);
        run(&["remote", "add", "origin", "https://github.com/Jozkah/streamer.git"]);

        let report = build_report(
            "https://github.com/Jozkah/streamer",
            &[Candidate { path: repo.clone(), source: "attached" }],
        )
        .expect("github url");
        assert_eq!(report.reason, Reason::PrivateRepositoryOrNotFound);
        assert!(report.anonymous_web);
        assert!(report.git_available);
        assert_eq!(report.local_clone_match.as_deref(), Some(repo.to_string_lossy().as_ref()));
        assert!(report.recommended_actions.contains(&"use_matching_local_clone"));
        // Must never suggest re-crawling or switching provider.
        let json = serde_json::to_string(&report).unwrap();
        assert!(!json.contains("provider"), "no provider retry: {json}");
        assert!(!json.to_lowercase().contains("web_search"), "{json}");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn report_asks_the_user_when_no_clone_matches() {
        let report = build_report(
            "https://github.com/Jozkah/streamer",
            &[], // no candidates
        )
        .expect("github url");
        assert!(report.local_clone_match.is_none());
        assert!(
            report.recommended_actions.contains(&"ask_user_for_another_source"),
            "{:?}",
            report.recommended_actions
        );
        // Offers an actionable alternative, not a dead end.
        assert!(report.recommended_actions.len() >= 2);
    }

    #[test]
    fn a_non_github_url_produces_no_report() {
        assert!(build_report("https://example.com/x", &[]).is_none());
        assert!(build_report("https://gitlab.com/o/r", &[]).is_none());
    }

    #[test]
    fn private_access_failure_is_recognised_but_ordinary_errors_are_not() {
        for e in ["Error fetching URL(s): CRAWL_NOT_FOUND", "HTTP 404 Not Found", "403 Forbidden"] {
            assert!(looks_like_private_access_failure(e), "{e}");
        }
        assert!(!looks_like_private_access_failure("connection reset by peer"));
        assert!(!looks_like_private_access_failure("timed out"));
    }
}

/// What one bounded `gh` call printed.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "cli", allow(dead_code))]
pub(crate) struct GhOutput {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    /// Stdout reached the cap and the rest was not read.
    pub truncated: bool,
    /// The deadline passed and the process was killed (typed, so no caller
    /// has to compare `stderr` against the message below).
    pub timed_out: bool,
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
                // Only output that did not fit makes it "full"; a read that
                // exactly fills the cap is not truncation by itself.
                if n > room {
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
            // Keep 64 KiB but read to the end: stopping at the cap left `gh`
            // blocked writing to a full stderr pipe until the timeout.
            let mut chunk = [0u8; 16 * 1024];
            while let Ok(n) = err.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let room = (64 * 1024usize).saturating_sub(buf.len());
                buf.extend_from_slice(&chunk[..n.min(room)]);
            }
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
        std::thread::sleep(std::time::Duration::from_millis(25));
    };
    // A process that exited normally has closed its pipes; one that was killed
    // may have left a grandchild holding them, so the wait is bounded.
    let grace = if killed { std::time::Duration::from_millis(500) } else { std::time::Duration::from_secs(5) };
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
        timed_out,
    }
}
