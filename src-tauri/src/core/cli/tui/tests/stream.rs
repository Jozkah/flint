//! Moved verbatim out of `tui/tests.rs`.

use super::*;

/// P2C-018: snapshots that queue behind a slow write collapse to the newest
/// per thread, and every flush in the batch is still answered.
#[test]
fn queued_thread_snapshots_collapse_to_the_newest_per_thread() {
    use crate::core::cli::tui::stream::{coalesce_saves, ThreadSave, ThreadSaveJob};
    let save = |id: &str, n: usize| {
        ThreadSaveJob::Save(ThreadSave {
            base: std::path::PathBuf::from("agent"),
            id: id.to_string(),
            model: "m".to_string(),
            history: vec![serde_json::json!(n); n],
            metadata: None,
        })
    };
    let (flush_tx, _flush_rx) = std::sync::mpsc::channel();
    let (saves, flushes) = coalesce_saves(vec![
        save("t1", 1),
        save("t2", 1),
        ThreadSaveJob::Flush(flush_tx),
        save("t1", 3),
    ]);
    assert_eq!(flushes.len(), 1);
    assert_eq!(saves.len(), 2);
    assert_eq!(saves[0].id, "t2");
    assert_eq!(saves[1].id, "t1");
    assert_eq!(saves[1].history.len(), 3, "the newest snapshot of t1");
}

#[test]
fn steering_failed_handoff_keeps_input_for_next_turn() {
    let mut app = test_app();
    app.submit_user("start".into());
    app.want_start = false;
    app.submit_user("late follow-up".into());
    let (request, receiver) = steering_request(app.history.clone());
    drop(receiver);
    app.steer_run(request);
    assert_eq!(app.message_queue.len(), 1);
    assert_eq!(app.history.len(), 1);
    app.on_done("stop".into(), None);
    assert!(app.message_queue.is_empty());
    assert_eq!(app.history.last().unwrap()["content"], "late follow-up");
    assert!(app.want_start);
}

#[tokio::test]
async fn steering_waits_until_earlier_stream_events_are_rendered() {
    let (tx, rx) = mpsc::unbounded_channel();
    let (steering_tx, steering) = mpsc::unbounded_channel();
    tx.send(StreamEvent::Token {
        text: "answer".into(),
    })
    .unwrap();
    let (request, _receiver) = steering_request(vec![]);
    steering_tx.send(request).unwrap();
    let mut current = Some(CurrentRun {
        rx,
        steering,
        handle: tokio::spawn(async {}),
    });
    assert!(matches!(
        next_event(&mut current).await,
        RunEvent::Stream(Some(StreamEvent::Token { .. }))
    ));
    assert!(matches!(
        next_event(&mut current).await,
        RunEvent::Steering(_)
    ));
}

/// #63: a mid-turn `MessagesUpdated` on an existing thread is saved by
/// the background saver, not inline in the render loop, and still reaches
/// disk (in order) once the saver is flushed.
#[tokio::test]
async fn mid_turn_messages_updated_saves_off_the_render_loop() {
    let mut app = test_app();
    app.submit_user("first".into());
    app.persist();
    assert!(app.thread_id.is_some(), "first save assigns the id");
    assert!(app.thread_saver.is_none(), "first save runs inline");

    for text in ["step one", "step two"] {
        app.apply(StreamEvent::MessagesUpdated {
            messages: vec![
                json!({ "role": "user", "content": "first" }),
                json!({ "role": "assistant", "content": text }),
            ],
        });
    }
    assert!(
        app.thread_saver.is_some(),
        "a mid-turn save must go through the background saver"
    );
    app.join_journal();

    let mut restored = test_app();
    restored.agent_dir = app.agent_dir.clone();
    apply_resume(&mut restored, &ResumeRequest::resume(ResumeTarget::Latest)).await;
    let last = restored.history.last().expect("history restored");
    assert_eq!(last["content"], "step two", "newest snapshot wins");
}

/// The boxed diff panel is re-drawn at the current width, so its right
/// border still lands inside the frame after a shrink.
#[test]
fn a_committed_diff_panel_reboxes_on_resize() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "e1".into(),
        name: "edit".into(),
        args: json!({"path": "src/main.rs"}),
    });
    app.apply(StreamEvent::ToolResult {
        id: "e1".into(),
        content: "edited".into(),
        is_error: false,
        diff: Some("@@ edit 1/1 @@\n-    let value = compute_something_long(1, 2, 3);\n+    let value = compute_something_much_longer(1, 2, 3, 4);".into()),
    });
    let border_width = |rows: &[String]| {
        rows.iter()
            .find(|r| r.contains('┌'))
            .map(|r| r.trim_end().chars().count())
            .expect("no diff panel")
    };
    let wide = border_width(&render_rows(&mut app, 100, 24));
    let narrow_rows = render_rows(&mut app, 50, 24);
    let narrow = border_width(&narrow_rows);
    assert!(
        narrow < wide,
        "panel kept its old width: {narrow} vs {wide}"
    );
    assert!(narrow <= 50, "panel overflows the frame: {narrow}");
    // Every panel row still closes inside the frame, so the box reads as a box.
    for row in narrow_rows.iter().filter(|r| r.contains('│')) {
        assert!(
            row.trim_end().chars().count() <= 50,
            "row overflows: {row:?}"
        );
    }
}

/// A standalone diff row already names the file in past tense, so the
/// tool's own "Applied N edit(s) to <path>" summary must not repeat it.
#[test]
fn standalone_diff_result_drops_the_redundant_summary_line() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "e1".into(),
        name: "edit".into(),
        args: json!({"path": "src/core/cli/tui.rs"}),
    });
    app.apply(StreamEvent::ToolResult {
        id: "e1".into(),
        content: "Applied 1 edit(s) to src/core/cli/tui.rs".into(),
        is_error: false,
        diff: Some("@@ edit 1/1 @@\n-a\n+b".into()),
    });
    let rows = render_rows(&mut app, 100, 24);
    assert!(
        rows.iter().any(|r| r.contains("Edited tui.rs")),
        "call row lost: {rows:?}"
    );
    assert!(
        !rows.iter().any(|r| r.contains("Applied 1 edit(s)")),
        "duplicate summary line: {rows:?}"
    );
    assert!(
        rows.iter().any(|r| r.contains('┌')),
        "diff panel lost: {rows:?}"
    );
}

/// A failed edit's row only says "Edited <file>" with a cross, so the error
/// text is the only place the reason survives and must still render.
#[test]
fn failed_diff_result_keeps_its_error_text() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "e1".into(),
        name: "edit".into(),
        args: json!({"path": "src/main.rs"}),
    });
    app.apply(StreamEvent::ToolResult {
        id: "e1".into(),
        content: "ERROR: src/main.rs: edit 1: old_string not found".into(),
        is_error: true,
        diff: None,
    });
    let rows = render_rows(&mut app, 100, 24);
    assert!(
        rows.iter().any(|r| r.contains("old_string not found")),
        "error text lost: {rows:?}"
    );
}

/// A tool row's label is stored untruncated and laid out at draw time: it
/// wraps onto as many rows as the width needs, and re-packs onto fewer when
/// the terminal widens.
#[test]
fn tool_row_labels_rewrap_on_resize() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "t1".into(),
        name: "bash".into(),
        args: json!({"command": "echo the quick brown fox jumps over the lazy dog"}),
    });
    app.apply(StreamEvent::ToolResult {
        id: "t1".into(),
        content: "ok".into(),
        is_error: false,
        diff: None,
    });
    // Close the group so its row reads as the finished command, not the
    // live "running 1 command" throbber.
    app.finalize_tool_group();
    // The label's rows, stripped of gutter and tag and joined back into the
    // text they display.
    let label = |rows: &[String], width: usize| {
        let start = rows
            .iter()
            .position(|r| r.contains("Ran: echo"))
            .expect("no tool row");
        let body: Vec<String> = rows[start..]
            .iter()
            .take_while(|r| r.starts_with('│') && r.trim_end() != "│")
            .map(|r| {
                assert!(
                    r.trim_end().chars().count() <= width,
                    "row overflows: {r:?}"
                );
                r.trim_end().trim_start_matches(['│', ' ', '✓']).to_string()
            })
            .collect();
        (body.len(), body.join(" "))
    };
    let (narrow_rows, narrow) = label(&render_rows(&mut app, 40, 12), 40);
    let (wide_rows, wide) = label(&render_rows(&mut app, 100, 12), 100);
    let full = "Ran: echo the quick brown fox jumps over the lazy dog";
    assert_eq!(narrow, full, "narrow layout dropped text");
    assert_eq!(wide, full, "wide layout dropped text");
    assert!(
        narrow_rows > wide_rows,
        "label did not re-pack when widened: {narrow_rows} vs {wide_rows}"
    );
}

/// A multi-line command keeps its breaks in the transcript row: the label
/// is not flattened onto one line, and the row is not one wide `Line` whose
/// newlines ratatui swallows.
#[test]
fn multiline_command_label_keeps_its_line_breaks() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "t1".into(),
        name: "bash".into(),
        args: json!({"command": "cd /tmp\ncargo build\ncargo test"}),
    });
    app.apply(StreamEvent::ToolResult {
        id: "t1".into(),
        content: "ok".into(),
        is_error: false,
        diff: None,
    });
    app.finalize_tool_group();
    let rows = render_rows(&mut app, 80, 16);
    let has = |needle: &str| rows.iter().any(|r| r.trim_end().ends_with(needle));
    assert!(has("Ran: cd /tmp"), "first command line missing: {rows:?}");
    assert!(has("cargo build"), "second command line missing: {rows:?}");
    assert!(has("cargo test"), "third command line missing: {rows:?}");
}

/// A tool label wraps, but a pathological one (a pasted heredoc body) is
/// bounded so it cannot push the conversation off screen.
#[test]
fn tool_label_wrapping_is_bounded() {
    let mut app = test_app();
    let command = (0..40)
        .map(|i| format!("echo line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    app.apply(StreamEvent::ToolCall {
        id: "t1".into(),
        name: "bash".into(),
        args: json!({ "command": command }),
    });
    app.finalize_tool_group();
    let rendered = app.transcript.last().expect("no row").lines(80);
    assert_eq!(
        rendered.len(),
        super::super::TOOL_ROW_MAX_LINES,
        "label was not bounded"
    );
    let last: String = rendered[super::super::TOOL_ROW_MAX_LINES - 1]
        .spans
        .iter()
        .map(|s| s.content.as_ref())
        .collect();
    assert!(
        last.ends_with('\u{2026}'),
        "elision was not marked: {last:?}"
    );
}

/// The expanded (Ctrl-O) view is where the full output lives, so a line
/// wider than the terminal wraps there instead of eliding.
#[test]
fn expanded_group_detail_wraps_instead_of_eliding() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "t1".into(),
        name: "bash".into(),
        args: json!({"command": "cat notes"}),
    });
    let long = "alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima";
    app.apply(StreamEvent::ToolResult {
        id: "t1".into(),
        content: long.into(),
        is_error: false,
        diff: None,
    });
    app.finalize_tool_group();
    let group = app.groups.last().expect("no group");
    let text: String = super::super::group_detail_lines(group, 40)
        .iter()
        .flat_map(|line| line.spans.iter())
        .map(|s| s.content.as_ref())
        .collect::<String>();
    assert!(!text.contains('\u{2026}'), "detail elided: {text:?}");
    for word in long.split(' ') {
        assert!(text.contains(word), "detail dropped {word:?}: {text:?}");
    }
}

/// A long option label and its description wrap inside the ask box, and the
/// box grows to hold them rather than clipping.
#[test]
fn ask_options_wrap_and_size_the_box() {
    let mut app = test_app();
    let request = crate::core::agent::interaction::AskRequest::parse(&json!({
        "questions": [{
            "id": "scope",
            "question": "Which of these two rather long scopes should the agent take on next?",
            "options": [
                {"label": "A thoroughly long option label that cannot fit one row",
                 "description": "and a description that is longer still, needing rows of its own"},
                {"label": "Short"}
            ],
            "multi": false
        }]
    }))
    .expect("valid ask request");
    app.apply(StreamEvent::AskRequest {
        request_id: "r1".into(),
        request,
        timeout_secs: None,
    });
    let rows = render_rows(&mut app, 50, 30);
    let joined = rows.join("\n");
    for word in ["thoroughly", "fit one row", "longer still", "Short"] {
        assert!(joined.contains(word), "ask box clipped {word:?}:\n{joined}");
    }
    for row in &rows {
        assert!(row.chars().count() <= 50, "row overflows: {row:?}");
    }
}

/// Degenerate frames (a sliver of a terminal mid-drag) must render, not panic.
#[test]
fn tiny_frames_render_without_panicking() {
    let mut app = test_app();
    app.push_user_line("hello", &[]);
    app.push_assistant_blocks(
        "| a | b |\n|---|---|\n| 1 | 2 |\n\n```rs\nlet x = 1;\n```",
        &[],
        None,
    );
    app.apply(StreamEvent::ToolResult {
        id: "x".into(),
        content: "done".into(),
        is_error: false,
        diff: Some("@@ edit 1/1 @@\n-a\n+b".into()),
    });
    let sizes = [(1, 1), (2, 3), (8, 4), (20, 6), (40, 2), (200, 80)];
    for (w, h) in sizes {
        render_rows(&mut app, w, h);
    }
    // The permission prompt grows upward from the input dock and sizes its
    // diff preview from the frame, so it is the overlay most exposed to a
    // frame that has just shrunk out from under it.
    let mut p = pending(true);
    p.diff = Some("@@ edit 1/1 @@\n-old line of code\n+new line of code".into());
    p.path = Some("src/main.rs".into());
    app.pending_queue.push_back(p);
    for (w, h) in sizes {
        render_rows(&mut app, w, h);
    }
}

/// A write the credential scan flagged is put to the person with where and
/// which rule, offers "Write anyway" and "Deny" only (no "always", even if
/// the event claimed one), and names no value.
#[test]
fn a_secret_write_prompt_offers_write_anyway_and_deny_only() {
    let mut app = test_app();
    app.apply(StreamEvent::PermissionRequest {
        request_id: "s1".into(),
        tool_name: "write".into(),
        capability: "write".into(),
        path: Some("lib/env.ts".into()),
        command: None,
        diff: Some("@@ -0,0 +1,2 @@
+const a = 1".into()),
        patch: None,
        prompt_kind: "secret".into(),
        offers_always: true,
        reason: Some(
            "This write looks like it contains a secret: lib/env.ts:2 rule \"API key\" matched `export const k = \"[redacted]\"`. \"Write anyway\" writes it this one time."
                .into(),
        ),
        args_digest: None,
        call_id: None,
    });
    let p = app.pending().unwrap();
    let labels: Vec<_> = p.options().into_iter().map(|(_, l)| l).collect();
    assert_eq!(labels, vec!["Write anyway", "Deny"]);
    assert!(!p.offers_always);
    let text: String = p
        .detail_lines(200)
        .iter()
        .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>())
        .collect::<Vec<_>>()
        .join("
");
    assert!(text.contains("lib/env.ts"), "{text}");
    assert!(text.contains("This write looks like it contains a secret"), "{text}");
    assert!(text.contains("API key"), "{text}");
    assert!(!text.contains("AKIA"), "{text}");
    let rows = render_rows(&mut app, 100, 30).join("
");
    assert!(rows.contains("Write anyway"), "{rows}");
}

#[test]
fn write_permission_prompt_carries_diff_into_pending() {
    let mut app = test_app();
    app.apply(StreamEvent::PermissionRequest {
        request_id: "w1".into(),
        tool_name: "write".into(),
        capability: "write".into(),
        path: Some("out.txt".into()),
        command: None,
        diff: Some("@@ created file @@\n+ hi".into()),
        patch: None,
        prompt_kind: "write".into(),
        offers_always: true,
        reason: None,
        args_digest: None,
        call_id: None,
    });
    let p = app.pending().unwrap();
    assert_eq!(p.diff.as_deref(), Some("@@ created file @@\n+ hi"));
    let preview = p.diff_preview(60);
    assert!(preview.len() >= 4, "boxed diff expected, got {preview:?}");
    let text: String = preview.iter().map(line_text).collect();
    assert!(
        text.contains('┌') && text.contains('┘'),
        "no box frame: {text}"
    );
    assert!(text.contains("+ hi"), "diff content missing: {text}");
}

#[test]
fn exec_permission_prompt_has_no_diff_preview() {
    let mut app = test_app();
    app.apply(StreamEvent::PermissionRequest {
        request_id: "e1".into(),
        tool_name: "bash".into(),
        capability: "exec".into(),
        path: None,
        command: Some("ls".into()),
        diff: None,
        patch: None,
        prompt_kind: "exec".into(),
        offers_always: true,
        reason: None,
        args_digest: None,
        call_id: None,
    });
    assert!(app.pending().unwrap().diff_preview(60).is_empty());
}

#[test]
fn ask_resolved_dismisses_only_the_matching_prompt() {
    let mut app = test_app();
    app.apply(StreamEvent::AskRequest {
        request_id: "keep".into(),
        request: ask_request(false, false),
        timeout_secs: None,
    });
    app.apply(StreamEvent::AskRequest {
        request_id: "gone".into(),
        request: ask_request(false, false),
        timeout_secs: None,
    });
    assert_eq!(app.ask_queue.len(), 2);

    app.apply(StreamEvent::AskResolved {
        request_id: "gone".into(),
    });
    assert_eq!(
        app.ask_queue.len(),
        1,
        "only the timed-out prompt is dropped"
    );
    assert_eq!(app.ask_queue.front().unwrap().request_id, "keep");
}

#[tokio::test]
async fn ask_paste_event_does_not_leak_during_option_selection() {
    let mut app = test_app();
    let registry = crate::core::agent::interaction::new_registry();
    let (request_id, _receiver) = crate::core::agent::interaction::register(&registry).await;
    app.apply(StreamEvent::AskRequest {
        request_id,
        request: ask_request(false, false),
        timeout_secs: None,
    });

    route_paste_event(&mut app, Event::Paste("must not become chat".into()));

    assert!(app.ask_queue.front().unwrap().custom_input.is_empty());
    assert!(app.input.is_empty(), "paste leaked into chat composer");
}

/// The gate reaches the App: a turn whose content carries tags commits them
/// as ordinary prose, with no reasoning block folded out of the transcript.
#[test]
fn think_tags_gate_off_commits_tagged_content_as_one_answer() {
    without_think_tags(|| {
        let mut app = test_app();
        app.submit_user("go".into());
        app.apply(StreamEvent::Token {
            text: "<think>ponder</think>Answer.".into(),
        });
        app.on_done("stop".into(), None);
        assert!(
            app.reasoning_blocks.is_empty(),
            "nothing may fold with the gate off"
        );
        let last = app.history.last().expect("assistant turn in history");
        assert_eq!(last["content"], "<think>ponder</think>Answer.");
    });
}

/// Several reasoning blocks in one turn must not all show the same turn-wide
/// duration: per-block timing is not tracked, so each falls back to a plain
/// `Thought` rather than stamping the total on every one.
#[test]
fn multiple_reasoning_blocks_drop_the_shared_duration() {
    let mut app = test_app();
    app.apply(StreamEvent::Token {
        text: "<think>first thought</think>one<think>second thought</think>two".into(),
    });
    // Force a measurable duration so a single block would read "Thought for Ns".
    app.thinking_since =
        Some(std::time::Instant::now() - std::time::Duration::from_secs(2));
    app.flush_assistant();
    let text = transcript_text(&app);
    assert!(text.contains("Thought"), "reasoning summaries present: {text}");
    assert!(
        !text.contains("Thought for"),
        "a shared duration was stamped on multiple blocks: {text}"
    );
}

#[test]
fn toggle_expands_and_collapses_all_regions_at_once() {
    let mut app = test_app();
    // Two reasoning blocks and two tool groups interleaved across turns.
    app.apply(StreamEvent::Token {
        text: "<think>a</think>".into(),
    });
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "ls" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "ok".into(),
        is_error: false,
        diff: None,
    });
    app.apply(StreamEvent::Token {
        text: "<think>b</think>".into(),
    });
    app.apply(StreamEvent::ToolCall {
        id: "c2".into(),
        name: "bash".into(),
        args: json!({ "command": "pwd" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c2".into(),
        content: "ok".into(),
        is_error: false,
        diff: None,
    });
    app.on_done("stop".into(), None);
    assert_eq!(app.reasoning_blocks.len(), 2);
    assert_eq!(app.groups.len(), 2);

    // One toggle expands every region.
    app.toggle_regions();
    let all: std::collections::HashSet<usize> = app
        .groups
        .iter()
        .map(|g| g.idx)
        .chain(app.reasoning_blocks.iter().map(|r| r.idx))
        .collect();
    assert_eq!(app.expanded, all);

    // A second toggle collapses them all.
    app.toggle_regions();
    assert!(app.expanded.is_empty());
}

/// End to end: the command a job was started with reaches the poll's row.
#[tokio::test]
async fn a_polled_job_row_names_the_command_it_was_started_with() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "cargo build --release", "timeout": 1 }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "Command exceeded 1s and is continuing in the background \
                      (job_id=bash-1). Call bash again with {\"job_id\": \"bash-1\"}."
            .into(),
        is_error: false,
        diff: None,
    });
    app.apply(StreamEvent::ToolCall {
        id: "c2".into(),
        name: "bash".into(),
        args: json!({ "job_id": "bash-1" }),
    });

    let text: String = app
        .transcript
        .iter()
        .map(row_text)
        .chain(std::iter::once(
            app.tool_group
                .as_ref()
                .map(|g| g.calls.iter().map(|c| c.activity.clone()).collect())
                .unwrap_or_default(),
        ))
        .collect();
    assert!(
        text.contains("Waiting for: cargo build --release"),
        "the poll row does not name its command: {text}"
    );
}

