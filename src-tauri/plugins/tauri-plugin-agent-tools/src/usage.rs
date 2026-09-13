//! What the payload that was actually dispatched cost. AH-073.
//!
//! Jan's own measurement is an estimate -- bytes over four -- and it has to be,
//! because it runs before a request exists and no tokenizer here matches every
//! server's. The exact number comes back from the server that tokenized it, in
//! the response's `usage`, and this is where that number is kept.
//!
//! Bound to the invocation and to the prompt snapshot, never to "the last
//! request": a run makes many model calls, and a count shown beside the wrong
//! payload is worse than no count, because it looks authoritative.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::audit::now;

pub const SCHEMA_VERSION: u32 = 1;

/// Where a count came from. An estimate is never presented as a count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsageSource {
    /// Reported by the provider that tokenized the payload. Exact.
    Provider,
    /// Jan's own approximation, when the provider reported nothing.
    Estimated,
}

/// One dispatch's accounting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PayloadUsage {
    #[serde(rename = "v")]
    pub version: u32,
    pub at: String,
    #[serde(default)]
    pub session: String,
    #[serde(default)]
    pub run: String,
    /// The dispatch this counts. One invocation, one payload, one count.
    pub invocation: String,
    /// The snapshot of the payload these numbers describe, so the count and
    /// the bytes it counted can be put side by side.
    #[serde(default)]
    pub snapshot: String,
    #[serde(default)]
    pub snapshot_hash: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub prompt_tokens: Option<u64>,
    #[serde(default)]
    pub completion_tokens: Option<u64>,
    #[serde(default)]
    pub total_tokens: Option<u64>,
    /// The provider's prompt-cache read for this dispatch. AH-211. Absent on
    /// records written before it existed and whenever the provider did not
    /// report it -- never written as a zero nobody measured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_prompt_tokens: Option<u64>,
    /// The provider's prompt-cache write for this dispatch. Part of
    /// `prompt_tokens`, not in addition to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    pub source: UsageSource,
}

pub fn log_path(data_folder: &Path) -> PathBuf {
    data_folder.join("audit").join("payload-usage.jsonl")
}

pub fn append(data_folder: &Path, usage: &PayloadUsage) {
    if let Err(e) = try_append(data_folder, usage) {
        eprintln!("payload usage: could not record {}: {e}", usage.invocation);
    }
}

fn try_append(data_folder: &Path, usage: &PayloadUsage) -> Result<(), String> {
    // Shared with compaction and deletion; see `crate::retention`.
    let _guard = crate::retention::lock();
    let path = log_path(data_folder);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let line = serde_json::to_string(usage).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())
}

pub fn read_all(data_folder: &Path) -> Vec<PayloadUsage> {
    let Ok(file) = std::fs::File::open(log_path(data_folder)) else {
        return Vec::new();
    };
    std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(&l).ok())
        .collect()
}

/// Records for one invocation, one run or one session.
///
/// Scoped like the snapshot lookup it pairs with: a caller names what it is
/// asking about and gets nothing outside it, so this cannot become a way to
/// read another session's activity.
pub fn scoped_lookup(
    data_folder: &Path,
    invocation: Option<&str>,
    run: Option<&str>,
    session: Option<&str>,
) -> Result<Vec<PayloadUsage>, String> {
    if invocation.is_none() && run.is_none() && session.is_none() {
        return Err("a usage lookup must name an invocation, a run or a session".into());
    }
    Ok(read_all(data_folder)
        .into_iter()
        .filter(|record| {
            invocation.map_or(true, |id| record.invocation == id)
                && run.map_or(true, |id| record.run == id)
                && session.map_or(true, |id| record.session == id)
        })
        .collect())
}

/// A later record for the same invocation refines the earlier one.
///
/// A step is measured before it is sent and counted after the reply, so both
/// exist for one dispatch. The provider's count wins whenever there is one.
pub fn latest_for(data_folder: &Path, invocation: &str) -> Option<PayloadUsage> {
    let mut best: Option<PayloadUsage> = None;
    for record in read_all(data_folder) {
        if record.invocation != invocation {
            continue;
        }
        let better = match &best {
            None => true,
            Some(current) => {
                current.source == UsageSource::Estimated || record.source == UsageSource::Provider
            }
        };
        if better {
            best = Some(record);
        }
    }
    best
}

