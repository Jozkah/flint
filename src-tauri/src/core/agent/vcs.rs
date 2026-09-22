//! Where a branch stands against its remote, and what a conflict actually
//! says. AH-171, AH-165.
//!
//! Both of these are things a run currently does by asking the model to read
//! `git status` and decide. That is the failure mode worth removing: the two
//! situations where a wrong guess destroys work are a branch that has diverged
//! from its remote, and a merge that stopped half-done. In both, the
//! convenient answer -- `git push --force`, `git checkout --theirs .` -- throws
//! away somebody's commits, and a model that has been told "make it work" will
//! reach for it.
//!
//! So this reports, and refuses to resolve:
//!
//! * [`divergence`] says how far apart a branch and its upstream are, in both
//!   directions, and what can be done that loses nothing. A force push is
//!   never among the options it returns -- not as a last resort, not with a
//!   warning. If the only way forward discards commits, that is a person's
//!   decision to make with their hands.
//! * [`conflicts`] reads a stopped merge: which files are unresolved, what
//!   kind of conflict each one is (both changed it, one deleted it, it is
//!   binary), and the conflicting regions with their surrounding lines. It
//!   never writes a file.
//!
//! Nothing in those two fetches, merges, pushes or checks anything out.
//!
//! The operations that do change history -- [`apply_split`] (AH-160),
//! [`rebase_start`] (AH-166) and [`cherry_pick`] (AH-167) -- are built so that
//! work is recoverable at every step: they refuse a dirty tree, write a backup
//! ref (`refs/jan/backup/...`) before anything moves, never pass a name that
//! could be read as an option, never open an editor, and [`abort_op`] returns
//! the branch exactly to its backup and checks that it did.

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

/// The most conflicting regions reported per file, and the most lines kept per
/// side of one. A conflict that is bigger than this is real and is reported as
/// truncated: the point is to show enough to decide, not to reproduce the file.
pub const MAX_HUNKS: usize = 20;
pub const MAX_SIDE_LINES: usize = 60;
/// The most conflicted files reported.
pub const MAX_FILES: usize = 200;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VcsErrorKind {
    /// The path is not inside a git work tree.
    NotARepo,
    /// git is not installed, or would not run.
    GitUnavailable,
    /// git ran and failed.
    GitFailed,
    /// The caller asked for something that would discard work.
    WouldDiscard,
    /// No branch by that name here.
    NoBranch,
    /// Nothing is staged, so there is no change to describe.
    NothingStaged,
    /// The message would be wrong about the commit.
    BadMessage,
    /// The name is not one this will hand to git.
    BadName,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VcsError {
    pub kind: VcsErrorKind,
    pub message: String,
}

impl VcsError {
    fn new(kind: VcsErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: tauri_plugin_agent_tools::harness_error::scrub(&message.into()),
        }
    }
}

/// What this failure is in the harness's own vocabulary (AH-009).
impl From<&VcsError> for tauri_plugin_agent_tools::harness_error::HarnessError {
    fn from(error: &VcsError) -> Self {
        use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
        let kind = match error.kind {
            VcsErrorKind::NotARepo => ErrorKind::NotFound,
            VcsErrorKind::GitUnavailable => ErrorKind::ToolUnavailable,
            VcsErrorKind::GitFailed => ErrorKind::ToolFailed,
            // Structurally forbidden rather than merely failed: asking again
            // will not make it allowed.
            VcsErrorKind::WouldDiscard => ErrorKind::PolicyViolation,
            VcsErrorKind::NoBranch => ErrorKind::NotFound,
            VcsErrorKind::BadName => ErrorKind::InvalidInput,
            // Nothing to describe is not a failure of the message: it is the
            // caller asking too early, and no retry changes it.
            VcsErrorKind::NothingStaged => ErrorKind::InvalidInput,
            VcsErrorKind::BadMessage => ErrorKind::InvalidInput,
        };
        HarnessError::new(kind, error.message.clone()).at(Stage::Tool)
    }
}

/// R20: configuration every git a tool runs is given, so git runs no program
/// the repository could have been made to name. Hooks are looked for where
/// there are none; fsmonitor, signing and credential prompts are off.
pub(crate) const HARDENED: &[&str] = &[
    "-c",
    "core.hooksPath=/dev/null/jan-no-hooks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "tag.gpgSign=false",
    "-c",
    "core.sshCommand=",
    "-c",
    "credential.helper=",
];

/// Keys in a repository's own config whose value is a program git would run.
fn runs_a_program(key: &str, value: &str) -> bool {
    let key = key.to_ascii_lowercase();
    let last = key.rsplit('.').next().unwrap_or("");
    let boolean = matches!(value.trim().to_ascii_lowercase().as_str(), "" | "true" | "false" | "yes" | "no" | "on" | "off" | "1" | "0");
    (key.starts_with("filter.") && matches!(last, "clean" | "smudge" | "process"))
        || (key.starts_with("diff.") && matches!(last, "textconv" | "command"))
        || (key.starts_with("merge.") && last == "driver")
        || (key.starts_with("gpg.") && last == "program")
        || (key == "core.fsmonitor" && !boolean)
        || matches!(
            key.as_str(),
            "core.editor" | "sequence.editor" | "core.sshcommand" | "core.askpass" | "core.pager"
                | "credential.helper" | "uploadpack.packobjectshook" | "core.gitproxy" | "diff.external"
                | "core.hookspath"
        )
        || (key.starts_with("credential.") && last == "helper")
        || key.starts_with("alias.") && value.trim_start().starts_with('!')
}

/// The filter commands git-lfs itself installs. A repository that uses
/// git-lfs names these, and they are not a program the repository chose.
fn is_git_lfs_filter(key: &str, value: &str) -> bool {
    let key = key.to_ascii_lowercase();
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    key.starts_with("filter.lfs.")
        && matches!(
            value.as_str(),
            "git-lfs clean -- %f" | "git-lfs smudge -- %f" | "git-lfs smudge --skip -- %f"
                | "git-lfs filter-process" | "git-lfs filter-process --skip"
        )
}

/// R22: for change checkpoints and isolated checkouts, which run filters on
/// every file they stage or check out -- refuse a repository whose own config
/// names a filter, diff or merge program other than git-lfs's own commands.
pub(crate) fn refuse_filter_programs(repo: &Path) -> Result<(), String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(["config", "--local", "--includes", "--list", "-z"]);
    jan_utils::system::hide_console_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("git would not run: {e}"))?;
    let listed = String::from_utf8_lossy(&out.stdout);
    for entry in listed.split('\0').filter(|e| !e.is_empty()) {
        let (key, value) = entry.split_once('\n').unwrap_or((entry, ""));
        let lower = key.to_ascii_lowercase();
        let last = lower.rsplit('.').next().unwrap_or("");
        let program = (lower.starts_with("filter.") && matches!(last, "clean" | "smudge" | "process"))
            || (lower.starts_with("diff.") && matches!(last, "textconv" | "command"))
            || (lower.starts_with("merge.") && last == "driver");
        if program && !is_git_lfs_filter(key, value) {
            return Err(format!(
                "this repository's own git config sets `{key}`, which makes git run a program on the files it stages or checks out; Jan does not snapshot or check out this repository, so undo is not available for it. Remove that setting to restore it."
            ));
        }
    }
    Ok(())
}

/// Refuse a repository whose own config names a program for git to run.
pub(crate) fn refuse_program_config(repo: &Path) -> Result<(), VcsError> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(["config", "--local", "--includes", "--list", "-z"]);
    jan_utils::system::hide_console_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| VcsError::new(VcsErrorKind::GitUnavailable, format!("git would not run: {e}")))?;
    // No local config at all (not a repository) is for the caller to report.
    let listed = String::from_utf8_lossy(&out.stdout);
    for entry in listed.split('\0').filter(|e| !e.is_empty()) {
        let (key, value) = entry.split_once('\n').unwrap_or((entry, ""));
        if runs_a_program(key, value) {
            return Err(VcsError::new(
                VcsErrorKind::WouldDiscard,
                format!(
                    "this repository's own git config sets `{key}`, which makes git run a program; Jan's git tools do not run in it. Remove that setting, or use git yourself."
                ),
            ));
        }
    }
    Ok(())
}

fn git(repo: &Path, args: &[&str]) -> Result<String, VcsError> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(HARDENED)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    jan_utils::system::hide_console_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| VcsError::new(VcsErrorKind::GitUnavailable, format!("git would not run: {e}")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        Err(VcsError::new(
            VcsErrorKind::GitFailed,
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ))
    }
}

/// Where a branch stands relative to the remote it tracks.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Standing {
    /// The same commit.
    InSync,
    /// Local commits the remote does not have.
    Ahead,
    /// Remote commits this branch does not have.
    Behind,
    /// Both, which is the case that destroys work when guessed at.
    Diverged,
    /// The branch tracks nothing.
    NoUpstream,
    /// There is no branch: `HEAD` is detached.
    Detached,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Divergence {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub standing: Standing,
    /// Whether the working tree has changes that are not committed. A move
    /// that is safe for a clean tree is not necessarily safe for this one.
    pub dirty: bool,
    /// What can be done from here that loses nothing, in the order worth
    /// trying. Never contains a force push or a hard reset: if the only way
    /// forward discards commits, this says so and stops.
    pub options: Vec<String>,
    /// Set when every way forward would discard work, so the answer is "ask a
    /// person", not a command.
    pub needs_a_person: bool,
}