/// A running command is a terminal from the moment it starts: the boxed
/// prompt appears immediately, before any output, and each chunk streams into
/// the box as it is produced.
#[test]
fn a_running_command_shows_its_output_live() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "t1".into(),
        name: "bash".into(),
        args: json!({ "command": "make" }),
    });
    // The box opens right away, framed, before a single line is printed.
    let opening = render_rows(&mut app, 70, 16).join("\n");
    assert!(opening.contains("$ make"), "box opens immediately: {opening}");
    assert!(opening.contains('\u{250c}'), "framed: {opening}");

    app.apply(StreamEvent::ToolOutputDelta {
        id: "t1".into(),
        delta: "compiling foo\n".into(),
    });
    app.apply(StreamEvent::ToolOutputDelta {
        id: "t1".into(),
        delta: "compiling bar\n".into(),
    });
    let live = render_rows(&mut app, 70, 16).join("\n");
    assert!(
        live.contains("$ make"),
        "command on the prompt line: {live}"
    );
    assert!(live.contains("compiling foo"), "first chunk: {live}");
    assert!(live.contains("compiling bar"), "and the next: {live}");
    assert!(live.contains('\u{250c}'), "framed: {live}");
}

/// A streamed bash call types into a terminal box while the arguments
/// stream, then the full `ToolCall` swaps it for the running box -- no plain
/// throbber at any point, and the typing status must not linger.
#[test]
fn streamed_bash_call_types_then_runs_in_the_terminal() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCallStarted {
        id: "c1".into(),
        name: "bash".into(),
    });
    app.apply(StreamEvent::ToolCallArgsDelta {
        id: "c1".into(),
        delta: "{\"command\":\"make\"}".into(),
    });
    let typing = render_rows(&mut app, 70, 16).join("\n");
    assert!(!typing.contains("Preparing"), "no plain throbber: {typing}");
    assert!(typing.contains("$ make"), "command types into the box: {typing}");
    assert!(typing.contains("typing"), "typing status while streaming: {typing}");

    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "make" }),
    });
    let live = render_rows(&mut app, 70, 16).join("\n");
    assert!(live.contains("$ make"), "the same box now runs: {live}");
    assert!(
        !live.contains("typing"),
        "the status flips off typing once the command runs: {live}"
    );
}

/// The reported bug: a provider that announces the streaming call under one
/// id and assembles the final call under another left the in-flight display
/// on screen through the whole command. Any `ToolCall` means streaming is
/// over, so a stale throbber must clear regardless of its id.
#[test]
fn a_stale_throbber_clears_on_a_tool_call_with_a_different_id() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCallStarted {
        id: "stream-1".into(),
        name: "bash".into(),
    });
    app.apply(StreamEvent::ToolCallArgsDelta {
        id: "stream-1".into(),
        delta: "{\"command\":\"sleep 1\"}".into(),
    });
    let typing = render_rows(&mut app, 70, 16).join("\n");
    assert!(typing.contains("$ sleep 1"), "the in-flight box shows: {typing}");

    app.apply(StreamEvent::ToolCall {
        id: "final-1".into(),
        name: "bash".into(),
        args: json!({ "command": "make" }),
    });
    let live = render_rows(&mut app, 70, 16).join("\n");
    assert!(
        !live.contains("sleep 1"),
        "the stale in-flight box clears despite the id mismatch: {live}"
    );
    assert!(live.contains("$ make"), "the running command's box shows: {live}");
}

/// The terminal box replaces the plain "Executing:" activity row entirely,
/// from the first frame, so the command is never shown twice; the spinner and
/// elapsed fold into the box.
#[test]
fn the_live_terminal_replaces_the_executing_row() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "t1".into(),
        name: "bash".into(),
        args: json!({ "command": "make" }),
    });
    let live = render_rows(&mut app, 70, 16).join("\n");
    assert!(live.contains("$ make"), "terminal box from the start: {live}");
    assert!(live.contains('\u{250c}'), "framed: {live}");
    assert!(
        !live.contains("Executing: make"),
        "the activity row is replaced, not duplicated: {live}"
    );
    // Elapsed folds into the box (0s at render time), with the spinner.
    assert!(live.contains("0s"), "elapsed in the box: {live}");
}

/// Parallel commands in one group each stream in their own terminal box, so
/// a second command never hides an older one still running.
#[test]
fn parallel_bash_calls_each_get_a_terminal_box() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "make" }),
    });
    app.apply(StreamEvent::ToolCall {
        id: "c2".into(),
        name: "bash".into(),
        args: json!({ "command": "cargo test" }),
    });
    app.apply(StreamEvent::ToolOutputDelta {
        id: "c1".into(),
        delta: "compiling foo\n".into(),
    });
    app.apply(StreamEvent::ToolOutputDelta {
        id: "c2".into(),
        delta: "running 3 tests\n".into(),
    });
    let live = render_rows(&mut app, 80, 30).join("\n");
    assert!(live.contains("$ make"), "first command box: {live}");
    assert!(live.contains("compiling foo"), "first command output: {live}");
    assert!(live.contains("$ cargo test"), "second command box: {live}");
    assert!(live.contains("running 3 tests"), "second command output: {live}");
    assert!(
        live.matches('\u{250c}').count() >= 2,
        "one box per command: {live}"
    );

    // When the first finishes, only the still-running one keeps its box.
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "compiling foo\n[exit 0]".into(),
        is_error: false,
        diff: None,
    });
    let live = render_rows(&mut app, 80, 30).join("\n");
    assert!(!live.contains("$ make"), "the finished command folds away: {live}");
    assert!(live.contains("$ cargo test"), "the running one stays boxed: {live}");
}

/// The result is the authoritative output, so the live buffer is released
/// with it -- a long session must not accumulate every command it ran.
#[test]
fn a_finished_command_releases_its_live_buffer() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "t1".into(),
        name: "bash".into(),
        args: json!({ "command": "make" }),
    });
    app.apply(StreamEvent::ToolOutputDelta {
        id: "t1".into(),
        delta: "compiling foo\n".into(),
    });
    app.apply(StreamEvent::ToolResult {
        id: "t1".into(),
        content: "compiling foo\n[exit 0]".into(),
        is_error: false,
        diff: None,
    });
    assert!(
        !app.live_output.contains_key("t1"),
        "the finished call still holds its buffer"
    );
}

/// A group runs its calls in parallel, so the panel follows the call that is
/// actually printing. Keying it to the newest unresolved call instead made a
/// `read` issued after a long `bash` blank the box until the read landed.
#[test]
fn a_later_call_does_not_blank_the_live_panel() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "t1".into(),
        name: "bash".into(),
        args: json!({ "command": "make" }),
    });
    app.apply(StreamEvent::ToolOutputDelta {
        id: "t1".into(),
        delta: "compiling foo\n".into(),
    });
    app.apply(StreamEvent::ToolCall {
        id: "t2".into(),
        name: "read".into(),
        args: json!({ "path": "src/main.rs" }),
    });
    let live = render_rows(&mut app, 70, 18).join("\n");
    assert!(
        live.contains("compiling foo"),
        "the streaming call keeps the panel: {live}"
    );
}

/// The wait on a backgrounded job is the case the live view matters most for.
/// The job streams under the id of the call that *started* it while the user
/// watches the later call that *collects* it, so the two are aliased.
#[test]
fn waiting_on_a_backgrounded_job_shows_its_live_output() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "t1".into(),
        name: "bash".into(),
        args: json!({ "command": "cargo test" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "t1".into(),
        content: "Command exceeded 30s and is continuing in the background \
                      (job_id=bash-7)."
            .into(),
        is_error: false,
        diff: None,
    });
    // Backgrounded, so the buffer survives its own result.
    app.apply(StreamEvent::ToolOutputDelta {
        id: "t1".into(),
        delta: "test tui::rolls ... ok\n".into(),
    });
    app.apply(StreamEvent::ToolCall {
        id: "t2".into(),
        name: "bash".into(),
        args: json!({ "job_id": "bash-7" }),
    });
    assert_eq!(
        app.live_alias.get("t2").map(String::as_str),
        Some("t1"),
        "the collecting call is aliased to the job's origin"
    );
    app.apply(StreamEvent::ToolOutputDelta {
        id: "t1".into(),
        delta: "test tui::folds ... ok\n".into(),
    });
    let live = render_rows(&mut app, 74, 20).join("\n");
    assert!(
        live.contains("test tui::folds ... ok"),
        "the waiting row reports the job's progress: {live}"
    );
}

/// A runaway command must not grow the TUI's memory without bound.
#[test]
fn live_output_is_bounded() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolOutputDelta {
        id: "t1".into(),
        delta: "x".repeat(super::super::LIVE_OUTPUT_MAX_BYTES * 2),
    });
    let held = app.live_output.get("t1").expect("buffered").len();
    assert!(held <= super::super::LIVE_OUTPUT_MAX_BYTES, "kept {held} bytes");
}

#[tokio::test]
async fn esc_stops_the_open_tool_group_throbber() {
    let mut app = test_app();
    app.status = Status::Running;
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "sleep 60" }),
    });
    assert!(app.tool_group.as_ref().is_some_and(|g| g.is_running()));
    press_esc(&mut app).await;
    assert_eq!(app.status, Status::Idle);
    let rows = render_rows(&mut app, 60, 30);
    let spinning: Vec<&String> = rows
        .iter()
        .filter(|r| SPINNER.iter().any(|f| r.contains(f)))
        .collect();
    assert!(
        spinning.is_empty(),
        "throbber survived cancel: {spinning:?}"
    );
}

#[tokio::test]
async fn esc_stops_the_awaiting_subagent_throbber() {
    let mut app = test_app();
    app.status = Status::Running;
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "await_subagent".into(),
        args: json!({ "run_id": "reviewer-1" }),
    });
    assert!(!app.awaiting.is_empty());
    press_esc(&mut app).await;
    let rows = render_rows(&mut app, 60, 30);
    let spinning: Vec<&String> = rows
        .iter()
        .filter(|r| SPINNER.iter().any(|f| r.contains(f)))
        .collect();
    assert!(
        spinning.is_empty(),
        "throbber survived cancel: {spinning:?}"
    );
}

#[test]
fn reasoning_folds_before_await_subagent() {
    // A reasoning model that thinks and then awaits a subagent must fold
    // its <think> block to a summary row, not leave it fully expanded in
    // the live tail behind the throbber.
    let mut app = test_app();
    app.apply(StreamEvent::Token {
        text: "<think>collecting the subagent answers</think>".into(),
    });
    assert!(app.reasoning_blocks.is_empty());
    app.apply(StreamEvent::ToolCall {
        id: "a1".into(),
        name: "await_subagent".into(),
        args: json!({ "run_id": "sub-reviewer-1" }),
    });
    assert_eq!(app.reasoning_blocks.len(), 1);
    assert!(app.assistant_buf.is_empty());
    assert_eq!(app.awaiting.len(), 1);
}

#[test]
fn await_subagent_shows_throbber_until_result() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "a1".into(),
        name: "await_subagent".into(),
        args: json!({ "run_id": "sub-reviewer-1" }),
    });
    // Tracked as an awaiting throbber (not folded into a tool group row).
    assert_eq!(app.awaiting.len(), 1);
    assert_eq!(
        app.awaiting[0],
        (
            "a1".to_string(),
            "sub-reviewer-1".to_string(),
            "reviewer".to_string()
        )
    );
    assert!(app.tool_group.is_none(), "await must not open a tool group");
    // The result clears the throbber.
    app.apply(StreamEvent::ToolResult {
        id: "a1".into(),
        content: "the subagent's answer".into(),
        is_error: false,
        diff: None,
    });
    assert!(app.awaiting.is_empty());
}

/// Regression test: `SubagentEnd` can arrive before the parent's own
/// `await_subagent` `ToolResult` (the two race). Previously only the
/// `ToolResult` cleared `awaiting`, so a finished subagent kept showing
/// an "Awaiting subagent: X" throbber alongside its own "finished" row.
#[test]
fn subagent_end_clears_its_awaiting_throbber_even_without_a_tool_result() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "a1".into(),
        name: "await_subagent".into(),
        args: json!({ "run_id": "sub-reviewer-1" }),
    });
    app.apply(StreamEvent::ToolCall {
        id: "a2".into(),
        name: "await_subagent".into(),
        args: json!({ "run_id": "sub-explorer-1" }),
    });
    assert_eq!(app.awaiting.len(), 2);

    app.apply(StreamEvent::SubagentEnd {
        run_id: "sub-reviewer-1".into(),
        name: "reviewer".into(),
    });
    assert_eq!(
        app.awaiting.len(),
        1,
        "the finished subagent's throbber must clear even without its ToolResult"
    );
    assert_eq!(app.awaiting[0].2, "explorer");
}

/// The summary row says what a child cost, or that it ran out of turns,
/// when the loop reported it; a child that reported nothing keeps the
/// plain row.
#[test]
fn a_finished_subagent_row_carries_its_cost_or_turn_limit_stop() {
    let mut app = test_app();
    for (run, status, usage) in [
        ("r-ok", "done", Some(json!({ "total_tokens": 12_300 }))),
        ("r-limit", "turn_limit", None),
        ("r-bare", "done", None),
    ] {
        app.apply(StreamEvent::SubagentStart {
            run_id: run.into(),
            name: run.into(),
            task: None,
        });
        app.apply(StreamEvent::SubagentFinished {
            run_id: run.into(),
            name: run.into(),
            status: status.into(),
            usage,
            detail: None,
        });
        app.apply(StreamEvent::SubagentEnd {
            run_id: run.into(),
            name: run.into(),
        });
    }
    let text = transcript_text(&app);
    assert!(text.contains("subagent r-ok finished (0 tool calls, 12K tokens)"), "{text}");
    assert!(text.contains("subagent r-limit finished (0 tool calls, stopped at its turn limit)"), "{text}");
    assert!(text.contains("subagent r-bare finished (0 tool calls)"), "{text}");
    assert!(app.subagent_finish.is_empty(), "notes are consumed, not leaked");
}

/// A dispatch that named its errand puts the name on the summary row.
#[test]
fn a_titled_subagent_row_names_its_errand() {
    let mut app = test_app();
    app.apply(StreamEvent::SubagentTitle {
        run_id: "r1".into(),
        name: "explorer".into(),
        title: "Map the lexer".into(),
    });
    app.apply(StreamEvent::SubagentStart {
        run_id: "r1".into(),
        name: "explorer".into(),
        task: None,
    });
    app.apply(StreamEvent::SubagentEnd {
        run_id: "r1".into(),
        name: "explorer".into(),
    });
    let text = transcript_text(&app);
    assert!(text.contains("subagent explorer: Map the lexer finished"), "{text}");
    assert!(app.subagent_titles.is_empty(), "titles are consumed, not leaked");
}

#[test]
fn concurrent_subagents_track_independent_panels() {
    let mut app = test_app();
    app.apply(StreamEvent::SubagentStart {
        run_id: "r1".into(),
        name: "alpha".into(),
        task: None,
    });
    app.apply(StreamEvent::SubagentStart {
        run_id: "r2".into(),
        name: "beta".into(),
        task: None,
    });
    app.apply(wrap(
        "r2",
        "beta",
        StreamEvent::ToolCall {
            id: "c0".into(),
            name: "bash".into(),
            args: json!({ "command": "beta-cmd" }),
        },
    ));
    assert_eq!(app.subagents.len(), 2);
    let alpha = app.subagents.iter().find(|p| p.run_id == "r1").unwrap();
    let beta = app.subagents.iter().find(|p| p.run_id == "r2").unwrap();
    assert_eq!(alpha.calls.len(), 0, "beta's call must not land on alpha");
    assert_eq!(beta.calls.len(), 1);
    assert!(beta.calls.last().unwrap().contains("beta-cmd"));
}

#[test]
fn queued_panel_promotes_to_running_without_duplicate() {
    let mut app = test_app();
    app.apply(StreamEvent::SubagentQueued {
        run_id: "r1".into(),
        name: "reviewer".into(),
        task: Some("queue up".into()),
        waiting: 2,
    });
    let queued = app
        .subagents
        .iter()
        .find(|p| p.run_id == "r1")
        .expect("queued panel");
    assert!(
        queued.queued,
        "dispatch beyond the cap opens a queued panel"
    );
    assert_eq!(queued.waiting, 2);

    // The child's later SubagentStart must flip the same panel to running,
    // not push a duplicate.
    app.apply(StreamEvent::SubagentStart {
        run_id: "r1".into(),
        name: "reviewer".into(),
        task: None,
    });
    assert_eq!(app.subagents.len(), 1, "no duplicate panel on promotion");
    let promoted = app.subagents.iter().find(|p| p.run_id == "r1").unwrap();
    assert!(!promoted.queued, "promoted panel is now running");
}

#[test]
fn queued_panel_renders_queue_position() {
    let mut app = test_app();
    app.apply(StreamEvent::SubagentQueued {
        run_id: "r1".into(),
        name: "reviewer".into(),
        task: Some("task".into()),
        waiting: 3,
    });
    let rows = render_rows(&mut app, 80, 20);
    assert!(
        rows.iter().any(|r| r.contains("queued (3)")),
        "queued panel shows its position: {rows:?}"
    );
}

