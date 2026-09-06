//! Reading back what a run did: replay and audit export (`AH-032`, `AH-177`,
//! `AH-200`).
//!
//! The recorder writes a canonical event log per run. Until something reads it
//! back, that log is write-only -- which is the state the harness was already
//! in with `StreamEvent`, just one layer further along. These three commands
//! are what make the record answerable:
//!
//! ```text
//! jan cli agent runs list
//! jan cli agent runs show <run-id>
//! jan cli agent runs export <run-id>
//! ```
//!
//! `show` renders the log for a person; `export` emits the record and every
//! event verbatim for a reviewer or another tool. Neither interprets or filters
//! -- an audit export that decided what was worth including would not be one.

use jan_agent_harness::envelope::EventLog;
use jan_agent_harness::error::{ErrorKind, HarnessError};
use jan_agent_harness::event::{EventPayload, HarnessEvent};
use jan_agent_harness::identity::RunId;
use jan_agent_harness::state::{RunRecord, RunStatus, StateStore};

use crate::core::agent::recorder::STATE_DIR;

/// The store every recorded run lives in.
pub(crate) fn store() -> StateStore {
    StateStore::new(crate::core::app::commands::resolve_jan_data_folder().join(STATE_DIR))
}

/// One line describing a run, for `runs list`.
pub(crate) fn summarize(record: &RunRecord) -> String {
    let status = format!("{:?}", record.status).to_lowercase();
    format!(
        "{}  {:<11}  {:>6} events  {}{}",
        record.identity.run,
        status,
        record.last_event_seq + 1,
        record.model,
        if record.plan_mode { "  [plan]" } else { "" }
    )
}

/// A short, stable rendering of one event.
///
/// Deliberately one line each: a replay is read by scrolling, and an event that
/// wraps into a paragraph hides the shape of the run around it.
pub(crate) fn render_event(event: &HarnessEvent) -> String {
    let agent = short_id(event.identity.agent.as_str());
    let body = match &event.payload {
        EventPayload::RunStarted { model, plan_mode } => {
            format!("run started  model={model}{}", if *plan_mode { "  plan" } else { "" })
        }
        EventPayload::RunFinished { outcome } => format!("run finished  {outcome:?}"),
        EventPayload::TurnStarted { turn } => format!("turn {turn} started"),
        EventPayload::TurnFinished { turn, usage } => format!(
            "turn {turn} finished  prompt={} completion={}",
            usage.prompt_tokens, usage.completion_tokens
        ),
        EventPayload::ToolCalled { tool, resource, .. } => match resource {
            Some(resource) => format!("call    {tool}  {resource}"),
            None => format!("call    {tool}"),
        },
        EventPayload::ToolFinished { tool, outcome, duration_ms, .. } => {
            let took = match duration_ms {
                Some(ms) => format!("  {ms}ms"),
                // Absent means unmeasured, and the replay says so rather than
                // printing a zero a reader would take for a real number.
                None => "  (untimed)".to_string(),
            };
            format!("result  {tool}  {outcome:?}{took}")
        }
        EventPayload::PermissionRequested { tool, resource, .. } => match resource {
            Some(resource) => format!("ASK     {tool}  {resource}"),
            None => format!("ASK     {tool}"),
        },
        EventPayload::PermissionDecided { tool, decision, .. } => {
            format!("DECIDE  {tool}  {decision:?}")
        }
        EventPayload::AskRequested { question, .. } => format!("ask     {question}"),
        EventPayload::AskAnswered { answered, .. } => {
            format!("ask     {}", if *answered { "answered" } else { "unanswered" })
        }
        EventPayload::SubagentStarted { agent, name } => {
            format!("subagent {name} started as {}", short_id(agent.as_str()))
        }
        EventPayload::SubagentFinished { agent, outcome } => {
            format!("subagent {} finished  {outcome:?}", short_id(agent.as_str()))
        }
        EventPayload::TodoUpdated { pending, in_progress, completed, abandoned } => format!(
            "todo    {pending} pending, {in_progress} active, {completed} done, {abandoned} dropped"
        ),
        EventPayload::Compacted { messages_removed, tokens_before, tokens_after } => format!(
            "compact removed {messages_removed} messages, {tokens_before} -> {tokens_after} tokens"
        ),
        EventPayload::CheckpointCreated { label, .. } => format!("checkpoint  {label}"),
        EventPayload::BudgetCrossed { budget, spent, limit, exhausted } => format!(
            "BUDGET  {budget}  spent={spent} limit={limit}{}",
            if *exhausted { "  exhausted" } else { "" }
        ),
        EventPayload::ErrorRaised { kind, message, .. } => {
            format!("ERROR   {}  {message}", kind.tag())
        }
        EventPayload::ProgressStalled { repeats, stopped } => format!(
            "STALLED {repeats} identical turns{}",
            if *stopped { "  (run stopped)" } else { "" }
        ),
        // Written by a newer build. Named, never dropped: a replay that quietly
        // skipped what it could not read would misrepresent the run.
        EventPayload::Unknown { kind, .. } => format!("{kind}  (not understood by this build)"),
    };
    format!("{:>5}  {agent}  {body}", event.seq)
}