/// Read how far a branch and its upstream have drifted.
///
/// Reads only what is already fetched. It does not fetch: a function that
/// reaches the network as a side effect of being asked a question is one that
/// cannot be called from anywhere careful.
pub fn divergence(repo: &Path) -> Result<Divergence, VcsError> {
    if git(repo, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err(VcsError::new(
            VcsErrorKind::NotARepo,
            "there is no git work tree here",
        ));
    }
    let dirty = !git(repo, &["status", "--porcelain"])?.trim().is_empty();
    let branch = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty() && b != "HEAD");
    let Some(branch) = branch else {
        return Ok(Divergence {
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            standing: Standing::Detached,
            dirty,
            options: vec![
                "HEAD is detached: put these commits on a branch before anything else, \
                 with `git switch -c <name>`"
                    .to_string(),
            ],
            needs_a_person: false,
        });
    };
    let upstream = git(repo, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .ok()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());
    let Some(upstream) = upstream else {
        return Ok(Divergence {
            branch: Some(branch.clone()),
            upstream: None,
            ahead: 0,
            behind: 0,
            standing: Standing::NoUpstream,
            dirty,
            options: vec![format!(
                "`{branch}` tracks nothing: `git push -u <remote> {branch}` publishes it \
                 without touching anything that exists"
            )],
            needs_a_person: false,
        });
    };

    let counts = git(repo, &["rev-list", "--left-right", "--count", "@{u}...HEAD"])?;
    let mut parts = counts.split_whitespace();
    let behind: usize = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let ahead: usize = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);

    let standing = match (ahead, behind) {
        (0, 0) => Standing::InSync,
        (_, 0) => Standing::Ahead,
        (0, _) => Standing::Behind,
        _ => Standing::Diverged,
    };
    let mut options = Vec::new();
    match standing {
        Standing::InSync => options.push("nothing to do: the branch and its remote agree".into()),
        Standing::Ahead => options.push(format!(
            "`git push` sends the {ahead} commit(s) `{upstream}` does not have; nothing is \
             overwritten because it has nothing you do not"
        )),
        Standing::Behind => {
            if dirty {
                options.push(
                    "commit or stash the working tree first: a fast-forward will not run over \
                     uncommitted changes"
                        .into(),
                );
            }
            options.push(format!(
                "`git merge --ff-only {upstream}` takes the {behind} commit(s) you are missing \
                 and cannot lose anything, because you have no commits of your own here"
            ));
        }
        Standing::Diverged => {
            options.push(format!(
                "both sides moved: {ahead} commit(s) here, {behind} on `{upstream}`. \
                 `git merge {upstream}` keeps both histories"
            ));
            options.push(format!(
                "or `git rebase {upstream}` replays your {ahead} commit(s) on top -- it rewrites \
                 them, so only do it if they have not been shared"
            ));
            options.push(
                "what is deliberately not offered: a force push, which would delete the \
                 commits on the remote that are not here"
                    .into(),
            );
        }
        Standing::NoUpstream | Standing::Detached => {}
    }
    Ok(Divergence {
        branch: Some(branch),
        upstream: Some(upstream),
        ahead,
        behind,
        standing,
        dirty,
        // A rebase rewrites and a merge does not, so neither is "the only way
        // is to discard" -- but a diverged branch is never resolved without a
        // decision about which of those the project wants.
        needs_a_person: standing == Standing::Diverged,
        options,
    })
}

/// Refuse, in one place, the operations whose whole purpose is to overwrite
/// somebody else's work (AH-171).
///
/// Called where a caller could otherwise assemble one: it is a typed refusal
/// rather than a missing feature, so the run says why instead of quietly
/// having no way to do it.
pub fn refuse_overwrite(operation: &str) -> VcsError {
    VcsError::new(
        VcsErrorKind::WouldDiscard,
        format!(
            "{operation} would delete commits that exist only on the remote. The harness does \
             not do that on its own: merge, rebase, or ask the person whose commits they are."
        ),
    )
}

/// What kind of conflict one file is in.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictKind {
    /// Both sides changed the same file.
    BothChanged,
    /// One side deleted it while the other changed it. Resolving this by
    /// picking a side deletes work either way, so it is named separately.
    DeletedByThem,
    DeletedByUs,
    /// Both sides added a file with the same name.
    BothAdded,
    /// Not text: there are no regions to show, only a choice of side.
    Binary,
}

/// One conflicting region of a file.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// The line the `<<<<<<<` marker is on, 1-based, in the file as it stands.
    pub at: usize,
    pub ours: Vec<String>,
    pub theirs: Vec<String>,
    /// Set when either side was longer than what is kept here.
    pub truncated: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub path: String,
    pub kind: ConflictKind,
    pub hunks: Vec<Hunk>,
    /// Set when the file has more conflicting regions than are listed.
    pub truncated: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergeState {
    /// Whether a merge, rebase or cherry-pick is in progress at all.
    pub in_progress: bool,
    pub files: Vec<Conflict>,
    /// Set when there are more conflicted files than are listed.
    pub truncated: bool,
    /// Said plainly, because the safe move depends on it: nothing here
    /// resolves anything, and neither `--ours` nor `--theirs` is a default.
    pub note: String,
}

/// Read a stopped merge.
pub fn conflicts(repo: &Path) -> Result<MergeState, VcsError> {
    if git(repo, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err(VcsError::new(
            VcsErrorKind::NotARepo,
            "there is no git work tree here",
        ));
    }
    // `ls-files -u` lists the unmerged index entries: stage 1 is the common
    // ancestor, 2 ours, 3 theirs. Which stages are present is what says
    // whether a side deleted the file.
    let unmerged = git(repo, &["ls-files", "-u"])?;
    let mut stages: std::collections::BTreeMap<String, Vec<u8>> = Default::default();
    for line in unmerged.lines() {
        let Some((meta, path)) = line.split_once('\t') else { continue };
        let stage = meta.split_whitespace().last().and_then(|s| s.parse::<u8>().ok());
        if let Some(stage) = stage {
            stages.entry(path.to_string()).or_default().push(stage);
        }
    }
    let in_progress = !stages.is_empty()
        || repo.join(".git").join("MERGE_HEAD").exists()
        || repo.join(".git").join("REBASE_HEAD").exists();

    let mut files = Vec::new();
    let truncated = stages.len() > MAX_FILES;
    for (path, stages) in stages.into_iter().take(MAX_FILES) {
        let has_ours = stages.contains(&2);
        let has_theirs = stages.contains(&3);
        let has_base = stages.contains(&1);
        let kind = match (has_base, has_ours, has_theirs) {
            (_, true, false) => ConflictKind::DeletedByThem,
            (_, false, true) => ConflictKind::DeletedByUs,
            (false, true, true) => ConflictKind::BothAdded,
            _ => ConflictKind::BothChanged,
        };
        let full = repo.join(&path);
        let text = std::fs::read(&full).unwrap_or_default();
        let binary = text.contains(&0);
        let (kind, hunks, file_truncated) = if binary {
            (ConflictKind::Binary, Vec::new(), false)
        } else {
            let (hunks, cut) = parse_markers(&String::from_utf8_lossy(&text));
            (kind, hunks, cut)
        };
        files.push(Conflict { path, kind, hunks, truncated: file_truncated });
    }

    Ok(MergeState {
        in_progress,
        files,
        truncated,
        note: "nothing here is resolved: these are the regions as they stand. Taking one \
               side wholesale discards the other, so each region is a decision."
            .to_string(),
    })
}

/// Read the conflict markers a stopped merge left in a file.
fn parse_markers(text: &str) -> (Vec<Hunk>, bool) {
    let mut hunks = Vec::new();
    let mut truncated = false;
    let mut ours: Vec<String> = Vec::new();
    let mut theirs: Vec<String> = Vec::new();
    let mut at = 0usize;
    let mut side = 0u8; // 0 outside, 1 ours, 2 theirs
    let mut cut_here = false;
    for (index, line) in text.lines().enumerate() {
        if line.starts_with("<<<<<<<") {
            side = 1;
            at = index + 1;
            ours.clear();
            theirs.clear();
            cut_here = false;
            continue;
        }
        if side != 0 && line.starts_with("=======") {
            side = 2;
            continue;
        }
        if side != 0 && line.starts_with(">>>>>>>") {
            if hunks.len() >= MAX_HUNKS {
                truncated = true;
                side = 0;
                continue;
            }
            hunks.push(Hunk {
                at,
                ours: std::mem::take(&mut ours),
                theirs: std::mem::take(&mut theirs),
                truncated: cut_here,
            });
            side = 0;
            continue;
        }
        match side {
            1 if ours.len() < MAX_SIDE_LINES => ours.push(line.to_string()),
            2 if theirs.len() < MAX_SIDE_LINES => theirs.push(line.to_string()),
            1 | 2 => cut_here = true,
            _ => {}
        }
    }
    (hunks, truncated)
}

// ---- AH-161: branches, through something other than a shell command --------

/// The most branches listed.
pub const MAX_BRANCHES: usize = 500;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    /// Whether this is the branch the working tree is on.
    pub current: bool,
    /// The upstream it tracks, when it tracks one.
    #[serde(default)]
    pub upstream: Option<String>,
    /// Set when another worktree of this repository has it checked out, which
    /// is what makes switching to it refuse rather than fail obscurely.
    pub checked_out_elsewhere: bool,
}

/// The branches this repository has.
pub fn branches(repo: &Path) -> Result<Vec<Branch>, VcsError> {
    if git(repo, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err(VcsError::new(VcsErrorKind::NotARepo, "there is no git work tree here"));
    }
    // `worktree list --porcelain` says which branch each checkout holds, so a
    // branch another worktree is on can be named as such instead of being
    // offered and then refused by git.
    let held: Vec<String> = git(repo, &["worktree", "list", "--porcelain"])
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.strip_prefix("branch refs/heads/"))
        .map(str::to_string)
        .collect();
    let current = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let listed = git(
        repo,
        &["for-each-ref", "--format=%(refname:short)%09%(upstream:short)", "refs/heads"],
    )?;
    Ok(listed
        .lines()
        .take(MAX_BRANCHES)
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let name = parts.next()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            let upstream = parts.next().map(str::trim).filter(|u| !u.is_empty()).map(str::to_string);
            Some(Branch {
                current: name == current,
                checked_out_elsewhere: held.contains(&name) && name != current,
                name,
                upstream,
            })
        })
        .collect())
}

