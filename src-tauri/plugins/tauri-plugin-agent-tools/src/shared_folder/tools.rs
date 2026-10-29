//! The tool-side half: the checks the file tools, the git tool and the shell
//! tools make before acting, and the notice after a branch moved.
//!
//! Each decision is a function over `(mailbox, table, session, now)` so it
//! tests without a tool context; the `ToolContext` wrappers only find the
//! caller's identity. A call with no mailbox identity (the CLI, a subagent
//! child, a plain chat thread) is never held.

use std::path::{Path, PathBuf};

use super::claims::{ClaimTable, Decision};
use super::guard::{self, Probe, TreeChange};
use super::{clean_name, head, now_ms, path_key, table, view, GIT_HELD_PREFIX, HELD_PREFIX};
use crate::session_mailbox::{Mailbox, SessionRecord, SessionStatus};
use crate::tools::ToolContext;

fn identity(ctx: &ToolContext<'_>) -> Option<(Mailbox, String)> {
    let data = ctx.mailbox_root?;
    let me = ctx.mailbox_session.or(ctx.session_id)?;
    Some((Mailbox::open(data), me.to_string()))
}


// -- file claims ------------------------------------------------------------

/// The hold text for a write another session has claimed, or `None` to go
/// ahead. `shown` is the path as the agent wrote it.
pub fn decide_write(
    mailbox: &Mailbox,
    table: &mut ClaimTable,
    me: &str,
    file: &str,
    shown: &str,
    now: i64,
) -> Option<String> {
    // One registry read for the whole decision, not one per session named.
    let sessions = mailbox.sessions_now();
    let record = sessions.get(me)?;
    // An isolated session writes in its own copy: no claims either way.
    if record.shared.isolated || record.shared.folder_key.is_none() {
        return None;
    }
    let name = |id: &str| {
        sessions
            .get(id)
            .map(|r| clean_name(&r.display_name))
            .unwrap_or_else(|| "another session".to_string())
    };
    let live = |id: &str| sessions.get(id).is_some_and(|r| mailbox.is_live_member(r) && !r.shared.isolated);
    match table.check_write(me, file, &name, &live, now) {
        Decision::Allow => None,
        Decision::Hold { owner_id } => Some(format!(
            "{HELD_PREFIX}{shown} is being edited by {}. Message them with send_message, \
             re-read the file, then retry.",
            name(&owner_id)
        )),
    }
}

/// Record a successful write: takes the claim (unless isolated) and lists the
/// file among the session's recent edits.
pub fn decide_record(
    mailbox: &Mailbox,
    table: &mut ClaimTable,
    me: &str,
    file: &str,
    now: i64,
) {
    let Some(record) = mailbox.session(me) else { return };
    let claim = !record.shared.isolated && record.shared.folder_key.is_some();
    table.record_write(me, file, claim, now);
    super::announce(record.shared.folder_key, me, "claim");
}

pub fn write_gate(ctx: &ToolContext<'_>, file: &Path, shown: &str) -> Option<String> {
    let (mailbox, me) = identity(ctx)?;
    let key = path_key::file_key(file);
    let now = now_ms();
    let held = {
        let mut table = table();
        table.sweep(now);
        decide_write(&mailbox, &mut table, &me, &key, shown, now)
    };
    if held.is_some() {
        super::announce(mailbox.session(&me).and_then(|r| r.shared.folder_key), &me, "held");
    }
    held
}

pub fn record_write(ctx: &ToolContext<'_>, file: &Path) {
    let Some((mailbox, me)) = identity(ctx) else { return };
    decide_record(&mailbox, &mut table(), &me, &path_key::file_key(file), now_ms());
}

pub fn note_read(ctx: &ToolContext<'_>, file: &Path) {
    let Some((_, me)) = identity(ctx) else { return };
    table().note_read(&me, &path_key::file_key(file), now_ms());
}

/// The agent sent a message: evidence for the one-retry rule.
pub fn note_message_sent(session: &str) {
    table().note_message_sent(session, now_ms());
}

// -- git guard ----------------------------------------------------------------

struct FsProbe<'a> {
    cwd: &'a Path,
}

impl Probe for FsProbe<'_> {
    fn is_plain_path(&self, arg: &str) -> bool {
        self.cwd.join(arg).exists() && !head::branch_exists(self.cwd, arg)
    }
}

