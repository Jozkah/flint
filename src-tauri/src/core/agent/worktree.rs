//! Flint-owned Git worktrees: an isolated checkout a run can edit without
//! touching the one the user is working in.
//!
//! The access mode existed before this did, declared and deliberately inert:
//! `BACKEND_ACCESS_CAPABILITY.managedWorktree` was false because there was no
//! lifecycle beneath it, and a mode that says "isolated" while writes still go
//! to a sandbox would be exactly the unkept promise the rework exists to
//! remove. This is that lifecycle.
//!
//! Three rules shape the whole module.
//!
//! **The source checkout is never written.** Not by this module, and not by the
//! run: the worktree path is what the tool layer is given, and the source path
//! is simply never handed to it. Containment here is structural rather than
//! checked, because a check can be forgotten at one call site and a value that
//! was never passed cannot be.
//!
//! **Identity is not a path.** Repositories get moved, renamed and re-cloned. A
//! record is matched on the repository's first commit where it has one, so a
//! worktree cannot be silently reused for a different repository that happens
//! to sit at the same path — and a mismatch refuses rather than rebinding.
//!
//! **A refusal beats a guess.** Every state this can end up in — the worktree
//! deleted underneath us, the branch moved by someone else, a directory that is
//! no longer a worktree — is a named outcome the caller can report. None of
//! them silently recreates anything, because recreating a worktree is how the
//! work someone left in it disappears.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Run a `git` scoped to `repo`, with a fixed identity.
///
/// The identity matters even though this module does not commit: `git worktree
/// add` creates a branch, and on a machine with no `user.email` configured git
/// refuses operations that might need one. Supplying it here means the feature
/// works on a fresh machine rather than failing with a message about
/// configuring an identity the user has no reason to care about.
fn run(repo: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(crate::core::agent::vcs::HARDENED)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_AUTHOR_NAME", "Flint")
        .env("GIT_AUTHOR_EMAIL", "agent@jan.ai")
        .env("GIT_COMMITTER_NAME", "Flint")
        .env("GIT_COMMITTER_EMAIL", "agent@jan.ai");
    jan_utils::system::hide_console_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("failed to launch git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git {} failed", args.first().copied().unwrap_or(""))
        } else {
            stderr
        })
    }
}

/// How a repository is recognised again later.
///
/// `first_commit` is the stable half: it survives moves, renames and re-clones,
/// and differs between unrelated repositories. It is absent for a repository
/// with no commits yet, which is why `path` is kept as well — together they are
/// enough to refuse a stale binding without refusing a legitimate one.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoIdentity {
    /// Canonical top level of the working tree.
    pub root: String,
    /// The repository's first commit, when it has one.
    pub first_commit: Option<String>,
}

impl RepoIdentity {
    /// A directory name that is stable for this repository and safe on every
    /// platform.
    ///
    /// Derived rather than random so the same repository lands in the same
    /// place across restarts, and hashed rather than spelled out so a deep
    /// source path cannot push the worktree path over Windows' limit.
    pub fn key(&self) -> String {
        let basis = self
            .first_commit
            .clone()
            .unwrap_or_else(|| self.root.clone());
        format!("{:016x}", fnv1a(basis.as_bytes()))
    }
}

/// FNV-1a. Not for security — only to turn an identity into a short, stable,
/// filesystem-safe directory name.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    hash
}

/// What a run needs to know about its worktree.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRecord {
    /// The isolated checkout. This, and only this, is what the run may write.
    pub path: String,
    /// The branch created for it.
    pub branch: String,
    /// The commit it was created from, for diffing and for refusing a stale
    /// binding.
    pub base_sha: String,
    /// The repository it came from. Read for review, never written.
    pub source_root: String,
    /// Identity of that repository, so a moved or re-cloned one is noticed.
    pub identity: RepoIdentity,
    /// Paths that were dirty in the source when this was created.
    ///
    /// A worktree is made from committed state, so uncommitted work in the
    /// source is invisible to the run. Recorded here so the confirmation and
    /// the completion summary can say what was left behind rather than letting
    /// the user discover it later.
    pub uncommitted_at_creation: Vec<String>,
    /// The branch the worktree was based on (the source checkout's branch when
    /// it was created, or the one the user picked), and the one "Merge" merges
    /// into. `None` when the source was on a detached HEAD.
    #[serde(default)]
    pub base_branch: Option<String>,
    /// What the source checkout held that the worktree does not carry: a
    /// rebase, merge, cherry-pick or revert in progress. Said, not refused --
    /// the worktree starts from a commit and is unaffected by it.
    #[serde(default)]
    pub notes: Vec<String>,
}

/// Whether a recorded worktree is still usable, and why not when it is not.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum WorktreeState {
    /// Present, on its branch, attached to its repository.
    Ready,
    /// The directory is gone.
    Missing,
    /// The directory exists but is not a Git worktree any more.
    Corrupt,
    /// It is checked out on a different branch than the one recorded.
    BranchMoved,
    /// The repository it belongs to is not the one at the recorded path.
    IdentityChanged,
}

/// Read a repository's identity.
///
/// Fails when `path` is not inside a working tree, which is the honest answer
/// for a folder that is not a repository: a managed worktree cannot be offered
/// for it, and saying so is better than creating something that resembles one.
pub fn identity(path: &Path) -> Result<RepoIdentity, String> {
    let root = run(path, &["rev-parse", "--show-toplevel"])?;
    if root.is_empty() {
        return Err("not a git repository".to_string());
    }
    let root_path = PathBuf::from(&root);
    let canonical = root_path
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(root);
    // `--max-parents=0` is the root commit. A repository with no commits has
    // none, and that is not an error: it is a repository whose identity has to
    // rest on its path until it has one.
    let first_commit = run(path, &["rev-list", "--max-parents=0", "HEAD"])
        .ok()
        .and_then(|out| out.lines().last().map(str::to_string))
        .filter(|sha| !sha.is_empty());
    Ok(RepoIdentity {
        root: canonical,
        first_commit,
    })
}

/// Paths with uncommitted changes in the source working tree.
///
/// Includes untracked files: a run that cannot see a file the user has just
/// written is surprised by its absence exactly as much as by a modified one.
///
/// Two plain commands rather than one `--porcelain` parse. Porcelain encodes
/// the status in fixed leading columns, which means the parse depends on
/// leading whitespace surviving — and it does not here, because [`run`] trims
/// the output it returns. Rather than make one helper's trimming a hidden
/// requirement of the other, this asks two questions whose answers are already
/// one path per line.
pub fn uncommitted(repo: &Path) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    // Tracked files differing from HEAD, staged or not.
    if let Ok(out) = run(repo, &["diff", "--name-only", "HEAD"]) {
        paths.extend(out.lines().map(str::to_string));
    }
    if let Ok(out) = run(repo, &["ls-files", "--others", "--exclude-standard"]) {
        paths.extend(out.lines().map(str::to_string));
    }
    paths.retain(|p| !p.is_empty());
    paths.sort();
    paths.dedup();
    paths
}

/// A history operation stopped in a checkout, with the files it left
/// unresolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationInProgress {
    /// `merge`, `rebase`, `cherry-pick` or `revert`.
    pub operation: &'static str,
    pub unresolved: Vec<String>,
}

impl OperationInProgress {
    /// What a worktree created while this is stopped says about it.
    pub fn notice(&self) -> String {
        let op = self.operation;
        format!(
            "The checkout has a {op} in progress; this worktree starts from HEAD's commit \
             and does not carry the {op}, its conflicts or the checkout's uncommitted changes."
        )
    }
}

