//! How long request records are kept, and removing them with their chat.
//!
//! `audit/prompts.jsonl` holds the redacted payload of every model dispatch and
//! `audit/payload-usage.jsonl` the provider's count for each. Both only ever
//! grew: a long-lived install kept every system prompt, every inline file and
//! every tool result it had ever sent, and deleting a conversation left its
//! requests behind. Two rules fix that:
//!
//! * **Bounded.** Compaction keeps the newest records within an age, a count and
//!   a byte budget, whichever is tightest. It runs at startup, so a folder that
//!   was over budget when the app closed is back under it before the first
//!   request of the next session.
//! * **Deleted with the conversation.** Removing a thread removes every snapshot
//!   and usage line whose `session` is that thread, so "delete this chat" does
//!   not quietly keep a copy of what it sent.
//!
//! Both logs are rewritten through a temp file under [`LOG_LOCK`], the same lock
//! every append takes, so a dispatch recorded while a compaction runs is not
//! lost between the read and the rename.

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;

use crate::{snapshot, usage};

/// Held by every append to, and every rewrite of, the request logs.
pub static LOG_LOCK: Mutex<()> = Mutex::new(());

/// Take the log lock, recovering from a poisoned one: a panic in another writer
/// must not stop requests being recorded for the rest of the session.
pub(crate) fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOG_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// [`LOG_LOCK`] plus a lock file in the data folder, so the desktop app and
/// the CLI writing the same logs do not lose each other's lines between a
/// compaction's read and its rename. The file lock is best effort: a folder
/// it cannot be taken in still gets the in-process lock, and the record.
pub(crate) struct LogGuard {
    _file: Option<crate::mailbox::Held>,
    _mutex: std::sync::MutexGuard<'static, ()>,
}

pub(crate) fn lock_for(data_folder: &Path) -> LogGuard {
    let mutex = lock();
    let file = crate::mailbox::Held::take(&data_folder.join("request-logs")).ok();
    LogGuard { _file: file, _mutex: mutex }
}

/// Open a JSONL log for appending, starting on a fresh line: when a crash left
/// the last record without its newline, one is written first, so the next
/// record is not glued onto the torn one and lost with it.
pub(crate) fn open_for_append(path: &Path) -> std::io::Result<std::fs::File> {
    use std::io::{Read, Seek, SeekFrom, Write};
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(path)?;
    if file.metadata()?.len() > 0 {
        let mut last = [0u8; 1];
        file.seek(SeekFrom::End(-1))?;
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            file.write_all(b"\n")?;
        }
    }
    Ok(file)
}

/// The lines of a JSO\n log, lossily decoded. A line with invalid UTF-8 (a torn
/// write, a bad byte from a crash) comes back with replacement characters and
/// simply fails to parse, instead of ending the iteration and hiding every
/// record after it. A read error still ends it.
pub(crate) fn lossy_lines(file: std::fs::File) -> impl Iterator<Item = String> {
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(file);
    let mut buf = Vec::new();
    std::iter::from_fn(move || {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(
                String::from_utf8_lossy(&buf)
                    .trim_end_matches(['\n', '\r'])
                    .to_string(),
            ),
        }
    })
}

/// What a request log may hold. The tightest limit wins.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Retention {
    /// Records older than this are dropped. Seconds.
    pub max_age_secs: i64,
    /// At most this many records are kept, newest first.
    pub max_entries: usize,
    /// At most this many bytes of serialized records are kept, newest first.
    pub max_bytes: u64,
}

/// The policy applied at startup.
///
/// Thirty days is long enough to answer "why did it say that" about last
/// week's conversation; the count and byte caps stop one very busy day of
/// large payloads from filling the data folder regardless of age.
pub const DEFAULT_RETENTION: Retention = Retention {
    max_age_secs: 30 * 24 * 60 * 60,
    max_entries: 5_000,
    max_bytes: 64 * 1024 * 1024,
};

