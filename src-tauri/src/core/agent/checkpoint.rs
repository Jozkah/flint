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
//! **In a worktree or a sandbox, Flint owns the tree.** Everything in it got
//! there because Flint put it there, so rolling it back to a checkpoint loses
//! nothing that was not Flint's to lose. Hard restore is correct.
//!
//! **In the user's own checkout, Flint does not.** The tree holds work Flint never
//! saw — edits made in their editor while a run was going, a stash, a
//! half-finished change in a file the run never touched. `restore` discards
//! everything after the target indiscriminately, so pointing it at a user's
//! checkout would delete work whose only sin was being in the same directory.
//!
//! So rewind is not one operation with a flag. It is a hard restore where Flint
//! owns the tree, and a reviewable patch where it does not — and the type
//! system is what keeps them apart, rather than a caller remembering which case
//! they are in.
//!
//! # What a restore puts back, and what it does not
//!
//! Restored, in a managed tree, relative to its top level:
//!
//! - Every file `git add -A` sees: tracked files and untracked files that are
//!   not ignored. Contents come back byte for byte — `core.autocrlf` and the
//!   tree's own `.gitattributes` conversions (`text`, `eol`, filters) are off
//!   for Flint's snapshots, so line endings are never rewritten.
//! - Deletions (a deleted file is written again) and additions (a file created
//!   after the checkpoint is removed, and a directory it leaves empty goes too).
//!   An untracked file created after the checkpoint is part of the tree, so it
//!   is removed as well — the safety checkpoint taken before the restore holds
//!   it, which is what makes undoing the restore bring it back.
//! - Symbolic links, as links, where Git checks them out as links (Unix; Git
//!   for Windows writes a plain file holding the target unless `core.symlinks`
//!   is on). A link is never followed to write or delete through it.
//! - The executable bit, where Git records it (`core.fileMode`, on by default
//!   on Unix and off on Windows).
//!
//! Not restored, and not touched:
//!
//! - Ignored files (`.gitignore`, `.git/info/exclude`): never captured, never
//!   removed. A restore that would have to delete a directory holding ignored
//!   files — because the checkpoint has a file at that path — is refused before
//!   anything is written.
//! - Nested repositories and submodules. A snapshot holds only the commit such
//!   a directory pointed at, so its files are neither put back nor removed. A
//!   nested repository with no commit makes capture fail outright.
//! - Anything outside the tree's top level. A restore of a checkpoint whose
//!   root is not the top of its working tree is refused.
//! - Git's own state: branches, HEAD, the index, refs, stashes.
//! - Other permissions, ownership, timestamps and empty directories, none of
//!   which Git records.
//! - `.git/info/attributes` and `core.attributesFile`, which still apply.
//! - The conversation, and every effect outside the files: processes started,
//!   packages installed elsewhere, network requests, messages sent.
//!
//! # The guard against silent loss
//!
//! A restore discards whatever is on disk. It is only allowed to discard what a
//! checkpoint still holds, so before anything is written the tree is compared
//! with the holding checkpoint — the safety point taken for this restore, or
//! `latest` without one — and the restore is refused if anything differs,
//! except paths the caller has explicitly agreed to lose. If the restore then
//! fails partway, the tree is put back to the holding checkpoint and the error
//! says whether that worked and what, if anything, still differs.

use std::collections::HashSet;
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
    /// A Flint-owned worktree or sandbox. Everything in it is Flint's.
    Managed,
    /// The user's own checkout. It holds work Flint never saw.
    UserCheckout,
}

