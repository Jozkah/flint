//! Native-Git recovery for a private GitHub repository, as a constrained tool.
//!
//! When `web_fetch` cannot read a GitHub URL because the repository is private,
//! the useful move is not to retry the anonymous crawl or switch web-search
//! provider -- it is to inspect a local clone. But the sandboxed `bash` tool
//! runs in an AppContainer whose PowerShell has no `git` on PATH and cannot read
//! outside the workspace, so `git` there fails with "not recognized" or "access
//! denied". This module runs Git *outside* that shell, as a direct process, and
//! only against folders the run is already allowed to read (`read_roots` --
//! attached or explicitly authorized). It grants no broad filesystem access and
//! never composes a shell command line.
//!
//! The model reaches it through the `git_inspect` tool; it never needs the host
//! Git path. A qualifying `web_fetch` failure also gets a structured recovery
//! note appended automatically, so the model is handed the matching clone and
//! the next step rather than a dead end.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

/// Keep a short-lived native-Git process from flashing a console window on
/// Windows. Inlined (the plugin does not depend on `jan-utils`), matching the
/// `CREATE_NO_WINDOW` pattern the rest of this crate already uses.
fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// A GitHub repository coordinate, compared case-insensitively with any trailing
/// `.git` dropped, so every remote spelling of the same repo compares equal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub owner: String,
    pub repo: String,
}

impl RepoRef {
    fn new(owner: &str, repo: &str) -> Self {
        Self {
            owner: owner.trim().to_ascii_lowercase(),
            repo: repo
                .trim()
                .strip_suffix(".git")
                .unwrap_or_else(|| repo.trim())
                .to_ascii_lowercase(),
        }
    }
    fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

const GITHUB_HOSTS: &[&str] = &["github.com", "api.github.com", "raw.githubusercontent.com"];

/// Parse an owner/repo out of any GitHub URL, remote spelling, or a bare
/// `owner/repo`, or `None` when it is not a GitHub repository.
pub fn parse_github_repo(input: &str) -> Option<RepoRef> {
    let s = input.trim();
    if s.is_empty() {
        return None;
    }
    // scp syntax: `[user@]github.com:owner/repo(.git)`.
    if !s.contains("://") && s.contains(':') && !s.starts_with(|c: char| c.is_ascii_alphabetic() && s[1..].starts_with(":\\")) {
        if let Some((host_part, path)) = s.split_once(':') {
            let host = host_part.rsplit('@').next().unwrap_or(host_part).to_ascii_lowercase();
            if host == "github.com" {
                return two_segments(path).map(|(o, r)| RepoRef::new(o, r));
            }
        }
    }
    // Bare `owner/repo` with no host at all.
    if !s.contains("://") && !s.contains(':') && s.matches('/').count() == 1 {
        return two_segments(s).map(|(o, r)| RepoRef::new(o, r));
    }
    // URL form.
    let after_scheme = s.split_once("://").map(|(_, rest)| rest)?;
    let after_userinfo = after_scheme.rsplit('@').next().unwrap_or(after_scheme);
    let (authority, path) = after_userinfo.split_once('/')?;
    let host = authority.split(':').next().unwrap_or(authority).to_ascii_lowercase();
    if !GITHUB_HOSTS.contains(&host.as_str()) {
        return None;
    }
    let path = if host == "api.github.com" {
        path.strip_prefix("repos/").unwrap_or(path)
    } else {
        path
    };
    two_segments(path).map(|(o, r)| RepoRef::new(o, r))
}

fn two_segments(path: &str) -> Option<(&str, &str)> {
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let mut it = path.split('/').filter(|seg| !seg.is_empty());
    let owner = it.next()?;
    let repo = it.next()?;
    (!owner.is_empty() && !repo.is_empty()).then_some((owner, repo))
}

/// Whether a fetch error looks like the private-access wall (as opposed to an
/// unrelated network failure).
pub fn looks_like_private_access_failure(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("crawl_not_found")
        || e.contains("not found")
        || e.contains("404")
        || e.contains("403")
        || e.contains("unauthorized")
        || e.contains("forbidden")
        || e.contains("authentication")
}

/// Locate native Git without relying only on the shell's PATH.
pub fn discover_git() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(p) = on_path("git.exe") {
            return Some(p);
        }
        for known in [
            r"C:\Program Files\Git\cmd\git.exe",
            r"C:\Program Files\Git\bin\git.exe",
            r"C:\Program Files (x86)\Git\cmd\git.exe",
            r"C:\Program Files (x86)\Git\bin\git.exe",
        ] {
            if Path::new(known).is_file() {
                return Some(PathBuf::from(known));
            }
        }
        git_from_registry()
    }
    #[cfg(not(windows))]
    {
        on_path("git")
    }
}

