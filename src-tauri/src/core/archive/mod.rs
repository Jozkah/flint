//! Archive instead of delete. See `store` for the layout and the rules.
//!
//! `mod.rs` holds the purge cleanup, the one place that knows what each kind
//! owns outside its archived copy.

pub mod commands;
pub mod store;

use std::path::Path;

use store::{ArchiveMeta, Kind};

/// What a startup pass did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct StartupReport {
    pub auto_archived: usize,
    pub purged: usize,
    pub blocked: usize,
}

/// Archive threads that have sat idle past the configured age. Cheap when the
/// setting is off (the default): nothing is read. Meant to run before the
/// window lists threads, so the list never names a thread that has just moved.
pub fn auto_archive_idle_threads(data: &Path, now: u64) -> usize {
    let settings = store::read_settings(data);
    if !settings.enabled {
        return 0;
    }
    store::auto_archive_threads(data, settings.auto_archive_thread_days, now).len()
}

/// Delete archived items older than the configured retention. Items a guard
/// refuses (a Cowork session whose worktree holds unmerged work) stay and are
/// retried on the next start.
pub fn sweep_expired(data: &Path, now: u64) -> StartupReport {
    let settings = store::read_settings(data);
    let mut hook = |m: &ArchiveMeta, d: &Path| purge_cleanup(data, m, d);
    let report = store::sweep(data, settings.auto_delete_days, now, &mut hook);
    for b in &report.blocked {
        log::info!(
            "archived {} \"{}\" kept past its retention: {}",
            b.kind.as_str(),
            b.title,
            b.reason
        );
    }
    StartupReport {
        auto_archived: 0,
        purged: report.purged,
        blocked: report.blocked.len(),
    }
}

