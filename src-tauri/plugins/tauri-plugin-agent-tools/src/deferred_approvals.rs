//! Approvals answered later.
//!
//! A run that reaches a permission prompt nobody can answer right now does not
//! have to guess. It records the question here -- which tool, which exact
//! arguments (by digest, the same one the live prompt is bound to), in which
//! project and session -- tells the model to stop and wait, and ends. Someone
//! answers later (`flint approvals allow|deny <id>`, or the desktop's settings
//! card); the session is then resumed and the model proposes the call again.
//! The gate asks this store first ([`redeem`]): an answer for exactly that
//! call is applied once, and consumed.
//!
//! The one rule the module exists to keep: **nothing here ever approves by
//! default.** A request that was never answered stays pending and the call
//! stays refused; one that is answered after it expired is refused and marked
//! expired; one voided by a checkpoint restore is gone; an answer is matched on
//! project, session, tool *and* argument digest, so it cannot be spent on a
//! different call; and it is spent once.
//!
//! Also here: the record that a session's workspace was restored to a
//! checkpoint ([`record_restore`]), which voids that session's unspent answers
//! and lets the loop tell the model its earlier approvals no longer stand.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::scoped_rules::project_key;

/// How long a question stays answerable unless the project says otherwise.
pub const DEFAULT_TTL_SECS: u64 = 24 * 60 * 60;
/// The longest a question may stay answerable.
pub const MAX_TTL_SECS: u64 = 7 * 24 * 60 * 60;
/// Settled records are kept this long for the listing, then dropped.
const KEEP_SETTLED_SECS: u64 = 7 * 24 * 60 * 60;
const MAX_RECORDS: usize = 200;
const SUMMARY_CHARS: usize = 300;
/// The most of a call's content (a diff, the arguments) kept for the listing.
const DETAIL_CHARS: usize = 4000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeferStatus {
    /// Waiting for a person.
    Pending,
    /// Allowed, not yet spent by the resumed run.
    Allowed,
    /// Denied, not yet told to the resumed run.
    Denied,
    /// Not answered (or not spent) in time.
    Expired,
    /// Allowed, but the file it was about changed before the answer was spent.
    Stale,
    /// A checkpoint restore made the question moot.
    Void,
    /// Spent: the resumed run has seen the answer.
    Consumed,
}

impl DeferStatus {
    fn is_open(self) -> bool {
        matches!(self, Self::Pending | Self::Allowed | Self::Denied)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deferred {
    pub id: String,
    /// [`project_key`] of the project folder.
    pub project: String,
    /// The session to resume; empty for a run that had none.
    pub session: String,
    pub tool: String,
    /// The prompt kind (`write`, `exec`, ...), for the listing.
    pub kind: String,
    /// What the person is being asked, in a line: the command, the path.
    pub summary: String,
    /// `approval_digest(tool, args)` of the call that was asked about.
    pub args_digest: String,
    /// What the call would do in full: the diff of a write or edit, otherwise
    /// its arguments. Bounded and redacted; the digest binds the real thing.
    #[serde(default)]
    pub detail: String,
    /// The file the call changes and its stamp when the question was asked.
    /// An allow is only spent while the file is still that file.
    #[serde(default)]
    pub base: Option<FileBase>,
    pub status: DeferStatus,
    pub created_at: u64,
    pub expires_at: u64,
    pub answered_at: Option<u64>,
}

/// A target file and its stamp ([`file_stamp`]) at defer time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBase {
    pub path: String,
    pub stamp: String,
}

/// The stamp of `path` as it is now: content hash, or `absent`.
pub fn file_stamp(path: &Path) -> String {
    crate::patch::BaseStamp::of(std::fs::read(path).ok().as_deref()).hex()
}

/// The question to record.
pub struct NewDeferred<'a> {
    pub project_root: &'a Path,
    pub session: &'a str,
    pub tool: &'a str,
    pub kind: &'a str,
    pub summary: &'a str,
    pub args_digest: &'a str,
    /// The call's content for the person deciding (see [`Deferred::detail`]).
    pub detail: &'a str,
    /// The file the call changes, stamped now.
    pub base_file: Option<&'a Path>,
}

