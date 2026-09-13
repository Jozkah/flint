//! A finished run's recorded events, for stepping through it. AH-176.
//!
//! The event log already holds everything a run did, in order. What this adds
//! is the decision of what can be stepped through: a run that has a recorded
//! start and a recorded end. A run the log does not hold, a run with no end (it
//! is still going, or it was cut off before it could write one) and a log that
//! cannot be read are each a typed refusal, so an interface never presents an
//! empty or half-written recording as a finished run.
//!
//! Nothing here runs anything again: the recording is read, never re-executed.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use crate::event_log::{self, Envelope};
use crate::harness_error::{ErrorKind, HarnessError, Stage};

/// One run that can be stepped through.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishedRun {
    pub run: String,
    pub started_at: String,
    pub ended_at: String,
    /// What the run's end said stopped it (`done`, `aborted`, `error`, ...).
    pub stopped_by: String,
    /// How many recorded events the run has, start and end included.
    pub steps: usize,
    /// The log filled up at some point during the run.
    pub truncated: bool,
}

/// A finished run and its events, in log order.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecording {
    #[serde(flatten)]
    pub summary: FinishedRun,
    pub events: Vec<Envelope>,
}

fn read(data_folder: &Path, session: &str) -> Result<Vec<Envelope>, HarnessError> {
    if session.trim().is_empty() {
        return Err(HarnessError::new(
            ErrorKind::InvalidInput,
            "stepping through a run needs the session it belongs to",
        )
        .at(Stage::Replay));
    }
    event_log::read_session(data_folder, session).map_err(|e| {
        HarnessError::new(
            ErrorKind::MalformedState,
            format!("this session's event log could not be read: {}", e.message()),
        )
        .at(Stage::Replay)
    })
}

/// Group a session's events by run, keeping log order within each.
fn by_run(events: Vec<Envelope>) -> (Vec<String>, BTreeMap<String, Vec<Envelope>>) {
    let mut order = Vec::new();
    let mut runs: BTreeMap<String, Vec<Envelope>> = BTreeMap::new();
    for e in events {
        if e.run.is_empty() {
            continue;
        }
        if !runs.contains_key(&e.run) {
            order.push(e.run.clone());
        }
        runs.entry(e.run.clone()).or_default().push(e);
    }
    (order, runs)
}

/// The run's summary when it has both a recorded start and a recorded end.
fn summarize(run: &str, events: &[Envelope], truncated: bool) -> Option<FinishedRun> {
    let started = events.iter().find(|e| e.kind == "run.started")?;
    let ended = events.iter().rev().find(|e| e.kind == "run.ended")?;
    Some(FinishedRun {
        run: run.to_string(),
        started_at: started.at.clone(),
        ended_at: ended.at.clone(),
        stopped_by: ended
            .payload
            .get("stoppedBy")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
        steps: events.len(),
        truncated,
    })
}

fn log_truncated(all: &[Envelope]) -> bool {
    all.iter().any(|e| e.kind == "log.truncated")
}

/// Every finished run in the session, in the order they ended, so the last one
/// is the run that most recently finished. Runs overlap -- a chat run can start
/// inside an agent run and end before it -- so the order they started in is not
/// the order they finished in. A session with none is an empty list, not an
/// error; a log that cannot be read is.
pub fn finished_runs(data_folder: &Path, session: &str) -> Result<Vec<FinishedRun>, HarnessError> {
    let all = read(data_folder, session)?;
    let truncated = log_truncated(&all);
    let (order, runs) = by_run(all);
    let mut finished: Vec<(u64, FinishedRun)> = order
        .iter()
        .filter_map(|run| {
            let end = runs[run].iter().rev().find(|e| e.kind == "run.ended")?.seq;
            Some((end, summarize(run, &runs[run], truncated)?))
        })
        .collect();
    finished.sort_by_key(|(end, _)| *end);
    Ok(finished.into_iter().map(|(_, run)| run).collect())
}