/// Build a record, stamped now.
pub fn record(invocation: impl Into<String>, source: UsageSource) -> PayloadUsage {
    PayloadUsage {
        version: SCHEMA_VERSION,
        at: now(),
        session: String::new(),
        run: String::new(),
        invocation: invocation.into(),
        snapshot: String::new(),
        snapshot_hash: String::new(),
        model: String::new(),
        prompt_tokens: None,
        completion_tokens: None,
        total_tokens: None,
        cached_prompt_tokens: None,
        cache_write_tokens: None,
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn scratch() -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "jan-usage-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn seed(invocation: &str, source: UsageSource, prompt: u64) -> PayloadUsage {
        let mut r = record(invocation, source);
        r.session = "s1".into();
        r.run = "r1".into();
        r.snapshot = format!("snap-{invocation}");
        r.snapshot_hash = "fnv1a64:abc".into();
        r.prompt_tokens = Some(prompt);
        r
    }

    #[test]
    fn a_count_stays_with_its_own_dispatch() {
        let dir = scratch();
        append(&dir, &seed("i1", UsageSource::Provider, 100));
        append(&dir, &seed("i2", UsageSource::Provider, 900));

        let found = latest_for(&dir, "i1").unwrap();
        assert_eq!(found.prompt_tokens, Some(100));
        assert_eq!(found.snapshot, "snap-i1");
    }

    #[test]
    fn the_providers_count_replaces_the_estimate_for_the_same_dispatch() {
        let dir = scratch();
        append(&dir, &seed("i1", UsageSource::Estimated, 120));
        append(&dir, &seed("i1", UsageSource::Provider, 137));

        let found = latest_for(&dir, "i1").unwrap();
        assert_eq!(found.source, UsageSource::Provider);
        assert_eq!(found.prompt_tokens, Some(137));
    }

    #[test]
    fn an_estimate_never_overwrites_a_real_count() {
        let dir = scratch();
        append(&dir, &seed("i1", UsageSource::Provider, 137));
        append(&dir, &seed("i1", UsageSource::Estimated, 120));

        assert_eq!(
            latest_for(&dir, "i1").unwrap().source,
            UsageSource::Provider
        );
    }

    #[test]
    fn the_record_survives_a_restart() {
        let dir = scratch();
        append(&dir, &seed("i1", UsageSource::Provider, 137));
        // Nothing in memory; read back off disk.
        assert_eq!(read_all(&dir).len(), 1);
    }

    #[test]
    fn one_session_cannot_read_anothers_accounting() {
        let dir = scratch();
        append(&dir, &seed("i1", UsageSource::Provider, 137));
        let mut other = seed("i9", UsageSource::Provider, 999);
        other.session = "s2".into();
        append(&dir, &other);

        let mine = scoped_lookup(&dir, None, None, Some("s1")).unwrap();
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].invocation, "i1");
    }

    #[test]
    fn an_unscoped_lookup_is_refused_rather_than_answered() {
        let dir = scratch();
        append(&dir, &seed("i1", UsageSource::Provider, 137));
        assert!(scoped_lookup(&dir, None, None, None).is_err());
    }

    #[test]
    fn cache_counts_round_trip_and_older_records_stay_unreported() {
        let dir = scratch();
        let mut cached = seed("i1", UsageSource::Provider, 5974);
        cached.cached_prompt_tokens = Some(5957);
        cached.cache_write_tokens = Some(0);
        append(&dir, &cached);
        // A line written before the cache fields existed.
        let path = log_path(&dir);
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str(
            "{\"v\":1,\"at\":\"2026-01-01T00:00:00Z\",\"invocation\":\"i0\",\
             \"prompt_tokens\":10,\"source\":\"provider\"}\n",
        );
        std::fs::write(&path, raw).unwrap();

        let back = latest_for(&dir, "i1").unwrap();
        assert_eq!(back.cached_prompt_tokens, Some(5957));
        // A reported zero is a measurement and survives as one.
        assert_eq!(back.cache_write_tokens, Some(0));

        let old = latest_for(&dir, "i0").unwrap();
        assert_eq!(old.prompt_tokens, Some(10));
        assert_eq!(old.cached_prompt_tokens, None);
        assert_eq!(old.cache_write_tokens, None);
        // And writing it again does not invent the fields.
        let line = serde_json::to_string(&old).unwrap();
        assert!(!line.contains("cached_prompt_tokens"));
        assert!(!line.contains("cache_write_tokens"));
    }

    #[test]
    fn a_truncated_tail_costs_one_record_not_the_file() {
        let dir = scratch();
        append(&dir, &seed("i1", UsageSource::Provider, 137));
        let path = log_path(&dir);
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str("{\"v\":1,\"at\":\"20");
        std::fs::write(&path, raw).unwrap();
        assert_eq!(read_all(&dir).len(), 1);
    }
}
