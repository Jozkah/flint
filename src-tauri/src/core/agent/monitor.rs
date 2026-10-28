//! The `monitor` tool: a background command whose matching stdout lines reach
//! the run as short events, instead of one notice when the job ends.
//!
//! There is no second process manager. `monitor` is dispatched as a
//! backgrounded `bash` call -- same confinement, same permission gate, same
//! entry in the background tasks panel with the same Stop button -- and this
//! module only remembers, per job, what to filter and how far it has been read.
//! The turn loop calls [`collect`] at each turn boundary, next to the
//! background-job doorbell.
//!
//! Delivery is rate-capped so a chatty command cannot flood the context: a
//! turn gets at most one line per second elapsed since the last delivery (never
//! fewer than one), a job delivers at most [`MAX_LINES_PER_JOB`] lines, after
//! which one summary line says the rest is dropped.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use regex::Regex;

pub const MAX_LINES_PER_JOB: usize = 100;
/// A delivered line is cut to this many characters.
const MAX_LINE_CHARS: usize = 300;

struct Watcher {
    filter: Option<Regex>,
    /// Absolute offset into the job's output already read.
    cursor: u64,
    delivered: usize,
    last_delivery: Option<Instant>,
    /// The summary line was sent; nothing more is delivered.
    capped: bool,
    /// Matching lines held back by the rate cap, delivered on later turns.
    backlog: Vec<String>,
    /// Matching lines discarded because the backlog hit its bound.
    dropped: usize,
}

/// The backlog never holds more than this many lines.
const MAX_BACKLOG: usize = 2 * MAX_LINES_PER_JOB;

/// Job ids a run is watching. Dropping it (any way the run ends) forgets
/// their watchers so a stopped job cannot leave one behind.
#[derive(Default)]
pub struct Tracked(Vec<String>);

impl std::ops::Deref for Tracked {
    type Target = Vec<String>;
    fn deref(&self) -> &Vec<String> {
        &self.0
    }
}

impl std::ops::DerefMut for Tracked {
    fn deref_mut(&mut self) -> &mut Vec<String> {
        &mut self.0
    }
}

impl Drop for Tracked {
    fn drop(&mut self) {
        for job in &self.0 {
            forget(job);
        }
    }
}

/// Drop the watcher for a job that ended or whose run is over.
pub fn forget(job_id: &str) {
    if let Ok(mut map) = watchers().lock() {
        map.remove(job_id);
    }
}

/// Queue a line unless the backlog is full, in which case count the drop.
fn push_bounded(w: &mut Watcher, line: String) {
    if w.backlog.len() >= MAX_BACKLOG {
        w.dropped += 1;
    } else {
        w.backlog.push(line);
    }
}

fn watchers() -> &'static Mutex<HashMap<String, Watcher>> {
    static W: OnceLock<Mutex<HashMap<String, Watcher>>> = OnceLock::new();
    W.get_or_init(Default::default)
}

/// A bad filter is an error before anything runs. Empty means every line.
pub fn parse_filter(filter: Option<&str>) -> Result<Option<Regex>, String> {
    match filter.map(str::trim).filter(|f| !f.is_empty()) {
        None => Ok(None),
        Some(f) => Regex::new(f)
            .map(Some)
            .map_err(|e| format!("filter is not a valid regex: {e}")),
    }
}

/// Remember a watcher for a job that has just started.
pub fn register(job_id: &str, filter: Option<Regex>) {
    watchers().lock().unwrap_or_else(|e| e.into_inner()).insert(
        job_id.to_string(),
        Watcher {
            filter,
            cursor: 0,
            delivered: 0,
            last_delivery: None,
            capped: false,
            backlog: Vec::new(),
            dropped: 0,
        },
    );
}

pub fn is_watched(job_id: &str) -> bool {
    watchers().lock().unwrap_or_else(|e| e.into_inner()).contains_key(job_id)
}

/// Pure core of delivery: take from `backlog` what the cap allows right now.
/// `elapsed_secs` is the time since the last delivery (`None`: the first one).
fn take_allowed(
    backlog: &mut Vec<String>,
    delivered: &mut usize,
    elapsed_secs: Option<u64>,
) -> (Vec<String>, bool) {
    let room = MAX_LINES_PER_JOB.saturating_sub(*delivered);
    let per_turn = elapsed_secs.map_or(1, |s| s.max(1)) as usize;
    let n = backlog.len().min(per_turn).min(room);
    let lines: Vec<String> = backlog.drain(..n).collect();
    *delivered += lines.len();
    (lines, *delivered >= MAX_LINES_PER_JOB)
}

fn clip(line: &str) -> String {
    let line = line.trim_end();
    if line.chars().count() <= MAX_LINE_CHARS {
        line.to_string()
    } else {
        let cut: String = line.chars().take(MAX_LINE_CHARS).collect();
        format!("{cut}...")
    }
}