#[test]
fn subagent_end_commits_summary_and_clears_only_that_panel() {
    let mut app = test_app();
    app.apply(StreamEvent::SubagentStart {
        run_id: "r1".into(),
        name: "reviewer".into(),
        task: None,
    });
    app.apply(wrap(
        "r1",
        "reviewer",
        StreamEvent::ToolCall {
            id: "c0".into(),
            name: "bash".into(),
            args: json!({ "command": "ls" }),
        },
    ));
    app.apply(StreamEvent::SubagentEnd {
        run_id: "r1".into(),
        name: "reviewer".into(),
    });
    assert!(app.subagents.iter().all(|p| p.run_id != "r1"));
    assert!(app
        .transcript
        .iter()
        .any(|r| row_text(r).contains("subagent reviewer finished (1 tool call)")));
}

#[test]
fn parent_tokens_still_render_while_subagent_active() {
    let mut app = test_app();
    app.apply(StreamEvent::SubagentStart {
        run_id: "r1".into(),
        name: "reviewer".into(),
        task: None,
    });
    // A wrapped child token is internal and dropped.
    app.apply(wrap(
        "r1",
        "reviewer",
        StreamEvent::Token {
            text: "child prose".into(),
        },
    ));
    assert!(app.assistant_buf.is_empty());
    // The parent's own token still streams even with a child active.
    app.apply(StreamEvent::Token {
        text: "parent prose".into(),
    });
    assert_eq!(app.assistant_buf, "parent prose");
}

#[test]
fn permission_inside_subagent_attributes_the_asking_subagent() {
    let mut app = test_app();
    app.apply(StreamEvent::SubagentStart {
        run_id: "r1".into(),
        name: "reviewer".into(),
        task: None,
    });
    app.apply(wrap(
        "r1",
        "reviewer",
        StreamEvent::PermissionRequest {
            request_id: "p1".into(),
            tool_name: "bash".into(),
            capability: "exec".into(),
            path: None,
            command: Some("cargo test".into()),
            diff: None,
            patch: None,
            prompt_kind: "exec".into(),
            offers_always: true,
            reason: None,
            args_digest: None,
            call_id: None,
        },
    ));
    assert_eq!(
        app.pending().and_then(|p| p.subagent.as_deref()),
        Some("reviewer")
    );
}

/// Regression test: two subagents requesting permission concurrently must
/// both be retained (queued), not have the second overwrite/drop the
/// first. Previously `pending` was a single `Option<Pending>` that the
/// second `PermissionRequest` clobbered, leaving the first subagent's
/// oneshot sender unreachable and its call hung forever.
#[test]
fn concurrent_subagent_permission_requests_both_queue() {
    let mut app = test_app();
    app.apply(StreamEvent::SubagentStart {
        run_id: "r1".into(),
        name: "reviewer".into(),
        task: None,
    });
    app.apply(StreamEvent::SubagentStart {
        run_id: "r2".into(),
        name: "explorer".into(),
        task: None,
    });
    app.apply(wrap(
        "r1",
        "reviewer",
        StreamEvent::PermissionRequest {
            request_id: "p1".into(),
            tool_name: "bash".into(),
            capability: "exec".into(),
            path: None,
            command: Some("cargo test".into()),
            diff: None,
            patch: None,
            prompt_kind: "exec".into(),
            offers_always: true,
            reason: None,
            args_digest: None,
            call_id: None,
        },
    ));
    // Second subagent's request arrives while the first is still pending.
    app.apply(wrap(
        "r2",
        "explorer",
        StreamEvent::PermissionRequest {
            request_id: "p2".into(),
            tool_name: "read".into(),
            capability: "read".into(),
            path: Some("secrets.env".into()),
            command: None,
            diff: None,
            patch: None,
            prompt_kind: "read".into(),
            offers_always: false,
            reason: None,
            args_digest: None,
            call_id: None,
        },
    ));

    assert_eq!(app.pending_queue.len(), 2, "both requests must be retained");
    // The first request stays visible/answerable; the second is not lost.
    assert_eq!(
        app.pending().map(|p| p.request_id.as_str()),
        Some("p1"),
        "front of the queue should still be the first subagent's request"
    );
    assert_eq!(
        app.pending().and_then(|p| p.subagent.as_deref()),
        Some("reviewer")
    );

    // Resolving the front (simulating the user answering it) pops it and
    // surfaces the second subagent's request, attributed correctly.
    app.pending_queue.pop_front();
    assert_eq!(app.pending_queue.len(), 1);
    assert_eq!(
        app.pending().map(|p| p.request_id.as_str()),
        Some("p2"),
        "second subagent's request must surface once the first resolves"
    );
    assert_eq!(
        app.pending().and_then(|p| p.subagent.as_deref()),
        Some("explorer")
    );
}

#[test]
fn a_cancelled_write_does_not_leak_its_recorded_path() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "write".into(),
        args: json!({"path": "src/main.rs"}),
    });
    assert_eq!(app.diff_paths.len(), 1);
    app.begin_turn();
    assert!(app.diff_paths.is_empty(), "path outlived its turn");
}

#[test]
fn a_completed_write_carries_its_path_into_the_result_diff() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "write".into(),
        args: json!({"path": "src/main.rs"}),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "wrote 3 lines".into(),
        is_error: false,
        diff: Some("     1 | fn main() {\n-    2 | let x = 1;\n+    2 | let x = 2;".into()),
    });
    assert!(
        !diff_syntax_colours(&row_lines(&app.transcript)).is_empty(),
        "result diff not highlighted: {:?}",
        app.transcript.iter().map(row_text).collect::<Vec<_>>()
    );
}

#[test]
fn cancel_clears_pending_run_start() {
    let mut app = test_app();
    // Submit while the run is still gated on model/MCP/snapshot readiness:
    // want_start is armed but no run has spawned yet.
    app.submit_user("do a thing".into());
    app.apply(StreamEvent::SubagentStart {
        run_id: "sub-reviewer-1".into(),
        name: "reviewer".into(),
        task: None,
    });
    app.apply(StreamEvent::ToolCall {
        id: "a1".into(),
        name: "await_subagent".into(),
        args: json!({ "run_id": "sub-reviewer-1" }),
    });
    // A second call whose args are still streaming in (no ToolCall event
    // yet, just the throbber-only ToolCallStarted).
    app.apply(StreamEvent::ToolCallStarted {
        id: "w1".into(),
        name: "write".into(),
    });
    assert!(app.want_start, "submit should arm want_start");
    assert_eq!(app.status, Status::Running);
    assert_eq!(app.subagents.len(), 1);
    assert_eq!(app.awaiting.len(), 1);
    assert_eq!(app.starting.len(), 1);

    app.cancel_run();
    assert!(
        !app.want_start,
        "cancel must drop the pending start or the loop re-spawns it"
    );
    assert_eq!(app.status, Status::Idle);
    assert!(
        app.subagents.is_empty(),
        "cancel must clear live subagent rows"
    );
    assert!(
        app.awaiting.is_empty(),
        "cancel must clear awaited-subagent state"
    );
    assert!(
        app.starting.is_empty(),
        "cancel must clear a still-streaming call's throbber, or it lingers forever"
    );
}

#[test]
fn cancel_keeps_streamed_prose_and_tool_calls() {
    let mut app = test_app();
    app.submit_user("do a thing".into());
    // Model calls a tool, then streams a partial answer.
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "grep -n foo src/" }),
    });
    app.apply(StreamEvent::Token {
        text: "Here is what I found so far".into(),
    });
    app.cancel_run();
    let body: Vec<String> = app.transcript.iter().map(row_text).collect();
    let joined = body.join("\n");
    assert!(
        joined.contains("Here is what I found so far"),
        "streamed prose vanished on cancel:\n{joined}"
    );
    assert!(
        joined.contains("grep"),
        "tool call vanished on cancel:\n{joined}"
    );
    assert!(joined.contains("cancelled"), "no cancel marker:\n{joined}");
    assert!(app.assistant_buf.is_empty());
    // The partial answer is recorded in history for the next turn / resume.
    let last = app.history.last().expect("history entry");
    assert_eq!(last["role"], "assistant");
    assert!(
        last["content"]
            .as_str()
            .unwrap_or_default()
            .contains("Here is what I found so far"),
        "partial answer not in history: {last}"
    );
}

#[test]
fn cancel_preserves_completed_tool_calls_and_results_in_history() {
    let mut app = test_app();
    app.submit_user("do a thing".into());
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "grep -n foo src/" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "match on line 3\n[exit 0]".into(),
        is_error: false,
        diff: None,
    });
    // The run is cancelled before the model emits any answer prose, so
    // nothing is streamed to be committed as assistant text.
    app.cancel_run();
    let wire = app
        .history
        .iter()
        .map(serde_json::Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        wire.contains("\"tool_calls\"") && wire.contains("c1"),
        "tool call missing from wire history on cancel: {wire}"
    );
    assert!(
        wire.contains("\"tool_call_id\":\"c1\"") && wire.contains("match on line 3"),
        "tool result missing from wire history on cancel: {wire}"
    );
}

#[test]
fn on_error_preserves_completed_tool_calls_and_results_in_history() {
    let mut app = test_app();
    app.submit_user("do a thing".into());
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "grep -n foo src/" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "match on line 3\n[exit 0]".into(),
        is_error: false,
        diff: None,
    });
    // The run dies on an upstream error before the model emits any answer
    // prose. This stub stream publishes no `MessagesUpdated` for the step,
    // so the completed call must be folded into history by the error path
    // (the same guarantee the Esc-cancel path already provides).
    app.on_error("upstream".into(), "connection reset".into());
    let wire = app
        .history
        .iter()
        .map(serde_json::Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        wire.contains("\"tool_calls\"") && wire.contains("c1"),
        "tool call missing from wire history on error: {wire}"
    );
    assert!(
        wire.contains("\"tool_call_id\":\"c1\"") && wire.contains("match on line 3"),
        "tool result missing from wire history on error: {wire}"
    );
}

#[test]
fn on_error_pairs_in_flight_calls_with_a_placeholder_result() {
    let mut app = test_app();
    app.submit_user("do a thing".into());
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "sleep 300" }),
    });
    // The call was still in flight when the stream errored; no ToolResult
    // ever arrives. It must still reach the wire, paired with a placeholder
    // result so the exchange is protocol-valid for a later prompt.
    app.on_error("upstream".into(), "connection reset".into());
    let wire = app
        .history
        .iter()
        .map(serde_json::Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        wire.contains("\"tool_calls\"") && wire.contains("c1"),
        "interrupted call missing from wire history on error: {wire}"
    );
    assert!(
        wire.contains("\"tool_call_id\":\"c1\""),
        "interrupted call must be paired with a result: {wire}"
    );
}

#[test]
fn on_error_does_not_double_fold_when_flush_assistant_committed_prose() {
    let mut app = test_app();
    app.submit_user("do a thing".into());
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "ls" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "ok".into(),
        is_error: false,
        diff: None,
    });
    // Some prose streamed before the error, so `on_error`'s flush_assistant
    // commits it. The completed call must still be folded - and folded only
    // once regardless of the prose that preceded the error.
    app.apply(StreamEvent::Token {
        text: "I found it".into(),
    });
    app.on_error("upstream".into(), "connection reset".into());
    let assistant_tool_turns = app
        .history
        .iter()
        .filter(|m| m.get("tool_calls").is_some())
        .count();
    assert_eq!(assistant_tool_turns, 1, "tool call folded exactly once");
}

#[test]
fn cancel_surfaces_interrupted_calls_paired_with_a_placeholder_result() {
    let mut app = test_app();
    app.submit_user("do a thing".into());
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "sleep 300" }),
    });
    // No ToolResult arrives: the call was still in flight at cancel. It
    // must still reach the wire history, paired with a placeholder result
    // so the upstream sees a valid (call, result) exchange, not a dangling
    // call that OpenAI-compatible endpoints reject.
    app.cancel_run();
    let wire = app
        .history
        .iter()
        .map(serde_json::Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        wire.contains("\"tool_calls\"") && wire.contains("c1"),
        "interrupted call missing from wire history: {wire}"
    );
    assert!(
        wire.contains("\"tool_call_id\":\"c1\""),
        "interrupted call must be paired with a result for a valid exchange: {wire}"
    );
}

/// The backend publishes a mid-turn `MessagesUpdated` on a compaction retry
/// and on the budget soft-stop, so the turn's exchange can already be in
/// `history` when the cancel folds it. Folding it again would put the same
/// call and result on the wire twice.
#[test]
fn cancel_after_a_mid_turn_messages_updated_folds_each_call_once() {
    let mut app = test_app();
    app.submit_user("do a thing".into());
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "ls" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "ok".into(),
        is_error: false,
        diff: None,
    });
    app.apply(StreamEvent::MessagesUpdated {
        messages: vec![
            json!({ "role": "user", "content": "do a thing" }),
            json!({
                "role": "assistant",
                "content": serde_json::Value::Null,
                "tool_calls": [{
                    "id": "c1",
                    "type": "function",
                    "function": { "name": "bash", "arguments": "{\"command\":\"ls\"}" }
                }],
            }),
            json!({ "role": "tool", "tool_call_id": "c1", "content": "ok" }),
        ],
    });
    app.cancel_run();
    let (calls, results) = tool_turns(&app);
    assert_eq!(calls.len(), 1, "call folded twice: {:?}", app.history);
    assert_eq!(results.len(), 1, "result folded twice: {:?}", app.history);
}

/// A cancel is routinely followed by a late `Error` or stream close from the
/// task it aborted, and `display_log` is not cleared by the cancel, so the
/// fold must be idempotent across both.
#[test]
fn cancel_then_a_late_error_folds_each_call_once() {
    let mut app = test_app();
    app.submit_user("do a thing".into());
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "ls" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "ok".into(),
        is_error: false,
        diff: None,
    });
    app.cancel_run();
    app.on_error("upstream".into(), "connection reset".into());
    let (calls, results) = tool_turns(&app);
    assert_eq!(calls.len(), 1, "call folded twice: {:?}", app.history);
    assert_eq!(results.len(), 1, "result folded twice: {:?}", app.history);
}

/// The loop emits every `ToolCall` in the model's order and then dispatches
/// them concurrently, so results arrive in completion order. The folded
/// exchange must pair each result to its call by id and keep the
/// `tool_calls` order, the invariant strict endpoints enforce.
#[test]
fn cancelled_turn_pairs_out_of_order_results_to_their_calls() {
    let mut app = test_app();
    app.submit_user("do a thing".into());
    for (id, command) in [("c1", "sleep 5"), ("c2", "ls"), ("c3", "pwd")] {
        app.apply(StreamEvent::ToolCall {
            id: id.into(),
            name: "bash".into(),
            args: json!({ "command": command }),
        });
    }
    // c3 and c2 finish first; c1 is still in flight at the cancel.
    for id in ["c3", "c2"] {
        app.apply(StreamEvent::ToolResult {
            id: id.into(),
            content: format!("out of {id}"),
            is_error: false,
            diff: None,
        });
    }
    app.cancel_run();
    let (calls, results) = tool_turns(&app);
    assert_eq!(
        calls.len(),
        1,
        "one assistant tool-call turn: {:?}",
        app.history
    );
    let ids: Vec<&str> = calls[0]["tool_calls"]
        .as_array()
        .expect("tool_calls array")
        .iter()
        .map(|tc| tc["id"].as_str().expect("id"))
        .collect();
    assert_eq!(ids, ["c1", "c2", "c3"], "tool_calls kept in model order");
    let paired: Vec<(&str, &str)> = results
        .iter()
        .map(|m| {
            (
                m["tool_call_id"].as_str().expect("tool_call_id"),
                m["content"].as_str().expect("content"),
            )
        })
        .collect();
    assert_eq!(
        paired,
        [
            ("c1", super::super::super::MISSING_TOOL_RESULT),
            ("c2", "out of c2"),
            ("c3", "out of c3"),
        ],
        "results follow the tool_calls order, paired by id"
    );
}

#[test]
fn single_collapsible_tool_folds_to_one_row() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "grep -n foo src/" }),
    });
    let running = row_text(app.transcript.last().unwrap());
    assert!(running.contains("▸ Executing: grep"), "running: {running}");
    let before = app.transcript.len();
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "match\nmatch\n(+50 lines)".into(),
        is_error: false,
        diff: None,
    });
    // Result is swallowed: still one row, still running.
    assert_eq!(app.transcript.len(), before);
    // Finalizing (turn boundary / done) marks it complete on the same row.
    app.finalize_tool_group();
    let row = row_text(app.transcript.last().unwrap());
    assert!(row.contains("✓") && row.contains("Ran: grep"), "row: {row}");
    assert!(!row.contains("lines"), "row: {row}");
    assert!(app.tool_group.is_none());
}

#[test]
fn expanded_bash_group_shows_full_output_not_summary() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "git push" }),
    });
    let content =
        "To github.com:janhq/jan.git\n   a1b2c3d..e4f5g6h  main -> main\nremote line\n[exit 0]";
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: content.into(),
        is_error: false,
        diff: None,
    });
    app.finalize_tool_group();
    let joined = group_detail_lines(&app.groups[0], 120)
        .iter()
        .map(line_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        joined.contains("main -> main"),
        "middle line lost: {joined}"
    );
    assert!(joined.contains("remote line"), "line lost: {joined}");
    assert!(joined.contains("[exit 0]"), "exit marker lost: {joined}");
    assert!(
        !joined.contains("(+"),
        "must not summarize when expanded: {joined}"
    );
    // Single-call group: the command header must not be repeated inside the
    // expansion (the summary row above already shows it).
    assert!(!joined.contains("▸"), "duplicate command header: {joined}");
    assert!(
        !joined.contains("git push"),
        "duplicate command label: {joined}"
    );
}

#[test]
fn first_streamed_token_finalizes_open_tool_group() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "grep -n foo src/" }),
    });
    assert!(app.tool_group.is_some());
    // Prose begins streaming in the same turn (no intervening Step): the
    // group's status must land in the timeline as `✓` right away.
    app.apply(StreamEvent::Token {
        text: "Here".into(),
    });
    assert!(app.tool_group.is_none());
    let row = app
        .transcript
        .iter()
        .rev()
        .map(row_text)
        .find(|t| t.contains("Ran: grep"))
        .unwrap();
    assert!(row.contains("✓"), "row: {row}");
    // Later tokens must not re-trigger finalize work.
    app.apply(StreamEvent::Token {
        text: " goes".into(),
    });
    assert!(app.tool_group.is_none());
}

