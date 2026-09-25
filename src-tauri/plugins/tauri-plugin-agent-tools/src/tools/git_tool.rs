//! The `git` tool: the host's real `git` (and `gh`) run outside the sandbox.
//!
//! On Windows the `bash` tool runs in an AppContainer that cannot start Git for
//! Windows, so an agent could not commit, push or open a pull request, and
//! models fell back to MCP shells that bypass Flint's approval prompts. This
//! tool runs the host binaries directly, as an argv array (never a shell
//! string), with the working directory confined to the folders the run may
//! use, a timeout, a bounded and secret-redacted output, and no credential
//! handling of its own: git and gh use the user's existing login, and nothing
//! can prompt (`GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`).
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
];

fn deny_common_git(sub: &str, rest: &[String]) -> Result<(), String> {
    for a in rest {
        let lower = a.to_ascii_lowercase();
        for opt in DENIED_GIT_OPTIONS {
            if lower == *opt || lower.starts_with(&format!("{opt}=")) {
                return Err(format!(
                    "the option `{a}` is not allowed: it can run other programs or reach outside the allowed folders"
                ));
            }
        }
        if lower.starts_with("ext::") || lower.starts_with("fd::") {
            return Err(format!("the transport in `{a}` is not allowed"));
        }
    }
    // Short spellings of the options above, per subcommand.
    match sub {
        // `-u` is `--upload-pack` for these two (for push it is
        // `--set-upstream`, for fetch `--update-head-ok`).
        "clone" | "ls-remote" => {
            if has(rest, &["-u"]) {
                return Err("`-u` (upload/receive-pack) is not allowed".into());
            }
            if sub == "clone" && has(rest, &["-c"]) {
                return Err("`clone -c` (configuration override) is not allowed".into());
            }
        }
        "rebase" => {
            if has(rest, &["-x"]) || rest.iter().any(|a| a.starts_with("-x")) {
                return Err("`rebase -x/--exec` runs shell commands and is not allowed".into());
            }
        }
        "grep" => {
            if has(rest, &["-O"]) || rest.iter().any(|a| a.starts_with("-O")) {
                return Err("`grep -O` opens a pager program and is not allowed".into());
            }
        }
        "merge" | "pull" => {
            let strategies = ["ort", "recursive", "resolve", "octopus", "ours", "subtree"];
            let mut it = rest.iter().peekable();
            while let Some(a) = it.next() {
                let value = if a == "-s" || a == "--strategy" {
                    it.peek().map(|s| s.as_str())
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
        _ => {}
    }
    Ok(())
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
    let Some(sub) = args.first().cloned() else {
        return Err("no git subcommand given (e.g. [\"status\"])".into());
    };
    if sub.starts_with('-') {
        return Err(format!(
            "global options before the subcommand (`{sub}`) are not allowed; pass the folder as `cwd` instead of -C, and do not override configuration with -c"
        ));
    }
    let rest: Vec<String> = args[1..].to_vec();
    deny_common_git(&sub, &rest)?;
    let mut plan = plan_of(Program::Git, args.clone(), GitClass::Local);
    let first = rest.first().map(String::as_str);
    match sub.as_str() {
        "status" | "log" | "diff" | "show" | "rev-parse" | "ls-files" | "ls-tree" | "blame"
        | "shortlog" | "describe" | "cat-file" | "grep" | "rev-list" | "merge-base"
        | "name-rev" | "show-ref" | "for-each-ref" | "whatchanged" | "count-objects"
        | "check-ignore" | "version" | "diff-tree" | "diff-index" | "diff-files" | "range-diff" => {
            plan.class = GitClass::Read;
        }
        "ls-remote" => {
            plan.class = GitClass::Read;
            plan.reaches_remote = true;
            plan.remote = positionals(&rest, &[]).first().map(|s| s.to_string());
        }
        "branch" => {
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
        }
        "tag" => {
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
        }
        "remote" => match first {
            None | Some("-v") | Some("--verbose") | Some("show") | Some("get-url") => {
                plan.class = GitClass::Read;
                if first == Some("show") {
                    plan.reaches_remote = true;
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
        },
        "stash" => match first {
            Some("list") | Some("show") => plan.class = GitClass::Read,
            Some("drop") | Some("clear") => {
                plan.destructive = Some("discards stashed changes".into());
            }
            _ => {}
        },
        "config" => {
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
        }
        "worktree" => match first {
            Some("list") => plan.class = GitClass::Read,
            Some("remove") if has_opt(&rest, &["-f", "--force"]) => {
                plan.destructive = Some("removes a worktree with uncommitted changes".into());
            }
            Some("add") | Some("remove") | Some("move") | Some("prune") | Some("lock")
            | Some("unlock") | Some("repair") => {}
            _ => return Err("`git worktree` supports list, add, remove, move, prune, lock, unlock, repair".into()),
        },
        "reflog" => match first {
            Some("expire") | Some("delete") | Some("drop") => {
                plan.destructive = Some("deletes reflog entries, the record that recovers lost commits".into());
            }
            _ => plan.class = GitClass::Read,
        },
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
        "add" | "commit" | "mv" | "merge" | "rebase" | "cherry-pick" | "revert" | "am"
        | "apply" | "init" | "notes" | "sparse-checkout" | "update-index" => {}
        "clone" => {
            plan.reaches_remote = true;
            let values = ["-b", "--branch", "--depth", "-o", "--origin", "-j", "--jobs", "--filter", "--shallow-since", "--shallow-exclude", "--bundle-uri"];
            let pos = positionals(&rest, &values);
            let Some(url) = pos.first() else {
                return Err("git clone needs a repository URL".into());
            };
            check_clone_url(url)?;
            plan.remote = Some(url.to_string());
        }
        "fetch" | "pull" => {
            plan.reaches_remote = true;
            let pos = positionals(&rest, &["--depth", "-j", "--jobs", "-s", "--strategy", "-X", "--strategy-option"]);
            plan.remote = pos.first().map(|s| s.to_string());
            plan.branch = pos.get(1).map(|s| s.to_string());
        }
        "push" => {
            plan.class = GitClass::Remote;
            plan.reaches_remote = true;
            let pos = positionals(&rest, &["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
            plan.remote = pos.first().map(|s| s.to_string());
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
        }
        other => {
            return Err(format!(
                "`git {other}` is not supported by this tool. Supported: status, log, diff, show, branch, tag, remote, stash, add, commit, checkout, switch, restore, merge, rebase, cherry-pick, revert, reset, clean, rm, mv, init, clone, fetch, pull, push, worktree, config (read only)"
            ))
        }
    }
    Ok(plan)
}

fn gh_plan(args: Vec<String>) -> Result<GitPlan, String> {
    let Some(group) = args.first().cloned() else {
        return Err("no gh command given (e.g. [\"pr\", \"list\"])".into());
    };
    if group.starts_with('-') {
        return Err(format!(
            "options before the gh command (`{group}`) are not allowed"
        ));
    }
    if has_opt(&args, &["--show-token", "-t"]) && group == "auth" {
        return Err("`gh auth status --show-token` is not allowed: the token must never reach the transcript".into());
    }
    let action = args.get(1).map(String::as_str).unwrap_or("");
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
                "`gh {group} {action}` is not supported by this tool. Supported: repo view/list/clone/create/fork, pr list/view/status/diff/checks/checkout/create/merge/comment/close/edit/review/ready, issue list/view/create/comment/close/edit, run list/view, release list/view/create, auth status. `gh api`, `gh auth login`, `gh secret`, `gh config` and extensions are refused."
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
        Some(Value::String(_)) => {
            return Err("`args` must be an array of separate arguments, e.g. [\"commit\", \"-m\", \"Fix typo\"], not one command string".into())
        }
        _ => return Err("`args` (array of strings) is required, e.g. [\"status\"]".into()),
    };
    plan(program, &args)
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

fn canon(p: &Path) -> Option<PathBuf> {
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

fn inside(p: &Path, roots: &[PathBuf]) -> bool {
    roots
        .iter()
        .filter_map(|r| canon(r))
        .any(|r| p.starts_with(&r))
}

fn in_jan_dir(p: &Path) -> bool {
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

    fn write(&self) -> Vec<PathBuf> {
        self.granted
            .iter()
            .chain(self.workspace.iter())
            .cloned()
            .collect()
    }

    /// Where a call with no `cwd` runs: the granted folder or worktree if
    /// there is one, else the attached folder, else the session workspace.
    fn default_base(&self) -> Option<&PathBuf> {
        self.granted
            .first()
            .or(self.read.first())
            .or(self.workspace.first())
    }
}

/// Resolve and check the working directory for `plan`.
pub fn resolve_cwd(raw: Option<&str>, plan: &GitPlan, roots: &Roots) -> Result<PathBuf, String> {
    let base = roots
        .default_base()
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
        if plan.class == GitClass::Read {
            return Ok(cwd);
        }
        return Err(format!(
            "`{}` is attached read-only, so `{}` cannot run there. Only read-only git commands (status, log, diff, ...) work in it; ask the user for write access or a worktree to change it.",
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

pub fn check_created_dir(plan: &GitPlan, cwd: &Path, roots: &Roots) -> Result<(), String> {
    let Some(dir) = created_dir(plan) else {
        return Ok(());
    };
    let target = if Path::new(&dir).is_absolute() {
        PathBuf::from(&dir)
    } else {
        cwd.join(&dir)
    };
    let resolved =
        canon_new(&target).ok_or_else(|| format!("`{dir}` is not a usable destination"))?;
    if in_jan_dir(&resolved) || !inside(&resolved, &roots.write()) {
        return Err(format!(
            "`{dir}` is outside the folders this run may write to"
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

/// Run a planned call in `cwd`. Returns the tool result text; a failure starts
/// with `ERROR:`.
pub async fn execute(plan: &GitPlan, cwd: &Path) -> String {
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
    cmd.args(&plan.args)
        .current_dir(cwd)
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
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let secs = if plan.reaches_remote {
        REMOTE_TIMEOUT_SECS
    } else {
        LOCAL_TIMEOUT_SECS
    };
    let shown = crate::secrets::redact_secrets(&plan.display());
    let out = match tokio::time::timeout(Duration::from_secs(secs), cmd.output()).await {
        Err(_) => return format!("ERROR: `{shown}` timed out after {secs}s and was stopped"),
        Ok(Err(e)) => return format!("ERROR: could not start {}: {e}", plan.program.as_str()),
        Ok(Ok(out)) => out,
    };
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
    } else {
        format!("ERROR: `{shown}` exited with {code}\n{body}")
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
    execute(&plan, &cwd).await
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
            &["--repo", "o/r", "pr", "list"],
        ] {
            assert!(p("gh", args).is_err(), "gh {args:?} was not refused");
        }
        assert!(p("bash", &["-c", "x"]).is_err());
        assert!(p("git", &["commit", "-m", "a\0b"]).is_err());
        // A multi-line message is one argv entry, not a second command.
        assert!(p("git", &["commit", "-m", "subject\n\nbody"]).is_ok());
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
        assert!(plan_from_args(&json!({"args": "status"})).is_err());
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
        let _ = std::fs::remove_dir_all(&base);
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
    fn output_is_capped() {
        let big = "x".repeat(OUTPUT_CAP + 10);
        let c = cap(big);
        assert!(c.contains("[output truncated"));
        assert!(c.len() < OUTPUT_CAP + 100);
    }
}
