//! Finding session logs and reading them once.
//!
//! Folders are only listed and read, never written. Symbolic links are not
//! followed. Each log's records are cached on disk under the key
//! `path + mtime + size`: a log that is unchanged since the last scan is not
//! opened again, and a log that grew or was rewritten is parsed afresh.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use super::parse::{parse_claude_code, parse_codex};
use super::{Agent, ParseStats, Record};

/// A log bigger than this is left unread.
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_DEPTH: usize = 12;
const CACHE_VERSION: u32 = 1;

/// The two folders that are read.
#[derive(Clone, Debug)]
pub struct Roots {
    pub claude_code: PathBuf,
    pub codex: PathBuf,
}

/// `CLAUDE_CONFIG_DIR` else `~/.claude`, then `/projects`; `CODEX_HOME` else
/// `~/.codex`, then `/sessions`.
pub fn default_roots() -> Roots {
    let home = dirs::home_dir().unwrap_or_default();
    let pick = |var: &str, dot: &str| {
        std::env::var_os(var)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(dot))
    };
    Roots {
        claude_code: pick("CLAUDE_CONFIG_DIR", ".claude").join("projects"),
        codex: pick("CODEX_HOME", ".codex").join("sessions"),
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RootStatus {
    Ok,
    Missing,
    Denied,
    Error,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RootInfo {
    pub agent: Agent,
    pub path: String,
    pub status: RootStatus,
    /// Readable `.jsonl` logs found.
    pub files: usize,
    /// `.jsonl.zst` logs found and left unread (this build cannot decompress them).
    pub compressed_skipped: usize,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub roots: Vec<RootInfo>,
    pub files_parsed: usize,
    pub files_cached: usize,
    pub files_unreadable: usize,
    pub files_too_large: usize,
    pub skipped_lines: u64,
    /// Repeated replies dropped, within a log and across logs.
    pub duplicates: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct CacheFile {
    version: u32,
    files: HashMap<String, CacheEntry>,
}

#[derive(Serialize, Deserialize, Clone)]
struct CacheEntry {
    mtime_ms: i64,
    size: u64,
    records: Vec<Record>,
    stats: ParseStats,
}

fn load_cache(path: Option<&Path>) -> CacheFile {
    let Some(path) = path else { return CacheFile { version: CACHE_VERSION, ..Default::default() } };
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<CacheFile>(&b).ok())
        .filter(|c| c.version == CACHE_VERSION)
        .unwrap_or(CacheFile { version: CACHE_VERSION, ..Default::default() })
}

fn save_cache(path: Option<&Path>, cache: &CacheFile) {
    let Some(path) = path else { return };
    if let Ok(bytes) = serde_json::to_vec(cache) {
        // A cache that cannot be written only costs the next scan its speed.
        let _ = crate::core::atomic_io::write_atomic_durable(path, &bytes);
    }
}

struct Found {
    files: Vec<PathBuf>,
    compressed: usize,
    status: RootStatus,
}

fn list_logs(root: &Path) -> Found {
    let mut found = Found { files: vec![], compressed: 0, status: RootStatus::Ok };
    match std::fs::metadata(root) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => {
            found.status = RootStatus::Error;
            return found;
        }
        Err(e) => {
            found.status = match e.kind() {
                std::io::ErrorKind::NotFound => RootStatus::Missing,
                std::io::ErrorKind::PermissionDenied => RootStatus::Denied,
                _ => RootStatus::Error,
            };
            return found;
        }
    }
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                if dir == root {
                    found.status = if e.kind() == std::io::ErrorKind::PermissionDenied {
                        RootStatus::Denied
                    } else {
                        RootStatus::Error
                    };
                }
                continue;
            }
        };
        for entry in entries.flatten() {
            let Ok(ty) = entry.file_type() else { continue };
            let path = entry.path();
            if ty.is_symlink() {
                continue;
            }
            if ty.is_dir() {
                if depth < MAX_DEPTH {
                    stack.push((path, depth + 1));
                }
            } else if ty.is_file() {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if name.ends_with(".jsonl") {
                    found.files.push(path);
                } else if name.ends_with(".jsonl.zst") {
                    found.compressed += 1;
                }
            }
        }
    }
    found.files.sort();
    found
}