fn on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    #[cfg(windows)]
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".to_string())
        .split(';')
        .filter(|e| !e.is_empty())
        .map(|e| e.to_ascii_lowercase())
        .collect();
    for dir in std::env::split_paths(&path) {
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        #[cfg(windows)]
        if Path::new(name).extension().is_none() {
            for ext in &exts {
                let cand = dir.join(format!("{name}{ext}"));
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn git_from_registry() -> Option<PathBuf> {
    for (root, sub) in [("HKLM", "SOFTWARE\\GitForWindows"), ("HKCU", "SOFTWARE\\GitForWindows")] {
        if let Some(install) = reg_read_string(root, sub, "InstallPath") {
            for tail in ["cmd\\git.exe", "bin\\git.exe"] {
                let cand = Path::new(&install).join(tail);
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn reg_read_string(root: &str, subkey: &str, value: &str) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
    };
    let hkey = match root {
        "HKLM" => HKEY_LOCAL_MACHINE,
        "HKCU" => HKEY_CURRENT_USER,
        _ => return None,
    };
    let wide = |s: &str| -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    };
    let sub = wide(subkey);
    let val = wide(value);
    let mut len: u32 = 0;
    let rc = unsafe {
        RegGetValueW(hkey, sub.as_ptr(), val.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut len)
    };
    if rc != ERROR_SUCCESS || len == 0 {
        return None;
    }
    let mut buf = vec![0u16; (len as usize) / 2 + 1];
    let mut len2 = (buf.len() * 2) as u32;
    let rc = unsafe {
        RegGetValueW(hkey, sub.as_ptr(), val.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr() as *mut _, &mut len2)
    };
    if rc != ERROR_SUCCESS {
        return None;
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..end]))
}

/// Run native Git directly (argv array, no shell), window hidden. Returns
/// `(success, combined output)`; stderr is included because a caller reporting
/// a failure wants git's own reason.
fn run_git(git: &Path, repo_dir: &Path, args: &[&str]) -> (bool, String) {
    let mut cmd = Command::new(git);
    cmd.arg("-C")
        .arg(repo_dir)
        // No hooks, no pager, no credential prompt that could hang unseen.
        .arg("-c").arg("core.hooksPath=/dev/null")
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_OPTIONAL_LOCKS", "0");
    hide_console(&mut cmd);
    match cmd.output() {
        Ok(out) => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr);
                if !err.trim().is_empty() {
                    text.push_str(err.trim());
                }
            }
            (out.status.success(), text.trim().to_string())
        }
        Err(e) => (false, format!("failed to launch git: {e}")),
    }
}

fn git_remote_urls(git: &Path, repo_dir: &Path) -> Vec<String> {
    let (ok, text) = run_git(git, repo_dir, &["config", "--get-regexp", "^remote\\..*\\.url$"]);
    if !ok {
        return Vec::new();
    }
    text.lines()
        .filter_map(|line| line.split_once(char::is_whitespace))
        .map(|(_, url)| url.trim().to_string())
        .filter(|u| !u.is_empty())
        .collect()
}

/// The read roots that are themselves the top of a Git working tree whose remote
/// matches `target`. Only the roots the run may already read are considered.
fn matching_clones(git: &Path, target: &RepoRef, read_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut hits: Vec<PathBuf> = Vec::new();
    for root in read_roots {
        if !root.is_dir() {
            continue;
        }
        let matched = git_remote_urls(git, root)
            .iter()
            .filter_map(|u| parse_github_repo(u))
            .any(|r| &r == target);
        if matched && !hits.iter().any(|p| p == root) {
            hits.push(root.clone());
        }
    }
    hits
}

