//! The `git` tool: the host's real `git` (and `gh`) run outside the sandbox.
//!
//! On Windows the `bash` tool runs in an AppContainer that cannot start Git for
//! Windows, so an agent could not commit, push or open a pull request, and
//! models fell back to MCP shells that bypass Flint's approval prompts. This
//! tool runs the host binaries directly, as an argv array (never a shell
//! string), with the working directory confined to the folders the run may
//! use, a timeout, a bounded and secret-redacted output, and no credential
//! store of its own: git and gh use the user's existing login (a git network
//! call to an https host gh is logged in to uses gh's login, through
//! `gh auth git-credential`), and nothing can prompt
//! (`GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`).
//!
//! Every call is classified before it runs ([`plan`]):
//!
//! * [`GitClass::Read`] -- status, log, diff, `gh pr list`, ... -- runs
//!   without asking.
//! * [`GitClass::Local`] -- add, commit, checkout, merge, clone into an
//!   allowed folder, ... -- is put to the user unless the run is one that
//!   auto-approves its own workspace.
//! * [`GitClass::Remote`] -- push, `gh pr create`, ... -- is always put to the
//!   user, naming the exact command, remote and branch.
//!
//! A call can also be *destructive* (force push, `reset --hard`, `clean`,
//! `branch -D`, `gh repo delete`), which is always asked about with a stronger
//! warning. Options that would let a call run arbitrary programs or read
//! outside the allowed folders (`-c core.sshCommand=...`, `--upload-pack`,
//! credential helpers, `git config --global`, `gh api`, ...) are refused
//! before anything runs.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

/// Longest output handed back to the model, in bytes.
pub const OUTPUT_CAP: usize = 64 * 1024;
/// Limit for a call that stays on this machine.
pub const LOCAL_TIMEOUT_SECS: u64 = 120;
/// Limit for a call that talks to a remote (clone, fetch, pull, push, gh).
pub const REMOTE_TIMEOUT_SECS: u64 = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Program {
    Git,
    Gh,
}

impl Program {
    pub fn as_str(self) -> &'static str {
        match self {
            Program::Git => "git",
            Program::Gh => "gh",
        }
    }
}

/// How much a call is allowed to do without the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitClass {
    /// Reads repository state. Never asked about.
    Read,
    /// Changes the local repository or working tree.
    Local,
    /// Writes to a remote: push, or a GitHub change through `gh`.
    Remote,
}

/// A classified call, ready to run and to describe in an approval prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitPlan {
    pub program: Program,
    /// The argv after the program name, exactly as it will run.
    pub args: Vec<String>,
    pub class: GitClass,
    /// Why the call can lose work or rewrite shared history, if it can.
    pub destructive: Option<String>,
    /// Whether the call talks to a remote at all (clone, fetch, push, gh).
    pub reaches_remote: bool,
    /// The remote named in the call (`origin`), or a gh `--repo` value.
    pub remote: Option<String>,
    /// The branch or refspec named in the call, when it names one.
    pub branch: Option<String>,
}

impl GitPlan {
    /// The command line as the user is shown it.
    pub fn display(&self) -> String {
        let mut out = self.program.as_str().to_string();
        for a in &self.args {
            out.push(' ');
            if a.is_empty() || a.chars().any(|c| c.is_whitespace() || c == '"') {
                out.push('"');
                out.push_str(&a.replace('"', "\\\""));
                out.push('"');
            } else {
                out.push_str(a);
            }
        }
        out
    }

    /// Whether the call must be put to the user every time, whatever the
    /// run's mode or earlier answers: anything that writes to a remote, and
    /// anything destructive.
    pub fn always_asks(&self) -> bool {
        self.class == GitClass::Remote || self.destructive.is_some()
    }
}

fn has(args: &[String], flags: &[&str]) -> bool {
    args.iter().any(|a| flags.contains(&a.as_str()))
}

/// Whether any argument is one of `flags`, or one of them with `=value`.
fn has_opt(args: &[String], flags: &[&str]) -> bool {
    args.iter().any(|a| {
        flags
            .iter()
            .any(|f| a == f || (f.starts_with("--") && a.starts_with(&format!("{f}="))))
    })
}

/// A short-option cluster (`-fd`) containing `c`.
fn has_short(args: &[String], c: char) -> bool {
    args.iter()
        .any(|a| a.starts_with('-') && !a.starts_with("--") && a.len() > 1 && a[1..].contains(c))
}

/// Arguments that are not options, skipping the values of `value_flags`.
fn positionals<'a>(args: &'a [String], value_flags: &[&str]) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut i = 0;
    let mut after_dashdash = false;
    while i < args.len() {
        let a = args[i].as_str();
        if after_dashdash {
            out.push(a);
        } else if a == "--" {
            after_dashdash = true;
        } else if a.starts_with('-') && a.len() > 1 {
            if value_flags.contains(&a) {
                i += 1;
            }
        } else {
            out.push(a);
        }
        i += 1;
    }
    out
}

/// Options refused wherever they appear: each can run another program, read
/// or write outside the allowed folders, or swap in a credential source.
const DENIED_GIT_OPTIONS: &[&str] = &[
    "--upload-pack",
    "--receive-pack",
    "--exec",
    "--template",
    "--config",
    "--config-env",
    "--no-index",
    "--output",
    "--output-directory",
    "--open-files-in-pager",
    "--git-dir",
    "--work-tree",
    "--separate-git-dir",
    "--reference",
    "--reference-if-able",
    "--ext-diff",
    // Options that make a Read-class call print a host file (P2B-001).
    "--contents",
    "--ignore-revs-file",
    "--exclude-from",
    "--pathspec-from-file",
];

fn deny_common_git(sub: &str, rest: &[String]) -> Result<(), String> {
    for a in rest {
        let lower = a.to_ascii_lowercase();
        // git accepts any unambiguous prefix of a long option (`--upload`,
        // `--exe`), so a prefix of a denied option is refused too.
        let name = lower.split('=').next().unwrap_or("");
        // Real options that are a prefix of a denied one (git prefers the exact
        // match): `blame --ignore-rev <rev>`, `log --exclude=<glob>`.
        if name == "--ignore-rev" || name == "--exclude" {
            continue;
        }
        for opt in DENIED_GIT_OPTIONS {
            if name.len() >= 3 && name.starts_with("--") && opt.starts_with(name) {
                return Err(format!(
                    "the option `{a}` is not allowed: it can run other programs or reach outside the allowed folders"
                ));
            }
        }
        if lower.starts_with("ext::") || lower.starts_with("fd::") {
            return Err(format!("the transport in `{a}` is not allowed"));
        }
    }
    // `-O<orderfile>` reads a file named by the call (diff family, log, show).
    if matches!(
        sub,
        "diff" | "log" | "show" | "diff-tree" | "diff-index" | "diff-files" | "range-diff"
    ) {
        let end = rest.iter().position(|a| a == "--").unwrap_or(rest.len());
        if rest[..end].iter().any(|a| a.starts_with("-O")) {
            return Err("`-O<orderfile>` reads a file and is not allowed".into());
        }
    }
    // Short spellings of the options above, per subcommand.
    match sub {
        // `-u` is `--upload-pack` for these two (for push it is
        // `--set-upstream`, for fetch `--update-head-ok`).
        "clone" | "ls-remote" => {
            // Short flags bundle (`-qucalc`), so every letter is checked.
            if has_short(rest, 'u') {
                return Err("`-u` (upload/receive-pack) is not allowed".into());
            }
            if sub == "clone" && has_short(rest, 'c') {
                return Err("`clone -c` (configuration override) is not allowed".into());
            }
        }
        "rebase" => {
            if has_short(rest, 'x') {
                return Err("`rebase -x/--exec` runs shell commands and is not allowed".into());
            }
        }
        "grep" => {
            if has_short(rest, 'O') {
                return Err("`grep -O` opens a pager program and is not allowed".into());
            }
            if has_short(rest, 'f') || has_opt(rest, &["--file"]) {
                return Err("`grep -f/--file` reads patterns from a file and is not allowed".into());
            }
        }
        "blame" => {
            if has_short(rest, 'S') {
                return Err("`blame -S` reads revisions from a file and is not allowed".into());
            }
        }
        "ls-files" => {
            if rest.iter().any(|a| a.starts_with("-X")) {
                return Err("`ls-files -X` reads patterns from a file and is not allowed".into());
            }
        }
        "merge" | "pull" => {
            let strategies = ["ort", "recursive", "resolve", "octopus", "ours", "subtree"];
            let mut it = rest.iter().peekable();
            while let Some(a) = it.next() {
                let value = if a == "-s" || a == "--strategy" {
                    it.peek().map(|s| s.as_str())
                } else if let Some(attached) = a.strip_prefix("-s").filter(|v| !v.is_empty() && !v.starts_with('-')) {
                    // `-sours` is `-s ours`: the attached spelling gets the same check.
                    Some(attached)
                } else {
                    a.strip_prefix("--strategy=")
                };
                if let Some(v) = value {
                    if !strategies.contains(&v) {
                        return Err(format!("merge strategy `{v}` is not allowed"));
                    }
                }
            }
        }
        "apply" | "am" => {
            // Both write files named by the patch: `--unsafe-paths` lifts the
            // check that they stay in the tree, `--directory` re-roots them.
            // Any unambiguous prefix of either works as well.
            let end = rest.iter().position(|a| a == "--").unwrap_or(rest.len());
            for a in &rest[..end] {
                let lower = a.to_ascii_lowercase();
                let name = lower.split('=').next().unwrap_or("");
                if name.len() >= 3
                    && name.starts_with("--")
                    && ["--unsafe-paths", "--directory"].iter().any(|opt| opt.starts_with(name))
                {
                    return Err(format!("the option `{a}` is not allowed for {sub}: it moves where a patch writes"));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// The files a call makes git read (`-F`, `--file`, commit `-t`; patch files
/// of `am`/`apply`), as the model wrote them.
fn message_file_values(sub: &str, rest: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        if a == "--" {
            break;
        }
        let value = match a.as_str() {
            "-m" | "--message" => {
                it.next();
                continue;
            }
            "-F" | "--file" | "-t" => it.next().map(String::as_str),
            _ => a
                .strip_prefix("--file=")
                .or_else(|| a.strip_prefix("-F").filter(|v| !v.is_empty()))
                .or_else(|| a.strip_prefix("-t").filter(|v| !v.is_empty())),
        };
        if let Some(v) = value {
            out.push(v.to_string());
        }
    }
    if matches!(sub, "am" | "apply") {
        let values = ["-p", "-C", "--directory", "--include", "--exclude", "--whitespace", "--reject"];
        out.extend(positionals(rest, &values).into_iter().map(str::to_string));
    }
    out
}

/// Whether `v` names a path outside the folder, by its spelling alone.
fn escapes_by_spelling(v: &str) -> bool {
    let p = std::path::Path::new(v);
    v != "-"
        && (p.is_absolute()
            || v.starts_with(['/', '\\'])
            || v.contains(':')
            || p.components().any(|c| matches!(c, std::path::Component::ParentDir)))
}

/// A message file (`-F`, `--file`, commit `-t`) is read by git outside the
/// sandbox, so it must be a relative path that stays inside the folder.
fn check_message_files(sub: &str, rest: &[String]) -> Result<(), String> {
    for v in message_file_values(sub, rest) {
        if escapes_by_spelling(&v) {
            return Err(format!(
                "the message file `{v}` must be a relative path inside the folder"
            ));
        }
    }
    Ok(())
}

/// The run-time half of `check_message_files`: a relative name can still be a
/// link to a file outside the writable folders (the model can make one with
/// `bash`), so each file is resolved against `cwd` and refused when it is a
/// symlink or lands outside `roots.write()`. A missing file is left to git.
pub fn check_message_file_paths(plan: &GitPlan, cwd: &Path, roots: &Roots) -> Result<(), String> {
    if plan.program != Program::Git {
        return Ok(());
    }
    let Some(sub) = plan.args.first() else {
        return Ok(());
    };
    if !matches!(sub.as_str(), "commit" | "notes" | "tag" | "merge" | "am" | "apply") {
        return Ok(());
    }
    for v in message_file_values(sub, &plan.args[1..]) {
        if v == "-" {
            continue;
        }
        let full = cwd.join(&v);
        let Ok(meta) = std::fs::symlink_metadata(&full) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            return Err(format!("the message file `{v}` is a symbolic link and is not allowed"));
        }
        let real = canon(&full).ok_or_else(|| format!("the message file `{v}` cannot be resolved"))?;
        if !inside(&real, &roots.write()) {
            return Err(format!(
                "the message file `{v}` resolves outside the folders this run may write"
            ));
        }
    }
    Ok(())
}

/// `git diff` falls back to `--no-index` when a path points outside the work
/// tree, printing any host file. Positionals (and everything after `--`) of
/// the diff family must therefore be in-tree spellings: not absolute, no
/// `..` component, no drive letter, no Windows device name.
fn check_diff_paths(rest: &[String]) -> Result<(), String> {
    let values = ["-U", "-S", "-G", "--diff-filter", "--relative", "--src-prefix", "--dst-prefix", "-l", "--stat-width"];
    for v in positionals(rest, &values) {
        let bytes = v.as_bytes();
        let drive = bytes.len() >= 2
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes.len() == 2 || matches!(bytes[2], b'/' | b'\\'));
        let device = {
            let stem = v.split('.').next().unwrap_or("").to_ascii_lowercase();
            matches!(stem.as_str(), "nul" | "con" | "prn" | "aux" | "conin$" | "conout$")
        };
        let dotdot = v.split(['/', '\\']).any(|c| c == "..");
        if v.starts_with(['/', '\\']) || drive || device || dotdot {
            return Err(format!(
                "`{v}` points outside the work tree; git would diff it as a plain file (--no-index) and print any host file. Use paths inside the repository"
            ));
        }
    }
    Ok(())
}

/// `git diff` in a folder that is not a work tree runs in `--no-index` mode
/// for plain paths. Refuse it there.
pub async fn check_diff_in_work_tree(plan: &GitPlan, cwd: &Path) -> Result<(), String> {
    if plan.program != Program::Git || plan.args.first().map(String::as_str) != Some("diff") {
        return Ok(());
    }
    let Some(git) = crate::tools::git_native::discover_git() else {
        return Ok(());
    };
    let mut cmd = tokio::process::Command::new(&git);
    jan_process::HostProcessEnv::host_env(&mut cmd);
    cmd.args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    match crate::tools::owned::output_with_timeout(&mut cmd, Duration::from_secs(30)).await {
        Ok(Ok(out)) if out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "true" => Ok(()),
        _ => Err("`git diff` only runs inside a Git work tree (outside one it would compare plain files, including files outside the allowed folders)".into()),
    }
}

/// Only network URLs can be cloned: a local path or `file://` would read a
/// repository outside the allowed folders.
fn check_clone_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    let ok = lower.starts_with("https://")
        || lower.starts_with("ssh://")
        || (lower.starts_with("git@") && lower.contains(':'));
    if ok {
        Ok(())
    } else {
        Err(format!(
            "only https://, ssh:// and git@host: URLs can be cloned, not `{url}`"
        ))
    }
}

/// Whether a remote argument names a configured remote (`origin`) rather than
/// spelling out where to go: a URL, an scp-style address or a path.
fn is_remote_name(s: &str) -> bool {
    !s.is_empty()
        && !s.contains([':', '/', '\\', '@'])
        && !s.starts_with(['.', '-', '~'])
}

/// A remote spelled out in a network call gets the same URL check as a clone:
/// `git ls-remote /etc` or `file://` would read a repository outside the
/// allowed folders, and the host of any other form is what the network rules
/// are matched against.
fn check_remote_arg(remote: &str) -> Result<(), String> {
    if is_remote_name(remote) {
        Ok(())
    } else {
        check_clone_url(remote)
    }
}

/// The host of a remote URL: `https://h/p`, `ssh://u@h:22/p` or `u@h:p`.
fn url_host(url: &str) -> Option<String> {
    let url = url.trim();
    let host = if url.contains("://") {
        url::Url::parse(url).ok()?.host_str()?.to_string()
    } else {
        let (_, rest) = url.split_once('@').unwrap_or(("", url));
        rest.split_once(':')?.0.to_string()
    };
    let host = host.trim_matches(['[', ']']).trim_end_matches('.').to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// The `url` (and, for a push, `pushurl`) values of `remote.<name>` in the
/// repository's own config file, read without running git. Follows a linked
/// worktree's `.git` file to the shared config. Empty when there is none.
fn configured_remote_urls(cwd: &Path, name: &str, push: bool) -> Vec<String> {
    let mut dir = Some(cwd);
    let mut git_dir: Option<PathBuf> = None;
    while let Some(d) = dir {
        let dot = d.join(".git");
        if dot.is_dir() {
            git_dir = Some(dot);
            break;
        }
        if dot.is_file() {
            let text = std::fs::read_to_string(&dot).unwrap_or_default();
            if let Some(p) = text.trim().strip_prefix("gitdir:") {
                let p = Path::new(p.trim());
                let p = if p.is_absolute() { p.to_path_buf() } else { d.join(p) };
                let common = std::fs::read_to_string(p.join("commondir")).ok();
                git_dir = Some(match common {
                    Some(c) => p.join(c.trim()),
                    None => p,
                });
            }
            break;
        }
        dir = d.parent();
    }
    let Some(git_dir) = git_dir else { return Vec::new() };
    let text = std::fs::read_to_string(git_dir.join("config")).unwrap_or_default();
    let mut out = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        let line = line.trim();
        if let Some(header) = line.strip_prefix('[') {
            let header = header.trim_end_matches(']').trim();
            inside = header
                .split_once(char::is_whitespace)
                .is_some_and(|(sec, sub)| {
                    sec.eq_ignore_ascii_case("remote") && sub.trim().trim_matches('"') == name
                });
        } else if inside {
            if let Some((k, v)) = line.split_once('=') {
                let k = k.trim().to_ascii_lowercase();
                if k == "url" || (push && k == "pushurl") {
                    out.push(v.trim().trim_matches('"').to_string());
                }
            }
        }
    }
    out
}

/// Every remote name configured in the repository's config.
fn configured_remote_names(cwd: &Path) -> Vec<String> {
    let mut dir = Some(cwd);
    while let Some(d) = dir {
        let cfg = d.join(".git").join("config");
        if let Ok(text) = std::fs::read_to_string(cfg) {
            return text
                .lines()
                .filter_map(|l| {
                    let l = l.trim().strip_prefix('[')?.trim_end_matches(']');
                    let (sec, sub) = l.split_once(char::is_whitespace)?;
                    sec.eq_ignore_ascii_case("remote")
                        .then(|| sub.trim().trim_matches('"').to_string())
                })
                .collect();
        }
        dir = d.parent();
    }
    Vec::new()
}

impl GitPlan {
    /// The hosts this call reaches, for the network rules (W10). A URL names
    /// its own host; a remote name is looked up in the repository config; `gh`
    /// talks to GitHub unless `--hostname` or a `HOST/owner/repo` says
    /// otherwise. A name the config does not resolve yields no host, so only
    /// the all-network switch applies to it.
    pub fn net_hosts(&self, cwd: &Path) -> Vec<String> {
        if !self.reaches_remote {
            return Vec::new();
        }
        let mut hosts: Vec<String> = Vec::new();
        let mut add = |h: Option<String>| {
            if let Some(h) = h {
                if !hosts.contains(&h) {
                    hosts.push(h);
                }
            }
        };
        match self.program {
            Program::Gh => {
                fn opt_value<'a>(args: &'a [String], flags: &[&str]) -> Option<&'a str> {
                    args.iter().enumerate().find_map(|(i, a)| {
                        if flags.contains(&a.as_str()) {
                            args.get(i + 1).map(String::as_str)
                        } else {
                            flags
                                .iter()
                                .find_map(|f| a.strip_prefix(format!("{f}=").as_str()))
                        }
                    })
                }
                if let Some(h) = opt_value(&self.args, &["--hostname"]) {
                    add(Some(h.trim().trim_end_matches('.').to_ascii_lowercase()));
                } else if let Some(r) = opt_value(&self.args, &["--repo", "-R"]) {
                    if r.contains("://") || r.contains('@') {
                        add(url_host(r));
                    } else if r.split('/').count() == 3 {
                        add(r.split('/').next().map(|h| h.to_ascii_lowercase()));
                    } else {
                        add(Some("github.com".into()));
                    }
                } else {
                    add(Some("github.com".into()));
                }
            }
            Program::Git => {
                let sub = self.args.first().map(String::as_str).unwrap_or("");
                let push = sub == "push";
                let names = |name: &str, add: &mut dyn FnMut(Option<String>)| {
                    for u in configured_remote_urls(cwd, name, push) {
                        add(url_host(&u));
                    }
                };
                let all = self.args.iter().any(|a| a == "--all" || a == "--multiple")
                    && matches!(sub, "fetch" | "push");
                if all {
                    for n in configured_remote_names(cwd) {
                        names(&n, &mut add);
                    }
                } else {
                    let remote = self.remote.as_deref().unwrap_or("origin");
                    if is_remote_name(remote) {
                        names(remote, &mut add);
                    } else {
                        add(url_host(remote));
                    }
                }
            }
        }
        hosts
    }
}