/// Whether a name is one this will act on.
///
/// Deliberately narrower than git's own rules: no leading dash (which git
/// would read as a flag), no `..`, no spaces, no ref punctuation. A name this
/// refuses is a name somebody can retype; a name that turns into an argument
/// is a bug that deletes something.
fn usable_branch_name(name: &str) -> Result<(), VcsError> {
    let name = name.trim();
    if name.is_empty() || name.len() > 200 {
        return Err(VcsError::new(
            VcsErrorKind::BadName,
            "a branch needs a name, of at most 200 characters",
        ));
    }
    let bad = name.starts_with('-')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.contains("..")
        || name.contains(char::is_whitespace)
        || name.contains(['~', '^', ':', '?', '*', '[', '\\'])
        || name.chars().any(|c| c.is_control());
    if bad {
        return Err(VcsError::new(
            VcsErrorKind::BadName,
            format!("{name:?} is not a branch name this will act on"),
        ));
    }
    Ok(())
}

/// What a branch operation did.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchChange {
    pub branch: String,
    /// The branch that was current before, when it changed.
    #[serde(default)]
    pub from: Option<String>,
    pub created: bool,
    /// What the caller should know, in one line.
    pub note: String,
}

/// Create a branch, or switch to one that exists.
///
/// What it will not do, each as a typed refusal rather than a missing case:
///
/// * overwrite a branch that exists (`git switch -C` is not reachable here);
/// * move onto a branch another worktree holds, which would take it from the
///   checkout that is using it;
/// * switch away from changes that are not committed -- git itself refuses a
///   switch that would lose them, and this refuses one that would *carry*
///   them somewhere the caller did not ask for;
/// * delete anything. There is no delete here at all: a branch is the only
///   record of work that is not merged yet.
pub fn switch_branch(repo: &Path, name: &str, create: bool) -> Result<BranchChange, VcsError> {
    refuse_program_config(repo)?;
    usable_branch_name(name)?;
    let name = name.trim();
    if git(repo, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err(VcsError::new(VcsErrorKind::NotARepo, "there is no git work tree here"));
    }
    let existing = branches(repo)?;
    let from = existing.iter().find(|b| b.current).map(|b| b.name.clone());
    let known = existing.iter().find(|b| b.name == name);

    match (create, known) {
        (true, Some(_)) => {
            return Err(VcsError::new(
                VcsErrorKind::WouldDiscard,
                format!(
                    "`{name}` already exists. Creating it again would move it, and whatever it \
                     points at now would be unreferenced; switch to it instead, or pick another \
                     name."
                ),
            ))
        }
        (false, None) => {
            return Err(VcsError::new(
                VcsErrorKind::NoBranch,
                format!("there is no branch called `{name}` here"),
            ))
        }
        (false, Some(branch)) if branch.checked_out_elsewhere => {
            return Err(VcsError::new(
                VcsErrorKind::WouldDiscard,
                format!("`{name}` is checked out in another worktree of this repository"),
            ))
        }
        _ => {}
    }

    let dirty = !git(repo, &["status", "--porcelain"])?.trim().is_empty();
    if dirty && !create {
        // Creating from here carries the changes onto the new branch, which is
        // the ordinary way to start work. Moving to a branch that already
        // exists carries them somewhere with its own history, which is rarely
        // what anybody meant.
        return Err(VcsError::new(
            VcsErrorKind::WouldDiscard,
            format!(
                "the working tree has changes that are not committed, so switching to `{name}` \
                 would carry them onto it. Commit or stash them first."
            ),
        ));
    }

    let args: Vec<&str> = if create {
        vec!["switch", "-c", name]
    } else {
        vec!["switch", name]
    };
    git(repo, &args)?;
    Ok(BranchChange {
        branch: name.to_string(),
        from,
        created: create,
        note: if create {
            format!("created `{name}` and switched to it")
        } else {
            format!("switched to `{name}`")
        },
    })
}

// ---- AH-159: a commit message drawn from the staged change ----------------

/// The most staged files listed, and the most diff characters shown.
pub const MAX_STAGED_FILES: usize = 100;
pub const MAX_DIFF_CHARS: usize = 24 * 1024;
/// What a subject line may be, by the convention nearly every project uses.
pub const MAX_SUBJECT: usize = 72;

/// The staged change, as the thing a message has to describe.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    /// Paths, relative, `/`-separated.
    pub files: Vec<String>,
    pub insertions: usize,
    pub deletions: usize,
    /// The diff itself, bounded and scrubbed -- the model writes the message,
    /// so it needs to see what changed rather than a summary of it.
    pub diff: String,
    /// Set when the diff was cut, so nothing claims to have read all of it.
    pub truncated: bool,
    /// Files that are changed but *not* staged. Named because a message that
    /// describes them would be describing work this commit does not contain.
    pub unstaged: Vec<String>,
}

/// Read what is staged.
pub fn staged(repo: &Path) -> Result<Staged, VcsError> {
    if git(repo, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err(VcsError::new(VcsErrorKind::NotARepo, "there is no git work tree here"));
    }
    let names = git(repo, &["diff", "--cached", "--name-only"])?;
    let files: Vec<String> = names
        .lines()
        .map(|l| l.trim().replace('\\', "/"))
        .filter(|l| !l.is_empty())
        .take(MAX_STAGED_FILES)
        .collect();
    if files.is_empty() {
        return Err(VcsError::new(
            VcsErrorKind::NothingStaged,
            "nothing is staged, so there is no change for a message to describe",
        ));
    }
    let stat = git(repo, &["diff", "--cached", "--shortstat"]).unwrap_or_default();
    let number_before = |word: &str| -> usize {
        stat.split(',')
            .find(|part| part.contains(word))
            .and_then(|part| part.trim().split_whitespace().next()?.parse().ok())
            .unwrap_or(0)
    };
    let raw = git(repo, &["diff", "--cached"]).unwrap_or_default();
    let scrubbed = tauri_plugin_agent_tools::harness_error::scrub(&raw);
    let kept: String = scrubbed.chars().take(MAX_DIFF_CHARS).collect();
    let truncated = kept.chars().count() < scrubbed.chars().count();
    let unstaged: Vec<String> = git(repo, &["diff", "--name-only"])
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().replace('\\', "/"))
        .filter(|l| !l.is_empty())
        .take(MAX_STAGED_FILES)
        .collect();
    Ok(Staged {
        files,
        insertions: number_before("insertion"),
        deletions: number_before("deletion"),
        diff: kept,
        truncated,
        unstaged,
    })
}

/// What a message has to be before it is worth offering.
///
/// Not a style opinion: each of these is a message that would be wrong about
/// the commit. An empty subject says nothing; an over-long one is truncated by
/// every tool that shows it; a message naming a file that is not in this
/// commit describes work the commit does not contain, which is the failure
/// that matters -- a model summarising the *branch* rather than the change.
pub fn check_message(message: &str, staged: &Staged) -> Result<String, VcsError> {
    let trimmed = message.trim();
    let mut lines = trimmed.lines();
    let subject = lines.next().unwrap_or_default().trim();
    if subject.is_empty() {
        return Err(VcsError::new(
            VcsErrorKind::BadMessage,
            "a commit message needs a subject line",
        ));
    }
    if subject.chars().count() > MAX_SUBJECT {
        return Err(VcsError::new(
            VcsErrorKind::BadMessage,
            format!(
                "the subject is {} characters; {MAX_SUBJECT} is what git and every tool that \
                 shows a log will display",
                subject.chars().count()
            ),
        ));
    }
    if let Some(second) = trimmed.lines().nth(1) {
        if !second.trim().is_empty() {
            return Err(VcsError::new(
                VcsErrorKind::BadMessage,
                "the line after the subject must be blank, or the body is read as part of it",
            ));
        }
    }
    // A path in the message that is not in the commit.
    let staged_set: std::collections::BTreeSet<&str> =
        staged.files.iter().map(String::as_str).collect();
    for word in trimmed.split(|c: char| c.is_whitespace() || c == '`' || c == '(' || c == ')') {
        let candidate = word.trim_matches(|c: char| c == ',' || c == '.' || c == ':' || c == ';');
        let looks_like_path = candidate.contains('/') && candidate.contains('.');
        if !looks_like_path || staged_set.contains(candidate) {
            continue;
        }
        if staged.unstaged.iter().any(|u| u == candidate) {
            return Err(VcsError::new(
                VcsErrorKind::BadMessage,
                format!(
                    "the message names {candidate:?}, which is changed but not staged: this \
                     commit does not contain it"
                ),
            ));
        }
    }
    if tauri_plugin_agent_tools::harness_error::scrub(trimmed) != trimmed {
        return Err(VcsError::new(
            VcsErrorKind::BadMessage,
            "the message carries something that looks like a credential",
        ));
    }
    Ok(trimmed.to_string())
}

/// What a run is told when it is asked to write the message.
pub fn message_brief(staged: &Staged) -> String {
    let mut out = format!(
        "{} file(s) staged, +{} -{}{}:\n",
        staged.files.len(),
        staged.insertions,
        staged.deletions,
        if staged.truncated { " (diff shown in part)" } else { "" }
    );
    for file in &staged.files {
        out.push_str(&format!("  {file}\n"));
    }
    if !staged.unstaged.is_empty() {
        out.push_str(
            "\nChanged and NOT staged -- this commit does not contain these, so do not \
             describe them:\n",
        );
        for file in &staged.unstaged {
            out.push_str(&format!("  {file}\n"));
        }
    }
    out.push_str("\nThe staged diff:\n");
    out.push_str(&staged.diff);
    out
}

// ---- AH-160: one large change split into coherent commits -------------------

/// One commit of a split: the files it takes and the message it gets.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SplitGroup {
    pub files: Vec<String>,
    pub message: String,
}

/// What a split did.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SplitOutcome {
    /// The commits made, in order: short id and subject.
    pub commits: Vec<(String, String)>,
    /// Changed files no group took; still changed, not committed.
    pub left_uncommitted: Vec<String>,
    /// Set when the split stopped before every group was committed.
    pub stopped: Option<String>,
}

fn normalized(file: &str) -> String {
    file.trim().replace('\\', "/")
}