#[test]
fn failed_grouped_call_keeps_its_failure_in_the_expanded_detail() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "grep".into(),
        args: json!({ "pattern": "foo" }),
    });
    app.apply(StreamEvent::ToolCall {
        id: "c2".into(),
        name: "read".into(),
        args: json!({ "path": "main.rs" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "ERROR: tool 'grep' denied by user".into(),
        is_error: true,
        diff: None,
    });
    app.apply(StreamEvent::ToolResult {
        id: "c2".into(),
        content: "fn main() {}".into(),
        is_error: false,
        diff: None,
    });
    app.finalize_tool_group();
    // The collapsed row carries the latest result, but the earlier failure
    // must still be reachable by expanding the group.
    let row = row_text(&app.transcript[app.groups[0].idx]);
    assert!(row.contains("✓"), "row: {row}");
    let detail: String = group_detail_lines(&app.groups[0], 80)
        .iter()
        .map(|l| {
            l.spans
                .iter()
                .map(|s| s.content.as_ref())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        detail.contains("✗") && detail.contains("denied by user"),
        "failure lost from the expanded detail: {detail}"
    );
}

#[test]
fn cancelled_tool_group_is_not_marked_successful() {
    let mut app = test_app();
    app.submit_user("do a thing".into());
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "sleep 300" }),
    });
    let idx = app.tool_group.as_ref().unwrap().idx;
    app.cancel_run();
    let row = row_text(&app.transcript[idx]);
    assert!(
        !row.contains("✓"),
        "a cancelled command must not read as succeeded: {row}"
    );
    assert!(row.contains("○"), "no interrupted marker: {row}");
    // Present tense beside the interrupted mark: `Ran: sleep 300` would read
    // as completed, matching the standalone edit/write orphan path.
    assert!(
        row.contains("Executing") && !row.contains("Ran"),
        "interrupted command reads as completed: {row}"
    );
}

#[test]
fn cancelled_standalone_edit_row_is_marked_interrupted() {
    let mut app = test_app();
    app.submit_user("do a thing".into());
    app.apply(StreamEvent::ToolCall {
        id: "e1".into(),
        name: "edit".into(),
        args: json!({ "path": "foo.rs", "old_string": "a", "new_string": "b" }),
    });
    let idx = app.transcript.len() - 1;
    assert!(row_text(&app.transcript[idx]).contains("▸"));
    app.cancel_run();
    let row = row_text(&app.transcript[idx]);
    assert!(
        !row.contains("▸"),
        "cancelled edit still reads as in flight: {row}"
    );
    assert!(row.contains("○"), "no interrupted marker: {row}");
}

#[test]
fn completed_standalone_edit_survives_a_later_cancel() {
    let mut app = test_app();
    app.submit_user("do a thing".into());
    app.apply(StreamEvent::ToolCall {
        id: "e1".into(),
        name: "edit".into(),
        args: json!({ "path": "foo.rs", "old_string": "a", "new_string": "b" }),
    });
    let idx = app.transcript.len() - 1;
    app.apply(StreamEvent::ToolResult {
        id: "e1".into(),
        content: "edited foo.rs".into(),
        is_error: false,
        diff: None,
    });
    app.cancel_run();
    let row = row_text(&app.transcript[idx]);
    assert!(
        row.contains("✓ Edited foo.rs") && !row.contains("○"),
        "a resolved edit must keep its call row: {row}"
    );
}

#[test]
fn pre_tool_prose_lands_above_the_tool_row() {
    let mut app = test_app();
    app.apply(StreamEvent::Token {
        text: "Let me check the README.".into(),
    });
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "grep -n foo src/" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "ok".into(),
        is_error: false,
        diff: None,
    });
    app.apply(StreamEvent::Token {
        text: "Found it.".into(),
    });
    app.apply(StreamEvent::Step { index: 2, max: 8 });
    let rows: Vec<String> = app.transcript.iter().map(row_text).collect();
    let prose = rows
        .iter()
        .position(|r| r.contains("check the README"))
        .unwrap();
    let tool = rows.iter().position(|r| r.contains("Ran: grep")).unwrap();
    let after = rows.iter().position(|r| r.contains("Found it")).unwrap();
    assert!(prose < tool && tool < after, "rows: {rows:?}");
}

#[test]
fn consecutive_collapsible_tools_fold_into_one_summary_row() {
    let mut app = test_app();
    let calls = [
        ("c1", "memory_list", json!({})),
        ("c2", "skill_list", json!({})),
        ("c3", "memory_read", json!({ "name": "project-overview" })),
        ("c4", "memory_read", json!({ "name": "top-p" })),
    ];
    for (id, name, args) in calls {
        app.apply(StreamEvent::ToolCall {
            id: id.into(),
            name: name.into(),
            args,
        });
        app.apply(StreamEvent::ToolResult {
            id: id.into(),
            content: "ok".into(),
            is_error: false,
            diff: None,
        });
    }
    // All four folded into a single running row with a live counter.
    let tool_rows = app
        .transcript
        .iter()
        .filter(|r| row_text(r).contains("Reading") || row_text(r).contains("Read "))
        .count();
    assert_eq!(tool_rows, 1);
    // Every call has reported, so the row already reads as a finished
    // breakdown -- not "<latest> (4)", and not still-running until the
    // model speaks.
    let row = row_text(app.transcript.last().unwrap());
    assert!(row.contains("✓ Read 3 memory notes, 1 skill"), "row: {row}");
    // The model speaking closes the group without disturbing the row.
    app.apply(StreamEvent::Token {
        text: "Done.".into(),
    });
    let row = row_text(app.transcript.last().unwrap());
    assert!(row.contains("✓ Read 3 memory notes, 1 skill"), "row: {row}");
}

#[test]
fn folded_group_expands_and_collapses_via_keybinding() {
    let mut app = test_app();
    let calls = [
        ("c1", "memory_read", json!({ "name": "project-overview" })),
        ("c2", "memory_read", json!({ "name": "top-p" })),
    ];
    for (id, name, args) in calls {
        app.apply(StreamEvent::ToolCall {
            id: id.into(),
            name: name.into(),
            args,
        });
        app.apply(StreamEvent::ToolResult {
            id: id.into(),
            content: format!("result for {id}"),
            is_error: false,
            diff: None,
        });
    }
    app.apply(StreamEvent::Token {
        text: "Done.".into(),
    });
    assert_eq!(app.groups.len(), 1);

    // Collapsed by default: draw injects no per-call detail.
    assert!(app.expanded.is_empty());
    let group_idx = app.groups[0].idx;
    let detail = group_detail_lines(&app.groups[0], 80);
    let detail_text: Vec<String> = detail.iter().map(line_text).collect();
    assert!(detail_text.iter().any(|l| l.contains("result for c1")));
    assert!(detail_text.iter().any(|l| l.contains("result for c2")));

    // Ctrl-O expands, a second toggle collapses.
    app.toggle_regions();
    assert!(app.expanded.contains(&group_idx));
    app.toggle_regions();
    assert!(app.expanded.is_empty());
}

#[test]
fn folded_group_expands_and_collapses_via_click() {
    let mut app = test_app();
    let calls = [
        ("c1", "memory_read", json!({ "name": "project-overview" })),
        ("c2", "memory_read", json!({ "name": "top-p" })),
    ];
    for (id, name, args) in calls {
        app.apply(StreamEvent::ToolCall {
            id: id.into(),
            name: name.into(),
            args,
        });
        app.apply(StreamEvent::ToolResult {
            id: id.into(),
            content: format!("result for {id}"),
            is_error: false,
            diff: None,
        });
    }
    app.apply(StreamEvent::Token {
        text: "Done.".into(),
    });
    let group_idx = app.groups[0].idx;

    // A click on the group's own row toggles it, same as Ctrl-O.
    app.toggle_region(group_idx);
    assert!(app.expanded.contains(&group_idx));
    app.toggle_region(group_idx);
    assert!(app.expanded.is_empty());

    // A row that isn't a region's own summary is a no-op.
    app.toggle_region(9999);
    assert!(app.expanded.is_empty());
}

#[test]
fn running_group_row_shows_spinner_and_elapsed() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "grep".into(),
        args: json!({ "pattern": "foo" }),
    });
    let group = app.tool_group.as_ref().expect("group open");
    let text = lines_text(&running_group_rows(group, 2, 80));
    assert!(text.contains(SPINNER[2]), "{text}");
    assert!(text.contains("(0s)") || text.contains("(1s)"), "{text}");
}

/// A lone in-flight call is specific enough to name: the live row shows its
/// own label (the full command for bash), not the "running 1 command" count.
#[test]
fn running_single_call_row_names_the_call() {
    let mut app = test_app();
    let cmd = format!("grep -n foo {}", "src/very/long/path/".repeat(6));
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": cmd }),
    });
    let group = app.tool_group.as_ref().expect("group open");
    let text = lines_text(&running_group_rows(group, 0, 200));
    assert!(text.contains(&format!("Executing: {cmd}")), "{text}");
    assert!(!text.contains("running 1 command"), "{text}");
}

/// Two or more calls in flight still name the tool actively running (the
/// latest outstanding one), not a counted breakdown -- a summary like
/// "Running 2 commands" would wrongly imply both are executing at once.
#[test]
fn running_multi_call_row_names_the_in_flight_tool() {
    let mut app = test_app();
    for (id, cmd) in [("c1", "cargo test"), ("c2", "cargo clippy")] {
        app.apply(StreamEvent::ToolCall {
            id: id.into(),
            name: "bash".into(),
            args: json!({ "command": cmd }),
        });
    }
    let group = app.tool_group.as_ref().expect("group open");
    let text = lines_text(&running_group_rows(group, 0, 200));
    assert!(text.contains("Executing: cargo clippy"), "{text}");
    assert!(!text.contains("Running 2 commands"), "{text}");
}

#[test]
fn tool_group_stops_looking_live_once_its_call_resolves() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "grep".into(),
        args: json!({ "pattern": "foo" }),
    });
    assert!(app.tool_group.as_ref().unwrap().is_running());
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "ok".into(),
        is_error: false,
        diff: None,
    });
    // Group stays open (folding), but with its only call resolved and no
    // next call yet, it must not render as still executing.
    assert!(app.tool_group.is_some());
    assert!(!app.tool_group.as_ref().unwrap().is_running());

    app.apply(StreamEvent::ToolCall {
        id: "c2".into(),
        name: "grep".into(),
        args: json!({ "pattern": "bar" }),
    });
    assert!(app.tool_group.as_ref().unwrap().is_running());
}

#[test]
fn grouped_row_resolves_when_its_result_lands_not_when_prose_starts() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "grep".into(),
        args: json!({ "pattern": "foo" }),
    });
    let idx = app.tool_group.as_ref().unwrap().idx;
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "ok".into(),
        is_error: false,
        diff: None,
    });
    // No token has streamed yet: the row must already read as done rather
    // than sitting on the present-tense running form until prose arrives.
    let row = row_text(&app.transcript[idx]);
    assert!(row.contains("✓"), "status lagged behind the result: {row}");
    assert!(row.contains("Searched"), "row not past tense: {row}");

    // A later call in the same group reopens it as running.
    app.apply(StreamEvent::ToolCall {
        id: "c2".into(),
        name: "read".into(),
        args: json!({ "path": "main.rs" }),
    });
    let row = row_text(&app.transcript[idx]);
    assert!(row.contains("▸") && !row.contains("✓"), "row: {row}");
}

#[test]
fn failed_grouped_row_shows_the_failure_before_the_group_closes() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "cargo build" }),
    });
    let idx = app.tool_group.as_ref().unwrap().idx;
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "ERROR: command not found".into(),
        is_error: true,
        diff: None,
    });
    let row = row_text(&app.transcript[idx]);
    assert!(
        row.contains("✗") && !row.contains("✓"),
        "failure not shown at result time: {row}"
    );
}

#[test]
fn grouped_row_reports_the_latest_result_not_an_earlier_failure() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "cargo buidl" }),
    });
    let idx = app.tool_group.as_ref().unwrap().idx;
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "ERROR: no such subcommand".into(),
        is_error: true,
        diff: None,
    });
    // The retry succeeds, so the collapsed row must stop reading as failed.
    app.apply(StreamEvent::ToolCall {
        id: "c2".into(),
        name: "bash".into(),
        args: json!({ "command": "cargo build" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c2".into(),
        content: "Finished".into(),
        is_error: false,
        diff: None,
    });
    let row = row_text(&app.transcript[idx]);
    assert!(
        row.contains("✓") && !row.contains("✗"),
        "stale failure on the summary row: {row}"
    );
}

#[test]
fn group_row_stays_running_while_a_sibling_call_is_outstanding() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "sleep 10" }),
    });
    app.apply(StreamEvent::ToolCall {
        id: "c2".into(),
        name: "read".into(),
        args: json!({ "path": "main.rs" }),
    });
    let idx = app.tool_group.as_ref().unwrap().idx;
    // Results can land out of dispatch order; the row must not claim the
    // batch is done while an earlier call is still outstanding.
    app.apply(StreamEvent::ToolResult {
        id: "c2".into(),
        content: "fn main() {}".into(),
        is_error: false,
        diff: None,
    });
    assert!(app.tool_group.as_ref().unwrap().is_running());
    let row = row_text(&app.transcript[idx]);
    assert!(!row.contains("✓"), "resolved early: {row}");
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "done".into(),
        is_error: false,
        diff: None,
    });
    assert!(!app.tool_group.as_ref().unwrap().is_running());
    assert!(row_text(&app.transcript[idx]).contains("✓"));
}

#[test]
fn handle_mouse_click_maps_row_to_region_toggle() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "memory_read".into(),
        args: json!({ "name": "x" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "result".into(),
        is_error: false,
        diff: None,
    });
    app.apply(StreamEvent::Token {
        text: "Done.".into(),
    });
    let group_idx = app.groups[0].idx;

    // Simulate what `draw` would have recorded: the group's row is the
    // only transcript row, right under the top border at row 1.
    app.transcript_rect = Rect::new(0, 0, 80, 10);
    app.last_scroll = 0;
    app.row_index = vec![Some(group_idx)];

    click(&mut app, 5, 1);
    assert!(app.expanded.contains(&group_idx));

    // Clicking outside the viewport (past the bottom border) is a no-op.
    click(&mut app, 5, 9);
    assert!(app.expanded.contains(&group_idx));
}

#[test]
fn toggle_region_expands_still_running_group() {
    // A tool group is still open (not yet finalized into `app.groups`)
    // while the agent is actively executing -- clicking its row must
    // still toggle it, not just after it finishes.
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "grep".into(),
        args: json!({ "pattern": "foo" }),
    });
    let idx = app.tool_group.as_ref().expect("group open").idx;
    assert!(app.groups.is_empty(), "not finalized yet");

    app.toggle_region(idx);
    assert!(app.expanded.contains(&idx));
    app.toggle_region(idx);
    assert!(app.expanded.is_empty());
}

#[test]
fn silent_tool_turns_keep_folding_across_step_boundaries() {
    let mut app = test_app();
    // One tool per turn (Step between each), no prose: the agent-loop shape.
    for (i, id) in ["c1", "c2", "c3"].iter().enumerate() {
        app.apply(StreamEvent::Step {
            index: i as u32 + 1,
            max: 8,
        });
        app.apply(StreamEvent::ToolCall {
            id: (*id).into(),
            name: "bash".into(),
            args: json!({ "command": "ls" }),
        });
        app.apply(StreamEvent::ToolResult {
            id: (*id).into(),
            content: "ok".into(),
            is_error: false,
            diff: None,
        });
    }
    // Still one open group after three turns, not a row per turn.
    assert!(app.tool_group.is_some());
    let tool_rows = app
        .transcript
        .iter()
        .filter(|l| {
            let t = row_text(l);
            t.contains("Executing") || t.contains("Running") || t.contains("Ran")
        })
        .count();
    assert_eq!(tool_rows, 1);
    app.on_done("stop".into(), None);
    let row = app
        .transcript
        .iter()
        .map(row_text)
        .find(|t| t.contains("Ran "))
        .unwrap();
    assert!(row.contains("✓ Ran 3 commands"), "row: {row}");
}

#[test]
fn reasoning_before_tool_call_renders_above_it_in_order() {
    let mut app = test_app();
    // Reasoning model thinks, then acts. The thought must commit above the
    // tool row (emission order), not linger in the live tail below it.
    app.apply(StreamEvent::Token {
        text: "<think>let me look at the config</think>".into(),
    });
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "ls" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "ok".into(),
        is_error: false,
        diff: None,
    });
    // Buffer is drained: the reasoning is committed, not stranded below.
    assert!(app.assistant_buf.is_empty());
    // Reasoning folds to a collapsed summary row (raw thought hidden), which
    // still lands above the tool row it preceded (emission order).
    let rows: Vec<String> = app.transcript.iter().map(row_text).collect();
    assert!(
        !rows.iter().any(|r| r.contains("let me look")),
        "raw reasoning must be hidden by default: {rows:?}"
    );
    let think_at = rows
        .iter()
        .position(|r| r.contains("Thought"))
        .unwrap();
    let tool_at = rows
        .iter()
        .position(|r| r.contains("Executing") || r.contains("Running") || r.contains("Ran"))
        .unwrap();
    assert!(
        think_at < tool_at,
        "reasoning must render above the tool row it preceded: {rows:?}"
    );
    // The raw thought is retained on the block for expansion.
    let block = &app.reasoning_blocks[0];
    assert!(block
        .detail
        .iter()
        .map(line_text)
        .any(|l| l.contains("let me look")));
}

