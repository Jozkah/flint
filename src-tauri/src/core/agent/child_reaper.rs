//! Automatic removal of isolated child worktrees that ended with nothing in
//! them.
//!
//! Every writing child gets its own worktree and branch, and a child that
//! failed or was cancelled used to keep both until someone discarded them by
//! hand. This removes such a worktree only when every check below passes:
//!
//! - the child's record says it failed or was cancelled, and it ended more than
//!   [`GRACE`] ago, so a person had time to look at it;
//! - the worktree is still the one that was recorded (same repository, same
//!   branch, under Flint's own worktree folder);
//! - `git status` in it succeeds and lists nothing: no change, no untracked
//!   file, and no ignored entry other than a whole ignored `node_modules` or
//!   `target` directory, which a build recreates. An ignored `.env` or local
//!   config keeps the worktree, even inside a committed folder that happens to
//!   be called `target`;
//! - its branch holds no commit that no other branch, tag or remote has;
//! - and the ordinary non-forcing discard agrees, which re-checks the changes
//!   and the commits and refuses on its own if either changed.
//!
//! What is removed is therefore the checkout of committed files that exist
//! elsewhere, plus ignored `node_modules` and `target` directories.
//!
//! The slow checks (the worktree's state, the status scan, the commit count)
//! run without the team-children record lock, so other children starting and
//! settling are not held up by them. The record is read under that lock before
//! the checks and again after them, and the worktree is removed, still under
//! the lock, only if the record did not change in between. A child starting
//! takes the same lock and refuses a worktree that is gone, so a child resumed
//! into this worktree during a pass is never removed under it.
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
            let outcome = reap_one(data_folder, &record, roots, grace, at);
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

/// The same ending of the same child in the same worktree: what must not
/// change between the record read before the checks and the one read before
/// removal.
fn same_ending(a: &ChildRecord, b: &ChildRecord) -> bool {
    a.status == b.status
        && a.ended_at == b.ended_at
        && a.worktree_path == b.worktree_path
        && a.branch == b.branch
}

/// The record as it is now, if it is still due and still the ending `seen`.
fn still_due(
    data_folder: &Path,
    seen: &ChildRecord,
    grace: chrono::Duration,
    at: chrono::DateTime<chrono::Utc>,
) -> Result<ChildRecord, Outcome> {
    match team_children::load(data_folder, &seen.owner_id) {
        Ok(now) if due(&now, grace, at) && same_ending(&now, seen) => Ok(now),
        Ok(_) => Err(Outcome::Kept(
            "the child was resumed or its record changed during this pass".into(),
        )),
        Err(e) => Err(Outcome::Kept(e.message)),
    }
}

/// Re-read `snapshot`'s record under the record lock, run the slow checks
/// without it, then remove the worktree under the lock only if the record is
/// still the one the checks were for.
fn reap_one(
    data_folder: &Path,
    snapshot: &ChildRecord,
    roots: &Path,
    grace: chrono::Duration,
    at: chrono::DateTime<chrono::Utc>,
) -> Outcome {
    let seen = match team_children::with_records_locked(|| still_due(data_folder, snapshot, grace, at)) {
        Ok(record) => record,
        Err(kept) => return kept,
    };
    let wt = match scan(&seen, roots) {
        Ok(wt) => wt,
        Err(why) => return Outcome::Kept(why),
    };
    discard_if_unchanged(data_folder, &seen, &wt, roots, grace, at)
}

/// Under the record lock: remove the worktree if the record is still `seen`.
fn discard_if_unchanged(
    data_folder: &Path,
    seen: &ChildRecord,
    wt: &worktree::WorktreeRecord,
    roots: &Path,
    grace: chrono::Duration,
    at: chrono::DateTime<chrono::Utc>,
) -> Outcome {
    team_children::with_records_locked(|| {
        if let Err(kept) = still_due(data_folder, seen, grace, at) {
            return kept;
        }
        match worktree::discard_owned(wt, roots, false) {
            Ok(()) => Outcome::Reaped,
            Err(e) => Outcome::Kept(e),
        }
    })
}

/// Ignored paths a build or install recreates, so losing them loses nothing.
const REGENERABLE: &[&str] = &["node_modules", "target"];

/// Whether an ignored entry from `git status --ignored=matching` is a whole
/// dependency or build output directory: reported as a directory (trailing
/// slash) whose own name is in [`REGENERABLE`]. A file inside a committed
/// folder that merely shares the name (`docs/target/.env`) is not.
fn regenerable(path: &str) -> bool {
    path.trim_matches('"')
        .strip_suffix('/')
        .is_some_and(|dir| REGENERABLE.contains(&dir.rsplit('/').next().unwrap_or("")))
}