/// The event text for every watched job in `jobs` that has something to say
/// now, or `None`. Jobs that are gone (collected, cancelled) are forgotten.
pub fn collect(jobs: &[String]) -> Option<String> {
    use tauri_plugin_agent_tools::tools::handlers::{bash_job_output_since, inspect_bash_job};
    let mut out = Vec::new();
    let mut map = watchers().lock().unwrap_or_else(|e| e.into_inner());
    for job in jobs {
        let Some(w) = map.get_mut(job) else { continue };
        let Some(status) = inspect_bash_job(job, None) else {
            map.remove(job);
            continue;
        };
        if w.capped {
            if status.finished {
                map.remove(job);
            }
            continue;
        }
        if let Some((text, next)) = bash_job_output_since(job, None, w.cursor) {
            let skipped = next.saturating_sub(w.cursor).saturating_sub(text.len() as u64);
            if skipped > 0 {
                push_bounded(w, format!("({skipped} bytes of output were not kept)"));
            }
            w.cursor = next;
            for line in text.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with("[exit ") {
                    continue;
                }
                if w.filter.as_ref().is_none_or(|f| f.is_match(line)) {
                    push_bounded(w, clip(line));
                }
            }
        }
        let elapsed = w.last_delivery.map(|t| t.elapsed().as_secs());
        let (lines, hit_cap) = take_allowed(&mut w.backlog, &mut w.delivered, elapsed);
        if !lines.is_empty() {
            w.last_delivery = Some(Instant::now());
            for line in lines {
                out.push(format!("[monitor {job}] {line}"));
            }
        }
        if hit_cap {
            let dropped = w.backlog.len() + w.dropped;
            w.backlog.clear();
            w.dropped = 0;
            w.capped = true;
            out.push(format!(
                "[monitor {job}] {MAX_LINES_PER_JOB} lines delivered, the cap for one watcher; \
                 later output is not delivered{}. Read it with {{\"job_id\": \"{job}\"}} or stop the job.",
                if dropped > 0 {
                    format!(" ({dropped} matching lines dropped)")
                } else {
                    String::new()
                }
            ));
        }
        if status.finished && w.backlog.is_empty() {
            map.remove(job);
        }
    }
    (!out.is_empty()).then(|| out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn at_most_one_line_per_elapsed_second_and_never_fewer_than_one() {
        let mut backlog: Vec<String> = (0..10).map(|i| i.to_string()).collect();
        let mut delivered = 0;
        let (a, _) = take_allowed(&mut backlog, &mut delivered, None);
        assert_eq!(a, ["0"]);
        let (b, _) = take_allowed(&mut backlog, &mut delivered, Some(0));
        assert_eq!(b, ["1"]);
        let (c, _) = take_allowed(&mut backlog, &mut delivered, Some(3));
        assert_eq!(c, ["2", "3", "4"]);
        assert_eq!(delivered, 5);
    }

    #[test]
    fn a_job_stops_at_the_hundred_line_cap() {
        let mut backlog: Vec<String> = (0..500).map(|i| i.to_string()).collect();
        let mut delivered = MAX_LINES_PER_JOB - 2;
        let (lines, hit) = take_allowed(&mut backlog, &mut delivered, Some(60));
        assert_eq!(lines.len(), 2);
        assert!(hit);
        assert_eq!(delivered, MAX_LINES_PER_JOB);
    }

    #[test]
    fn filter_must_be_a_regex_and_empty_means_everything() {
        assert!(parse_filter(Some("(")).is_err());
        assert!(parse_filter(Some("  ")).unwrap().is_none());
        assert!(parse_filter(Some("ERROR|WARN")).unwrap().unwrap().is_match("WARN: x"));
    }

    fn test_watcher() -> Watcher {
        Watcher {
            filter: None,
            cursor: 0,
            delivered: 0,
            last_delivery: None,
            capped: false,
            backlog: Vec::new(),
            dropped: 0,
        }
    }

    #[test]
    fn backlog_is_capped_and_counts_drops() {
        let mut w = test_watcher();
        for i in 0..(MAX_BACKLOG + 50) {
            push_bounded(&mut w, i.to_string());
        }
        assert_eq!(w.backlog.len(), MAX_BACKLOG);
        assert_eq!(w.dropped, 50);
    }

    #[test]
    fn forget_removes_watcher() {
        register("monitor-test-forget", None);
        assert!(is_watched("monitor-test-forget"));
        forget("monitor-test-forget");
        assert!(!is_watched("monitor-test-forget"));
        register("monitor-test-tracked", None);
        {
            let mut t = Tracked::default();
            t.push("monitor-test-tracked".to_string());
        }
        assert!(!is_watched("monitor-test-tracked"));
    }

    #[test]
    fn long_lines_are_clipped() {
        assert!(clip(&"x".repeat(1000)).chars().count() <= MAX_LINE_CHARS + 3);
    }
}