#[tokio::test]
async fn streamed_reasoning_before_mixed_tool_batch_keeps_results_paired() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Exercise the real HTTP normalizer, including started/argument events.
    // The loop emits all authoritative calls before executing the batch.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = vec![0; 8192];
        let mut used = 0;
        loop {
            let n = socket.read(&mut request[used..]).await.unwrap();
            assert_ne!(n, 0);
            used += n;
            if request[..used].windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
            request.resize(request.len() * 2, 0);
        }
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
        for delta in [
            json!({"reasoning_content": "inspect before changing"}),
            json!({"tool_calls": [{"index": 0, "id": "c1", "type": "function", "function": {"name": "bash", "arguments": "{\"command\":\"first\"}"}}]}),
            json!({"tool_calls": [{"index": 1, "id": "c2", "type": "function", "function": {"name": "write", "arguments": "{\"path\":\"second.rs\",\"content\":\"new\"}"}}]}),
            json!({"tool_calls": [{"index": 2, "id": "c3", "type": "function", "function": {"name": "read", "arguments": "{\"path\":\"third.rs\"}"}}]}),
        ] {
            let chunk = json!({"choices": [{"index": 0, "delta": delta}]});
            socket
                .write_all(format!("data: {chunk}\n\n").as_bytes())
                .await
                .unwrap();
        }
        socket.write_all(b"data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n").await.unwrap();
        socket.shutdown().await.unwrap();
    });
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let completion = tokio::time::timeout(
        Duration::from_secs(10),
        crate::core::agent::genai_bridge::stream_chat_completions(
            &reqwest13::Client::new(),
            &format!("http://{addr}/v1/chat/completions"),
            &[],
            None,
            &json!({"model": "m", "messages": [{"role": "user", "content": "go"}]}),
            &tx,
            None,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    server.await.unwrap();
    drop(tx);

    let mut app = test_app();
    while let Some(event) = rx.recv().await {
        app.apply(event);
    }
    // The real streamed reasoning precedes the in-progress tool display.
    app.toggle_regions();
    let live = render_rows(&mut app, 120, 50).join("\n");
    assert!(live.contains("inspect before changing"), "{live}");
    // The in-flight bash call types into a terminal box ($ <command>), which
    // trails the reasoning that preceded it.
    assert!(live.contains("$ first"), "{live}");
    assert!(
        live.find("inspect before changing").unwrap() < live.find("$ first").unwrap(),
        "{live}"
    );
    app.toggle_regions();

    for call in completion["choices"][0]["message"]["tool_calls"]
        .as_array()
        .unwrap()
    {
        app.apply(StreamEvent::ToolCall {
            id: call["id"].as_str().unwrap().into(),
            name: call["function"]["name"].as_str().unwrap().into(),
            args: serde_json::from_str(call["function"]["arguments"].as_str().unwrap())
                .unwrap(),
        });
    }
    // A standalone write closes c1's group before any batch result arrives.
    // Resolve the later group first to detect attaching to the wrong owner.
    for (id, content, is_error) in [
        ("c3", "third result", false),
        ("c1", "first failed", true),
        ("c2", "second result", false),
    ] {
        app.apply(StreamEvent::ToolResult {
            id: id.into(),
            content: content.into(),
            is_error,
            diff: None,
        });
    }
    let closed = &app.groups[0];
    assert!(row_text(&app.transcript[closed.idx]).contains('✗'));
    let first = group_detail_lines(closed, 120)
        .iter()
        .map(line_text)
        .collect::<Vec<_>>()
        .join("\n");
    let third = group_detail_lines(app.tool_group.as_ref().unwrap(), 120)
        .iter()
        .map(line_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        first.contains("first failed") && !first.contains("third result"),
        "{first}"
    );
    assert!(
        third.contains("third result") && !third.contains("first failed"),
        "{third}"
    );
    app.toggle_regions();
    let open_idx = app.tool_group.as_ref().unwrap().idx;
    app.toggle_region(open_idx);
    let rendered = render_rows(&mut app, 120, 50).join("\n");
    let reasoning = rendered.find("inspect before changing").unwrap();
    let first = rendered.find("first failed").unwrap();
    let third = rendered.find("third result").unwrap();
    assert!(reasoning < first && first < third, "{rendered}");
}

#[test]
fn native_reasoning_before_next_tool_keeps_prior_result_paired() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "first" }),
    });
    app.apply(StreamEvent::Reasoning {
        text: "deciding on the next call".into(),
    });
    app.apply(StreamEvent::ToolCall {
        id: "c2".into(),
        name: "read".into(),
        args: json!({ "path": "second.rs" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "first result".into(),
        is_error: false,
        diff: None,
    });
    app.apply(StreamEvent::ToolResult {
        id: "c2".into(),
        content: "second result".into(),
        is_error: false,
        diff: None,
    });

    assert_eq!(app.groups.len(), 1, "the first group should be closed by reasoning");
    assert_eq!(app.groups[0].calls[0].content.as_deref(), Some("first result"));
    let current = app.tool_group.as_ref().expect("second group remains open");
    assert_eq!(current.calls[0].id, "c2");
    assert_eq!(current.calls[0].content.as_deref(), Some("second result"));
}

#[test]
fn reasoning_row_is_separated_from_following_prose_by_a_blank_line() {
    let mut app = test_app();
    app.apply(StreamEvent::Token {
        text: "<think>thinking</think>Hi there!".into(),
    });
    app.apply(StreamEvent::Step { index: 1, max: 8 });
    let rows: Vec<String> = app.transcript.iter().map(row_text).collect();
    let think_at = rows
        .iter()
        .position(|r| r.contains("Thought"))
        .unwrap();
    let prose_at = rows.iter().position(|r| r.contains("Hi there!")).unwrap();
    assert!(think_at < prose_at);
    // A blank line must sit between the reasoning row and the prose.
    assert!(
        rows[think_at + 1..prose_at]
            .iter()
            .any(|r| r.trim().is_empty()),
        "expected a blank line between reasoning and prose: {rows:?}"
    );
}

/// A folded reasoning block reads as the desktop's `Thought for Ns`, and the
/// duration is journaled so a resume restamps it rather than dropping to a
/// bare `Thought`.
#[test]
fn committed_reasoning_shows_its_duration_and_survives_resume() {
    let mut app = test_app();
    app.apply(StreamEvent::Reasoning {
        text: "weighing the options".into(),
    });
    // Backdate the open block so it reads as multi-second, not instant.
    app.thinking_since = Some(Instant::now() - Duration::from_secs(3));
    // Answer prose closes the reasoning block, stashing its elapsed.
    app.apply(StreamEvent::Token {
        text: "the answer".into(),
    });
    app.flush_assistant();
    let rows: Vec<String> = app.transcript.iter().map(row_text).collect();
    assert!(
        rows.iter().any(|r| r.contains("Thought for 3s")),
        "collapsed reasoning names its duration: {rows:?}"
    );

    // The duration rides the journal, so a replay restamps the same label.
    let entry = app
        .display_log
        .iter()
        .rev()
        .find(|e| matches!(e, DisplayEntry::Assistant { .. }))
        .cloned()
        .expect("assistant entry journaled");
    let mut fresh = test_app();
    replay_display_log(&mut fresh, vec![entry]);
    let replayed: Vec<String> = fresh.transcript.iter().map(row_text).collect();
    assert!(
        replayed.iter().any(|r| r.contains("Thought for 3s")),
        "resume keeps the duration label: {replayed:?}"
    );
}

#[test]
fn committed_reasoning_folds_and_expands_via_keybinding() {
    let mut app = test_app();
    app.apply(StreamEvent::Token {
        text: "<think>step one\nstep two</think>The answer is 42.".into(),
    });
    // A turn boundary commits the buffer.
    app.apply(StreamEvent::Step { index: 1, max: 8 });

    let rows: Vec<String> = app.transcript.iter().map(row_text).collect();
    assert!(rows.iter().any(|r| r.contains("Thought")));
    assert!(rows.iter().any(|r| r.contains("The answer is 42")));
    // Raw reasoning is hidden until expanded.
    assert!(!rows.iter().any(|r| r.contains("step one")));
    assert_eq!(app.reasoning_blocks.len(), 1);

    let idx = app.reasoning_blocks[0].idx;
    app.toggle_regions();
    assert!(app.expanded.contains(&idx));
    app.toggle_regions();
    assert!(app.expanded.is_empty());
}

/// A finished reasoning + tool run is one trace: once the answer follows it
/// folds by default to a single `Worked · N steps` header, and expanding
/// (toggle or Ctrl-O) restores the run.
#[test]
fn a_finished_trace_folds_to_one_header_and_expands() {
    let mut app = test_app();
    // Reasoning, then a tool call (which commits the reasoning block), then
    // an answer (which closes the tool group and marks the trace finished).
    app.apply(StreamEvent::Token { text: "<think>weigh it</think>".into() });
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "grep".into(),
        args: json!({ "pattern": "x" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "match".into(),
        is_error: false,
        diff: None,
    });
    app.apply(StreamEvent::Token { text: "the answer".into() });
    app.flush_assistant();

    let runs = app.trace_runs();
    assert_eq!(runs.len(), 1, "reasoning + tool group form one trace: {runs:?}");
    assert!(runs[0].tool_ran && runs[0].steps == 2, "{:?}", runs[0]);
    let start = runs[0].start;

    // Default (an answer follows): folded to one header, members hidden.
    let folded = render_rows(&mut app, 70, 20).join("\n");
    assert!(folded.contains("Worked \u{b7} 2 steps"), "fold header: {folded}");
    assert!(!folded.contains("Thought"), "reasoning row hidden: {folded}");
    assert!(folded.contains("the answer"), "prose survives: {folded}");

    // Expanding shows the run and drops the header.
    app.toggle_trace(start);
    let open = render_rows(&mut app, 70, 20).join("\n");
    assert!(open.contains("Thought"), "reasoning summary shows: {open}");
    assert!(!open.contains("Worked \u{b7}"), "no header when expanded: {open}");

    // Ctrl-O folds everything back.
    app.toggle_trace(start);
    let refolded = render_rows(&mut app, 70, 20).join("\n");
    assert!(refolded.contains("Worked \u{b7} 2 steps"), "refolded: {refolded}");
}

/// Ctrl-O (`toggle_regions`) unfolds every collapsed trace along with the
/// per-row detail, and folds them back on the next press.
#[test]
fn ctrl_o_unfolds_and_refolds_traces() {
    let mut app = test_app();
    app.apply(StreamEvent::Token { text: "<think>weigh it</think>".into() });
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "grep".into(),
        args: json!({ "pattern": "x" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "match".into(),
        is_error: false,
        diff: None,
    });
    app.apply(StreamEvent::Token { text: "the answer".into() });
    app.flush_assistant();

    assert!(render_rows(&mut app, 70, 20).join("\n").contains("Worked \u{b7}"), "folded by default");
    app.toggle_regions();
    assert!(!render_rows(&mut app, 70, 20).join("\n").contains("Worked \u{b7}"), "Ctrl-O unfolds");
    app.toggle_regions();
    assert!(render_rows(&mut app, 70, 20).join("\n").contains("Worked \u{b7}"), "Ctrl-O refolds");
}

/// The condensed live view: while an active run streams, its settled steps
/// fold into a live `Working…` header and only the current step (the running
/// command box here) shows below -- no growing pile of settled rows.
#[test]
fn the_active_trace_folds_to_a_live_header() {
    let mut app = test_app();
    app.status = super::super::Status::Running;
    // reasoning, tool, reasoning, then a running tool -- three settled
    // members (two reasoning blocks + one closed group) with no answer yet.
    app.apply(StreamEvent::Token { text: "<think>first</think>".into() });
    app.apply(StreamEvent::ToolCall {
        id: "t1".into(),
        name: "grep".into(),
        args: json!({ "pattern": "x" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "t1".into(),
        content: "match".into(),
        is_error: false,
        diff: None,
    });
    app.apply(StreamEvent::Token { text: "<think>second</think>".into() });
    app.apply(StreamEvent::ToolCall {
        id: "t2".into(),
        name: "bash".into(),
        args: json!({ "command": "cargo test" }),
    });

    let runs = app.trace_runs();
    assert_eq!(runs.len(), 1, "one active run of settled steps: {runs:?}");
    assert!(runs[0].steps == 3 && runs[0].tool_ran, "{:?}", runs[0]);

    let live = render_rows(&mut app, 70, 20).join("\n");
    // Live header (present tense, spinner-led), settled steps folded away.
    assert!(live.contains("Working \u{b7} 3 steps"), "live header: {live}");
    assert!(!live.contains("Thought"), "settled steps folded: {live}");
    // The current step -- the running command -- shows below the header.
    assert!(live.contains("$ cargo test"), "current step shows: {live}");
}

/// A lone settled step is not worth a fold header: it is already one line, so
/// a header saves no space, reads as "1 step", and would then un-fold on
/// wrap-up (the committed trace fold needs 2+ too). It stays visible beside
/// the current step instead. Only a second settled step earns the fold.
#[test]
fn a_lone_finished_tool_is_not_folded() {
    let mut app = test_app();
    app.status = super::super::Status::Running;
    app.apply(StreamEvent::Token { text: "here goes".into() });
    app.flush_assistant(); // an answer, so what follows is a fresh active run
    app.apply(StreamEvent::ToolCall {
        id: "t1".into(),
        name: "bash".into(),
        args: json!({ "command": "git diff" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "t1".into(),
        content: "changed.rs".into(),
        is_error: false,
        diff: None,
    });
    // Reasoning now streams: one settled tool + the current reasoning step.
    app.apply(StreamEvent::Token { text: "<think>analyzing the diff".into() });

    let live = render_rows(&mut app, 70, 20).join("\n");
    assert!(!live.contains("Working \u{b7}"), "a lone step is not folded: {live}");
    assert!(live.contains("git diff"), "the finished tool shows: {live}");
    assert!(live.contains("analyzing the diff"), "the current reasoning shows: {live}");
}

/// The reported case: while the next tool call is still typing its arguments
/// (the live typing box), the prior settled steps must fold behind the live
/// header rather than all rendering above the box.
#[test]
fn prior_steps_fold_while_the_next_tool_call_is_typing() {
    let mut app = test_app();
    app.status = super::super::Status::Running;
    app.apply(StreamEvent::Token { text: "<think>investigating</think>".into() });
    app.apply(StreamEvent::ToolCall {
        id: "t1".into(),
        name: "bash".into(),
        args: json!({ "command": "grep needle" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "t1".into(),
        content: "hit".into(),
        is_error: false,
        diff: None,
    });
    // The next call begins streaming its arguments -- the current step.
    app.apply(StreamEvent::ToolCallStarted {
        id: "t2".into(),
        name: "bash".into(),
    });
    app.apply(StreamEvent::ToolCallArgsDelta {
        id: "t2".into(),
        delta: "{\"command\": \"cargo build\"}".into(),
    });

    let live = render_rows(&mut app, 70, 20).join("\n");
    assert!(live.contains("Working \u{b7} 2 steps"), "prior steps fold: {live}");
    assert!(!live.contains("grep needle"), "the prior command row is gone: {live}");
    assert!(live.contains("cargo build"), "the typing box is the current step: {live}");
}

/// The screenshot case: after an answer, a fresh run of settled steps must
/// stay folded across the gap between one step finishing and the next
/// starting -- while the run is live, not only while a token is mid-flight.
#[test]
fn a_settled_run_stays_folded_in_the_gap_between_steps() {
    let mut app = test_app();
    app.status = super::super::Status::Running;
    app.apply(StreamEvent::Token { text: "I'll review this PR.".into() });
    app.flush_assistant(); // the answer, so what follows is a fresh run
    for (id, cmd) in [("t1", "grep alpha"), ("t2", "grep bravo")] {
        app.apply(StreamEvent::Token {
            text: format!("<think>step {id}</think>"),
        });
        app.apply(StreamEvent::ToolCall {
            id: id.into(),
            name: "bash".into(),
            args: json!({ "command": cmd }),
        });
        app.apply(StreamEvent::ToolResult {
            id: id.into(),
            content: "ok".into(),
            is_error: false,
            diff: None,
        });
    }
    // No token in flight now: a bare gap, but the run is still live, so the
    // settled steps stay folded behind the header rather than un-folding for
    // the frame before the next step's content arrives.
    let live = render_rows(&mut app, 90, 24).join("\n");
    assert!(live.contains("Working \u{b7} 4 steps"), "the run folds in the gap: {live}");
    assert!(!live.contains("grep alpha"), "no lingering command rows: {live}");
    assert!(!live.contains("grep bravo"), "no lingering command rows: {live}");

    // The fold does not depend on a Step event to hold; a Step (the next
    // turn) keeps it folded just the same, never toggling it open.
    app.apply(StreamEvent::Step { index: 3, max: 8 });
    let folded = render_rows(&mut app, 90, 24).join("\n");
    assert!(folded.contains("Working \u{b7} 4 steps"), "still folded after a Step: {folded}");
    assert!(!folded.contains("grep alpha"), "prior command rows stay hidden: {folded}");
    assert!(!folded.contains("grep bravo"), "prior command rows stay hidden: {folded}");
}

/// Gating the live fold on `Status::Running` ties it to the run's lifetime: a
/// `Step` landing as the last event before the stream stops cannot leave an
/// animated `Working · N steps` header spinning over an idle transcript. This
/// is the phantom-header regression the removed `step_boundary` flag caused
/// (it was never reset on the terminal paths, which skip `apply`).
#[test]
fn the_live_fold_ends_with_the_run() {
    let mut app = test_app();
    app.status = super::super::Status::Running;
    for (id, cmd) in [("t1", "grep alpha"), ("t2", "grep bravo")] {
        app.apply(StreamEvent::Token {
            text: format!("<think>step {id}</think>"),
        });
        app.apply(StreamEvent::ToolCall {
            id: id.into(),
            name: "bash".into(),
            args: json!({ "command": cmd }),
        });
        app.apply(StreamEvent::ToolResult {
            id: id.into(),
            content: "ok".into(),
            is_error: false,
            diff: None,
        });
    }
    // A Step arrives, then the run stops with no further content.
    app.apply(StreamEvent::Step { index: 2, max: 8 });
    assert!(
        render_rows(&mut app, 90, 24).join("\n").contains("Working \u{b7} 4 steps"),
        "folded while the run is live"
    );
    app.status = super::super::Status::Idle;
    let idle = render_rows(&mut app, 90, 24).join("\n");
    assert!(!idle.contains("Working"), "no phantom animated header at idle: {idle}");
}

#[test]
fn silent_consecutive_tool_calls_still_fold() {
    let mut app = test_app();
    // No reasoning/prose between calls: they must fold into one group row.
    for id in ["c1", "c2", "c3"] {
        app.apply(StreamEvent::ToolCall {
            id: id.into(),
            name: "bash".into(),
            args: json!({ "command": "ls" }),
        });
        app.apply(StreamEvent::ToolResult {
            id: id.into(),
            content: "ok".into(),
            is_error: false,
            diff: None,
        });
    }
    assert!(app.tool_group.is_some());
    let tool_rows = app
        .transcript
        .iter()
        .filter(|l| {
            let t = row_text(l);
            t.contains("Executing") || t.contains("Running") || t.contains("Ran ")
        })
        .count();
    assert_eq!(tool_rows, 1);
    app.apply(StreamEvent::Token {
        text: "All done.".into(),
    });
    assert!(app.tool_group.is_none());
    let row = app
        .transcript
        .iter()
        .map(row_text)
        .find(|t| t.contains("Ran "))
        .unwrap();
    assert!(row.contains("✓ Ran 3 commands"), "row: {row}");
}

#[test]
fn on_done_normal_stop_with_answer_has_no_warning() {
    let mut app = test_app();
    app.apply(StreamEvent::Token {
        text: "The answer.".into(),
    });
    app.on_done("stop".into(), None);
    assert!(!app
        .transcript
        .iter()
        .any(|l| row_text(l).contains("finished")));
}

#[test]
fn on_done_truncated_finish_warns_in_timeline() {
    let mut app = test_app();
    app.apply(StreamEvent::Token {
        text: "partial".into(),
    });
    app.on_done("length".into(), None);
    let warn = app
        .transcript
        .iter()
        .map(row_text)
        .find(|t| t.contains("finished early"))
        .unwrap();
    assert!(warn.contains("length"), "warn: {warn}");
}

#[test]
fn on_done_stop_without_answer_warns() {
    let mut app = test_app();
    // Only reasoning, no answer prose (or an empty/malformed completion).
    app.apply(StreamEvent::Token {
        text: "<think>hmm</think>".into(),
    });
    app.on_done("stop".into(), None);
    assert!(app
        .transcript
        .iter()
        .any(|l| row_text(l).contains("finished with no answer")));
}

#[test]
fn permission_prompt_does_not_break_tool_folding() {
    let mut app = test_app();
    for id in ["c1", "c2"] {
        app.apply(StreamEvent::ToolCall {
            id: id.into(),
            name: "bash".into(),
            args: json!({ "command": "grep -n foo src/" }),
        });
        app.apply(StreamEvent::PermissionRequest {
            request_id: format!("p-{id}"),
            tool_name: "bash".into(),
            capability: "exec".into(),
            path: None,
            command: Some("grep -n foo src/".into()),
            diff: None,
            patch: None,
            prompt_kind: "exec".into(),
            offers_always: true,
            reason: None,
            args_digest: None,
            call_id: None,
        });
        app.pending_queue.clear(); // simulate approval
        app.apply(StreamEvent::ToolResult {
            id: id.into(),
            content: "ok".into(),
            is_error: false,
            diff: None,
        });
    }
    // Both gated calls stayed in one running group despite the prompts.
    assert!(app.tool_group.is_some());
    let tool_rows = app
        .transcript
        .iter()
        .filter(|l| {
            let t = row_text(l);
            t.contains("Executing") || t.contains("Running") || t.contains("Ran")
        })
        .count();
    assert_eq!(tool_rows, 1);
}

#[test]
fn diff_tool_result_keeps_separate_rows_and_panel() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "edit".into(),
        args: json!({ "path": "a.txt" }),
    });
    let before = app.transcript.len();
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "edited".into(),
        is_error: false,
        diff: Some("- old\n+ new".into()),
    });
    // Call row preserved; result row + boxed diff appended below it.
    assert!(app.transcript.len() > before);
    let joined: String = app
        .transcript
        .iter()
        .map(row_text)
        .collect::<Vec<_>>()
        .join("\n");
    // The call row resolves to past tense once the result lands.
    assert!(joined.contains("Edited a.txt"), "{joined}");
    assert!(!joined.contains("Editing a.txt"), "{joined}");
    assert!(joined.contains('┌') && joined.contains('┘'), "{joined}");
}

#[test]
fn diff_tool_row_reads_present_tense_until_its_result_lands() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "write".into(),
        args: json!({ "path": "a.txt", "content": "x" }),
    });
    assert!(row_text(app.transcript.last().unwrap()).contains("Writing a.txt"));
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "boom".into(),
        is_error: true,
        diff: None,
    });
    let joined: String = app
        .transcript
        .iter()
        .map(row_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(joined.contains("✗ Wrote a.txt"), "{joined}");
    assert!(app.pending_rows.is_empty());
}