fn plan_of(program: Program, args: Vec<String>, class: GitClass) -> GitPlan {
    GitPlan {
        program,
        args,
        class,
        destructive: None,
        reaches_remote: false,
        remote: None,
        branch: None,
    }
}

fn git_plan(mut args: Vec<String>) -> Result<GitPlan, String> {
    while args.first().map(String::as_str) == Some("--no-pager") {
        args.remove(0);
    }
    let sub = git_subcommand(&args)?;
    let rest: Vec<String> = args[1..].to_vec();
    deny_common_git(&sub, &rest)?;
    let mut plan = plan_of(Program::Git, args.clone(), GitClass::Local);
    classify_git(&mut plan, &sub, &rest)?;
    Ok(plan)
}

/// The subcommand, refusing `-C` and any other global option before it.
fn git_subcommand(args: &[String]) -> Result<String, String> {
    let Some(sub) = args.first().cloned() else {
        return Err("no git subcommand given (e.g. [\"status\"])".into());
    };
    if sub == "-C" || (sub.starts_with("-C") && sub.len() > 2) {
        let (dir, skip) = if sub == "-C" {
            (args.get(1).cloned().unwrap_or_default(), 2)
        } else {
            (sub[2..].to_string(), 1)
        };
        let rest: Vec<String> = args.iter().skip(skip).cloned().collect();
        return Err(format!(
            "`git -C <dir>` is not supported: pass the folder in the tool's `cwd` parameter and leave -C out of `args`, e.g. {{\"cwd\": {}, \"args\": {}}}",
            serde_json::Value::String(dir),
            serde_json::Value::from(rest)
        ));
    }
    if sub.starts_with('-') {
        return Err(format!(
            "global options before the subcommand (`{sub}`) are not allowed; pass the folder as `cwd` instead of -C, and do not override configuration with -c"
        ));
    }
    Ok(sub)
}

/// One subcommand's classification, by subcommand.
fn classify_git(plan: &mut GitPlan, sub: &str, rest: &[String]) -> Result<(), String> {
    match sub {
        "status" | "log" | "diff" | "show" | "rev-parse" | "ls-files" | "ls-tree" | "blame"
        | "shortlog" | "describe" | "cat-file" | "grep" | "rev-list" | "merge-base"
        | "name-rev" | "show-ref" | "for-each-ref" | "whatchanged" | "count-objects"
        | "check-ignore" | "version" | "diff-tree" | "diff-index" | "diff-files" | "range-diff" => {
            classify_read(plan, sub, rest)
        }
        "merge-tree" => classify_merge_tree(plan, rest),
        "ls-remote" => classify_ls_remote(plan, rest),
        "branch" => classify_branch(plan, rest),
        "tag" => classify_tag(plan, sub, rest),
        "remote" => classify_remote(plan, rest),
        "stash" => classify_stash(plan, rest),
        "config" => classify_config(plan, rest),
        "worktree" => classify_worktree(plan, rest),
        "reflog" => classify_reflog(plan, rest),
        "reset" | "clean" | "checkout" | "switch" | "restore" | "rm" => classify_working_tree(plan, sub, rest),
        "commit" | "notes" | "merge" | "am" | "apply" => check_message_files(sub, rest),
        "add" | "mv" | "rebase" | "cherry-pick" | "revert" | "init" | "sparse-checkout"
        | "update-index" => Ok(()),
        "clone" => classify_clone(plan, rest),
        "fetch" | "pull" => classify_fetch(plan, rest),
        "push" => classify_push(plan, rest),
        other => Err(format!(
            "`git {other}` is not supported by this tool. Supported: status, log, diff, show, merge-tree, branch, tag, remote, stash, add, commit, checkout, switch, restore, merge, rebase, cherry-pick, revert, reset, clean, rm, mv, init, clone, fetch, pull, push, worktree, config (read only)"
        )),
    }
}

/// Read-only subcommands; the diff family also checks its paths.
fn classify_read(plan: &mut GitPlan, sub: &str, rest: &[String]) -> Result<(), String> {
    plan.class = GitClass::Read;
    if matches!(sub, "diff" | "diff-tree" | "diff-index" | "diff-files" | "range-diff") {
        check_diff_paths(&rest)?;
    }
    Ok(())
}

/// `git merge-tree`: only the `--write-tree <base> <head>` shape.
fn classify_merge_tree(plan: &mut GitPlan, rest: &[String]) -> Result<(), String> {
    if rest.len() != 3 || rest[0] != "--write-tree"
        || rest[1].starts_with('-') || rest[2].starts_with('-') {
        return Err("`git merge-tree` requires [\"--write-tree\", \"<base>\", \"<head>\"]".into());
    }
    plan.class = GitClass::Local;
    Ok(())
}

/// `git ls-remote`: reads a remote.
fn classify_ls_remote(plan: &mut GitPlan, rest: &[String]) -> Result<(), String> {
    plan.class = GitClass::Read;
    plan.reaches_remote = true;
    plan.remote = positionals(&rest, &["--upload-pack", "--exec", "-o", "--server-option", "--sort"])
        .first()
        .map(|s| s.to_string());
    if let Some(r) = &plan.remote {
        check_remote_arg(r)?;
    }
    Ok(())
}

/// `git branch`: listing reads; changing, deleting and forcing do not.
fn classify_branch(plan: &mut GitPlan, rest: &[String]) -> Result<(), String> {
    let deleting = has_opt(&rest, &["-d", "--delete", "-D"]);
    let forced = has(&rest, &["-D", "-M", "-C"])
        || (deleting && has_opt(&rest, &["-f", "--force"]));
    let changes = deleting
        || has_opt(
            &rest,
            &[
                "-m", "-M", "--move", "-c", "-C", "--copy", "-u", "--set-upstream-to",
                "--unset-upstream", "--edit-description", "-f", "--force", "-t", "--track",
            ],
        );
    let listing = has_opt(
        &rest,
        &[
            "-l", "--list", "-a", "--all", "-r", "--remotes", "--show-current",
            "--contains", "--no-contains", "--merged", "--no-merged", "--points-at",
        ],
    );
    let values = ["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--format", "--sort", "--color", "--column"];
    if changes {
        plan.class = GitClass::Local;
    } else if listing || positionals(&rest, &values).is_empty() {
        plan.class = GitClass::Read;
    }
    if forced {
        plan.destructive = Some("deletes or overwrites a branch even if its commits are not merged".into());
    }
    plan.branch = positionals(&rest, &values).first().map(|s| s.to_string());
    Ok(())
}

/// `git tag`: listing reads; creating, deleting and moving do not.
fn classify_tag(plan: &mut GitPlan, sub: &str, rest: &[String]) -> Result<(), String> {
    check_message_files(&sub, &rest)?;
    let listing = has_opt(&rest, &["-l", "--list", "--contains", "--points-at", "--merged", "--no-merged", "-n", "-v", "--verify"]);
    let values = ["--contains", "--points-at", "--merged", "--no-merged", "-m", "--message", "-F", "--file", "--sort", "--format"];
    if !has_opt(&rest, &["-d", "--delete", "-a", "-s", "-f", "--force", "-m", "--message"])
        && (listing || positionals(&rest, &values).is_empty())
    {
        plan.class = GitClass::Read;
    }
    if has_opt(&rest, &["-f", "--force"]) {
        plan.destructive = Some("moves an existing tag".into());
    }
    Ok(())
}

/// `git remote`: showing reads; changing checks any URL it names.
fn classify_remote(plan: &mut GitPlan, rest: &[String]) -> Result<(), String> {
    let first = rest.first().map(String::as_str);
    match first {
    None | Some("-v") | Some("--verbose") | Some("show") | Some("get-url") => {
        plan.class = GitClass::Read;
        if first == Some("show") {
            plan.reaches_remote = true;
            plan.remote = positionals(&rest[1..], &[]).first().map(|s| s.to_string());
            if let Some(r) = &plan.remote {
                check_remote_arg(r)?;
            }
        }
    }
    Some("add") | Some("rename") | Some("remove") | Some("rm") | Some("set-url")
    | Some("set-head") | Some("set-branches") | Some("prune") | Some("update") => {
        plan.class = GitClass::Local;
        if let Some(url) = positionals(&rest[1..], &["-t", "-m"]).get(1) {
            if first == Some("add") || first == Some("set-url") {
                check_clone_url(url)?;
            }
        }
    }
    Some(other) => return Err(format!("`git remote {other}` is not supported by this tool")),
    }
    Ok(())
}

/// `git stash`: list and show read; drop and clear lose work.
fn classify_stash(plan: &mut GitPlan, rest: &[String]) -> Result<(), String> {
    let first = rest.first().map(String::as_str);
    match first {
    Some("list") | Some("show") => plan.class = GitClass::Read,
    Some("drop") | Some("clear") => {
        plan.destructive = Some("discards stashed changes".into());
    }
    _ => {}
    }
    Ok(())
}

/// `git config`: reading only, never another file's scope.
fn classify_config(plan: &mut GitPlan, rest: &[String]) -> Result<(), String> {
    let first = rest.first().map(String::as_str);
    if has_opt(&rest, &["--global", "--system", "--file", "-f", "--blob", "--worktree", "--includes"]) {
        return Err("`git config --global/--system/--file` is not allowed; ask the user to change their Git configuration".into());
    }
    let reading = has_opt(
        &rest,
        &["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--get-color", "--get-colorbool"],
    ) || matches!(first, Some("get") | Some("list"))
        || (rest.len() == 1 && !rest[0].starts_with('-'));
    if !reading {
        return Err("changing Git configuration is not allowed through this tool; ask the user to run it".into());
    }
    plan.class = GitClass::Read;
    Ok(())
}

/// `git worktree`: the supported actions; a forced remove loses work.
fn classify_worktree(plan: &mut GitPlan, rest: &[String]) -> Result<(), String> {
    let first = rest.first().map(String::as_str);
    match first {
    Some("list") => plan.class = GitClass::Read,
    Some("remove") if has_opt(&rest, &["-f", "--force"]) => {
        plan.destructive = Some("removes a worktree with uncommitted changes".into());
    }
    Some("add") | Some("remove") | Some("move") | Some("prune") | Some("lock")
    | Some("unlock") | Some("repair") => {}
    _ => return Err("`git worktree` supports list, add, remove, move, prune, lock, unlock, repair".into()),
    }
    Ok(())
}

/// `git reflog`: reading, unless it deletes entries.
fn classify_reflog(plan: &mut GitPlan, rest: &[String]) -> Result<(), String> {
    let first = rest.first().map(String::as_str);
    match first {
    Some("expire") | Some("delete") | Some("drop") => {
        plan.destructive = Some("deletes reflog entries, the record that recovers lost commits".into());
    }
    _ => plan.class = GitClass::Read,
    }
    Ok(())
}

/// Subcommands that can discard uncommitted work: reset, clean, checkout, switch, restore, rm.
fn classify_working_tree(plan: &mut GitPlan, sub: &str, rest: &[String]) -> Result<(), String> {
    match sub {
        "reset" => {
            if has_opt(&rest, &["--hard", "--merge", "--keep"]) {
                plan.destructive = Some("discards uncommitted changes in the working tree".into());
            }
        }
        "clean" => {
            if has_opt(&rest, &["-n", "--dry-run"]) || has_short(&rest, 'n') {
                plan.class = GitClass::Read;
            } else {
                plan.destructive = Some("permanently deletes untracked files".into());
            }
        }
        "checkout" => {
            if has_opt(&rest, &["-f", "--force"]) || has(&rest, &["--", "."]) {
                plan.destructive = Some("overwrites uncommitted changes in the working tree".into());
            }
            plan.branch = positionals(&rest, &["-b", "-B", "--orphan"]).first().map(|s| s.to_string());
            if has(&rest, &["-B"]) {
                plan.destructive = Some("resets an existing branch".into());
            }
        }
        "switch" => {
            if has_opt(&rest, &["-f", "--force", "--discard-changes"]) {
                plan.destructive = Some("discards uncommitted changes".into());
            }
            if has(&rest, &["-C", "--force-create"]) {
                plan.destructive = Some("resets an existing branch".into());
            }
            plan.branch = positionals(&rest, &["-c", "--create", "-C", "--force-create", "--orphan"])
                .first()
                .map(|s| s.to_string());
        }
        "restore" => {
            let staged_only = has_opt(&rest, &["-S", "--staged"]) && !has_opt(&rest, &["-W", "--worktree"]);
            if !staged_only {
                plan.destructive = Some("discards uncommitted changes in the working tree".into());
            }
        }
        "rm" => {
            if has_opt(&rest, &["-f", "--force"]) {
                plan.destructive = Some("removes files with uncommitted changes".into());
            }
        }
        _ => {}
    }
    Ok(())
}

/// `git clone`: reaches the remote it names, which must be a safe URL.
fn classify_clone(plan: &mut GitPlan, rest: &[String]) -> Result<(), String> {
    plan.reaches_remote = true;
    let values = ["-b", "--branch", "--depth", "-o", "--origin", "-j", "--jobs", "--filter", "--shallow-since", "--shallow-exclude", "--bundle-uri"];
    let pos = positionals(&rest, &values);
    let Some(url) = pos.first() else {
        return Err("git clone needs a repository URL".into());
    };
    check_clone_url(url)?;
    plan.remote = Some(url.to_string());
    Ok(())
}