/// Last six characters of an id: enough to tell agents apart in one run,
/// short enough that the events line up.
fn short_id(id: &str) -> String {
    let tail: String = id.chars().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{tail:>6}")
}

/// The whole replay, header included.
pub(crate) fn replay_lines(record: &RunRecord, events: &[HarnessEvent]) -> Vec<String> {
    let mut lines = vec![
        format!("run     {}", record.identity.run),
        format!("thread  {}", record.identity.thread),
        format!("model   {}", record.model),
        format!("status  {:?}", record.status),
        String::new(),
    ];
    if events.is_empty() {
        lines.push("(no events recorded)".to_string());
        return lines;
    }
    lines.extend(events.iter().map(render_event));
    lines
}

/// The audit export: the run's record and every event, verbatim.
pub(crate) fn export_value(
    record: &RunRecord,
    events: &[HarnessEvent],
) -> Result<serde_json::Value, HarnessError> {
    Ok(serde_json::json!({
        "record": serde_json::to_value(record)?,
        "events": serde_json::to_value(events)?,
    }))
}

/// Loads a run's record and events from a given store.
///
/// Split from [`load`] so tests can read back a run they recorded into a
/// temporary directory rather than the user's real data folder.
pub(crate) fn load_from(
    store: &StateStore,
    run: &str,
) -> Result<(RunRecord, Vec<HarnessEvent>), HarnessError> {
    let run = RunId::parse(run)?;
    // `load_for_resume`, not `load`: a CLI invocation is by definition not the
    // run's own process, so a record still reading `Running` means that process
    // never closed it. Showing such a run as running would be a lie with a
    // consequence -- it is exactly the run whose side effects are in doubt.
    let record = store.load_for_resume(&run)?;
    let events = EventLog::read(store.events_path(&run))?;
    Ok((record, events))
}

/// A tool call that was dispatched with no recorded outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UnfinishedCall {
    pub tool: String,
    pub resource: Option<String>,
}

/// What an interrupted run left behind.
///
/// The event log records a call before it runs and again when it ends, so a
/// call with no ending is one whose side effects may or may not have landed.
/// That set is the whole question when deciding what to do about an interrupted
/// run, and it is not answerable from a transcript.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Recovery {
    pub last_turn_started: Option<u32>,
    pub last_turn_finished: Option<u32>,
    pub unfinished: Vec<UnfinishedCall>,
}

pub(crate) fn recovery(events: &[HarnessEvent]) -> Recovery {
    let mut state = Recovery::default();
    let mut open: Vec<(String, UnfinishedCall)> = Vec::new();

    for event in events {
        match &event.payload {
            EventPayload::TurnStarted { turn } => state.last_turn_started = Some(*turn),
            EventPayload::TurnFinished { turn, .. } => state.last_turn_finished = Some(*turn),
            EventPayload::ToolCalled { call_id, tool, resource, .. } => open.push((
                call_id.clone(),
                UnfinishedCall { tool: tool.clone(), resource: resource.clone() },
            )),
            EventPayload::ToolFinished { call_id, .. } => {
                open.retain(|(id, _)| id != call_id);
            }
            _ => {}
        }
    }
    state.unfinished = open.into_iter().map(|(_, call)| call).collect();
    state
}