/// What a compaction or a deletion removed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    pub snapshots: usize,
    pub usage: usize,
    /// Sessions whose stored tool-call diffs were removed (Jozkah/jan#234).
    pub diff_sessions: usize,
    /// Permission decisions removed from `audit/permissions.jsonl`.
    pub permissions: usize,
    /// Settled change proposals removed, with their unreferenced blobs.
    pub proposals: usize,
}

/// The folder holding one session's stored diffs.
fn diff_dir(data_folder: &Path, session: &str) -> Option<std::path::PathBuf> {
    crate::activity::diff_path(data_folder, session, "_").parent().map(Path::to_path_buf)
}

/// Keep the permission-log lines `keep` accepts, by their parsed JSON. A line
/// that does not parse is kept: deleting on a guess is worse than keeping.
/// Rewritten only when something was dropped. Caller holds the log lock.
fn filter_permissions(data_folder: &Path, keep: impl Fn(&serde_json::Value) -> bool) -> Result<usize, String> {
    let path = crate::audit::log_path(data_folder);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(0);
    };
    let mut out = String::with_capacity(text.len());
    let mut dropped = 0;
    for line in text.lines() {
        let drop = serde_json::from_str::<serde_json::Value>(line)
            .map(|v| !keep(&v))
            .unwrap_or(false);
        if drop {
            dropped += 1;
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    if dropped > 0 {
        crate::workspace::write_atomic(&path, out.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(dropped)
}

/// Parse the `YYYY-MM-DDTHH:MM:SSZ` form [`crate::audit::now`] writes.
///
/// Anything else is `None`, and a record whose age is unknown is kept by the
/// age rule (the count and byte caps still apply to it): dropping a record
/// because its timestamp could not be read would delete on a guess.
pub fn parse_rfc3339(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() != 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' || bytes[19] != b'Z' {
        return None;
    }
    let num = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hh, mm, ss) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // Days from civil, the inverse of `audit::format_rfc3339`.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

/// Keep the records the policy allows, oldest first as they were stored.
///
/// Walks newest to oldest so the count and byte caps always drop the oldest
/// records, never whichever happened to be read last.
pub(crate) fn retain<T: Serialize>(
    records: Vec<T>,
    at: impl Fn(&T) -> &str,
    policy: &Retention,
    now: i64,
) -> Vec<T> {
    let cutoff = now.saturating_sub(policy.max_age_secs);
    let mut kept: Vec<T> = Vec::new();
    let mut bytes: u64 = 0;
    for record in records.into_iter().rev() {
        if kept.len() >= policy.max_entries {
            break;
        }
        if let Some(when) = parse_rfc3339(at(&record)) {
            if when < cutoff {
                continue;
            }
        }
        let size = serde_json::to_string(&record)
            .map(|line| line.len() as u64 + 1)
            .unwrap_or(0);
        if bytes + size > policy.max_bytes {
            break;
        }
        bytes += size;
        kept.push(record);
    }
    kept.reverse();
    kept
}

/// The longest quota window (a month of thirty days). Usage records inside
/// it are what monthly quotas are counted from.
pub const LONGEST_QUOTA_WINDOW_SECS: i64 = 30 * 24 * 60 * 60;

/// Usage lines are small and feed the token and spend quotas, so only age
/// trims them: a count or byte cap would drop in-window records and a monthly
/// quota would undercount (report-09 MED-2).
fn usage_policy(policy: &Retention) -> Retention {
    Retention {
        max_age_secs: policy.max_age_secs.max(LONGEST_QUOTA_WINDOW_SECS),
        max_entries: usize::MAX,
        max_bytes: u64::MAX,
    }
}

/// Replace a JSONL log with `records`, atomically. An empty set removes the
/// file rather than leaving an empty one behind.
pub(crate) fn rewrite<T: Serialize>(path: &Path, records: &[T]) -> Result<(), String> {
    if records.is_empty() {
        return match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    let mut body = String::new();
    for record in records {
        body.push_str(&serde_json::to_string(record).map_err(|e| e.to_string())?);
        body.push('\n');
    }
    crate::atomic_file::write_atomic(path, body.as_bytes())
}

/// When anything inside `dir` last changed: the newest file's time, not the
/// folder's own (which a write to an existing file never moves).
fn newest_inside(dir: &Path) -> Option<i64> {
    fn walk(dir: &Path, depth: usize, newest: &mut Option<std::time::SystemTime>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                if depth < 8 {
                    walk(&entry.path(), depth + 1, newest);
                }
            } else if let Ok(t) = meta.modified() {
                if newest.is_none_or(|n| t > n) {
                    *newest = Some(t);
                }
            }
        }
    }
    let mut newest = std::fs::metadata(dir).and_then(|m| m.modified()).ok();
    walk(dir, 0, &mut newest);
    newest
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
}

/// Apply `policy` to both request logs.
pub fn compact(data_folder: &Path, policy: &Retention, now: i64) -> Result<Removed, String> {
    let _guard = lock_for(data_folder);
    let mut removed = Removed::default();

    if snapshot::log_path(data_folder).exists() {
        let all = snapshot::read_all(data_folder);
        let before = all.len();
        let kept = retain(all, |s| s.at.as_str(), policy, now);
        removed.snapshots = before - kept.len();
        rewrite_if_worthwhile(&snapshot::log_path(data_folder), &kept, removed.snapshots, LARGE_LOG_BYTES)?;
    }
    if usage::log_path(data_folder).exists() {
        let all = usage::read_all(data_folder);
        let before = all.len();
        let kept = retain(all, |u| u.at.as_str(), &usage_policy(policy), now);
        removed.usage = before - kept.len();
        rewrite_if_worthwhile(&usage::log_path(data_folder), &kept, removed.usage, LARGE_LOG_BYTES)?;
    }
    // The diff store and the permission log grew for the life of the install
    // (Jozkah/jan#234): both are held to the same age limit.
    let cutoff = now - policy.max_age_secs;
    removed.proposals = crate::proposal::prune_settled(data_folder, cutoff);
    removed.permissions = filter_permissions(data_folder, |v| {
        v.get("at")
            .and_then(|a| a.as_str())
            .and_then(parse_rfc3339)
            .is_none_or(|t| t >= cutoff)
    })?;
    if let Some(root) = diff_dir(data_folder, "_").and_then(|d| d.parent().map(Path::to_path_buf)) {
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let modified = newest_inside(&entry.path());
                if entry.path().is_dir() && modified.is_some_and(|m| m < cutoff)
                    && std::fs::remove_dir_all(entry.path()).is_ok() {
                        removed.diff_sessions += 1;
                    }
            }
        }
    }
    Ok(removed)
}