/// Which merge, rebase, cherry-pick or revert is stopped in `repo`, read from
/// git's own state files through `--git-path` so a linked worktree resolves
/// them in the right git directory.
pub fn operation_in_progress(repo: &Path) -> Option<OperationInProgress> {
    let exists = |name: &str| {
        run(repo, &["rev-parse", "--git-path", name])
            .map(|p| {
                let p = PathBuf::from(p);
                if p.is_absolute() {
                    p
                } else {
                    repo.join(p)
                }
            })
            .is_ok_and(|p| p.exists())
    };
    let operation = if exists("rebase-merge") || exists("rebase-apply") {
        "rebase"
    } else if exists("CHERRY_PICK_HEAD") {
        "cherry-pick"
    } else if exists("REVERT_HEAD") {
        "revert"
    } else if exists("MERGE_HEAD") {
        "merge"
    } else {
        return None;
    };
    let mut unresolved: Vec<String> = run(repo, &["diff", "--name-only", "--diff-filter=U"])
        .map(|out| {
            out.lines()
                .map(str::to_string)
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default();
    unresolved.sort();
    unresolved.dedup();
    Some(OperationInProgress {
        operation,
        unresolved,
    })
}

/// A short, stable, filesystem- and ref-safe name for one owner id.
///
/// Readable half plus a hash of the whole id, and the hash is the part that
/// matters. Owners are no longer only session ids: a team gives each isolated
/// child its own destination, and those ids share a long common prefix. A
/// name built by truncating would hand two different children the same branch
/// and the same directory — which is not a cosmetic collision but two agents
/// writing the same checkout while each is told it is alone in it.
fn slug(owner_id: &str) -> String {
    let head: String = owner_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect();
    format!(
        "{}-{:016x}",
        if head.is_empty() { "session" } else { &head },
        fnv1a(owner_id.as_bytes())
    )
}

/// The branch a worktree uses.
///
/// Stable across restarts, so reopening a session finds its own work rather
/// than starting a second branch beside it, and namespaced so it is obvious in
/// `git branch` who made it and why.
pub fn branch_name(session_id: &str) -> String {
    format!("{BRANCH_PREFIX}{}", slug(session_id))
}

/// Where a session's worktree lives, under Flint's own data directory.
///
/// Outside the user's checkout on purpose: inside it, the worktree would show
/// up in their editor, their search results and — but for `.git` bookkeeping —
/// their next commit.
pub fn worktree_path(worktrees_root: &Path, identity: &RepoIdentity, session_id: &str) -> PathBuf {
    // Short on purpose: Git for Windows fails once a worktree's `.git` path
    // passes about 218 characters, and the data folder is already deep. Eight
    // hex characters of the repository key and ten of the session's hash keep
    // the pair unique while adding under twenty characters.
    worktrees_root
        .join(&identity.key()[..8])
        .join(short_id(session_id))
}

/// Where builds before the short layout put a session's worktree. Still looked
/// at, so a session made by an older build finds its own work.
pub fn legacy_worktree_path(
    worktrees_root: &Path,
    identity: &RepoIdentity,
    session_id: &str,
) -> PathBuf {
    worktrees_root.join(identity.key()).join(slug(session_id))
}

/// Ten hex characters of the session id's hash: the short, stable part of a
/// session's worktree directory and branch.
pub fn short_id(session_id: &str) -> String {
    format!("{:016x}", fnv1a(session_id.as_bytes()))[..10].to_string()
}

/// Words a request is phrased with that say nothing about the work, left out
/// of branch names: "can you please edit x so that y" becomes `edit-x-y`.
const BRANCH_FILLER: &[&str] = &[
    "a", "an", "the", "and", "or", "but", "so", "that", "this", "these", "those", "to", "of", "in",
    "on", "for", "with", "at", "by", "from", "into", "is", "are", "be", "it", "its", "can",
    "could", "would", "will", "should", "you", "your", "i", "me", "my", "we", "our", "us",
    "please", "pls", "want", "need", "like", "hey", "hi", "just", "also", "then", "some", "do",
    "does", "make", "sure", "let", "lets", "help", "how", "what", "why", "if", "when", "there",
    "all",
];

/// At most this many words of the title go into a branch name.
const BRANCH_MAX_WORDS: usize = 5;
/// And at most this many characters, cut on a word boundary.
const BRANCH_MAX_CHARS: usize = 36;

/// A branch name made from a session's title, `flint/<words>-<id>`.
///
/// The title makes `git branch` readable: its first few meaningful words, with
/// filler ("can you", "so that", "please") dropped and never a word cut in
/// half. A six-character id keeps two sessions with the same title apart. Only
/// ASCII letters and digits survive, so no title can spell a ref outside the
/// namespace.
pub fn titled_branch_name(title: &str, session_id: &str) -> String {
    let id = &short_id(session_id)[..6];
    let lowered = title.to_ascii_lowercase();
    let all: Vec<&str> = lowered
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let meaningful: Vec<&str> = all
        .iter()
        .copied()
        .filter(|w| !BRANCH_FILLER.contains(w))
        .collect();
    // A title made only of filler still reads better than `session`.
    let source = if meaningful.is_empty() {
        &all
    } else {
        &meaningful
    };
    let mut words = String::new();
    for w in source.iter().take(BRANCH_MAX_WORDS) {
        let w = &w[..w.len().min(BRANCH_MAX_CHARS)];
        if !words.is_empty() && words.len() + 1 + w.len() > BRANCH_MAX_CHARS {
            break;
        }
        if !words.is_empty() {
            words.push('-');
        }
        words.push_str(w);
    }
    if words.is_empty() {
        format!("{FLINT_BRANCH_PREFIX}session-{id}")
    } else {
        format!("{FLINT_BRANCH_PREFIX}{words}-{id}")
    }
}

/// Whether a branch is in one of the namespaces Flint creates branches in.
pub fn is_flint_branch(branch: &str) -> bool {
    branch.starts_with(BRANCH_PREFIX) || branch.starts_with(FLINT_BRANCH_PREFIX)
}

/// Whether `path` is a Git worktree of `repo`.
fn is_worktree_of(path: &Path, repo: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    let Ok(top) = run(path, &["rev-parse", "--show-toplevel"]) else {
        return false;
    };
    let same = |a: &str, b: &Path| {
        let a = PathBuf::from(a);
        match (a.canonicalize(), b.canonicalize()) {
            (Ok(x), Ok(y)) => x == y,
            _ => a == b,
        }
    };
    if !same(&top, path) {
        return false;
    }
    // A worktree shares the repository's object store; comparing the common
    // git dir is what distinguishes "a worktree of this repo" from "a separate
    // clone that happens to sit here".
    let (Ok(a), Ok(b)) = (
        run(
            path,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ),
        run(
            repo,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ),
    ) else {
        return false;
    };
    same(&a, &PathBuf::from(b))
}

/// Whether `path` really sits inside `root`, after both are resolved.
///
/// Resolved rather than compared as strings, because the interesting cases are
/// the ones a string comparison gets wrong: a symlink in Flint's worktrees
/// directory pointing at the user's home, a path with `..` in it, a directory
/// that was replaced between the check and the use. A path that cannot be
/// resolved is not contained — an answer nobody can verify is not a yes.
fn contained(path: &Path, root: &Path) -> bool {
    let (Ok(path), Ok(root)) = (
        // The worktree may not exist yet, so resolve the nearest existing
        // ancestor and re-append the rest: canonicalizing a path that is about
        // to be created would fail for every first-time creation.
        resolve_lexically(path),
        root.canonicalize(),
    ) else {
        return false;
    };
    path.starts_with(&root) && path != root
}

/// Canonicalize as much of `path` as exists, keeping the rest.
fn resolve_lexically(path: &Path) -> Result<PathBuf, ()> {
    let mut existing = path;
    let mut rest: Vec<&std::ffi::OsStr> = Vec::new();
    loop {
        if existing.exists() {
            let base = existing.canonicalize().map_err(|_| ())?;
            return Ok(rest.iter().rev().fold(base, |acc, part| acc.join(part)));
        }
        let Some(parent) = existing.parent() else {
            return Err(());
        };
        let Some(name) = existing.file_name() else {
            return Err(());
        };
        // `..` cannot be re-appended to a resolved base and still mean what it
        // said, so a path that climbs is refused rather than guessed at.
        if name == std::ffi::OsStr::new("..") {
            return Err(());
        }
        rest.push(name);
        existing = parent;
    }
}

/// What a worktree has that is not committed.
///
/// Asked before discarding one. The whole point of a managed worktree is that
/// a run's work lives somewhere; removing it without saying what is in it is
/// how that work disappears without anyone deciding it should.
pub fn pending(record: &WorktreeRecord) -> Vec<String> {
    uncommitted(Path::new(&record.path))
}

/// Check a recorded worktree against what is on disk.
///
/// Every failure is named. The caller decides what to do about it, because the
/// right answer differs: a missing worktree can be recreated, a branch someone
/// else moved should not be silently reset.
pub fn state(record: &WorktreeRecord) -> WorktreeState {
    let path = PathBuf::from(&record.path);
    let source = PathBuf::from(&record.source_root);
    if !path.exists() {
        return WorktreeState::Missing;
    }
    match identity(&source) {
        Ok(current) if current != record.identity => return WorktreeState::IdentityChanged,
        Err(_) => return WorktreeState::IdentityChanged,
        _ => {}
    }
    if !is_worktree_of(&path, &source) {
        return WorktreeState::Corrupt;
    }
    match run(&path, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Ok(branch) if branch == record.branch => WorktreeState::Ready,
        Ok(_) => WorktreeState::BranchMoved,
        Err(_) => WorktreeState::Corrupt,
    }
}

/// Find a session's existing worktree, if it has a usable one.
///
/// Returns `None` rather than an error when there is nothing to reuse: not
/// having one yet is the ordinary case, not a failure.
pub fn existing(repo: &Path, worktrees_root: &Path, session_id: &str) -> Option<WorktreeRecord> {
    let identity = identity(repo).ok()?;
    let path = [
        worktree_path(worktrees_root, &identity, session_id),
        legacy_worktree_path(worktrees_root, &identity, session_id),
    ]
    .into_iter()
    .find(|p| is_worktree_of(p, repo))?;
    let branch = run(&path, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    let base_sha = run(&path, &["rev-parse", "HEAD"]).ok()?;
    Some(WorktreeRecord {
        path: path.to_string_lossy().to_string(),
        branch,
        base_sha,
        source_root: identity.root.clone(),
        identity,
        uncommitted_at_creation: Vec::new(),
        base_branch: None,
        notes: Vec::new(),
    })
}

/// Create a worktree for this session, or reuse the one it already has.
///
/// Refuses rather than improvises in the two cases where improvising loses
/// work: a branch of the right name that is not ours, and a directory in our
/// own location that is not a worktree of this repository. Both mean something
/// happened outside Flint, and picking a different name to get past it would
/// leave the user with two branches and no explanation.
pub fn ensure(
    repo: &Path,
    worktrees_root: &Path,
    session_id: &str,
) -> Result<WorktreeRecord, String> {
    ensure_with(repo, worktrees_root, session_id, &EnsureOptions::default())
}

/// How a new worktree is named and what it starts from.
#[derive(Debug, Clone, Default)]
pub struct EnsureOptions {
    /// The session's title: the branch becomes `flint/<title>-<short id>`
    /// instead of the id-derived `jan/cowork/...` name.
    pub title: Option<String>,
    /// A branch (or any commit-ish) to start from instead of the checkout's
    /// HEAD. It also becomes the branch "Merge" targets.
    pub base: Option<String>,
}

/// [`ensure`] with a title for the branch and an optional base to start from.
pub fn ensure_with(
    repo: &Path,
    worktrees_root: &Path,
    session_id: &str,
    options: &EnsureOptions,
) -> Result<WorktreeRecord, String> {
    // A relative root would be resolved twice, differently: by `git -C repo`
    // against the repository -- putting the worktree inside the checkout it
    // exists to protect -- and by everything else against this process's
    // working directory, where it then cannot be found. Flint's configured data
    // folder defaults to the relative `./data`, so this is not hypothetical.
    let worktrees_root = &absolute(worktrees_root)?;
    let identity = identity(repo)?;
    let path = worktree_path(worktrees_root, &identity, session_id);
    let branch = match options.title.as_deref().map(str::trim) {
        Some(title) if !title.is_empty() => titled_branch_name(title, session_id),
        _ => branch_name(session_id),
    };

    // Where the worktree will actually be, not where the name says. A symlink
    // in Flint's own worktrees directory — or one someone put there — would
    // otherwise make "under the data folder" a statement about the string
    // rather than about the disk, and the run would be editing whatever it
    // points at.
    std::fs::create_dir_all(worktrees_root)
        .map_err(|e| format!("could not create {}: {e}", worktrees_root.display()))?;
    if !contained(&path, worktrees_root) {
        return Err(format!(
            "{} would resolve outside the folder Jan owns",
            path.display()
        ));
    }
    // And never inside the checkout it exists to protect: a worktree there
    // would show up in the user's editor, their search and their next commit.
    if contained(&path, repo) {
        return Err(format!(
            "{} is inside the repository it would be isolated from",
            path.display()
        ));
    }

    if let Some(found) = existing(repo, worktrees_root, session_id) {
        // The directory is derived from the session id, so a worktree there on
        // any Flint branch is this session's own -- named before its title
        // changed, or by an older build.
        if found.branch == branch || is_flint_branch(&found.branch) {
            return Ok(found);
        }
        return Err(format!(
            "the worktree at {} is on branch {}, not {}",
            found.path, found.branch, branch
        ));
    }

    if path.exists() {
        return Err(format!(
            "{} already exists and is not a worktree of this repository",
            path.display()
        ));
    }

    // A worktree is built from a commit, so a merge, rebase, cherry-pick or
    // revert stopped in the checkout does not come along -- and does not need
    // to: the worktree is a separate checkout of HEAD's commit, and the
    // operation stays exactly where it was. That is said on the record rather
    // than refused, so the session can start while the user finishes the
    // operation in their own checkout.
    let mut notes = Vec::new();
    if let Some(stopped) = operation_in_progress(repo) {
        notes.push(stopped.notice());
    }

    let (head, base_branch) = match options.base.as_deref().map(str::trim) {
        Some(base) if !base.is_empty() => {
            if base.starts_with('-') {
                return Err(format!("{base} is not a branch or commit"));
            }
            let sha = run(
                repo,
                &["rev-parse", "--verify", &format!("{base}^{{commit}}")],
            )
            .map_err(|_| format!("{base} is not a branch or commit in this repository"))?;
            let local = run(
                repo,
                &["rev-parse", "--verify", &format!("refs/heads/{base}")],
            )
            .is_ok();
            (sha, local.then(|| base.to_string()))
        }
        _ => {
            let sha = run(repo, &["rev-parse", "HEAD"]).map_err(|_| {
                "this repository has no commits yet, so there is nothing to branch from".to_string()
            })?;
            (sha, current_branch(repo))
        }
    };
    let branch_exists = run(
        repo,
        &["rev-parse", "--verify", &format!("refs/heads/{branch}")],
    )
    .is_ok();
    if branch_exists {
        return Err(format!(
            "branch {branch} already exists; remove it or use another session"
        ));
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let path_str = path.to_string_lossy().to_string();
    crate::core::agent::vcs::refuse_filter_programs(repo)?;
    run(repo, &["worktree", "add", "-b", &branch, &path_str, &head])?;

    Ok(WorktreeRecord {
        path: path_str,
        branch,
        base_sha: head,
        source_root: identity.root.clone(),
        identity,
        uncommitted_at_creation: uncommitted(repo),
        base_branch,
        notes,
    })
}

/// The branch checked out in `repo`, or `None` on a detached HEAD.
pub(crate) fn current_branch(repo: &Path) -> Option<String> {
    run(repo, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .filter(|b| !b.is_empty())
}

/// Run `git` in `repo` and hand back the exit status with stdout, for the
/// commands whose non-zero exit carries an answer (`merge-tree`,
/// `merge-base --is-ancestor`).
fn run_status(repo: &Path, args: &[&str]) -> Result<(bool, String), String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(crate::core::agent::vcs::HARDENED)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    jan_utils::system::hide_console_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("failed to launch git: {e}"))?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).trim().to_string(),
    ))
}