/// The other live sessions on the shared tree of `me`, running ones first.
fn tree_mates(mailbox: &Mailbox, me: &SessionRecord) -> Vec<SessionRecord> {
    let Some(key) = &me.shared.folder_key else { return Vec::new() };
    let mut mates: Vec<SessionRecord> = mailbox
        .live_in_folder(key)
        .into_iter()
        .filter(|r| r.id != me.id && !r.shared.isolated)
        .collect();
    mates.sort_by_key(|r| (r.status != SessionStatus::Running, r.id.clone()));
    mates
}

fn change_in_other_repo(change: &TreeChange, cwd: &Path, me: &SessionRecord) -> bool {
    let Some(dir) = &change.dir else { return false };
    let target = {
        let p = PathBuf::from(dir);
        if p.is_absolute() { p } else { cwd.join(p) }
    };
    let theirs = head::repo_root(&target).map(|r| path_key::folder_key(&r));
    let mine = me
        .folder
        .as_deref()
        .and_then(|f| head::repo_root(Path::new(f)))
        .map(|r| path_key::folder_key(&r));
    matches!((theirs, mine), (Some(a), Some(b)) if a != b)
}

/// The hold text for tree-changing git `changes`, or `None`. Applies only to a
/// non-isolated session in a git folder that another live non-isolated
/// session shares.
pub fn decide_git(
    mailbox: &Mailbox,
    table: &mut ClaimTable,
    me: &str,
    changes: &[TreeChange],
    cwd: &Path,
    now: i64,
) -> Option<String> {
    let record = mailbox.session(me)?;
    if record.shared.isolated || !record.shared.git || record.shared.folder_key.is_none() {
        return None;
    }
    let change = changes.iter().find(|c| !change_in_other_repo(c, cwd, &record))?;
    let mates = tree_mates(mailbox, &record);
    let owner = mates.first()?;
    let name = clean_name(&owner.display_name);
    let branch = record
        .folder
        .as_deref()
        .and_then(|f| head::read_head(Path::new(f)))
        .map(|h| h.label())
        .or_else(|| owner.shared.start_branch.clone())
        .unwrap_or_else(|| "its branch".to_string());
    match table.check_git(me, change.kind, &owner.id, &name, now) {
        Decision::Allow => None,
        Decision::Hold { .. } => Some(format!(
            "{GIT_HELD_PREFIX}{name} is working on {branch} in this folder. Switching changes \
             its files. Start an isolated worktree for this session or message them."
        )),
    }
}

/// `git` tool arguments (after the program name).
pub fn guard_git_tool(
    ctx: &ToolContext<'_>,
    program: &str,
    args: &[String],
    cwd: &Path,
) -> Option<String> {
    let (mailbox, me) = identity(ctx)?;
    let change = guard::classify_args(program, args, &FsProbe { cwd })?;
    let held = decide_git(&mailbox, &mut table(), &me, &[change], cwd, now_ms());
    if held.is_some() {
        super::announce(mailbox.session(&me).and_then(|r| r.shared.folder_key), &me, "held");
    }
    held
}

/// A shell command line (`bash`, `host_powershell`, `host_wsl`).
pub fn guard_command(ctx: &ToolContext<'_>, command: &str, cwd: &Path) -> Option<String> {
    let (mailbox, me) = identity(ctx)?;
    let changes = guard::scan_command(command, &FsProbe { cwd });
    if changes.is_empty() {
        return None;
    }
    let held = decide_git(&mailbox, &mut table(), &me, &changes, cwd, now_ms());
    if held.is_some() {
        super::announce(mailbox.session(&me).and_then(|r| r.shared.folder_key), &me, "held");
    }
    held
}

// -- HEAD moved --------------------------------------------------------------

/// The "branch changed under you" notice, if the branch differs from what the
/// session saw after its previous tool. Always re-baselines.
pub fn decide_head_moved(
    mailbox: &Mailbox,
    table: &mut ClaimTable,
    me: &str,
) -> Option<String> {
    let record = mailbox.session(me)?;
    if record.shared.isolated || !record.shared.git {
        return None;
    }
    let current = head::read_head(Path::new(record.folder.as_deref()?))?;
    let label = current.label();
    let seen = table.head_seen(me).cloned();
    table.set_head_seen(me, label.clone(), current.sha.clone());
    let (was, _) = seen?;
    if was == label {
        return None;
    }
    let who = match tree_mates(mailbox, &record).first() {
        Some(mate) => clean_name(&mate.display_name),
        None => "the user".to_string(),
    };
    super::announce(record.shared.folder_key, me, "branch");
    Some(format!(
        "The branch changed from {was} to {label} since your last step. Do not commit until it \
         is back (or ask {who})."
    ))
}

/// Before a tool runs: the moved-branch notice for its result, if any.
pub fn before_tool(ctx: &ToolContext<'_>) -> Option<String> {
    let (mailbox, me) = identity(ctx)?;
    decide_head_moved(&mailbox, &mut table(), &me)
}