/// `git fetch` / `git pull`: reach the named remote.
fn classify_fetch(plan: &mut GitPlan, rest: &[String]) -> Result<(), String> {
    plan.reaches_remote = true;
    let pos = positionals(&rest, &["--depth", "-j", "--jobs", "-s", "--strategy", "-X", "--strategy-option"]);
    plan.remote = pos.first().map(|s| s.to_string());
    plan.branch = pos.get(1).map(|s| s.to_string());
    if let Some(r) = &plan.remote {
        check_remote_arg(r)?;
    }
    Ok(())
}

/// `git push`: reaches a remote; forcing or deleting there is destructive.
fn classify_push(plan: &mut GitPlan, rest: &[String]) -> Result<(), String> {
    plan.class = GitClass::Remote;
    plan.reaches_remote = true;
    let pos = positionals(&rest, &["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
    // `--repo=<url>` names the destination as a positional would.
    let repo_opt = rest.iter().enumerate().find_map(|(i, a)| match a.as_str() {
        "--repo" => rest.get(i + 1).cloned(),
        _ => a.strip_prefix("--repo=").map(str::to_string),
    });
    plan.remote = repo_opt.or_else(|| pos.first().map(|s| s.to_string()));
    if let Some(r) = &plan.remote {
        check_remote_arg(r)?;
    }
    let refs: Vec<&str> = pos.iter().skip(1).copied().collect();
    if !refs.is_empty() {
        plan.branch = Some(refs.join(" "));
    }
    let force = has_opt(&rest, &["-f", "--force", "--force-with-lease", "--force-if-includes", "--mirror"])
        || refs.iter().any(|r| r.starts_with('+'));
    let deletes = has_opt(&rest, &["-d", "--delete", "--prune"])
        || refs.iter().any(|r| r.starts_with(':'));
    if force {
        plan.destructive = Some("force push: rewrites history on the remote that others may have".into());
    } else if deletes {
        plan.destructive = Some("deletes branches or tags on the remote".into());
    }
    Ok(())
}

/// How gh calls are written, for refusals that should teach the shape.
const GH_SHAPES: &str = "Write gh calls subcommand first, flags with their dashes, each flag and value as separate entries, e.g. [\"pr\", \"create\", \"--repo\", \"owner/repo\", \"--head\", \"my-branch\", \"--base\", \"main\", \"--title\", \"T\", \"--body\", \"B\"] or [\"issue\", \"list\", \"--repo\", \"owner/repo\", \"--json\", \"number,title\"].";

/// `gh -R owner/repo issue list` is a spelling gh itself accepts; move a
/// leading `-R/--repo` behind the subcommand so it is classified like any
/// other call (transcript audit #8) instead of being refused.
fn move_leading_repo(args: Vec<String>) -> Result<Vec<String>, String> {
    let mut lead: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "-R" || a == "--repo" {
            let Some(v) = args.get(i + 1) else {
                return Err(format!("`{a}` needs a repository after it, e.g. [\"{a}\", \"owner/repo\"]. {GH_SHAPES}"));
            };
            lead.push(a.to_string());
            lead.push(v.clone());
            i += 2;
        } else if a.starts_with("--repo=") {
            lead.push(a.to_string());
            i += 1;
        } else {
            break;
        }
    }
    if lead.is_empty() {
        return Ok(args);
    }
    let mut rest: Vec<String> = args[i..].to_vec();
    if rest.is_empty() {
        return Err(format!("no gh command given after `{}`. {GH_SHAPES}", lead.join(" ")));
    }
    let at = if rest.get(1).is_some_and(|s| !s.starts_with('-')) { 2 } else { 1 };
    let tail = rest.split_off(at);
    rest.extend(lead);
    rest.extend(tail);
    Ok(rest)
}

/// The `--json` fields gh accepts for the commands a model reads most, so an
/// invalid field is refused with the valid list instead of gh's bare error.
fn gh_json_fields(group: &str, action: &str) -> Option<&'static [&'static str]> {
    const PR: &[&str] = &[
        "additions", "assignees", "author", "autoMergeRequest", "baseRefName", "baseRefOid",
        "body", "changedFiles", "closed", "closedAt", "closingIssuesReferences", "comments",
        "commits", "createdAt", "deletions", "files", "fullDatabaseId", "headRefName",
        "headRefOid", "headRepository", "headRepositoryOwner", "id", "isCrossRepository",
        "isDraft", "labels", "latestReviews", "maintainerCanModify", "mergeCommit",
        "mergeStateStatus", "mergeable", "mergedAt", "mergedBy", "milestone", "number",
        "potentialMergeCommit", "projectCards", "projectItems", "reactionGroups",
        "reviewDecision", "reviewRequests", "reviews", "state", "statusCheckRollup", "title",
        "updatedAt", "url",
    ];
    const ISSUE: &[&str] = &[
        "assignees", "author", "body", "closed", "closedAt", "closedByPullRequestsReferences",
        "comments", "createdAt", "id", "isPinned", "labels", "milestone", "number",
        "projectCards", "projectItems", "reactionGroups", "state", "stateReason", "title",
        "updatedAt", "url",
    ];
    const RUN_LIST: &[&str] = &[
        "attempt", "conclusion", "createdAt", "databaseId", "displayTitle", "event",
        "headBranch", "headSha", "name", "number", "startedAt", "status", "updatedAt", "url",
        "workflowDatabaseId", "workflowName",
    ];
    const RUN_VIEW: &[&str] = &[
        "attempt", "conclusion", "createdAt", "databaseId", "displayTitle", "event",
        "headBranch", "headSha", "jobs", "name", "number", "startedAt", "status", "updatedAt",
        "url", "workflowDatabaseId", "workflowName",
    ];
    const RELEASE_LIST: &[&str] =
        &["createdAt", "isDraft", "isLatest", "isPrerelease", "name", "publishedAt", "tagName"];
    const CHECKS: &[&str] = &[
        "bucket", "completedAt", "description", "event", "link", "name", "startedAt", "state",
        "workflow",
    ];
    match (group, action) {
        ("pr", "list" | "view") => Some(PR),
        ("issue", "list" | "view") => Some(ISSUE),
        ("run", "list") => Some(RUN_LIST),
        ("run", "view") => Some(RUN_VIEW),
        ("release", "list") => Some(RELEASE_LIST),
        ("pr", "checks") => Some(CHECKS),
        _ => None,
    }
}

/// The gh subcommand that replaces a refused `gh api <endpoint>` call.
fn gh_api_alternative(args: &[String]) -> String {
    let endpoint = args
        .iter()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .map(|a| a.to_ascii_lowercase())
        .unwrap_or_default();
    let has_seg = |seg: &str| endpoint.split(['/', '?']).any(|p| p == seg);
    let alt = if has_seg("pulls") {
        if has_seg("comments") || has_seg("reviews") {
            r#"["pr", "view", "<number>", "--repo", "owner/repo", "--json", "comments,reviews"]"#
        } else if has_seg("files") {
            r#"["pr", "diff", "<number>", "--repo", "owner/repo", "--name-only"]"#
        } else {
            r#"["pr", "list", "--repo", "owner/repo", "--json", "number,title,state"] or ["pr", "view", "<number>", "--repo", "owner/repo", "--json", "<fields>"]"#
        }
    } else if has_seg("issues") {
        r#"["issue", "list", "--repo", "owner/repo", "--json", "number,title,state"] or ["issue", "view", "<number>", "--repo", "owner/repo", "--json", "<fields>"]"#
    } else if has_seg("actions") || has_seg("runs") {
        r#"["run", "list", "--repo", "owner/repo"] or ["run", "view", "<run-id>", "--repo", "owner/repo", "--log-failed"]"#
    } else if has_seg("releases") || has_seg("tags") {
        r#"["release", "list", "--repo", "owner/repo"] or ["release", "view", "<tag>", "--repo", "owner/repo"]"#
    } else if has_seg("search") {
        r#"["search", "issues" | "prs" | "repos" | "code", "<query>"]"#
    } else if has_seg("user") || has_seg("users") || has_seg("orgs") {
        r#"["repo", "list", "<owner>"] (or ["auth", "status"] for the signed-in account)"#
    } else {
        r#"["repo", "view", "owner/repo", "--json", "<fields>"]"#
    };
    format!(
        "`gh api` is not allowed through this tool. Use the matching subcommand instead: {alt}. {GH_SHAPES}"
    )
}

/// Mistakes a model makes in gh's argument shape, named with the fix.
fn check_gh_shape(group: &str, action: &str, args: &[String]) -> Result<(), String> {
    if has(args, &["--web", "-w"]) {
        return Err(format!(
            "`--web` opens a browser you cannot see and returns nothing; drop it (use `--json <fields>` to read). {GH_SHAPES}"
        ));
    }
    if let Some(i) = args.iter().position(|a| a == "--json") {
        let words: Vec<&String> = args[i + 1..]
            .iter()
            .take_while(|a| !a.starts_with('-'))
            .collect();
        let field = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric());
        if words.len() >= 3 && words.iter().all(|w| field(w)) {
            let joined = words.iter().map(|w| w.as_str()).collect::<Vec<_>>().join(",");
            return Err(format!(
                "`--json` takes ONE comma-separated value: [\"--json\", \"{joined}\"], not separate arguments. {GH_SHAPES}"
            ));
        }
        if words.is_empty() {
            return Err(format!("`--json` needs the fields to return, e.g. [\"--json\", \"number,title\"]. {GH_SHAPES}"));
        }
        // `gh repo view` is not checked field by field (its list grows), but
        // the one miss seen in session 8411d403 -- `permission` for "can I
        // push?" -- is named with its real spelling.
        if group == "repo"
            && action == "view"
            && words[0].split(',').map(str::trim).any(|f| f == "permission")
        {
            return Err(format!(
                "`gh repo view --json` has no field `permission` (did you mean `viewerPermission`?). {GH_SHAPES}"
            ));
        }
        if let Some(valid) = gh_json_fields(group, action) {
            let bad: Vec<&str> = words[0]
                .split(',')
                .map(str::trim)
                .filter(|f| !f.is_empty() && !valid.contains(f))
                .collect();
            if !bad.is_empty() {
                // The near miss, named first: `permission` -> `viewerPermission`.
                let hint: Vec<String> = bad
                    .iter()
                    .filter_map(|b| {
                        let mut chars = b.chars();
                        let first = chars.next()?;
                        let viewer = format!("viewer{}{}", first.to_ascii_uppercase(), chars.as_str());
                        valid.contains(&viewer.as_str()).then(|| format!(" (did you mean `{viewer}`?)"))
                    })
                    .collect();
                return Err(format!(
                    "`gh {group} {action} --json` has no field {}{}. Valid fields: {}",
                    bad.iter().map(|b| format!("`{b}`")).collect::<Vec<_>>().join(", "),
                    hint.join(""),
                    valid.join(",")
                ));
            }
        }
    }
    if matches!(group, "pr" | "issue") && action == "create" {
        const VALUE_FLAGS: &[&str] = &[
            "-R", "--repo", "-t", "--title", "-b", "--body", "-F", "--body-file", "-B", "--base",
            "-H", "--head", "-l", "--label", "-a", "--assignee", "-m", "--milestone", "-p",
            "--project", "-r", "--reviewer", "-T", "--template", "--recover",
        ];
        let stray = positionals(&args[2..], VALUE_FLAGS);
        if let Some(first) = stray.first() {
            return Err(format!(
                "`gh {group} create` takes no positional arguments, but got `{first}` -- were the dashes dropped (`--title`, `--body`, `--repo`)? {GH_SHAPES}"
            ));
        }
    }
    Ok(())
}

/// Files gh reads and uploads (`--body-file`, `-F`, `--notes-file`, release
/// assets) are read outside the sandbox, so each must be a relative path that
/// stays inside the folder, like git's message files (O06-017).
fn check_gh_files(group: &str, action: &str, args: &[String]) -> Result<(), String> {
    let rest = args.get(2..).unwrap_or(&[]);
    let mut files: Vec<String> = Vec::new();
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        if a == "--" {
            break;
        }
        match a.as_str() {
            "-F" | "--body-file" | "--notes-file" => files.extend(it.next().cloned()),
            _ => {
                if let Some(v) = a
                    .strip_prefix("--body-file=")
                    .or_else(|| a.strip_prefix("--notes-file="))
                    .or_else(|| a.strip_prefix("-F").filter(|v| !v.is_empty()))
                {
                    files.push(v.to_string());
                }
            }
        }
    }
    if group == "release" && matches!(action, "create" | "upload") {
        // `gh release create|upload <tag> <files>...`; an asset may carry a
        // `#display label`.
        let values = [
            "-F", "--notes-file", "-n", "--notes", "-t", "--title", "--target", "-R", "--repo",
            "--discussion-category", "--notes-start-tag",
        ];
        files.extend(
            positionals(rest, &values)
                .into_iter()
                .skip(1)
                .map(|a| a.split('#').next().unwrap_or(a).to_string()),
        );
    }
    for v in files {
        if escapes_by_spelling(&v) {
            return Err(format!("the file `{v}` must be a relative path inside the folder"));
        }
    }
    Ok(())
}

fn gh_plan(args: Vec<String>) -> Result<GitPlan, String> {
    let args = move_leading_repo(args)?;
    let Some(group) = args.first().cloned() else {
        return Err(format!("no gh command given. {GH_SHAPES}"));
    };
    if group.starts_with('-') {
        return Err(format!(
            "options before the gh command (`{group}`) are not allowed: put the subcommand first. {GH_SHAPES}"
        ));
    }
    if has_opt(&args, &["--show-token", "-t"]) && group == "auth" {
        return Err("`gh auth status --show-token` is not allowed: the token must never reach the transcript".into());
    }
    if group == "api" {
        return Err(gh_api_alternative(&args));
    }
    let action = args.get(1).map(String::as_str).unwrap_or("");
    check_gh_shape(&group, action, &args)?;
    check_gh_files(&group, action, &args)?;
    let mut plan = plan_of(Program::Gh, args.clone(), GitClass::Read);
    plan.reaches_remote = true;
    let destructive = |why: &str| Some(why.to_string());
    match (group.as_str(), action) {
        ("repo", "view" | "list")
        | ("pr", "list" | "view" | "status" | "diff" | "checks")
        | ("issue", "list" | "view" | "status")
        | ("run", "list" | "view")
        | ("release", "list" | "view")
        | ("workflow", "list" | "view")
        | ("auth", "status")
        | ("search", _)
        | ("status", _)
        | ("label", "list") => {}
        ("repo", "clone") | ("pr", "checkout") => plan.class = GitClass::Local,
        ("repo", "create" | "fork" | "edit" | "sync")
        | ("pr", "create" | "merge" | "comment" | "reopen" | "edit" | "review" | "ready" | "lock" | "unlock")
        | ("issue", "create" | "comment" | "close" | "reopen" | "edit" | "lock" | "unlock" | "pin" | "unpin" | "develop")
        | ("release", "create" | "edit" | "upload")
        | ("label", "create" | "edit")
        | ("run", "rerun" | "cancel") => plan.class = GitClass::Remote,
        ("pr", "close") => {
            plan.class = GitClass::Remote;
            if has_opt(&args, &["-d", "--delete-branch"]) {
                plan.destructive = destructive("closes the pull request and deletes its branch");
            }
        }
        ("repo", "delete") => {
            plan.class = GitClass::Remote;
            plan.destructive = destructive("permanently deletes a GitHub repository");
        }
        ("repo", "archive" | "rename" | "unarchive") => {
            plan.class = GitClass::Remote;
            plan.destructive = destructive("changes a GitHub repository's name or availability");
        }
        ("issue", "delete" | "transfer") | ("release", "delete" | "delete-asset") | ("label", "delete") => {
            plan.class = GitClass::Remote;
            plan.destructive = destructive("permanently deletes or moves content on GitHub");
        }
        _ => {
            return Err(format!(
                "`gh {group} {action}` is not supported by this tool. Supported: repo view/list/clone/create/fork, pr list/view/status/diff/checks/checkout/create/merge/comment/close/edit/review/ready, issue list/view/create/comment/close/edit, run list/view, release list/view/create, auth status. `gh api`, `gh auth login`, `gh secret`, `gh config` and extensions are refused. {GH_SHAPES}"
            ))
        }
    }
    if group == "pr" && action == "merge" && has_opt(&args, &["--admin"]) {
        plan.destructive =
            destructive("merges with administrator privileges, bypassing branch protection");
    }
    // The repository a gh call acts on, when it names one.
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "-R" || a == "--repo" {
            plan.remote = it.next().cloned();
        } else if let Some(v) = a.strip_prefix("--repo=") {
            plan.remote = Some(v.to_string());
        }
    }
    if group == "repo" && plan.remote.is_none() {
        plan.remote = args.get(2).filter(|a| !a.starts_with('-')).cloned();
    }
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "-B" || a == "--base" || a == "-H" || a == "--head" {
            let v = it.next().cloned().unwrap_or_default();
            plan.branch = Some(match plan.branch.take() {
                Some(prev) => format!("{prev} {a} {v}"),
                None => format!("{a} {v}"),
            });
        }
    }
    // gh forwards everything after `--` to `git clone`, unchecked
    // (`-c credential.helper=!cmd`, `--separate-git-dir`): refuse it.
    if group == "repo" && matches!(action, "clone" | "fork") {
        if let Some(i) = args.iter().position(|a| a == "--") {
            if action == "clone" || has_opt(&args, &["--clone"]) {
                return Err(format!(
                    "`gh repo {action}` does not accept git flags after `--` ({}); they are passed straight to git clone",
                    args[i + 1..].join(" ")
                ));
            }
        }
    }
    if group == "repo" && action == "clone" {
        if let Some(r) = args.get(2) {
            if r.contains("://") || r.starts_with("git@") {
                check_clone_url(r)?;
            } else if r.starts_with('.') || r.contains('\\') || r.starts_with('/') {
                return Err(format!("`{r}` is not a GitHub repository"));
            }
        }
    }
    Ok(plan)
}

