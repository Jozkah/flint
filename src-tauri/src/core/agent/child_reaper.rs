//! Automatic removal of isolated child worktrees that ended with nothing in
//! them.
//!
//! Every writing child gets its own worktree and branch, and a child that
//! failed or was cancelled used to keep both until someone discarded them by
//! hand. This removes such a worktree only when removing it cannot lose
//! anything:
//!
//! - the child's record says it failed or was cancelled, and it ended more than
//!   [`GRACE`] ago, so a person had time to look at it;
//! - the worktree is still the one that was recorded (same repository, same
//!   branch, under Flint's own worktree folder);
//! - `git status` in it succeeds and lists nothing, untracked files included;
//! - its branch holds no commit that no other branch, tag or remote has;
//! - and the ordinary non-forcing discard agrees, which re-checks both of the
//!   above and refuses on its own if either changed.
//!
//! Anything that fails a check is left alone and the reason is logged. The
//! record itself is kept, so the review list still shows the child (as
//! deleted) until the records' own retention removes it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::core::agent::team_children::{self, ChildRecord, ChildStatus};
use crate::core::agent::worktree;

/// How long after a child ends its worktree is left for a person to look at.
pub const GRACE: chrono::Duration = chrono::Duration::hours(24);

/// What one pass did with one child's worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Reaped,
    Kept(String),
}

/// Look at every failed or cancelled child whose grace period is over and
/// remove the worktrees that hold no work. Children that do not qualify by
/// status or age are not reported; those that qualify but were kept are, with
/// the reason.
pub fn reap(
    data_folder: &Path,
    roots: &Path,
    grace: chrono::Duration,
    at: chrono::DateTime<chrono::Utc>,
) -> Vec<(String, Outcome)> {
    team_children::all_records(data_folder)
        .into_iter()
        .filter(|record| due(record, grace, at))
        .filter(|record| Path::new(&record.worktree_path).exists())
        .map(|record| {
            let outcome = reap_one(&record, roots);
            match &outcome {
                Outcome::Reaped => log::info!(
                    "team child {} {}: removed its empty worktree {} and branch {}",
                    record.task_id,
                    ending(record.status),
                    record.worktree_path,
                    record.branch
                ),
                Outcome::Kept(why) => log::info!(
                    "team child {} {}: kept its worktree {} ({why})",
                    record.task_id,
                    ending(record.status),
                    record.worktree_path
                ),
            }
            (record.worktree_path, outcome)
        })
        .collect()
}

fn ending(status: ChildStatus) -> &'static str {
    match status {
        ChildStatus::Failed => "failed",
        ChildStatus::Cancelled => "was cancelled",
        ChildStatus::Completed => "completed",
        ChildStatus::Running => "is running",
    }
}

/// Failed or cancelled, with an end time more than `grace` before `at`. A
/// record without a readable end time is never due.
fn due(record: &ChildRecord, grace: chrono::Duration, at: chrono::DateTime<chrono::Utc>) -> bool {
    matches!(record.status, ChildStatus::Failed | ChildStatus::Cancelled)
        && record
            .ended_at
            .as_deref()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .is_some_and(|ended| ended < at - grace)
}

fn reap_one(record: &ChildRecord, roots: &Path) -> Outcome {
    let wt = match team_children::checked_worktree(record, roots) {
        Ok(wt) => wt,
        Err(e) => return Outcome::Kept(e.message),
    };
    match worktree::run(
        Path::new(&wt.path),
        &["status", "--porcelain", "--untracked-files=all"],
    ) {
        Ok(out) if out.trim().is_empty() => {}
        Ok(_) => return Outcome::Kept("it has uncommitted changes".into()),
        Err(e) => return Outcome::Kept(format!("its status could not be read: {e}")),
    }
    match commits_only_on(&wt.source_root, &wt.branch) {
        Ok(0) => {}
        Ok(n) => return Outcome::Kept(format!("its branch has {n} commit(s) found nowhere else")),
        Err(e) => return Outcome::Kept(format!("its commits could not be checked: {e}")),
    }
    match worktree::discard_owned(&wt, roots, false) {
        Ok(()) => Outcome::Reaped,
        Err(e) => Outcome::Kept(e),
    }
}

/// How many commits `branch` has that no other branch, tag or remote ref
/// reaches.
fn commits_only_on(source_root: &str, branch: &str) -> Result<usize, String> {
    let exclude = format!("--exclude={branch}");
    let out = worktree::run(
        Path::new(source_root),
        &[
            "rev-list",
            "--count",
            &format!("refs/heads/{branch}"),
            "--not",
            &exclude,
            "--branches",
            "--tags",
            "--remotes",
        ],
    )?;
    out.trim()
        .parse::<usize>()
        .map_err(|e| format!("unexpected rev-list output {out:?}: {e}"))
}

/// One pass at a time: a run ending while the startup pass is still going
/// does not start a second one over the same worktrees.
static REAPING: AtomicBool = AtomicBool::new(false);