/// Remove every request record belonging to one conversation.
///
/// Matched on `session`, which is the thread id for a chat and the session id
/// for a Cowork run. An empty id matches nothing: a blank argument must not
/// become "delete every record that was filed without a session".
pub fn delete_session(data_folder: &Path, session: &str) -> Result<Removed, String> {
    let session = session.trim();
    if session.is_empty() {
        return Ok(Removed::default());
    }
    let _guard = lock_for(data_folder);
    let mut removed = Removed::default();

    if snapshot::log_path(data_folder).exists() {
        let all = snapshot::read_all(data_folder);
        let before = all.len();
        let kept: Vec<_> = all.into_iter().filter(|s| s.session != session).collect();
        removed.snapshots = before - kept.len();
        rewrite_if_changed(&snapshot::log_path(data_folder), &kept, removed.snapshots)?;
    }
    if usage::log_path(data_folder).exists() {
        let all = usage::read_all(data_folder);
        let before = all.len();
        let kept: Vec<_> = all.into_iter().filter(|u| u.session != session).collect();
        removed.usage = before - kept.len();
        rewrite_if_changed(&usage::log_path(data_folder), &kept, removed.usage)?;
    }
    // What the conversation's tool calls wrote and decided goes with it
    // (Jozkah/jan#234): its stored diffs and its permission decisions.
    // And its undo journal, with the file contents only it referred to
    // (Jozkah/jan#294).
    crate::undo::forget(data_folder, session);
    if let Some(dir) = diff_dir(data_folder, session).filter(|d| d.is_dir()) {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        removed.diff_sessions = 1;
    }
    removed.permissions =
        filter_permissions(data_folder, |v| v.get("session").and_then(|s| s.as_str()) != Some(session))?;
    Ok(removed)
}