/// Classify a call. `program` is `git` or `gh`; `args` is the argv after it.
pub fn plan(program: &str, args: &[String]) -> Result<GitPlan, String> {
    let mut args = args.to_vec();
    // Models often repeat the program name as the first argument.
    if args.first().map(String::as_str) == Some(program) {
        args.remove(0);
    }
    if args.iter().any(|a| a.contains('\0')) {
        return Err("arguments may not contain NUL characters".into());
    }
    match program {
        "git" => git_plan(args),
        "gh" => gh_plan(args),
        other => Err(format!("program must be `git` or `gh`, not `{other}`")),
    }
}

/// Classify a tool call's JSON arguments: `{program?, args, cwd?}`.
pub fn plan_from_args(v: &Value) -> Result<GitPlan, String> {
    let program = v
        .get("program")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("git");
    let args = match v.get("args") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|i| {
                i.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| "every entry of `args` must be a string".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?,
        // A model often sends the command as one string ("log --oneline -5").
        // Split it the way a shell would, quotes included, rather than refuse
        // and spend a turn; the plan below still checks every argument.
        Some(Value::String(line)) => match split_command_line(line) {
            Some(parts) if !parts.is_empty() => parts,
            _ => {
                return Err("`args` must be an array of separate arguments, e.g. [\"commit\", \"-m\", \"Fix typo\"]; this one string could not be split (unbalanced quotes)".into())
            }
        },
        _ => return Err("`args` (array of strings) is required, e.g. [\"status\"]".into()),
    };
    plan(program, &args)
}

/// Split a command line into arguments: whitespace separates, and single or
/// double quotes group (`\"` is a quote and `\\` a backslash inside double
/// quotes; any other backslash stays literal so Windows paths survive, and a
/// leading `\\` of a UNC path is kept as is). No expansion of any kind.
/// `None` for an unterminated quote.
pub(crate) fn split_command_line(line: &str) -> Option<Vec<String>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' | '"' => {
                in_word = true;
                let start = cur.len();
                loop {
                    match chars.next() {
                        None => return None,
                        Some(q) if q == c => break,
                        Some('\\') if c == '"' && chars.peek() == Some(&'"') => {
                            cur.push('"');
                            chars.next();
                        }
                        // `\\` is one backslash, except at the very start of
                        // the quoted text where it is a UNC prefix.
                        Some('\\')
                            if c == '"' && chars.peek() == Some(&'\\') && cur.len() > start =>
                        {
                            cur.push('\\');
                            chars.next();
                        }
                        Some(other) => cur.push(other),
                    }
                }
            }
            c if c.is_whitespace() => {
                if in_word {
                    out.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            other => {
                in_word = true;
                cur.push(other);
            }
        }
    }
    if in_word {
        out.push(cur);
    }
    Some(out)
}

fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    p
}

pub(crate) fn canon(p: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(p).ok().map(strip_verbatim)
}

/// Canonical form of a path that may not exist yet: its nearest existing
/// ancestor canonicalized, with the missing tail appended. `..` in the tail
/// is refused by returning `None`.
fn canon_new(p: &Path) -> Option<PathBuf> {
    if let Some(c) = canon(p) {
        return Some(c);
    }
    let mut tail = Vec::new();
    let mut cur = p.to_path_buf();
    loop {
        let name = cur.file_name()?.to_os_string();
        tail.push(name);
        cur = cur.parent()?.to_path_buf();
        if let Some(mut base) = canon(&cur) {
            for part in tail.iter().rev() {
                if part == ".." || part == "." {
                    return None;
                }
                base.push(part);
            }
            return Some(base);
        }
    }
}

pub(crate) fn inside(p: &Path, roots: &[PathBuf]) -> bool {
    roots
        .iter()
        .filter_map(|r| canon(r))
        .any(|r| p.starts_with(&r))
}

pub(crate) fn in_jan_dir(p: &Path) -> bool {
    p.components()
        .any(|c| matches!(c, Component::Normal(n) if n == crate::tools::sandbox::JAN_DIR))
}

/// Folders a call may run in.
#[derive(Debug, Clone, Default)]
pub struct Roots {
    /// Folders the user granted write access to: a managed worktree, a
    /// project folder confirmed for direct edits, a `request_access` grant.
    pub granted: Vec<PathBuf>,
    /// The session workspace and its scratch folder.
    pub workspace: Vec<PathBuf>,
    /// Folders attached read-only. Only [`GitClass::Read`] calls run there.
    pub read: Vec<PathBuf>,
}

impl Roots {
    pub fn from_ctx(ctx: &crate::tools::ToolContext<'_>) -> Self {
        let mut workspace = vec![ctx.project_root.to_path_buf()];
        if let Some(s) = ctx.scratch_root {
            workspace.push(s.to_path_buf());
        }
        Roots {
            granted: ctx.write_roots.to_vec(),
            workspace,
            read: ctx.read_roots.to_vec(),
        }
    }

    pub(crate) fn write(&self) -> Vec<PathBuf> {
        self.granted
            .iter()
            .chain(self.workspace.iter())
            .cloned()
            .collect()
    }

    /// Where a call with no `cwd` runs: the granted folder or worktree if
    /// there is one, else the attached folder, else the session workspace.
    pub(crate) fn default_base(&self) -> Option<&PathBuf> {
        self.granted
            .first()
            .or(self.read.first())
            .or(self.workspace.first())
    }
}

/// Whether `plan` writes only to the remote and leaves the folder it runs in
/// as it was: `git push` (at most it records the upstream it pushed to) and
/// the GitHub pull request / issue / release commands. Such a call may run in
/// a folder attached read-only. It is a [`GitClass::Remote`] call, so it is
/// put to the user every time, naming the command, remote and branch; the
/// approval is the permission, and refusing it afterwards for the folder being
/// read-only asked the user a question whose "yes" could never be honoured
/// (session 8411d403: a push approved, then refused as "attached read-only").
/// `gh pr merge` / `gh pr close --delete-branch` (which switch and delete
/// local branches), `gh repo fork` (adds remotes) and `gh repo sync` (moves a
/// local branch) change the folder and are not included.
pub fn publishes_only(plan: &GitPlan) -> bool {
    if plan.class != GitClass::Remote {
        return false;
    }
    let first = plan.args.first().map(String::as_str);
    let second = plan.args.get(1).map(String::as_str).unwrap_or("");
    match (plan.program, first) {
        (Program::Git, Some("push")) => true,
        (Program::Gh, Some("pr")) => {
            !matches!(second, "merge" | "checkout")
                && !(second == "close" && has_opt(&plan.args, &["-d", "--delete-branch"]))
        }
        (Program::Gh, Some("issue" | "release" | "label" | "run")) => true,
        _ => false,
    }
}

/// Resolve and check the working directory for `plan`.
pub fn resolve_cwd(raw: Option<&str>, plan: &GitPlan, roots: &Roots) -> Result<PathBuf, String> {
    // A call that makes a new repository (`clone`, `init`) never needs to run
    // inside an existing one, and the read-only attached folder could not take
    // it anyway: defaulting there refused `git clone <url> <writable dir>` with
    // "attached read-only" although the destination was the session
    // workspace. Such a call defaults to a writable root instead. (`worktree
    // add` is not one: it runs in the repository it branches from.)
    let first = plan.args.first().map(String::as_str);
    let second = plan.args.get(1).map(String::as_str);
    let creates = match plan.program {
        Program::Git => matches!(first, Some("clone" | "init")),
        Program::Gh => first == Some("repo") && second == Some("clone"),
    };
    let base = if creates {
        roots.granted.first().or(roots.workspace.first())
    } else {
        roots.default_base()
    }
    .cloned()
    .ok_or_else(|| "no workspace is available for this run".to_string())?;
    let wanted = match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) if Path::new(p).is_absolute() => PathBuf::from(p),
        Some(p) => base.join(p),
        None => base,
    };
    let cwd = canon(&wanted).ok_or_else(|| format!("`{}` does not exist", wanted.display()))?;
    if !cwd.is_dir() {
        return Err(format!("`{}` is not a folder", cwd.display()));
    }
    if in_jan_dir(&cwd) {
        return Err("the agent's own `.jan` folder is not reachable through git".into());
    }
    if inside(&cwd, &roots.write()) {
        return Ok(cwd);
    }
    if inside(&cwd, &roots.read) {
        if plan.class == GitClass::Read || publishes_only(plan) {
            return Ok(cwd);
        }
        return Err(format!(
            "`{}` is attached read-only, so `{}` cannot run there. Only read-only git commands (status, log, diff, ...), `git push` and GitHub pull request / issue commands work in it; ask the user for write access or a worktree to change it.",
            cwd.display(),
            plan.display()
        ));
    }
    Err(format!(
        "`{}` is outside the project folder, worktree and session workspace; git runs only there",
        cwd.display()
    ))
}

/// A folder a call creates (`clone <url> <dir>`, `init <dir>`,
/// `worktree add <dir>`), checked against the writable roots.
fn created_dir(plan: &GitPlan) -> Option<String> {
    let args = &plan.args;
    match (plan.program, args.first().map(String::as_str)) {
        (Program::Git, Some("clone")) => {
            let values = [
                "-b",
                "--branch",
                "--depth",
                "-o",
                "--origin",
                "-j",
                "--jobs",
                "--filter",
                "--shallow-since",
                "--shallow-exclude",
                "--bundle-uri",
            ];
            positionals(&args[1..], &values)
                .get(1)
                .map(|s| s.to_string())
        }
        (Program::Git, Some("init")) => {
            positionals(&args[1..], &["-b", "--initial-branch", "--object-format"])
                .first()
                .map(|s| s.to_string())
        }
        (Program::Git, Some("worktree")) if args.get(1).map(String::as_str) == Some("add") => {
            positionals(&args[2..], &["-b", "-B", "--reason"])
                .first()
                .map(|s| s.to_string())
        }
        (Program::Gh, Some("repo")) if args.get(1).map(String::as_str) == Some("clone") => {
            positionals(&args[2..], &["-u", "--upstream-remote-name"])
                .get(1)
                .map(|s| s.to_string())
        }
        _ => None,
    }
}

/// A destination that is a direct sibling of a folder the user granted write
/// access to: where `git worktree add ../name` puts a worktree by convention.
/// Allowed, and then added to the session's grant, so the folder the agent just
/// made is one it can read, write and run git in.
fn beside_granted(dest: &Path, roots: &Roots) -> bool {
    let Some(parent) = dest.parent() else {
        return false;
    };
    roots
        .granted
        .iter()
        .filter_map(|g| canon(g))
        .any(|g| g.parent() == Some(parent) && g != dest)
}

/// The absolute destination of a call that creates a folder, if it names one.
fn created_path(plan: &GitPlan, cwd: &Path) -> Option<PathBuf> {
    let dir = created_dir(plan)?;
    let target = if Path::new(&dir).is_absolute() {
        PathBuf::from(&dir)
    } else {
        cwd.join(&dir)
    };
    canon_new(&target)
}

/// Every positional of a creating call besides the URL. An option git takes
/// with a separate value that `created_dir` does not know (`init --ref-format
/// files /outside`) shifts which positional is the destination, so each one
/// that could name a folder elsewhere is checked too (F5x2-019).
fn creating_positionals(plan: &GitPlan) -> Vec<String> {
    let args = &plan.args;
    let (rest, skip) = match (plan.program, args.first().map(String::as_str)) {
        (Program::Git, Some("clone")) => (&args[1..], 1),
        (Program::Git, Some("init")) => (&args[1..], 0),
        (Program::Git, Some("worktree")) if args.get(1).map(String::as_str) == Some("add") => (&args[2..], 0),
        (Program::Gh, Some("repo")) if args.get(1).map(String::as_str) == Some("clone") => (&args[2..], 1),
        _ => return Vec::new(),
    };
    positionals(rest, &[]).into_iter().skip(skip).map(str::to_string).collect()
}

pub fn check_created_dir(plan: &GitPlan, cwd: &Path, roots: &Roots) -> Result<(), String> {
    check_destination(plan, cwd, roots)?;
    let dest = created_dir(plan);
    for other in creating_positionals(plan) {
        if dest.as_deref() == Some(other.as_str()) {
            continue;
        }
        // A plain relative name stays under the checked working folder; only a
        // spelling that can leave it is resolved.
        if !escapes_by_spelling(&other) {
            continue;
        }
        let target = if Path::new(&other).is_absolute() { PathBuf::from(&other) } else { cwd.join(&other) };
        let ok = canon_new(&target)
            .is_some_and(|r| !in_jan_dir(&r) && (inside(&r, &roots.write()) || beside_granted(&r, roots)));
        if !ok {
            return Err(format!(
                "`{other}` names a folder outside the folders this run may write to; pick a destination inside them"
            ));
        }
    }
    Ok(())
}

fn check_destination(plan: &GitPlan, cwd: &Path, roots: &Roots) -> Result<(), String> {
    let Some(dir) = created_dir(plan) else {
        return Ok(());
    };
    let resolved =
        created_path(plan, cwd).ok_or_else(|| format!("`{dir}` is not a usable destination"))?;
    if in_jan_dir(&resolved) || !(inside(&resolved, &roots.write()) || beside_granted(&resolved, roots)) {
        // Said with where it resolved and where it may go: a bare "outside the
        // folders" sent a model to ask for access to the wrong folder.
        let granted: Vec<String> = roots
            .granted
            .iter()
            .map(|r| format!("`{}`", crate::tools::sandbox::plain_display(r)))
            .collect();
        let allowed = if granted.is_empty() {
            "none beyond the session workspace; the attached project folder is read-only, so ask the user to attach it with worktree or edit access"
                .to_string()
        } else {
            format!("{}, or the session workspace", granted.join(", "))
        };
        return Err(format!(
            "`{dir}` resolves to `{}`, outside the folders this run may write to ({allowed}). Pick a destination inside one of them, or ask the user to attach the project with worktree access.",
            crate::tools::sandbox::plain_display(&resolved)
        ));
    }
    Ok(())
}

/// Locate `gh` without relying only on the shell's PATH.
pub fn discover_gh() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(p) = crate::tools::git_native::on_path("gh.exe") {
            return Some(p);
        }
        for known in [
            r"C:\Program Files\GitHub CLI\gh.exe",
            r"C:\Program Files (x86)\GitHub CLI\gh.exe",
        ] {
            if Path::new(known).is_file() {
                return Some(PathBuf::from(known));
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        crate::tools::git_native::on_path("gh")
    }
}

fn cap(text: String) -> String {
    if text.len() <= OUTPUT_CAP {
        return text;
    }
    let mut end = OUTPUT_CAP;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n[output truncated: {} of {} bytes shown]",
        &text[..end],
        end,
        text.len()
    )
}

/// Configuration forced on every call, whatever the repository says.
pub const CONFIG_OVERRIDES: &[(&str, &str)] = &[
    ("protocol.ext.allow", "never"),
    ("protocol.file.allow", "never"),
    ("diff.external", ""),
    ("core.hooksPath", "/dev/null"),
    ("core.fsmonitor", "false"),
    ("core.pager", "cat"),
    // A repository must not turn certificate checks off for pushes that carry
    // the user's GitHub login.
    ("http.sslVerify", "true"),
];

/// The argv actually run: the plan's, plus `--no-ext-diff --no-textconv`
/// after the options of a diff-producing subcommand, so no diff driver runs.
pub fn argv_for(plan: &GitPlan) -> Vec<String> {
    let mut argv = plan.args.clone();
    if plan.program == Program::Git
        && matches!(
            argv.first().map(String::as_str),
            Some("diff" | "log" | "show")
        )
    {
        // After the model's own options so its `--textconv` cannot win (the
        // last one given does), and before `--` where options end.
        let at = argv.iter().position(|a| a == "--").unwrap_or(argv.len());
        argv.splice(at..at, ["--no-ext-diff".to_string(), "--no-textconv".to_string()]);
    }
    argv
}