/// Run `git` as the user: their configured identity when they have one, and
/// Flint's fixed identity only when they do not. A merge commit or a commit of
/// the session's work lands on the user's branch, so it should carry their
/// name wherever git knows it.
fn run_as_user(repo: &Path, args: &[&str]) -> Result<String, String> {
    let configured = run_status(repo, &["config", "user.email"])
        .map(|(ok, out)| ok && !out.is_empty())
        .unwrap_or(false);
    if !configured {
        return run(repo, args);
    }
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(crate::core::agent::vcs::HARDENED)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    jan_utils::system::hide_console_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("failed to launch git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// The commits on the worktree's branch that `base` does not have, one line
/// each (`<short sha> <subject>`). Empty when there is no base to compare with.
pub fn unmerged_commits(record: &WorktreeRecord, base: Option<&str>) -> Vec<String> {
    let source = Path::new(&record.source_root);
    let Some(base) = base
        .map(str::to_string)
        .or_else(|| record.base_branch.clone())
        .or_else(|| current_branch(source))
        .filter(|b| b != &record.branch)
    else {
        return Vec::new();
    };
    run(
        source,
        &[
            "log",
            "--format=%h %s",
            &format!("refs/heads/{base}..refs/heads/{}", record.branch),
            "--",
        ],
    )
    .map(|out| {
        out.lines()
            .map(str::to_string)
            .filter(|l| !l.is_empty())
            .collect()
    })
    .unwrap_or_default()
}

/// Commit everything the session left uncommitted in its worktree.
///
/// Returns `false` when there was nothing to commit.
pub fn commit_pending(record: &WorktreeRecord, message: &str) -> Result<bool, String> {
    let path = Path::new(&record.path);
    if pending(record).is_empty() {
        return Ok(false);
    }
    let message = if message.trim().is_empty() {
        "Work from a Flint session"
    } else {
        message.trim()
    };
    run(path, &["add", "-A"])?;
    run_as_user(path, &["commit", "-q", "--no-verify", "-m", message])?;
    Ok(true)
}

/// Rename a session's branch after its title, keeping the short id.
///
/// Sessions start before they have a title, so their branch is first named
/// `flint/session-<id>`; once the title is known the branch follows it. Only a
/// branch in Flint's namespace is renamed, and the worktree stays checked out
/// on it (git moves the worktree's HEAD with the branch).
pub fn rename_branch(
    record: &WorktreeRecord,
    session_id: &str,
    title: &str,
) -> Result<WorktreeRecord, String> {
    if !is_flint_branch(&record.branch) {
        return Err(format!("{} is not a branch Flint named", record.branch));
    }
    let wanted = titled_branch_name(title, session_id);
    if wanted == record.branch {
        return Ok(record.clone());
    }
    let source = Path::new(&record.source_root);
    if run(
        source,
        &["rev-parse", "--verify", &format!("refs/heads/{wanted}")],
    )
    .is_ok()
    {
        return Err(format!("branch {wanted} already exists"));
    }
    run(source, &["branch", "-m", &record.branch, &wanted])?;
    let mut next = record.clone();
    next.branch = wanted;
    Ok(next)
}

/// What "Merge into <base>" did.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    /// The base branch now contains the session's branch.
    pub merged: bool,
    /// Merged by moving the base forward, with no merge commit.
    pub fast_forward: bool,
    /// The base already had everything; nothing changed.
    pub already_merged: bool,
    /// The branch merged into.
    pub target: String,
    /// The base's new tip, when it moved.
    pub new_tip: Option<String>,
    /// Files both sides changed incompatibly. Nothing was changed when this is
    /// non-empty.
    pub conflicts: Vec<String>,
    /// Whether the session's uncommitted work was committed first.
    pub committed_pending: bool,
}

/// The checkout (the user's own, or another worktree) that has `branch`
/// checked out, if any.
fn checkout_of(repo: &Path, branch: &str) -> Option<PathBuf> {
    let out = run(repo, &["worktree", "list", "--porcelain"]).ok()?;
    let mut path: Option<&str> = None;
    let wanted = format!("branch refs/heads/{branch}");
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            path = Some(rest);
        } else if line == wanted {
            return path.map(PathBuf::from);
        }
    }
    None
}

/// Merge a session's branch into its base branch (or `target`).
///
/// Fast-forwards when it can and writes a merge commit when it must. Conflicts
/// are found with `git merge-tree` before anything moves, so a conflicting
/// merge reports its files and leaves every checkout and ref exactly as it
/// was -- nothing is ever left half-merged. Uncommitted work in the session's
/// worktree is committed first only when `commit_message` says so; otherwise
/// it is a refusal that names the files.
///
/// The one case refused rather than handled: the base is checked out somewhere
/// with uncommitted changes or an operation in progress. Moving it there would
/// either overwrite that work or fail halfway, and both are worse than asking.
pub fn merge(
    record: &WorktreeRecord,
    target: Option<&str>,
    commit_message: Option<&str>,
) -> Result<MergeOutcome, String> {
    let source = PathBuf::from(&record.source_root);
    let target = target
        .map(str::to_string)
        .or_else(|| record.base_branch.clone())
        .ok_or_else(|| {
            "this worktree was made from a detached HEAD, so there is no branch to merge into; \
             pick one"
                .to_string()
        })?;
    if target.starts_with('-') || target == record.branch {
        return Err(format!("{target} is not a branch this can be merged into"));
    }
    let base_ref = format!("refs/heads/{target}");
    let base_tip = run(&source, &["rev-parse", "--verify", &base_ref])
        .map_err(|_| format!("branch {target} does not exist"))?;

    let mut committed_pending = false;
    let dirty = pending(record);
    if !dirty.is_empty() {
        match commit_message {
            Some(message) => committed_pending = commit_pending(record, message)?,
            None => {
                return Err(format!(
                    "the session has {} uncommitted change(s) that would not be merged: {}",
                    dirty.len(),
                    dirty.join(", ")
                ))
            }
        }
    }
    let tip = run(
        &source,
        &[
            "rev-parse",
            "--verify",
            &format!("refs/heads/{}", record.branch),
        ],
    )?;

    let is_ancestor = |a: &str, b: &str| {
        run_status(&source, &["merge-base", "--is-ancestor", a, b])
            .map(|(ok, _)| ok)
            .unwrap_or(false)
    };
    let mut outcome = MergeOutcome {
        merged: false,
        fast_forward: false,
        already_merged: false,
        target: target.clone(),
        new_tip: None,
        conflicts: Vec::new(),
        committed_pending,
    };
    if is_ancestor(&tip, &base_tip) {
        outcome.merged = true;
        outcome.already_merged = true;
        return Ok(outcome);
    }

    let new_tip = if is_ancestor(&base_tip, &tip) {
        outcome.fast_forward = true;
        tip.clone()
    } else {
        let (clean, out) = run_status(
            &source,
            &[
                "merge-tree",
                "--write-tree",
                "--name-only",
                "--no-messages",
                &base_tip,
                &tip,
            ],
        )?;
        let mut lines = out.lines();
        let tree = lines.next().unwrap_or_default().trim().to_string();
        if !clean {
            let conflicts: Vec<String> = lines
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect();
            if tree.is_empty() || conflicts.is_empty() {
                return Err(
                    "git could not test this merge (git 2.38 or newer is needed)".to_string(),
                );
            }
            outcome.conflicts = conflicts;
            return Ok(outcome);
        }
        let message = format!("Merge branch '{}' into {target}", record.branch);
        run_as_user(
            &source,
            &[
                "commit-tree",
                &tree,
                "-p",
                &base_tip,
                "-p",
                &tip,
                "-m",
                &message,
            ],
        )?
    };

    match checkout_of(&source, &target) {
        Some(checkout) => {
            if let Some(stopped) = operation_in_progress(&checkout) {
                return Err(format!(
                    "{target} is checked out at {} with a {} in progress; finish it first",
                    checkout.display(),
                    stopped.operation
                ));
            }
            let dirty = uncommitted(&checkout);
            if !dirty.is_empty() {
                return Err(format!(
                    "{target} is checked out at {} with uncommitted changes ({}); commit or \
                     stash them first so merging cannot overwrite them",
                    checkout.display(),
                    dirty.join(", ")
                ));
            }
            // A fast-forward to the new tip, whichever kind of merge made it:
            // the checkout's files and its branch move together.
            run(&checkout, &["merge", "--ff-only", "-q", &new_tip])?;
        }
        None => {
            // Nobody has it checked out, so only the ref moves -- and only if
            // it is still where it was when the merge was worked out.
            run(&source, &["update-ref", &base_ref, &new_tip, &base_tip])?;
        }
    }
    outcome.merged = true;
    outcome.new_tip = Some(new_tip);
    Ok(outcome)
}