/// Why the worktree's status keeps it, if it does: any change or untracked
/// file, or an ignored file outside [`REGENERABLE`] folders.
fn status_keeps(porcelain: &str) -> Option<String> {
    let mut ignored = Vec::new();
    for line in porcelain.lines().filter(|l| !l.trim().is_empty()) {
        match line.strip_prefix("!! ") {
            Some(path) if regenerable(path) => {}
            Some(path) => ignored.push(path.trim_matches('"').to_string()),
            None => return Some("it has uncommitted changes".into()),
        }
    }
    (!ignored.is_empty()).then(|| format!("it holds ignored files: {}", ignored.join(", ")))
}

/// The slow checks, run without the record lock: the worktree is still the
/// recorded one, holds nothing but regenerable ignored output, and its branch
/// has no commit found nowhere else. `Err` says why it is kept.
fn scan(record: &ChildRecord, roots: &Path) -> Result<worktree::WorktreeRecord, String> {
    let wt = team_children::checked_worktree(record, roots).map_err(|e| e.message)?;
    let status = worktree::run(
        Path::new(&wt.path),
        &["status", "--porcelain", "--untracked-files=all", "--ignored=matching"],
    )
    .map_err(|e| format!("its status could not be read: {e}"))?;
    if let Some(why) = status_keeps(&status) {
        return Err(why);
    }
    match commits_only_on(&wt.source_root, &wt.branch) {
        Ok(0) => Ok(wt),
        Ok(n) => Err(format!("its branch has {n} commit(s) found nowhere else")),
        Err(e) => Err(format!("its commits could not be checked: {e}")),
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

/// Clears [`REAPING`] when dropped, so a pass that panics does not leave the
/// reaper switched off for the rest of the session.
struct ReapingReset;

impl Drop for ReapingReset {
    fn drop(&mut self) {
        REAPING.store(false, Ordering::Release);
    }
}

/// Run a pass on a background thread, after `delay`. Does nothing if a pass is
/// already running.
pub fn reap_in_background(data_folder: PathBuf, delay: std::time::Duration) {
    if REAPING.swap(true, Ordering::AcqRel) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("child-worktree-reaper".into())
        .spawn(move || {
            let _reset = ReapingReset;
            std::thread::sleep(delay);
            match worktree::absolute(&tauri_plugin_agent_tools::workspace::worktrees_dir(
                &data_folder,
            )) {
                Ok(roots) => {
                    reap(&data_folder, &roots, GRACE, chrono::Utc::now());
                }
                Err(e) => log::warn!("child worktree reaper: no worktree folder: {e}"),
            }
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
        std::fs::write(repo.join(".gitignore"), ".env\nnode_modules/\ntarget/\n").unwrap();
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
        let ended = ended.to_rfc3339();
        team_children::update_record_for_test(&f.data, &owner, |r| r.ended_at = Some(ended));
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
    fn an_ignored_env_file_keeps_the_worktree_but_build_output_does_not() {
        let f = fixture();
        let now = chrono::Utc::now();
        let old = now - chrono::Duration::days(2);
        let secrets = child(&f, "t1", ChildStatus::Failed, old);
        std::fs::write(Path::new(&secrets.worktree_path).join(".env"), "TOKEN=x\n").unwrap();
        let built = child(&f, "t2", ChildStatus::Cancelled, old);
        let wt = Path::new(&built.worktree_path);
        std::fs::create_dir_all(wt.join("node_modules/pkg")).unwrap();
        std::fs::write(wt.join("node_modules/pkg/index.js"), "x").unwrap();
        std::fs::create_dir_all(wt.join("target/debug")).unwrap();
        std::fs::write(wt.join("target/debug/app"), "x").unwrap();

        let out = reap(&f.data, &f.roots, GRACE, now);
        assert!(matches!(outcome_for(&out, &secrets), Some(Outcome::Kept(why)) if why.contains(".env")), "{out:?}");
        assert!(Path::new(&secrets.worktree_path).join(".env").exists());
        assert_eq!(outcome_for(&out, &built), Some(Outcome::Reaped));
        assert!(!wt.exists());
    }

    #[test]
    fn only_a_whole_ignored_output_directory_is_regenerable() {
        for dir in ["node_modules/", "target/", "web-app/node_modules/", "src-tauri/target/"] {
            assert!(regenerable(dir), "{dir}");
        }
        for kept in [
            "docs/target/.env",
            "config/target/local.json",
            "node_modules/.env",
            "target",
            "targets/",
            "docs/node_modules_backup/",
        ] {
            assert!(!regenerable(kept), "{kept}");
        }
        assert!(status_keeps("!! docs/target/.env\n").is_some());
        assert!(status_keeps("!! config/target/local.json\n").is_some());
        assert_eq!(status_keeps("!! node_modules/\n!! target/\n!! web-app/node_modules/\n"), None);
    }

    #[test]
    fn status_lines_are_judged_by_kind_and_place() {
        assert_eq!(status_keeps(""), None);
        assert_eq!(status_keeps("!! node_modules/\n!! web/target/\n"), None);
        assert!(status_keeps(" M a.txt\n").is_some());
        assert!(status_keeps("?? new.txt\n").is_some());
        assert!(status_keeps("!! .env\n").unwrap().contains(".env"));
        assert!(status_keeps("!! node_modules/\n!! config/local.json\n").is_some());
    }

    /// The record is read again after the unlocked checks: a child resumed
    /// (or re-ended) between the scan and the removal keeps its worktree.
    #[test]
    fn a_record_that_changes_after_the_scan_keeps_the_worktree() {
        let f = fixture();
        let now = chrono::Utc::now();
        let old = now - chrono::Duration::days(2);
        for (task, change) in [
            ("t1", Box::new(|r: &mut ChildRecord| {
                r.status = ChildStatus::Running;
                r.ended_at = None;
            }) as Box<dyn FnOnce(&mut ChildRecord)>),
            ("t2", Box::new(|r: &mut ChildRecord| {
                r.ended_at = Some((chrono::Utc::now() - chrono::Duration::days(3)).to_rfc3339());
            })),
        ] {
            let record = child(&f, task, ChildStatus::Failed, old);
            let seen = team_children::with_records_locked(|| still_due(&f.data, &record, GRACE, now))
                .expect("due before the scan");
            let wt = scan(&seen, &f.roots).expect("clean worktree");
            team_children::update_record_for_test(&f.data, &record.owner_id, change);
            let outcome = discard_if_unchanged(&f.data, &seen, &wt, &f.roots, GRACE, now);
            assert!(matches!(outcome, Outcome::Kept(_)), "{task}: {outcome:?}");
            assert!(Path::new(&record.worktree_path).exists(), "{task}");
        }
    }

    /// The slow checks need no record lock: they finish while another thread
    /// holds it, the way a child starting or settling would.
    #[test]
    fn the_scan_runs_while_another_thread_holds_the_record_lock() {
        let f = fixture();
        let now = chrono::Utc::now();
        let record = child(&f, "t1", ChildStatus::Failed, now - chrono::Duration::days(2));
        let roots = f.roots.clone();
        let done = team_children::with_records_locked(|| {
            let (tx, rx) = std::sync::mpsc::channel();
            let scanned = record.clone();
            std::thread::spawn(move || {
                let _ = tx.send(scan(&scanned, &roots).is_ok());
            });
            rx.recv_timeout(std::time::Duration::from_secs(60))
        });
        assert_eq!(done, Ok(true), "the scan waited for the record lock");
    }

    /// A child resumed after the pass took its snapshot is running in that
    /// worktree again; the pass re-reads the record and keeps it.
    #[test]
    fn a_child_resumed_during_a_pass_keeps_its_worktree() {
        let f = fixture();
        let now = chrono::Utc::now();
        let snapshot = child(&f, "t1", ChildStatus::Failed, now - chrono::Duration::days(2));
        assert!(due(&snapshot, GRACE, now));
        team_children::update_record_for_test(&f.data, &snapshot.owner_id, |r| {
            r.status = ChildStatus::Running;
            r.ended_at = None;
        });
        let outcome = reap_one(&f.data, &snapshot, &f.roots, GRACE, now);
        assert!(matches!(outcome, Outcome::Kept(_)), "{outcome:?}");
        assert!(Path::new(&snapshot.worktree_path).exists());
    }

    /// The flag that keeps passes from overlapping is cleared even when a pass
    /// panics.
    #[test]
    fn a_panicking_pass_does_not_leave_the_reaper_switched_off() {
        REAPING.store(true, Ordering::Release);
        let result = std::panic::catch_unwind(|| {
            let _reset = ReapingReset;
            panic!("a pass went wrong");
        });
        assert!(result.is_err());
        assert!(!REAPING.load(Ordering::Acquire));
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