/// Why a repository-local configuration entry must stop the call, if it must.
///
/// Each of these makes git (or gh, which runs git) start a program or load a
/// file the repository names, outside the sandbox: a planted
/// `core.sshCommand` or `filter.*.smudge` is code execution on the next push
/// or checkout.
pub fn risky_config(key: &str, value: &str) -> Option<String> {
    let k = key.to_ascii_lowercase();
    let v = value.trim();
    let parts: Vec<&str> = k.split('.').collect();
    let section = parts[0];
    let last = *parts.last().unwrap_or(&"");
    let sub = parts.len() >= 3;
    let why = |what: &str| Some(format!("`{key}` {what}"));
    match k.as_str() {
        "core.sshcommand" | "core.gitproxy" | "core.pager" | "core.editor" | "core.askpass"
        | "diff.external" | "sequence.editor" | "gpg.program" | "include.path" => {
            return why("names a program or file git would run or load");
        }
        "core.fsmonitor" => {
            let builtin = matches!(
                v.to_ascii_lowercase().as_str(),
                "" | "false" | "true" | "0" | "1"
            );
            return (!builtin).then(|| format!("`{key}` names a program git would run"));
        }
        "core.hookspath" => {
            return (!v.is_empty()).then(|| format!("`{key}` points git at hook scripts"));
        }
        "protocol.ext.allow" => return why("enables the ext:: transport, which runs commands"),
        _ => {}
    }
    let runs = matches!(
        (section, last),
        ("diff", "command" | "textconv")
            | ("merge", "driver")
            | ("filter", "clean" | "smudge" | "process")
            | ("gpg", "program")
            | ("includeif", "path")
    );
    if runs && sub {
        return why("names a program or file git would run or load");
    }
    if section == "url" && sub && matches!(last, "insteadof" | "pushinsteadof") {
        // The rewritten prefix is the subsection: url.<base>.insteadOf.
        let base = k[4..k.len() - last.len() - 1].to_string();
        if ["ext::", "file:", "fd::"]
            .iter()
            .any(|p| base.starts_with(p))
        {
            return why("rewrites remotes to a transport that runs commands or reads local files");
        }
        // Anything else that is not GitHub could send the login to another host.
        if !["https://github.com/", "git@github.com:", "ssh://git@github.com/"]
            .iter()
            .any(|p| base.starts_with(p))
        {
            return why("rewrites remotes to a host other than GitHub");
        }
    }
    // Proxy and TLS settings let a repository intercept the token a push carries.
    if section == "http"
        && !matches!(last, "postbuffer" | "version" | "lowspeedlimit" | "lowspeedtime" | "maxrequests")
    {
        return why("redirects or weakens the network connection git uses");
    }
    if section == "remote" && sub && matches!(last, "proxy" | "proxyauthmethod") {
        return why("routes this remote through a proxy the repository chose");
    }
    if section == "credential" && last == "helper" {
        let program = v.starts_with('!') || v.contains('/') || v.contains('\\');
        if program {
            return why("runs a credential program the repository chose");
        }
    }
    None
}

/// Parse `git config --list --show-scope -z` output into (scope, key, value).
pub fn parse_scoped_config(raw: &[u8]) -> Vec<(String, String, String)> {
    // With `-z`, each entry is `<scope>\0<key>\n<value>\0`.
    let text = String::from_utf8_lossy(raw);
    let fields: Vec<&str> = text.split('\0').collect();
    fields
        .chunks(2)
        .filter(|pair| pair.len() == 2 && !pair[0].is_empty())
        .map(|pair| {
            let (key, value) = pair[1].split_once('\n').unwrap_or((pair[1], ""));
            (pair[0].to_string(), key.to_string(), value.to_string())
        })
        .collect()
}

/// Refuse a call in a repository whose own configuration (local or worktree
/// scope) would make git run a program. Read with the same host git, before
/// the call, with includes off so an include cannot hide a key (an include is
/// itself refused).
pub async fn check_repo_config(cwd: &Path) -> Result<(), String> {
    let Some(git) = crate::tools::git_native::discover_git() else {
        return Ok(());
    };
    let mut cmd = tokio::process::Command::new(&git);
    jan_process::HostProcessEnv::host_env(&mut cmd);
    cmd.args(["config", "--list", "--show-scope", "--no-includes", "-z"])
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_CONFIG_COUNT")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let out = match crate::tools::owned::output_with_timeout(&mut cmd, Duration::from_secs(30)).await {
        Ok(Ok(out)) => out,
        _ => return Err("could not read this repository's Git configuration".into()),
    };
    let found: Vec<String> = parse_scoped_config(&out.stdout)
        .into_iter()
        .filter(|(scope, _, _)| scope == "local" || scope == "worktree")
        .filter_map(|(_, k, v)| risky_config(&k, &v))
        .collect();
    if found.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "this repository's own Git configuration would make git run programs outside the sandbox, so nothing was run: {}. Ask the user to review and remove it (in .git/config) before continuing.",
            found.join("; ")
        ))
    }
}

/// The host of an `https://` remote URL, lower-cased, without user info or
/// port. `None` for ssh and anything else: those authenticate with keys, not
/// with a credential helper.
pub fn https_host(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("https://").or_else(|| {
        let t = url.trim();
        t.get(..8)
            .filter(|p| p.eq_ignore_ascii_case("https://"))
            .map(|_| &t[8..])
    })?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// The account `gh auth status --hostname <host>` reports as logged in.
/// Current gh says "Logged in to github.com account NAME (keyring)", older
/// releases "Logged in to github.com as NAME (...)".
pub fn gh_account(status: &str, host: &str) -> Option<String> {
    let host = host.to_ascii_lowercase();
    status.lines().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        let at = lower.find("logged in to ")?;
        let after = &line[at + "logged in to ".len()..];
        let mut words = after.split_whitespace();
        if words.next()?.to_ascii_lowercase() != host {
            return None;
        }
        match words.next()? {
            "account" | "as" => words
                .next()
                .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_'))
                .filter(|w| !w.is_empty())
                .map(str::to_string),
            _ => None,
        }
    })
}

/// A credential-helper value that makes git ask `gh` for the login, the same
/// shape `gh auth setup-git` writes. Forward slashes and single quotes, since
/// git runs it through its own shell.
pub fn gh_credential_helper(gh: &Path) -> String {
    let path = gh.to_string_lossy().replace('\\', "/");
    format!("!'{path}' auth git-credential")
}

/// A remote URL as shown to the model: any `user:password@` part removed.
pub fn without_userinfo(url: &str) -> String {
    if let Some((scheme, rest)) = url.split_once("://") {
        let (authority, path) = match rest.find('/') {
            Some(i) => rest.split_at(i),
            None => (rest, ""),
        };
        let host = authority.rsplit('@').next().unwrap_or(authority);
        return crate::secrets::redact_secrets(&format!("{scheme}://{host}{path}"));
    }
    crate::secrets::redact_secrets(url)
}

/// Whether git's output says the remote refused the login or the account.
pub fn auth_refused(output: &str) -> bool {
    let l = output.to_ascii_lowercase();
    [
        "returned error: 403",
        "returned error: 401",
        "write access to repository not granted",
        "permission to ",
        "authentication failed",
        "could not read username",
        "invalid username or password",
    ]
    .iter()
    .any(|m| l.contains(m))
}

/// Who a git network call authenticated as, for the approval and for a
/// refusal the user has to act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitIdentity {
    /// The GitHub CLI login, handed to git as its credential helper.
    Gh { account: String, host: String },
    /// git's own credential helper(s), as configured (names only).
    Helper { helpers: Vec<String>, host: Option<String> },
}

impl GitIdentity {
    /// What to tell the model when the remote refused the call.
    pub fn refusal_note(&self, url: Option<&str>) -> String {
        let target = url.map(|u| format!(" to `{u}`")).unwrap_or_default();
        let fix = "Nothing was pushed. Tell the user; do not retry the same call. Ways forward: the repository owner grants this account write access; or push to a fork of the repository (`gh repo fork`, push the branch there, then `gh pr create --head <owner>:<branch>`); or the user pushes it themselves.";
        match self {
            GitIdentity::Gh { account, host } => format!(
                "Flint authenticated as the GitHub CLI account `{account}` on {host} (`gh auth git-credential`), and the remote refused that account{target}: it has no write access there. {fix}"
            ),
            GitIdentity::Helper { helpers, host } => {
                let used = if helpers.is_empty() {
                    "no credential helper is configured".to_string()
                } else {
                    format!("git's own credential helper (`{}`) was used", helpers.join("`, `"))
                };
                let gh = match host {
                    Some(h) => format!(" The GitHub CLI is not installed or not logged in for {h}, so its login was not used; `gh auth login` would let Flint push with it."),
                    None => String::new(),
                };
                format!("The remote refused the login{target}: {used}, not a GitHub CLI login.{gh} {fix}")
            }
        }
    }
}

/// Run a short helper command and return its stdout and stderr, or `None`
/// when it did not start, timed out or failed.
async fn quiet_output(bin: &Path, args: &[&str], cwd: &Path) -> Option<String> {
    let mut cmd = tokio::process::Command::new(bin);
    jan_process::HostProcessEnv::host_env(&mut cmd);
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let out = crate::tools::owned::output_with_timeout(&mut cmd, Duration::from_secs(20))
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Some(text)
}

/// The URL a git network call talks to: the remote named in it (or `origin`),
/// resolved with `git remote get-url`, or the URL itself when it names one.
async fn remote_url_of(git: &Path, plan: &GitPlan, cwd: &Path) -> Option<String> {
    let named = plan.remote.as_deref().unwrap_or("origin");
    if named.contains("://") || named.starts_with("git@") {
        return Some(named.to_string());
    }
    let push = plan.args.first().map(String::as_str) == Some("push");
    let args: Vec<&str> = if push {
        vec!["remote", "get-url", "--push", named]
    } else {
        vec!["remote", "get-url", named]
    };
    quiet_output(git, &args, cwd)
        .await
        .and_then(|o| o.lines().next().map(|l| l.trim().to_string()))
        .filter(|l| !l.is_empty())
}

fn pr_flag(args: &[String], long: &str, short: &str) -> Option<String> {
    args.iter().enumerate().find_map(|(i, arg)| {
        if arg == long || arg == short {
            args.get(i + 1).cloned()
        } else {
            arg.strip_prefix(&format!("{long}=")).map(str::to_string)
        }
    })
}

/// How many times `long`/`short` (or `long=value`) appear. `gh` honours the
/// LAST one while `pr_flag` reads the first, so a repeat would verify one
/// target and open the PR against another.
fn pr_flag_count(args: &[String], long: &str, short: &str) -> usize {
    let prefix = format!("{long}=");
    args.iter()
        .filter(|arg| *arg == long || *arg == short || arg.starts_with(&prefix))
        .count()
}

fn pr_preflight_target(args: &[String]) -> Result<(String, String, String, String), String> {
    let required = || "include explicit --repo owner/repo, --base branch and --head branch so Flint can verify the proposed pull request before opening it".to_string();
    for (long, short) in [("--repo", "-R"), ("--base", "-B"), ("--head", "-H")] {
        if pr_flag_count(args, long, short) > 1 {
            return Err(format!("pass {long} only once so the verified target is the one used"));
        }
    }
    let repo = pr_flag(args, "--repo", "-R").ok_or_else(required)?;
    let base = pr_flag(args, "--base", "-B").ok_or_else(required)?;
    let head = pr_flag(args, "--head", "-H").ok_or_else(required)?;
    let parts: Vec<&str> = repo.split('/').collect();
    if !(parts.len() == 2 || parts.len() == 3)
        || parts.iter().any(|p| p.is_empty() || *p == "." || *p == ".."
            || !p.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)))
    {
        return Err("--repo must name owner/repo or host/owner/repo".into());
    }
    // `#`, `@` and `+` are legal in ref names (`fix/issue#12`). Still refused:
    // a leading `-` (flag injection), `..`, `@{`, spaces, control characters,
    // backslash and `~^:?*[`: none of those are in the allowed set.
    let valid_branch = |name: &str| !name.is_empty() && !name.contains("..")
        && name != "@"
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "._/-#@+".contains(c));
    let (head_owner, head_branch) = head.split_once(':')
        .map_or((parts[parts.len() - 2], head.as_str()), |(owner, branch)| (owner, branch));
    if !valid_branch(&base) || !valid_branch(head_branch) || head_owner.is_empty()
        || !head_owner.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        return Err("--base and --head must name ordinary branch refs: letters, digits and . _ / - # @ + only, no '..', no leading '-'".into());
    }
    let host = if parts.len() == 3 { parts[0] } else { "github.com" };
    let base_url = format!("https://{host}/{}/{}.git", parts[parts.len() - 2], parts[parts.len() - 1]);
    let head_url = format!("https://{host}/{head_owner}/{}.git", parts[parts.len() - 1]);
    Ok((base_url, base, head_url, head_branch.to_string()))
}

fn sha_in(output: &str) -> Option<String> {
    output.lines().filter_map(|line| line.split_whitespace().next()).find(|word|
        word.len() == 40 && word.chars().all(|c| c.is_ascii_hexdigit())
    ).map(str::to_string)
}

fn remote_identity(url: &str) -> Option<(&str, &str)> {
    let url = url.trim();
    let (host, path) = if let Some(rest) = url.strip_prefix("https://") {
        rest.split_once('/')?
    } else {
        let rest = url.strip_prefix("git@")?;
        rest.split_once(':')?
    };
    let host = host.rsplit('@').next()?;
    let path = path.trim_end_matches(".git");
    let (owner, repo) = path.split_once('/')?;
    (!host.is_empty() && !owner.is_empty() && !repo.is_empty() && !repo.contains('/'))
        .then_some((host, owner))
}

fn matching_head_urls(remotes: Vec<String>, expected_url: &str) -> Result<Vec<String>, String> {
    let expected = remote_identity(expected_url).ok_or("invalid pull request head repository")?;
    let mut urls = Vec::new();
    for url in remotes {
        if remote_identity(&url).is_some_and(|id| id.0.eq_ignore_ascii_case(expected.0)
            && id.1.eq_ignore_ascii_case(expected.1)) && !urls.contains(&url) {
            urls.push(url);
        }
    }
    if !urls.iter().any(|url| url == expected_url) {
        urls.push(expected_url.to_string());
    }
    Ok(urls)
}

async fn pushed_head(
    git: &Path,
    cwd: &Path,
    expected_url: &str,
    branch: &str,
) -> Result<(String, String), String> {
    let mut remotes_urls = Vec::new();
    if let Some(remotes) = quiet_output(git, &["remote"], cwd).await {
        for name in remotes.lines().map(str::trim).filter(|n| !n.is_empty()) {
            if let Some(url) = quiet_output(git, &["remote", "get-url", "--push", name], cwd)
                .await.and_then(|o| o.lines().next().map(str::trim).map(str::to_string))
            {
                remotes_urls.push(url);
            }
        }
    }
    let urls = matching_head_urls(remotes_urls, expected_url)?;
    for url in &urls {
        let plan = self::plan("git", &["ls-remote".into(), url.clone(), format!("refs/heads/{branch}")])?;
        let output = Box::pin(execute(&plan, cwd)).await;
        if let Some(sha) = sha_in(&output) {
            return Ok((url.clone(), sha));
        }
    }
    let owner = remote_identity(expected_url).map(|id| id.1).unwrap_or("");
    Err(format!("could not read pushed head {branch} from any push remote owned by {owner} (checked {} candidate repositories); push the branch first", urls.len()))
}

async fn pr_preflight(plan: &GitPlan, cwd: &Path) -> Result<(), String> {
    let (base_url, base, head_url, head) = pr_preflight_target(&plan.args)?;
    let git = crate::tools::git_native::discover_git().ok_or("Git is needed to check pull request conflicts")?;
    let remote_sha = |url: &str, branch: &str| -> Result<GitPlan, String> {
        self::plan("git", &["ls-remote".into(), url.into(), format!("refs/heads/{branch}")])
    };
    let base_remote = Box::pin(execute(&remote_sha(&base_url, &base)?, cwd)).await;
    let base_sha = sha_in(&base_remote).ok_or_else(|| format!("could not read current base {base} from {base_url}: {base_remote}"))?;
    let (_, head_sha) = pushed_head(&git, cwd, &head_url, &head).await?;
    let local_head = quiet_output(&git, &["rev-parse", "--verify", &format!("{head}^{{commit}}")], cwd)
        .await.and_then(|o| sha_in(&o));
    if local_head.as_deref() != Some(head_sha.as_str()) {
        return Err(format!("pushed head {head} differs from local branch; push the intended commit before opening the pull request"));
    }
    let local_base = quiet_output(&git, &["rev-parse", "--verify", "FETCH_HEAD^{commit}"], cwd)
        .await.and_then(|o| sha_in(&o));
    let tracking_base = quiet_output(&git, &["rev-parse", "--verify", &format!("refs/remotes/origin/{base}^{{commit}}")], cwd)
        .await.and_then(|o| sha_in(&o));
    if local_base.as_deref() != Some(base_sha.as_str())
        && tracking_base.as_deref() != Some(base_sha.as_str()) {
        return Err(format!("base {base} has moved; fetch the target repository's current base branch before opening the pull request"));
    }
    let merge = self::plan("git", &["merge-tree".into(), "--write-tree".into(), base_sha, head_sha])?;
    let checked = Box::pin(execute(&merge, cwd)).await;
    if checked.starts_with("ERROR:") {
        return Err(format!("the proposed pull request does not merge cleanly, or its merge could not be verified: {checked}"));
    }
    Ok(())
}

