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
//! Nothing here fetches, merges, pushes or checks anything out. Every function
//! reads.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

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

fn git(repo: &Path, args: &[&str]) -> Result<String, VcsError> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
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
}