/// `(gh installed, gh authenticated)`. Native, no shell. `"unknown"` when `gh`
/// is present but its auth state could not be read.
fn gh_status() -> (bool, &'static str) {
    let Some(gh) = on_path(if cfg!(windows) { "gh.exe" } else { "gh" }) else {
        return (false, "unknown");
    };
    let mut cmd = Command::new(&gh);
    cmd.args(["auth", "status"]);
    hide_console(&mut cmd);
    match cmd.output() {
        Ok(out) if out.status.success() => (true, "yes"),
        Ok(_) => (true, "no"),
        Err(_) => (true, "unknown"),
    }
}

/// A read-only Git operation the tool will run. Fixed argv per variant so no
/// caller string reaches git as an option -- there is no arbitrary passthrough.
fn op_args(op: &str) -> Option<Vec<&'static str>> {
    Some(match op {
        "summary" | "" => return None, // handled specially (several commands)
        "status" => vec!["status", "--short", "--branch"],
        "remotes" => vec!["remote", "-v"],
        "branches" => vec!["branch", "-a", "--no-color"],
        "log" => vec!["log", "--oneline", "-n", "20", "--no-color"],
        "show" => vec!["show", "--stat", "--no-color", "HEAD"],
        "files" => vec!["ls-files"],
        _ => return None,
    })
}

/// The `git_inspect` tool. Finds the attached clone that matches the given
/// GitHub URL/repo and runs a read-only Git operation on it natively -- or,
/// when zero or several match, returns structured guidance so the model asks
/// the user rather than stopping. `read_roots` are the only folders considered.
pub async fn git_inspect(args: &Value, read_roots: &[PathBuf]) -> String {
    let Some(url) = args.get("url").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty())
    else {
        return "ERROR: git_inspect requires a 'url' string (a GitHub repository URL or owner/repo).".to_string();
    };
    let Some(target) = parse_github_repo(url) else {
        return format!("ERROR: git_inspect 'url' is not a GitHub repository: {url}");
    };
    let op = args.get("op").and_then(|v| v.as_str()).unwrap_or("summary").trim().to_string();

    let Some(git) = discover_git() else {
        return json!({
            "status": "git_unavailable",
            "repository": target.slug(),
            "message": "Native Git is not installed on this machine, so a local clone cannot be inspected. Ask the user to install Git, or to provide another accessible source.",
            "recommended_actions": ["ask_user_to_install_git", "ask_user_for_another_source"],
        }).to_string();
    };

    let clones = matching_clones(&git, &target, read_roots);
    match clones.len() {
        0 => json!({
            "status": "no_local_clone",
            "repository": target.slug(),
            "anonymous_web": true,
            "message": format!(
                "No attached folder is a clone of {}. web_fetch cannot read a private repository. Do not retry web_fetch or switch web-search providers. Ask the user to choose one: attach or select the local clone; let native Git use their existing credentials; install or authenticate the GitHub CLI (gh); provide another accessible source; or cancel.",
                target.slug()
            ),
            "recommended_actions": [
                "ask_user_to_attach_or_select_clone",
                "ask_user_to_use_authenticated_git",
                "offer_install_or_auth_gh",
                "ask_user_for_another_source",
                "cancel",
            ],
        }).to_string(),
        1 => {
            let dir = &clones[0];
            let commands: Vec<Vec<&str>> = if op == "summary" {
                vec![
                    vec!["rev-parse", "--abbrev-ref", "HEAD"],
                    vec!["remote", "-v"],
                    vec!["status", "--short", "--branch"],
                    vec!["log", "--oneline", "-n", "10", "--no-color"],
                ]
            } else {
                match op_args(&op) {
                    Some(a) => vec![a],
                    None => {
                        return format!(
                            "ERROR: git_inspect 'op' must be one of: summary, status, remotes, branches, log, show, files. Got: {op}"
                        )
                    }
                }
            };
            let mut out = format!(
                "Recovered locally: {} is checked out at an attached folder, inspected with native Git (no web fetch, no shell).\nClone: {}\n",
                target.slug(),
                dir.display()
            );
            for cmd in commands {
                let (ok, text) = run_git(&git, dir, &cmd);
                out.push_str(&format!("\n$ git {}\n{}\n", cmd.join(" "), if text.is_empty() { if ok { "(no output)" } else { "(failed)" } } else { &text }));
            }
            out.push_str("\nContinue the original task using this local clone. Read files with the read/ls/grep tools (this folder is attached), and use git_inspect again for other read-only Git facts.");
            out
        }
        _ => json!({
            "status": "multiple_local_clones",
            "repository": target.slug(),
            "message": format!(
                "Several attached folders are clones of {}. Ask the user which one to use before inspecting it.",
                target.slug()
            ),
            "clones": clones.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
            "recommended_actions": ["ask_user_to_choose_clone"],
        }).to_string(),
    }
}