/// Run a planned call in `cwd`. Returns the tool result text; a failure starts
/// with `ERROR:`.
pub async fn execute(plan: &GitPlan, cwd: &Path) -> String {
    if plan.program == Program::Gh && plan.args.first().map(String::as_str) == Some("pr")
        && plan.args.get(1).map(String::as_str) == Some("create") {
        if let Err(reason) = pr_preflight(plan, cwd).await {
            return format!("ERROR: pull request not opened: {reason}");
        }
    }
    let bin = match plan.program {
        Program::Git => crate::tools::git_native::discover_git(),
        Program::Gh => discover_gh(),
    };
    let Some(bin) = bin else {
        return match plan.program {
            Program::Git => "ERROR: Git is not installed on this machine. Ask the user to install Git for Windows (or git) and try again.".into(),
            Program::Gh => "ERROR: The GitHub CLI (`gh`) is not installed on this machine. Ask the user to install it and run `gh auth login` themselves, or use `git push` and let them open the pull request.".into(),
        };
    };
    let mut cmd = tokio::process::Command::new(&bin);
    jan_process::HostProcessEnv::host_env(&mut cmd);
    harden_git(&mut cmd, plan);
    let (identity, url) = network_identity(&mut cmd, &bin, plan, cwd).await;
    cmd.args(argv_for(plan));
    isolate_env(&mut cmd, cwd);
    let secs = if plan.reaches_remote {
        REMOTE_TIMEOUT_SECS
    } else {
        LOCAL_TIMEOUT_SECS
    };
    let shown = crate::secrets::redact_secrets(&plan.display());
    let out = match crate::tools::owned::output_with_timeout(&mut cmd, Duration::from_secs(secs)).await {
        Err(_) => return format!("ERROR: `{shown}` timed out after {secs}s and was stopped"),
        Ok(Err(e)) => return format!("ERROR: could not start {}: {e}", plan.program.as_str()),
        Ok(Ok(out)) => out,
    };
    render_output(&shown, &out, identity.as_ref(), url.as_deref())
}

/// Nothing the repository's own files can name runs: no hooks, fsmonitor,
/// pager or editor, and no inherited merge driver for the conflict probe.
fn harden_git(cmd: &mut tokio::process::Command, plan: &GitPlan) {
    if plan.program == Program::Git && plan.args.first().map(String::as_str) == Some("merge-tree") {
        // Repository attributes may name a merge driver. Local drivers are
        // refused by check_repo_config; do not inherit one from user or system
        // configuration for this conflict probe either.
        cmd.env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null");
    }
    if plan.program == Program::Git {
        // Nothing the repository's own files can name runs: no hooks (a hook
        // is a script any tool that can write the worktree could plant), no
        // fsmonitor, no pager, no editor.
        cmd.args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.pager=cat",
        ]);
    }
}

/// For a network git call to an https remote, the identity it authenticates
/// with (and the `-c` that names it), plus the remote's URL.
async fn network_identity(
    cmd: &mut tokio::process::Command,
    bin: &Path,
    plan: &GitPlan,
    cwd: &Path,
) -> (Option<GitIdentity>, Option<String>) {
    // A git call that talks to an https remote authenticates with the GitHub
    // CLI login when gh is logged in for that host: that is the identity the
    // user connected, and git's own helper can hold a different (or stale)
    // account -- in session 8411d403 an approved push was refused with 403
    // while gh was logged in with repo scope. Only for the network
    // subcommands, and only a helper Flint names on the command line.
    let mut identity: Option<GitIdentity> = None;
    let mut url: Option<String> = None;
    let network = plan.program == Program::Git
        && matches!(
            plan.args.first().map(String::as_str),
            Some("push" | "fetch" | "pull" | "ls-remote" | "clone")
        );
    if network {
        url = remote_url_of(&bin, plan, cwd).await;
        if let Some(host) = url.as_deref().and_then(https_host) {
            let gh = discover_gh();
            let account = match gh.as_deref() {
                Some(gh) => quiet_output(gh, &["auth", "status", "--hostname", &host], cwd)
                    .await
                    .and_then(|s| gh_account(&s, &host)),
                None => None,
            };
            match (gh, account) {
                (Some(gh), Some(account)) => {
                    cmd.args([
                        "-c".to_string(),
                        "credential.helper=".to_string(),
                        "-c".to_string(),
                        format!("credential.helper={}", gh_credential_helper(&gh)),
                    ]);
                    identity = Some(GitIdentity::Gh { account, host });
                }
                _ => {
                    let helpers = quiet_output(&bin, &["config", "--get-all", "credential.helper"], cwd)
                        .await
                        .map(|o| {
                            o.lines()
                                .map(str::trim)
                                .filter(|l| !l.is_empty())
                                .map(crate::secrets::redact_secrets)
                                .collect()
                        })
                        .unwrap_or_default();
                    identity = Some(GitIdentity::Helper { helpers, host: Some(host) });
                }
            }
        }
    }
    (identity, url)
}

/// The child's working folder and an environment no prompt, pager, editor
/// or inherited repository variable can reach.
fn isolate_env(cmd: &mut tokio::process::Command, cwd: &Path) {
    cmd.current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat")
        .env("GIT_EDITOR", ":")
        .env("GIT_SEQUENCE_EDITOR", ":")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_CONFIG_COUNT")
        .env_remove("GIT_EXEC_PATH")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    // Per-call overrides at "command" scope, above anything a repository sets
    // (gh passes them on to the git it runs). `core.sshCommand` is left alone
    // so ssh remotes keep working; a repository that sets it is refused by
    // `check_repo_config` instead.
    cmd.env("GIT_CONFIG_COUNT", CONFIG_OVERRIDES.len().to_string());
    for (i, (k, v)) in CONFIG_OVERRIDES.iter().enumerate() {
        cmd.env(format!("GIT_CONFIG_KEY_{i}"), k)
            .env(format!("GIT_CONFIG_VALUE_{i}"), v);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
}

/// What the model is shown for a finished call: the command and its output,
/// redacted and capped, with a note naming the identity when an
/// authentication refusal is the reason it failed.
fn render_output(
    shown: &str,
    out: &std::process::Output,
    identity: Option<&GitIdentity>,
    url: Option<&str>,
) -> String {
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&err);
    }
    let body = cap(crate::secrets::redact_secrets(text.trim_end()));
    let code = out.status.code().unwrap_or(-1);
    if out.status.success() {
        if body.is_empty() {
            format!("$ {shown}\n(exit 0, no output)")
        } else {
            format!("$ {shown}\n{body}")
        }
    } else if code == 1 && body.is_empty() && is_query_command(shown) {
        // Exit 1 with no output from a lookup is git's "nothing matched"
        // (RQA-001): reporting it as an ERROR made a run list a missing
        // `user.*` config as an unresolved failure.
        format!("$ {shown}\n(exit 1, no match: nothing was found; this is not an error)")
    } else {
        let note = match identity {
            Some(id) if auth_refused(&body) => {
                let shown_url = url.map(without_userinfo);
                format!("\n{}", id.refusal_note(shown_url.as_deref()))
            }
            _ => String::new(),
        };
        format!("ERROR: `{shown}` exited with {code}\n{body}{note}")
    }
}

/// Whether `shown` is a git lookup whose exit 1 means "no match" rather than
/// a failure: `config --get*`, `grep`, `diff --quiet/--exit-code`,
/// `merge-base --is-ancestor`, `rev-parse --verify --quiet`, `show-ref`.
fn is_query_command(shown: &str) -> bool {
    let words: Vec<&str> = shown.split_whitespace().collect();
    let Some(pos) = words.iter().position(|w| w.ends_with("git") || w.ends_with("git.exe")) else {
        return false;
    };
    let rest = &words[pos + 1..];
    // Skip global options such as `-C dir` or `-c k=v` before the subcommand.
    let mut i = 0;
    while i < rest.len() && rest[i].starts_with('-') {
        i += if matches!(rest[i], "-C" | "-c") { 2 } else { 1 };
    }
    let Some(sub) = rest.get(i) else { return false };
    let flags = &rest[i + 1..];
    let has = |f: &str| flags.contains(&f);
    match *sub {
        "config" => flags.iter().any(|w| w.starts_with("--get")),
        "grep" | "show-ref" => true,
        "diff" => has("--quiet") || has("--exit-code"),
        "merge-base" => has("--is-ancestor"),
        "rev-parse" => has("--verify") && (has("--quiet") || has("-q")),
        _ => false,
    }
}

/// The `git` tool handler.
pub async fn run(args: &Value, ctx: &crate::tools::ToolContext<'_>) -> String {
    let plan = match plan_from_args(args) {
        Ok(p) => p,
        Err(e) => return format!("ERROR: git: {e}"),
    };
    let roots = Roots::from_ctx(ctx);
    let cwd = match resolve_cwd(args.get("cwd").and_then(Value::as_str), &plan, &roots) {
        Ok(c) => c,
        Err(e) => return format!("ERROR: git: {e}"),
    };
    if let Err(e) = check_created_dir(&plan, &cwd, &roots) {
        return format!("ERROR: git: {e}");
    }
    if let Err(e) = check_repo_config(&cwd).await {
        return format!("ERROR: git: {e}");
    }
    if let Err(e) = check_message_file_paths(&plan, &cwd, &roots) {
        return format!("ERROR: git: {e}");
    }
    if let Err(e) = check_diff_in_work_tree(&plan, &cwd).await {
        return format!("ERROR: git: {e}");
    }
    // A tree-changing command while another live session shares this folder.
    if let Some(held) = crate::shared_folder::tools::guard_git_tool(
        ctx,
        plan.program.as_str(),
        &plan.args,
        &cwd,
    ) {
        return held;
    }
    // Only a folder this very call brings into being may later join a grant.
    #[cfg(feature = "tauri")]
    let newly_made = created_path(&plan, &cwd).filter(|p| !p.exists());
    let out = execute(&plan, &cwd).await;
    // A folder the call made is reported by absolute path. The file tools
    // resolve a relative path in the sandbox workspace, not in the folder the
    // git call ran in, so a model that kept the relative name it typed here
    // read and wrote the wrong place.
    if !out.starts_with("ERROR") {
        if let Some(made) = created_path(&plan, &cwd) {
            // Beside the granted folder rather than inside it: the grant has to
            // cover the new folder before the model's next call needs it.
            #[cfg(feature = "tauri")]
            if !inside(&made, &roots.write()) {
                if let (Some(session), Some(data)) = (ctx.session_id, ctx.mask_root) {
                    if newly_made.as_deref() == Some(made.as_path()) {
                        crate::grants::record_created(session, &made);
                    }
                    if let Err(e) = crate::grants::extend_session(session, &made, ctx.project_root, data) {
                        return format!("{out}\n\n[not added to your write access: {e}]");
                    }
                }
            }
            return format!(
                "{out}

[created: {}. File tools take absolute paths for it; a relative path resolves in your workspace, not here.]",
                crate::tools::sandbox::plain_display(&made)
            );
        }
    }
    out
}

#[cfg(test)]
#[path = "git_plan_characterization_tests.rs"]
mod git_plan_characterization_tests;

#[cfg(test)]
mod render_output_tests {
    use super::*;

    fn output(code: u32, stdout: &str, stderr: &str) -> std::process::Output {
        #[cfg(windows)]
        let status = <std::process::ExitStatus as std::os::windows::process::ExitStatusExt>::from_raw(code);
        #[cfg(unix)]
        let status = <std::process::ExitStatus as std::os::unix::process::ExitStatusExt>::from_raw((code as i32) << 8);
        std::process::Output { status, stdout: stdout.into(), stderr: stderr.into() }
    }

    /// Q1-023: the output step split out of `execute` says what it said.
    #[test]
    fn a_finished_call_is_rendered_as_before() {
        assert_eq!(render_output("git status", &output(0, "", ""), None, None), "$ git status\n(exit 0, no output)");
        assert_eq!(
            render_output("git log", &output(0, "a", "warn\n"), None, None),
            "$ git log\na\nwarn"
        );
        assert_eq!(
            render_output("git push", &output(1, "", "fatal: nope\n"), None, None),
            "ERROR: `git push` exited with 1\nfatal: nope"
        );
        let id = GitIdentity::Helper { helpers: vec![], host: Some("github.com".into()) };
        let refused = render_output(
            "git push",
            &output(128, "", "remote: Permission to a/b.git denied to x.\nfatal: unable to access: The requested URL returned error: 403\n"),
            Some(&id),
            Some("https://user:pw@github.com/a/b.git"),
        );
        assert!(refused.starts_with("ERROR: `git push` exited with 128\n"), "{refused}");
        assert!(!refused.contains("user:pw"), "{refused}");
    }