/// Every path the working tree has changed, relative and `/`-separated,
/// renames by their new name.
fn changed_paths(repo: &Path) -> Result<Vec<String>, VcsError> {
    let status = git(repo, &["status", "--porcelain=v1", "--untracked-files=all", "-z"])?;
    let mut paths = Vec::new();
    let mut entries = status.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }
        let code = &entry[..2];
        paths.push(normalized(&entry[3..]));
        // A rename or copy is followed by its old name, which is not a
        // separate change.
        if code.starts_with('R') || code.starts_with('C') {
            entries.next();
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// Check a split before anything is staged or committed.
///
/// Refused: fewer than two groups, a group with no files, a file that is not
/// changed here or that looks like an option, a file in two groups, a message
/// that fails [`check_message`] against its own group -- and anything already
/// staged, because a split commits its groups one at a time from an empty
/// index and staged work would be swept into the first commit without anyone
/// choosing that. Returns the changed files no group takes.
pub fn check_split(repo: &Path, groups: &[SplitGroup]) -> Result<Vec<String>, VcsError> {
    if git(repo, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err(VcsError::new(VcsErrorKind::NotARepo, "there is no git work tree here"));
    }
    refuse_program_config(repo)?;
    if groups.len() < 2 {
        return Err(VcsError::new(
            VcsErrorKind::BadMessage,
            "a split needs at least two groups; one group is an ordinary commit",
        ));
    }
    if !git(repo, &["diff", "--cached", "--name-only"])?.trim().is_empty() {
        return Err(VcsError::new(
            VcsErrorKind::WouldDiscard,
            "something is already staged; a split commits its groups from an empty index, so it \
             would be swept into the first commit. Commit or unstage it first.",
        ));
    }
    let changed = changed_paths(repo)?;
    let mut taken: std::collections::BTreeMap<String, usize> = Default::default();
    for (index, group) in groups.iter().enumerate() {
        if group.files.is_empty() {
            return Err(VcsError::new(VcsErrorKind::BadMessage, format!("group {} takes no files", index + 1)));
        }
        let files: Vec<String> = group.files.iter().map(|f| normalized(f)).collect();
        for file in &files {
            if file.starts_with('-') || file.split('/').any(|part| part == "..") {
                return Err(VcsError::new(
                    VcsErrorKind::BadName,
                    format!("{file:?} is not a path this will hand to git"),
                ));
            }
            if !changed.contains(file) {
                return Err(VcsError::new(
                    VcsErrorKind::BadMessage,
                    format!("group {} names {file:?}, which is not changed here", index + 1),
                ));
            }
            if let Some(other) = taken.insert(file.clone(), index) {
                return Err(VcsError::new(
                    VcsErrorKind::BadMessage,
                    format!(
                        "{file:?} is in group {} and group {}; a change goes in one commit",
                        other + 1,
                        index + 1
                    ),
                ));
            }
        }
        // The message is checked against what this group's commit will
        // contain, so it cannot describe another group's files.
        let staged = Staged {
            files: files.clone(),
            insertions: 0,
            deletions: 0,
            diff: String::new(),
            truncated: false,
            unstaged: changed.iter().filter(|c| !files.contains(c)).cloned().collect(),
        };
        check_message(&group.message, &staged)
            .map_err(|e| VcsError::new(e.kind, format!("group {}: {}", index + 1, e.message)))?;
    }
    Ok(changed.into_iter().filter(|c| !taken.contains_key(c)).collect())
}

/// Commit each group in order. Stops between commits when `cancelled`; a group
/// that fails to commit is unstaged again (the index only -- the working tree
/// is never touched) and nothing after it is tried.
pub fn apply_split(
    repo: &Path,
    groups: &[SplitGroup],
    cancelled: &dyn Fn() -> bool,
) -> Result<SplitOutcome, VcsError> {
    let left_uncommitted = check_split(repo, groups)?;
    let mut outcome = SplitOutcome { commits: Vec::new(), left_uncommitted, stopped: None };
    for (index, group) in groups.iter().enumerate() {
        if cancelled() {
            outcome.stopped = Some(format!(
                "stopped before group {}; its files are still changed and uncommitted",
                index + 1
            ));
            break;
        }
        let files: Vec<String> = group.files.iter().map(|f| normalized(f)).collect();
        let mut add = vec!["add", "--"];
        add.extend(files.iter().map(String::as_str));
        let committed = git(repo, &add).and_then(|_| git(repo, &["commit", "-q", "-m", group.message.trim()]));
        if let Err(e) = committed {
            let _ = git(repo, &["reset", "-q"]);
            outcome.stopped = Some(format!(
                "group {} could not be committed ({}); it was unstaged and nothing after it was tried",
                index + 1,
                e.message
            ));
            return Ok(outcome);
        }
        let id = git(repo, &["rev-parse", "--short", "HEAD"])?;
        let subject = group.message.trim().lines().next().unwrap_or("").to_string();
        outcome.commits.push((id, subject));
    }
    Ok(outcome)
}

pub fn render_split(outcome: &SplitOutcome) -> String {
    let mut out = String::new();
    for (id, subject) in &outcome.commits {
        out.push_str(&format!("committed {id} {subject}\n"));
    }
    if !outcome.left_uncommitted.is_empty() {
        out.push_str(&format!(
            "left uncommitted (no group took them): {}\n",
            outcome.left_uncommitted.join(", ")
        ));
    }
    if let Some(stopped) = &outcome.stopped {
        out.push_str(&format!("stopped: {stopped}\n"));
    }
    out.trim_end().to_string()
}

// ---- AH-166 / AH-167: rebase and cherry-pick that can always be undone ------

/// Where a guided rebase or cherry-pick stands.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryOp {
    /// `rebase` or `cherry-pick`.
    pub operation: String,
    /// `done`, `conflicted` or `aborted`.
    pub state: String,
    /// The ref that records where the branch was before anything moved.
    pub backup: String,
    pub head: String,
    pub conflicts: Option<MergeState>,
    pub note: String,
}

const BACKUP_PREFIX: &str = "refs/jan/backup/";
/// Where a finished operation left the branch, named like its backup.
const AFTER_PREFIX: &str = "refs/jan/after/";

fn after_ref(backup: &str) -> String {
    format!("{AFTER_PREFIX}{}", backup.trim().trim_start_matches(BACKUP_PREFIX))
}

/// Branches a guided rebase will not rewrite: the conventional long-lived ones
/// and whatever the remote says is its default.
fn protected(repo: &Path, branch: &str) -> bool {
    if ["main", "master", "trunk", "develop"].contains(&branch) {
        return true;
    }
    git(repo, &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
        .map(|r| r.trim().rsplit('/').next() == Some(branch))
        .unwrap_or(false)
}

/// A ref name or commit id handed to git as an argument, never as an option.
fn usable_revision(rev: &str) -> Result<String, VcsError> {
    let rev = rev.trim();
    if rev.len() >= 7 && rev.len() <= 40 && rev.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(rev.to_string());
    }
    usable_branch_name(rev).map(|_| rev.to_string())
}

fn current_branch(repo: &Path) -> Result<String, VcsError> {
    git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]).map_err(|_| {
        VcsError::new(
            VcsErrorKind::WouldDiscard,
            "HEAD is detached; a guided rebase or cherry-pick needs a branch to move",
        )
    })
}

/// Which history operation is stopped here, read from git's own state files
/// (through `--git-path`, so a linked worktree is read correctly).
fn in_progress(repo: &Path) -> Option<&'static str> {
    let exists = |name: &str| {
        git(repo, &["rev-parse", "--git-path", name])
            .map(|p| {
                let p = std::path::PathBuf::from(p.trim());
                if p.is_absolute() { p } else { repo.join(p) }
            })
            .is_ok_and(|p| p.exists())
    };
    if exists("rebase-merge") || exists("rebase-apply") {
        Some("rebase")
    } else if exists("CHERRY_PICK_HEAD") {
        Some("cherry-pick")
    } else if exists("MERGE_HEAD") {
        Some("merge")
    } else {
        None
    }
}

fn require_clean(repo: &Path, what: &str) -> Result<(), VcsError> {
    if git(repo, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err(VcsError::new(VcsErrorKind::NotARepo, "there is no git work tree here"));
    }
    refuse_program_config(repo)?;
    if let Some(op) = in_progress(repo) {
        return Err(VcsError::new(
            VcsErrorKind::WouldDiscard,
            format!("a {op} is already in progress here; continue or abort it first"),
        ));
    }
    if !git(repo, &["status", "--porcelain"])?.trim().is_empty() {
        return Err(VcsError::new(
            VcsErrorKind::WouldDiscard,
            format!(
                "the working tree has uncommitted changes; {what} would mix them into history or \
                 lose them. Commit or stash them first."
            ),
        ));
    }
    Ok(())
}

/// Write the backup ref before anything moves.
fn write_backup(repo: &Path, operation: &str, branch: &str) -> Result<String, VcsError> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = format!("{BACKUP_PREFIX}{operation}/{branch}/{millis}");
    git(repo, &["update-ref", &name, "HEAD"])?;
    Ok(name)
}

/// The operation and branch a backup ref this module wrote belongs to.
fn parse_backup(backup: &str) -> Result<(&'static str, String), VcsError> {
    let bad = || {
        VcsError::new(
            VcsErrorKind::BadName,
            format!("{backup:?} is not a backup a guided rebase or cherry-pick made"),
        )
    };
    let rest = backup.trim().strip_prefix(BACKUP_PREFIX).ok_or_else(bad)?;
    let (operation, rest) = if let Some(rest) = rest.strip_prefix("rebase/") {
        ("rebase", rest)
    } else if let Some(rest) = rest.strip_prefix("cherry-pick/") {
        ("cherry-pick", rest)
    } else {
        return Err(bad());
    };
    let (branch, stamp) = rest.rsplit_once('/').ok_or_else(bad)?;
    if stamp.is_empty() || !stamp.chars().all(|c| c.is_ascii_digit()) {
        return Err(bad());
    }
    usable_branch_name(branch).map_err(|_| bad())?;
    Ok((operation, branch.to_string()))
}

