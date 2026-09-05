//! Checkpoints, and the two very different things "rewind" means.
//!
//! The snapshot machinery underneath this already existed and is already
//! exercised: [`super::git::snapshot`] writes a commit object without touching
//! the user's branch, HEAD or index and without scanning the working tree, and
//! [`super::git::restore`] rolls a tree back to one. The TUI has driven it from
//! its double-Esc picker for as long as it has had one. It was reachable only
//! from the CLI build, which is why Cowork had no recovery at all.
//!
//! What this module adds is the distinction that made promoting it unsafe to do
//! bluntly.
//!
//! **In a worktree or a sandbox, Jan owns the tree.** Everything in it got
//! there because Jan put it there, so rolling it back to a checkpoint loses
//! nothing that was not Jan's to lose. Hard restore is correct.
//!
//! **In the user's own checkout, Jan does not.** The tree holds work Jan never
//! saw — edits made in their editor while a run was going, a stash, a
//! half-finished change in a file the run never touched. `restore` discards
//! everything after the target indiscriminately, so pointing it at a user's
//! checkout would delete work whose only sin was being in the same directory.
//!
//! So rewind is not one operation with a flag. It is a hard restore where Jan
//! owns the tree, and a reviewable patch where it does not — and the type
//! system is what keeps them apart, rather than a caller remembering which case
//! they are in.

use std::path::{Path, PathBuf};

use super::git;

/// Whose working tree a checkpoint is about.
///
/// The whole reason this enum exists: the answer decides whether rewinding may
/// destroy anything, and it is not something a call site should have to
/// remember.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Destination {
    /// A Jan-owned worktree or sandbox. Everything in it is Jan's.
    Managed,
    /// The user's own checkout. It holds work Jan never saw.
    UserCheckout,
}

impl Destination {
    /// May a rewind here discard what is on disk?
    ///
    /// Only where Jan owns the tree. This is the one question the module
    /// exists to answer, so it is a named method rather than a comparison
    /// spelled out at each call site.
    pub fn may_hard_restore(self) -> bool {
        matches!(self, Destination::Managed)
    }
}

/// One recorded point a run can be taken back to.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    /// The snapshot commit. Not on any branch, and not reachable except through
    /// the thread's own ref.
    pub sha: String,
    /// What was about to happen when it was taken.
    pub label: String,
    /// Whose tree it describes, which decides how it may be rewound.
    pub destination: Destination,
    /// The tree it was taken in.
    pub root: String,
}

/// Take a checkpoint before something that can change files.
///
/// `changed` lists the paths touched since the previous checkpoint; only those
/// are staged, so the cost is proportional to the turn rather than to the
/// repository. Passing an empty list is meaningful and cheap: it records the
/// state as it stands.
pub fn capture(
    root: &Path,
    thread_id: &str,
    parent: Option<&str>,
    label: &str,
    changed: &[PathBuf],
    destination: Destination,
) -> Result<Checkpoint, String> {
    let sha = git::snapshot(root, parent, label, thread_id, changed)?;
    // Keeping the chain reachable is what stops garbage collection from
    // quietly making recovery impossible between one session and the next.
    git::update_ref(root, thread_id, &sha)?;
    Ok(Checkpoint {
        sha,
        label: label.to_string(),
        destination,
        root: root.to_string_lossy().to_string(),
    })
}

/// What a rewind would do, without doing it.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RewindPlan {
    /// Jan owns this tree, so it can be put back as it was.
    Restore { sha: String },
    /// Jan does not own this tree. Here is the change, for the user to apply.
    Patch { diff: String },
}

/// Plan a rewind to `target`.
///
/// In a managed tree this is a restore. In the user's checkout it is a patch
/// and never anything else — not as a safety check that a determined caller
/// could pass, but because there is no variant of this function that discards a
/// user's files.
pub fn plan(checkpoint: &Checkpoint, latest: &str) -> Result<RewindPlan, String> {
    if checkpoint.destination.may_hard_restore() {
        return Ok(RewindPlan::Restore {
            sha: checkpoint.sha.clone(),
        });
    }
    let root = PathBuf::from(&checkpoint.root);
    // The inverse: what to change to get from where the tree is now back to the
    // checkpoint. Reviewable, reversible, and it leaves untouched anything the
    // user changed that Jan never did.
    let diff = git::diff_between(&root, latest, &checkpoint.sha)?;
    Ok(RewindPlan::Patch { diff })
}

/// Carry out a rewind that is allowed to discard.
///
/// Refuses anything else. A caller that has a user's checkout and wants it back
/// the way it was gets a patch from [`plan`] and shows it to them; there is no
/// path from here to overwriting files Jan did not write.
pub fn restore(checkpoint: &Checkpoint, latest: &str) -> Result<(), String> {
    if !checkpoint.destination.may_hard_restore() {
        return Err(
            "this checkpoint is in your own checkout, so it will not be restored over: \
             review the change and apply it yourself"
                .to_string(),
        );
    }
    let root = PathBuf::from(&checkpoint.root);
    git::restore(&root, &checkpoint.sha, latest)
}

