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
    let temp = path.with_extension(format!("jsonl.tmp-{}", std::process::id()));
    std::fs::write(&temp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}

/// Apply `policy` to both request logs.
pub fn compact(data_folder: &Path, policy: &Retention, now: i64) -> Result<Removed, String> {
    let _guard = lock();
    let mut removed = Removed::default();

    if snapshot::log_path(data_folder).exists() {
        let all = snapshot::read_all(data_folder);
        let before = all.len();
        let kept = retain(all, |s| s.at.as_str(), policy, now);
        removed.snapshots = before - kept.len();
        rewrite_if_changed(&snapshot::log_path(data_folder), &kept, removed.snapshots)?;
    }
    if usage::log_path(data_folder).exists() {
        let all = usage::read_all(data_folder);
        let before = all.len();
        let kept = retain(all, |u| u.at.as_str(), policy, now);
        removed.usage = before - kept.len();
        rewrite_if_changed(&usage::log_path(data_folder), &kept, removed.usage)?;
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
    let _guard = lock();
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
        assert_eq!(removed, Removed { snapshots: 1, usage: 1 });
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
        assert_eq!(removed, Removed { snapshots: 2, usage: 1 });
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
}