impl Destination {
    /// May a rewind here discard what is on disk?
    ///
    /// Only where Flint owns the tree. This is the one question the module
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
/// **In a managed tree** the whole working tree is recorded as it stands and
/// `changed` is not consulted. A hard restore discards whatever the snapshot
/// does not hold, so a snapshot built only from reported paths would silently
/// lose an edit nobody reported — a file a shell command wrote, or one changed
/// after the previous point. Completeness is what makes a restore safe to
/// offer, and it is worth a scan in a tree Flint owns.
///
/// **In the user's checkout** `changed` lists the paths touched since the
/// previous checkpoint and only those are staged, so the cost is proportional
/// to the turn rather than to the repository. That snapshot only ever feeds a
/// reviewable patch, never a restore.
pub fn capture(
    root: &Path,
    thread_id: &str,
    parent: Option<&str>,
    label: &str,
    changed: &[PathBuf],
    destination: Destination,
) -> Result<Checkpoint, String> {
    let sha = if destination.may_hard_restore() {
        git::snapshot_worktree(root, parent, label)?
    } else {
        git::snapshot(root, parent, label, thread_id, changed)?
    };
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
    /// Flint owns this tree, so it can be put back as it was.
    Restore {
        sha: String,
        /// Every path the restore would change: the working tree as it stands,
        /// compared with the checkpoint. Added, modified and deleted alike.
        files: Vec<String>,
        /// Paths that differ from `latest` — the state the tree was last known
        /// to be in. Anything here changed after that point, and the caller
        /// decides which of it Flint wrote.
        #[serde(rename = "changedSinceLatest")]
        changed_since_latest: Vec<String>,
    },
    /// Flint does not own this tree. Here is the change, for the user to apply.
    Patch { diff: String },
}

/// Plan a rewind to `target`.
///
/// In a managed tree this is a restore. In the user's checkout it is a patch
/// and never anything else — not as a safety check that a determined caller
/// could pass, but because there is no variant of this function that discards a
/// user's files.
///
/// A restore plan names what it would touch, so a confirmation can show the
/// scope instead of asking someone to agree to an unnamed overwrite.
pub fn plan(checkpoint: &Checkpoint, latest: &str) -> Result<RewindPlan, String> {
    if checkpoint.destination.may_hard_restore() {
        let root = PathBuf::from(&checkpoint.root);
        let files = git::changed_since(&root, &checkpoint.sha)?;
        let changed_since_latest = if latest == checkpoint.sha {
            files.clone()
        } else {
            git::changed_since(&root, latest)?
        };
        return Ok(RewindPlan::Restore {
            sha: checkpoint.sha.clone(),
            files,
            changed_since_latest,
        });
    }
    let root = PathBuf::from(&checkpoint.root);
    // The inverse: what to change to get from where the tree is now back to the
    // checkpoint. Reviewable, reversible, and it leaves untouched anything the
    // user changed that Flint never did.
    let diff = git::diff_between(&root, latest, &checkpoint.sha)?;
    Ok(RewindPlan::Patch { diff })
}

/// What a restore may discard, as the caller vouches for it.
///
/// The default — no safety point, nothing allowed — is the strict one: the
/// tree must match `latest` exactly, or nothing is restored.
#[derive(serde::Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreGuard {
    /// A checkpoint taken of the tree as it stands, immediately before this
    /// restore. When given, it — not `latest` — is what the tree must match.
    #[serde(default)]
    pub safety: Option<String>,
    /// Paths, relative to the root, the caller has explicitly agreed may be
    /// overwritten although no checkpoint holds their current content.
    #[serde(default)]
    pub allow_overwrite: Vec<String>,
}

impl RestoreGuard {
    /// Vouched for by a safety checkpoint and nothing else.
    pub fn with_safety(sha: &str) -> Self {
        Self {
            safety: Some(sha.to_string()),
            allow_overwrite: Vec::new(),
        }
    }
}

/// Carry out a rewind that is allowed to discard.
///
/// Refuses anything else. A caller that has a user's checkout and wants it back
/// the way it was gets a patch from [`plan`] and shows it to them; there is no
/// path from here to overwriting files Flint did not write.
///
/// In a managed tree, refuses before writing anything when the tree has changes
/// no checkpoint holds (see [`RestoreGuard`]), or when the root is not the top
/// of its working tree. A restore that fails partway is rolled back to the
/// holding checkpoint, and the error says how far that got.
pub fn restore(checkpoint: &Checkpoint, latest: &str, guard: &RestoreGuard) -> Result<(), String> {
    if !checkpoint.destination.may_hard_restore() {
        return Err(
            "this checkpoint is in your own checkout, so it will not be restored over: \
             review the change and apply it yourself"
                .to_string(),
        );
    }
    let root = PathBuf::from(&checkpoint.root);
    require_top_level(&root)?;

    let holder = guard.safety.as_deref().unwrap_or(latest);
    let allowed: HashSet<String> = guard
        .allow_overwrite
        .iter()
        .map(|path| path.replace('\\', "/"))
        .collect();
    let unsaved: Vec<String> = git::changed_since(&root, holder)
        .map_err(|e| {
            format!(
                "nothing was restored: the tree could not be compared with checkpoint {}: {e}",
                short(holder)
            )
        })?
        .into_iter()
        .filter(|path| !allowed.contains(path))
        .collect();
    if !unsaved.is_empty() {
        return Err(format!(
            "nothing was restored: {} changed after checkpoint {} and no checkpoint holds \
             that change, so a restore would lose it: {}. Take a safety checkpoint of the \
             tree as it stands first",
            count(unsaved.len()),
            short(holder),
            list(&unsaved)
        ));
    }

    let target = checkpoint.sha.as_str();
    let failure = match git::restore_worktree(&root, target) {
        Err(git::RestoreError::Refused(reason)) => {
            return Err(format!("nothing was restored: {reason}"))
        }
        Err(git::RestoreError::Incomplete(reason)) => reason,
        Ok(_) => match git::changed_since(&root, target) {
            Ok(rest) if rest.is_empty() => return Ok(()),
            Ok(rest) => format!(
                "afterwards {} still differed from the checkpoint: {}",
                count(rest.len()),
                list(&rest)
            ),
            Err(e) => format!("the result could not be checked: {e}"),
        },
    };
    Err(roll_back(&root, holder, target, &failure))
}