/// The common shape: several grouped calls (bash, not the standalone
/// edit/write rows), each run separated by the model's prose. Live, the
/// prose is what closes each group; a replay must close them the same way or
/// every call folds into one row that is never committed.
#[tokio::test]
async fn resume_restores_grouped_tool_calls_between_prose() {
    let mut app = test_app();
    app.submit_user("check it".to_string());
    for (i, cmd) in ["git status", "git log -1"].iter().enumerate() {
        app.apply(StreamEvent::Token {
            text: format!("<think>step {i}</think>"),
        });
        app.apply(StreamEvent::ToolCall {
            id: format!("c{i}"),
            name: "bash".into(),
            args: json!({ "command": cmd }),
        });
        app.apply(StreamEvent::ToolResult {
            id: format!("c{i}"),
            content: "output".into(),
            is_error: false,
            diff: None,
        });
        app.apply(StreamEvent::Token {
            text: format!("Ran {cmd}.\n"),
        });
    }
    app.on_done("stop".into(), None);
    app.join_journal();
    let live: String = app
        .transcript
        .iter()
        .map(row_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        live.contains("git status") && live.contains("git log -1"),
        "{live}"
    );

    let mut fresh = test_app();
    fresh.agent_dir = app.agent_dir.clone();
    apply_resume(&mut fresh, &ResumeRequest::resume(ResumeTarget::Latest)).await;
    let resumed: String = fresh
        .transcript
        .iter()
        .map(row_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        resumed.contains("git status") && resumed.contains("git log -1"),
        "both grouped calls must come back as their own rows:\n{resumed}"
    );
    assert!(
        fresh.tool_group.is_none(),
        "no group may be left open after a replay"
    );
    assert_eq!(fresh.groups.len(), 2, "one closed group per run of calls");
    // Expanding a restored group row still shows the call and its output.
    fresh.toggle_regions();
    let expanded = render_rows(&mut fresh, 80, 40).join("\n");
    assert!(expanded.contains("output"), "{expanded}");
}

/// The worktree belongs to the thread, not just the session: a resume has to
/// find its way back to the checkout the conversation was written against.
#[tokio::test]
async fn a_session_records_its_worktree_and_a_resume_reads_it_back() {
    let mut app = test_app();
    app.set_workspace(Some(test_worktree("/tmp/wt-a")));
    app.submit_user("do it".into());
    app.on_done("stop".into(), None);
    let id = app.thread_id.clone().expect("saved");

    let thread = super::super::super::cli_get_thread_in(&app.agent_dir, &id).unwrap();
    assert_eq!(
        super::super::super::worktree::from_metadata(thread.get("metadata")),
        Some(test_worktree("/tmp/wt-a"))
    );
}

/// The checkout is frozen in the args a session's runs share, so loading a
/// thread from a different one must report the mismatch, not pretend.
#[tokio::test]
async fn resuming_a_thread_from_another_checkout_says_so() {
    let mut app = test_app();
    app.set_workspace(Some(test_worktree("/tmp/wt-a")));
    app.submit_user("do it".into());
    app.on_done("stop".into(), None);

    let mut elsewhere = test_app();
    elsewhere.agent_dir = app.agent_dir.clone();
    elsewhere.set_workspace(Some(test_worktree("/tmp/wt-b")));
    apply_resume(&mut elsewhere, &ResumeRequest::resume(ResumeTarget::Latest)).await;
    let notes: String = elsewhere
        .transcript
        .iter()
        .map(row_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        notes.contains("last worked in") && notes.contains("wt-a"),
        "{notes}"
    );

    // Same checkout: nothing to warn about.
    let mut same = test_app();
    same.agent_dir = app.agent_dir.clone();
    same.set_workspace(Some(test_worktree("/tmp/wt-a")));
    apply_resume(&mut same, &ResumeRequest::resume(ResumeTarget::Latest)).await;
    assert!(!same
        .transcript
        .iter()
        .map(row_text)
        .any(|t| t.contains("last worked in")));
}

/// The whole point of a fork over a rewind: the branch opens on the prefix,
/// with the tool rows the journal carried, and the source is still there.
#[tokio::test]
async fn fork_branches_the_prefix_and_leaves_the_source_whole() {
    let mut app = test_app();
    record_full_turn(&mut app);
    app.submit_user("and again".to_string());
    app.apply(StreamEvent::Token {
        text: "Second answer.".into(),
    });
    app.on_done("stop".into(), None);
    let source = app.thread_id.clone().expect("saved");

    fork_at(&mut app, 1).await;
    let forked = app.thread_id.clone().expect("landed on the fork");
    assert_ne!(forked, source);

    let after: String = app
        .transcript
        .iter()
        .map(row_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        after.contains("✓ Wrote a.txt") && after.contains("@@ created file @@"),
        "the journal was carried, not just the wire history: {after}"
    );
    assert!(!after.contains("Second answer."), "{after}");
    assert_eq!(
        app.input, "and again",
        "the forked-away message is ready to re-ask"
    );

    // The source is untouched: both turns still resumable from it.
    let mut back = test_app();
    back.agent_dir = app.agent_dir.clone();
    apply_resume(
        &mut back,
        &ResumeRequest::resume(ResumeTarget::Id(source.clone())),
    )
    .await;
    assert_eq!(back.thread_id.as_deref(), Some(source.as_str()));
    assert!(back
        .transcript
        .iter()
        .map(row_text)
        .any(|t| t.contains("Second answer.")));
}

/// A fork is a rewind that keeps the original, so the branch must render
/// exactly what rewinding the source to the same turn would have rendered.
#[tokio::test]
async fn a_fork_replays_the_rows_a_rewind_to_the_same_turn_leaves() {
    let mut forked = test_app();
    record_full_turn(&mut forked);
    forked.submit_user("and again".to_string());
    forked.apply(StreamEvent::Token {
        text: "Second answer.".into(),
    });
    forked.on_done("stop".into(), None);

    let mut rewound = test_app();
    rewound.agent_dir = forked.agent_dir.clone();
    apply_resume(&mut rewound, &ResumeRequest::resume(ResumeTarget::Latest)).await;
    rewind_to(&mut rewound, 1, false);

    fork_at(&mut forked, 1).await;

    // Notes are transient by design and never journaled, so they are the one
    // thing the two paths are allowed to disagree on.
    let rows = |app: &App| {
        app.transcript
            .iter()
            .map(row_text)
            .filter(|t| !t.trim_start().starts_with('\u{2022}'))
            .collect::<Vec<_>>()
    };
    assert_eq!(rows(&forked), rows(&rewound));
    assert_eq!(forked.history, rewound.history);
    assert_eq!(forked.display_log, rewound.display_log);
}

/// The parent pointer has to survive the branch's own first save, which
/// rewrites the whole metadata object.
#[tokio::test]
async fn a_fork_keeps_its_parent_pointer_across_later_saves() {
    let mut app = test_app();
    record_full_turn(&mut app);
    app.submit_user("and again".to_string());
    app.on_done("stop".into(), None);
    let source = app.thread_id.clone().expect("saved");

    fork_at(&mut app, 1).await;
    let forked = app.thread_id.clone().expect("landed on the fork");
    app.submit_user("a different approach".to_string());
    app.on_done("stop".into(), None);

    let meta = super::super::super::cli_get_thread_in(&app.agent_dir, &forked).unwrap();
    assert_eq!(
        meta["metadata"][super::super::super::FORKED_FROM_KEY],
        json!({ "thread_id": source, "user_turn": 1 })
    );
}

/// A fork borrows the live checkout for the rest of the session but must not
/// record it: the branch it opens later is its own, and two conversations on
/// one checkout is what a worktree exists to prevent.
#[tokio::test]
async fn a_fork_never_records_the_checkout_it_borrows() {
    let mut app = test_app();
    app.set_workspace(Some(test_worktree("/tmp/wt-a")));
    record_full_turn(&mut app);
    app.submit_user("and again".to_string());
    app.on_done("stop".into(), None);

    fork_at(&mut app, 1).await;
    let forked = app.thread_id.clone().expect("landed on the fork");
    app.submit_user("a different approach".to_string());
    app.on_done("stop".into(), None);

    let thread = super::super::super::cli_get_thread_in(&app.agent_dir, &forked).unwrap();
    assert_eq!(
        super::super::super::worktree::from_metadata(thread.get("metadata")),
        None,
        "the fork claimed its source's checkout"
    );
    assert_eq!(
        app.workspace,
        Some(test_worktree("/tmp/wt-a")),
        "the tools keep writing where the frozen run args point"
    );
}

/// The pointer belongs to the thread: resuming one from elsewhere (or with no
/// worktree at all) must not overwrite the checkout it recorded.
#[tokio::test]
async fn a_resumed_thread_keeps_the_checkout_it_recorded() {
    let mut app = test_app();
    app.set_workspace(Some(test_worktree("/tmp/wt-a")));
    app.submit_user("do it".into());
    app.on_done("stop".into(), None);
    let id = app.thread_id.clone().expect("saved");

    for live in [Some(test_worktree("/tmp/wt-b")), None] {
        let mut other = test_app();
        other.agent_dir = app.agent_dir.clone();
        other.set_workspace(live);
        apply_resume(&mut other, &ResumeRequest::resume(ResumeTarget::Latest)).await;
        other.submit_user("more".into());
        other.on_done("stop".into(), None);

        let thread = super::super::super::cli_get_thread_in(&app.agent_dir, &id).unwrap();
        assert_eq!(
            super::super::super::worktree::from_metadata(thread.get("metadata")),
            Some(test_worktree("/tmp/wt-a"))
        );
    }
}

#[tokio::test]
async fn rewind_keeps_the_kept_turns_tool_rows() {
    let mut app = test_app();
    record_full_turn(&mut app);
    app.submit_user("and again".to_string());
    app.apply(StreamEvent::Token {
        text: "Second answer.".into(),
    });
    app.on_done("stop".into(), None);

    rewind_to(&mut app, 1, false);
    let after: String = app
        .transcript
        .iter()
        .map(row_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        after.contains("✓ Wrote a.txt"),
        "first turn keeps its rows: {after}"
    );
    assert!(after.contains("@@ created file @@"), "{after}");
    assert!(
        !after.contains("Second answer."),
        "rewound turn is gone: {after}"
    );
    assert!(
        !app.display_log
            .iter()
            .any(|e| matches!(e, DisplayEntry::User { text, .. } if text == "and again")),
        "the journal is truncated with the conversation"
    );
    assert_eq!(
        app.input, "and again",
        "the rewound message returns to the input"
    );
}

#[test]
fn a_drag_selects_instead_of_toggling_the_row_under_it() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "grep".into(),
        args: json!({ "pattern": "foo" }),
    });
    let idx = app.tool_group.as_ref().expect("group open").idx;
    app.transcript_rect = Rect::new(0, 0, 80, 10);
    app.last_scroll = 0;
    app.row_index = vec![Some(idx)];

    handle_mouse(
        &mut app,
        mouse_at(MouseEventKind::Down(MouseButton::Left), 5, 1),
    );
    handle_mouse(
        &mut app,
        mouse_at(MouseEventKind::Drag(MouseButton::Left), 30, 1),
    );
    handle_mouse(
        &mut app,
        mouse_at(MouseEventKind::Up(MouseButton::Left), 30, 1),
    );

    assert!(app.expanded.is_empty(), "a drag must not expand the row");
    assert!(app.copy_armed, "the release arms the copy");
    let sel = app.selection.expect("selection held after release");
    assert!(!sel.dragging);
    assert_eq!(sel.spans(80), vec![(1, 5, 30)]);
}

/// A compaction the run does itself shows as `compacting` while it runs,
/// and leaves one line saying why when it lands.
#[test]
fn an_in_run_compaction_is_shown_and_then_explained() {
    use crate::core::agent::events::CompactionPhase;
    let mut app = test_app();
    app.status = Status::Running;
    app.apply(compaction_event(CompactionPhase::Started, None));
    let header: String = header_spans(&app).iter().map(|s| s.content.to_string()).collect();
    assert!(header.contains("compacting"), "{header}");
    app.apply(compaction_event(CompactionPhase::Finished, Some(12)));
    assert!(app.run_compacting.is_none());
    let rows = render_rows(&mut app, 120, 30).join("\n");
    assert!(
        rows.contains("compacted 12 messages into a summary: the session token budget was used up"),
        "{rows}"
    );
}

#[test]
fn a_failed_or_cancelled_compaction_clears_the_throbber() {
    use crate::core::agent::events::CompactionPhase;
    let mut app = test_app();
    app.status = Status::Running;
    app.apply(compaction_event(CompactionPhase::Started, None));
    app.apply(compaction_event(CompactionPhase::Failed, None));
    assert!(app.run_compacting.is_none());
    app.apply(compaction_event(CompactionPhase::Started, None));
    app.cancel_run();
    assert!(app.run_compacting.is_none());
}

/// A pending resend reads as `retrying`, not as a slow model, and the next
/// event of the run clears it.
#[test]
fn a_retry_is_shown_live_and_cleared_by_the_next_event() {
    let mut app = test_app();
    app.status = Status::Running;
    app.apply(retry_event(2, 5_000));
    let header: String = header_spans(&app).iter().map(|s| s.content.to_string()).collect();
    assert!(header.contains("retrying"), "{header}");
    assert!(!header.contains("working"), "{header}");
    let wait = app.retrying.as_ref().expect("a retry is pending");
    assert!(super::super::retry_wait_label(wait, Instant::now()).contains("attempt 2/10"));
    // Only the first retry leaves a transcript line.
    let notes = |app: &mut App| {
        render_rows(app, 120, 30)
            .iter()
            .filter(|row| row.contains("busy; retrying"))
            .count()
    };
    assert_eq!(notes(&mut app), 1, "the first retry leaves one transcript line");
    app.apply(retry_event(3, 5_000));
    assert_eq!(notes(&mut app), 1, "later retries stay out of the transcript");
    app.apply(StreamEvent::Token { text: "hi".into() });
    assert!(app.retrying.is_none(), "the answer arriving ends the wait");
}

#[test]
fn a_retry_past_its_wait_reads_as_in_flight_and_cancel_clears_it() {
    let mut app = test_app();
    app.status = Status::Running;
    app.apply(retry_event(2, 0));
    let wait = app.retrying.as_ref().expect("pending");
    let label = super::super::retry_wait_label(wait, Instant::now() + Duration::from_secs(1));
    assert!(label.starts_with("retrying ("), "{label}");
    let counting = super::super::RetryWait {
        attempt: 4,
        max_attempts: 10,
        at: Instant::now() + Duration::from_secs(3),
        reason: "r".into(),
    };
    assert!(super::super::retry_wait_label(&counting, Instant::now()).starts_with("retrying in "));
    app.cancel_run();
    assert!(app.retrying.is_none());
}

/// Parallel agents collapse into one fixed-height block, each carrying the
/// numbers that say whether it is progressing or about to blow its context.
#[test]
fn parallel_subagents_render_one_block_with_live_stats() {
    let mut app = test_app();
    for (i, name) in ["alpha", "beta"].iter().enumerate() {
        let run = format!("r{i}");
        start_subagent(&mut app, &run, name);
        subagent_event(&mut app, &run, name, StreamEvent::Step { index: 1, max: 8 });
        subagent_event(
            &mut app,
            &run,
            name,
            StreamEvent::TurnUsage {
                usage: Usage {
                    // 12.8K of a 128K window -> 10.0%.
                    prompt_tokens: Some(12_800 + i as u64 * 12_800),
                    completion_tokens: Some(100),
                    total_tokens: Some(12_900),
                    ..Default::default()
                },
                execution_id: None,
            },
        );
        subagent_event(
            &mut app,
            &run,
            name,
            StreamEvent::ToolCall {
                id: format!("c{i}"),
                name: "read".into(),
                args: json!({ "path": format!("{name}.rs") }),
            },
        );
    }

    let rows = render_rows(&mut app, 100, 24);
    let out = rows.join("\n");
    assert!(out.contains("2 agents"), "no consolidated header: {out}");
    for (name, pct) in [("alpha", "10.0%"), ("beta", "20.0%")] {
        assert!(out.contains(name), "missing {name}: {out}");
        assert!(out.contains(pct), "missing context share {pct}: {out}");
    }
    assert!(
        out.contains("1t · 1r"),
        "missing compact call/request counts: {out}"
    );
    // Two agents -> one activity line each, so the block stays scannable.
    assert_eq!(
        rows.iter()
            .filter(|r| r.contains("alpha.rs") || r.contains("beta.rs"))
            .count(),
        2,
        "expected exactly one activity line per agent: {out}"
    );
}

/// The fan-out is pinned above the input, not woven into the transcript: it
/// describes what is running *now*, so it must sit below prose the parent
/// emitted earlier, no matter when the dispatch happened.
#[test]
fn fan_out_is_pinned_below_the_transcript() {
    let mut app = test_app();
    start_subagent(&mut app, "r0", "alpha");
    app.apply(StreamEvent::Token {
        text: "parent keeps talking".into(),
    });
    app.flush_assistant();

    let rows = render_rows(&mut app, 100, 24);
    let prose = rows
        .iter()
        .position(|r| r.contains("parent keeps talking"))
        .expect("prose row");
    let panel = rows
        .iter()
        .position(|r| r.contains("alpha"))
        .expect("panel row");
    let input = rows
        .iter()
        .position(|r| r.contains("Type here to chat with agent"))
        .expect("input");
    assert!(prose < panel, "the panel is docked, not inline: {rows:?}");
    assert!(panel < input, "and it sits above the input: {rows:?}");
    assert!(
        rows.iter()
            .any(|r| r.contains("2 agents") || r.contains("1 agent")),
        "the fan-out is counted: {rows:?}"
    );
}

/// The panel is live state: when the last child ends it vanishes, leaving
/// the committed summary row as the only trace in the conversation.
#[test]
fn panel_clears_when_the_last_child_ends() {
    let mut app = test_app();
    start_subagent(&mut app, "r0", "alpha");
    app.apply(StreamEvent::SubagentEnd {
        run_id: "r0".into(),
        name: "alpha".into(),
    });
    assert!(app.subagents.is_empty(), "live panel closed");
    let rows = render_rows(&mut app, 100, 24);
    assert!(
        !rows.iter().any(|r| r.contains("1 agent")),
        "panel must be gone: {rows:?}"
    );
    assert!(
        rows.iter().any(|r| r.contains("subagent alpha finished")),
        "summary row missing: {rows:?}"
    );
}