/// The recovery section appended to an interrupted run's replay.
pub(crate) fn recovery_lines(state: &Recovery) -> Vec<String> {
    let mut lines = vec![String::new(), "-- interrupted --".to_string()];
    match (state.last_turn_started, state.last_turn_finished) {
        (Some(started), Some(finished)) if started > finished => {
            lines.push(format!("turn {started} was in flight; turn {finished} was the last to finish"));
        }
        (Some(started), None) => lines.push(format!("turn {started} was in flight; none finished")),
        (Some(_), Some(finished)) => lines.push(format!("turn {finished} finished; no turn was in flight")),
        _ => lines.push("no turn had started".to_string()),
    }

    if state.unfinished.is_empty() {
        lines.push("every dispatched tool call recorded an outcome".to_string());
        return lines;
    }
    lines.push(format!(
        "{} tool call(s) were dispatched with no recorded outcome. Their effects may or may \
         not have landed -- check before re-running them:",
        state.unfinished.len()
    ));
    for call in &state.unfinished {
        match &call.resource {
            Some(resource) => lines.push(format!("    {}  {resource}", call.tool)),
            None => lines.push(format!("    {}", call.tool)),
        }
    }
    lines
}

/// Loads a run's record and events, or says why it could not.
pub(crate) fn load(run: &str) -> Result<(RunRecord, Vec<HarnessEvent>), HarnessError> {
    load_from(&store(), run)
}

/// The most recent run left interrupted on a surface thread, if any.
///
/// Scans the run store rather than keeping an index: a store holds one small
/// record per run, and this runs once when a conversation is resumed. If that
/// ever stops being true the answer is an index, not a cache.
pub(crate) fn last_interrupted_on_thread(
    store: &StateStore,
    external_thread: &str,
) -> Option<(RunRecord, Vec<HarnessEvent>)> {
    // `list` is creation-ordered, so the last match is the most recent.
    store
        .list()
        .ok()?
        .into_iter()
        .rev()
        .filter_map(|run| {
            let record = store.load_for_resume(&run).ok()?;
            (record.status == RunStatus::Interrupted
                && record.external_thread.as_deref() == Some(external_thread))
            .then_some(record)
        })
        .find_map(|record| {
            let events = EventLog::read(store.events_path(&record.identity.run)).ok()?;
            Some((record, events))
        })
}

/// The note handed to a run resuming a thread whose last run was interrupted.
///
/// Addressed to the model, because it is the party that has to act on it. The
/// point is not that a previous run stopped -- it is that some of its tool
/// calls have no recorded outcome, so the workspace may or may not carry their
/// effects, and re-running them blindly is how a resumed session applies a
/// mutation twice.
pub(crate) fn interrupted_handoff(store: &StateStore, external_thread: &str) -> Option<String> {
    let (record, events) = last_interrupted_on_thread(store, external_thread)?;
    let state = recovery(&events);

    let mut note = format!(
        "[resumed after an interrupted run] Run {} stopped without finishing.",
        record.identity.run
    );
    if let Some(turn) = state.last_turn_started {
        note.push_str(&format!(" Turn {turn} was in flight."));
    }
    if state.unfinished.is_empty() {
        note.push_str(
            " Every tool call it dispatched recorded an outcome, so the workspace is in a \
             known state.",
        );
        return Some(note);
    }
    note.push_str(&format!(
        " {} tool call(s) were dispatched with no recorded outcome, so their effects may or may \
         not have landed. Verify before repeating them:",
        state.unfinished.len()
    ));
    for call in &state.unfinished {
        match &call.resource {
            Some(resource) => note.push_str(&format!("\n  - {} {resource}", call.tool)),
            None => note.push_str(&format!("\n  - {}", call.tool)),
        }
    }
    Some(note)
}