/// Put the tree back to `holder` after a restore to `target` failed, and say
/// exactly how that went. Never reports success it did not verify.
fn roll_back(root: &Path, holder: &str, target: &str, failure: &str) -> String {
    let attempt = git::restore_worktree(root, holder);
    let remaining = git::changed_since(root, holder);
    if let (Ok(_), Ok(rest)) = (&attempt, &remaining) {
        if rest.is_empty() {
            return format!(
                "the restore to checkpoint {} did not complete ({failure}); every file was put \
                 back as it was before the restore, which checkpoint {} holds",
                short(target),
                short(holder)
            );
        }
    }
    let why = match attempt {
        Ok(_) => "it finished, but the result does not match".to_string(),
        Err(git::RestoreError::Refused(e)) | Err(git::RestoreError::Incomplete(e)) => e,
    };
    let still = match remaining {
        Ok(rest) => format!(
            "{} still differ from the state before the restore: {}",
            count(rest.len()),
            list(&rest)
        ),
        Err(e) => format!("the tree could not be compared with that state: {e}"),
    };
    format!(
        "the restore to checkpoint {} did not complete ({failure}), and putting the tree back \
         also did not complete ({why}); {still}. Nothing is lost: checkpoint {} holds the state \
         before the restore, so restore it once the cause is fixed",
        short(target),
        short(holder)
    )
}