    /// RQA-001: a lookup that found nothing is a result, not an error.
    #[test]
    fn an_empty_lookup_is_not_an_error() {
        let shown = r"git config --show-origin --get-regexp ^user\.";
        let out = render_output(shown, &output(1, "", ""), None, None);
        assert!(!out.starts_with("ERROR"), "{out}");
        assert!(out.contains("no match"), "{out}");
        for q in ["git grep foo", "git diff --quiet", "git -C x config --get user.name", "git merge-base --is-ancestor a b"] {
            assert!(!render_output(q, &output(1, "", ""), None, None).starts_with("ERROR"), "{q}");
        }
        // Exit 1 with output, other exit codes, or a non-lookup stay errors.
        assert!(render_output(shown, &output(1, "", "fatal: bad\n"), None, None).starts_with("ERROR"));
        assert!(render_output(shown, &output(2, "", ""), None, None).starts_with("ERROR"));
        assert!(render_output("git commit -m x", &output(1, "", ""), None, None).starts_with("ERROR"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(program: &str, args: &[&str]) -> Result<GitPlan, String> {
        plan(
            program,
            &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
    }

    /// The shared table (also read by the web app's tests), so the renderer's
    /// prompt decision and this classification cannot drift apart.
    #[test]
    fn classification_table() {
        let table: Value = serde_json::from_str(include_str!(
            "../../../../../web-app/src/lib/__tests__/gitToolCases.json"
        ))
        .unwrap();
        for case in table.as_array().unwrap() {
            let program = case["program"].as_str().unwrap();
            let args: Vec<&str> = case["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a.as_str().unwrap())
                .collect();
            let got = p(program, &args);
            let label = format!("{program} {args:?}");
            match case["class"].as_str().unwrap() {
                "deny" => assert!(got.is_err(), "{label} should be refused, got {got:?}"),
                class => {
                    let got = got.unwrap_or_else(|e| panic!("{label}: {e}"));
                    let want = match class {
                        "read" => GitClass::Read,
                        "local" => GitClass::Local,
                        "remote" => GitClass::Remote,
                        other => panic!("bad class {other}"),
                    };
                    assert_eq!(got.class, want, "{label}");
                    assert_eq!(
                        got.destructive.is_some(),
                        case["destructive"].as_bool().unwrap_or(false),
                        "{label} destructive"
                    );
                }
            }
        }
    }

    #[test]
    fn pull_request_preflight_requires_exact_target() {
        let missing = p("gh", &["pr", "create", "--fill"]).unwrap();
        assert!(pr_preflight_target(&missing.args).is_err());
        let specified = p("gh", &[
            "pr", "create", "--repo", "owner/project", "--base", "main",
            "--head", "contributor:fix/issue", "--title", "Fix", "--body", "Details",
        ]).unwrap();
        assert_eq!(pr_preflight_target(&specified.args).unwrap(), (
            "https://github.com/owner/project.git".into(),
            "main".into(),
            "https://github.com/contributor/project.git".into(),
            "fix/issue".into(),
        ));
    }

    #[test]
    fn pull_request_head_uses_pushed_fork_even_when_repo_was_renamed() {
        let urls = matching_head_urls(
            vec![
                "https://github.com/menloresearch/jan.git".into(),
                "https://github.com/Jozkah/flint.git".into(),
            ],
            "https://github.com/Jozkah/jan.git",
        ).unwrap();
        assert_eq!(urls, vec![
            "https://github.com/Jozkah/flint.git",
            "https://github.com/Jozkah/jan.git",
        ]);
        assert_eq!(remote_identity("git@github.com:Jozkah/flint.git"), Some(("github.com", "Jozkah")));
        assert_eq!(remote_identity("https://user:token@github.com/Jozkah/flint.git"), Some(("github.com", "Jozkah")));
    }

    fn roots_with(granted: &Path, workspace: &Path) -> Roots {
        Roots {
            granted: vec![granted.to_path_buf()],
            workspace: vec![workspace.to_path_buf()],
            read: vec![],
        }
    }

    fn scratch_dir(label: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("flint_git_{label}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    #[test]
    fn a_worktree_outside_the_writable_roots_is_refused_with_where_it_landed() {
        let repo = scratch_dir("wt_out_repo");
        let ws = scratch_dir("wt_out_ws");
        let plan = p("git", &["worktree", "add", "../../elsewhere", "-b", "x"]).unwrap();
        let err = check_created_dir(&plan, &repo, &roots_with(&repo, &ws)).unwrap_err();
        assert!(err.contains("resolves to"), "{err}");
        assert!(err.contains("elsewhere"), "{err}");
        assert!(err.contains(&crate::tools::sandbox::plain_display(&repo)), "{err}");
        assert!(err.contains("worktree access"), "{err}");
    }

    #[test]
    fn a_worktree_inside_the_granted_folder_is_allowed_and_reported_absolute() {
        let repo = scratch_dir("wt_in_repo");
        let ws = scratch_dir("wt_in_ws");
        let plan = p("git", &["worktree", "add", "worktrees/catalog-home-2", "-b", "x"]).unwrap();
        assert!(check_created_dir(&plan, &repo, &roots_with(&repo, &ws)).is_ok());
        let made = created_path(&plan, &repo).unwrap();
        assert!(made.is_absolute(), "{made:?}");
        assert!(made.ends_with("catalog-home-2"), "{made:?}");
        assert!(made.starts_with(canon(&repo).unwrap()), "{made:?}");
    }

    #[test]
    fn a_worktree_beside_the_granted_folder_is_allowed() {
        let parent = scratch_dir("wt_side");
        let repo = parent.join("pokemon_scans");
        std::fs::create_dir_all(&repo).unwrap();
        let ws = scratch_dir("wt_side_ws");
        let roots = roots_with(&repo, &ws);
        let beside = p("git", &["worktree", "add", "../catalog-home-2", "-b", "x"]).unwrap();
        assert!(check_created_dir(&beside, &repo, &roots).is_ok());
        // Two levels away is not beside it.
        let far = p("git", &["worktree", "add", "../../catalog-home-2", "-b", "x"]).unwrap();
        assert!(check_created_dir(&far, &repo, &roots).is_err());
    }

    #[test]
    fn a_call_that_creates_nothing_has_no_created_path() {
        let repo = scratch_dir("wt_none");
        let plan = p("git", &["status"]).unwrap();
        assert!(created_path(&plan, &repo).is_none());
    }

    #[test]
    fn flag_denylist() {
        for args in [
            &["-c", "core.sshCommand=calc", "status"][..],
            &["-C", "/etc", "status"],
            &["--git-dir=/x", "log"],
            &["fetch", "--upload-pack=touch x", "origin"],
            &["push", "--receive-pack", "x"],
            &["clone", "-u", "x", "https://github.com/a/b"],
            &[
                "clone",
                "--config",
                "core.sshCommand=x",
                "https://github.com/a/b",
            ],
            &[
                "clone",
                "-c",
                "credential.helper=!x",
                "https://github.com/a/b",
            ],
            &["clone", "--template=/tmp/t", "https://github.com/a/b"],
            &["clone", "ext::sh -c touch% /tmp/pwned"],
            &["clone", "file:///etc/repo"],
            &["clone", "C:/Users/x/secret"],
            &["config", "--global", "user.name", "x"],
            &["config", "core.sshCommand", "calc"],
            &["config", "user.name", "x"],
            &["diff", "--no-index", "/etc/passwd", "x"],
            &["log", "--output=/tmp/x"],
            &["rebase", "-x", "calc", "main"],
            &["rebase", "--exec=calc", "main"],
            &["grep", "-Ocalc", "x"],
            &["merge", "-s", "evil", "main"],
            &["merge", "-sevil", "main"],
            &["apply", "--unsafe-paths", "x.patch"],
            &["apply", "--directory=../out", "x.patch"],
            &["am", "--direct=../out", "x.patch"],
            &["remote", "add", "o", "file:///x"],
            &["submodule", "update"],
            &["filter-branch"],
        ] {
            assert!(p("git", args).is_err(), "{args:?} was not refused");
        }
        for args in [
            &["api", "repos/o/r"][..],
            &["auth", "status", "--show-token"],
            &["auth", "login"],
            &["secret", "list"],
            &["extension", "install", "x"],
            &["config", "set", "editor", "x"],
            &["--hostname", "x", "pr", "list"],
        ] {
            assert!(p("gh", args).is_err(), "gh {args:?} was not refused");
        }
        assert!(p("bash", &["-c", "x"]).is_err());
        assert!(p("git", &["commit", "-m", "a\0b"]).is_err());
        // A multi-line message is one argv entry, not a second command.
        assert!(p("git", &["commit", "-m", "subject\n\nbody"]).is_ok());
        // A message file is read outside the sandbox: only inside the folder.
        assert!(p("git", &["commit", "-F", "msg.txt"]).is_ok());
        assert!(p("git", &["commit", "-m", "-Fix: c:/x"]).is_ok());
        for bad in [
            &["commit", "-F", "C:/Users/u/.ssh/id_rsa"][..],
            &["commit", "--file=../secret"],
            &["commit", "-F/etc/passwd"],
            &["notes", "add", "-F", "/etc/passwd"],
        ] {
            assert!(p("git", bad).is_err(), "{bad:?}");
        }
    }

    /// Transcript audit #8: gh shapes a model gets wrong are fixed where gh
    /// itself would accept them, and otherwise refused with the right form.
    #[test]
    fn gh_shape_mistakes_are_fixed_or_named() {
        let plan = p("gh", &["-R", "o/r", "issue", "create", "--title", "T"]).unwrap();
        assert_eq!(plan.args, vec!["issue", "create", "-R", "o/r", "--title", "T"]);
        assert_eq!(plan.remote.as_deref(), Some("o/r"));
        assert_eq!(plan.class, GitClass::Remote);

        let err = p("gh", &["repo", "view", "o/r", "--json", "defaultBranchRef", "isPrivate", "url"]).unwrap_err();
        assert!(err.contains("defaultBranchRef,isPrivate,url"), "{err}");
        let err = p("gh", &["issue", "create", "repo", "o/r", "t", "T"]).unwrap_err();
        assert!(err.contains("dashes"), "{err}");
        assert!(err.contains("--title"), "{err}");
        let err = p("gh", &["pr", "list", "--web", "--json", "number"]).unwrap_err();
        assert!(err.contains("browser"), "{err}");
        let err = p("gh", &["--hostname", "x", "pr", "list"]).unwrap_err();
        assert!(err.contains("[\"pr\", \"create\""), "{err}");
        // A PR number or branch after a single-field --json stays allowed.
        assert!(p("gh", &["pr", "view", "--json", "title", "main"]).is_ok());
    }

    #[test]
    fn plan_records_remote_branch_and_display() {
        let plan = p("git", &["push", "origin", "feature/x"]).unwrap();
        assert_eq!(plan.remote.as_deref(), Some("origin"));
        assert_eq!(plan.branch.as_deref(), Some("feature/x"));
        assert!(plan.always_asks());
        assert_eq!(plan.display(), "git push origin feature/x");
        let plan = p("git", &["git", "commit", "-m", "two words"]).unwrap();
        assert_eq!(plan.display(), "git commit -m \"two words\"");
        let plan = p("gh", &["pr", "create", "--base", "main", "--repo", "o/r"]).unwrap();
        assert_eq!(plan.remote.as_deref(), Some("o/r"));
        assert_eq!(plan.branch.as_deref(), Some("--base main"));
        assert!(plan.reaches_remote);
    }

    #[test]
    fn args_must_be_an_array() {
        // One string is split like a command line, then planned as usual.
        assert_eq!(
            plan_from_args(&json!({"args": "status"})).unwrap().class,
            GitClass::Read
        );
        assert!(plan_from_args(&json!({"args": "log \"unterminated"})).is_err());
        assert!(plan_from_args(&json!({})).is_err());
        assert!(plan_from_args(&json!({"args": ["status", 1]})).is_err());
        assert_eq!(
            plan_from_args(&json!({"args": ["status"]})).unwrap().class,
            GitClass::Read
        );
        assert_eq!(
            plan_from_args(&json!({"program": "gh", "args": ["pr", "list"]}))
                .unwrap()
                .program,
            Program::Gh
        );
    }

    #[test]
    fn git_dash_c_names_the_cwd_parameter_and_the_rewritten_call() {
        let e = p("git", &["-C", "C:/repo", "status", "--short"]).unwrap_err();
        assert!(e.contains("`cwd` parameter"), "{e}");
        assert!(e.contains(r#""cwd": "C:/repo""#), "{e}");
        assert!(e.contains(r#""args": ["status","--short"]"#), "{e}");
        let e = p("git", &["-C/repo", "log"]).unwrap_err();
        assert!(e.contains(r#""cwd": "/repo""#), "{e}");
        // Other global options keep the general refusal.
        assert!(p("git", &["-c", "a=b", "status"]).unwrap_err().contains("global options"));
    }

    #[test]
    fn gh_api_names_the_subcommand_to_use_instead() {
        let e = p("gh", &["api", "repos/o/r/pulls"]).unwrap_err();
        assert!(e.contains(r#"["pr", "list""#), "{e}");
        let e = p("gh", &["api", "repos/o/r/pulls/3/comments"]).unwrap_err();
        assert!(e.contains(r#"["pr", "view", "<number>""#), "{e}");
        let e = p("gh", &["api", "-X", "GET", "/repos/o/r/issues"]).unwrap_err();
        assert!(e.contains(r#"["issue", "list""#), "{e}");
        let e = p("gh", &["api", "repos/o/r/actions/runs"]).unwrap_err();
        assert!(e.contains(r#"["run", "list""#), "{e}");
        let e = p("gh", &["api", "repos/o/r/releases/latest"]).unwrap_err();
        assert!(e.contains(r#"["release", "list""#), "{e}");
        let e = p("gh", &["api", "repos/o/r"]).unwrap_err();
        assert!(e.contains(r#"["repo", "view""#), "{e}");
    }

    #[test]
    fn gh_json_with_an_unknown_field_lists_the_valid_ones() {
        let e = p("gh", &["pr", "list", "--json", "number,status,title"]).unwrap_err();
        assert!(e.contains("no field `status`"), "{e}");
        assert!(e.contains("Valid fields:") && e.contains("state") && e.contains("headRefName"), "{e}");
        let e = p("gh", &["issue", "view", "3", "--json", "number,headRefName"]).unwrap_err();
        assert!(e.contains("`headRefName`"), "{e}");
        let e = p("gh", &["run", "list", "--json", "id"]).unwrap_err();
        assert!(e.contains("databaseId"), "{e}");
        // Valid fields pass, and commands without a known list are not checked.
        assert!(p("gh", &["pr", "list", "--json", "number,title,state"]).is_ok());
        assert!(p("gh", &["run", "view", "5", "--json", "jobs,conclusion"]).is_ok());
        assert!(p("gh", &["repo", "view", "o/r", "--json", "anyNewField"]).is_ok());
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("flint-git-tool-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        canon(&d).unwrap()
    }

    #[test]
    fn cwd_is_confined() {
        let base = temp("cwd");
        let ws = base.join("ws");
        let attached = base.join("attached");
        let outside = base.join("outside");
        for d in [&ws, &attached, &outside, &ws.join(".jan")] {
            std::fs::create_dir_all(d).unwrap();
        }
        let roots = Roots {
            granted: vec![],
            workspace: vec![ws.clone()],
            read: vec![attached.clone()],
        };
        let read = p("git", &["status"]).unwrap();
        let commit = p("git", &["commit", "-m", "x"]).unwrap();
        assert_eq!(
            resolve_cwd(None, &read, &roots).unwrap(),
            attached,
            "default is the attached folder"
        );
        assert!(resolve_cwd(Some(ws.to_str().unwrap()), &commit, &roots).is_ok());
        assert!(resolve_cwd(Some(attached.to_str().unwrap()), &read, &roots).is_ok());
        let err = resolve_cwd(Some(attached.to_str().unwrap()), &commit, &roots).unwrap_err();
        assert!(err.contains("read-only"), "{err}");
        assert!(resolve_cwd(Some(outside.to_str().unwrap()), &read, &roots).is_err());
        assert!(resolve_cwd(Some("../outside"), &read, &roots).is_err());
        assert!(resolve_cwd(Some(ws.join(".jan").to_str().unwrap()), &read, &roots).is_err());

        let clone_out = p(
            "git",
            &[
                "clone",
                "https://github.com/o/r",
                outside.join("r").to_str().unwrap(),
            ],
        )
        .unwrap();
        assert!(check_created_dir(&clone_out, &ws, &roots).is_err());
        let clone_in = p("git", &["clone", "https://github.com/o/r", "r"]).unwrap();
        assert!(check_created_dir(&clone_in, &ws, &roots).is_ok());
        let clone_up = p("git", &["clone", "https://github.com/o/r", "../outside/r"]).unwrap();
        assert!(check_created_dir(&clone_up, &ws, &roots).is_err());

        // A clone with no cwd does not default into the read-only attached
        // folder: it runs from the workspace, where its destination is checked.
        let clone_abs = p(
            "git",
            &["clone", "https://github.com/o/r", ws.join("r").to_str().unwrap()],
        )
        .unwrap();
        let cwd = resolve_cwd(None, &clone_abs, &roots).unwrap();
        assert_eq!(cwd, ws, "a clone defaults to a writable root");
        assert!(check_created_dir(&clone_abs, &cwd, &roots).is_ok());

        // An unknown option value shifts the positionals: the real destination
        // is still checked (F5x2-019).
        let out = outside.join("x");
        let init_shift = p("git", &["init", "--ref-format", "files", out.to_str().unwrap()]).unwrap();
        assert!(check_created_dir(&init_shift, &ws, &roots).is_err());
        let init_in = p("git", &["init", "--ref-format", "files", "sub"]).unwrap();
        assert!(check_created_dir(&init_in, &ws, &roots).is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// gh reads body, notes and asset files outside the sandbox (O06-017).
    #[test]
    fn gh_file_arguments_stay_inside_the_folder() {
        assert!(p("gh", &["pr", "create", "--title", "t", "--body-file", "/etc/x"]).is_err());
        assert!(p("gh", &["issue", "create", "-t", "t", "-F", "../secret"]).is_err());
        assert!(p("gh", &["pr", "comment", "1", "--body-file=C:/Users/u/.ssh/id_rsa"]).is_err());
        assert!(p("gh", &["release", "upload", "v1", "/home/u/.netrc#notes"]).is_err());
        assert!(p("gh", &["release", "create", "v1", "--notes-file", "../n.md"]).is_err());
        assert!(p("gh", &["pr", "create", "--title", "t", "--body-file", "body.md"]).is_ok());
        assert!(p("gh", &["release", "upload", "v1", "dist/app.zip#App"]).is_ok());
    }

    /// Session 8411d403: a push the user approved was then refused because
    /// the repository was attached read-only. A call that only publishes runs
    /// there (it is asked about every time); one that changes the folder
    /// still does not.
    #[test]
    fn a_push_runs_in_a_read_only_attached_folder() {
        let base = temp("publish");
        let ws = base.join("ws");
        let attached = base.join("attached");
        for d in [&ws, &attached] {
            std::fs::create_dir_all(d).unwrap();
        }
        let roots = Roots {
            granted: vec![],
            workspace: vec![ws.clone()],
            read: vec![attached.clone()],
        };
        let at = Some(attached.to_str().unwrap());
        for ok in [
            p("git", &["push", "-u", "origin", "fix/x"]),
            p("gh", &["pr", "create", "--repo", "o/r", "--head", "fix/x", "--base", "main", "--title", "T", "--body", "B"]),
            p("gh", &["pr", "comment", "1", "--body", "hi"]),
            p("gh", &["issue", "create", "--title", "T", "--body", "B"]),
        ] {
            let plan = ok.unwrap();
            assert!(publishes_only(&plan), "{}", plan.display());
            assert_eq!(resolve_cwd(at, &plan, &roots).unwrap(), attached, "{}", plan.display());
        }
        for refused in [
            p("git", &["commit", "-m", "x"]),
            p("git", &["pull", "origin", "main"]),
            p("gh", &["pr", "merge", "1"]),
            p("gh", &["pr", "close", "1", "--delete-branch"]),
            p("gh", &["pr", "checkout", "1"]),
            p("gh", &["repo", "fork"]),
            p("gh", &["repo", "sync"]),
        ] {
            let plan = refused.unwrap();
            assert!(!publishes_only(&plan), "{}", plan.display());
            let err = resolve_cwd(at, &plan, &roots).unwrap_err();
            assert!(err.contains("read-only"), "{err}");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn https_hosts_and_gh_accounts_are_read() {
        assert_eq!(https_host("https://github.com/o/r.git").as_deref(), Some("github.com"));
        assert_eq!(https_host("HTTPS://x:tok@GitHub.com:443/o/r").as_deref(), Some("github.com"));
        assert_eq!(https_host("git@github.com:o/r.git"), None);
        assert_eq!(https_host("ssh://git@github.com/o/r"), None);

        let current = "github.com\n  \u{2713} Logged in to github.com account Jozkah (keyring)\n  - Active account: true\n  - Token scopes: 'repo'";
        assert_eq!(gh_account(current, "github.com").as_deref(), Some("Jozkah"));
        let older = "github.com\n  \u{2713} Logged in to github.com as octo-cat (C:\\x\\hosts.yml)";
        assert_eq!(gh_account(older, "github.com").as_deref(), Some("octo-cat"));
        assert_eq!(gh_account(current, "gitlab.com"), None);
        assert_eq!(gh_account("You are not logged into any GitHub hosts.", "github.com"), None);

        assert_eq!(
            gh_credential_helper(Path::new(r"C:\Program Files\GitHub CLI\gh.exe")),
            "!'C:/Program Files/GitHub CLI/gh.exe' auth git-credential"
        );
        assert_eq!(
            without_userinfo("https://user:secret@github.com/o/r.git"),
            "https://github.com/o/r.git"
        );
    }

    /// The 403 from session 8411d403 said nothing about whose login was
    /// refused. It now names the identity and the ways forward.
    #[test]
    fn a_refused_push_names_the_identity() {
        let out = "remote: Write access to repository not granted.\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403";
        assert!(auth_refused(out));
        assert!(!auth_refused("error: failed to push some refs (fetch first)"));

        let gh = GitIdentity::Gh { account: "Jozkah".into(), host: "github.com".into() };
        let note = gh.refusal_note(Some("https://github.com/o/r.git"));
        assert!(note.contains("`Jozkah`") && note.contains("github.com"), "{note}");
        assert!(note.contains("gh repo fork") && note.contains("do not retry"), "{note}");

        let helper = GitIdentity::Helper { helpers: vec!["manager".into()], host: Some("github.com".into()) };
        let note = helper.refusal_note(None);
        assert!(note.contains("`manager`") && note.contains("gh auth login"), "{note}");
    }

    #[test]
    fn gh_repo_view_names_the_viewer_permission_field() {
        let err = p("gh", &["repo", "view", "o/r", "--json", "defaultBranchRef,permission"]).unwrap_err();
        assert!(err.contains("`viewerPermission`"), "{err}");
        assert!(p("gh", &["repo", "view", "o/r", "--json", "defaultBranchRef,viewerPermission"]).is_ok());
    }

    #[tokio::test]
    async fn argv_runs_real_git_in_a_temp_repo() {
        if crate::tools::git_native::discover_git().is_none() {
            return;
        }
        let ws = temp("exec");
        // An identity for the commit that does not depend on the machine's.
        std::env::set_var("GIT_AUTHOR_NAME", "Flint Test");
        std::env::set_var("GIT_AUTHOR_EMAIL", "flint@example.invalid");
        std::env::set_var("GIT_COMMITTER_NAME", "Flint Test");
        std::env::set_var("GIT_COMMITTER_EMAIL", "flint@example.invalid");
        let roots = Roots {
            granted: vec![],
            workspace: vec![ws.clone()],
            read: vec![],
        };
        let go = |args: &[&str]| {
            let plan = p("git", args).unwrap();
            let cwd = resolve_cwd(None, &plan, &roots).unwrap();
            async move { execute(&plan, &cwd).await }
        };
        let out = go(&["init", "-q", "-b", "main"]).await;
        assert!(!out.starts_with("ERROR"), "{out}");
        std::fs::write(ws.join("a.txt"), "hello").unwrap();
        // A hook the repository carries must not run.
        std::fs::write(
            ws.join(".git/hooks/pre-commit"),
            "#!/bin/sh\necho HOOKRAN > hook.txt\nexit 1\n",
        )
        .unwrap();
        assert!(!go(&["add", "a.txt"]).await.starts_with("ERROR"));
        let out = go(&["commit", "-q", "-m", "first commit"]).await;
        assert!(!out.starts_with("ERROR"), "{out}");
        assert!(!ws.join("hook.txt").exists(), "a repository hook ran");
        let log = go(&["log", "--oneline"]).await;
        assert!(log.contains("first commit"), "{log}");
        assert!(log.starts_with("$ git log --oneline"), "{log}");
        let bad = go(&["checkout", "no-such-branch"]).await;
        assert!(bad.starts_with("ERROR:"), "{bad}");
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn risky_repo_config_is_named() {
        for (k, v) in [
            ("core.sshCommand", "calc.exe"),
            ("core.gitProxy", "x"),
            ("core.fsmonitor", "./evil.sh"),
            ("core.hooksPath", ".githooks"),
            ("core.pager", "less"),
            ("core.editor", "vim"),
            ("diff.external", "x"),
            ("diff.pdf.command", "x"),
            ("diff.pdf.textconv", "x"),
            ("merge.ours.driver", "x"),
            ("filter.lfs.smudge", "x"),
            ("filter.lfs.clean", "x"),
            ("filter.a.b.process", "x"),
            ("credential.helper", "!evil"),
            ("credential.https://github.com.helper", "C:/tools/steal.exe"),
            ("sequence.editor", "x"),
            ("gpg.program", "x"),
            ("gpg.ssh.program", "x"),
            ("url.ext::sh -c x.insteadOf", "https://github.com/"),
            ("url.file:///tmp/r.insteadOf", "https://github.com/"),
            ("protocol.ext.allow", "always"),
            ("include.path", "../x"),
            ("includeIf.gitdir:~/.path", "x"),
        ] {
            assert!(risky_config(k, v).is_some(), "{k}={v}");
        }
        for (k, v) in [
            ("core.hooksPath", ""),
            ("core.fsmonitor", "false"),
            ("core.autocrlf", "true"),
            ("credential.helper", "manager"),
            ("remote.origin.url", "https://github.com/o/r"),
            ("url.https://github.com/.insteadOf", "gh:"),
            ("user.name", "x"),
            ("diff.renames", "true"),
            ("branch.main.merge", "refs/heads/main"),
        ] {
            assert!(risky_config(k, v).is_none(), "{k}={v}");
        }
    }

    #[test]
    fn scoped_config_parses() {
        let raw = b"local\0core.sshcommand\ncalc\0global\0user.name\nMe\0local\0core.bare\nfalse\0";
        let got = parse_scoped_config(raw);
        assert_eq!(got.len(), 3);
        assert_eq!(
            got[0],
            ("local".into(), "core.sshcommand".into(), "calc".into())
        );
    }

    #[test]
    fn diff_commands_get_no_external_drivers() {
        let plan = p("git", &["log", "-p"]).unwrap();
        assert_eq!(
            argv_for(&plan),
            ["log", "-p", "--no-ext-diff", "--no-textconv"]
        );
        let plan = p("git", &["diff", "--textconv", "--", "f"]).unwrap();
        assert_eq!(
            argv_for(&plan),
            ["diff", "--textconv", "--no-ext-diff", "--no-textconv", "--", "f"]
        );
        let plan = p("git", &["status"]).unwrap();
        assert_eq!(argv_for(&plan), ["status"]);
    }

    #[tokio::test]
    async fn a_repo_that_sets_a_program_is_refused_before_anything_runs() {
        if crate::tools::git_native::discover_git().is_none() {
            return;
        }
        let ws = temp("cfg");
        let init = p("git", &["init", "-q"]).unwrap();
        assert!(!execute(&init, &ws).await.starts_with("ERROR"));
        assert!(
            check_repo_config(&ws).await.is_ok(),
            "a fresh repository is fine"
        );
        // Our own per-call overrides are command scope, never refused.
        let log = execute(&p("git", &["log"]).unwrap(), &ws).await;
        assert!(!log.contains("configuration would make"), "{log}");
        let cfg = ws.join(".git").join("config");
        let mut text = std::fs::read_to_string(&cfg).unwrap();
        text.push_str("[core]\n\tsshCommand = calc.exe\n[filter \"x\"]\n\tsmudge = evil\n");
        std::fs::write(&cfg, text).unwrap();
        let err = check_repo_config(&ws).await.unwrap_err();
        assert!(
            err.contains("core.sshcommand") && err.contains("filter.x.smudge"),
            "{err}"
        );
        let store = ws.join("store");
        let out = run(
            &json!({"args": ["status"]}),
            &crate::tools::ToolContext::new(&ws, &store, &[]),
        )
        .await;
        assert!(
            out.starts_with("ERROR: git: this repository's own Git configuration"),
            "{out}"
        );
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn output_is_capped() {
        let big = "x".repeat(OUTPUT_CAP + 10);
        let c = cap(big);
        assert!(c.contains("[output truncated"));
        assert!(c.len() < OUTPUT_CAP + 100);
    }

    #[test]
    fn a_command_line_splits_like_a_shell() {
        assert_eq!(
            split_command_line(r#"commit -m "Fix the \"parser\"" --author='A B'"#).unwrap(),
            vec!["commit", "-m", r#"Fix the "parser""#, "--author=A B"]
        );
        assert_eq!(
            split_command_line("  log   --oneline -5 ").unwrap(),
            vec!["log", "--oneline", "-5"]
        );
        assert!(split_command_line("log 'open").is_none());
    }

    #[test]
    fn a_backslash_before_a_closing_quote_does_not_swallow_it() {
        assert_eq!(
            split_command_line(r#"add "dir\\" next"#).unwrap(),
            vec!["add", r"dir\", "next"]
        );
        assert_eq!(
            split_command_line(r#"add "say \"hi\"""#).unwrap(),
            vec!["add", r#"say "hi""#]
        );
        // Single backslashes and a UNC prefix stay literal.
        assert_eq!(
            split_command_line(r#"add "C:\\repo\src" "\\server\share""#).unwrap(),
            vec!["add", r"C:\repo\src", r"\\server\share"]
        );
    }

    #[test]
    fn duplicate_pr_flags_are_rejected() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        for dup in [
            args(&["pr", "create", "--repo", "o/r", "--base", "a", "--base", "b", "--head", "h"]),
            args(&["pr", "create", "--repo", "o/r", "--base", "a", "-B", "b", "--head", "h"]),
            args(&["pr", "create", "--repo", "o/r", "--base=a", "--base", "b", "--head", "h"]),
            args(&["pr", "create", "--repo", "o/r", "--repo", "x/y", "--base", "a", "--head", "h"]),
        ] {
            assert!(pr_preflight_target(&dup).is_err(), "{dup:?}");
        }
    }

    #[test]
    fn branch_names_with_hash_at_and_plus_are_accepted() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let ok = args(&["pr", "create", "--repo", "o/r", "--base", "main", "--head", "fix/issue#12+x@y"]);
        assert_eq!(pr_preflight_target(&ok).unwrap().3, "fix/issue#12+x@y");
        for bad in ["-x", "a..b", "a@{1}", "a b", "a\\b", "a~1", "a^", "a:b:c", "a?", "a*", "a[", "@"] {
            let a = args(&["pr", "create", "--repo", "o/r", "--base", "main", "--head", bad]);
            assert!(pr_preflight_target(&a).is_err(), "{bad}");
        }
    }

    #[test]
    fn sha_in_skips_a_command_header_line() {
        let sha = "0123456789abcdef0123456789abcdef01234567";
        let out = format!("$ git ls-remote https://github.com/o/r.git main\n{sha}\trefs/heads/main\n");
        assert_eq!(sha_in(&out).as_deref(), Some(sha));
    }

    #[test]
    fn gh_repo_clone_dashdash_flags_refused() {
        for args in [
            &["repo", "clone", "o/r", "d", "--", "-c", "credential.helper=!calc"][..],
            &["repo", "clone", "o/r", "d", "--", "-c", "core.sshCommand=calc"],
            &["repo", "clone", "o/r", "d", "--", "--separate-git-dir=/anywhere"],
            &["repo", "fork", "o/r", "--clone", "--", "--template=/x"],
        ] {
            assert!(p("gh", args).is_err(), "{args:?}");
        }
        assert!(p("gh", &["repo", "clone", "o/r", "d"]).is_ok());
        assert!(p("gh", &["repo", "fork", "o/r"]).is_ok());
    }

    #[test]
    fn diff_two_absolute_paths_refused() {
        for args in [
            &["diff", "/dev/null", "/home/u/.aws/credentials"][..],
            &["diff", "C:/Users/u/.ssh/id_rsa", "NUL"],
            &["diff", "--", "/etc/passwd"],
            &["diff", "..\\secret", "x"],
            &["diff", "../outside", "a"],
            &["diff", "\\\\?\\C:\\x", "a"],
            &["diff-tree", "/etc/passwd"],
            &["range-diff", "../a", "b"],
        ] {
            assert!(p("git", args).is_err(), "{args:?}");
        }
        for args in [
            &["diff", "a.txt", "b.txt"][..],
            &["diff", "HEAD~1", "HEAD", "--", "src/main.rs"],
            &["diff", "main..feature"],
            &["diff", "--stat", "HEAD^"],
        ] {
            assert_eq!(p("git", args).unwrap().class, GitClass::Read, "{args:?}");
        }
    }

    #[test]
    fn blame_contents_refused() {
        for args in [
            &["blame", "--contents", "/home/u/.ssh/id_rsa", "--", "a.rs"][..],
            &["blame", "--contents=/etc/passwd", "a.rs"],
            &["blame", "--ignore-revs-file", "/etc/passwd", "a.rs"],
            &["blame", "--ignore-revs-f=/etc/passwd", "a.rs"],
            &["blame", "-S", "/etc/passwd", "a.rs"],
            &["log", "-O/etc/passwd"],
            &["diff", "-O/etc/passwd"],
            &["grep", "-f", "/etc/passwd"],
            &["grep", "--file=/etc/passwd"],
            &["ls-files", "--exclude-from=/etc/passwd"],
            &["ls-files", "-X", "/etc/passwd"],
            &["add", "--pathspec-from-file=/etc/passwd"],
        ] {
            assert!(p("git", args).is_err(), "{args:?}");
        }
        // Real options that merely share a prefix keep working.
        assert!(p("git", &["blame", "--ignore-rev", "HEAD~1", "a.rs"]).is_ok());
        assert!(p("git", &["log", "--exclude=refs/tags/*", "--all"]).is_ok());
        assert!(p("git", &["log", "-SOrder"]).is_ok());
        assert!(p("git", &["grep", "-n", "-F", "x"]).is_ok());
    }

    #[test]
    #[allow(non_snake_case)]
    fn tag_F_outside_roots_refused() {
        for args in [
            &["tag", "-a", "-F", "/home/u/.ssh/id_rsa", "v1"][..],
            &["tag", "-a", "-F", "C:/x/y", "v1"],
            &["tag", "-a", "--file=../x", "v1"],
            &["merge", "-F", "/etc/passwd", "feature"],
            &["merge", "--file=../x", "feature"],
            &["am", "/tmp/x.patch"],
            &["apply", "../x.patch"],
        ] {
            assert!(p("git", args).is_err(), "{args:?}");
        }
        assert!(p("git", &["tag", "-a", "-F", "msg.txt", "v1"]).is_ok());
        assert!(p("git", &["tag", "-a", "-m", "msg", "v1"]).is_ok());
        assert!(p("git", &["apply", "fix.patch"]).is_ok());
        assert!(p("git", &["merge", "-sours", "feature"]).is_ok());
        assert!(p("git", &["merge", "-m", "x", "feature"]).is_ok());
    }

    #[test]
    #[allow(non_snake_case)]
    fn merge_F_symlink_refused() {
        let repo = scratch_dir("msg_link_repo");
        let ws = scratch_dir("msg_link_ws");
        let outside = scratch_dir("msg_link_out");
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        std::fs::write(repo.join("ok.txt"), "fine").unwrap();
        let link = repo.join("msg.txt");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(outside.join("secret.txt"), &link).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(outside.join("secret.txt"), &link).is_ok();
        let roots = roots_with(&repo, &ws);
        let ok = p("git", &["merge", "-F", "ok.txt", "feature"]).unwrap();
        assert!(check_message_file_paths(&ok, &repo, &roots).is_ok());
        if made {
            for args in [
                &["merge", "-F", "msg.txt", "feature"][..],
                &["tag", "-a", "-F", "msg.txt", "v1"],
                &["commit", "-F", "msg.txt"],
            ] {
                let plan = p("git", args).unwrap();
                let err = check_message_file_paths(&plan, &repo, &roots).unwrap_err();
                assert!(err.contains("symbolic link"), "{err}");
            }
        }
        for d in [&repo, &ws, &outside] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn http_proxy_config_risky() {
        for (k, v) in [
            ("http.proxy", "https://attacker"),
            ("http.sslVerify", "false"),
            ("http.sslCAInfo", "/tmp/ca.pem"),
            ("http.extraHeader", "X: y"),
            ("http.https://github.com/.proxy", "https://attacker"),
            ("remote.origin.proxy", "https://attacker"),
            ("url.https://evil.example/.insteadOf", "https://github.com/"),
        ] {
            assert!(risky_config(k, v).is_some(), "{k}={v}");
        }
        for (k, v) in [
            ("http.postBuffer", "524288000"),
            ("url.git@github.com:.insteadOf", "https://github.com/"),
            ("remote.origin.url", "https://github.com/o/r"),
        ] {
            assert!(risky_config(k, v).is_none(), "{k}={v}");
        }
        assert!(CONFIG_OVERRIDES.contains(&("http.sslVerify", "true")));
    }

    #[tokio::test]
    async fn split_git_piece_checks_repo_config() {
        // The null-device split path in handlers/bash.rs must call the same check.
        let src = include_str!("handlers/bash.rs");
        let at = src.find("Piece::Git(argv) =>").expect("split git arm");
        assert!(src[at..at + 1500].contains("check_repo_config"));
        // And that check refuses a planted filter driver in a real repository.
        let Some(bin) = crate::tools::git_native::discover_git() else { return };
        let repo = scratch_dir("split_cfg");
        let ok = std::process::Command::new(&bin)
            .arg("init")
            .arg("-q")
            .arg(&repo)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            assert!(check_repo_config(&repo).await.is_ok());
            let cfg = repo.join(".git").join("config");
            let mut text = std::fs::read_to_string(&cfg).unwrap();
            text.push_str("[filter \"x\"]\n\tclean = calc\n");
            std::fs::write(&cfg, text).unwrap();
            assert!(check_repo_config(&repo).await.is_err());
        }
        let _ = std::fs::remove_dir_all(&repo);
    }
}