/// `path` made absolute against this process's working directory, with `.`
/// and `..` resolved lexically. Nothing is required to exist yet.
pub fn absolute(path: &Path) -> Result<PathBuf, String> {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("could not resolve {}: {e}", path.display()))?
            .join(path)
    };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    Ok(out)
}

/// Remove a worktree and its branch.
///
/// Deliberately not called anywhere automatically. Discarding is the one
/// operation here that destroys work, so it happens because someone asked for
/// it, never as cleanup on a path that was doing something else.
///
/// A worktree with uncommitted changes refuses unless `force` says otherwise,
/// and the refusal names the files. That is the difference between "the user
/// chose to throw this away" and "the changes are gone and nobody was told":
/// the caller has to have seen the list to pass `force`.
pub fn discard(record: &WorktreeRecord, force: bool) -> Result<(), String> {
    let dirty = pending(record);
    if !force && !dirty.is_empty() {
        return Err(format!(
            "{} has {} uncommitted change(s) that removing it would destroy: {}",
            record.path,
            dirty.len(),
            dirty.join(", ")
        ));
    }
    let unmerged = unmerged_commits(record, None);
    if !force && !unmerged.is_empty() {
        return Err(format!(
            "branch {} has {} commit(s) that are not in {}; removing it would destroy: {}",
            record.branch,
            unmerged.len(),
            record.base_branch.as_deref().unwrap_or("its base"),
            unmerged.join("; ")
        ));
    }
    let source = PathBuf::from(&record.source_root);
    // `--force` covers a dirty worktree, which is the normal state of one that
    // is being discarded on purpose.
    let _ = run(&source, &["worktree", "remove", "--force", &record.path]);
    // Prune first: the branch cannot be deleted while a worktree claims it.
    let _ = run(&source, &["worktree", "prune"]);
    let _ = run(&source, &["branch", "-D", &record.branch]);
    if PathBuf::from(&record.path).exists() {
        return Err(format!("{} could not be removed", record.path));
    }
    Ok(())
}

/// [`discard`], but only for a worktree that `record.source_root`'s own Git
/// lists at `record.path` on `record.branch`, under `worktrees_root` and in
/// Flint's branch namespace (Jozkah/jan#57).
///
/// The record arrives over IPC. Checking only that its path sits under the
/// worktrees root let a decoy path (one that need not exist, which also
/// silenced the uncommitted-changes guard) carry any repository and any branch
/// into `git branch -D`. The repository itself is the authority on which
/// worktree holds which branch, so the whole triple is matched against it.
pub fn discard_owned(
    record: &WorktreeRecord,
    worktrees_root: &Path,
    force: bool,
) -> Result<(), String> {
    ensure_owned(record, worktrees_root)?;
    discard(record, force)
}

/// Refuse a record that `record.source_root`'s own Git does not list at
/// `record.path` on `record.branch` under `worktrees_root`.
pub fn ensure_owned(record: &WorktreeRecord, worktrees_root: &Path) -> Result<(), String> {
    let normal = |p: &str| {
        resolve_lexically(Path::new(p))
            .map(|resolved| {
                crate::core::app::commands::strip_verbatim_prefix(resolved)
                    .to_string_lossy()
                    .into_owned()
            })
            .unwrap_or_else(|_| p.to_string())
    };
    let wanted = normal(&record.path);
    let known = list(Path::new(&record.source_root), worktrees_root)
        .into_iter()
        .any(|w| w.branch == record.branch && normal(&w.path) == wanted);
    if !known {
        return Err(format!(
            "{} is not a worktree Flint manages on branch {} of {}, so Flint will not remove it",
            record.path, record.branch, record.source_root
        ));
    }
    Ok(())
}

/// Every Flint-owned worktree of this repository that is actually on disk.
///
/// Read from Git rather than from anything Flint persisted, and that is the
/// point: the renderer's record of its worktrees dies with the process, so
/// after a crash the only truthful source is the repository itself. What comes
/// back is a list of places work might be sitting — never authority. Nothing
/// here issues a grant, and a recovered worktree is written only after someone
/// authorizes it again, so recovery can restore work without restoring access.
pub fn list(repo: &Path, worktrees_root: &Path) -> Vec<WorktreeRecord> {
    let Ok(identity) = identity(repo) else {
        return Vec::new();
    };
    let Ok(out) = run(repo, &["worktree", "list", "--porcelain"]) else {
        return Vec::new();
    };

    let mut found = Vec::new();
    let mut path: Option<String> = None;
    let mut head: Option<String> = None;
    let mut branch: Option<String> = None;
    let flush = |path: &mut Option<String>,
                 head: &mut Option<String>,
                 branch: &mut Option<String>,
                 found: &mut Vec<WorktreeRecord>| {
        let (Some(p), Some(h), Some(b)) = (path.take(), head.take(), branch.take()) else {
            return;
        };
        // Ours, and where we put them: a worktree the user made themselves is
        // not Flint's to list, offer to delete, or reason about.
        if !is_flint_branch(&b) || !contained(Path::new(&p), worktrees_root) {
            return;
        }
        // `git worktree list --porcelain` reports `C:/Users/...` on Windows,
        // while every record Flint creates holds a native `C:\Users\...`. Left
        // as git printed it, the same worktree compared unequal to itself --
        // so a listed worktree could not be matched to the one that made it.
        // Resolved the same way `contained` resolves, so both sides of any
        // comparison have been through the same normalisation.
        let p = resolve_lexically(Path::new(&p))
            .map(|resolved| {
                crate::core::app::commands::strip_verbatim_prefix(resolved)
                    .to_string_lossy()
                    .into_owned()
            })
            .unwrap_or(p);
        found.push(WorktreeRecord {
            path: p,
            branch: b,
            base_sha: h,
            source_root: identity.root.clone(),
            identity: identity.clone(),
            uncommitted_at_creation: Vec::new(),
            base_branch: None,
            notes: Vec::new(),
        });
    };

    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            flush(&mut path, &mut head, &mut branch, &mut found);
            path = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            head = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("branch refs/heads/") {
            branch = Some(rest.to_string());
        }
    }
    flush(&mut path, &mut head, &mut branch, &mut found);
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

/// The namespace every branch Flint creates lives under.
pub const BRANCH_PREFIX: &str = "jan/cowork/";

/// The namespace of branches named from a session's title.
pub const FLINT_BRANCH_PREFIX: &str = "flint/";

/// Drop the bookkeeping for worktrees whose directories are gone.
///
/// Idempotent, and safe to call at startup: it touches only Git's own record of
/// worktrees that no longer exist, and never a directory.
pub fn prune(repo: &Path) -> Result<(), String> {
    run(repo, &["worktree", "prune"]).map(|_| ())
}

/// Refuse a path that is not a plain entry inside the worktree.
///
/// Both the directories a run wants symlinked and the paths it wants a sparse
/// checkout narrowed to are repository-relative, and both are attacker-reachable
/// through persisted state, so both pass through here. The refusals are the ones
/// that would otherwise let an entry name something outside the worktree or the
/// repository's own bookkeeping:
///
/// - an absolute path (`/etc/...`), a Windows drive (`C:\...`, `C:/...`) or a
///   UNC path (`\\server\share`) — all of which name somewhere other than a
///   place inside the worktree;
/// - a backslash anywhere, which is both the Windows separator and the lead-in
///   for the two cases above — a repository-relative path is written with `/`;
/// - a `..` component, which climbs out of the worktree;
/// - a `.git` component, in any case, which reaches into the repository's own
///   directory rather than its working tree.
///
/// A rejected entry fails the whole call. Silently skipping it would apply an
/// optimization the caller did not get to see refused.
pub fn validate_repo_rel(p: &str) -> Result<(), String> {
    if p.is_empty() {
        return Err("an empty path is not a valid entry".to_string());
    }
    if p.contains('\\') {
        return Err(format!(
            "{p} contains a backslash; a path inside the worktree is written with forward slashes"
        ));
    }
    if p.starts_with('/') {
        return Err(format!(
            "{p} is absolute; only paths inside the worktree are allowed"
        ));
    }
    let bytes = p.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Err(format!(
            "{p} names a drive; only paths inside the worktree are allowed"
        ));
    }
    for segment in p.split('/') {
        if segment == ".." {
            return Err(format!("{p} climbs out of the worktree with `..`"));
        }
        if segment.eq_ignore_ascii_case(".git") {
            return Err(format!("{p} reaches into the repository's .git directory"));
        }
    }
    Ok(())
}

/// Create a directory link at `link` that points at `target`.
///
/// A link rather than a copy so a heavy directory — `node_modules`, a build
/// cache — is shared with the source rather than duplicated for every worktree.
#[cfg(unix)]
fn link_dir(target: &Path, link: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link).map_err(|e| {
        format!(
            "could not link {} -> {}: {e}",
            link.display(),
            target.display()
        )
    })
}

