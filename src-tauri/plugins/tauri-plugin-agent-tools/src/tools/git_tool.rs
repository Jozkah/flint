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
/// double quotes group (with `\"` inside double quotes). No expansion of any
/// kind. `None` for an unterminated quote.
fn split_command_line(line: &str) -> Option<Vec<String>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' | '"' => {
                in_word = true;
                loop {
                    match chars.next() {
                        None => return None,
                        Some(q) if q == c => break,
                        Some('\\') if c == '"' && chars.peek() == Some(&'"') => {
                            cur.push('"');
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

/// Configuration forced on every call, whatever the repository says.
pub const CONFIG_OVERRIDES: &[(&str, &str)] = &[
    ("protocol.ext.allow", "never"),
    ("protocol.file.allow", "never"),
    ("diff.external", ""),
    ("core.hooksPath", "/dev/null"),
    ("core.fsmonitor", "false"),
    ("core.pager", "cat"),
];

/// The argv actually run: the plan's, plus `--no-ext-diff --no-textconv`
/// right after a diff-producing subcommand, so no diff driver runs.
pub fn argv_for(plan: &GitPlan) -> Vec<String> {
    let mut argv = plan.args.clone();
    if plan.program == Program::Git
        && matches!(
            argv.first().map(String::as_str),
            Some("diff" | "log" | "show")
        )
    {
        argv.splice(
            1..1,
            ["--no-ext-diff".to_string(), "--no-textconv".to_string()],
        );
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
    let out = match tokio::time::timeout(Duration::from_secs(30), cmd.output()).await {
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
    let out = tokio::time::timeout(Duration::from_secs(20), cmd.output())
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
                                .map(|l| crate::secrets::redact_secrets(l))
                                .collect()
                        })
                        .unwrap_or_default();
                    identity = Some(GitIdentity::Helper { helpers, host: Some(host) });
                }
            }
        }
    }
    cmd.args(argv_for(plan));
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
        let note = match &identity {
            Some(id) if auth_refused(&body) => {
                let shown_url = url.as_deref().map(without_userinfo);
                format!("\n{}", id.refusal_note(shown_url.as_deref()))
            }
            _ => String::new(),
        };
        format!("ERROR: `{shown}` exited with {code}\n{body}{note}")
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
            &["--hostname", "x", "pr", "list"],
        ] {
            assert!(p("gh", args).is_err(), "gh {args:?} was not refused");
        }
        assert!(p("bash", &["-c", "x"]).is_err());
        assert!(p("git", &["commit", "-m", "a\0b"]).is_err());
        // A multi-line message is one argv entry, not a second command.
        assert!(p("git", &["commit", "-m", "subject\n\nbody"]).is_ok());
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
        let _ = std::fs::remove_dir_all(&base);
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
            ["log", "--no-ext-diff", "--no-textconv", "-p"]
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
}