/// A restore writes paths relative to the top of the working tree, so a root
/// below that top would let it write outside the root it was asked about.
fn require_top_level(root: &Path) -> Result<(), String> {
    let top = git::repo_root(root).ok_or_else(|| {
        format!(
            "nothing was restored: {} is not a Git working tree",
            root.display()
        )
    })?;
    let same = match (top.canonicalize(), root.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if same {
        Ok(())
    } else {
        Err(format!(
            "nothing was restored: {} is inside the working tree at {} rather than at its top, \
             and a restore there could write outside it",
            root.display(),
            top.display()
        ))
    }
}

fn short(sha: &str) -> String {
    sha.chars().take(8).collect()
}

fn count(n: usize) -> String {
    if n == 1 {
        "1 path".to_string()
    } else {
        format!("{n} paths")
    }
}

fn list(paths: &[String]) -> String {
    const SHOWN: usize = 20;
    let mut out = paths.iter().take(SHOWN).cloned().collect::<Vec<_>>().join(", ");
    if paths.len() > SHOWN {
        out.push_str(&format!(" and {} more", paths.len() - SHOWN));
    }
    out
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
    use sha2::{Digest, Sha256};
    use std::collections::BTreeMap;
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

    fn git_out(dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git");
        if out.status.success() {
            Ok(out.stdout)
        } else {
            Err(String::from_utf8_lossy(&out.stderr).to_string())
        }
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
        git_in(&root, &["commit", "-q", "--no-gpg-sign", "-m", "first"]);
        (dir, root)
    }

    fn write(root: &Path, rel: &str, content: impl AsRef<[u8]>) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, content).unwrap();
    }

    fn read(root: &Path, rel: &str) -> String {
        std::fs::read_to_string(root.join(rel)).unwrap()
    }

    /// Every file under `root` except `.git`, by SHA-256 of its bytes. Ignored
    /// files are included on purpose: they must survive every restore too.
    /// Symbolic links are recorded by their target and never followed.
    fn tree_state(root: &Path) -> BTreeMap<String, String> {
        fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                let rel = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if rel == ".git" {
                    continue;
                }
                let meta = std::fs::symlink_metadata(&path).unwrap();
                if meta.file_type().is_symlink() {
                    let target = std::fs::read_link(&path).unwrap();
                    out.insert(rel, format!("link:{}", target.display()));
                } else if meta.is_dir() {
                    walk(root, &path, out);
                } else {
                    let digest = Sha256::digest(std::fs::read(&path).unwrap());
                    out.insert(rel, hex::encode(digest));
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(root, root, &mut out);
        out
    }

    fn managed(root: &Path, id: &str, parent: Option<&str>, label: &str) -> Checkpoint {
        capture(root, id, parent, label, &[], Destination::Managed)
            .unwrap_or_else(|e| panic!("capture {label}: {e}"))
    }

    /// The path the UI takes: a safety point of the tree as it stands, then a
    /// restore vouched for by it. Returns the safety point.
    fn safe_restore(root: &Path, id: &str, parent: &str, target: &Checkpoint) -> Checkpoint {
        let safety = managed(root, id, Some(parent), "safety");
        restore(target, &safety.sha, &RestoreGuard::with_safety(&safety.sha))
            .unwrap_or_else(|e| panic!("restore to {}: {e}", target.label));
        safety
    }

    /// Symbolic links need a privilege on Windows that a test run usually does
    /// not have. Returns whether the link exists; a caller that gets `false`
    /// reports itself as skipped.
    fn try_symlink(target: &Path, link: &Path, dir: bool) -> bool {
        #[cfg(unix)]
        let made = {
            let _ = dir;
            std::os::unix::fs::symlink(target, link)
        };
        #[cfg(windows)]
        let made = if dir {
            std::os::windows::fs::symlink_dir(target, link)
        } else {
            std::os::windows::fs::symlink_file(target, link)
        };
        match made {
            Ok(()) => true,
            Err(e) => {
                eprintln!("SKIPPED: cannot create a symbolic link here ({e})");
                false
            }
        }
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
        // looking at their own history must not see Flint's bookkeeping in it.
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

        restore(&first, &latest.sha, &RestoreGuard::default()).expect("restore");

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

        // Work Flint never saw, in the same directory.
        std::fs::write(root.join("their-notes.txt"), "hours of work\n").unwrap();
        std::fs::write(root.join("a.txt"), "their edit\n").unwrap();

        let err = restore(&point, &point.sha, &RestoreGuard::default()).expect_err("must refuse");
        assert!(err.contains("your own checkout"), "{err}");

        // No guard turns it into one: not a safety point, not an explicit
        // agreement to overwrite every path.
        let err = restore(
            &point,
            &point.sha,
            &RestoreGuard {
                safety: Some(point.sha.clone()),
                allow_overwrite: vec!["a.txt".into(), "their-notes.txt".into()],
            },
        )
        .expect_err("must refuse whatever the guard says");
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
                sha: point.sha.clone(),
                files: vec![],
                changed_since_latest: vec![],
            }
        );
    }

    #[test]
    fn a_managed_checkpoint_holds_edits_nobody_reported() {
        let (_d, root) = repo();
        let id = thread_id("cp-unreported");
        // Changed on disk, and not named in `changed`: a shell command's
        // output, or an edit made in an editor.
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        std::fs::write(root.join("b.txt"), "new\n").unwrap();
        let point = capture(&root, &id, None, "before", &[], Destination::Managed).unwrap();

        std::fs::write(root.join("a.txt"), "three\n").unwrap();
        std::fs::write(root.join("c.txt"), "later\n").unwrap();

        match plan(&point, &point.sha).unwrap() {
            RewindPlan::Restore {
                files,
                changed_since_latest,
                ..
            } => {
                // b.txt is in the checkpoint and unchanged, so it is not in
                // scope; a.txt and c.txt are what a restore would touch.
                assert_eq!(files, vec!["a.txt".to_string(), "c.txt".to_string()]);
                assert_eq!(changed_since_latest, files);
            }
            other => panic!("expected a restore, got {other:?}"),
        }
    }

    #[test]
    fn a_restore_preceded_by_a_safety_point_can_be_undone() {
        let (_d, root) = repo();
        let id = thread_id("cp-undo");
        let point = capture(&root, &id, None, "before", &[], Destination::Managed).unwrap();

        std::fs::write(root.join("a.txt"), "edited later\n").unwrap();
        std::fs::write(root.join("new.txt"), "added later\n").unwrap();
        let before = tree_state(&root);

        let safety = safe_restore(&root, &id, &point.sha, &point);
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "one\n");
        assert!(!root.join("new.txt").exists());

        // Going back to the safety point puts the overwritten work back — itself
        // behind a safety point of its own, as the UI does it.
        safe_restore(&root, &id, &safety.sha, &safety);
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "edited later\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("new.txt")).unwrap(),
            "added later\n"
        );
        assert_eq!(tree_state(&root), before);
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

    // -----------------------------------------------------------------------
    // Restore safety: exactness, the guard, failure, and boundaries.
    // -----------------------------------------------------------------------

    #[test]
    fn every_checkpoint_restores_to_its_exact_tree() {
        let (_d, root) = repo();
        let id = thread_id("cp-exact");
        write(&root, ".gitignore", "node_modules/\n.env\n");
        write(&root, "node_modules/pkg/index.js", "module.exports = 1\n");
        write(&root, ".env", "SECRET=1\n");
        let p1 = managed(&root, &id, None, "one");
        let s1 = tree_state(&root);

        write(&root, "a.txt", "two\n");
        write(&root, "src/deep/nested/mod.rs", "pub fn f() {}\n");
        write(&root, "with space/file name.txt", "spaced\n");
        write(&root, "données/résumé é.txt", "accented\n");
        write(&root, "emoji 🚀.md", "# launch\n");
        write(&root, " leading and trailing .txt", "edges\n");
        let p2 = managed(&root, &id, Some(&p1.sha), "two");
        let s2 = tree_state(&root);

        std::fs::remove_file(root.join("a.txt")).unwrap();
        write(&root, "données/résumé é.txt", "accented, changed\n");
        std::fs::remove_dir_all(root.join("with space")).unwrap();
        write(&root, "bin.dat", [0u8, 159, 146, 150, 0, 255, b'\r', b'\n']);
        let p3 = managed(&root, &id, Some(&p2.sha), "three");
        let s3 = tree_state(&root);

        assert_ne!(s1, s2);
        assert_ne!(s2, s3);
        assert_ne!(s1, s3);

        // Every direction: back, forward, to the middle, and back again.
        let mut parent = p3.sha.clone();
        for (target, expected) in [(&p1, &s1), (&p3, &s3), (&p2, &s2), (&p1, &s1)] {
            let safety = safe_restore(&root, &id, &parent, target);
            assert_eq!(&tree_state(&root), expected, "restoring {}", target.label);
            parent = safety.sha;
        }
    }

    #[test]
    fn added_modified_and_deleted_files_are_all_reversed() {
        let (_d, root) = repo();
        let id = thread_id("cp-amd");
        write(&root, "keep/deleted later.txt", "still needed\n");
        write(&root, "nested/dir/modified ü.txt", "before\n");
        let point = managed(&root, &id, None, "before");

        std::fs::remove_file(root.join("keep/deleted later.txt")).unwrap();
        write(&root, "nested/dir/modified ü.txt", "after\n");
        write(&root, "brand new/ñ file.txt", "added\n");
        write(&root, "nested/dir/extra.txt", "added too\n");

        safe_restore(&root, &id, &point.sha, &point);

        assert_eq!(read(&root, "keep/deleted later.txt"), "still needed\n");
        assert_eq!(read(&root, "nested/dir/modified ü.txt"), "before\n");
        assert!(!root.join("brand new/ñ file.txt").exists());
        assert!(!root.join("nested/dir/extra.txt").exists());
        // A directory only the removed files lived in goes with them.
        assert!(!root.join("brand new").exists());
    }

    #[test]
    fn newer_edits_are_reported_and_never_silently_overwritten() {
        let (_d, root) = repo();
        let id = thread_id("cp-newer");
        let p1 = managed(&root, &id, None, "before");
        write(&root, "a.txt", "jan's edit\n");
        let latest = managed(&root, &id, Some(&p1.sha), "after");

        // Someone else's work, after the newest checkpoint.
        write(&root, "a.txt", "user edit after latest\n");
        write(&root, "notes.md", "user notes\n");
        let before = tree_state(&root);

        match plan(&p1, &latest.sha).unwrap() {
            RewindPlan::Restore {
                changed_since_latest,
                ..
            } => assert_eq!(
                changed_since_latest,
                vec!["a.txt".to_string(), "notes.md".to_string()]
            ),
            other => panic!("expected a restore, got {other:?}"),
        }

        // Without a safety point: refused, naming what would be lost.
        let err = restore(&p1, &latest.sha, &RestoreGuard::default()).expect_err("unsaved edits");
        assert!(err.starts_with("nothing was restored"), "{err}");
        assert!(err.contains("a.txt") && err.contains("notes.md"), "{err}");
        assert_eq!(tree_state(&root), before);

        // Agreeing to lose one path is not agreeing to lose the other.
        let err = restore(
            &p1,
            &latest.sha,
            &RestoreGuard {
                safety: None,
                allow_overwrite: vec!["notes.md".into()],
            },
        )
        .expect_err("a.txt is still unsaved");
        assert!(err.contains("1 path") && err.contains("a.txt"), "{err}");
        assert_eq!(tree_state(&root), before);

        // A "safety point" that does not hold the tree vouches for nothing.
        let err = restore(&p1, &latest.sha, &RestoreGuard::with_safety(&latest.sha))
            .expect_err("stale safety point");
        assert!(err.starts_with("nothing was restored"), "{err}");
        assert_eq!(tree_state(&root), before);

        // With a real one, the restore goes ahead...
        let safety = safe_restore(&root, &id, &latest.sha, &p1);
        assert_eq!(read(&root, "a.txt"), "one\n");
        assert!(!root.join("notes.md").exists());

        // ...and undoing it brings back exactly the tree it replaced, newer
        // edits included.
        safe_restore(&root, &id, &safety.sha, &safety);
        assert_eq!(tree_state(&root), before);

        // Explicitly agreeing to lose every unsaved path is honoured too.
        restore(
            &p1,
            &latest.sha,
            &RestoreGuard {
                safety: None,
                allow_overwrite: vec!["a.txt".into(), "notes.md".into()],
            },
        )
        .expect("every loss agreed to");
        assert_eq!(read(&root, "a.txt"), "one\n");
        assert!(!root.join("notes.md").exists());
    }

    #[test]
    fn untracked_files_are_part_of_the_tree_and_ignored_files_are_left_alone() {
        let (dir, root) = repo();
        let id = thread_id("cp-untracked");
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, "not in the tree\n").unwrap();
        write(&root, ".gitignore", "node_modules/\n.env\n*.log\n");
        write(&root, "node_modules/pkg/index.js", "v1\n");
        write(&root, ".env", "SECRET=1\n");
        let point = managed(&root, &id, None, "before");

        write(&root, "scratch.txt", "untracked, not ignored\n");
        write(&root, "tmp/notes/idea.txt", "also untracked\n");
        write(&root, ".env", "SECRET=2\n");
        write(&root, "build.log", "ignored output\n");
        write(&root, "node_modules/pkg/new.js", "installed later\n");
        let before = tree_state(&root);

        let safety = safe_restore(&root, &id, &point.sha, &point);

        // Untracked files inside the tree are the tree's, so they go...
        assert!(!root.join("scratch.txt").exists());
        assert!(!root.join("tmp").exists());
        // ...while ignored files are neither captured nor removed...
        assert_eq!(read(&root, ".env"), "SECRET=2\n");
        assert_eq!(read(&root, "build.log"), "ignored output\n");
        assert_eq!(read(&root, "node_modules/pkg/new.js"), "installed later\n");
        // ...and nothing outside the tree is touched at all.
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "not in the tree\n");

        // The safety point holds the untracked files, and not the ignored ones.
        let held = String::from_utf8(
            git_out(&root, &["ls-tree", "-r", "--name-only", &safety.sha]).unwrap(),
        )
        .unwrap();
        assert!(held.lines().any(|l| l == "scratch.txt"), "{held}");
        assert!(held.lines().any(|l| l == "tmp/notes/idea.txt"), "{held}");
        assert!(!held.lines().any(|l| l == ".env" || l == "build.log"), "{held}");
        assert!(!held.contains("node_modules"), "{held}");

        // Which is what makes undoing the restore bring them back.
        safe_restore(&root, &id, &safety.sha, &safety);
        assert_eq!(tree_state(&root), before);
    }

    #[test]
    fn a_restore_below_the_top_of_the_tree_is_refused() {
        let (_d, root) = repo();
        let sub = root.join("sub");
        write(&root, "sub/x.txt", "in the subdirectory\n");
        write(&root, "top.txt", "top\n");
        let point = managed(&sub, &thread_id("cp-sub"), None, "sub");

        write(&root, "top.txt", "changed outside the root\n");
        let err = restore(&point, &point.sha, &RestoreGuard::with_safety(&point.sha))
            .expect_err("root is not the top level");
        assert!(err.contains("rather than at its top"), "{err}");
        assert_eq!(read(&root, "top.txt"), "changed outside the root\n");
    }

    #[test]
    fn a_failed_capture_is_an_error_and_leaves_nothing_to_restore_over() {
        // Not a repository at all.
        let plain = tempfile::tempdir().unwrap();
        let err = capture(
            plain.path(),
            &thread_id("cp-norepo"),
            None,
            "x",
            &[],
            Destination::Managed,
        )
        .expect_err("not a repository");
        assert!(!err.is_empty());

        let (_d, root) = repo();
        let id = thread_id("cp-capfail");
        let point = managed(&root, &id, None, "before");
        write(&root, "a.txt", "unsaved\n");

        // A parent that does not exist.
        let missing = "0123456789abcdef0123456789abcdef01234567";
        assert!(capture(&root, &id, Some(missing), "x", &[], Destination::Managed).is_err());

        // A failed safety capture leaves the caller with no safety point to
        // name; the restore it would have vouched for is refused regardless.
        let err = restore(&point, &point.sha, &RestoreGuard::default()).expect_err("unsaved");
        assert!(err.starts_with("nothing was restored"), "{err}");
        let err = restore(&point, &point.sha, &RestoreGuard::with_safety(missing))
            .expect_err("a safety point that does not exist");
        assert!(err.starts_with("nothing was restored"), "{err}");
        assert_eq!(read(&root, "a.txt"), "unsaved\n");

        // A corrupted repository.
        std::fs::write(root.join(".git").join("HEAD"), "not a ref at all").unwrap();
        assert!(capture(&root, &id, Some(&point.sha), "x", &[], Destination::Managed).is_err());
        assert_eq!(read(&root, "a.txt"), "unsaved\n");
    }

    #[test]
    fn a_restore_that_fails_partway_is_rolled_back_and_can_be_retried() {
        let (_d, root) = repo();
        let id = thread_id("cp-partial");
        write(&root, "b.txt", "bee\n");
        write(&root, "guarded/locked.txt", "v1\n");
        let point = managed(&root, &id, None, "before");
        let at_point = tree_state(&root);

        write(&root, "a.txt", "two\n");
        write(&root, "guarded/locked.txt", "v2\n");
        write(&root, "new.txt", "new\n");
        let safety = managed(&root, &id, Some(&point.sha), "safety");
        let before = tree_state(&root);

        // Make one file impossible to replace, while still readable.
        #[cfg(windows)]
        let lock = {
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_SHARE_READ: u32 = 0x1;
            std::fs::OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ)
                .open(root.join("guarded/locked.txt"))
                .unwrap()
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let guarded = root.join("guarded");
            std::fs::set_permissions(&guarded, std::fs::Permissions::from_mode(0o555)).unwrap();
            if std::fs::write(guarded.join("probe"), "x").is_ok() {
                let _ = std::fs::remove_file(guarded.join("probe"));
                std::fs::set_permissions(&guarded, std::fs::Permissions::from_mode(0o755))
                    .unwrap();
                eprintln!(
                    "SKIPPED a_restore_that_fails_partway_is_rolled_back_and_can_be_retried: \
                     running with permissions that ignore a read-only directory"
                );
                return;
            }
        }

        let err = restore(&point, &safety.sha, &RestoreGuard::with_safety(&safety.sha))
            .expect_err("one file cannot be replaced");

        #[cfg(windows)]
        drop(lock);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                root.join("guarded"),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }

        // Not a silent success, and not a vague failure: it says it did not
        // complete, and that the tree was put back.
        assert!(err.contains("did not complete"), "{err}");
        assert!(err.contains("locked.txt"), "{err}");
        assert!(err.contains("every file was put back"), "{err}");
        assert_eq!(tree_state(&root), before);

        // Once the cause is gone the same restore works.
        safe_restore(&root, &id, &safety.sha, &point);
        assert_eq!(tree_state(&root), at_point);
    }

    #[test]
    fn a_directory_that_must_become_a_file_again() {
        let (_d, root) = repo();
        let id = thread_id("cp-dirfile");
        write(&root, ".gitignore", "*.log\n");
        write(&root, "thing", "was a file\n");
        let point = managed(&root, &id, None, "before");

        // Holding an ignored file, which no checkpoint keeps: refused before
        // anything is written.
        std::fs::remove_file(root.join("thing")).unwrap();
        write(&root, "thing/cache.log", "ignored\n");
        let safety = managed(&root, &id, Some(&point.sha), "safety");
        let before = tree_state(&root);
        let err = restore(&point, &safety.sha, &RestoreGuard::with_safety(&safety.sha))
            .expect_err("would delete an ignored file");
        assert!(err.starts_with("nothing was restored"), "{err}");
        assert!(err.contains("thing/cache.log"), "{err}");
        assert_eq!(tree_state(&root), before);

        // Holding only files a checkpoint keeps: replaced, and undoable.
        std::fs::remove_file(root.join("thing/cache.log")).unwrap();
        write(&root, "thing/part.txt", "kept by the safety point\n");
        let before = tree_state(&root);
        let safety = safe_restore(&root, &id, &safety.sha, &point);
        assert_eq!(read(&root, "thing"), "was a file\n");
        safe_restore(&root, &id, &safety.sha, &safety);
        assert_eq!(tree_state(&root), before);
    }

    #[test]
    fn a_symlinked_directory_is_never_written_through() {
        let (dir, root) = repo();
        let id = thread_id("cp-linkdir");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("f.txt"), "OUTSIDE\n").unwrap();
        std::fs::write(outside.join("only-outside.txt"), "keep\n").unwrap();

        write(&root, "sub/f.txt", "inside\n");
        write(&root, "gone/x.txt", "removed later\n");
        let point = managed(&root, &id, None, "before");
        std::fs::remove_file(root.join("gone/x.txt")).unwrap();
        std::fs::remove_dir(root.join("gone")).unwrap();
        let without_gone = managed(&root, &id, Some(&point.sha), "without gone");

        // A real directory replaced by a link to somewhere else.
        std::fs::remove_dir_all(root.join("sub")).unwrap();
        if !try_symlink(&outside, &root.join("sub"), true) {
            eprintln!("SKIPPED a_symlinked_directory_is_never_written_through");
            return;
        }
        let safety = safe_restore(&root, &id, &without_gone.sha, &point);

        let sub = std::fs::symlink_metadata(root.join("sub")).unwrap();
        assert!(sub.is_dir() && !sub.file_type().is_symlink(), "sub is a real directory again");
        assert_eq!(read(&root, "sub/f.txt"), "inside\n");
        assert_eq!(read(&root, "gone/x.txt"), "removed later\n");
        assert_eq!(std::fs::read_to_string(outside.join("f.txt")).unwrap(), "OUTSIDE\n");
        assert_eq!(std::fs::read_to_string(outside.join("only-outside.txt")).unwrap(), "keep\n");

        // A link where the target has nothing: the link is removed, and what it
        // pointed at is not.
        std::fs::remove_dir_all(root.join("gone")).unwrap();
        assert!(try_symlink(&outside, &root.join("gone"), true));
        safe_restore(&root, &id, &safety.sha, &without_gone);
        assert!(std::fs::symlink_metadata(root.join("gone")).is_err());
        assert_eq!(std::fs::read_to_string(outside.join("f.txt")).unwrap(), "OUTSIDE\n");
        assert_eq!(std::fs::read_to_string(outside.join("only-outside.txt")).unwrap(), "keep\n");
    }

    #[test]
    fn a_symlink_in_a_checkpoint_comes_back_as_a_link() {
        #[cfg(windows)]
        {
            eprintln!(
                "SKIPPED a_symlink_in_a_checkpoint_comes_back_as_a_link: Git for Windows checks \
                 links out as plain files unless core.symlinks is on, and creating one needs a \
                 privilege"
            );
        }
        #[cfg(unix)]
        {
            let (dir, root) = repo();
            let id = thread_id("cp-link");
            let secret = dir.path().join("secret.txt");
            std::fs::write(&secret, "TOP SECRET\n").unwrap();
            assert!(try_symlink(&secret, &root.join("link"), false));
            let point = managed(&root, &id, None, "before");

            std::fs::remove_file(root.join("link")).unwrap();
            write(&root, "link", "replaced by a file\n");
            safe_restore(&root, &id, &point.sha, &point);

            let meta = std::fs::symlink_metadata(root.join("link")).unwrap();
            assert!(meta.file_type().is_symlink());
            assert_eq!(std::fs::read_link(root.join("link")).unwrap(), secret);
            assert_eq!(std::fs::read_to_string(&secret).unwrap(), "TOP SECRET\n");
        }
    }

    #[test]
    fn a_nested_repository_is_neither_restored_nor_removed() {
        let (_d, root) = repo();
        let id = thread_id("cp-nested");
        let point = managed(&root, &id, None, "before");

        let nested = root.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        git_in(&nested, &["init", "-q"]);
        write(&nested, "inner.txt", "inner work\n");
        git_in(&nested, &["add", "."]);
        git_in(&nested, &["commit", "-q", "--no-gpg-sign", "-m", "inner"]);
        write(&nested, "inner.txt", "uncommitted inner work\n");
        write(&root, "outer.txt", "added\n");

        safe_restore(&root, &id, &point.sha, &point);

        assert!(!root.join("outer.txt").exists());
        assert!(nested.join(".git").exists());
        assert_eq!(read(&nested, "inner.txt"), "uncommitted inner work\n");

        // A nested repository with no commit cannot be recorded at all, so the
        // capture — and any restore that depends on it — fails rather than
        // proceeding without it.
        let empty = root.join("empty-nested");
        std::fs::create_dir_all(&empty).unwrap();
        git_in(&empty, &["init", "-q"]);
        write(&empty, "f.txt", "never committed\n");
        match capture(&root, &id, Some(&point.sha), "x", &[], Destination::Managed) {
            Err(err) => eprintln!("capture with an empty nested repository fails: {err}"),
            Ok(cp) => {
                let held = String::from_utf8(
                    git_out(&root, &["ls-tree", "-r", "--name-only", &cp.sha]).unwrap(),
                )
                .unwrap();
                eprintln!("capture with an empty nested repository succeeded; holds:\n{held}");
            }
        }
    }

    #[test]
    fn the_executable_bit_comes_back_where_git_records_it() {
        #[cfg(windows)]
        {
            eprintln!(
                "SKIPPED the_executable_bit_comes_back_where_git_records_it: Windows has no \
                 executable bit and Git for Windows sets core.fileMode=false"
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let (_d, root) = repo();
            let id = thread_id("cp-exec");
            write(&root, "run.sh", "#!/bin/sh\necho hi\n");
            std::fs::set_permissions(root.join("run.sh"), std::fs::Permissions::from_mode(0o755))
                .unwrap();
            let point = managed(&root, &id, None, "before");
            std::fs::set_permissions(root.join("run.sh"), std::fs::Permissions::from_mode(0o644))
                .unwrap();
            safe_restore(&root, &id, &point.sha, &point);
            let mode = std::fs::metadata(root.join("run.sh")).unwrap().permissions().mode();
            assert_ne!(mode & 0o111, 0, "mode {mode:o}");
        }
    }

    #[test]
    fn line_endings_come_back_byte_for_byte() {
        let (_d, root) = repo();
        let id = thread_id("cp-eol");
        // The conversions most likely to rewrite bytes: Git for Windows' default
        // autocrlf, and a repository that normalises line endings itself.
        git_in(&root, &["config", "core.autocrlf", "true"]);
        write(&root, ".gitattributes", "* text=auto\n*.crlf text eol=crlf\n");
        write(&root, "lf.txt", "a\nb\n");
        write(&root, "crlf.txt", "c\r\nd\r\n");
        write(&root, "mixed.txt", "e\r\nf\n");
        write(&root, "x.crlf", "g\nh\n");
        let point = managed(&root, &id, None, "before");
        let at_point = tree_state(&root);

        for rel in ["lf.txt", "crlf.txt", "mixed.txt", "x.crlf"] {
            write(&root, rel, "changed\n");
        }
        safe_restore(&root, &id, &point.sha, &point);
        assert_eq!(tree_state(&root), at_point);
        assert_eq!(std::fs::read(root.join("crlf.txt")).unwrap(), b"c\r\nd\r\n");
        assert_eq!(std::fs::read(root.join("x.crlf")).unwrap(), b"g\nh\n");
    }
}