fn stamp(path: &Path) -> Option<(i64, u64)> {
    let m = std::fs::metadata(path).ok()?;
    let mtime = m.modified().ok()?.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    Some((mtime, m.len()))
}

/// Read every log under `roots`. `progress(done, total)` is called as files
/// are handled. Records come back with repeated ids already removed.
pub fn scan(
    roots: &Roots,
    cache_path: Option<&Path>,
    progress: &dyn Fn(usize, usize),
) -> (Vec<Record>, ScanSummary) {
    let mut summary = ScanSummary::default();
    let mut work: Vec<(Agent, PathBuf)> = Vec::new();
    for (agent, root) in [(Agent::ClaudeCode, &roots.claude_code), (Agent::Codex, &roots.codex)] {
        let found = list_logs(root);
        summary.roots.push(RootInfo {
            agent,
            path: root.to_string_lossy().into_owned(),
            status: found.status,
            files: found.files.len(),
            compressed_skipped: found.compressed,
        });
        work.extend(found.files.into_iter().map(|f| (agent, f)));
    }

    let old = load_cache(cache_path);
    let mut next = CacheFile { version: CACHE_VERSION, files: HashMap::new() };
    let mut all: Vec<Record> = Vec::new();
    let total = work.len();
    for (i, (agent, path)) in work.into_iter().enumerate() {
        progress(i, total);
        let key = path.to_string_lossy().into_owned();
        let Some((mtime_ms, size)) = stamp(&path) else {
            summary.files_unreadable += 1;
            continue;
        };
        if size > MAX_FILE_BYTES {
            summary.files_too_large += 1;
            continue;
        }
        let entry = match old.files.get(&key) {
            Some(e) if e.mtime_ms == mtime_ms && e.size == size => {
                summary.files_cached += 1;
                e.clone()
            }
            _ => {
                let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                let folder = path
                    .parent()
                    .and_then(|p| p.file_name())
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let parsed = std::fs::File::open(&path).and_then(|f| {
                    let reader = std::io::BufReader::with_capacity(256 * 1024, f);
                    match agent {
                        Agent::Codex => parse_codex(reader, &stem),
                        _ => parse_claude_code(reader, &stem, &folder),
                    }
                });
                match parsed {
                    Ok((records, stats)) => {
                        summary.files_parsed += 1;
                        CacheEntry { mtime_ms, size, records, stats }
                    }
                    Err(_) => {
                        summary.files_unreadable += 1;
                        continue;
                    }
                }
            }
        };
        summary.skipped_lines += entry.stats.skipped_lines;
        summary.duplicates += entry.stats.duplicates;
        all.extend(entry.records.iter().cloned());
        next.files.insert(key, entry);
    }
    progress(total, total);

    // Only rewrite the cache when something changed (new/changed/removed log).
    if summary.files_parsed > 0 || next.files.len() != old.files.len() {
        save_cache(cache_path, &next);
    }

    // The same reply in two logs (a resumed session copies history) counts once.
    let mut seen: HashSet<String> = HashSet::new();
    let before = all.len();
    all.retain(|r| r.id.is_empty() || seen.insert(r.id.clone()));
    summary.duplicates += (before - all.len()) as u64;
    (all, summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn line(id: &str, out: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"2026-10-26T12:00:00Z","sessionId":"s","cwd":"/x/p","message":{{"id":"{id}","model":"claude-sonnet-5-5","usage":{{"input_tokens":1,"output_tokens":{out}}}}}}}"#
        )
    }

    fn setup() -> (tempfile::TempDir, Roots) {
        let d = tempfile::tempdir().unwrap();
        let claude = d.path().join("projects");
        let codex = d.path().join("sessions");
        fs::create_dir_all(claude.join("proj-a")).unwrap();
        fs::create_dir_all(&codex).unwrap();
        (d, Roots { claude_code: claude, codex })
    }

    #[test]
    fn cache_reuses_unchanged_and_reparses_changed() {
        let (d, roots) = setup();
        let log = roots.claude_code.join("proj-a/s1.jsonl");
        fs::write(&log, format!("{}\n", line("m1", 5))).unwrap();
        let cache = d.path().join("cache.json");

        let (recs, s1) = scan(&roots, Some(&cache), &|_, _| {});
        assert_eq!((recs.len(), s1.files_parsed, s1.files_cached), (1, 1, 0));

        let (recs, s2) = scan(&roots, Some(&cache), &|_, _| {});
        assert_eq!((recs.len(), s2.files_parsed, s2.files_cached), (1, 0, 1));

        // Size change invalidates.
        fs::write(&log, format!("{}\n{}\n", line("m1", 5), line("m2", 6))).unwrap();
        let (recs, s3) = scan(&roots, Some(&cache), &|_, _| {});
        assert_eq!((recs.len(), s3.files_parsed, s3.files_cached), (2, 1, 0));

        // Same size, new mtime invalidates too.
        let same_size = format!("{}\n{}\n", line("m1", 5), line("m3", 6));
        assert_eq!(same_size.len(), fs::metadata(&log).unwrap().len() as usize);
        fs::write(&log, same_size).unwrap();
        let f = fs::OpenOptions::new().write(true).open(&log).unwrap();
        f.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(60)).unwrap();
        drop(f);
        let (recs, s4) = scan(&roots, Some(&cache), &|_, _| {});
        assert_eq!((recs.len(), s4.files_parsed), (2, 1));
        assert!(recs.iter().any(|r| r.id == "cc:m3"));

        // A deleted log drops out of the results and the cache.
        fs::remove_file(&log).unwrap();
        let (recs, _) = scan(&roots, Some(&cache), &|_, _| {});
        assert!(recs.is_empty());
        let saved: CacheFile = serde_json::from_slice(&fs::read(&cache).unwrap()).unwrap();
        assert!(saved.files.is_empty());
    }

    /// Reads this machine's real logs: `cargo test ... -- --ignored real_logs --nocapture`.
    #[test]
    #[ignore]
    fn real_logs_smoke() {
        let t = std::time::Instant::now();
        let (recs, s) = scan(&default_roots(), None, &|_, _| {});
        let sum = |a: Agent, f: fn(&Record) -> u64| recs.iter().filter(|r| r.agent == a).map(f).sum::<u64>();
        println!("{:?}", s);
        println!(
            "records {} claude_out {} claude_ids {} codex_out {} in {:?}",
            recs.len(),
            sum(Agent::ClaudeCode, |r| r.output),
            recs.iter().filter(|r| r.agent == Agent::ClaudeCode).count(),
            sum(Agent::Codex, |r| r.output),
            t.elapsed()
        );
    }

    #[test]
    fn same_reply_in_two_logs_counts_once() {
        let (_d, roots) = setup();
        fs::write(roots.claude_code.join("proj-a/a.jsonl"), format!("{}\n", line("m1", 5))).unwrap();
        fs::write(roots.claude_code.join("proj-a/b.jsonl"), format!("{}\n", line("m1", 5))).unwrap();
        let (recs, s) = scan(&roots, None, &|_, _| {});
        assert_eq!(recs.len(), 1);
        assert_eq!(s.duplicates, 1);
    }

    #[test]
    fn missing_roots_and_compressed_logs_are_reported() {
        let (d, roots) = setup();
        fs::write(roots.codex.join("old.jsonl.zst"), b"\x28\xb5\x2f\xfd").unwrap();
        let gone = Roots { claude_code: d.path().join("nope"), codex: roots.codex.clone() };
        let (recs, s) = scan(&gone, None, &|_, _| {});
        assert!(recs.is_empty());
        assert_eq!(s.roots[0].status, RootStatus::Missing);
        assert_eq!(s.roots[1].status, RootStatus::Ok);
        assert_eq!(s.roots[1].compressed_skipped, 1);
    }
}