/// What destroying an archived item also destroys, run before its directory is
/// removed. A refusal keeps the item: nothing is half-purged.
pub fn purge_cleanup(data: &Path, meta: &ArchiveMeta, _dir: &Path) -> Result<(), String> {
    match meta.kind {
        Kind::Thread => {
            // The sanitized copies of what this conversation sent, and the
            // provider's counts for them, go with it. Best effort, like the
            // directory removal: a log that cannot be rewritten right now must
            // not stop the purge.
            if let Err(e) = tauri_plugin_agent_tools::retention::delete_session(data, &meta.id) {
                log::warn!("could not remove request records for a purged thread: {e}");
            }
            // The thread's agent scratch dir in the OS temp folder is ours to
            // remove too (Jozkah/jan#186).
            if let Some(scratch) = crate::core::threads::utils::thread_scratch_dir(&meta.id) {
                if let Err(e) = std::fs::remove_dir_all(&scratch) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        log::warn!("could not remove a purged thread's scratch dir: {e}");
                    }
                }
            }
            Ok(())
        }
        Kind::Cowork => {
            // Archiving never discards a worktree. Only when the user chose to
            // remove it along with the session does the purge do it, and then
            // under the same guard as ever: unmerged or uncommitted work
            // blocks the purge and the session stays archived.
            let extra = meta.extra.as_ref();
            let discard = extra
                .and_then(|e| e.get("discardOnPurge"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if discard {
                if let Some(record) = extra
                    .and_then(|e| e.get("worktree"))
                    .filter(|v| !v.is_null())
                {
                    crate::core::agent::commands::discard_for_purge(data, record).map_err(|e| {
                        format!(
                            "\"{}\" keeps its worktree: {e}. Merge or export that work first, then delete the session again.",
                            meta.title
                        )
                    })?;
                }
            }
            // Everything recorded for the session: its prompts, usage, stored
            // diffs, permission decisions and undo journal.
            if let Err(e) = tauri_plugin_agent_tools::retention::delete_session(data, &meta.id) {
                log::warn!("could not remove records of a purged Cowork session: {e}");
            }
            Ok(())
        }
        Kind::Room | Kind::Project => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
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
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// A data folder, a repository, and a Flint worktree for one session.
    fn cowork_fixture() -> (tempfile::TempDir, std::path::PathBuf, serde_json::Value) {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "first"]);
        let roots = crate::core::agent::worktree::absolute(
            &tauri_plugin_agent_tools::workspace::worktrees_dir(&data),
        )
        .unwrap();
        let record = crate::core::agent::worktree::ensure(&repo, &roots, "session-1").unwrap();
        let mut value = serde_json::to_value(&record).unwrap();
        value["kind"] = json!("worktree");
        (dir, data, value)
    }

    fn archive_session(data: &Path, record: &serde_json::Value, discard: bool) {
        store::archive_payload(
            data,
            Kind::Cowork,
            "session-1",
            "Work",
            &json!({ "id": "session-1" }),
            Some(json!({ "worktree": record, "discardOnPurge": discard })),
        )
        .unwrap();
    }

    fn purge(data: &Path) -> Result<(), String> {
        let mut hook = |m: &ArchiveMeta, d: &Path| purge_cleanup(data, m, d);
        store::purge_with(data, Kind::Cowork, "session-1", &mut hook)
    }

    #[test]
    fn startup_archives_idle_threads_and_purges_expired_items() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let day = 86_400_000u64;
        let now = store::now_ms() + 100 * day;
        let thread = |id: &str| {
            let t = data.join("threads").join(id);
            std::fs::create_dir_all(&t).unwrap();
            std::fs::write(t.join("thread.json"), json!({"id": id, "updated": 1.0}).to_string())
                .unwrap();
        };
        thread("idle");

        // Off by default: nothing moves.
        assert_eq!(auto_archive_idle_threads(data, now), 0);
        store::write_settings(
            data,
            &store::ArchiveSettings {
                enabled: true,
                auto_delete_days: 30,
                auto_archive_thread_days: 30,
            },
        )
        .unwrap();
        assert_eq!(auto_archive_idle_threads(data, now), 1);
        assert_eq!(store::list(data).len(), 1);

        // Now old enough to expire: archived "now", swept 31 days later.
        assert_eq!(sweep_expired(data, store::now_ms()).purged, 0);
        let report = sweep_expired(data, store::now_ms() + 31 * day);
        assert_eq!(report.purged, 1);
        assert!(store::list(data).is_empty());

        // With the archive off, idle threads are left alone.
        thread("idle2");
        store::write_settings(
            data,
            &store::ArchiveSettings { enabled: false, auto_delete_days: 30, auto_archive_thread_days: 30 },
        )
        .unwrap();
        assert_eq!(auto_archive_idle_threads(data, now), 0);
        assert!(data.join("threads/idle2").exists());
    }

    #[test]
    fn archiving_a_session_never_touches_its_worktree() {
        let (_dir, data, record) = cowork_fixture();
        archive_session(&data, &record, true);
        let path = record["path"].as_str().unwrap();
        assert!(Path::new(path).exists(), "archiving must not discard the worktree");
    }

    #[test]
    fn purge_keeps_the_worktree_when_the_user_chose_to_keep_it() {
        let (_dir, data, record) = cowork_fixture();
        archive_session(&data, &record, false);
        purge(&data).unwrap();
        assert!(Path::new(record["path"].as_str().unwrap()).exists());
        assert!(store::list(&data).is_empty());
    }

    #[test]
    fn purge_is_blocked_by_unmerged_work_and_the_session_stays() {
        let (_dir, data, record) = cowork_fixture();
        let wt = std::path::PathBuf::from(record["path"].as_str().unwrap());
        std::fs::write(wt.join("new.txt"), "work").unwrap();
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "-q", "-m", "unmerged work"]);
        archive_session(&data, &record, true);

        let err = purge(&data).unwrap_err();
        assert!(err.contains("keeps its worktree"), "{err}");
        assert!(err.contains("unmerged work") || err.contains("not in"), "{err}");
        assert!(wt.exists(), "the worktree is untouched");
        assert_eq!(store::list(&data).len(), 1, "the session stays archived");
    }

    #[test]
    fn purge_discards_a_clean_worktree_and_tolerates_one_already_gone() {
        let (_dir, data, record) = cowork_fixture();
        archive_session(&data, &record, true);
        purge(&data).unwrap();
        assert!(!Path::new(record["path"].as_str().unwrap()).exists());

        // A record whose worktree is already gone has nothing to lose.
        archive_session(&data, &record, true);
        purge(&data).unwrap();
        assert!(store::list(&data).is_empty());
    }

    #[test]
    fn a_decoy_record_is_refused_not_trusted() {
        let (_dir, data, mut record) = cowork_fixture();
        let elsewhere = data.parent().unwrap().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        record["path"] = json!(elsewhere.to_string_lossy());
        archive_session(&data, &record, true);
        assert!(purge(&data).is_err());
        assert!(elsewhere.exists());
    }
}