/// Forget a thread's snapshot chain.
///
/// Idempotent, and safe to call for a thread that never took one.
pub fn forget(root: &Path, thread_id: &str) {
    git::cleanup_snapshot_index(thread_id);
    let _ = git::drop_ref(root, thread_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

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
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A thread id no other test, and no earlier run, has used.
    ///
    /// The snapshot index is a persistent file keyed by thread id alone. That
    /// is right in production, where ids are unique and the index being reused
    /// across a thread's whole chain is the optimisation it exists for — but a
    /// fixed id in a test stages into an index left behind by a *previous run*
    /// against a different temporary repository, and `write-tree` then
    /// references objects that repository owns. Uniqueness here reproduces the
    /// production property rather than working around it.
    fn thread_id(tag: &str) -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!(
            "{tag}-{}-{}",
            nanos,
            COUNTER.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        git_in(&root, &["init", "-q", "-b", "main"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git_in(&root, &["add", "."]);
        git_in(&root, &["commit", "-q", "-m", "first"]);
        (dir, root)
    }

    #[test]
    fn a_checkpoint_does_not_disturb_the_branch() {
        let (_d, root) = repo();
        let head = String::from_utf8_lossy(
            &Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string();

        capture(
            &root,
            &thread_id("cp-branch"),
            None,
            "before",
            &[],
            Destination::Managed,
        )
        .unwrap();

        // The snapshot is a commit object, not a commit on the branch. Someone
        // looking at their own history must not see Jan's bookkeeping in it.
        let after = String::from_utf8_lossy(
            &Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string();
        assert_eq!(head, after);
    }

    #[test]
    fn a_managed_tree_is_put_back_as_it_was() {
        let (_d, root) = repo();
        let first = capture(
            &root,
            &thread_id("cp-managed"),
            None,
            "before",
            &[],
            Destination::Managed,
        )
        .unwrap();

        std::fs::write(root.join("a.txt"), "changed\n").unwrap();
        std::fs::write(root.join("b.txt"), "new\n").unwrap();
        let latest = capture(
            &root,
            &thread_id("cp-managed"),
            Some(&first.sha),
            "after",
            &[PathBuf::from("a.txt"), PathBuf::from("b.txt")],
            Destination::Managed,
        )
        .unwrap();

        restore(&first, &latest.sha).expect("restore");

        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\n"
        );
        // A file added after the checkpoint is gone again, which is what being
        // put back as it was means.
        assert!(!root.join("b.txt").exists());
    }

    #[test]
    fn the_users_checkout_is_never_restored_over() {
        let (_d, root) = repo();
        let point = capture(
            &root,
            &thread_id("cp-user"),
            None,
            "before",
            &[],
            Destination::UserCheckout,
        )
        .unwrap();

        // Work Jan never saw, in the same directory.
        std::fs::write(root.join("their-notes.txt"), "hours of work\n").unwrap();
        std::fs::write(root.join("a.txt"), "their edit\n").unwrap();

        let err = restore(&point, &point.sha).expect_err("must refuse");

        assert!(err.contains("your own checkout"), "{err}");
        // The refusal is the point: nothing was touched.
        assert_eq!(
            std::fs::read_to_string(root.join("their-notes.txt")).unwrap(),
            "hours of work\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "their edit\n"
        );
    }

    #[test]
    fn a_users_checkout_gets_a_patch_to_review_instead() {
        let (_d, root) = repo();
        let first = capture(
            &root,
            &thread_id("cp-patch"),
            None,
            "before",
            &[],
            Destination::UserCheckout,
        )
        .unwrap();
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        let latest = capture(
            &root,
            &thread_id("cp-patch"),
            Some(&first.sha),
            "after",
            &[PathBuf::from("a.txt")],
            Destination::UserCheckout,
        )
        .unwrap();

        match plan(&first, &latest.sha).expect("plan") {
            RewindPlan::Patch { diff } => {
                assert!(diff.contains("a.txt"), "{diff}");
                // The inverse: applying it goes back to the checkpoint.
                assert!(diff.contains("-two") || diff.contains("+one"), "{diff}");
            }
            other => panic!("expected a patch, got {other:?}"),
        }
    }

    #[test]
    fn a_managed_tree_is_planned_as_a_restore() {
        let (_d, root) = repo();
        let point = capture(
            &root,
            &thread_id("cp-plan"),
            None,
            "before",
            &[],
            Destination::Managed,
        )
        .unwrap();

        assert_eq!(
            plan(&point, &point.sha).unwrap(),
            RewindPlan::Restore {
                sha: point.sha.clone()
            }
        );
    }

    #[test]
    fn only_a_managed_tree_may_be_discarded() {
        // Stated once, as its own assertion, because every other guarantee in
        // this module rests on it.
        assert!(Destination::Managed.may_hard_restore());
        assert!(!Destination::UserCheckout.may_hard_restore());
    }

    #[test]
    fn a_chain_survives_to_be_rewound_to() {
        let (_d, root) = repo();
        let id = thread_id("cp-chain");
        let a = capture(&root, &id, None, "one", &[], Destination::Managed).unwrap();
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        let b = capture(
            &root,
            &id,
            Some(&a.sha),
            "two",
            &[PathBuf::from("a.txt")],
            Destination::Managed,
        )
        .unwrap();

        // Reachable through the thread's ref, so garbage collection cannot
        // quietly make recovery impossible between sessions.
        let reachable = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["rev-list", &git::snapshot_ref(&id)])
            .output()
            .unwrap();
        let listed = String::from_utf8_lossy(&reachable.stdout);
        assert!(listed.contains(&a.sha), "{listed}");
        assert!(listed.contains(&b.sha), "{listed}");
    }

    #[test]
    fn forgetting_is_safe_to_repeat() {
        let (_d, root) = repo();
        let id = thread_id("cp-forget");
        capture(&root, &id, None, "one", &[], Destination::Managed).unwrap();

        forget(&root, &id);
        forget(&root, &id);
        forget(&root, "never-existed");
    }
}