/// As [`link_dir`], on Windows.
///
/// A directory symlink is preferred, but creating one needs a privilege the
/// user may not hold (`SeCreateSymbolicLinkPrivilege`), so a denied symlink
/// falls back to a junction, which needs no privilege and shares the directory
/// just as well.
#[cfg(windows)]
fn link_dir(target: &Path, link: &Path) -> Result<(), String> {
    if std::os::windows::fs::symlink_dir(target, link).is_ok() {
        return Ok(());
    }
    // `mklink /J <link> <target>` is a `cmd` builtin, so it runs through `cmd`.
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .env("GIT_TERMINAL_PROMPT", "0");
    jan_utils::system::hide_console_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("could not create a junction at {}: {e}", link.display()))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "could not link {} -> {}: {}",
            link.display(),
            target.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Apply opt-in optimizations to an already-created worktree.
///
/// Two independent optimizations, applied in a fixed order:
///
/// 1. **Sparse checkout, first.** When `sparse_paths` is non-empty the worktree
///    is switched to cone-mode sparse checkout and narrowed to those paths. This
///    happens before any link because `sparse-checkout set` rewrites the working
///    tree to match the cone — materialising and pruning tracked paths. A link
///    placed first could sit in a directory that a later checkout then removes or
///    collides with; narrowing the tracked tree first leaves each link in a spot
///    git will not touch again.
///
/// 2. **Directory links, after.** Each entry in `symlink_dirs` becomes a link
///    inside the worktree pointing at the same relative directory in the source
///    working tree, so a heavy directory is shared rather than recopied. An entry
///    whose path already exists in the worktree is an error, never an overwrite:
///    the run may have created it or the sparse checkout just materialised it,
///    and replacing it with a link would discard it.
///
/// Every entry in both lists is validated with [`validate_repo_rel`] up front, so
/// a bad entry fails the call before anything is written.
pub fn apply_optimizations(
    worktree: &Path,
    source_root: &Path,
    symlink_dirs: &[String],
    sparse_paths: &[String],
) -> Result<(), String> {
    for entry in sparse_paths.iter().chain(symlink_dirs.iter()) {
        validate_repo_rel(entry)?;
    }

    if !sparse_paths.is_empty() {
        run(worktree, &["sparse-checkout", "init", "--cone"])?;
        let mut args: Vec<&str> = vec!["sparse-checkout", "set"];
        args.extend(sparse_paths.iter().map(String::as_str));
        run(worktree, &args)?;
    }

    for rel in symlink_dirs {
        let link = worktree.join(rel);
        let target = source_root.join(rel);
        // `symlink_metadata` rather than `exists`, so a path that is already a
        // (possibly broken) link is caught too, not just a real directory.
        if link.symlink_metadata().is_ok() {
            return Err(format!(
                "{} already exists in the worktree; refusing to replace it with a link",
                link.display()
            ));
        }
        if let Some(parent) = link.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }
        link_dir(&target, &link)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R20: creating an isolated checkout runs no hook the repository holds.
    #[test]
    fn an_isolated_checkout_runs_no_hook() {
        let base = std::env::temp_dir().join(format!("jan-wt-nohook-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git_in(&repo, &["init", "-q", "-b", "main"]);
        git_in(&repo, &["config", "user.email", "t@example.invalid"]);
        git_in(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("f.txt"), "f\n").unwrap();
        git_in(&repo, &["add", "-A"]);
        git_in(&repo, &["commit", "-qm", "first"]);
        let marker = base.join("hook-ran.txt");
        std::fs::write(
            repo.join(".git/hooks/post-checkout"),
            format!(
                "#!/bin/sh\necho ran > '{}'\n",
                marker.to_string_lossy().replace('\\', "/")
            ),
        )
        .unwrap();
        let checkout = base.join("checkout");
        run(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "isolated",
                &checkout.to_string_lossy(),
            ],
        )
        .expect("worktree add");
        assert!(checkout.join("f.txt").exists());
        assert!(!marker.exists(), "the repository's post-checkout hook ran");
        let _ = run(
            &repo,
            &["worktree", "remove", "--force", &checkout.to_string_lossy()],
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Reopening a cowork session runs, from a process with no console, the
    /// git helpers a restore needs: status, worktree prune/list/ensure/state,
    /// a checkpoint, the folder identity, and the job reconcile. None of that
    /// may put a console window on screen. Watched on the real desktop from a
    /// console-less copy of this test binary.
    #[cfg(windows)]
    #[test]
    fn restoring_a_session_opens_no_console_window() {
        use jan_process::console_watch::{headless_case, Expect};
        let name = std::thread::current().name().unwrap().to_string();
        headless_case(
            &name,
            || {
                let base =
                    std::env::temp_dir().join(format!("jan-wt-restore {}", std::process::id()));
                let _ = std::fs::remove_dir_all(&base);
                let repo = base.join("repo with space");
                std::fs::create_dir_all(&repo).unwrap();
                git_in(&repo, &["init", "-q", "-b", "main"]);
                git_in(&repo, &["config", "user.email", "t@example.invalid"]);
                git_in(&repo, &["config", "user.name", "Test"]);
                std::fs::write(repo.join("f.txt"), "f\n").unwrap();
                git_in(&repo, &["add", "-A"]);
                git_in(&repo, &["commit", "-qm", "first"]);
                std::fs::write(repo.join("f.txt"), "changed\n").unwrap();
                let roots = base.join("worktrees");
                let data = base.join("data");
                std::fs::create_dir_all(&data).unwrap();
                // A few times over, the way a restore that renders and
                // re-renders does, so a window with a lifetime of milliseconds
                // has many chances to be caught.
                for _ in 0..3 {
                    let status =
                        super::super::git::status(&repo, super::super::git::DiffScope::All)
                            .unwrap();
                    assert_eq!(status.branch.as_deref(), Some("main"));
                    let _ = prune(&repo);
                    let record =
                        ensure(&repo, &roots, "059d197c-c025-57a1-90ec-b71420e584f0").unwrap();
                    assert_eq!(state(&record), WorktreeState::Ready);
                    assert_eq!(list(&repo, &roots).len(), 1);
                    let made = super::super::checkpoint::capture(
                        &repo,
                        "059d197c-c025-57a1-90ec-b71420e584f0",
                        None,
                        "restore",
                        &[PathBuf::from("f.txt")],
                        super::super::checkpoint::Destination::UserCheckout,
                    )
                    .unwrap();
                    assert!(!made.sha.is_empty());
                    let _ = super::super::session_bundle::folder_identity(&repo);
                    let _ = tauri_plugin_agent_tools::worker::reconcile_all(&data);
                }
                let _ = std::fs::remove_dir_all(&base);
            },
            Expect::NoWindow,
        );
    }

    fn git_in(dir: &Path, args: &[&str]) {
        use jan_process::CommandConsole;
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            // Test scaffolding, not the code under test: from a console-less
            // process a plain `git` would open a window of its own and the
            // window test below would blame the wrong thing.
            .background()
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        repo: PathBuf,
        worktrees: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().join("repo");
        let worktrees = dir.path().join("worktrees");
        std::fs::create_dir_all(&repo).unwrap();
        git_in(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one").unwrap();
        git_in(&repo, &["add", "."]);
        git_in(&repo, &["commit", "-q", "-m", "first"]);
        Fixture {
            _dir: dir,
            repo,
            worktrees,
        }
    }

    /// The regression, found on Windows: the app's data folder was the
    /// relative `./data`, git resolved the worktree against the repository and
    /// everything else against the working directory, and authorizing the
    /// worktree then failed with "cannot find the file". A relative root is
    /// now made absolute once, so the record names the worktree where it is.
    #[test]
    fn a_relative_worktrees_root_is_resolved_once_and_never_inside_the_repo() {
        let f = fixture();
        let relative = PathBuf::from(format!("target/jan-wt-relative-{}", std::process::id()));
        let record = ensure(&f.repo, &relative, "session-rel").expect("created");
        let path = PathBuf::from(&record.path);
        assert!(path.is_absolute(), "{}", record.path);
        assert!(path.is_dir(), "the record names where the worktree is");
        assert!(
            !path.starts_with(f.repo.canonicalize().unwrap()) && !path.starts_with(&f.repo),
            "the worktree landed inside the repository: {}",
            record.path
        );
        assert_eq!(state(&record), WorktreeState::Ready);
        let _ = discard(&record, true);
        let _ = std::fs::remove_dir_all(&relative);
    }

    #[test]
    fn absolute_resolves_dots_without_touching_the_disk() {
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(
            absolute(Path::new("./a/./b/../c")).unwrap(),
            cwd.join("a").join("c")
        );
        let abs = cwd.join("x");
        assert_eq!(absolute(&abs).unwrap(), abs);
    }

    #[test]
    fn identifies_a_repository_by_its_first_commit() {
        let f = fixture();
        let id = identity(&f.repo).expect("identity");
        assert!(id.first_commit.is_some());
        // The key is what names the directory, so it has to be stable.
        assert_eq!(id.key(), identity(&f.repo).unwrap().key());
    }

    #[test]
    fn two_repositories_are_not_the_same_repository() {
        let f = fixture();
        let other = f._dir.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        git_in(&other, &["init", "-q", "-b", "main"]);
        std::fs::write(other.join("b.txt"), "two").unwrap();
        git_in(&other, &["add", "."]);
        git_in(&other, &["commit", "-q", "-m", "first"]);

        assert_ne!(identity(&f.repo).unwrap(), identity(&other).unwrap());
        assert_ne!(
            identity(&f.repo).unwrap().key(),
            identity(&other).unwrap().key()
        );
    }

    #[test]
    fn refuses_a_folder_that_is_not_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        assert!(identity(dir.path()).is_err());
    }

    #[test]
    fn creates_a_worktree_outside_the_source_checkout() {
        let f = fixture();
        let record = ensure(&f.repo, &f.worktrees, "session-1").expect("create");

        let path = PathBuf::from(&record.path);
        assert!(path.exists());
        // The property the whole mode rests on: the isolated checkout is not
        // inside the one the user is working in.
        assert!(!path.starts_with(&f.repo));
        assert_eq!(record.branch, branch_name("session-1"));
        assert_eq!(state(&record), WorktreeState::Ready);
    }

    #[test]
    fn the_source_checkout_is_left_alone() {
        let f = fixture();
        let before = std::fs::read_to_string(f.repo.join("a.txt")).unwrap();
        let branch_before = run(&f.repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();

        let record = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        std::fs::write(PathBuf::from(&record.path).join("a.txt"), "changed").unwrap();

        assert_eq!(
            std::fs::read_to_string(f.repo.join("a.txt")).unwrap(),
            before
        );
        assert_eq!(
            run(&f.repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(),
            branch_before
        );
    }

    #[test]
    fn reuses_the_same_worktree_across_restarts() {
        let f = fixture();
        let first = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        // A second call is what happens after a restart: it must find the work
        // that is already there rather than start a second branch beside it.
        let second = ensure(&f.repo, &f.worktrees, "session-1").expect("reuse");

        assert_eq!(first.path, second.path);
        assert_eq!(first.branch, second.branch);
    }

    #[test]
    fn different_sessions_get_different_worktrees() {
        let f = fixture();
        let a = ensure(&f.repo, &f.worktrees, "session-1").expect("a");
        let b = ensure(&f.repo, &f.worktrees, "session-2").expect("b");

        assert_ne!(a.path, b.path);
        assert_ne!(a.branch, b.branch);
    }

    #[test]
    fn refuses_a_branch_that_is_already_someone_elses() {
        let f = fixture();
        // Picking another name here would leave the user with two branches and
        // no explanation of why.
        git_in(&f.repo, &["branch", &branch_name("session-1")]);

        let err = ensure(&f.repo, &f.worktrees, "session-1").expect_err("refuse");
        assert!(err.contains("already exists"), "{err}");
    }

    #[test]
    fn refuses_a_directory_in_its_place_that_is_not_a_worktree() {
        let f = fixture();
        let id = identity(&f.repo).unwrap();
        let path = worktree_path(&f.worktrees, &id, "session-1");
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("stray.txt"), "not ours").unwrap();

        let err = ensure(&f.repo, &f.worktrees, "session-1").expect_err("refuse");
        assert!(err.contains("not a worktree"), "{err}");
    }

    #[test]
    fn records_what_the_worktree_could_not_see() {
        let f = fixture();
        // A worktree is made from committed state, so this edit is invisible to
        // the run. Recording it is what lets the UI say so.
        std::fs::write(f.repo.join("a.txt"), "uncommitted change").unwrap();
        std::fs::write(f.repo.join("new.txt"), "untracked").unwrap();

        let record = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        assert!(record.uncommitted_at_creation.iter().any(|p| p == "a.txt"));
        assert!(record
            .uncommitted_at_creation
            .iter()
            .any(|p| p == "new.txt"));
    }

    /// Run git expecting failure: a conflicting merge, rebase, cherry-pick or
    /// revert exits non-zero and leaves its state behind, which is the point.
    fn git_conflicting(dir: &Path, args: &[&str]) {
        use jan_process::CommandConsole;
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .background()
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("GIT_EDITOR", "true")
            .output()
            .expect("git");
        assert!(
            !out.status.success(),
            "git {args:?} was expected to stop on a conflict"
        );
    }

    /// `main` and `topic` both edit a.txt; returns the fixture on `main` with
    /// `topic`'s commit available to conflict with.
    fn diverged() -> Fixture {
        let f = fixture();
        git_in(&f.repo, &["checkout", "-q", "-b", "topic"]);
        std::fs::write(f.repo.join("a.txt"), "topic").unwrap();
        git_in(&f.repo, &["commit", "-q", "-am", "topic edit"]);
        git_in(&f.repo, &["checkout", "-q", "main"]);
        std::fs::write(f.repo.join("a.txt"), "main").unwrap();
        git_in(&f.repo, &["commit", "-q", "-am", "main edit"]);
        f
    }

    /// A stopped operation in the checkout no longer blocks a worktree: it is
    /// built from HEAD's commit, clean, and the record says what it did not
    /// carry. The operation in the checkout is left exactly where it was.
    fn assert_created_despite(f: &Fixture, op: &str, session: &str) {
        let stopped = operation_in_progress(&f.repo).expect("operation detected");
        assert_eq!(stopped.operation, op);
        assert_eq!(stopped.unresolved, vec!["a.txt".to_string()]);
        let head = run(&f.repo, &["rev-parse", "HEAD"]).unwrap();
        let record = ensure(&f.repo, &f.worktrees, session).expect("created from HEAD");
        assert_eq!(record.base_sha, head);
        assert!(
            record
                .notes
                .iter()
                .any(|n| n.contains(&format!("has a {op} in progress"))),
            "{:?}",
            record.notes
        );
        let wt = PathBuf::from(&record.path);
        assert!(pending(&record).is_empty(), "the worktree starts clean");
        assert!(!std::fs::read_to_string(wt.join("a.txt"))
            .unwrap()
            .contains("<<<<<<<"));
        assert_eq!(operation_in_progress(&wt), None);
        // The checkout still has its operation.
        assert_eq!(
            operation_in_progress(&f.repo).map(|o| o.operation),
            Some(stopped.operation)
        );
    }

    /// #314: a worktree built from HEAD silently dropped a stopped merge.
    #[test]
    fn creates_a_worktree_despite_a_merge_in_progress() {
        let f = diverged();
        git_conflicting(&f.repo, &["merge", "topic"]);
        assert_created_despite(&f, "merge", "sess-merge");
    }

    #[test]
    fn creates_a_worktree_despite_a_rebase_in_progress() {
        let f = diverged();
        git_conflicting(&f.repo, &["rebase", "topic"]);
        assert_created_despite(&f, "rebase", "sess-rebase");
    }

    #[test]
    fn creates_a_worktree_despite_a_cherry_pick_in_progress() {
        let f = diverged();
        git_conflicting(&f.repo, &["cherry-pick", "topic"]);
        assert_created_despite(&f, "cherry-pick", "sess-pick");
    }

    #[test]
    fn creates_a_worktree_despite_a_revert_in_progress() {
        let f = fixture();
        std::fs::write(f.repo.join("a.txt"), "two").unwrap();
        git_in(&f.repo, &["commit", "-q", "-am", "second"]);
        std::fs::write(f.repo.join("a.txt"), "three").unwrap();
        git_in(&f.repo, &["commit", "-q", "-am", "third"]);
        git_conflicting(&f.repo, &["revert", "--no-edit", "HEAD~1"]);
        assert_created_despite(&f, "revert", "sess-revert");
    }

    #[test]
    fn many_sessions_on_one_repository_get_their_own_worktrees_and_branches() {
        let f = fixture();
        let sessions = ["s-one", "s-two", "s-three", "s-four"];
        let records: Vec<WorktreeRecord> = std::thread::scope(|scope| {
            let handles: Vec<_> = sessions
                .iter()
                .map(|id| {
                    let (repo, roots) = (&f.repo, &f.worktrees);
                    scope.spawn(move || {
                        let options = EnsureOptions {
                            title: Some("Fix the parser".to_string()),
                            base: None,
                        };
                        // Git serialises its own ref/worktree writes with lock
                        // files; a concurrent loser retries like a user would.
                        let mut last = String::new();
                        for _ in 0..20 {
                            match ensure_with(repo, roots, id, &options) {
                                Ok(r) => return r,
                                Err(e) => last = e,
                            }
                            std::thread::sleep(std::time::Duration::from_millis(50));
                        }
                        panic!("{id}: {last}")
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let mut paths: Vec<&str> = records.iter().map(|r| r.path.as_str()).collect();
        let mut branches: Vec<&str> = records.iter().map(|r| r.branch.as_str()).collect();
        paths.sort();
        paths.dedup();
        branches.sort();
        branches.dedup();
        assert_eq!(paths.len(), sessions.len());
        assert_eq!(branches.len(), sessions.len());
        for r in &records {
            assert!(r.branch.starts_with("flint/fix-parser-"), "{}", r.branch);
            assert_eq!(r.base_branch.as_deref(), Some("main"));
        }
        // Each writes its own file without seeing the others'.
        for (i, r) in records.iter().enumerate() {
            std::fs::write(PathBuf::from(&r.path).join(format!("f{i}.txt")), "x").unwrap();
        }
        for (i, r) in records.iter().enumerate() {
            assert_eq!(pending(r), vec![format!("f{i}.txt")]);
        }
        assert_eq!(list(&f.repo, &f.worktrees).len(), sessions.len());
        // And the user's checkout saw none of it.
        assert!(uncommitted(&f.repo).is_empty());
    }

    #[test]
    fn a_titled_branch_is_readable_and_confined_to_its_namespace() {
        let b = titled_branch_name("Fix: the ../../main Parser!", "id-1");
        assert!(b.starts_with("flint/fix-main-parser-"), "{b}");
        assert!(!b.contains(".."));
        assert!(titled_branch_name("***", "id-1").starts_with("flint/session-"));
        assert_ne!(titled_branch_name("x", "a"), titled_branch_name("x", "b"));
    }

    #[test]
    fn a_titled_branch_drops_filler_and_keeps_whole_words() {
        let b = titled_branch_name(
            "can you edit bodycam.as so that the drone camera keeps its FOV",
            "id-1",
        );
        let id = &short_id("id-1")[..6];
        assert_eq!(b, format!("flint/edit-bodycam-as-drone-camera-{id}"));
        let only_filler = titled_branch_name("can you do that", "id-1");
        assert_eq!(only_filler, format!("flint/can-you-do-that-{id}"));
        let long = titled_branch_name("refactorthewholeenormousrenderingpipelinenow", "id-1");
        assert!(
            long.len() <= "flint/".len() + BRANCH_MAX_CHARS + 7,
            "{long}"
        );
    }

    #[test]
    fn a_session_keeps_its_worktree_when_its_title_changes() {
        let f = fixture();
        let first = ensure_with(
            &f.repo,
            &f.worktrees,
            "s1",
            &EnsureOptions {
                title: Some("First".into()),
                base: None,
            },
        )
        .unwrap();
        let again = ensure_with(
            &f.repo,
            &f.worktrees,
            "s1",
            &EnsureOptions {
                title: Some("Renamed".into()),
                base: None,
            },
        )
        .unwrap();
        assert_eq!(first.path, again.path);
        assert_eq!(first.branch, again.branch);
    }

    #[test]
    fn a_worktree_can_start_from_a_branch_the_user_picks() {
        let f = fixture();
        git_in(&f.repo, &["branch", "develop"]);
        git_in(&f.repo, &["checkout", "-q", "develop"]);
        std::fs::write(f.repo.join("d.txt"), "d").unwrap();
        git_in(&f.repo, &["add", "."]);
        git_in(&f.repo, &["commit", "-q", "-m", "dev"]);
        git_in(&f.repo, &["checkout", "-q", "main"]);
        let r = ensure_with(
            &f.repo,
            &f.worktrees,
            "s1",
            &EnsureOptions {
                title: None,
                base: Some("develop".into()),
            },
        )
        .unwrap();
        assert_eq!(r.base_branch.as_deref(), Some("develop"));
        assert!(PathBuf::from(&r.path).join("d.txt").exists());
        assert!(ensure_with(
            &f.repo,
            &f.worktrees,
            "s2",
            &EnsureOptions {
                title: None,
                base: Some("--upload-pack=x".into())
            },
        )
        .is_err());
    }

    #[test]
    fn a_worktree_is_created_beside_uncommitted_changes_and_says_so() {
        let f = fixture();
        std::fs::write(f.repo.join("a.txt"), "edited").unwrap();
        let r = ensure(&f.repo, &f.worktrees, "s1").unwrap();
        assert_eq!(r.uncommitted_at_creation, vec!["a.txt".to_string()]);
        assert_eq!(
            std::fs::read_to_string(PathBuf::from(&r.path).join("a.txt")).unwrap(),
            "one"
        );
    }

    #[test]
    fn a_worktree_made_by_an_older_build_is_still_found() {
        let f = fixture();
        let id = identity(&f.repo).unwrap();
        let old = legacy_worktree_path(&f.worktrees, &id, "s-old");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        git_in(
            &f.repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                &branch_name("s-old"),
                &old.to_string_lossy(),
            ],
        );
        let r = ensure(&f.repo, &f.worktrees, "s-old").expect("reused");
        assert_eq!(
            PathBuf::from(&r.path).canonicalize().unwrap(),
            old.canonicalize().unwrap()
        );
    }

    fn commit_in(dir: &Path, file: &str, body: &str) {
        std::fs::write(dir.join(file), body).unwrap();
        git_in(dir, &["add", "."]);
        git_in(dir, &["commit", "-q", "-m", file]);
    }

    #[test]
    fn merging_fast_forwards_the_checked_out_base() {
        let f = fixture();
        let r = ensure(&f.repo, &f.worktrees, "s1").unwrap();
        commit_in(Path::new(&r.path), "b.txt", "b");
        let out = merge(&r, None, None).unwrap();
        assert!(out.merged && out.fast_forward, "{out:?}");
        assert_eq!(out.target, "main");
        // The user's checkout moved with its branch.
        assert!(f.repo.join("b.txt").exists());
        assert!(uncommitted(&f.repo).is_empty());
        assert!(unmerged_commits(&r, None).is_empty());
        // Merging again changes nothing.
        assert!(merge(&r, None, None).unwrap().already_merged);
    }

    #[test]
    fn merging_writes_a_merge_commit_when_the_base_moved() {
        let f = fixture();
        let r = ensure(&f.repo, &f.worktrees, "s1").unwrap();
        commit_in(Path::new(&r.path), "b.txt", "b");
        commit_in(&f.repo, "c.txt", "c");
        let out = merge(&r, None, None).unwrap();
        assert!(out.merged && !out.fast_forward, "{out:?}");
        assert!(f.repo.join("b.txt").exists() && f.repo.join("c.txt").exists());
        let parents = run(&f.repo, &["rev-list", "--parents", "-n", "1", "HEAD"]).unwrap();
        assert_eq!(parents.split_whitespace().count(), 3, "{parents}");
    }

    #[test]
    fn merging_commits_pending_work_only_when_asked() {
        let f = fixture();
        let r = ensure(&f.repo, &f.worktrees, "s1").unwrap();
        std::fs::write(PathBuf::from(&r.path).join("n.txt"), "n").unwrap();
        let err = merge(&r, None, None).expect_err("pending work named");
        assert!(err.contains("n.txt"), "{err}");
        let out = merge(&r, None, Some("Add n")).unwrap();
        assert!(out.merged && out.committed_pending);
        assert!(f.repo.join("n.txt").exists());
    }

    #[test]
    fn a_conflicting_merge_reports_its_files_and_changes_nothing() {
        let f = fixture();
        let r = ensure(&f.repo, &f.worktrees, "s1").unwrap();
        commit_in(Path::new(&r.path), "a.txt", "session");
        commit_in(&f.repo, "a.txt", "user");
        let before = run(&f.repo, &["rev-parse", "HEAD"]).unwrap();
        let out = merge(&r, None, None).unwrap();
        assert!(!out.merged);
        assert_eq!(out.conflicts, vec!["a.txt".to_string()]);
        assert_eq!(run(&f.repo, &["rev-parse", "HEAD"]).unwrap(), before);
        assert_eq!(operation_in_progress(&f.repo), None);
        assert_eq!(
            std::fs::read_to_string(f.repo.join("a.txt")).unwrap(),
            "user"
        );
    }

    #[test]
    fn merging_into_a_dirty_checkout_is_refused() {
        let f = fixture();
        let r = ensure(&f.repo, &f.worktrees, "s1").unwrap();
        commit_in(Path::new(&r.path), "b.txt", "b");
        std::fs::write(f.repo.join("a.txt"), "user work").unwrap();
        let err = merge(&r, None, None).expect_err("refused");
        assert!(err.contains("uncommitted"), "{err}");
        assert_eq!(
            std::fs::read_to_string(f.repo.join("a.txt")).unwrap(),
            "user work"
        );
        assert!(!f.repo.join("b.txt").exists());
    }

    #[test]
    fn merging_a_base_nobody_has_checked_out_moves_only_the_ref() {
        let f = fixture();
        git_in(&f.repo, &["branch", "release"]);
        let r = ensure_with(
            &f.repo,
            &f.worktrees,
            "s1",
            &EnsureOptions {
                title: None,
                base: Some("release".into()),
            },
        )
        .unwrap();
        commit_in(Path::new(&r.path), "b.txt", "b");
        std::fs::write(f.repo.join("a.txt"), "dirty main is irrelevant").unwrap();
        let out = merge(&r, None, None).unwrap();
        assert!(out.merged, "{out:?}");
        let tip = run(&f.repo, &["rev-parse", "refs/heads/release"]).unwrap();
        assert_eq!(Some(tip), out.new_tip);
    }

    #[test]
    fn discarding_refuses_commits_that_were_never_merged() {
        let f = fixture();
        let r = ensure(&f.repo, &f.worktrees, "s1").unwrap();
        commit_in(Path::new(&r.path), "b.txt", "b");
        let err = discard(&r, false).expect_err("unmerged work kept");
        assert!(err.contains("not in main"), "{err}");
        assert!(PathBuf::from(&r.path).exists());
        merge(&r, None, None).unwrap();
        discard(&r, false).expect("merged work can go");
    }

    #[test]
    fn a_branch_follows_the_session_title() {
        let f = fixture();
        let r = ensure_with(
            &f.repo,
            &f.worktrees,
            "s1",
            &EnsureOptions {
                title: Some("New session".into()),
                base: None,
            },
        )
        .unwrap();
        let renamed = rename_branch(&r, "s1", "Add dark mode").unwrap();
        assert!(
            renamed.branch.starts_with("flint/add-dark-mode-"),
            "{}",
            renamed.branch
        );
        assert_eq!(state(&renamed), WorktreeState::Ready);
        assert_eq!(
            ensure(&f.repo, &f.worktrees, "s1").unwrap().branch,
            renamed.branch
        );
    }

    #[test]
    fn a_finished_merge_no_longer_blocks_a_worktree() {
        let f = diverged();
        git_conflicting(&f.repo, &["merge", "topic"]);
        git_in(&f.repo, &["merge", "--abort"]);
        assert_eq!(operation_in_progress(&f.repo), None);
        ensure(&f.repo, &f.worktrees, "sess-after").expect("created once the merge is gone");
    }

    /// A worktree made before the merge started is still the session's own;
    /// resuming it is not refused.
    #[test]
    fn an_existing_worktree_is_reused_despite_a_later_merge() {
        let f = diverged();
        let first = ensure(&f.repo, &f.worktrees, "sess-early").unwrap();
        git_conflicting(&f.repo, &["merge", "topic"]);
        let again = ensure(&f.repo, &f.worktrees, "sess-early").expect("reused");
        assert_eq!(first.path, again.path);
    }

    #[test]
    fn notices_a_worktree_that_was_deleted_underneath_it() {
        let f = fixture();
        let record = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        std::fs::remove_dir_all(&record.path).unwrap();

        assert_eq!(state(&record), WorktreeState::Missing);
    }

    #[test]
    fn notices_a_branch_someone_else_moved() {
        let f = fixture();
        let record = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        git_in(
            &PathBuf::from(&record.path),
            &["checkout", "-q", "-b", "somebody-elses"],
        );

        // Not silently reset: the caller is told, and decides.
        assert_eq!(state(&record), WorktreeState::BranchMoved);
    }

    #[test]
    fn notices_a_directory_that_stopped_being_a_worktree() {
        let f = fixture();
        let record = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        std::fs::remove_dir_all(PathBuf::from(&record.path).join(".git"))
            .or_else(|_| std::fs::remove_file(PathBuf::from(&record.path).join(".git")))
            .unwrap();

        assert_eq!(state(&record), WorktreeState::Corrupt);
    }

    #[test]
    fn notices_a_different_repository_at_the_same_path() {
        let f = fixture();
        let mut record = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        // A re-clone at the same path is a different repository, and reusing a
        // worktree for it would put one project's work in another's branch.
        record.identity.first_commit = Some("0".repeat(40));

        assert_eq!(state(&record), WorktreeState::IdentityChanged);
    }

    #[test]
    fn discarding_removes_the_worktree_and_its_branch() {
        let f = fixture();
        let record = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        std::fs::write(PathBuf::from(&record.path).join("a.txt"), "dirty").unwrap();

        discard(&record, true).expect("discard");

        assert!(!PathBuf::from(&record.path).exists());
        assert!(run(
            &f.repo,
            &[
                "rev-parse",
                "--verify",
                &format!("refs/heads/{}", branch_name("session-1"))
            ]
        )
        .is_err());
        // And the repository it came from is still intact.
        assert!(f.repo.join("a.txt").exists());
    }

    #[test]
    fn pruning_is_safe_to_repeat() {
        let f = fixture();
        let record = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        std::fs::remove_dir_all(&record.path).unwrap();

        assert!(prune(&f.repo).is_ok());
        assert!(prune(&f.repo).is_ok());
    }

    #[test]
    fn a_worktree_path_stays_inside_its_root() {
        let f = fixture();
        let id = identity(&f.repo).unwrap();
        // Session ids reach this from persisted state; a crafted one must not
        // be able to climb out of the directory Flint owns.
        let path = worktree_path(&f.worktrees, &id, "../../etc/passwd");
        assert!(path.starts_with(&f.worktrees), "{}", path.display());
    }

    #[test]
    fn a_branch_name_cannot_be_forged_from_a_session_id() {
        // Same concern, on the ref namespace: everything Flint creates is under
        // `jan/cowork/`, whatever the id contains.
        assert!(branch_name("../../main").starts_with("jan/cowork/"));
        assert!(branch_name("").starts_with("jan/cowork/"));
        assert!(!branch_name("a/b").contains("a/b"));
    }

    #[test]
    fn lists_only_the_worktrees_jan_made_here() {
        let f = fixture();
        let mine = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        // One the user made themselves, in a place of their own.
        let theirs = f._dir.path().join("their-worktree");
        git_in(
            &f.repo,
            &[
                "worktree",
                "add",
                "-b",
                "their-branch",
                &theirs.to_string_lossy(),
            ],
        );

        let found = list(&f.repo, &f.worktrees);

        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].path, mine.path);
        assert_eq!(found[0].branch, mine.branch);
        assert_eq!(found[0].base_sha, mine.base_sha);
        // A worktree Flint did not make is not Flint's to list, offer to delete, or
        // reason about.
        assert!(!found.iter().any(|one| one.branch == "their-branch"));
    }

    #[test]
    fn a_listed_worktree_carries_no_authority() {
        // Recovery finds work; it does not restore access to it. The record is
        // a place and a branch — there is nowhere in it for a grant to be, so
        // a recovered worktree cannot be written until someone authorizes it
        // again.
        let f = fixture();
        ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        let found = list(&f.repo, &f.worktrees);
        let json = serde_json::to_string(&found[0]).expect("serialize");
        assert!(!json.contains("grant"), "{json}");
    }

    #[test]
    fn refuses_to_discard_work_nobody_has_seen() {
        let f = fixture();
        let record = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        std::fs::write(PathBuf::from(&record.path).join("new.txt"), "work").unwrap();

        let err = discard(&record, false).expect_err("must refuse");
        assert!(err.contains("new.txt"), "{err}");
        assert!(
            PathBuf::from(&record.path).exists(),
            "the worktree must still be there"
        );
        assert_eq!(pending(&record), vec!["new.txt".to_string()]);

        // Forced is the same operation, chosen: the caller had to have been
        // told what it holds to get here.
        discard(&record, true).expect("forced discard");
        assert!(!PathBuf::from(&record.path).exists());
    }

    /// Jozkah/jan#57: a record whose path is a decoy under the worktrees root
    /// cannot carry another repository's branch into `git branch -D`; a real
    /// Flint worktree is still discarded.
    #[test]
    fn discard_owned_refuses_a_record_git_does_not_list() {
        let f = fixture();
        git_in(&f.repo, &["branch", "precious"]);
        let decoy = WorktreeRecord {
            path: f.worktrees.join("decoy").to_string_lossy().into_owned(),
            branch: "precious".to_string(),
            base_sha: String::new(),
            source_root: f.repo.to_string_lossy().into_owned(),
            identity: identity(&f.repo).expect("identity"),
            uncommitted_at_creation: Vec::new(),
            base_branch: None,
            notes: Vec::new(),
        };
        assert!(discard_owned(&decoy, &f.worktrees, false).is_err());
        let still = std::process::Command::new("git")
            .args([
                "-C",
                &decoy.source_root,
                "rev-parse",
                "--verify",
                "refs/heads/precious",
            ])
            .output()
            .expect("git");
        assert!(still.status.success(), "the unrelated branch was deleted");

        // A real worktree's own record, but pointed at another branch.
        let record = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        let mut swapped = record.clone();
        swapped.branch = "precious".to_string();
        assert!(discard_owned(&swapped, &f.worktrees, true).is_err());

        discard_owned(&record, &f.worktrees, false).expect("a real worktree is discarded");
        assert!(!PathBuf::from(&record.path).exists());
    }

    #[test]
    fn a_clean_worktree_needs_no_forcing() {
        let f = fixture();
        let record = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        assert!(pending(&record).is_empty());
        discard(&record, false).expect("nothing to lose");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_worktrees_root_that_leads_somewhere_else() {
        // The check has to be on the disk, not the string: a symlink where Flint
        // keeps its worktrees would otherwise make "under the data folder"
        // true of the name and false of the place.
        let f = fixture();
        let elsewhere = f._dir.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let linked = f._dir.path().join("linked");
        std::os::unix::fs::symlink(&elsewhere, &linked).unwrap();

        // The root itself resolving elsewhere is fine — it is still one place
        // Flint owns. What must not happen is a *child* escaping it.
        let inside = linked.join("sub");
        assert!(contained(&inside, &linked));
        assert!(!contained(&elsewhere.join(".."), &linked));
        assert!(
            !contained(&linked, &linked),
            "the root is not inside itself"
        );
    }

    #[test]
    fn refuses_a_worktree_inside_the_checkout_it_protects() {
        let f = fixture();
        let inside = f.repo.join(".jan-worktrees");
        let err = ensure(&f.repo, &inside, "session-1").expect_err("must refuse");
        assert!(err.contains("inside the repository"), "{err}");
    }

    #[test]
    fn ids_sharing_a_long_prefix_get_different_destinations() {
        // A team's isolated children are named after the session and the run
        // that dispatched them, so they differ only in the last few
        // characters. Two of them sharing a branch or a directory would put
        // two agents in one checkout while each is told it has its own.
        let f = fixture();
        let id = identity(&f.repo).unwrap();
        let a = "3f2a9c1e-1234-4c9a-9b7e-000000000000--child-parser";
        let b = "3f2a9c1e-1234-4c9a-9b7e-000000000000--child-docs";

        assert_ne!(branch_name(a), branch_name(b));
        assert_ne!(
            worktree_path(&f.worktrees, &id, a),
            worktree_path(&f.worktrees, &id, b)
        );
        // And still stable: the same id names the same place next time.
        assert_eq!(branch_name(a), branch_name(a));
        assert_eq!(
            worktree_path(&f.worktrees, &id, a),
            worktree_path(&f.worktrees, &id, a)
        );
    }

    #[test]
    fn validate_repo_rel_accepts_ordinary_entries() {
        assert!(validate_repo_rel("node_modules").is_ok());
        assert!(validate_repo_rel("src").is_ok());
        assert!(validate_repo_rel("packages/app/dist").is_ok());
    }

    #[test]
    fn validate_repo_rel_refuses_absolute_drive_and_unc() {
        assert!(validate_repo_rel("/etc/passwd").is_err());
        assert!(validate_repo_rel("C:\\Windows").is_err());
        assert!(validate_repo_rel("C:/Windows").is_err());
        assert!(validate_repo_rel("\\\\server\\share").is_err());
    }

    #[test]
    fn validate_repo_rel_refuses_traversal_and_dot_git() {
        assert!(validate_repo_rel("..").is_err());
        assert!(validate_repo_rel("../secret").is_err());
        assert!(validate_repo_rel("a/../../b").is_err());
        assert!(validate_repo_rel(".git").is_err());
        assert!(validate_repo_rel(".git/config").is_err());
        // Case-insensitive: a Windows filesystem would still reach .git.
        assert!(validate_repo_rel(".GIT/hooks").is_err());
    }

    #[test]
    fn optimize_refuses_an_entry_that_climbs_or_touches_git() {
        let f = fixture();
        let record = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        let wt = PathBuf::from(&record.path);
        let src = PathBuf::from(&record.source_root);
        // A rejected entry fails the call rather than being skipped.
        assert!(apply_optimizations(&wt, &src, &["../escape".to_string()], &[]).is_err());
        assert!(apply_optimizations(&wt, &src, &[], &[".git".to_string()]).is_err());
    }

    #[test]
    fn optimize_will_not_clobber_an_existing_path() {
        let f = fixture();
        let record = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        let wt = PathBuf::from(&record.path);
        let src = PathBuf::from(&record.source_root);
        // a.txt is a committed file already present in the worktree.
        let err = apply_optimizations(&wt, &src, &["a.txt".to_string()], &[])
            .expect_err("must refuse to overwrite");
        assert!(err.contains("already exists"), "{err}");
        // And it was left exactly as it was.
        assert_eq!(std::fs::read_to_string(wt.join("a.txt")).unwrap(), "one");
    }

    #[test]
    fn optimize_shares_a_directory_by_linking_it() {
        let f = fixture();
        // A heavy directory that lives only in the source, untracked, as
        // node_modules would be.
        std::fs::create_dir_all(f.repo.join("node_modules")).unwrap();
        std::fs::write(f.repo.join("node_modules/lib.txt"), "shared").unwrap();
        let record = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        let wt = PathBuf::from(&record.path);
        let src = PathBuf::from(&record.source_root);
        apply_optimizations(&wt, &src, &["node_modules".to_string()], &[]).expect("link");
        // The worktree reaches the source's directory through the link, with no
        // second copy of it.
        assert_eq!(
            std::fs::read_to_string(wt.join("node_modules/lib.txt")).unwrap(),
            "shared"
        );
    }

    #[test]
    fn optimize_narrows_the_tree_with_sparse_checkout_first() {
        let f = fixture();
        // Two tracked directories; the cone keeps one and drops the other.
        std::fs::create_dir_all(f.repo.join("keep")).unwrap();
        std::fs::create_dir_all(f.repo.join("drop")).unwrap();
        std::fs::write(f.repo.join("keep/k.txt"), "k").unwrap();
        std::fs::write(f.repo.join("drop/d.txt"), "d").unwrap();
        git_in(&f.repo, &["add", "."]);
        git_in(&f.repo, &["commit", "-q", "-m", "dirs"]);
        let record = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        let wt = PathBuf::from(&record.path);
        let src = PathBuf::from(&record.source_root);
        // Sparse first, then a link into the narrowed tree, in one call.
        std::fs::create_dir_all(f.repo.join("cache")).unwrap();
        std::fs::write(f.repo.join("cache/c.txt"), "c").unwrap();
        apply_optimizations(&wt, &src, &["cache".to_string()], &["keep".to_string()])
            .expect("optimize");
        assert!(
            wt.join("keep/k.txt").exists(),
            "kept path should be present"
        );
        assert!(
            !wt.join("drop/d.txt").exists(),
            "dropped path should be outside the cone"
        );
        // The link was placed after the narrowing, and reaches the source.
        assert_eq!(
            std::fs::read_to_string(wt.join("cache/c.txt")).unwrap(),
            "c"
        );
    }
}