/// `await_subagent` on a child that already has a live panel used to print
/// a second "Awaiting subagent: X" row directly under the block that was
/// showing that child's progress. Only an orphaned wait gets a row.
#[test]
fn awaiting_row_is_suppressed_while_the_child_has_a_live_panel() {
    let mut app = test_app();
    start_subagent(&mut app, "r0", "alpha");
    app.apply(StreamEvent::ToolCall {
        id: "a1".into(),
        name: "await_subagent".into(),
        args: json!({ "run_id": "r0" }),
    });
    assert_eq!(app.awaiting.len(), 1, "wait state is still tracked");
    let rows = render_rows(&mut app, 100, 24);
    assert!(
        !rows.iter().any(|r| r.contains("Awaiting subagent")),
        "live panel already reports this child: {rows:?}"
    );

    // The child ends while its result is still in flight: with no panel
    // left to report it, the wait gets its own row again.
    app.subagents.clear();
    let rows = render_rows(&mut app, 100, 24);
    assert!(
        rows.iter().any(|r| r.contains("Awaiting subagent")),
        "orphaned wait must stay visible: {rows:?}"
    );
}

/// Regression: a child streaming a large `write` completes no tool call
/// for the whole request, so the panel used to sit frozen on
/// "0 tools / starting…" for exactly the stretch the user most wants
/// feedback on. Its in-flight call must report progress like the parent's.
#[test]
fn subagent_reports_its_in_flight_call() {
    let mut app = test_app();
    start_subagent(&mut app, "r0", "flappy-2d");
    subagent_event(
        &mut app,
        "r0",
        "flappy-2d",
        StreamEvent::Step { index: 1, max: 8 },
    );

    // The child announces a write and starts streaming its arguments --
    // no ToolCall yet, which is the whole problem.
    subagent_event(
        &mut app,
        "r0",
        "flappy-2d",
        StreamEvent::ToolCallStarted {
            id: "c1".into(),
            name: "write".into(),
        },
    );
    let out = render_rows(&mut app, 100, 20).join("\n");
    assert!(
        !out.contains("starting…"),
        "should have moved off the placeholder: {out}"
    );
    assert!(
        out.contains("write"),
        "should name the tool being assembled: {out}"
    );

    // Once the path arrives it names the destination, still mid-stream.
    for delta in [r#"{"path":"flappy"#, r#"-2d.html","content":"<!doct"#] {
        subagent_event(
            &mut app,
            "r0",
            "flappy-2d",
            StreamEvent::ToolCallArgsDelta {
                id: "c1".into(),
                delta: delta.into(),
            },
        );
    }
    let out = render_rows(&mut app, 100, 20).join("\n");
    assert!(
        out.contains("flappy-2d.html"),
        "destination should surface: {out}"
    );
    assert!(out.contains("0t · "), "still no completed call: {out}");

    // The completed call supersedes the in-progress row.
    subagent_event(
        &mut app,
        "r0",
        "flappy-2d",
        StreamEvent::ToolCall {
            id: "c1".into(),
            name: "write".into(),
            args: json!({ "path": "flappy-2d.html" }),
        },
    );
    let out = render_rows(&mut app, 100, 20).join("\n");
    assert!(out.contains("1t · "), "completed call should count: {out}");
    assert!(
        app.subagents[0].active.is_none(),
        "in-flight view should clear once the call lands"
    );
}

/// When the model is reasoning (a ` think>` block is streaming), the input
/// placeholder cycles through synonyms of "thinking".
#[test]
fn thinking_placeholder_uses_thinking_synonyms() {
    let mut app = test_app();
    app.submit_user("go".into());
    app.apply(StreamEvent::Token {
        text: "<think>ponder the plan".into(),
    });
    // Pinned off for the same reason as `working_placeholder_animates`:
    // the sweep replaces a letter of the word being matched.
    let row = with_wave_glyph(None, || {
        render_rows(&mut app, 80, 12)
            .into_iter()
            .find(|r| r.contains("(Esc to cancel, type to steer the agent)"))
            .expect("running placeholder present")
    });
    assert!(
        THINKING_WORDS.iter().any(|w| row.contains(w)),
        "expected a thinking synonym in: {row:?}"
    );
    assert!(
        !WORKING_WORDS.iter().any(|w| row.contains(w)),
        "no working synonym while reasoning: {row:?}"
    );
}

/// Native reasoning events (a dedicated `reasoning_content` field) drive the
/// same orange thinking placeholder as inline `<`> tags, are folded into the
/// transcript like a wrapped block on flush, and never enter the wire answer.
#[test]
fn native_reasoning_drives_thinking_placeholder_and_folds_on_flush() {
    let mut app = test_app();
    app.submit_user("go".into());
    app.apply(StreamEvent::Reasoning {
        text: "ponder the plan".into(),
    });
    // Pinned off: this asserts on the *word*, and the sweep overwrites a
    // letter of it with the travelling glyph. `wave` is on by default now,
    // so leaving it to the process state makes this test depend on
    // whichever config the shared cell resolved first.
    let row = with_wave_glyph(None, || {
        render_rows(&mut app, 80, 12)
            .into_iter()
            .find(|r| r.contains("(Esc to cancel, type to steer the agent)"))
            .expect("running placeholder present")
    });
    assert!(
        THINKING_WORDS.iter().any(|w| row.contains(w)),
        "expected a thinking synonym while reasoning: {row:?}"
    );
    // The answer arrives: reasoning stays folded into a summary row.
    app.apply(StreamEvent::Token {
        text: "Here is the answer".into(),
    });
    app.on_done("stop".into(), None);
    assert_eq!(
        app.reasoning_blocks.len(),
        1,
        "reasoning folded into one block"
    );
    // The wire history carries the answer, with the reasoning preserved on
    // the message's `reasoning_content` rather than inlined into `content`.
    let last = app.history.last().expect("assistant turn in history");
    assert_eq!(last["content"], "Here is the answer");
    assert_eq!(
        last["reasoning_content"], "ponder the plan",
        "reasoning must be preserved for resend: {last}"
    );
    assert!(
        !last["content"]
            .as_str()
            .unwrap_or_default()
            .contains("ponder the plan"),
        "reasoning must not be inlined into the answer content: {last}"
    );
}

/// A cancelled turn keeps the reasoning that produced its partial answer,
/// so the next prompt resumes with the same context the model had.
#[test]
fn cancel_preserves_native_reasoning_on_the_partial_answer() {
    let mut app = test_app();
    app.submit_user("go".into());
    app.apply(StreamEvent::Reasoning {
        text: "half a thought".into(),
    });
    app.apply(StreamEvent::Token {
        text: "Partial answer".into(),
    });
    app.cancel_run();
    let last = app.history.last().expect("assistant turn in history");
    assert_eq!(last["content"], "Partial answer");
    assert_eq!(last["reasoning_content"], "half a thought");
}

/// A turn with no native reasoning must not grow a `reasoning_content` key:
/// providers that reject unknown assistant fields see an unchanged shape.
#[test]
fn a_turn_without_reasoning_adds_no_reasoning_key_to_history() {
    let mut app = test_app();
    app.submit_user("go".into());
    app.apply(StreamEvent::Token {
        text: "Just an answer".into(),
    });
    app.on_done("stop".into(), None);
    let last = app.history.last().expect("assistant turn in history");
    assert_eq!(last["content"], "Just an answer");
    assert!(
        last.get("reasoning_content").is_none(),
        "no reasoning streamed, so the key must be absent: {last}"
    );
}

/// The `[thinking]` badge and the orange placeholder must close when the
/// answer starts streaming: native segments live until the next flush, so
/// only the "newest segment is still at the tail" check can tell the two
/// apart. Without it the badge shimmered through the whole answer and
/// `[thought for Ns]` never appeared for a `reasoning_content` provider.
#[test]
fn native_reasoning_badge_closes_once_prose_starts() {
    let mut app = test_app();
    app.submit_user("go".into());
    app.apply(StreamEvent::Reasoning {
        text: "ponder".into(),
    });
    assert_eq!(
        app.reasoning_status().map(|(w, _)| w),
        Some("thinking".to_string())
    );
    assert!(app.reasoning_open(), "reasoning is live");
    app.apply(StreamEvent::Token {
        text: "Answer".into(),
    });
    assert!(!app.reasoning_open(), "prose has started");
    assert_eq!(
        app.reasoning_status().map(|(w, _)| w),
        Some("thought for 0s".to_string()),
        "the closed block reports its duration"
    );
}

/// Reasoning that mentions a `</think>` tag must not close the block it is
/// wrapped in and spill the rest of the thought into the answer.
#[test]
fn native_reasoning_mentioning_a_close_tag_stays_reasoning() {
    let mut app = test_app();
    app.submit_user("go".into());
    app.apply(StreamEvent::Reasoning {
        text: "the </think> tag is tricky".into(),
    });
    app.on_done("stop".into(), None);
    let rows = render_rows(&mut app, 80, 30).join("\n");
    assert!(
        !rows.contains("tag is tricky"),
        "reasoning rendered as answer prose: {rows}"
    );
    assert_eq!(app.reasoning_blocks.len(), 1, "one folded reasoning block");
    // Kept verbatim: reasoning never shares a string with the prose, so
    // there is no block for the tag to close and nothing to neutralize.
    assert!(
        detail_text(&app.reasoning_blocks[0]).contains("</think>"),
        "the tag is preserved as written: {}",
        detail_text(&app.reasoning_blocks[0])
    );
}

/// Interleaved reasoning keeps emission order: each stretch folds where it
/// streamed instead of every thought being hoisted above all the prose.
#[test]
fn interleaved_native_reasoning_keeps_emission_order() {
    let mut app = test_app();
    app.submit_user("go".into());
    app.apply(StreamEvent::Reasoning {
        text: "first thought".into(),
    });
    app.apply(StreamEvent::Token {
        text: "Part one.".into(),
    });
    app.apply(StreamEvent::Reasoning {
        text: "second thought".into(),
    });
    app.apply(StreamEvent::Token {
        text: " Part two.".into(),
    });
    app.on_done("stop".into(), None);
    assert_eq!(app.reasoning_blocks.len(), 2, "two separate stretches");
    // Journaled apart: prose verbatim, each stretch at the offset it
    // streamed at, so a replay rebuilds the order without parsing markers.
    let DisplayEntry::Assistant {
        text,
        reasoning,
        reasoning_ms: _,
    } = app
        .display_log
        .iter()
        .rev()
        .find(|e| matches!(e, DisplayEntry::Assistant { .. }))
        .expect("assistant entry journaled")
    else {
        unreachable!()
    };
    assert_eq!(text, "Part one. Part two.");
    assert_eq!(
        reasoning,
        &vec![
            ReasoningSeg {
                at: 0,
                text: "first thought".into()
            },
            ReasoningSeg {
                at: 9,
                text: "second thought".into()
            },
        ]
    );
    // The wire answer is prose only; both thoughts ride along on
    // `reasoning_content`, concatenated in emission order.
    let last = app.history.last().expect("assistant turn in history");
    assert_eq!(last["content"], "Part one. Part two.");
    assert_eq!(
        last["reasoning_content"], "first thoughtsecond thought",
        "both stretches must be preserved for resend: {last}"
    );
}

/// The turn receipt reports what the whole turn cost, which for a
/// tool-using turn is more than the final request's usage.
#[test]
fn terminal_usage_updates_context_when_no_intermediate_event_arrives() {
    let mut app = test_app();
    app.submit_user("go".into());
    app.on_done(
        "stop".into(),
        Some(Usage {
            prompt_tokens: Some(120),
            completion_tokens: Some(8),
            total_tokens: Some(128),
            cached_prompt_tokens: None,
            cache_write_tokens: None,
        }),
    );
    assert_eq!(app.turn_prompt_tokens, 120);
    assert_eq!(app.tokens, 128);
    assert!(!app.tokens_estimated);
}

#[test]
fn missing_usage_falls_back_to_a_context_estimate() {
    let mut app = test_app();
    app.submit_user("go".into());
    app.on_done("stop".into(), None);
    assert!(app.tokens > 0);
    assert!(app.tokens_estimated);
}

#[test]
fn turn_stats_sum_output_across_requests() {
    let mut app = test_app();
    app.submit_user("go".into());
    for _ in 0..3 {
        app.apply(StreamEvent::TurnUsage {
            usage: Usage {
                prompt_tokens: Some(40_000),
                completion_tokens: Some(500),
                total_tokens: Some(40_500),
                ..Default::default()
            },
            execution_id: None,
        });
    }
    assert_eq!(app.turn_output_tokens, 1_500);
    assert_eq!(app.turn_prompt_tokens, 40_000);

    app.on_done("stop".into(), None);
    let out: String = app
        .transcript
        .iter()
        .map(row_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(out.contains("40K"), "input tokens missing: {out}");
    assert!(out.contains("1.5K"), "summed output missing: {out}");
    assert!(out.contains("/s"), "rate missing: {out}");

    // A new turn starts the count over rather than accumulating forever.
    app.submit_user("again".into());
    assert_eq!(app.turn_output_tokens, 0);
}

/// Turn-granular aging: a single run's model roundtrips (`Step` events)
/// each count toward the grace period, so a finished plan does not outlive
/// the long tool-call run that produced it.
#[tokio::test]
async fn closed_todos_age_per_turn_not_per_run() {
    let mut app = test_app();
    app.todos
        .init(vec![crate::core::agent::todo::TodoPhase {
            name: String::new(),
            tasks: vec![todo_item("a")],
        }])
        .unwrap();
    app.todos
        .done(crate::core::agent::todo::Target::All)
        .unwrap();

    // Three roundtrips inside the run that finished the list: the counter
    // climbs per turn, and once it passes the cutoff the list drops even
    // though no new run kicked off.
    for _ in 1..=super::super::TODO_KEEP_CLOSED_TURNS {
        app.apply(StreamEvent::Step { index: 1, max: 8 });
        age_closed_todos(&mut app).await;
    }
    assert!(!app.todos.is_empty(), "must survive the full grace period");

    app.apply(StreamEvent::Step { index: 1, max: 8 });
    age_closed_todos(&mut app).await;
    assert!(
        app.todos.is_empty(),
        "dropped mid-run after the grace period"
    );
}

/// A compaction invalidates the provider's last measurement: the count is
/// an estimate until a fresh response reports one.
#[tokio::test]
async fn context_fill_is_estimated_after_a_compaction() {
    let mut app = test_app();
    app.turn_prompt_tokens = 120_000;
    assert!(
        app.context_report().await.fill_reported,
        "a fresh provider count is authoritative"
    );
    app.tokens_estimated = true;
    assert!(
        !app.context_report().await.fill_reported,
        "a post-compaction count must not claim to be measured"
    );
    app.apply(StreamEvent::TurnUsage {
        usage: Usage {
            prompt_tokens: Some(90_000),
            completion_tokens: Some(10),
            total_tokens: Some(90_010),
            ..Default::default()
        },
        execution_id: None,
    });
    assert!(
        app.context_report().await.fill_reported,
        "a fresh response restores the measured count"
    );
}

/// Rewinding drops turns the provider's count measured, so that count now
/// overstates the window. It must revert to an estimate.
#[tokio::test]
async fn context_fill_is_estimated_after_a_rewind() {
    let mut app = test_app();
    for i in 0..4 {
        app.history.push(serde_json::json!({
            "role": if i % 2 == 0 { "user" } else { "assistant" },
            "content": "x".repeat(4_000),
        }));
    }
    app.apply(StreamEvent::TurnUsage {
        usage: Usage {
            prompt_tokens: Some(120_000),
            completion_tokens: Some(10),
            total_tokens: Some(120_010),
            ..Default::default()
        },
        execution_id: None,
    });
    assert!(app.context_report().await.fill_reported);
    rewind_to(&mut app, 0, false);
    assert!(
        !app.context_report().await.fill_reported,
        "a count measured over rewound-away turns must not read as measured"
    );
}

/// A file-sized `write` streams its arguments in thousands of deltas. One
/// repaint each is thousands of full frames for a preview that only ever
/// shows its last few lines, so a burst already sitting in the channel is
/// drained into a single frame.
#[tokio::test]
async fn a_burst_of_stream_events_is_drained_into_one_frame() {
    let mut app = test_app();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let mut current = Some(CurrentRun {
        rx,
        steering: mpsc::unbounded_channel().1,
        handle: tokio::spawn(async {}),
    });

    tx.send(StreamEvent::ToolCallStarted {
        id: "c1".into(),
        name: "write".into(),
    })
    .expect("send");
    for _ in 0..64 {
        tx.send(StreamEvent::ToolCallArgsDelta {
            id: "c1".into(),
            delta: "ab".into(),
        })
        .expect("send");
    }

    let drained = drain_stream_events(&mut app, &mut current).await;
    assert_eq!(drained, 65, "the whole burst must land in one pass");
    assert_eq!(app.starting[0].args.len(), 128);
    assert!(current.is_some(), "an unfinished run must stay live");

    // Nothing left: draining an empty channel is a no-op, not a stall.
    assert_eq!(drain_stream_events(&mut app, &mut current).await, 0);
}

/// The drain must not starve input handling: a run that emits faster than
/// the loop can drain still has to yield back to the keyboard poll.
#[tokio::test]
async fn the_drain_is_bounded() {
    let mut app = test_app();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let mut current = Some(CurrentRun {
        rx,
        steering: mpsc::unbounded_channel().1,
        handle: tokio::spawn(async {}),
    });
    for _ in 0..(super::super::EVENT_DRAIN_MAX + 50) {
        tx.send(StreamEvent::Token { text: "x".into() })
            .expect("send");
    }
    assert_eq!(
        drain_stream_events(&mut app, &mut current).await,
        super::super::EVENT_DRAIN_MAX
    );
}

/// A terminal event inside a burst ends the run there and stops the drain,
/// so nothing queued behind it is applied to a finished run.
#[tokio::test]
async fn the_drain_stops_at_a_terminal_event() {
    let mut app = test_app();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let mut current = Some(CurrentRun {
        rx,
        steering: mpsc::unbounded_channel().1,
        handle: tokio::spawn(async {}),
    });
    tx.send(StreamEvent::Token { text: "hi".into() })
        .expect("send");
    tx.send(StreamEvent::Done {
        stop_reason: "stop".into(),
        usage: None,
    })
    .expect("send");
    tx.send(StreamEvent::Token {
        text: "late".into(),
    })
    .expect("send");

    let drained = drain_stream_events(&mut app, &mut current).await;
    assert_eq!(drained, 2, "drain must stop on the terminal event");
    assert!(current.is_none(), "the run was not cleared");
}

#[test]
fn stream_error_clears_the_preparing_throbber() {
    let mut app = test_app();
    app.submit_user("do a thing".into());
    app.apply(StreamEvent::ToolCallStarted {
        id: "c1".into(),
        name: "write".into(),
    });
    assert!(!app.starting.is_empty());
    app.on_error("stream".into(), "connection reset".into());
    assert!(
        app.starting.is_empty(),
        "an aborted run leaves a throbber naming a tool that never ran"
    );
}

/// A run can end normally while a tool call was still streaming its
/// arguments: the upstream stops mid-call and the assembled completion
/// carries no `tool_calls`, so no `ToolCall` ever supersedes the throbber
/// and no `ToolResult` ever resolves the pending row. `on_done` owns cleaning
/// up both orphans. The throbber (`c2`) is started *after* `c1`'s `ToolCall`
/// precisely so no later `ToolCall` clears it first -- that is the truncation
/// shape, where the streaming call is the last thing the run ever emits.
#[test]
fn normal_done_clears_an_unfinished_tool_call() {
    let mut app = test_app();
    app.submit_user("do a thing".into());
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "write".into(),
        args: serde_json::json!({ "path": "a.txt", "content": "x" }),
    });
    app.apply(StreamEvent::ToolCallStarted {
        id: "c2".into(),
        name: "write".into(),
    });
    assert_eq!(app.starting.len(), 1);
    assert_eq!(app.pending_rows.len(), 1);

    app.on_done("stop".into(), None);

    assert!(
        app.starting.is_empty(),
        "a finished run leaves a throbber naming a tool that never ran"
    );
    assert!(
        app.pending_rows.is_empty(),
        "a finished run leaves a call row spinning for a result that never comes"
    );
}