/// A recovery note to append to a failed GitHub `web_fetch`, or `None` when the
/// URL is not a GitHub repo or the failure is not the private-access kind.
///
/// It states plainly that anonymous web cannot read a private repo, that
/// retrying/switching providers will not help, and -- if an attached clone
/// matches -- points at it and tells the model to call `git_inspect`.
pub fn web_fetch_recovery_note(url: &str, err: &str, read_roots: &[PathBuf]) -> Option<String> {
    let target = parse_github_repo(url)?;
    if !looks_like_private_access_failure(err) {
        return None;
    }
    let git = discover_git();
    let clones = git
        .as_ref()
        .map(|g| matching_clones(g, &target, read_roots))
        .unwrap_or_default();

    let mut note = String::from(
        "\n\nRECOVERY: web_fetch is an anonymous crawler with no GitHub credentials, so it cannot read a private repository. Do NOT retry web_fetch and do NOT switch web-search providers -- neither can authenticate.",
    );
    match clones.len() {
        1 => note.push_str(&format!(
            " An attached folder is a local clone of {} ({}). Call the `git_inspect` tool with url=\"{}\" to inspect it with native Git and continue the task from the local clone.",
            target.slug(),
            clones[0].display(),
            url
        )),
        n if n > 1 => note.push_str(&format!(
            " Several attached folders are clones of {}. Call `git_inspect` with url=\"{}\"; it will list them so you can ask the user which to use.",
            target.slug(),
            url
        )),
        _ => note.push_str(&format!(
            " Call the `git_inspect` tool with url=\"{}\": if the repo is attached it will inspect the local clone, otherwise it returns the choices to offer the user (attach/select a clone, use authenticated git, install/auth gh, another source, or cancel). Do not conclude the repository is unreachable.",
            url
        )),
    }
    // Structured metadata so the agent loop has machine-readable state, not only
    // prose. Mirrors the RecoveryReport shape: reason, what was searched, what is
    // available, and the ordered actions.
    let (gh_available, gh_authenticated) = gh_status();
    let recommended_actions: Vec<&str> = match clones.len() {
        1 => vec!["call_git_inspect", "use_matching_local_clone"],
        n if n > 1 => vec!["call_git_inspect", "ask_user_to_choose_clone"],
        _ => vec![
            "call_git_inspect",
            "ask_user_to_attach_or_select_clone",
            "use_authenticated_git",
            "offer_install_or_auth_gh",
            "ask_user_for_another_source",
            "cancel",
        ],
    };
    let report = json!({
        "reason": "private_repository_or_not_found",
        "repository": target.slug(),
        "anonymous_web": true,
        "local_clone_match": clones.first().map(|p| p.display().to_string()),
        "additional_clone_matches": clones.iter().skip(1).map(|p| p.display().to_string()).collect::<Vec<_>>(),
        "git_available": git.is_some(),
        "gh_available": gh_available,
        "gh_authenticated": gh_authenticated,
        "tool_to_call": "git_inspect",
        "recommended_actions": recommended_actions,
    });
    note.push_str(&format!("\nRECOVERY_METADATA (structured): {report}"));
    Some(note)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn init_repo(dir: &Path, remote: &str) {
        let git = discover_git().expect("git");
        for args in [vec!["init", "-q"], vec!["remote", "add", "origin", remote]] {
            let mut c = Command::new(&git);
            c.arg("-C").arg(dir).args(&args);
            hide_console(&mut c);
            c.output().unwrap();
        }
        // one commit so summary's log has something
        std::fs::write(dir.join("README.md"), "hi").unwrap();
        for args in [
            vec!["-c", "user.email=t@t", "-c", "user.name=t", "add", "."],
            vec!["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
        ] {
            let mut c = Command::new(&git);
            c.arg("-C").arg(dir).args(&args);
            hide_console(&mut c);
            c.output().unwrap();
        }
    }

    #[test]
    fn parses_and_matches_every_remote_spelling() {
        let want = RepoRef::new("Jozkah", "streamer");
        for f in [
            "https://github.com/Jozkah/streamer",
            "https://github.com/Jozkah/streamer.git",
            "https://api.github.com/repos/Jozkah/streamer",
            "git@github.com:Jozkah/streamer.git",
            "ssh://git@github.com/Jozkah/streamer.git",
            "Jozkah/streamer",
            "https://github.com/JOZKAH/Streamer",
        ] {
            assert_eq!(parse_github_repo(f).as_ref(), Some(&want), "{f}");
        }
        for f in ["https://example.com/o/r", "https://gitlab.com/o/r", "C:\\path\\repo", "not a url"] {
            assert_eq!(parse_github_repo(f), None, "{f}");
        }
    }

    #[tokio::test]
    async fn one_matching_attached_clone_is_inspected_locally_in_a_spaced_path() {
        if discover_git().is_none() {
            eprintln!("git missing; skip");
            return;
        }
        let base = std::env::temp_dir().join(format!("jan gitnat {}", std::process::id()));
        let repo = base.join("OBS Project");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo, "git@github.com:Jozkah/streamer.git");
        let other = base.join("unrelated");
        std::fs::create_dir_all(&other).unwrap();
        init_repo(&other, "https://github.com/someone/else.git");

        let roots = vec![other.clone(), repo.clone()];
        let out = git_inspect(&json!({ "url": "https://github.com/Jozkah/streamer" }), &roots).await;
        assert!(out.contains("Recovered locally"), "{out}");
        assert!(out.contains("OBS Project"), "clone path: {out}");
        assert!(out.contains("origin") && out.to_lowercase().contains("streamer"), "remote shown: {out}");
        assert!(!out.contains("someone/else"), "must not pick the unrelated repo: {out}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn no_match_returns_user_choices_not_a_dead_end() {
        let out = git_inspect(&json!({ "url": "https://github.com/Jozkah/streamer" }), &[]).await;
        assert!(out.contains("no_local_clone"), "{out}");
        assert!(out.contains("ask_user_to_attach_or_select_clone"), "{out}");
        assert!(!out.to_lowercase().contains("unreachable"));
    }

    #[tokio::test]
    async fn multiple_matches_ask_the_user_to_choose() {
        if discover_git().is_none() {
            return;
        }
        let base = std::env::temp_dir().join(format!("jan gitnat multi {}", std::process::id()));
        let a = base.join("clone a");
        let b = base.join("clone b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        init_repo(&a, "https://github.com/Jozkah/streamer.git");
        init_repo(&b, "git@github.com:Jozkah/streamer.git");
        let out = git_inspect(&json!({ "url": "Jozkah/streamer" }), &[a.clone(), b.clone()]).await;
        assert!(out.contains("multiple_local_clones"), "{out}");
        assert!(out.contains("ask_user_to_choose_clone"), "{out}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn recovery_note_only_for_private_github_failures_and_points_at_the_clone() {
        // Non-GitHub: no note.
        assert!(web_fetch_recovery_note("https://example.com/x", "CRAWL_NOT_FOUND", &[]).is_none());
        // GitHub but a non-private failure: no note.
        assert!(web_fetch_recovery_note("https://github.com/o/r", "connection reset", &[]).is_none());
        // GitHub private failure, no clone: steer to git_inspect + user choices.
        let n = web_fetch_recovery_note("https://github.com/Jozkah/streamer", "Error: CRAWL_NOT_FOUND", &[]).unwrap();
        assert!(n.contains("git_inspect"), "{n}");
        assert!(n.contains("Do NOT retry web_fetch"), "{n}");
        // It instructs against a false "unreachable" conclusion rather than
        // asserting one.
        assert!(n.contains("Do not conclude the repository is unreachable"), "{n}");
    }
}