/// What the gate finds when it asks whether this call was answered earlier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Redeem {
    /// Never deferred.
    None,
    /// Asked, no answer yet: the call stays unrun.
    Pending(Deferred),
    /// Allowed; the answer is spent by this call.
    Allowed(Deferred),
    /// Denied; the answer is spent by this call.
    Denied(Deferred),
    /// The answer (or the wait) ran out; refused, and spent.
    Expired(Deferred),
    /// Allowed, but the target file changed since the question was asked;
    /// refused, and spent, so the run proposes the change afresh.
    Stale(Deferred),
}

static LOCK: Mutex<()> = Mutex::new(());

/// The process-local mutex plus the cross-process file lock, so the CLI and
/// the desktop cannot both spend the same approval.
struct Guard {
    _held: crate::mailbox::Held,
    _local: std::sync::MutexGuard<'static, ()>,
}

fn lock(data_folder: &Path) -> Result<Guard, String> {
    let local = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let held = crate::mailbox::Held::take(&store_file(data_folder))?;
    Ok(Guard { _held: held, _local: local })
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    #[serde(default)]
    items: Vec<Deferred>,
}

pub fn store_file(data_folder: &Path) -> PathBuf {
    data_folder.join("approvals").join("deferred.json")
}

fn restores_file(data_folder: &Path) -> PathBuf {
    data_folder.join("approvals").join("restores.json")
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read(data_folder: &Path) -> Result<Vec<Deferred>, String> {
    match std::fs::read_to_string(store_file(data_folder)) {
        Ok(raw) => serde_json::from_str::<File>(&raw)
            .map(|f| f.items)
            .map_err(|e| format!("the deferred approvals file is unreadable: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("the deferred approvals file cannot be read: {e}")),
    }
}

fn write(data_folder: &Path, mut items: Vec<Deferred>, now: u64) -> Result<(), String> {
    items.retain(|d| d.status.is_open() || now.saturating_sub(d.created_at) < KEEP_SETTLED_SECS);
    if items.len() > MAX_RECORDS {
        // Oldest settled first; an open question is never the one dropped.
        items.sort_by_key(|d| (d.status.is_open(), d.created_at));
        let excess = items.len() - MAX_RECORDS;
        items.drain(..excess);
    }
    let json = serde_json::to_vec_pretty(&File { items }).map_err(|e| e.to_string())?;
    crate::atomic_file::write_atomic(&store_file(data_folder), &json)
}

/// Mark what has run out of time. A question not answered by its deadline, and
/// an answer not spent by it, are both over.
fn expire(items: &mut [Deferred], now: u64) {
    for d in items.iter_mut() {
        if d.status.is_open() && now >= d.expires_at {
            d.status = DeferStatus::Expired;
        }
    }
}

fn clip(text: &str) -> String {
    let one_line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= SUMMARY_CHARS {
        one_line
    } else {
        let cut: String = one_line.chars().take(SUMMARY_CHARS).collect();
        format!("{cut}...")
    }
}

/// The detail as kept: secrets redacted, at most [`DETAIL_CHARS`].
fn bound_detail(text: &str) -> String {
    let redacted = crate::secrets::redact_secrets(text);
    if redacted.chars().count() <= DETAIL_CHARS {
        redacted
    } else {
        let cut: String = redacted.chars().take(DETAIL_CHARS).collect();
        format!("{cut}\n... (cut)")
    }
}

fn clamp_ttl(ttl_secs: u64) -> u64 {
    if ttl_secs == 0 {
        DEFAULT_TTL_SECS
    } else {
        ttl_secs.min(MAX_TTL_SECS)
    }
}

/// Record a question, or return the one already recorded for the same call:
/// a model that asks twice must not leave two.
pub fn defer(data_folder: &Path, new: NewDeferred<'_>, ttl_secs: u64) -> Result<Deferred, String> {
    defer_at(data_folder, new, ttl_secs, now_secs())
}

pub fn defer_at(
    data_folder: &Path,
    new: NewDeferred<'_>,
    ttl_secs: u64,
    now: u64,
) -> Result<Deferred, String> {
    let _guard = lock(data_folder)?;
    let mut items = read(data_folder)?;
    expire(&mut items, now);
    let project = project_key(new.project_root);
    if let Some(same) = items.iter().find(|d| {
        d.status.is_open()
            && d.project == project
            && d.session == new.session
            && d.tool == new.tool
            && d.args_digest == new.args_digest
    }) {
        return Ok(same.clone());
    }
    let record = Deferred {
        id: format!("defer-{:x}-{:x}", now, rand::random::<u32>()),
        project,
        session: new.session.to_string(),
        tool: new.tool.to_string(),
        kind: new.kind.to_string(),
        summary: clip(new.summary),
        args_digest: new.args_digest.to_string(),
        detail: bound_detail(new.detail),
        base: new.base_file.map(|p| FileBase {
            path: p.to_string_lossy().into_owned(),
            stamp: file_stamp(p),
        }),
        status: DeferStatus::Pending,
        created_at: now,
        expires_at: now.saturating_add(clamp_ttl(ttl_secs)),
        answered_at: None,
    };
    items.push(record.clone());
    write(data_folder, items, now)?;
    Ok(record)
}

/// The questions on file, as they stand now (an expired one lists as expired).
/// `include_settled` adds the ones already answered, spent, voided or expired.
pub fn list(data_folder: &Path, project: Option<&Path>, include_settled: bool) -> Vec<Deferred> {
    list_at(data_folder, project, include_settled, now_secs())
}

pub fn list_at(
    data_folder: &Path,
    project: Option<&Path>,
    include_settled: bool,
    now: u64,
) -> Vec<Deferred> {
    let Ok(_guard) = lock(data_folder) else {
        return Vec::new();
    };
    let key = project.map(project_key);
    let mut items = read(data_folder).unwrap_or_default();
    expire(&mut items, now);
    items
        .into_iter()
        .filter(|d| key.as_ref().is_none_or(|k| &d.project == k))
        .filter(|d| include_settled || matches!(d.status, DeferStatus::Pending | DeferStatus::Allowed | DeferStatus::Denied))
        .collect()
}

/// Answer a pending question. Refused -- never granted -- when it is not
/// pending any more: already answered, expired (the record is marked so), voided
/// or spent.
pub fn answer(data_folder: &Path, id: &str, allow: bool) -> Result<Deferred, String> {
    answer_at(data_folder, id, allow, now_secs())
}

pub fn answer_at(data_folder: &Path, id: &str, allow: bool, now: u64) -> Result<Deferred, String> {
    let _guard = lock(data_folder)?;
    let mut items = read(data_folder)?;
    expire(&mut items, now);
    let Some(entry) = items.iter_mut().find(|d| d.id == id) else {
        return Err(format!("no deferred approval {id}"));
    };
    let outcome = match entry.status {
        DeferStatus::Pending => {
            entry.status = if allow { DeferStatus::Allowed } else { DeferStatus::Denied };
            entry.answered_at = Some(now);
            Ok(entry.clone())
        }
        DeferStatus::Expired => Err(format!("{id} expired before it was answered; the run must ask again")),
        DeferStatus::Void => Err(format!("{id} was voided by a checkpoint restore; the run must ask again")),
        DeferStatus::Allowed | DeferStatus::Denied => Err(format!("{id} was already answered")),
        DeferStatus::Consumed => Err(format!("{id} was already applied")),
        DeferStatus::Stale => Err(format!("{id} is about a file that changed since; the run must ask again")),
    };
    // The expiry sweep is saved either way, so a refused late answer leaves the
    // record saying why.
    write(data_folder, items, now)?;
    outcome
}

/// Drop a record from the listing.
pub fn discard(data_folder: &Path, id: &str) -> Result<bool, String> {
    let _guard = lock(data_folder)?;
    let mut items = read(data_folder)?;
    let before = items.len();
    items.retain(|d| d.id != id);
    if items.len() == before {
        return Ok(false);
    }
    write(data_folder, items, now_secs())?;
    Ok(true)
}

/// Ask the store about a call the model is proposing now.
pub fn redeem(
    data_folder: &Path,
    project_root: &Path,
    session: &str,
    tool: &str,
    args_digest: &str,
) -> Redeem {
    redeem_at(data_folder, project_root, session, tool, args_digest, now_secs())
}

pub fn redeem_at(
    data_folder: &Path,
    project_root: &Path,
    session: &str,
    tool: &str,
    args_digest: &str,
    now: u64,
) -> Redeem {
    let Ok(_guard) = lock(data_folder) else {
        return Redeem::None;
    };
    // Unreadable store: nothing is found, so the call is asked about afresh.
    let Ok(mut items) = read(data_folder) else {
        return Redeem::None;
    };
    expire(&mut items, now);
    let project = project_key(project_root);
    let Some(entry) = items
        .iter_mut()
        .filter(|d| {
            d.project == project
                && d.session == session
                && d.tool == tool
                && d.args_digest == args_digest
                && matches!(
                    d.status,
                    DeferStatus::Pending | DeferStatus::Allowed | DeferStatus::Denied | DeferStatus::Expired
                )
        })
        .max_by_key(|d| d.created_at)
    else {
        return Redeem::None;
    };
    let seen = entry.clone();
    let result = match entry.status {
        DeferStatus::Pending => return Redeem::Pending(seen),
        DeferStatus::Allowed => {
            // The answer was about the file as it was when asked: a file that
            // moved on since would be overwritten unreviewed.
            let moved = seen
                .base
                .as_ref()
                .is_some_and(|b| file_stamp(Path::new(&b.path)) != b.stamp);
            if moved {
                entry.status = DeferStatus::Stale;
                Redeem::Stale(seen)
            } else {
                entry.status = DeferStatus::Consumed;
                Redeem::Allowed(seen)
            }
        }
        DeferStatus::Denied => {
            entry.status = DeferStatus::Consumed;
            Redeem::Denied(seen)
        }
        _ => {
            entry.status = DeferStatus::Consumed;
            Redeem::Expired(seen)
        }
    };
    // If the spend cannot be saved the answer must not be used: an allowance
    // that might be spent twice is not one.
    if write(data_folder, items, now).is_err() {
        return Redeem::None;
    }
    result
}

/// Void every unspent question of a session. Returns how many.
pub fn void_session(data_folder: &Path, session: &str) -> usize {
    void_session_at(data_folder, session, now_secs())
}

pub fn void_session_at(data_folder: &Path, session: &str, now: u64) -> usize {
    let Ok(_guard) = lock(data_folder) else {
        return 0;
    };
    let Ok(mut items) = read(data_folder) else {
        return 0;
    };
    let mut voided = 0;
    for d in items.iter_mut().filter(|d| d.session == session && d.status.is_open()) {
        d.status = DeferStatus::Void;
        voided += 1;
    }
    if voided > 0 {
        let _ = write(data_folder, items, now);
    }
    voided
}

// -- restores -----------------------------------------------------------------

#[derive(Debug, Default, Serialize, Deserialize)]
struct Restores {
    #[serde(default)]
    sessions: BTreeMap<String, u64>,
}

/// A session's workspace was rolled back to a checkpoint: its unspent deferred
/// answers are void, and the next run of it is told so.
pub fn record_restore(data_folder: &Path, session: &str) -> Result<(), String> {
    if session.is_empty() {
        return Ok(());
    }
    void_session(data_folder, session);
    let _guard = lock(data_folder)?;
    let path = restores_file(data_folder);
    let mut file: Restores = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    file.sessions.insert(session.to_string(), now_secs());
    // A bounded file: sessions that never run again must not pile up.
    while file.sessions.len() > 200 {
        let oldest = file.sessions.iter().min_by_key(|(_, at)| **at).map(|(k, _)| k.clone());
        match oldest {
            Some(k) => file.sessions.remove(&k),
            None => break,
        };
    }
    let json = serde_json::to_vec(&file).map_err(|e| e.to_string())?;
    crate::atomic_file::write_atomic(&path, &json)
}

/// Whether the session was restored since its last run, taking the marker so
/// the model is told once.
pub fn take_restore(data_folder: &Path, session: &str) -> Option<u64> {
    if session.is_empty() {
        return None;
    }
    let _guard = lock(data_folder).ok()?;
    let path = restores_file(data_folder);
    let mut file: Restores = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
    let at = file.sessions.remove(session)?;
    let json = serde_json::to_vec(&file).ok()?;
    crate::atomic_file::write_atomic(&path, &json).ok()?;
    Some(at)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fx {
        _tmp: tempfile::TempDir,
        data: PathBuf,
        project: PathBuf,
    }

    fn fx() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let project = tmp.path().join("proj");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        Fx { _tmp: tmp, data, project }
    }

    fn ask<'a>(f: &'a Fx, session: &'a str, digest: &'a str) -> NewDeferred<'a> {
        NewDeferred {
            project_root: &f.project,
            session,
            tool: "bash",
            kind: "exec",
            summary: "make deploy",
            args_digest: digest,
            detail: "",
            base_file: None,
        }
    }

    const T0: u64 = 1_000_000;
    const TTL: u64 = 3600;

    #[test]
    fn an_unanswered_question_stays_unanswered_and_the_call_stays_refused() {
        let f = fx();
        let d = defer_at(&f.data, ask(&f, "s1", "d1"), TTL, T0).unwrap();
        assert_eq!(d.status, DeferStatus::Pending);
        match redeem_at(&f.data, &f.project, "s1", "bash", "d1", T0 + 10) {
            Redeem::Pending(p) => assert_eq!(p.id, d.id),
            other => panic!("{other:?}"),
        }
        // Asking again does not answer it, and does not create a second record.
        assert!(matches!(redeem_at(&f.data, &f.project, "s1", "bash", "d1", T0 + 20), Redeem::Pending(_)));
        assert_eq!(list_at(&f.data, None, true, T0 + 20).len(), 1);
    }

    #[test]
    fn asking_twice_for_the_same_call_leaves_one_record() {
        let f = fx();
        let a = defer_at(&f.data, ask(&f, "s1", "d1"), TTL, T0).unwrap();
        let b = defer_at(&f.data, ask(&f, "s1", "d1"), TTL, T0 + 5).unwrap();
        assert_eq!(a.id, b.id);
        let other = defer_at(&f.data, ask(&f, "s1", "d2"), TTL, T0 + 5).unwrap();
        assert_ne!(a.id, other.id);
    }

    #[test]
    fn an_allow_is_applied_once_to_exactly_that_call() {
        let f = fx();
        let d = defer_at(&f.data, ask(&f, "s1", "d1"), TTL, T0).unwrap();
        answer_at(&f.data, &d.id, true, T0 + 60).unwrap();
        // A different digest (changed arguments), tool, session or project is not covered.
        assert_eq!(redeem_at(&f.data, &f.project, "s1", "bash", "other", T0 + 61), Redeem::None);
        assert_eq!(redeem_at(&f.data, &f.project, "s1", "write", "d1", T0 + 61), Redeem::None);
        assert_eq!(redeem_at(&f.data, &f.project, "s2", "bash", "d1", T0 + 61), Redeem::None);
        let elsewhere = f.project.parent().unwrap().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        assert_eq!(redeem_at(&f.data, &elsewhere, "s1", "bash", "d1", T0 + 61), Redeem::None);
        // The right call spends it ...
        assert!(matches!(redeem_at(&f.data, &f.project, "s1", "bash", "d1", T0 + 62), Redeem::Allowed(_)));
        // ... once.
        assert_eq!(redeem_at(&f.data, &f.project, "s1", "bash", "d1", T0 + 63), Redeem::None);
    }

    #[test]
    fn a_denial_is_applied_once_and_then_the_call_may_be_asked_again() {
        let f = fx();
        let d = defer_at(&f.data, ask(&f, "s1", "d1"), TTL, T0).unwrap();
        answer_at(&f.data, &d.id, false, T0 + 60).unwrap();
        assert!(matches!(redeem_at(&f.data, &f.project, "s1", "bash", "d1", T0 + 61), Redeem::Denied(_)));
        assert_eq!(redeem_at(&f.data, &f.project, "s1", "bash", "d1", T0 + 62), Redeem::None);
    }

    #[test]
    fn a_late_answer_is_refused_and_the_record_says_expired() {
        let f = fx();
        let d = defer_at(&f.data, ask(&f, "s1", "d1"), TTL, T0).unwrap();
        let err = answer_at(&f.data, &d.id, true, T0 + TTL).unwrap_err();
        assert!(err.contains("expired"), "{err}");
        let listed = list_at(&f.data, None, true, T0 + TTL + 1);
        assert_eq!(listed[0].status, DeferStatus::Expired);
        // The resumed run is told it expired, once, and nothing runs.
        assert!(matches!(redeem_at(&f.data, &f.project, "s1", "bash", "d1", T0 + TTL + 2), Redeem::Expired(_)));
        assert_eq!(redeem_at(&f.data, &f.project, "s1", "bash", "d1", T0 + TTL + 3), Redeem::None);
    }

    #[test]
    fn an_allow_that_is_not_spent_in_time_expires_instead_of_running() {
        let f = fx();
        let d = defer_at(&f.data, ask(&f, "s1", "d1"), TTL, T0).unwrap();
        answer_at(&f.data, &d.id, true, T0 + 10).unwrap();
        match redeem_at(&f.data, &f.project, "s1", "bash", "d1", T0 + TTL + 1) {
            Redeem::Expired(_) => {}
            other => panic!("an expired allow must not run: {other:?}"),
        }
    }

    #[test]
    fn the_deadline_is_exact_and_a_zero_ttl_is_the_default_never_forever() {
        let f = fx();
        let d = defer_at(&f.data, ask(&f, "s1", "d1"), TTL, T0).unwrap();
        assert_eq!(d.expires_at, T0 + TTL);
        assert!(answer_at(&f.data, &d.id, true, T0 + TTL - 1).is_ok());
        let zero = defer_at(&f.data, ask(&f, "s2", "d1"), 0, T0).unwrap();
        assert_eq!(zero.expires_at, T0 + DEFAULT_TTL_SECS);
        let huge = defer_at(&f.data, ask(&f, "s3", "d1"), u64::MAX, T0).unwrap();
        assert_eq!(huge.expires_at, T0 + MAX_TTL_SECS);
    }

    #[test]
    fn a_question_is_answered_at_most_once() {
        let f = fx();
        let d = defer_at(&f.data, ask(&f, "s1", "d1"), TTL, T0).unwrap();
        answer_at(&f.data, &d.id, false, T0 + 1).unwrap();
        assert!(answer_at(&f.data, &d.id, true, T0 + 2).unwrap_err().contains("already answered"));
        assert!(answer_at(&f.data, "defer-nope", true, T0 + 2).is_err());
    }

    #[test]
    fn a_restore_voids_unspent_questions_and_answers() {
        let f = fx();
        let pending = defer_at(&f.data, ask(&f, "s1", "d1"), TTL, T0).unwrap();
        let allowed = defer_at(&f.data, ask(&f, "s1", "d2"), TTL, T0).unwrap();
        answer_at(&f.data, &allowed.id, true, T0 + 1).unwrap();
        let other_session = defer_at(&f.data, ask(&f, "s2", "d1"), TTL, T0).unwrap();
        assert_eq!(void_session_at(&f.data, "s1", T0 + 1), 2);
        assert_eq!(redeem_at(&f.data, &f.project, "s1", "bash", "d2", T0 + 2), Redeem::None, "an allow given before the restore is gone");
        assert!(answer_at(&f.data, &pending.id, true, T0 + 2).unwrap_err().contains("restore"));
        assert!(matches!(redeem_at(&f.data, &f.project, "s2", "bash", "d1", T0 + 2), Redeem::Pending(p) if p.id == other_session.id));
    }

    #[test]
    fn restore_markers_are_per_session_and_taken_once() {
        let f = fx();
        record_restore(&f.data, "s1").unwrap();
        assert_eq!(take_restore(&f.data, "s2"), None);
        assert!(take_restore(&f.data, "s1").is_some());
        assert_eq!(take_restore(&f.data, "s1"), None, "told once");
        record_restore(&f.data, "").unwrap();
        assert_eq!(take_restore(&f.data, ""), None);
    }

    #[test]
    fn an_unreadable_store_approves_nothing() {
        let f = fx();
        let d = defer_at(&f.data, ask(&f, "s1", "d1"), TTL, T0).unwrap();
        answer_at(&f.data, &d.id, true, T0 + 1).unwrap();
        std::fs::write(store_file(&f.data), "{ broken").unwrap();
        assert_eq!(redeem_at(&f.data, &f.project, "s1", "bash", "d1", T0 + 2), Redeem::None);
        assert!(defer_at(&f.data, ask(&f, "s1", "d1"), TTL, T0 + 2).is_err());
        assert!(list_at(&f.data, None, true, T0 + 2).is_empty());
        assert_eq!(std::fs::read_to_string(store_file(&f.data)).unwrap(), "{ broken");
    }

    #[test]
    fn the_summary_is_one_short_line() {
        let f = fx();
        let long = format!("line one\nline two {}", "x".repeat(1000));
        let d = defer_at(
            &f.data,
            NewDeferred { summary: &long, ..ask(&f, "s1", "d1") },
            TTL,
            T0,
        )
        .unwrap();
        assert!(!d.summary.contains('\n'));
        assert!(d.summary.chars().count() <= SUMMARY_CHARS + 3);
    }

    #[test]
    fn the_listing_carries_the_content_bounded_and_redacted() {
        let f = fx();
        let body = format!("+ token = \"ghp_{}\"\n{}", "a".repeat(36), "+x\n".repeat(5000));
        let d = defer_at(
            &f.data,
            NewDeferred { tool: "write", detail: &body, ..ask(&f, "s1", "d1") },
            TTL,
            T0,
        )
        .unwrap();
        let listed = &list_at(&f.data, None, false, T0 + 1)[0];
        assert_eq!(listed.detail, d.detail);
        assert!(listed.detail.starts_with("+ token"));
        assert!(!listed.detail.contains(&"a".repeat(36)), "{}", &listed.detail[..80]);
        assert!(listed.detail.chars().count() <= DETAIL_CHARS + 20);
        assert!(listed.detail.ends_with("(cut)"));
    }

    #[test]
    fn an_allow_for_a_file_that_changed_since_is_refused_not_applied() {
        let f = fx();
        let file = f.project.join("a.txt");
        std::fs::write(&file, "one").unwrap();
        let d = defer_at(
            &f.data,
            NewDeferred { tool: "write", base_file: Some(&file), ..ask(&f, "s1", "d1") },
            TTL,
            T0,
        )
        .unwrap();
        answer_at(&f.data, &d.id, true, T0 + 1).unwrap();
        std::fs::write(&file, "two").unwrap();
        assert!(matches!(redeem_at(&f.data, &f.project, "s1", "write", "d1", T0 + 2), Redeem::Stale(_)));
        // Spent: the re-proposed call is asked about afresh.
        assert_eq!(redeem_at(&f.data, &f.project, "s1", "write", "d1", T0 + 3), Redeem::None);
        assert_eq!(list_at(&f.data, None, true, T0 + 3)[0].status, DeferStatus::Stale);

        // Unchanged (or still absent) file: the allow is spent as usual.
        let fresh = f.project.join("b.txt");
        let d = defer_at(
            &f.data,
            NewDeferred { tool: "write", base_file: Some(&fresh), ..ask(&f, "s1", "d2") },
            TTL,
            T0,
        )
        .unwrap();
        answer_at(&f.data, &d.id, true, T0 + 1).unwrap();
        assert!(matches!(redeem_at(&f.data, &f.project, "s1", "write", "d2", T0 + 2), Redeem::Allowed(_)));
    }

    #[test]
    fn settled_records_are_pruned_but_open_ones_never() {
        let f = fx();
        let old = defer_at(&f.data, ask(&f, "s1", "d1"), TTL, T0).unwrap();
        answer_at(&f.data, &old.id, false, T0 + 1).unwrap();
        redeem_at(&f.data, &f.project, "s1", "bash", "d1", T0 + 2);
        let open = defer_at(&f.data, ask(&f, "s1", "d2"), MAX_TTL_SECS, T0 + KEEP_SETTLED_SECS + 10).unwrap();
        let all = list_at(&f.data, None, true, T0 + KEEP_SETTLED_SECS + 11);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, open.id);
    }

    #[test]
    fn deferred_two_handles_no_lost_update() {
        let f = fx();
        // Another process holds the store: a writer waits, then both survive.
        let held = crate::mailbox::Held::take(&store_file(&f.data)).unwrap();
        let data = f.data.clone();
        let project = f.project.clone();
        let writer = std::thread::spawn(move || {
            let n = NewDeferred {
                project_root: &project,
                session: "s-a",
                tool: "bash",
                kind: "exec",
                summary: "a",
                args_digest: "digest-a",
                detail: "a",
                base_file: None,
            };
            defer_at(&data, n, 600, 1_000).unwrap()
        });
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!writer.is_finished(), "the writer ignored the held lock");
        drop(held);
        writer.join().unwrap();
        defer_at(&f.data, ask(&f, "s-b", "digest-b"), 600, 1_000).unwrap();
        assert_eq!(list_at(&f.data, None, true, 1_000).len(), 2);
    }
}