/// Rewrite only when something was dropped, so a compaction that removes
/// nothing does not also discard lines that no longer parse -- that is for a
/// compaction that is already rewriting to decide, not for a no-op.
fn rewrite_if_changed<T: Serialize>(path: &Path, kept: &[T], removed: usize) -> Result<(), String> {
    if removed == 0 {
        return Ok(());
    }
    rewrite(path, kept)
}

/// A log at least this big is not rewritten by retention for a small gain.
const LARGE_LOG_BYTES: u64 = 1 << 20;

/// [`rewrite_if_changed`] for age/size retention, which runs on a schedule and
/// can afford to wait: rewriting a large log to drop a sliver of it costs a
/// full read and write for almost nothing. When the file is at least
/// `large_bytes` and dropping `removed` records would free under a tenth of
/// it, the rewrite is skipped; the records go on a later pass, once enough has
/// aged out. Not used for deleting a conversation, which must take effect now.
fn rewrite_if_worthwhile<T: Serialize>(
    path: &Path,
    kept: &[T],
    removed: usize,
    large_bytes: u64,
) -> Result<(), String> {
    if removed == 0 {
        return Ok(());
    }
    if let Ok(len) = std::fs::metadata(path).map(|m| m.len()) {
        if len >= large_bytes {
            let kept_bytes: u64 = kept
                .iter()
                .map(|r| serde_json::to_string(r).map(|l| l.len() as u64 + 1).unwrap_or(0))
                .sum();
            let freed = len.saturating_sub(kept_bytes);
            if freed.saturating_mul(10) < len {
                return Ok(());
            }
        }
    }
    rewrite(path, kept)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Compact with [`DEFAULT_RETENTION`] against the clock. For startup.
pub fn compact_default(data_folder: &Path) -> Result<Removed, String> {
    compact(data_folder, &DEFAULT_RETENTION, now_secs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::{capture, Identity};
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn an_append_after_a_torn_line_starts_on_its_own_line() {
        use std::io::Write;
        let path = dir("torn").join("log.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{\"a\":1}\n{\"b\":").unwrap();
        writeln!(open_for_append(&path).unwrap(), "{{\"c\":3}}").unwrap();
        writeln!(open_for_append(&path).unwrap(), "{{\"d\":4}}").unwrap();
        let lines: Vec<String> = lossy_lines(std::fs::File::open(&path).unwrap()).collect();
        assert_eq!(lines, ["{\"a\":1}", "{\"b\":", "{\"c\":3}", "{\"d\":4}"]);
    }

    fn dir(tag: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!(
            "jan-retention-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn snap(session: &str, at: &str) -> snapshot::PromptSnapshot {
        let mut s = capture(
            &json!({ "model": "m", "messages": [{ "role": "user", "content": session }] }),
            &Identity {
                session: session.into(),
                run: format!("run-{session}"),
                ..Default::default()
            },
        );
        s.at = at.into();
        s
    }

    /// Jozkah/jan#234: deleting a conversation removes its stored diffs and
    /// its permission decisions, and leaves every other conversation's.
    #[test]
    fn deleting_a_session_removes_its_diffs_and_decisions() {
        let d = dir("diffs");
        for session in ["gone", "kept"] {
            let p = crate::activity::diff_path(&d, session, "call_0");
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "+x\n").unwrap();
            crate::audit::append(
                &d,
                &crate::audit::PermissionRecord::new(
                    crate::audit::now(),
                    session,
                    "write",
                    "path",
                    &crate::resource::Resource::command("ls"),
                    crate::audit::Outcome::Allow,
                    "test",
                ),
            );
        }
        let removed = delete_session(&d, "gone").unwrap();
        assert_eq!((removed.diff_sessions, removed.permissions), (1, 1));
        // The cross-process log lock is released with its guard.
        assert!(!d.join("request-logs.lock").exists());
        assert!(!crate::activity::diff_path(&d, "gone", "call_0").exists());
        assert!(crate::activity::diff_path(&d, "kept", "call_0").exists());
        let log = std::fs::read_to_string(crate::audit::log_path(&d)).unwrap();
        assert!(!log.contains("\"gone\"") && log.contains("\"kept\""), "{log}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Jozkah/jan#287: deleting one session's snapshots while another's are
    /// being appended loses none of the appended ones.
    #[test]
    fn a_snapshot_rewrite_does_not_lose_concurrent_appends() {
        let d = dir("race");
        let now = crate::audit::now();
        let writer = {
            let (d, now) = (d.clone(), now.clone());
            std::thread::spawn(move || {
                for _ in 0..200 {
                    snapshot::append(&d, &snap("keep", &now));
                }
            })
        };
        for _ in 0..200 {
            snapshot::append(&d, &snap("gone", &now));
            let _ = snapshot::delete_session(&d, "gone");
        }
        writer.join().unwrap();
        let kept = snapshot::by_session(&d, "keep").len();
        assert_eq!(kept, 200, "appends lost to a concurrent rewrite");
        let _ = std::fs::remove_dir_all(&d);
    }

    fn use_line(session: &str, at: &str) -> usage::PayloadUsage {
        let mut u = usage::record(format!("inv-{session}-{at}"), usage::UsageSource::Provider);
        u.session = session.into();
        u.at = at.into();
        u
    }

    const DAY: i64 = 86_400;

    #[test]
    fn the_timestamp_format_round_trips() {
        for secs in [0u64, 86_399, 951_782_400, 1_780_000_000] {
            let text = crate::audit::format_rfc3339(secs);
            assert_eq!(parse_rfc3339(&text), Some(secs as i64), "{text}");
        }
        assert_eq!(parse_rfc3339("yesterday"), None);
        assert_eq!(parse_rfc3339("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn records_older_than_the_age_limit_are_dropped() {
        let d = dir("age");
        let now = 1_780_000_000;
        let old = crate::audit::format_rfc3339((now - 40 * DAY) as u64);
        let fresh = crate::audit::format_rfc3339((now - DAY) as u64);
        snapshot::append(&d, &snap("s-old", &old));
        snapshot::append(&d, &snap("s-new", &fresh));
        usage::append(&d, &use_line("s-old", &old));
        usage::append(&d, &use_line("s-new", &fresh));

        let removed = compact(&d, &DEFAULT_RETENTION, now).unwrap();
        assert_eq!(removed, Removed { snapshots: 1, usage: 1, ..Removed::default() });
        let left = snapshot::read_all(&d);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].session, "s-new");
        assert_eq!(usage::read_all(&d)[0].session, "s-new");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_count_cap_keeps_the_newest() {
        let d = dir("count");
        let now = 1_780_000_000;
        for i in 0..5 {
            let at = crate::audit::format_rfc3339((now - 10 + i) as u64);
            snapshot::append(&d, &snap(&format!("s{i}"), &at));
        }
        let policy = Retention {
            max_entries: 2,
            ..DEFAULT_RETENTION
        };
        let removed = compact(&d, &policy, now).unwrap();
        assert_eq!(removed.snapshots, 3);
        let sessions: Vec<_> = snapshot::read_all(&d).into_iter().map(|s| s.session).collect();
        assert_eq!(sessions, vec!["s3", "s4"], "oldest first, newest kept");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn usage_inside_the_quota_window_survives_the_count_cap() {
        let d = dir("usage-cap");
        let now = 1_780_000_000;
        for i in 0..5 {
            let at = crate::audit::format_rfc3339((now - 10 + i) as u64);
            usage::append(&d, &use_line(&format!("s{i}"), &at));
        }
        let old = crate::audit::format_rfc3339((now - LONGEST_QUOTA_WINDOW_SECS - 60) as u64);
        usage::append(&d, &use_line("s-old", &old));
        let policy = Retention { max_entries: 2, max_bytes: 1, ..DEFAULT_RETENTION };
        let removed = compact(&d, &policy, now).unwrap();
        assert_eq!(removed.usage, 1, "only the out-of-window line goes");
        assert_eq!(usage::read_all(&d).len(), 5);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_byte_cap_keeps_the_newest_that_fit() {
        let d = dir("bytes");
        let now = 1_780_000_000;
        let at = crate::audit::format_rfc3339(now as u64);
        for i in 0..4 {
            snapshot::append(&d, &snap(&format!("s{i}"), &at));
        }
        let one_line = serde_json::to_string(&snapshot::read_all(&d)[0]).unwrap().len() as u64 + 1;
        let policy = Retention {
            max_bytes: one_line * 2 + one_line / 2,
            ..DEFAULT_RETENTION
        };
        compact(&d, &policy, now).unwrap();
        let sessions: Vec<_> = snapshot::read_all(&d).into_iter().map(|s| s.session).collect();
        assert_eq!(sessions, vec!["s2", "s3"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_record_with_an_unreadable_timestamp_is_not_deleted_on_a_guess() {
        let d = dir("undated");
        snapshot::append(&d, &snap("s1", "not a time"));
        let removed = compact(&d, &DEFAULT_RETENTION, 1_780_000_000).unwrap();
        assert_eq!(removed.snapshots, 0);
        assert_eq!(snapshot::read_all(&d).len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn deleting_a_conversation_removes_its_requests_and_no_others() {
        let d = dir("delete");
        let at = crate::audit::now();
        snapshot::append(&d, &snap("thread-a", &at));
        snapshot::append(&d, &snap("thread-b", &at));
        snapshot::append(&d, &snap("thread-a", &at));
        usage::append(&d, &use_line("thread-a", &at));
        usage::append(&d, &use_line("thread-b", &at));

        let removed = delete_session(&d, "thread-a").unwrap();
        assert_eq!(removed, Removed { snapshots: 2, usage: 1, ..Removed::default() });
        assert!(snapshot::by_session(&d, "thread-a").is_empty());
        assert_eq!(snapshot::by_session(&d, "thread-b").len(), 1);
        assert_eq!(usage::read_all(&d).len(), 1);
        assert_eq!(usage::read_all(&d)[0].session, "thread-b");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn deleting_the_last_conversation_leaves_no_empty_log() {
        let d = dir("last");
        snapshot::append(&d, &snap("only", &crate::audit::now()));
        delete_session(&d, "only").unwrap();
        assert!(!snapshot::log_path(&d).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_blank_session_deletes_nothing() {
        let d = dir("blank");
        let mut unfiled = snap("x", &crate::audit::now());
        unfiled.session = String::new();
        snapshot::append(&d, &unfiled);
        assert_eq!(delete_session(&d, "  ").unwrap(), Removed::default());
        assert_eq!(snapshot::read_all(&d).len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_logs_are_not_an_error() {
        let d = dir("absent");
        assert_eq!(compact(&d, &DEFAULT_RETENTION, 0).unwrap(), Removed::default());
        assert_eq!(delete_session(&d, "t").unwrap(), Removed::default());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_large_log_is_not_rewritten_for_under_a_tenth_of_its_size() {
        let d = dir("worthwhile");
        let path = d.join("log.jsonl");
        let records: Vec<serde_json::Value> =
            (0..100).map(|i| json!({ "n": i, "pad": "x".repeat(50) })).collect();
        rewrite(&path, &records).unwrap();
        let before = std::fs::metadata(&path).unwrap().len();

        // One record of a hundred is about 1%: skipped when the file counts as large.
        let kept: Vec<_> = records[1..].to_vec();
        rewrite_if_worthwhile(&path, &kept, 1, 1).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().len(), before);

        // Below the large threshold it is rewritten as before.
        rewrite_if_worthwhile(&path, &kept, 1, u64::MAX).unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() < before);

        // Half of a large log is worth the rewrite.
        let half: Vec<_> = records[..50].to_vec();
        rewrite(&path, &records).unwrap();
        rewrite_if_worthwhile(&path, &half, 50, 1).unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() < before * 6 / 10);

        // Nothing removed never rewrites.
        let now = std::fs::metadata(&path).unwrap().len();
        rewrite_if_worthwhile(&path, &half, 0, 1).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().len(), now);
        let _ = std::fs::remove_dir_all(&d);
    }
}
