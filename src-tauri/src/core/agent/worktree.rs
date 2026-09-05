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

/// The branch a session's worktree uses.
///
/// Stable across restarts, so reopening a session finds its own work rather
/// than starting a second branch beside it, and namespaced so it is obvious in
/// `git branch` who made it and why.
pub fn branch_name(session_id: &str) -> String {
    let short: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect();
    format!(
        "jan/cowork/{}",
        if short.is_empty() { "session" } else { &short }
    )
}

/// Where a session's worktree lives, under Jan's own data directory.
///
/// Outside the user's checkout on purpose: inside it, the worktree would show
/// up in their editor, their search results and — but for `.git` bookkeeping —
/// their next commit.
pub fn worktree_path(worktrees_root: &Path, identity: &RepoIdentity, session_id: &str) -> PathBuf {
    let session: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(64)
        .collect();
    worktrees_root.join(identity.key()).join(session)
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
pub fn discard(record: &WorktreeRecord) -> Result<(), String> {
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
        assert_eq!(record.branch, "jan/cowork/session1");
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
        git_in(&f.repo, &["branch", "jan/cowork/session1"]);

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

        discard(&record).expect("discard");

        assert!(!PathBuf::from(&record.path).exists());
        assert!(run(
            &f.repo,
            &["rev-parse", "--verify", "refs/heads/jan/cowork/session1"]
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
}