/// An `await_subagent` whose result never lands is the same orphan: the
/// child cannot outlive the run whose stream carried its events.
#[test]
fn terminal_events_clear_an_unresolved_await() {
    for terminal in [0, 1] {
        let mut app = test_app();
        app.submit_user("do a thing".into());
        app.awaiting
            .push(("c1".into(), "run-1".into(), "explorer".into()));
        if terminal == 0 {
            app.on_done("stop".into(), None);
        } else {
            app.on_error("stream".into(), "connection reset".into());
        }
        assert!(
            app.awaiting.is_empty(),
            "an awaiting throbber outlived the run that could resolve it"
        );
    }
}

/// The deltas have to actually reach the call they belong to.
#[test]
fn args_deltas_accumulate_onto_the_starting_call() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCallStarted {
        id: "c1".into(),
        name: "write".into(),
    });
    for delta in [r#"{"path":"a"#, r#".html","content":"he"#, "llo"] {
        app.apply(StreamEvent::ToolCallArgsDelta {
            id: "c1".into(),
            delta: delta.into(),
        });
    }
    let call = &mut app.starting[0];
    call.refresh_preview();
    assert_eq!(call.preview.path.as_deref(), Some("a.html"));
    assert_eq!(tail_text(call), Some(vec!["hello".to_string()]));

    // A delta for an unknown call is dropped, not panicked on.
    app.apply(StreamEvent::ToolCallArgsDelta {
        id: "nope".into(),
        delta: "x".into(),
    });
    assert_eq!(app.starting.len(), 1);
}

#[test]
fn on_done_counts_turn_and_queues_eval_under_active_goal() {
    let mut app = test_app();
    app.goal = Some(crate::core::agent::goal::GoalState::new("cond"));
    app.status = Status::Running;
    app.apply(StreamEvent::Token {
        text: "did some work".into(),
    });
    app.on_done("stop".into(), None);
    assert_eq!(app.goal.as_ref().unwrap().turns, 1);
    assert!(app.goal_eval_pending, "evaluation should be queued");
}

#[test]
fn on_done_without_goal_does_not_queue_eval() {
    let mut app = test_app();
    app.status = Status::Running;
    app.apply(StreamEvent::Token {
        text: "done".into(),
    });
    app.on_done("stop".into(), None);
    assert!(!app.goal_eval_pending);
}

#[test]
fn on_done_early_finish_does_not_queue_goal_eval() {
    // An early/truncated finish under a goal counts the turn but leaves
    // control with the user rather than auto-continuing.
    let mut app = test_app();
    app.goal = Some(crate::core::agent::goal::GoalState::new("cond"));
    app.status = Status::Running;
    app.apply(StreamEvent::Token {
        text: "partial".into(),
    });
    app.on_done("length".into(), None);
    assert_eq!(app.goal.as_ref().unwrap().turns, 1);
    assert!(
        !app.goal_eval_pending,
        "early finish should not auto-continue"
    );
}

#[test]
fn todo_reminder_suppressed_when_no_answer() {
    let mut app = test_app();
    seed_open_todos(&mut app);
    // A stop with no answer text is an abnormal finish, not a clean yield.
    app.status = Status::Running;
    app.on_done("stop".into(), None);
    assert!(!app.want_start);
}

#[tokio::test]
async fn todo_reminder_suppressed_while_ask_pending() {
    let mut app = test_app();
    seed_open_todos(&mut app);
    let registry = crate::core::agent::interaction::new_registry();
    let (request_id, _rx) = crate::core::agent::interaction::register(&registry).await;
    app.apply(StreamEvent::AskRequest {
        request_id,
        request: ask_request(false, false),
        timeout_secs: None,
    });
    finish_clean_turn(&mut app);
    assert!(
        !app.want_start,
        "a pending ask blocks the reminder boundary"
    );
}

#[test]
fn todo_reminder_waits_for_progress_before_firing_again() {
    let mut app = test_app();
    seed_open_todos(&mut app);
    finish_clean_turn(&mut app);
    assert!(app.want_start);
    app.want_start = false;
    // Change the summary so dedup alone wouldn't suppress a second fire,
    // but no tool result has landed since the reminder: still silent.
    app.todos.phases[0].tasks[0].content = "t1-changed".into();
    finish_clean_turn(&mut app);
    assert!(
        !app.want_start,
        "an unanswered reminder must not be followed by another before any progress"
    );
    // A tool result lands (any tool, not just todo) -- progress happened.
    app.apply(StreamEvent::ToolResult {
        id: "x".into(),
        content: "ok".into(),
        is_error: false,
        diff: None,
    });
    app.todos.phases[0].tasks[0].content = "t1-changed-again".into();
    finish_clean_turn(&mut app);
    assert!(
        app.want_start,
        "a reminder may fire again once progress happened"
    );
}

/// The animation is scoped to the state that needs it: a folded, streaming
/// reasoning block. Everything else keeps its flat badge.
#[test]
fn only_invisible_live_reasoning_animates_the_badge() {
    let mut app = test_app();
    // Streaming reasoning puts the thought on screen, so the badge has
    // nothing to stand in for; the shimmer is for the hidden case.
    app.stream_reasoning = false;
    assert!(!app.is_thinking(), "idle");
    app.submit_user("hi".into());
    assert!(!app.is_thinking(), "running, but nothing thinking yet");

    app.apply(StreamEvent::Token {
        text: "<think>pondering".into(),
    });
    assert!(app.is_thinking(), "open reasoning block");
    let rows = render_rows(&mut app, 110, 12);
    assert!(
        rows[0].contains("[thinking]"),
        "label intact: {:?}",
        rows[0]
    );

    app.apply(StreamEvent::Token {
        text: "</think>done".into(),
    });
    assert!(!app.is_thinking(), "the block closed");

    // With reasoning on screen -- streamed into the live tail, or unfolded
    // outright -- the transcript itself is moving, so the badge stays flat.
    app.stream_reasoning = true;
    app.apply(StreamEvent::Token {
        text: "<think>more".into(),
    });
    assert!(
        !app.is_thinking(),
        "streamed reasoning needs no badge motion"
    );
    app.stream_reasoning = false;
    app.show_reasoning = true;
    assert!(
        !app.is_thinking(),
        "unfolded reasoning needs no badge motion"
    );
}

/// Folded reasoning summaries and tool rows are one run of activity: a turn
/// that alternates them used to spend a blank line on every switch.
#[test]
fn reasoning_and_tool_rows_share_one_band() {
    let mut app = test_app();
    app.apply(StreamEvent::Token {
        text: "<think>weighing options</think>".into(),
    });
    app.flush_assistant();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "grep".into(),
        args: json!({ "pattern": "x" }),
    });
    assert!(
        !app.transcript.iter().any(Row::is_blank),
        "no separator between a reasoning summary and a tool row"
    );

    // Prose is a different band and still gets its air.
    app.apply(StreamEvent::Token {
        text: "an answer".into(),
    });
    app.flush_assistant();
    assert!(
        app.transcript.iter().any(Row::is_blank),
        "prose is still separated from the activity above it"
    );
}

/// The live tail mirrors the band rule the commit will: reasoning streaming
/// after a tool call shares the tool band, so no blank separates them, while
/// streaming prose still opens with one.
#[test]
fn streaming_reasoning_after_a_tool_call_has_no_leading_blank() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "grep".into(),
        args: json!({ "pattern": "x" }),
    });
    app.assistant_buf = "<think>weighing options".to_string();
    let rows = render_rows(&mut app, 60, 30);
    let reason = rows
        .iter()
        .position(|r| r.contains("weighing options"))
        .expect("streamed reasoning");
    assert!(
        !rows[reason - 1].trim().is_empty(),
        "no blank between the tool row and streaming reasoning: {rows:?}"
    );

    // Streaming prose in the same spot is a band change and keeps its air.
    app.assistant_buf = "here is the answer".to_string();
    let rows = render_rows(&mut app, 60, 30);
    let prose = rows
        .iter()
        .position(|r| r.contains("here is the answer"))
        .expect("streamed prose");
    assert!(
        rows[prose - 1].trim().is_empty(),
        "prose after a tool call still opens with a blank: {rows:?}"
    );
}

/// The in-progress "Preparing X" throbber is a tool-band row, so it shares
/// the band with the reasoning or tool row above it (no blank) but is still
/// separated from answer prose.
#[test]
fn preparing_row_shares_the_band_with_reasoning_and_tools() {
    // After reasoning: same band, no blank.
    let mut app = test_app();
    app.apply(StreamEvent::Token {
        text: "<think>deciding</think>".into(),
    });
    app.apply(StreamEvent::ToolCallStarted {
        id: "c1".into(),
        name: "read".into(),
    });
    let rows = render_rows(&mut app, 60, 30);
    let prep = rows
        .iter()
        .position(|r| r.contains("Preparing"))
        .expect("preparing row");
    assert!(
        !rows[prep - 1].trim().is_empty(),
        "no blank between reasoning and Preparing: {rows:?}"
    );

    // After a committed tool call: same band, no blank.
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "t1".into(),
        name: "grep".into(),
        args: json!({ "pattern": "x" }),
    });
    app.apply(StreamEvent::ToolCallStarted {
        id: "t2".into(),
        name: "read".into(),
    });
    let rows = render_rows(&mut app, 60, 30);
    let prep = rows
        .iter()
        .position(|r| r.contains("Preparing"))
        .expect("preparing row");
    assert!(
        !rows[prep - 1].trim().is_empty(),
        "no blank between a tool row and Preparing: {rows:?}"
    );

    // After answer prose: a band change still keeps its air.
    let mut app = test_app();
    app.apply(StreamEvent::Token {
        text: "here is the answer".into(),
    });
    app.apply(StreamEvent::ToolCallStarted {
        id: "p1".into(),
        name: "read".into(),
    });
    let rows = render_rows(&mut app, 60, 30);
    let prep = rows
        .iter()
        .position(|r| r.contains("Preparing"))
        .expect("preparing row");
    assert!(
        rows[prep - 1].trim().is_empty(),
        "prose is still separated from Preparing: {rows:?}"
    );
}

/// A `bash` command that detaches is counted in the status bar until a later
/// call collects it.
#[test]
fn background_shell_count_tracks_detach_and_collect() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "sleep 100" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "Command exceeded 30s and is continuing in the background (job_id=bash-0)."
            .into(),
        is_error: false,
        diff: None,
    });
    assert_eq!(app.active_bg_jobs.len(), 1, "the detached job is counted");
    let footer: String = super::super::footer_spans(&app)
        .iter()
        .map(|s| s.content.as_ref())
        .collect();
    assert!(footer.contains("1 bg shell"), "status bar names it: {footer}");

    // A later call collects the job; the count drops.
    app.apply(StreamEvent::ToolCall {
        id: "c2".into(),
        name: "bash".into(),
        args: json!({ "job_id": "bash-0" }),
    });
    assert!(app.active_bg_jobs.is_empty(), "collected job is uncounted");
    // Jozkah/jan#134: collecting the job consumes its pairing entries.
    assert!(app.bash_jobs.is_empty(), "collected job's command is kept");
    assert!(app.job_origin.is_empty(), "collected job's origin is kept");
    let footer: String = super::super::footer_spans(&app)
        .iter()
        .map(|s| s.content.as_ref())
        .collect();
    assert!(!footer.contains("bg shell"), "indicator is gone: {footer}");
}

/// A child's panel normally closes on its own `SubagentEnd`. A run that
/// ends without one -- an upstream error mid-fan-out, a `Done` that beats
/// the child's own event -- used to strand the block: it kept spinning in
/// the dock, on an idle session, until the next `/clear`.
#[test]
fn run_end_closes_panels_no_subagent_end_ever_closed() {
    for finish in ["done", "error"] {
        let mut app = test_app();
        app.submit_user("go".into());
        start_subagent(&mut app, "r0", "alpha");
        subagent_event(
            &mut app,
            "r0",
            "alpha",
            StreamEvent::ToolCall {
                id: "c1".into(),
                name: "read".into(),
                args: json!({ "path": "a.rs" }),
            },
        );
        assert_eq!(app.subagents.len(), 1, "{finish}: panel open");

        match finish {
            "done" => app.on_done("stop".into(), None),
            _ => app.on_error("upstream".into(), "boom".into()),
        }

        assert!(app.subagents.is_empty(), "{finish}: live panel must close");
        let rows = render_rows(&mut app, 100, 24);
        assert!(
            !rows.iter().any(|r| r.contains("1 agent")),
            "{finish}: panel must be gone: {rows:?}"
        );
        // Not silently: the child did work, so it gets the same kind of
        // summary row a clean end would leave, marked unfinished.
        assert!(
            rows.iter()
                .any(|r| r.contains("subagent alpha interrupted")),
            "{finish}: unfinished child must be accounted for: {rows:?}"
        );
    }
}

/// The dock is one unit and the conversation is another:
/// `TRANSCRIPT_BOTTOM_PAD` keeps the model's closing line off the rule that
/// separates the transcript from the input.
#[test]
fn the_transcript_keeps_its_air_above_the_dock() {
    let mut app = test_app();
    app.apply(StreamEvent::Token {
        text: "an answer".into(),
    });
    app.flush_assistant();
    let rows = render_rows(&mut app, 60, 20);

    let rule = rows
        .iter()
        .rposition(|r| r.trim_end().chars().filter(|c| *c == '─').count() > 20)
        .expect("the separator rule is on screen");
    let last_prose = rows[..rule]
        .iter()
        .rposition(|r| r.trim() == "an answer")
        .expect("the answer is on screen");
    // Literal, not derived from the constant: the point is the geometry on
    // screen, and reading the expectation back off `TRANSCRIPT_BOTTOM_PAD`
    // would make the test pass at any value including zero.
    assert_eq!(
        rule - last_prose,
        2,
        "exactly one blank row between the transcript and the dock: {rows:#?}"
    );
    assert!(
        rows[rule - 1].trim().is_empty(),
        "the row above the rule is the air, not content: {rows:#?}"
    );
}

/// Reasoning and answer are different bands, and the committed path gaps
/// between them. The live tail packed them together, so a native-reasoning
/// model's answer streamed flush against the reasoning above it and then
/// dropped a row when the commit put the real separator in.
#[test]
fn the_live_tail_gaps_between_reasoning_and_the_answer() {
    let mut app = test_app();
    app.apply(StreamEvent::Reasoning {
        text: "musing".into(),
    });
    app.apply(StreamEvent::Token {
        text: "Here is the ".into(),
    });

    // The `┊` gutter marks the reasoning band in both forms: folded to a
    // summary row while it streams, and as dimmed detail once committed.
    let gap = |rows: &[String]| -> usize {
        let reasoning = rows
            .iter()
            .rposition(|r| r.contains('┊'))
            .unwrap_or_else(|| panic!("the reasoning band is on screen: {rows:#?}"));
        let prose = rows
            .iter()
            .position(|r| r.contains("Here is the"))
            .unwrap_or_else(|| panic!("the answer is on screen: {rows:#?}"));
        prose - reasoning
    };
    let live = render_rows(&mut app, 60, 16);
    assert_eq!(
        gap(&live),
        2,
        "one blank row between the reasoning and the answer: {live:#?}"
    );

    // Committing it moves nothing: the live gap is the one the commit puts in.
    app.flush_assistant();
    let flushed = render_rows(&mut app, 60, 16);
    assert_eq!(
        gap(&flushed),
        2,
        "the commit must not change the gap: {flushed:#?}"
    );
}

#[tokio::test]
async fn execute_in_fresh_context_queues_the_plan_alone_and_clears_history_on_start() {
    use crate::core::agent::plan::{RunMode, EXECUTE_FRESH_LABEL};
    let mut app = test_app();
    app.run_mode = RunMode::Plan;
    app.apply(StreamEvent::TodoUpdate { list: staged_todos() });
    app.history.push(serde_json::json!({ "role": "user", "content": "long old talk" }));
    app.status = Status::Running;
    super::super::apply_plan_review(&mut app, EXECUTE_FRESH_LABEL, "ship it");
    assert_eq!(app.run_mode, RunMode::Normal);
    let queued = app.message_queue.front().expect("a queued turn");
    assert!(queued.fresh_context);
    let text = queued.message["content"].as_str().unwrap();
    assert!(text.contains("ship it") && text.contains("do the thing"), "{text}");
    // Nothing is cleared while the ask turn still runs.
    assert_eq!(app.history.len(), 1);
    app.status = Status::Idle;
    app.dequeue_next();
    assert_eq!(app.history.len(), 1, "old talk gone, only the plan message remains");
    assert!(app.history[0]["content"].as_str().unwrap().contains("do the thing"));
}

#[test]
fn on_done_does_not_queue_goal_eval_while_planning() {
    use crate::core::agent::plan::RunMode;
    let mut app = test_app();
    app.goal = Some(crate::core::agent::goal::GoalState::new("cond"));
    app.run_mode = RunMode::Plan;
    app.status = Status::Running;
    app.apply(StreamEvent::Token {
        text: "planning".into(),
    });
    app.on_done("stop".into(), None);
    assert!(
        !app.goal_eval_pending,
        "plan mode pauses the goal loop; no auto-continue"
    );
}

#[test]
fn every_transcript_class_owns_a_distinct_gutter() {
    let mut app = test_app();

    app.note("conversation cleared");
    assert_eq!(last_row(&app)[0].0, "\u{2022} ", "system note");

    // The user turn distinguishes itself with a filled bubble background
    // rather than a gutter glyph.
    app.push_user_line("do it", &[]);
    assert_eq!(
        last_row(&app)[0].1.bg,
        Some(super::super::user_bubble_bg()),
        "user message"
    );

    app.apply(StreamEvent::ToolCall {
        id: "t1".into(),
        name: "bash".into(),
        args: json!({"command": "ls"}),
    });
    app.apply(StreamEvent::ToolResult {
        id: "t1".into(),
        content: "ok".into(),
        is_error: false,
        diff: None,
    });
    app.finalize_tool_group();
    assert_eq!(last_row(&app)[0].0, "\u{2502} ", "tool row");

    // Model prose is the one class with no gutter, which is what makes the
    // others readable as "not the model".
    app.assistant_buf = "Done.".into();
    app.flush_assistant();
    let prose = last_row(&app);
    assert!(
        !prose[0].0.starts_with('\u{2022}') && !prose[0].0.starts_with('>'),
        "prose took a gutter: {prose:?}"
    );
}