pub fn cli_runs_list() -> Result<(), String> {
    let store = store();
    let runs = store.list().map_err(|e| e.to_string())?;
    if runs.is_empty() {
        println!("No recorded runs under {}", store.root().display());
        return Ok(());
    }
    for run in runs {
        // One unreadable record must not hide every other run.
        match store.load_for_resume(&run) {
            Ok(record) => println!("{}", summarize(&record)),
            Err(error) => println!("{run}  <unreadable: {error}>"),
        }
    }
    Ok(())
}

pub fn cli_runs_show(run: &str) -> Result<(), String> {
    let (record, events) = load(run).map_err(describe)?;
    for line in replay_lines(&record, &events) {
        println!("{line}");
    }
    if record.status == RunStatus::Interrupted {
        for line in recovery_lines(&recovery(&events)) {
            println!("{line}");
        }
    }
    Ok(())
}

pub fn cli_runs_export(run: &str) -> Result<(), String> {
    let (record, events) = load(run).map_err(describe)?;
    let value = export_value(&record, &events).map_err(|e| e.to_string())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?
    );
    Ok(())
}

/// Turns a lookup failure into something a user can act on.
fn describe(error: HarnessError) -> String {
    match error.kind() {
        ErrorKind::NotFound => {
            format!("{error}\nRun `jan cli agent runs list` to see recorded runs.")
        }
        ErrorKind::InvalidInput => {
            format!("{error}\nRun ids look like `run_abc123`; `jan cli agent runs list` shows them.")
        }
        _ => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jan_agent_harness::event::{PermissionDecision, ToolOutcome, Usage};
    use jan_agent_harness::fixtures::identity;
    use jan_agent_harness::state::RunStatus;

    fn record() -> RunRecord {
        RunRecord::started(identity(), "test-model", false)
    }

    fn event(seq: u64, payload: EventPayload) -> HarnessEvent {
        HarnessEvent::at(seq, 1_700_000_000_000, identity(), payload)
    }

    #[test]
    fn a_replay_leads_with_what_the_run_was() {
        let lines = replay_lines(&record(), &[]);
        assert!(lines[0].starts_with("run     run_"));
        assert!(lines.iter().any(|l| l.contains("test-model")));
        assert!(lines.iter().any(|l| l.contains("(no events recorded)")));
    }

    #[test]
    fn every_event_renders_on_one_line() {
        let payloads = vec![
            EventPayload::RunStarted { model: "m".into(), plan_mode: true },
            EventPayload::RunFinished { outcome: ToolOutcome::Ok },
            EventPayload::TurnStarted { turn: 0 },
            EventPayload::TurnFinished {
                turn: 0,
                usage: Usage { prompt_tokens: 10, completion_tokens: 2 },
            },
            EventPayload::ToolCalled {
                call_id: "c".into(),
                tool: "bash".into(),
                resource: Some("git status".into()),
                fingerprint: "f".into(),
            },
            EventPayload::PermissionRequested {
                call_id: "c".into(),
                tool: "bash".into(),
                resource: None,
            },
            EventPayload::PermissionDecided {
                call_id: "c".into(),
                tool: "bash".into(),
                decision: PermissionDecision::AutoAllowed,
            },
            EventPayload::BudgetCrossed {
                budget: "token_budget".into(),
                spent: 9,
                limit: 5,
                exhausted: true,
            },
            EventPayload::ProgressStalled { repeats: 5, stopped: true },
            EventPayload::Unknown { kind: "from_the_future".into(), raw: serde_json::json!({}) },
        ];
        for (seq, payload) in payloads.into_iter().enumerate() {
            let line = render_event(&event(seq as u64, payload));
            assert_eq!(line.lines().count(), 1, "wrapped: {line}");
            assert!(line.contains(&seq.to_string()));
        }
    }

    #[test]
    fn an_untimed_call_says_so_rather_than_showing_zero() {
        let line = render_event(&event(
            0,
            EventPayload::ToolFinished {
                call_id: "c".into(),
                tool: "read".into(),
                outcome: ToolOutcome::Ok,
                duration_ms: None,
            },
        ));
        assert!(line.contains("(untimed)"), "{line}");
        assert!(!line.contains("0ms"), "{line}");
    }

    #[test]
    fn a_measured_call_shows_its_duration() {
        let line = render_event(&event(
            0,
            EventPayload::ToolFinished {
                call_id: "c".into(),
                tool: "read".into(),
                outcome: ToolOutcome::Ok,
                duration_ms: Some(37),
            },
        ));
        assert!(line.contains("37ms"), "{line}");
    }

    /// A replay that silently skipped what it could not read would misrepresent
    /// the run it is supposed to be evidence of.
    #[test]
    fn an_event_from_a_newer_build_is_named_not_dropped() {
        let line = render_event(&event(
            3,
            EventPayload::Unknown {
                kind: "quantum_entanglement".into(),
                raw: serde_json::json!({ "spooky": true }),
            },
        ));
        assert!(line.contains("quantum_entanglement"));
        assert!(line.contains("not understood"));
    }

    #[test]
    fn the_export_carries_the_record_and_every_event_verbatim() {
        let record = record();
        let events: Vec<HarnessEvent> = (0..3)
            .map(|seq| event(seq, EventPayload::TurnStarted { turn: seq as u32 }))
            .collect();

        let value = export_value(&record, &events).unwrap();
        assert_eq!(value["record"]["model"], "test-model");
        assert_eq!(value["events"].as_array().unwrap().len(), 3);
        // Round-trips: an auditor can feed the export back into the same types.
        let back: Vec<HarnessEvent> = serde_json::from_value(value["events"].clone()).unwrap();
        assert_eq!(back, events);
    }

    /// The whole point of the recorder: a run it wrote can be read back and
    /// shown. Covers the seam between the two -- writer and reader agreeing on
    /// the on-disk layout -- which no test of either half alone can.
    #[test]
    fn a_recorded_run_reads_back_as_a_replay_and_an_export() {
        use crate::core::agent::recorder::RunRecorder;
        use jan_agent_harness::fixtures::TempDir;

        let data = TempDir::new("runs-roundtrip");
        let recorder =
            RunRecorder::open(data.path(), None, None, "test-model", false).expect("opens");
        recorder.emit(EventPayload::RunStarted {
            model: "test-model".into(),
            plan_mode: false,
        });
        recorder.emit(EventPayload::PermissionDecided {
            call_id: "c1".into(),
            tool: "bash".into(),
            decision: PermissionDecision::AutoAllowed,
        });
        recorder.emit(EventPayload::ToolFinished {
            call_id: "c1".into(),
            tool: "bash".into(),
            outcome: ToolOutcome::Ok,
            duration_ms: Some(12),
        });
        recorder.finish(RunStatus::Completed);

        let store = StateStore::new(data.path().join(STATE_DIR));
        let run_id = recorder.identity().run.to_string();
        let (record, events) = load_from(&store, &run_id).expect("the run reads back");

        assert_eq!(record.status, RunStatus::Completed);
        assert_eq!(events.len(), 3);

        let replay = replay_lines(&record, &events).join("\n");
        assert!(replay.contains(&run_id), "{replay}");
        // The line that matters most in an audit: a decision nobody was asked
        // about.
        assert!(replay.contains("DECIDE  bash  AutoAllowed"), "{replay}");
        assert!(replay.contains("12ms"), "{replay}");

        let exported = export_value(&record, &events).expect("exports");
        assert_eq!(exported["events"].as_array().unwrap().len(), 3);
        assert_eq!(exported["record"]["status"], "completed");
    }

    #[test]
    fn a_run_that_was_never_recorded_is_reported_as_missing() {
        use jan_agent_harness::fixtures::TempDir;
        let data = TempDir::new("runs-missing");
        let store = StateStore::new(data.path().join(STATE_DIR));
        let error = load_from(&store, "run_doesnotexist").expect_err("no such run");
        assert_eq!(error.kind(), ErrorKind::NotFound);
        assert!(describe(error).contains("runs list"));
    }

    fn called(seq: u64, call_id: &str, tool: &str, resource: Option<&str>) -> HarnessEvent {
        event(
            seq,
            EventPayload::ToolCalled {
                call_id: call_id.into(),
                tool: tool.into(),
                resource: resource.map(str::to_string),
                fingerprint: "f".into(),
            },
        )
    }

    fn finished(seq: u64, call_id: &str, tool: &str) -> HarnessEvent {
        event(
            seq,
            EventPayload::ToolFinished {
                call_id: call_id.into(),
                tool: tool.into(),
                outcome: ToolOutcome::Ok,
                duration_ms: Some(3),
            },
        )
    }

    /// The question an interrupted run poses: which calls went out without
    /// coming back. A transcript cannot answer it; the event log can.
    #[test]
    fn a_call_without_an_outcome_is_the_one_reported() {
        let events = vec![
            event(0, EventPayload::TurnStarted { turn: 0 }),
            called(1, "c1", "read", Some("a.txt")),
            finished(2, "c1", "read"),
            called(3, "c2", "bash", Some("rm -rf build")),
            // ...and here the process died.
        ];
        let state = recovery(&events);
        assert_eq!(
            state.unfinished,
            vec![UnfinishedCall {
                tool: "bash".into(),
                resource: Some("rm -rf build".into())
            }]
        );
        assert_eq!(state.last_turn_started, Some(0));
        assert_eq!(state.last_turn_finished, None);
    }

    #[test]
    fn a_run_where_every_call_came_back_reports_nothing_outstanding() {
        let events = vec![
            event(0, EventPayload::TurnStarted { turn: 0 }),
            called(1, "c1", "read", Some("a.txt")),
            finished(2, "c1", "read"),
            event(
                3,
                EventPayload::TurnFinished { turn: 0, usage: Usage::default() },
            ),
        ];
        let state = recovery(&events);
        assert!(state.unfinished.is_empty());
        assert_eq!(state.last_turn_finished, Some(0));

        let lines = recovery_lines(&state).join("\n");
        assert!(lines.contains("every dispatched tool call recorded an outcome"), "{lines}");
    }

    #[test]
    fn the_recovery_section_warns_that_effects_may_have_landed() {
        let events = vec![
            event(0, EventPayload::TurnStarted { turn: 2 }),
            called(1, "c1", "write", Some("src/main.rs")),
        ];
        let lines = recovery_lines(&recovery(&events)).join("\n");
        assert!(lines.contains("interrupted"), "{lines}");
        assert!(lines.contains("turn 2 was in flight"), "{lines}");
        assert!(lines.contains("may or may not have landed"), "{lines}");
        assert!(lines.contains("write  src/main.rs"), "{lines}");
    }

    #[test]
    fn a_run_that_died_before_any_turn_says_so() {
        let lines = recovery_lines(&recovery(&[])).join("\n");
        assert!(lines.contains("no turn had started"), "{lines}");
    }

    /// A CLI invocation is never the run's own process, so a record still
    /// reading `Running` means that process never closed it.
    #[test]
    fn a_run_that_never_closed_reads_back_as_interrupted() {
        use crate::core::agent::recorder::RunRecorder;
        use jan_agent_harness::fixtures::TempDir;

        let data = TempDir::new("runs-interrupted");
        let recorder =
            RunRecorder::open(data.path(), None, None, "test-model", false).expect("opens");
        recorder.emit(EventPayload::TurnStarted { turn: 0 });
        recorder.emit(EventPayload::ToolCalled {
            call_id: "c1".into(),
            tool: "bash".into(),
            resource: Some("make install".into()),
            fingerprint: "f".into(),
        });
        recorder.persist();
        let run_id = recorder.identity().run.to_string();
        drop(recorder); // the process dies without finishing

        let store = StateStore::new(data.path().join(STATE_DIR));
        let (record, events) = load_from(&store, &run_id).expect("reads back");
        assert_eq!(record.status, RunStatus::Interrupted);

        let state = recovery(&events);
        assert_eq!(
            state.unfinished,
            vec![UnfinishedCall {
                tool: "bash".into(),
                resource: Some("make install".into())
            }]
        );
    }

    /// Recording a run, killing the process, then resuming its thread: the new
    /// run has to be told what the old one left in doubt.
    #[test]
    fn a_resumed_thread_is_handed_the_calls_that_never_came_back() {
        use crate::core::agent::recorder::RunRecorder;
        use jan_agent_harness::fixtures::TempDir;

        let data = TempDir::new("runs-handoff");
        let thread = "6f1b8c2e-0000-4000-8000-000000000000";
        let recorder =
            RunRecorder::open(data.path(), Some(thread), None, "m", false).expect("opens");
        recorder.emit(EventPayload::TurnStarted { turn: 4 });
        recorder.emit(EventPayload::ToolCalled {
            call_id: "c1".into(),
            tool: "write".into(),
            resource: Some("src/main.rs".into()),
            fingerprint: "f".into(),
        });
        recorder.persist();
        drop(recorder); // the process dies mid-turn

        let store = StateStore::new(data.path().join(STATE_DIR));
        let note = interrupted_handoff(&store, thread).expect("a handoff note");

        assert!(note.contains("interrupted run"), "{note}");
        assert!(note.contains("Turn 4 was in flight"), "{note}");
        assert!(note.contains("may or may not have landed"), "{note}");
        assert!(note.contains("write src/main.rs"), "{note}");
        assert!(note.contains("Verify before repeating"), "{note}");
    }

    #[test]
    fn a_thread_with_no_interrupted_run_gets_no_note() {
        use crate::core::agent::recorder::RunRecorder;
        use jan_agent_harness::fixtures::TempDir;

        let data = TempDir::new("runs-handoff-clean");
        let thread = "clean-thread";
        let recorder =
            RunRecorder::open(data.path(), Some(thread), None, "m", false).expect("opens");
        recorder.finish(RunStatus::Completed);

        let store = StateStore::new(data.path().join(STATE_DIR));
        assert!(interrupted_handoff(&store, thread).is_none());
        // ...and a thread that has never run gets nothing either.
        assert!(interrupted_handoff(&store, "never-seen").is_none());
    }

    /// An interrupted run on someone else's conversation must not leak into
    /// this one -- it would describe files this thread never touched.
    #[test]
    fn an_interrupted_run_on_another_thread_is_not_handed_over() {
        use crate::core::agent::recorder::RunRecorder;
        use jan_agent_harness::fixtures::TempDir;

        let data = TempDir::new("runs-handoff-isolation");
        let other =
            RunRecorder::open(data.path(), Some("thread-a"), None, "m", false).expect("opens");
        other.emit(EventPayload::ToolCalled {
            call_id: "c1".into(),
            tool: "bash".into(),
            resource: Some("rm -rf /tmp/a".into()),
            fingerprint: "f".into(),
        });
        other.persist();
        drop(other);

        let store = StateStore::new(data.path().join(STATE_DIR));
        assert!(interrupted_handoff(&store, "thread-b").is_none());
        assert!(interrupted_handoff(&store, "thread-a").is_some());
    }

    #[test]
    fn a_summary_line_names_the_run_its_status_and_its_model() {
        let mut record = record();
        record.finish(RunStatus::Cancelled);
        let line = summarize(&record);
        assert!(line.contains(record.identity.run.as_str()));
        assert!(line.contains("cancelled"));
        assert!(line.contains("test-model"));
    }

    #[test]
    fn a_malformed_run_id_is_explained_rather_than_echoed() {
        let message = describe(HarnessError::new(ErrorKind::InvalidInput, "bad id"));
        assert!(message.contains("runs list"), "{message}");
    }

    #[test]
    fn short_ids_are_padded_so_events_line_up() {
        assert_eq!(short_id("agt_abcdef").len(), 6);
        assert_eq!(short_id("ab").len(), 6);
    }
}