/// One run's recording. Refused, by kind, when the run is not in the log
/// (`not_found`) or has no recorded end (`invalid_input`).
pub fn recording(data_folder: &Path, session: &str, run: &str) -> Result<RunRecording, HarnessError> {
    if run.trim().is_empty() {
        return Err(HarnessError::new(
            ErrorKind::InvalidInput,
            "stepping through a run needs the run to step through",
        )
        .at(Stage::Replay));
    }
    let all = read(data_folder, session)?;
    let truncated = log_truncated(&all);
    let (_, mut runs) = by_run(all);
    let Some(events) = runs.remove(run) else {
        return Err(HarnessError::new(
            ErrorKind::NotFound,
            format!("run {run} is not recorded in this session"),
        )
        .at(Stage::Replay));
    };
    let Some(summary) = summarize(run, &events, truncated) else {
        let why = if events.iter().any(|e| e.kind == "run.started") {
            "has no recorded end: it is still running, or it was cut off before it could finish"
        } else {
            "has no recorded start"
        };
        return Err(HarnessError::new(
            ErrorKind::InvalidInput,
            format!("run {run} {why}, so it cannot be stepped through"),
        )
        .at(Stage::Replay));
    };
    Ok(RunRecording { summary, events })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_log::{append, NewEvent};
    use serde_json::{json, Value};

    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jan-run-replay-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn put(d: &Path, session: &str, run: &str, id: &str, kind: &str, payload: Value) {
        append(
            d,
            NewEvent {
                id: id.into(),
                session: session.into(),
                run: run.into(),
                invocation: String::new(),
                kind: kind.into(),
                payload,
            },
        )
        .unwrap();
    }

    #[test]
    fn only_runs_with_a_start_and_an_end_can_be_stepped_through() {
        let d = dir("finished");
        put(&d, "s", "r1", "a", "run.started", json!({ "model": "m" }));
        put(&d, "s", "r1", "b", "tool.requested", json!({ "call": "c", "tool": "read", "phase": "requested" }));
        put(&d, "s", "r1", "c", "tool.succeeded", json!({ "call": "c", "tool": "read", "phase": "succeeded" }));
        put(&d, "s", "r1", "d", "run.ended", json!({ "stoppedBy": "done" }));
        // Still going (or cut off): started, never ended.
        put(&d, "s", "r2", "e", "run.started", json!({ "model": "m" }));
        put(&d, "s", "r2", "f", "tool.requested", json!({ "call": "x", "tool": "ls", "phase": "requested" }));

        let runs = finished_runs(&d, "s").unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run, "r1");
        assert_eq!(runs[0].stopped_by, "done");
        assert_eq!(runs[0].steps, 4);
        assert!(!runs[0].truncated);

        let rec = recording(&d, "s", "r1").unwrap();
        let kinds: Vec<&str> = rec.events.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["run.started", "tool.requested", "tool.succeeded", "run.ended"]);
        assert!(rec.events.windows(2).all(|w| w[0].seq < w[1].seq));

        let wire = serde_json::to_value(&rec).unwrap();
        assert_eq!(wire["run"], "r1");
        assert_eq!(wire["stoppedBy"], "done");
        assert_eq!(wire["events"].as_array().unwrap().len(), 4);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Found by the desktop scenario's first attempt: a chat run that started
    /// inside an agent run and ended first was offered as the latest run,
    /// because runs were listed in the order they started.
    #[test]
    fn overlapping_runs_are_listed_in_the_order_they_finished() {
        let d = dir("overlap");
        put(&d, "s", "agent", "a", "run.started", json!({}));
        put(&d, "s", "chat", "b", "run.started", json!({}));
        put(&d, "s", "chat", "c", "run.ended", json!({ "stoppedBy": "done" }));
        put(&d, "s", "agent", "d", "tool.requested", json!({ "call": "x", "tool": "ls", "phase": "requested" }));
        put(&d, "s", "agent", "e", "run.ended", json!({ "stoppedBy": "done" }));
        let runs: Vec<String> = finished_runs(&d, "s").unwrap().into_iter().map(|r| r.run).collect();
        assert_eq!(runs, ["chat", "agent"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_run_that_cannot_be_stepped_through_is_refused_by_kind() {
        let d = dir("refused");
        put(&d, "s", "r2", "e", "run.started", json!({}));
        put(&d, "s", "r3", "g", "tool.requested", json!({ "call": "x", "tool": "ls", "phase": "requested" }));

        let unfinished = recording(&d, "s", "r2").unwrap_err();
        assert_eq!(unfinished.kind(), ErrorKind::InvalidInput);
        assert_eq!(unfinished.stage(), Stage::Replay);
        assert!(unfinished.message().contains("no recorded end"), "{}", unfinished.message());

        let headless = recording(&d, "s", "r3").unwrap_err();
        assert!(headless.message().contains("no recorded start"), "{}", headless.message());

        let missing = recording(&d, "s", "nope").unwrap_err();
        assert_eq!(missing.kind(), ErrorKind::NotFound);

        assert_eq!(recording(&d, "", "r2").unwrap_err().kind(), ErrorKind::InvalidInput);
        assert_eq!(recording(&d, "s", " ").unwrap_err().kind(), ErrorKind::InvalidInput);
        assert_eq!(finished_runs(&d, "").unwrap_err().kind(), ErrorKind::InvalidInput);
        // A session with nothing recorded has no finished runs; that is not a failure.
        assert!(finished_runs(&d, "empty").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_log_that_cannot_be_read_is_an_error_and_never_an_empty_list() {
        let d = dir("corrupt");
        put(&d, "s", "r1", "a", "run.started", json!({}));
        put(&d, "s", "r1", "b", "run.ended", json!({ "stoppedBy": "done" }));
        let path = event_log::log_path(&d, "s");
        let mut text = std::fs::read_to_string(&path).unwrap();
        // Not the last line, so it is corruption rather than a torn write.
        text = format!("not an event\n{text}");
        std::fs::write(&path, text).unwrap();
        crate::event_log::forget_loaded();

        let err = finished_runs(&d, "s").unwrap_err();
        assert_eq!(err.kind(), ErrorKind::MalformedState);
        assert_eq!(recording(&d, "s", "r1").unwrap_err().kind(), ErrorKind::MalformedState);
        let _ = std::fs::remove_dir_all(&d);
    }
}