/// Run a pass on a background thread, after `delay`. Does nothing if a pass is
/// already running.
pub fn reap_in_background(data_folder: PathBuf, delay: std::time::Duration) {
    if REAPING.swap(true, Ordering::AcqRel) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("child-worktree-reaper".into())
        .spawn(move || {
            std::thread::sleep(delay);
            match worktree::absolute(&tauri_plugin_agent_tools::workspace::worktrees_dir(
                &data_folder,
            )) {
                Ok(roots) => {
                    reap(&data_folder, &roots, GRACE, chrono::Utc::now());
                }
                Err(e) => log::warn!("child worktree reaper: no worktree folder: {e}"),
            }
            REAPING.store(false, Ordering::Release);
        });
    if let Err(e) = spawned {
        log::warn!("child worktree reaper could not start: {e}");
        REAPING.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::team_children::BeginInput;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.com",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    struct Fixture {
        _tmp: tempfile::TempDir,
        data: PathBuf,
        roots: PathBuf,
        repo: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let data = tmp.path().join("data");
        let roots = data.join("worktrees");
        std::fs::create_dir_all(&roots).unwrap();
        let roots = worktree::absolute(&roots).unwrap();
        Fixture {
            data,
            roots,
            repo: repo.canonicalize().unwrap(),
            _tmp: tmp,
        }
    }

    /// A child with its own worktree, ended `status` at `ended`.
    fn child(f: &Fixture, task: &str, status: ChildStatus, ended: chrono::DateTime<chrono::Utc>) -> ChildRecord {
        let owner = tauri_plugin_agent_tools::child_session_id("parent", task);
        worktree::ensure(&f.repo, &f.roots, &owner).unwrap();
        team_children::begin(
            &f.data,
            &f.roots,
            BeginInput {
                parent_session: "parent".into(),
                task_id: task.into(),
                run: String::new(),
                call: String::new(),
                description: String::new(),
                agent: String::new(),
                project: f.repo.to_string_lossy().into_owned(),
                declared_writes: Vec::new(),
                overrides: Vec::new(),
            },
        )
        .unwrap();
        team_children::settle(&f.data, &f.roots, "parent", task, status, "").unwrap();
        team_children::set_ended_at_for_test(&f.data, &owner, &ended.to_rfc3339());
        team_children::load(&f.data, &owner).unwrap()
    }

    fn outcome_for(out: &[(String, Outcome)], record: &ChildRecord) -> Option<Outcome> {
        out.iter()
            .find(|(p, _)| p == &record.worktree_path)
            .map(|(_, o)| o.clone())
    }

    #[test]
    fn an_empty_failed_worktree_past_its_grace_is_removed() {
        let f = fixture();
        let now = chrono::Utc::now();
        let old = child(&f, "t1", ChildStatus::Failed, now - chrono::Duration::hours(30));
        let out = reap(&f.data, &f.roots, GRACE, now);
        assert_eq!(outcome_for(&out, &old), Some(Outcome::Reaped));
        assert!(!Path::new(&old.worktree_path).exists());
        let branches = worktree::run(&f.repo, &["branch", "--list", &old.branch]).unwrap();
        assert!(branches.trim().is_empty(), "branch left behind: {branches}");
        assert!(team_children::load(&f.data, &old.owner_id).is_ok(), "the record stays");
    }

    #[test]
    fn a_worktree_inside_its_grace_or_completed_is_not_touched() {
        let f = fixture();
        let now = chrono::Utc::now();
        let fresh = child(&f, "t1", ChildStatus::Cancelled, now - chrono::Duration::hours(2));
        let done = child(&f, "t2", ChildStatus::Completed, now - chrono::Duration::days(5));
        let out = reap(&f.data, &f.roots, GRACE, now);
        assert!(out.is_empty(), "{out:?}");
        assert!(Path::new(&fresh.worktree_path).exists());
        assert!(Path::new(&done.worktree_path).exists());
    }

    #[test]
    fn uncommitted_or_untracked_work_keeps_the_worktree() {
        let f = fixture();
        let now = chrono::Utc::now();
        let old = now - chrono::Duration::days(2);
        let edited = child(&f, "t1", ChildStatus::Failed, old);
        std::fs::write(Path::new(&edited.worktree_path).join("a.txt"), "changed\n").unwrap();
        let untracked = child(&f, "t2", ChildStatus::Cancelled, old);
        std::fs::write(Path::new(&untracked.worktree_path).join("new.txt"), "x\n").unwrap();
        let out = reap(&f.data, &f.roots, GRACE, now);
        assert!(matches!(outcome_for(&out, &edited), Some(Outcome::Kept(_))), "{out:?}");
        assert!(matches!(outcome_for(&out, &untracked), Some(Outcome::Kept(_))), "{out:?}");
        assert!(Path::new(&edited.worktree_path).join("a.txt").exists());
        assert!(Path::new(&untracked.worktree_path).join("new.txt").exists());
    }

    #[test]
    fn a_commit_only_on_the_child_branch_keeps_the_worktree() {
        let f = fixture();
        let now = chrono::Utc::now();
        let committed = child(&f, "t1", ChildStatus::Failed, now - chrono::Duration::days(2));
        let wt = Path::new(&committed.worktree_path);
        std::fs::write(wt.join("b.txt"), "b\n").unwrap();
        git(wt, &["add", "."]);
        git(wt, &["commit", "-q", "-m", "child work"]);
        let out = reap(&f.data, &f.roots, GRACE, now);
        assert!(matches!(outcome_for(&out, &committed), Some(Outcome::Kept(_))), "{out:?}");
        assert!(wt.join("b.txt").exists());

        // Once that commit is on another branch, nothing is lost by removing it.
        git(&f.repo, &["merge", "-q", "--ff-only", &committed.branch]);
        let out = reap(&f.data, &f.roots, GRACE, now);
        assert_eq!(outcome_for(&out, &committed), Some(Outcome::Reaped));
    }

    #[test]
    fn a_second_pass_is_a_no_op() {
        let f = fixture();
        let now = chrono::Utc::now();
        child(&f, "t1", ChildStatus::Failed, now - chrono::Duration::days(2));
        assert_eq!(reap(&f.data, &f.roots, GRACE, now).len(), 1);
        assert!(reap(&f.data, &f.roots, GRACE, now).is_empty());
    }
}
