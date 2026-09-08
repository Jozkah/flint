//! Jan-owned Git worktrees: an isolated checkout a run can edit without
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
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_AUTHOR_NAME", "Jan Agent")
        .env("GIT_AUTHOR_EMAIL", "agent@jan.ai")
        .env("GIT_COMMITTER_NAME", "Jan Agent")
        .env("GIT_COMMITTER_EMAIL", "agent@jan.ai")
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

/// Where a session's worktree lives, under Jan's own data directory.
///
/// Outside the user's checkout on purpose: inside it, the worktree would show
/// up in their editor, their search results and — but for `.git` bookkeeping —
/// their next commit.
pub fn worktree_path(worktrees_root: &Path, identity: &RepoIdentity, session_id: &str) -> PathBuf {
    worktrees_root.join(identity.key()).join(slug(session_id))
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
/// the ones a string comparison gets wrong: a symlink in Jan's worktrees
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
    let path = worktree_path(worktrees_root, &identity, session_id);
    if !is_worktree_of(&path, repo) {
        return None;
    }
    let branch = run(&path, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    let base_sha = run(&path, &["rev-parse", "HEAD"]).ok()?;
    Some(WorktreeRecord {
        path: path.to_string_lossy().to_string(),
        branch,
        base_sha,
        source_root: identity.root.clone(),
        identity,
        uncommitted_at_creation: Vec::new(),
    })
}

/// Create a worktree for this session, or reuse the one it already has.
///
/// Refuses rather than improvises in the two cases where improvising loses
/// work: a branch of the right name that is not ours, and a directory in our
/// own location that is not a worktree of this repository. Both mean something
/// happened outside Jan, and picking a different name to get past it would
/// leave the user with two branches and no explanation.
pub fn ensure(
    repo: &Path,
    worktrees_root: &Path,
    session_id: &str,
) -> Result<WorktreeRecord, String> {
    let identity = identity(repo)?;
    let path = worktree_path(worktrees_root, &identity, session_id);
    let branch = branch_name(session_id);

    // Where the worktree will actually be, not where the name says. A symlink
    // in Jan's own worktrees directory — or one someone put there — would
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
        if found.branch == branch {
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

    let head = run(repo, &["rev-parse", "HEAD"]).map_err(|_| {
        "this repository has no commits yet, so there is nothing to branch from".to_string()
    })?;
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
    run(repo, &["worktree", "add", "-b", &branch, &path_str, &head])?;

    Ok(WorktreeRecord {
        path: path_str,
        branch,
        base_sha: head,
        source_root: identity.root.clone(),
        identity,
        uncommitted_at_creation: uncommitted(repo),
    })
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

/// Every Jan-owned worktree of this repository that is actually on disk.
///
/// Read from Git rather than from anything Jan persisted, and that is the
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
    let mut flush = |path: &mut Option<String>,
                     head: &mut Option<String>,
                     branch: &mut Option<String>,
                     found: &mut Vec<WorktreeRecord>| {
        let (Some(p), Some(h), Some(b)) = (path.take(), head.take(), branch.take()) else {
            return;
        };
        // Ours, and where we put them: a worktree the user made themselves is
        // not Jan's to list, offer to delete, or reason about.
        if !b.starts_with(BRANCH_PREFIX) || !contained(Path::new(&p), worktrees_root) {
            return;
        }
        // `git worktree list --porcelain` reports `C:/Users/...` on Windows,
        // while every record Jan creates holds a native `C:\Users\...`. Left
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

/// The namespace every branch Jan creates lives under.
pub const BRANCH_PREFIX: &str = "jan/cowork/";

/// Drop the bookkeeping for worktrees whose directories are gone.
///
/// Idempotent, and safe to call at startup: it touches only Git's own record of
/// worktrees that no longer exist, and never a directory.
pub fn prune(repo: &Path) -> Result<(), String> {
    run(repo, &["worktree", "prune"]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_in(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
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
        // be able to climb out of the directory Jan owns.
        let path = worktree_path(&f.worktrees, &id, "../../etc/passwd");
        assert!(path.starts_with(&f.worktrees), "{}", path.display());
    }

    #[test]
    fn a_branch_name_cannot_be_forged_from_a_session_id() {
        // Same concern, on the ref namespace: everything Jan creates is under
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
        // A worktree Jan did not make is not Jan's to list, offer to delete, or
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

    #[test]
    fn a_clean_worktree_needs_no_forcing() {
        let f = fixture();
        let record = ensure(&f.repo, &f.worktrees, "session-1").expect("create");
        assert!(pending(&record).is_empty());
        discard(&record, false).expect("nothing to lose");
    }

    #[test]
    fn refuses_a_worktrees_root_that_leads_somewhere_else() {
        // The check has to be on the disk, not the string: a symlink where Jan
        // keeps its worktrees would otherwise make "under the data folder"
        // true of the name and false of the place.
        let f = fixture();
        let elsewhere = f._dir.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let linked = f._dir.path().join("linked");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&elsewhere, &linked).unwrap();
        #[cfg(not(unix))]
        return;

        // The root itself resolving elsewhere is fine — it is still one place
        // Jan owns. What must not happen is a *child* escaping it.
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
}