/// After a tool ran: what the session did to the branch itself is not news.
pub fn after_tool(ctx: &ToolContext<'_>) {
    let Some((mailbox, me)) = identity(ctx) else { return };
    let Some(record) = mailbox.session(&me) else { return };
    if record.shared.isolated || !record.shared.git {
        return;
    }
    if let Some(h) = record.folder.as_deref().and_then(|f| head::read_head(Path::new(f))) {
        table().set_head_seen(&me, h.label(), h.sha);
    }
}

/// The environment line for a run of `session_id`, if it is not alone.
pub fn env_line_for(data_folder: &Path, session_id: &str) -> Option<String> {
    view::env_line(&Mailbox::open(data_folder), &table(), session_id, now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;

    const T0: i64 = 5_000_000;

    struct World {
        _data: tempfile::TempDir,
        repo: tempfile::TempDir,
        mailbox: Mailbox,
        clock: Arc<AtomicI64>,
        table: ClaimTable,
    }

    impl World {
        fn new() -> Self {
            let data = tempfile::tempdir().unwrap();
            let repo = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(repo.path().join(".git/refs/heads")).unwrap();
            std::fs::write(repo.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
            let clock = Arc::new(AtomicI64::new(T0));
            let mailbox = Mailbox::open(data.path()).with_clock(clock.clone());
            World { _data: data, repo, mailbox, clock, table: ClaimTable::new() }
        }
        fn join(&self, id: &str, name: &str, isolated: bool) {
            self.mailbox
                .register_shared(id, name, self.repo.path().to_str(), None, None, Some(isolated))
                .unwrap();
        }
        fn file(&self, rel: &str) -> String {
            path_key::file_key(&self.repo.path().join(rel))
        }
        fn now(&self) -> i64 {
            self.clock.load(Ordering::SeqCst)
        }
        fn tick(&self, ms: i64) {
            self.clock.fetch_add(ms, Ordering::SeqCst);
        }
        fn write(&mut self, me: &str, rel: &str) -> Option<String> {
            let key = self.file(rel);
            let now = self.now();
            let held = decide_write(&self.mailbox, &mut self.table, me, &key, rel, now);
            if held.is_none() {
                decide_record(&self.mailbox, &mut self.table, me, &key, now);
            }
            held
        }
        fn git(&mut self, me: &str, changes: &[TreeChange]) -> Option<String> {
            let cwd = self.repo.path().to_path_buf();
            let now = self.now();
            decide_git(&self.mailbox, &mut self.table, me, changes, &cwd, now)
        }
        fn run_start(&mut self, me: &str) {
            self.mailbox.set_status(me, true, Some("r1")).unwrap();
            self.table.release_session(me);
        }
        fn run_end(&mut self, me: &str) {
            self.mailbox.set_status(me, false, Some("r1")).unwrap();
            self.table.release_session(me);
        }
    }

    fn checkout() -> Vec<TreeChange> {
        vec![TreeChange { kind: "checkout", dir: None }]
    }

    #[test]
    fn two_sessions_a_claims_b_is_held_b_messages_and_retries() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        w.join("b", "Beta", false);
        assert!(w.write("a", "src/x.ts").is_none());
        w.tick(1000);
        let held = w.write("b", "src/x.ts").expect("held");
        assert_eq!(
            held,
            "Not written. src/x.ts is being edited by Alpha. Message them with send_message, \
             re-read the file, then retry."
        );
        // B messages, then retries: through.
        w.tick(1000);
        w.table.note_message_sent("b", w.now());
        w.tick(1000);
        assert!(w.write("b", "src/x.ts").is_none());
        // B now owns the claim; A is held in turn.
        w.tick(1000);
        assert!(w.write("a", "src/x.ts").unwrap().contains("Beta"));
    }

    #[test]
    fn a_different_file_is_free() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        w.join("b", "Beta", false);
        assert!(w.write("a", "src/x.ts").is_none());
        assert!(w.write("b", "src/y.ts").is_none());
    }

    #[test]
    fn an_isolated_session_is_never_held_and_never_claims() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        w.join("iso", "Iso", true);
        assert!(w.write("a", "src/x.ts").is_none());
        assert!(w.write("iso", "src/x.ts").is_none());
        // Its edit claimed nothing, so A is not held by it and A's claim stays A's.
        assert!(w.write("a", "src/x.ts").is_none());
        w.join("b", "Beta", false);
        assert!(w.write("b", "src/x.ts").unwrap().contains("Alpha"));
    }

    #[test]
    fn a_session_without_a_folder_or_unknown_is_never_held() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        w.write("a", "f");
        w.mailbox.register("loner", "Loner", None).unwrap();
        assert!(w.write("loner", "f").is_none());
        assert!(w.write("ghost", "f").is_none());
    }

    #[test]
    fn the_owners_run_ending_releases_the_claim() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        w.join("b", "Beta", false);
        w.run_start("a");
        w.write("a", "x");
        assert!(w.write("b", "x").is_some());
        w.run_end("a");
        w.tick(10);
        assert!(w.write("b", "x").is_none());
    }

    #[test]
    fn a_dead_session_cannot_wedge_a_writer() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        w.join("b", "Beta", false);
        w.run_start("a");
        w.write("a", "x");
        assert!(w.write("b", "x").is_some());
        // A's heartbeat is gone for longer than the stale limit.
        w.tick(crate::session_mailbox::STALE_AFTER_MS + 1000);
        assert!(w.write("b", "x").is_none());
    }

    #[test]
    fn an_archived_session_releases_its_claim() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        w.join("b", "Beta", false);
        w.write("a", "x");
        w.mailbox.set_archived("a", true).unwrap();
        assert!(w.write("b", "x").is_none());
    }

    #[test]
    fn a_registration_from_a_gone_process_is_not_live() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        w.write("a", "x");
        w.join("b", "Beta", false);
        // The app restarted: this process has a new epoch and A never came back.
        w.mailbox = Mailbox::open(w._data.path())
            .with_clock(w.clock.clone())
            .with_epoch("restarted");
        w.mailbox
            .register_shared("b", "Beta", w.repo.path().to_str(), None, None, Some(false))
            .unwrap();
        assert!(w.write("b", "x").is_none());
        let view = view::view_for(&w.mailbox, &w.table, "b", w.now()).unwrap();
        assert!(view.others.is_empty());
    }

    #[test]
    fn user_override_lets_a_session_edit_anyway() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        w.join("b", "Beta", false);
        w.write("a", "x");
        assert!(w.write("b", "x").is_some());
        w.table.allow("b", super::super::claims::Scope::Edit, 10, w.now());
        assert!(w.write("b", "x").is_none());
    }

    // -- git guard ----------------------------------------------------------

    #[test]
    fn git_is_held_when_another_live_session_shares_the_tree() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        w.join("b", "Beta", false);
        let held = w.git("b", &checkout())
            .expect("held");
        assert_eq!(
            held,
            "Not run. Alpha is working on main in this folder. Switching changes its files. \
             Start an isolated worktree for this session or message them."
        );
    }

    #[test]
    fn git_is_free_when_alone_or_only_isolated_peers() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        assert!(w.git("a", &checkout()).is_none());
        w.join("iso", "Iso", true);
        assert!(w.git("a", &checkout()).is_none());
        // An isolated session is never held, whoever shares the source.
        w.join("b", "Beta", false);
        assert!(w.git("iso", &checkout()).is_none());
    }

    #[test]
    fn git_is_free_in_a_folder_that_is_not_a_repo() {
        let data = tempfile::tempdir().unwrap();
        let plain = tempfile::tempdir().unwrap();
        if head::repo_root(plain.path()).is_some() {
            return; // the temp dir sits inside a repo on this machine
        }
        let m = Mailbox::open(data.path());
        m.register_shared("a", "A", plain.path().to_str(), None, None, Some(false)).unwrap();
        m.register_shared("b", "B", plain.path().to_str(), None, None, Some(false)).unwrap();
        let mut t = ClaimTable::new();
        assert!(decide_git(&m, &mut t, "b", &checkout(), plain.path(), T0).is_none());
    }

    #[test]
    fn git_retry_after_a_message_passes() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        w.join("b", "Beta", false);
        assert!(w.git("b", &checkout()).is_some());
        w.tick(10);
        w.table.note_message_sent("b", w.now());
        w.tick(10);
        assert!(w.git("b", &checkout()).is_none());
    }

    #[test]
    fn git_c_into_another_repo_is_not_held() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        w.join("b", "Beta", false);
        let other = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(other.path().join(".git")).unwrap();
        let change = vec![TreeChange {
            kind: "checkout",
            dir: Some(other.path().to_string_lossy().into_owned()),
        }];
        assert!(w.git("b", &change).is_none());
        // -C pointing back into the shared repo is still held.
        let own = vec![TreeChange {
            kind: "checkout",
            dir: Some(w.repo.path().to_string_lossy().into_owned()),
        }];
        assert!(w.git("b", &own).is_some());
    }

    #[test]
    fn the_command_scanner_feeds_the_guard() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        w.join("b", "Beta", false);
        let changes = guard::scan_command("cd sub && git checkout feat/other", &guard::NoProbe);
        assert_eq!(changes.len(), 1);
        assert!(w.git("b", &changes).is_some());
        let none = guard::scan_command("git status && git log -3", &guard::NoProbe);
        assert!(none.is_empty());
    }

    // -- HEAD moved ---------------------------------------------------------

    #[test]
    fn head_moved_under_a_session_is_reported_once() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        w.join("b", "Beta", false);
        // First tool of the run: baseline only.
        assert!(decide_head_moved(&w.mailbox, &mut w.table, "b").is_none());
        // Another session switches branches in the shared tree.
        std::fs::write(w.repo.path().join(".git/HEAD"), "ref: refs/heads/feat/multi-game-catalog\n").unwrap();
        let notice = decide_head_moved(&w.mailbox, &mut w.table, "b").expect("notice");
        assert_eq!(
            notice,
            "The branch changed from main to feat/multi-game-catalog since your last step. Do not \
             commit until it is back (or ask Alpha)."
        );
        // Said once: the next step sees a stable branch.
        assert!(decide_head_moved(&w.mailbox, &mut w.table, "b").is_none());
    }

    #[test]
    fn a_branch_the_session_moved_itself_is_not_news() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        assert!(decide_head_moved(&w.mailbox, &mut w.table, "a").is_none());
        std::fs::write(w.repo.path().join(".git/HEAD"), "ref: refs/heads/topic\n").unwrap();
        // after_tool re-baselines, which is what set_head_seen does.
        let h = head::read_head(w.repo.path()).unwrap();
        w.table.set_head_seen("a", h.label(), h.sha);
        assert!(decide_head_moved(&w.mailbox, &mut w.table, "a").is_none());
    }

    #[test]
    fn a_lone_session_is_told_to_ask_the_user() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        decide_head_moved(&w.mailbox, &mut w.table, "a");
        std::fs::write(w.repo.path().join(".git/HEAD"), "ref: refs/heads/other\n").unwrap();
        assert!(decide_head_moved(&w.mailbox, &mut w.table, "a").unwrap().ends_with("(or ask the user)."));
    }

    #[test]
    fn new_commits_on_the_same_branch_are_not_a_branch_change() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        decide_head_moved(&w.mailbox, &mut w.table, "a");
        std::fs::write(
            w.repo.path().join(".git/refs/heads/main"),
            "2222222222222222222222222222222222222222\n",
        )
        .unwrap();
        assert!(decide_head_moved(&w.mailbox, &mut w.table, "a").is_none());
    }

    #[test]
    fn a_run_start_resets_the_baseline() {
        let mut w = World::new();
        w.join("a", "Alpha", false);
        decide_head_moved(&w.mailbox, &mut w.table, "a");
        std::fs::write(w.repo.path().join(".git/HEAD"), "ref: refs/heads/other\n").unwrap();
        w.run_start("a");
        assert!(decide_head_moved(&w.mailbox, &mut w.table, "a").is_none());
    }

    #[test]
    fn isolated_sessions_are_not_told_about_the_source_branch() {
        let mut w = World::new();
        w.join("iso", "Iso", true);
        decide_head_moved(&w.mailbox, &mut w.table, "iso");
        std::fs::write(w.repo.path().join(".git/HEAD"), "ref: refs/heads/other\n").unwrap();
        assert!(decide_head_moved(&w.mailbox, &mut w.table, "iso").is_none());
    }

    #[test]
    fn start_branch_and_head_are_recorded_at_registration() {
        let w = World::new();
        std::fs::write(
            w.repo.path().join(".git/refs/heads/main"),
            "3333333333333333333333333333333333333333\n",
        )
        .unwrap();
        w.join("a", "Alpha", false);
        let rec = w.mailbox.session("a").unwrap();
        assert_eq!(rec.shared.start_branch.as_deref(), Some("main"));
        assert_eq!(rec.shared.start_head.as_deref(), Some("3333333333333333333333333333333333333333"));
        assert!(rec.shared.git);
        assert_eq!(rec.shared.registered_epoch.as_deref(), Some(crate::session_mailbox::process_epoch()));
    }

    #[test]
    fn the_same_session_registering_again_is_not_another() {
        let w = World::new();
        w.join("a", "Alpha", false);
        w.join("a", "Alpha renamed", false);
        let t = ClaimTable::new();
        assert!(view::view_for(&w.mailbox, &t, "a", w.now()).unwrap().others.is_empty());
    }
}