/// git with no editor: continuing a rebase or a cherry-pick never opens one.
fn git_no_editor(repo: &Path, args: &[&str]) -> Result<String, VcsError> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(HARDENED)
        .args(["-c", "core.editor=true"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true");
    jan_utils::system::hide_console_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| VcsError::new(VcsErrorKind::GitUnavailable, format!("git would not run: {e}")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        Err(VcsError::new(
            VcsErrorKind::GitFailed,
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ))
    }
}

fn op_state(repo: &Path, operation: &str, backup: String, note: &str) -> Result<HistoryOp, VcsError> {
    let head = git(repo, &["rev-parse", "--short", "HEAD"]).unwrap_or_default();
    let stopped = in_progress(repo).is_some();
    if !stopped {
        // R19: remember where the finished operation left the branch, so an
        // undo can tell its own result from work made afterwards.
        git(repo, &["update-ref", &after_ref(&backup), "HEAD"])?;
    }
    Ok(HistoryOp {
        operation: operation.to_string(),
        state: if stopped { "conflicted" } else { "done" }.to_string(),
        backup,
        head,
        conflicts: if stopped { Some(conflicts(repo)?) } else { None },
        note: note.to_string(),
    })
}

/// Start a guided rebase of the current branch onto `onto`.
///
/// Refused: a dirty tree, a detached HEAD, an operation already in progress, a
/// shared branch, a target that is not a commit, and -- the one that rewrites
/// other people's history -- a branch whose commits being rebased are already
/// on its upstream.
pub fn rebase_start(repo: &Path, onto: &str) -> Result<HistoryOp, VcsError> {
    let onto = usable_revision(onto)?;
    require_clean(repo, "a rebase")?;
    let branch = current_branch(repo)?;
    if protected(repo, &branch) {
        return Err(VcsError::new(
            VcsErrorKind::WouldDiscard,
            format!("`{branch}` is a shared branch; rewriting its history is not something a guided rebase does"),
        ));
    }
    git(repo, &["rev-parse", "--verify", "--quiet", &format!("{onto}^{{commit}}")])
        .map_err(|_| VcsError::new(VcsErrorKind::NoBranch, format!("`{onto}` is not a commit here")))?;
    let rewritten = git(repo, &["rev-list", &format!("{onto}..HEAD")])?;
    if let Ok(upstream) = git(repo, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) {
        let pushed = git(repo, &["rev-list", "@{u}"]).unwrap_or_default();
        let pushed: std::collections::BTreeSet<&str> = pushed.lines().collect();
        if rewritten.lines().any(|c| pushed.contains(c)) {
            return Err(VcsError::new(
                VcsErrorKind::WouldDiscard,
                format!(
                    "some of the commits this would rewrite are already on `{upstream}`; rebasing \
                     them would rewrite history other people may have"
                ),
            ));
        }
    }
    let backup = write_backup(repo, "rebase", &branch)?;
    let _ = git_no_editor(repo, &["rebase", "--no-autostash", &onto]);
    op_state(
        repo,
        "rebase",
        backup,
        "The backup ref records where the branch was; abort with it returns the branch there exactly.",
    )
}

/// Port one commit onto the current branch, recording where it came from.
pub fn cherry_pick(repo: &Path, commit: &str) -> Result<HistoryOp, VcsError> {
    let commit = usable_revision(commit)?;
    require_clean(repo, "a cherry-pick")?;
    let branch = current_branch(repo)?;
    git(repo, &["rev-parse", "--verify", "--quiet", &format!("{commit}^{{commit}}")])
        .map_err(|_| VcsError::new(VcsErrorKind::NoBranch, format!("`{commit}` is not a commit here")))?;
    let backup = write_backup(repo, "cherry-pick", &branch)?;
    let _ = git_no_editor(repo, &["cherry-pick", "-x", &commit]);
    op_state(
        repo,
        "cherry-pick",
        backup,
        "The backup ref records where the branch was; abort with it returns the branch there exactly.",
    )
}

/// Continue a stopped rebase or cherry-pick once its conflicts are resolved
/// and staged.
pub fn continue_op(repo: &Path, backup: &str) -> Result<HistoryOp, VcsError> {
    let (operation, _) = parse_backup(backup)?;
    refuse_program_config(repo)?;
    if in_progress(repo) != Some(operation) {
        return Err(VcsError::new(
            VcsErrorKind::NoBranch,
            format!("no {operation} is stopped here to continue"),
        ));
    }
    let state = conflicts(repo)?;
    if !state.files.is_empty() {
        return Err(VcsError::new(
            VcsErrorKind::WouldDiscard,
            format!(
                "{} file(s) still have conflicts ({}); resolve and stage them before continuing",
                state.files.len(),
                state.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>().join(", ")
            ),
        ));
    }
    if let Err(e) = git_no_editor(repo, &[operation, "--continue"]) {
        if in_progress(repo).is_none() {
            return Err(e);
        }
    }
    op_state(repo, operation, backup.trim().to_string(), "continued")
}

/// Abandon a rebase or cherry-pick -- or undo a finished one -- and put the
/// branch back where its backup says it was. Verified, not assumed.
pub fn abort_op(repo: &Path, backup: &str) -> Result<HistoryOp, VcsError> {
    let (operation, branch) = parse_backup(backup)?;
    refuse_program_config(repo)?;
    let backup = backup.trim();
    let expected = git(repo, &["rev-parse", "--verify", "--quiet", backup])
        .map_err(|_| VcsError::new(VcsErrorKind::NoBranch, format!("the backup {backup} does not exist")))?;
    if in_progress(repo) == Some(operation) {
        let _ = git_no_editor(repo, &[operation, "--abort"]);
    }
    let current = current_branch(repo)?;
    if current != branch {
        return Err(VcsError::new(
            VcsErrorKind::WouldDiscard,
            format!("the backup is for `{branch}` but HEAD is on `{current}`; nothing was reset"),
        ));
    }
    let head_now = git(repo, &["rev-parse", "HEAD"])?;
    if head_now != expected {
        // Undoing a finished operation: only while the branch is still exactly
        // where the operation left it. Anything else is later work.
        match git(repo, &["rev-parse", "--verify", "--quiet", &after_ref(backup)]) {
            Ok(after) if after == head_now => {}
            Ok(_) => {
                return Err(VcsError::new(
                    VcsErrorKind::WouldDiscard,
                    format!(
                        "`{branch}` has moved since the {operation} finished; returning to the backup would drop that later work from the branch. Nothing was reset."
                    ),
                ))
            }
            Err(_) => {
                return Err(VcsError::new(
                    VcsErrorKind::WouldDiscard,
                    format!(
                        "there is no record of where the {operation} left `{branch}`, so its result cannot be told from later work; nothing was reset"
                    ),
                ))
            }
        }
    }
    if head_now != expected {
        if !git(repo, &["status", "--porcelain"])?.trim().is_empty() {
            return Err(VcsError::new(
                VcsErrorKind::WouldDiscard,
                "the working tree has uncommitted changes that returning to the backup would lose; nothing was reset",
            ));
        }
        git(repo, &["reset", "-q", "--keep", &expected])?;
    }
    let head = git(repo, &["rev-parse", "HEAD"])?;
    if head != expected {
        return Err(VcsError::new(
            VcsErrorKind::GitFailed,
            format!("HEAD is {head}, not the backup {expected}; nothing further was changed"),
        ));
    }
    Ok(HistoryOp {
        operation: operation.to_string(),
        state: "aborted".to_string(),
        backup: backup.to_string(),
        head: head.chars().take(12).collect(),
        conflicts: None,
        note: "The branch is back exactly where it was before the operation started.".to_string(),
    })
}

/// What is stopped here, and the backups that can undo earlier operations.
pub fn history_status(repo: &Path) -> Result<String, VcsError> {
    if git(repo, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err(VcsError::new(VcsErrorKind::NotARepo, "there is no git work tree here"));
    }
    let mut out = match in_progress(repo) {
        Some(op) => {
            let state = conflicts(repo)?;
            format!(
                "a {op} is stopped here with {} conflicted file(s){}.\n",
                state.files.len(),
                if state.files.is_empty() {
                    String::new()
                } else {
                    format!(": {}", state.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>().join(", "))
                }
            )
        }
        None => "no rebase or cherry-pick is in progress.\n".to_string(),
    };
    let refs = git(
        repo,
        &["for-each-ref", "--sort=-creatordate", "--count=10", "--format=%(refname) %(objectname:short)", BACKUP_PREFIX],
    )?;
    if refs.trim().is_empty() {
        out.push_str("no backups.");
    } else {
        out.push_str("backups, newest first (abort with one to return its branch there):\n");
        out.push_str(refs.trim());
    }
    Ok(out)
}

pub fn render_op(op: &HistoryOp) -> String {
    let mut out = format!(
        "{} {}: HEAD is {}; backup {} .",
        op.operation, op.state, op.head, op.backup
    );
    if let Some(state) = &op.conflicts {
        out.push_str(&format!(
            "\nConflicted files ({}): {}\nResolve and stage them, then call continue with this backup -- or abort with it to return exactly to where the branch was.",
            state.files.len(),
            state.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>().join(", ")
        ));
    }
    out.push('\n');
    out.push_str(&op.note);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn run(repo: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .expect("git runs in these tests");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn write(repo: &Path, name: &str, body: &str) {
        std::fs::write(repo.join(name), body).unwrap();
    }

    /// A repository with a remote it really tracks, so the upstream is a real
    /// upstream rather than a fixture's idea of one.
    fn pair(tag: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "jan-vcs-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let origin = base.join("origin.git");
        let work = base.join("work");
        std::fs::create_dir_all(&origin).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        run(&origin, &["init", "--bare", "-q", "-b", "main"]);
        run(&work, &["init", "-q", "-b", "main"]);
        run(&work, &["config", "user.email", "t@example.invalid"]);
        run(&work, &["config", "user.name", "Test"]);
        write(&work, "file.txt", "one\n");
        run(&work, &["add", "-A"]);
        run(&work, &["commit", "-qm", "first"]);
        run(&work, &["remote", "add", "origin", &origin.to_string_lossy()]);
        run(&work, &["push", "-q", "-u", "origin", "main"]);
        (base, work)
    }

    fn commit(repo: &Path, name: &str, body: &str, message: &str) {
        write(repo, name, body);
        run(repo, &["add", "-A"]);
        run(repo, &["commit", "-qm", message]);
    }

    #[test]
    fn a_branch_that_agrees_with_its_remote_says_so_and_proposes_nothing() {
        let (base, work) = pair("sync");
        let d = divergence(&work).unwrap();
        assert_eq!(d.standing, Standing::InSync);
        assert_eq!((d.ahead, d.behind), (0, 0));
        assert!(!d.needs_a_person);
        assert_eq!(d.upstream.as_deref(), Some("origin/main"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn ahead_and_behind_are_counted_separately_and_neither_is_a_problem() {
        let (base, work) = pair("ahead");
        commit(&work, "file.txt", "one\ntwo\n", "second");
        let ahead = divergence(&work).unwrap();
        assert_eq!(ahead.standing, Standing::Ahead);
        assert_eq!((ahead.ahead, ahead.behind), (1, 0));
        assert!(ahead.options.iter().any(|o| o.contains("git push")));
        assert!(!ahead.needs_a_person);

        // Push it, then move the remote on without us: now we are behind.
        run(&work, &["push", "-q"]);
        let other = work.parent().unwrap().join("other");
        run(
            work.parent().unwrap(),
            &["clone", "-q", &work.parent().unwrap().join("origin.git").to_string_lossy(), &other.to_string_lossy()],
        );
        run(&other, &["config", "user.email", "t@example.invalid"]);
        run(&other, &["config", "user.name", "Test"]);
        commit(&other, "file.txt", "one\ntwo\nthree\n", "third");
        run(&other, &["push", "-q"]);
        run(&work, &["fetch", "-q"]);
        let behind = divergence(&work).unwrap();
        assert_eq!(behind.standing, Standing::Behind);
        assert_eq!((behind.ahead, behind.behind), (0, 1));
        assert!(
            behind.options.iter().any(|o| o.contains("--ff-only")),
            "the move that cannot lose anything is the one offered: {:?}",
            behind.options
        );
        assert!(!behind.needs_a_person);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The case the whole feature exists for.
    #[test]
    fn a_diverged_branch_is_never_told_to_force_anything() {
        let (base, work) = pair("diverged");
        let other = work.parent().unwrap().join("other");
        run(
            work.parent().unwrap(),
            &["clone", "-q", &work.parent().unwrap().join("origin.git").to_string_lossy(), &other.to_string_lossy()],
        );
        run(&other, &["config", "user.email", "t@example.invalid"]);
        run(&other, &["config", "user.name", "Test"]);
        commit(&other, "file.txt", "one\ntheirs\n", "theirs");
        run(&other, &["push", "-q"]);

        commit(&work, "file.txt", "one\nours\n", "ours");
        run(&work, &["fetch", "-q"]);

        let d = divergence(&work).unwrap();
        assert_eq!(d.standing, Standing::Diverged);
        assert_eq!((d.ahead, d.behind), (1, 1));
        assert!(d.needs_a_person, "a diverged branch is a decision, not a command");
        let all = d.options.join(" ");
        assert!(all.contains("git merge"), "{all}");
        assert!(all.contains("git rebase"), "{all}");
        // Not as a last resort, not with a warning, not at all.
        assert!(
            !all.contains("push --force") && !all.contains("-f ") && !all.contains("reset --hard"),
            "an option that deletes the remote's commits was offered: {all}"
        );

        // And the refusal, where a caller tries to assemble one anyway.
        let refusal = refuse_overwrite("a force push");
        assert_eq!(refusal.kind, VcsErrorKind::WouldDiscard);
        let harness: tauri_plugin_agent_tools::harness_error::HarnessError = (&refusal).into();
        assert_eq!(
            harness.kind(),
            tauri_plugin_agent_tools::harness_error::ErrorKind::PolicyViolation
        );
        assert_eq!(
            harness.retry(),
            tauri_plugin_agent_tools::harness_error::Retry::Never,
            "asking again does not make it allowed"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_branch_with_no_upstream_and_a_detached_head_are_told_apart() {
        let (base, work) = pair("upstream");
        run(&work, &["switch", "-q", "-c", "side"]);
        let side = divergence(&work).unwrap();
        assert_eq!(side.standing, Standing::NoUpstream);
        assert_eq!(side.branch.as_deref(), Some("side"));
        assert!(side.options.iter().any(|o| o.contains("push -u")));

        let head = git(&work, &["rev-parse", "HEAD"]).unwrap();
        run(&work, &["checkout", "-q", &head]);
        let detached = divergence(&work).unwrap();
        assert_eq!(detached.standing, Standing::Detached);
        assert_eq!(detached.branch, None);
        assert!(detached.options.iter().any(|o| o.contains("switch -c")));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// AH-161: branches through something other than a shell command, with the
    /// refusals that a shell command would not give.
    #[test]
    fn a_branch_can_be_made_and_moved_to_and_nothing_is_overwritten() {
        let (base, work) = pair("branches");
        let listed = branches(&work).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].current && listed[0].name == "main");
        assert_eq!(listed[0].upstream.as_deref(), Some("origin/main"));

        let made = switch_branch(&work, "feature/one", true).unwrap();
        assert!(made.created && made.from.as_deref() == Some("main"));
        assert_eq!(
            git(&work, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim(),
            "feature/one"
        );

        // Creating it again would move it and orphan what it points at.
        let again = switch_branch(&work, "feature/one", true).unwrap_err();
        assert_eq!(again.kind, VcsErrorKind::WouldDiscard);
        let harness: tauri_plugin_agent_tools::harness_error::HarnessError = (&again).into();
        assert_eq!(
            harness.kind(),
            tauri_plugin_agent_tools::harness_error::ErrorKind::PolicyViolation
        );

        // Switching back works, and says where it came from.
        let back = switch_branch(&work, "main", false).unwrap();
        assert!(!back.created && back.from.as_deref() == Some("feature/one"));

        // A branch that is not here is not found, rather than created.
        let missing = switch_branch(&work, "no-such-branch", false).unwrap_err();
        assert_eq!(missing.kind, VcsErrorKind::NoBranch);
        assert!(branches(&work).unwrap().iter().all(|b| b.name != "no-such-branch"));

        // Uncommitted changes are not carried onto an existing branch.
        std::fs::write(work.join("file.txt"), "one\nchanged\n").unwrap();
        let dirty = switch_branch(&work, "feature/one", false).unwrap_err();
        assert_eq!(dirty.kind, VcsErrorKind::WouldDiscard);
        assert!(dirty.message.contains("not committed"), "{}", dirty.message);
        // But starting new work from them is the ordinary thing to do.
        assert!(switch_branch(&work, "feature/two", true).is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A name that would become an argument is refused before git sees it.
    #[test]
    fn a_name_that_is_really_a_flag_or_a_path_is_refused() {
        let (base, work) = pair("names");
        for hostile in [
            "--force",
            "-D",
            "a b",
            "a..b",
            "refs/heads/../../x",
            "a~1",
            "a:b",
            "",
            "   ",
        ] {
            let refused = switch_branch(&work, hostile, true).unwrap_err();
            assert_eq!(refused.kind, VcsErrorKind::BadName, "{hostile:?}");
        }
        // And nothing was created by any of them.
        assert_eq!(branches(&work).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A branch another checkout is using is named as such rather than taken
    /// from it.
    #[test]
    fn a_branch_another_worktree_holds_is_not_taken() {
        let (base, work) = pair("worktrees");
        run(&work, &["switch", "-q", "-c", "held"]);
        run(&work, &["switch", "-q", "main"]);
        let elsewhere = base.join("other-checkout");
        run(&work, &["worktree", "add", "-q", &elsewhere.to_string_lossy(), "held"]);

        let listed = branches(&work).unwrap();
        let held = listed.iter().find(|b| b.name == "held").expect("the branch is listed");
        assert!(held.checked_out_elsewhere, "{listed:?}");

        let refused = switch_branch(&work, "held", false).unwrap_err();
        assert_eq!(refused.kind, VcsErrorKind::WouldDiscard);
        assert!(refused.message.contains("another worktree"), "{}", refused.message);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// AH-159: the staged change is what the message describes, and a message
    /// about anything else is refused.
    #[test]
    fn a_message_is_checked_against_what_is_actually_staged() {
        let (base, work) = pair("commit-message");
        // Nothing staged yet.
        assert_eq!(staged(&work).unwrap_err().kind, VcsErrorKind::NothingStaged);

        std::fs::write(work.join("file.txt"), "one\ntwo\n").unwrap();
        std::fs::write(work.join("other.txt"), "untouched by this commit\n").unwrap();
        run(&work, &["add", "file.txt"]);

        let change = staged(&work).unwrap();
        assert_eq!(change.files, ["file.txt"]);
        assert!(change.insertions >= 1, "{change:?}");
        assert!(change.diff.contains("two"), "the diff is what changed: {}", change.diff);
        assert!(
            change.unstaged.iter().any(|f| f == "other.txt") || change.unstaged.is_empty(),
            "an untracked file is not a staged one: {:?}",
            change.unstaged
        );

        // A message that describes the commit is accepted.
        let good = check_message("fix(file): keep the second line\n\nIt was dropped.", &change)
            .expect("a message about this change");
        assert!(good.starts_with("fix(file)"));

        // The ones that would be wrong about it are not.
        assert_eq!(check_message("", &change).unwrap_err().kind, VcsErrorKind::BadMessage);
        assert_eq!(
            check_message(&"x".repeat(MAX_SUBJECT + 1), &change).unwrap_err().kind,
            VcsErrorKind::BadMessage
        );
        assert_eq!(
            check_message("subject\nbody with no blank line", &change).unwrap_err().kind,
            VcsErrorKind::BadMessage
        );
        let leaky = check_message(
            "chore: rotate\n\nAuthorization: Bearer sk-not-a-real-key-1234567890",
            &change,
        )
        .unwrap_err();
        assert_eq!(leaky.kind, VcsErrorKind::BadMessage);
        assert!(leaky.message.contains("credential"), "{}", leaky.message);

        // And the brief tells the writer what is *not* in the commit.
        let brief = message_brief(&change);
        assert!(brief.contains("file.txt"), "{brief}");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A file that is changed and not staged cannot be described by this
    /// commit's message.
    #[test]
    fn a_message_about_work_that_is_not_in_the_commit_is_refused() {
        let (base, work) = pair("unstaged");
        std::fs::write(work.join("file.txt"), "one\nstaged change\n").unwrap();
        run(&work, &["add", "file.txt"]);
        run(&work, &["commit", "-qm", "first change"]);
        std::fs::write(work.join("file.txt"), "one\nstaged change\nmore\n").unwrap();
        std::fs::write(work.join("src/app.ts"), "export const a = 1\n").ok();
        std::fs::create_dir_all(work.join("src")).unwrap();
        std::fs::write(work.join("src/app.ts"), "export const a = 1\n").unwrap();
        run(&work, &["add", "src/app.ts"]);
        run(&work, &["commit", "-qm", "add app"]);
        // Now: one staged file, one changed-but-unstaged file.
        std::fs::write(work.join("file.txt"), "one\nstaged change\nmore\nstaged again\n")
            .unwrap();
        std::fs::write(work.join("src/app.ts"), "export const a = 2\n").unwrap();
        run(&work, &["add", "file.txt"]);

        let change = staged(&work).unwrap();
        assert_eq!(change.files, ["file.txt"]);
        assert_eq!(change.unstaged, ["src/app.ts"]);

        let refused = check_message("feat: change src/app.ts as well", &change).unwrap_err();
        assert_eq!(refused.kind, VcsErrorKind::BadMessage);
        assert!(refused.message.contains("not staged"), "{}", refused.message);

        // The brief says so too, so the writer is not left to infer it.
        assert!(message_brief(&change).contains("NOT staged"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn somewhere_that_is_not_a_repository_is_a_typed_refusal() {
        let dir = std::env::temp_dir().join(format!("jan-vcs-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let err = divergence(&dir).unwrap_err();
        assert_eq!(err.kind, VcsErrorKind::NotARepo);
        assert_eq!(conflicts(&dir).unwrap_err().kind, VcsErrorKind::NotARepo);
        let harness: tauri_plugin_agent_tools::harness_error::HarnessError = (&err).into();
        assert_eq!(
            harness.kind(),
            tauri_plugin_agent_tools::harness_error::ErrorKind::NotFound
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A real stopped merge, read as it stands.
    #[test]
    fn a_stopped_merge_is_reported_region_by_region_and_resolved_by_nobody() {
        let (base, work) = pair("conflict");
        run(&work, &["switch", "-q", "-c", "theirs"]);
        commit(&work, "file.txt", "one\ntheir change\n", "theirs");
        run(&work, &["switch", "-q", "main"]);
        commit(&work, "file.txt", "one\nour change\n", "ours");
        // Deliberately allowed to fail: this is the merge that conflicts.
        let _ = Command::new("git")
            .arg("-C")
            .arg(&work)
            .args(["merge", "theirs"])
            .output()
            .unwrap();

        let state = conflicts(&work).unwrap();
        assert!(state.in_progress, "a stopped merge is in progress");
        assert_eq!(state.files.len(), 1);
        let file = &state.files[0];
        assert_eq!(file.path, "file.txt");
        assert_eq!(file.kind, ConflictKind::BothChanged);
        assert_eq!(file.hunks.len(), 1);
        assert_eq!(file.hunks[0].ours, ["our change"]);
        assert_eq!(file.hunks[0].theirs, ["their change"]);
        assert!(file.hunks[0].at > 0, "the region says where it is");
        // The file on disk is untouched: nothing here resolves anything.
        let on_disk = std::fs::read_to_string(work.join("file.txt")).unwrap();
        assert!(on_disk.contains("<<<<<<<"), "the merge was resolved by reading it");
        assert!(state.note.contains("nothing here is resolved"));

        run(&work, &["merge", "--abort"]);
        let quiet = conflicts(&work).unwrap();
        assert!(!quiet.in_progress && quiet.files.is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A file one side deleted is not the same as a file both sides edited,
    /// and saying so is the difference between a safe resolution and a lost
    /// file.
    #[test]
    fn a_file_one_side_deleted_is_named_as_that() {
        let (base, work) = pair("delete");
        run(&work, &["switch", "-q", "-c", "theirs"]);
        std::fs::remove_file(work.join("file.txt")).unwrap();
        run(&work, &["add", "-A"]);
        run(&work, &["commit", "-qm", "they deleted it"]);
        run(&work, &["switch", "-q", "main"]);
        commit(&work, "file.txt", "one\nours\n", "we changed it");
        let _ = Command::new("git")
            .arg("-C")
            .arg(&work)
            .args(["merge", "theirs"])
            .output()
            .unwrap();

        let state = conflicts(&work).unwrap();
        assert_eq!(state.files.len(), 1);
        assert_eq!(state.files[0].kind, ConflictKind::DeletedByThem);
        assert!(state.files[0].hunks.is_empty(), "there are no regions in a deletion");
        run(&work, &["merge", "--abort"]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_conflict_bigger_than_is_worth_showing_says_it_was_cut() {
        let long: Vec<String> = (0..MAX_SIDE_LINES + 10).map(|n| format!("line {n}")).collect();
        let text = format!(
            "start\n<<<<<<< HEAD\n{}\n=======\ntheirs\n>>>>>>> other\nend\n",
            long.join("\n")
        );
        let (hunks, truncated) = parse_markers(&text);
        assert_eq!(hunks.len(), 1);
        assert!(!truncated, "the file has one region, and it is listed");
        assert_eq!(hunks[0].ours.len(), MAX_SIDE_LINES);
        assert!(hunks[0].truncated, "a side that was cut says so");

        // And a file with more regions than are listed says that too.
        let many = "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n".repeat(MAX_HUNKS + 3);
        let (hunks, truncated) = parse_markers(&many);
        assert_eq!(hunks.len(), MAX_HUNKS);
        assert!(truncated);
    }

    fn tree_of(repo: &Path, name: &str) -> String {
        // A checkout may write CRLF (core.autocrlf); the content is what matters.
        std::fs::read_to_string(repo.join(name)).unwrap_or_default().replace("\r\n", "\n")
    }

    fn head(repo: &Path) -> String {
        let out = Command::new("git").arg("-C").arg(repo).args(["rev-parse", "HEAD"]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn a_change_is_split_into_the_commits_it_was_planned_as() {
        let (base, work) = pair("split");
        write(&work, "a.txt", "a\n");
        write(&work, "b.txt", "b\n");
        write(&work, "file.txt", "one\ntwo\n");
        write(&work, "left.txt", "left\n");
        let groups = vec![
            SplitGroup { files: vec!["a.txt".into(), "b.txt".into()], message: "add a and b".into() },
            SplitGroup { files: vec!["file.txt".into()], message: "extend file".into() },
        ];
        let outcome = apply_split(&work, &groups, &|| false).unwrap();
        assert_eq!(outcome.commits.len(), 2, "{outcome:?}");
        assert!(outcome.stopped.is_none());
        assert_eq!(outcome.left_uncommitted, vec!["left.txt".to_string()]);
        let files_of = |rev: &str| {
            let out = Command::new("git").arg("-C").arg(&work).args(["show", "--name-only", "--format=", rev]).output().unwrap();
            String::from_utf8_lossy(&out.stdout).lines().map(str::to_string).collect::<Vec<_>>()
        };
        assert_eq!(files_of("HEAD~1"), vec!["a.txt", "b.txt"]);
        assert_eq!(files_of("HEAD"), vec!["file.txt"]);
        assert_eq!(tree_of(&work, "left.txt"), "left\n");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_split_that_would_mislead_or_sweep_in_other_work_is_refused() {
        let (base, work) = pair("split-refuse");
        write(&work, "a.txt", "a\n");
        std::fs::create_dir_all(work.join("src")).unwrap();
        write(&work, "src/b.txt", "b\n");
        let before = head(&work);
        let g = |files: &[&str], message: &str| SplitGroup {
            files: files.iter().map(|f| f.to_string()).collect(),
            message: message.into(),
        };
        let kind = |groups: Vec<SplitGroup>| apply_split(&work, &groups, &|| false).unwrap_err().kind;
        assert_eq!(kind(vec![g(&["a.txt"], "one")]), VcsErrorKind::BadMessage, "one group");
        assert_eq!(kind(vec![g(&["a.txt"], "one"), g(&["a.txt", "src/b.txt"], "two")]), VcsErrorKind::BadMessage, "a file in two groups");
        assert_eq!(kind(vec![g(&["a.txt"], "one"), g(&["nope.txt"], "two")]), VcsErrorKind::BadMessage, "an unchanged file");
        assert_eq!(kind(vec![g(&["a.txt"], "one"), g(&["--exec=x"], "two")]), VcsErrorKind::BadName, "an option as a path");
        assert_eq!(kind(vec![g(&["a.txt"], ""), g(&["src/b.txt"], "two")]), VcsErrorKind::BadMessage, "no message");
        assert_eq!(kind(vec![g(&["a.txt"], "add src/b.txt"), g(&["src/b.txt"], "two")]), VcsErrorKind::BadMessage, "a message naming another group's file path");
        run(&work, &["add", "src/b.txt"]);
        assert_eq!(kind(vec![g(&["a.txt"], "one"), g(&["src/b.txt"], "two")]), VcsErrorKind::WouldDiscard, "something already staged");
        assert_eq!(head(&work), before, "a refused split committed something");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_cancelled_split_stops_between_commits_and_leaves_the_index_clean() {
        let (base, work) = pair("split-cancel");
        write(&work, "a.txt", "a\n");
        write(&work, "b.txt", "b\n");
        let groups = vec![
            SplitGroup { files: vec!["a.txt".into()], message: "add a".into() },
            SplitGroup { files: vec!["b.txt".into()], message: "add b".into() },
        ];
        let calls = std::cell::Cell::new(0);
        let outcome = apply_split(&work, &groups, &|| {
            calls.set(calls.get() + 1);
            calls.get() > 1
        })
        .unwrap();
        assert_eq!(outcome.commits.len(), 1);
        assert!(outcome.stopped.as_deref().unwrap_or("").contains("group 2"));
        assert_eq!(tree_of(&work, "b.txt"), "b\n", "the uncommitted file is untouched");
        let staged = Command::new("git").arg("-C").arg(&work).args(["diff", "--cached", "--name-only"]).output().unwrap();
        assert!(String::from_utf8_lossy(&staged.stdout).trim().is_empty(), "the index was left dirty");
        assert!(!work.join(".git").join("index.lock").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_conflicting_rebase_stops_recoverably_and_abort_returns_exactly_to_the_backup() {
        let (base, work) = pair("rebase");
        run(&work, &["switch", "-q", "-c", "feature"]);
        commit(&work, "file.txt", "feature\n", "feature change");
        let before = head(&work);
        run(&work, &["switch", "-q", "main"]);
        commit(&work, "file.txt", "main\n", "main change");
        run(&work, &["switch", "-q", "feature"]);
        let started = rebase_start(&work, "main").unwrap();
        assert_eq!(started.state, "conflicted", "{started:?}");
        assert_eq!(started.conflicts.as_ref().unwrap().files[0].path, "file.txt");
        assert!(started.backup.starts_with("refs/jan/backup/rebase/feature/"));
        // A later process finds it.
        let status = history_status(&work).unwrap();
        assert!(status.contains("a rebase is stopped") && status.contains(&started.backup), "{status}");
        assert_eq!(continue_op(&work, &started.backup).unwrap_err().kind, VcsErrorKind::WouldDiscard, "continued with conflicts left");
        assert_eq!(rebase_start(&work, "main").unwrap_err().kind, VcsErrorKind::WouldDiscard, "a second rebase over a stopped one");
        let aborted = abort_op(&work, &started.backup).unwrap();
        assert_eq!(aborted.state, "aborted");
        assert_eq!(head(&work), before, "abort did not return to the backup");
        assert_eq!(tree_of(&work, "file.txt"), "feature\n");
        assert_eq!(in_progress(&work), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_clean_rebase_finishes_and_its_backup_can_still_undo_it() {
        let (base, work) = pair("rebase-clean");
        run(&work, &["switch", "-q", "-c", "topic"]);
        commit(&work, "topic.txt", "topic\n", "topic change");
        let before = head(&work);
        run(&work, &["switch", "-q", "main"]);
        commit(&work, "other.txt", "other\n", "main moves on");
        run(&work, &["switch", "-q", "topic"]);
        let done = rebase_start(&work, "main").unwrap();
        assert_eq!(done.state, "done", "{done:?}");
        assert_ne!(head(&work), before);
        assert_eq!(tree_of(&work, "other.txt"), "other\n");
        abort_op(&work, &done.backup).unwrap();
        assert_eq!(head(&work), before, "the backup undoes a finished rebase");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// R20: a hook or a program named in the repository's own config is never
    /// run by these tools.
    #[test]
    fn a_hook_or_a_program_in_the_repositorys_own_config_is_never_run() {
        let (base, work) = pair("no-exec");
        let marker = base.join("ran.txt");
        let marker_sh = marker.to_string_lossy().replace('\\', "/");
        std::fs::write(work.join(".git/hooks/pre-commit"), format!("#!/bin/sh\necho ran > '{marker_sh}'\n")).unwrap();
        std::fs::write(work.join(".git/hooks/post-checkout"), format!("#!/bin/sh\necho ran > '{marker_sh}'\n")).unwrap();
        write(&work, "a.txt", "a\n");
        write(&work, "b.txt", "b\n");
        let groups = vec![
            SplitGroup { files: vec!["a.txt".into()], message: "add a".into() },
            SplitGroup { files: vec!["b.txt".into()], message: "add b".into() },
        ];
        apply_split(&work, &groups, &|| false).unwrap();
        switch_branch(&work, "topic", true).unwrap();
        assert!(!marker.exists(), "a hook ran");

        for (key, value) in [
            ("core.fsmonitor", "echo ran"),
            ("filter.x.clean", "sh -c 'echo ran'"),
            ("diff.x.textconv", "cat"),
            ("core.sshCommand", "ssh -o ProxyCommand=evil"),
            ("core.hooksPath", ".githooks"),
        ] {
            run(&work, &["config", "--local", key, value]);
            write(&work, "c.txt", key);
            let refused = check_split(&work, &groups).unwrap_err();
            assert_eq!(refused.kind, VcsErrorKind::WouldDiscard, "{key}: {}", refused.message);
            assert!(refused.message.to_lowercase().contains(&key.to_lowercase()), "{}", refused.message);
            assert_eq!(switch_branch(&work, "main", false).unwrap_err().kind, VcsErrorKind::WouldDiscard, "{key}");
            run(&work, &["config", "--local", "--unset", key]);
        }
        // A boolean fsmonitor is not a program.
        run(&work, &["config", "--local", "core.fsmonitor", "false"]);
        assert!(refuse_program_config(&work).is_ok());
        // An included file counts as the repository's own config.
        std::fs::write(base.join("extra.cfg"), "[filter \"y\"]\n\tsmudge = evil\n").unwrap();
        run(&work, &["config", "--local", "include.path", &base.join("extra.cfg").to_string_lossy()]);
        assert_eq!(refuse_program_config(&work).unwrap_err().kind, VcsErrorKind::WouldDiscard, "an included program");
        assert!(!marker.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// R19: undoing a finished operation must not take later work with it.
    #[test]
    fn undoing_a_finished_rebase_refuses_to_drop_commits_made_after_it() {
        let (base, work) = pair("rebase-later");
        run(&work, &["switch", "-q", "-c", "topic"]);
        commit(&work, "topic.txt", "topic\n", "topic change");
        run(&work, &["switch", "-q", "main"]);
        commit(&work, "other.txt", "other\n", "main moves on");
        run(&work, &["switch", "-q", "topic"]);
        let done = rebase_start(&work, "main").unwrap();
        assert_eq!(done.state, "done", "{done:?}");
        commit(&work, "later.txt", "later work\n", "work made after the rebase");
        let later = head(&work);
        let refused = abort_op(&work, &done.backup).unwrap_err();
        assert_eq!(refused.kind, VcsErrorKind::WouldDiscard, "{}", refused.message);
        assert_eq!(head(&work), later, "undoing the rebase dropped a commit made after it");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_rebase_that_would_rewrite_shared_history_is_refused() {
        let (base, work) = pair("rebase-refuse");
        commit(&work, "x.txt", "x\n", "on main");
        assert_eq!(rebase_start(&work, "HEAD~1").unwrap_err().kind, VcsErrorKind::BadName, "not a plain revision");
        let first = head(&work);
        commit(&work, "x2.txt", "x\n", "on main again");
        assert_eq!(rebase_start(&work, &first).unwrap_err().kind, VcsErrorKind::WouldDiscard, "main itself");
        run(&work, &["switch", "-q", "-c", "feature"]);
        commit(&work, "y.txt", "y\n", "pushed feature commit");
        run(&work, &["push", "-q", "-u", "origin", "feature"]);
        run(&work, &["switch", "-q", "main"]);
        commit(&work, "z.txt", "z\n", "main moves on");
        run(&work, &["switch", "-q", "feature"]);
        let before = head(&work);
        let refused = rebase_start(&work, "main").unwrap_err();
        assert_eq!(refused.kind, VcsErrorKind::WouldDiscard, "{}", refused.message);
        assert!(refused.message.contains("already on"), "{}", refused.message);
        assert_eq!(head(&work), before, "a refused rebase moved the branch");
        write(&work, "y.txt", "dirty\n");
        assert_eq!(rebase_start(&work, "main").unwrap_err().kind, VcsErrorKind::WouldDiscard, "a dirty tree");
        assert_eq!(tree_of(&work, "y.txt"), "dirty\n");
        run(&work, &["checkout", "-q", "--", "y.txt"]);
        assert_eq!(rebase_start(&work, "--exec=calc").unwrap_err().kind, VcsErrorKind::BadName);
        assert_eq!(rebase_start(&work, "no-such-branch").unwrap_err().kind, VcsErrorKind::NoBranch);
        let listed = Command::new("git").arg("-C").arg(&work).args(["for-each-ref", "refs/jan/"]).output().unwrap();
        assert!(String::from_utf8_lossy(&listed.stdout).trim().is_empty(), "a refused rebase wrote a backup");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_commit_is_ported_and_a_conflicting_pick_is_continued_or_undone() {
        let (base, work) = pair("pick");
        run(&work, &["switch", "-q", "-c", "fix"]);
        commit(&work, "fix.txt", "fixed\n", "the fix");
        let fix = head(&work);
        commit(&work, "file.txt", "fix branch\n", "conflicting change");
        let conflicting = head(&work);
        run(&work, &["switch", "-q", "main"]);
        commit(&work, "file.txt", "main side\n", "main side");
        let clean = cherry_pick(&work, &fix).unwrap();
        assert_eq!(clean.state, "done", "{clean:?}");
        assert_eq!(tree_of(&work, "fix.txt"), "fixed\n");
        let before = head(&work);
        let stopped = cherry_pick(&work, &conflicting).unwrap();
        assert_eq!(stopped.state, "conflicted");
        abort_op(&work, &stopped.backup).unwrap();
        assert_eq!(head(&work), before);
        assert_eq!(tree_of(&work, "file.txt"), "main side\n");
        let again = cherry_pick(&work, &conflicting).unwrap();
        write(&work, "file.txt", "resolved\n");
        run(&work, &["add", "file.txt"]);
        let finished = continue_op(&work, &again.backup).unwrap();
        assert_eq!(finished.state, "done", "{finished:?}");
        assert_eq!(tree_of(&work, "file.txt"), "resolved\n");
        assert_eq!(cherry_pick(&work, "-n").unwrap_err().kind, VcsErrorKind::BadName);
        assert_eq!(abort_op(&work, "refs/heads/main").unwrap_err().kind, VcsErrorKind::BadName, "not a backup this made");
        assert_eq!(abort_op(&work, "refs/jan/backup/rebase/../x/1").unwrap_err().kind, VcsErrorKind::BadName);
        // A backup for another branch never resets this one.
        run(&work, &["switch", "-q", "fix"]);
        let here = head(&work);
        assert_eq!(abort_op(&work, &again.backup).unwrap_err().kind, VcsErrorKind::WouldDiscard);
        assert_eq!(head(&work), here);
        let _ = std::fs::remove_dir_all(&base);
    }
}
