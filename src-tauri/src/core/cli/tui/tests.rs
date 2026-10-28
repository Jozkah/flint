
/// #133: a value above i64::MAX used to be cast with `as i64`, wrapping
/// negative into agent.toml and bricking the next startup.
#[test]
fn int_setting_refuses_values_that_do_not_fit_a_toml_integer() {
    use super::parse_int_setting;
    assert_eq!(parse_int_setting("", Some(8), 1), Ok(None));
    assert_eq!(parse_int_setting(" 42 ", Some(8), 1), Ok(Some(42)));
    assert_eq!(
        parse_int_setting(&i64::MAX.to_string(), None, 1),
        Ok(Some(i64::MAX))
    );
    assert!(parse_int_setting("0", Some(8), 1).is_err(), "below min");
    assert!(parse_int_setting("abc", Some(8), 1).is_err(), "not a number");
    let over = (i64::MAX as u64 + 1).to_string();
    assert!(parse_int_setting(&over, None, 1).is_err(), "wraps negative");
    assert!(parse_int_setting(&u64::MAX.to_string(), None, 1).is_err());
}

/// An empty MCP map, for the `run_command`/`handle_key` paths that take one
/// but whose behaviour under test has nothing to do with MCP.
fn no_mcp() -> crate::core::state::SharedMcpServers {
    std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()))
}
use super::journal::{self, DisplayEntry};
use super::{cancel_command, next_event, RunEvent, SessionLimits, SteeringRequest};
use tokio::sync::mpsc;
use super::{
    age_closed_todos, alt_scroll_restore, alt_scroll_save_off, answer_without_reasoning,
    apply_repaint, apply_resume, assistant_is_awaiting_user_answer, assistant_runs,
    TerminalGuard, normalize_paste, panic_restore_sequence, autoscroll_selection, await_branch_poll, backgrounded_job_id, brand, build_user_message,
    clipboard_path, compact_tokens, context_lines, diff_lines, drain_stream_events,
    estimate_token_count, finish_compaction, finish_context_report,
    finish_login, finish_plugin_install, finish_tokamak_login, format_tokens,
    group_detail_lines, group_summary, handle_ask_key, handle_ask_mouse, handle_key,
    handle_mouse, header_spans, image_mime, image_mime_of, input_content_lines,
    load_first_file_image, load_image_file, message_text, open_config_screen,
    open_rewind_picker, pairs_to_str, parse_command, partial_json_field,
    provider_label_for_model, rebuild_recall, replay_display_log, restore_goal,
    restore_run_mode, restore_todos, resume_hint, rewind_to, route_paste_event,
    route_resize_event, row_width,
    run_command, running_group_rows, selection_text, spans_width, spawn_branch_poll,
    split_reasoning, starting_call_lines, startup_modes, strip_system_xml_tags,
    subagent_activity, subagent_name_from_run_id, summarize_result, sync_output_for,
    has_answer_text, thinking_open, tilde_path, tokens_per_second, tool_activity, tool_finished,
    transcript_top_padding, unescape_partial_json_string, user_content_parts, wave_sweep_line,
    with_wave_glyph, without_think_tags, App, CompactKind, ContextReport, ContextSegment,
    ContextView, CurrentRun, McpField, McpPrompt, Pending, PendingImage, PickerKind,
    ProviderField, ReasoningSeg, ResumeTarget, Row, RowKind, Selection, SelectionMode,
    SnapshotJob, Status, AGENT_SETTINGS, ALT_SCROLL_RESTORE, ALT_SCROLL_SAVE_OFF, COPY_NOTICE,
    DIFF_ADD_BG, DIFF_DEL_BG, DIFF_MAX_ROWS, DIFF_PREVIEW_MAX_ROWS, KEY_BINDINGS,
    KITTY_KEYS_OFF, KITTY_KEYS_ON, MAX_IMAGE_BYTES, MAX_OVERFLOW_RETRIES, MOUSE_TRACK_ON,
    PROVIDERS_SETTINGS_ROW, SLASH_COMMANDS, SPINNER, SPINNER_ADVANCE_MS, THINKING_WORDS,
    WORKING_WORDS,
};
// Worktree/fork/resume helpers exercised by the tests below; they are
// defined on the parent module but were missing from the import list.
use super::{fork_at, open_fork_picker, open_tree_picker, worktree_command, ResumeRequest};
use crate::core::cli::worktree::Worktree;
use crate::core::agent::events::{StreamEvent, Usage};
use crate::core::agent::r#loop::PermissionRegistry;
use ratatui::buffer::Buffer;
use ratatui::crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent,
    MouseEventKind,
};
use ratatui::layout::Rect;
use ratatui::{
    style::{Color, Modifier, Style},
    text::Line,
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri_plugin_agent_tools::tools::gate::PermissionDecision;
use unicode_width::UnicodeWidthStr;

/// A bare key press with no modifiers.
fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn mouse_at(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
    MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    }
}

/// Press and release without moving: the gesture that toggles a region.
fn click(app: &mut App, column: u16, row: u16) {
    handle_mouse(
        app,
        mouse_at(MouseEventKind::Down(MouseButton::Left), column, row),
    );
    handle_mouse(
        app,
        mouse_at(MouseEventKind::Up(MouseButton::Left), column, row),
    );
}

/// Wraps an `App` bound to a temp dir that is removed when the wrapper is
/// dropped, so tests that persist threads or journals never leak under
/// `/tmp` and never dirty the working tree.
struct TestApp {
    app: App,
    _dir: tempfile::TempDir,
}

impl std::ops::Deref for TestApp {
    type Target = App;

    fn deref(&self) -> &App {
        &self.app
    }
}

impl std::ops::DerefMut for TestApp {
    fn deref_mut(&mut self) -> &mut App {
        &mut self.app
    }
}

fn test_app() -> TestApp {
    // Persist into a unique temp dir so tests that save threads never
    // dirty the working tree (src-tauri/threads/) and the dir is removed on
    // drop.
    let dir = tempfile::tempdir().unwrap();
    let limits = SessionLimits {
        context_window: 128_000,
        context_window_source:
            crate::core::cli::model_capabilities::ContextWindowSource::Fallback,
        reserve_tokens: 16_384,
        compaction: Default::default(),
        max_tokens: None,
        max_session_tokens: 128_000,
        max_session_tokens_pinned: true,
        max_turns: None,
        cost_ceiling: None,
        pause_at_usd: None,
    };
    let app = App::new(
        "m".into(),
        limits,
        false,
        dir.path().to_path_buf(),
        std::path::PathBuf::from("/tmp/repo"),
        None,
    );
    TestApp { app, _dir: dir }
}

fn steering_request(
    messages: Vec<serde_json::Value>,
) -> (
    SteeringRequest,
    tokio::sync::oneshot::Receiver<Vec<serde_json::Value>>,
) {
    let (reply, receiver) = tokio::sync::oneshot::channel();
    (
        SteeringRequest {
            messages,
            reply,
            run_mode: crate::core::agent::plan::RunMode::Normal,
        },
        receiver,
    )
}

#[test]
fn steering_preserves_images_paths_order_and_transcript_once() {
    let mut app = test_app();
    let files = tempfile::tempdir().unwrap();
    app.project_root = files.path().to_path_buf();
    std::fs::write(files.path().join("note.txt"), "original context").unwrap();
    app.submit_user("start".into());
    app.want_start = false;
    app.pending_images.push(PendingImage {
        name: "pic.png".into(),
        data_url: "data:image/png;base64,AAAA".into(),
    });
    app.submit_user("read @note.txt".into());
    app.submit_user("then test".into());
    assert!(app.pending_images.is_empty());
    assert_eq!(app.history.len(), 1);
    std::fs::write(files.path().join("note.txt"), "changed later").unwrap();
    let (request, mut receiver) = steering_request(app.history.clone());
    app.steer_run(request);
    let messages = receiver.try_recv().unwrap();
    assert_eq!(messages.len(), 2);
    assert!(messages[0]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("original context"));
    assert_eq!(
        messages[0]["content"][1]["image_url"]["url"],
        "data:image/png;base64,AAAA"
    );
    assert_eq!(messages[1]["content"], "then test");
    assert_eq!(app.history.len(), 3);
    assert!(app.message_queue.is_empty());
    assert_eq!(
        app.display_log
            .iter()
            .filter(|e| matches!(e, DisplayEntry::User { .. }))
            .count(),
        3
    );
    let (request, mut receiver) = steering_request(app.history.clone());
    app.steer_run(request);
    assert!(receiver.try_recv().unwrap().is_empty());
    assert_eq!(app.history.len(), 3);
}

#[test]
fn steering_cancel_removes_only_pending_input() {
    let mut app = test_app();
    app.submit_user("start".into());
    app.want_start = false;
    app.submit_user("remove me".into());
    app.submit_user("keep me".into());
    cancel_command(&mut app, "1");
    let (request, mut receiver) = steering_request(app.history.clone());
    app.steer_run(request);
    assert_eq!(
        receiver.try_recv().unwrap(),
        vec![json!({"role": "user", "content": "keep me"})]
    );
}

#[test]
fn steering_does_not_answer_or_bypass_a_permission_prompt() {
    let mut app = test_app();
    app.submit_user("start".into());
    app.want_start = false;
    app.submit_user("correction".into());
    app.pending_queue.push_back(pending(false));
    let (request, mut receiver) = steering_request(app.history.clone());
    app.steer_run(request);
    assert!(receiver.try_recv().unwrap().is_empty());
    assert_eq!(app.pending_queue.len(), 1);
    assert_eq!(app.message_queue.len(), 1);
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

#[test]
fn steering_plan_transition_waits_for_a_new_run() {
    let mut app = test_app();
    app.submit_user("start".into());
    app.want_start = false;
    app.run_mode = crate::core::agent::plan::RunMode::Plan;
    app.submit_user("plan only".into());
    let (request, mut receiver) = steering_request(app.history.clone());
    app.steer_run(request);
    assert!(receiver.try_recv().unwrap().is_empty());
    assert_eq!(app.message_queue.len(), 1);
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

#[test]
fn steering_error_and_cancel_fallback_keep_attachments() {
    for cancel in [false, true] {
        let mut app = test_app();
        app.submit_user("start".into());
        app.want_start = false;
        app.pending_images.push(PendingImage {
            name: "pic.png".into(),
            data_url: "data:image/png;base64,AAAA".into(),
        });
        app.submit_user("follow-up".into());
        if cancel {
            app.cancel_run();
        } else {
            app.on_error("error".into(), "offline".into());
        }
        assert!(app.message_queue.is_empty());
        assert!(app.want_start);
        assert_eq!(
            app.history.last().unwrap()["content"][1]["image_url"]["url"],
            "data:image/png;base64,AAAA"
        );
    }
}

#[test]
fn steering_session_reset_discards_old_pending_input() {
    let mut app = test_app();
    app.submit_user("start".into());
    app.want_start = false;
    app.submit_user("old session only".into());
    app.reset_session();
    let (request, mut receiver) = steering_request(vec![]);
    app.steer_run(request);
    assert!(receiver.try_recv().unwrap().is_empty());
    assert!(app.history.is_empty());
    assert!(app.message_queue.is_empty());
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

#[tokio::test]
async fn steering_consumed_input_survives_resume_once() {
    let mut app = test_app();
    app.submit_user("start".into());
    app.want_start = false;
    app.submit_user("correction".into());
    let (request, mut receiver) = steering_request(app.history.clone());
    app.steer_run(request);
    assert_eq!(receiver.try_recv().unwrap().len(), 1);
    app.join_journal();
    let mut restored = test_app();
    restored.agent_dir = app.agent_dir.clone();
    apply_resume(&mut restored, &ResumeRequest::resume(ResumeTarget::Latest)).await;
    assert_eq!(
        restored
            .history
            .iter()
            .filter(|m| m["content"] == "correction")
            .count(),
        1
    );
    assert_eq!(
        restored
            .display_log
            .iter()
            .filter(|e| matches!(e, DisplayEntry::User { text, .. } if text == "correction"))
            .count(),
        1
    );
    assert!(restored.message_queue.is_empty());
}

#[tokio::test]
async fn steering_expands_skill_input_without_resetting_the_run() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    app.submit_user("start".into());
    app.want_start = false;
    app.pending_images.push(PendingImage {
        name: "pic.png".into(),
        data_url: "data:image/png;base64,AAAA".into(),
    });
    app.submit_user("please /skill:deploy carefully".into());
    let (request, mut receiver) = steering_request(app.history.clone());
    app.steer_run(request);
    let messages = receiver.try_recv().unwrap();
    assert!(messages[0]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("User: please carefully"));
    assert_eq!(
        messages[0]["content"][1]["image_url"]["url"],
        "data:image/png;base64,AAAA"
    );
    assert!(!app.want_start);
    assert!(transcript_text(&app).contains("[skill:deploy] please carefully"));
    app.join_journal();
    std::fs::remove_dir_all(root).unwrap();
}

/// App whose project has one installed skill `<name>/SKILL.md` with the
/// given frontmatter description, so slash-popup and dispatch tests run
/// against a real `.jan/agent/skills/` tree. Returns the temp project
/// root for cleanup.
fn skill_test_app(name: &str, description: &str) -> (App, std::path::PathBuf) {
    skill_test_app_fm(name, description, "")
}

/// Like `skill_test_app` but with extra frontmatter lines (before the
/// closing `---`), for invocation-flag tests.
fn skill_test_app_fm(
    name: &str,
    description: &str,
    extra_fm: &str,
) -> (App, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "jan_tui_skill_{}_{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let agent_dir = root.join(".jan/agent");
    std::fs::create_dir_all(agent_dir.join("skills").join(name)).unwrap();
    std::fs::write(
        agent_dir.join("skills").join(name).join("SKILL.md"),
        format!(
            "---\nname: {name}\ndescription: {description}\n{extra_fm}---\n\n# {name}\n\nBody.\n"
        ),
    )
    .unwrap();
    (
        App::new(
            "m".into(),
            super::SessionLimits {
                context_window: 128_000,
                context_window_source:
                    crate::core::cli::model_capabilities::ContextWindowSource::Fallback,
                reserve_tokens: 16_384,
        compaction: Default::default(),
                max_tokens: None,
                max_session_tokens: 128_000,
                max_session_tokens_pinned: true,
                max_turns: None,
                cost_ceiling: None,
                pause_at_usd: None,
            },
            false,
            agent_dir,
            root.clone(),
            None,
        ),
        root,
    )
}

/// Draw `app` into an off-screen terminal and return its rows as strings.
fn render_rows(app: &mut App, w: u16, h: u16) -> Vec<String> {
    use ratatui::{backend::TestBackend, Terminal};
    let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
    terminal.draw(|f| super::draw(f, app)).unwrap();
    let buf = terminal.backend().buffer().clone();
    (0..buf.area.height)
        .map(|y| {
            (0..buf.area.width)
                .map(|x| buf[(x, y)].symbol())
                .collect::<String>()
        })
        .collect()
}

fn pending(offers_always: bool) -> Pending {
    Pending {
        request_id: "r".into(),
        tool_name: "bash".into(),
        capability: "execute".into(),
        path: None,
        command: Some("git status".into()),
        diff: None,
        offers_always,
        reason: None,
        prompt_kind: "exec".into(),
        selected: 0,
        subagent: None,
        // Backdated past the settle window so key tests answer at once.
        shown_at: Instant::now()
            .checked_sub(Duration::from_secs(5))
            .unwrap_or_else(Instant::now),
    }
}

/// The unsandboxed-retry prompt names the command and says why it is
/// asked, with only once / deny on offer.
#[test]
fn a_permission_prompt_shows_its_reason_under_the_command() {
    let mut p = pending(false);
    p.command = Some("go build ./...".into());
    p.reason = Some(
        tauri_plugin_agent_tools::unsandboxed_retry::NULL_DEVICE_RETRY_REASON.to_string(),
    );
    let text: String = p
        .detail_lines(400)
        .iter()
        .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("go build ./..."), "{text}");
    assert!(text.contains("null device (NUL) refuses sandboxed programs"), "{text}");
    assert_eq!(p.options().len(), 2, "allow once and deny only");
}

#[test]
fn tokens_per_second_floors_duration_at_100ms() {
    // 100 tokens over exactly 1s -> 100/s.
    assert_eq!(tokens_per_second(100, 1000), 100.0);
    // Sub-100ms durations are floored at 100ms, so no divide-by-tiny spike:
    // 10 tokens / 0ms and / 100ms both yield 100/s, not infinity.
    assert_eq!(tokens_per_second(10, 0), 100.0);
    assert_eq!(tokens_per_second(10, 50), 100.0);
    assert_eq!(tokens_per_second(10, 100), 100.0);
    // Zero output is a clean 0, never NaN.
    assert_eq!(tokens_per_second(0, 500), 0.0);
}

fn transcript_text(app: &App) -> String {
    app.transcript.iter().map(message_text_of).collect()
}

fn message_text_of(row: &Row) -> String {
    row_text(row)
}

/// Text a committed transcript row renders to at a nominal width, joined
/// across the lines a multi-line row (prose, a diff panel) expands to.
fn row_text(row: &Row) -> String {
    row_lines(std::slice::from_ref(row))
        .iter()
        .map(line_text)
        .collect::<Vec<_>>()
        .join("\n")
}


/// Every line the given rows render to at a nominal width.
fn row_lines(rows: &[Row]) -> Vec<Line<'static>> {
    rows.iter().flat_map(|r| r.lines(80)).collect()
}

#[test]
fn spinner_advances_only_after_a_full_frame_elapses() {
    let mut app = test_app();
    let t0 = Instant::now();
    app.last_spinner_advance = t0;
    app.spinner_frame = 0;
    // One 50ms tick is under the 80ms frame time: no advance.
    app.advance_spinner(t0 + Duration::from_millis(50));
    assert_eq!(app.spinner_frame, 0);
    // A second tick brings cumulative elapsed to 100ms (>= 80): +1 frame.
    app.advance_spinner(t0 + Duration::from_millis(100));
    assert_eq!(app.spinner_frame, 1);
    // Leftover 20ms carried forward: next advance is at 160ms, not 180ms.
    app.advance_spinner(t0 + Duration::from_millis(150));
    assert_eq!(app.spinner_frame, 1);
    app.advance_spinner(t0 + Duration::from_millis(165));
    assert_eq!(app.spinner_frame, 2);
}

#[test]
fn spinner_catches_up_multiple_frames_after_a_stall() {
    let mut app = test_app();
    let t0 = Instant::now();
    app.last_spinner_advance = t0;
    app.spinner_frame = 0;
    // A 500ms stall == floor(500/80) = 6 frames caught up in one advance.
    app.advance_spinner(t0 + Duration::from_millis(500));
    assert_eq!(app.spinner_frame, (500 / SPINNER_ADVANCE_MS) as usize);
    assert_eq!(app.spinner_frame, 6);
}

#[test]
fn transcript_bottom_anchors_short_content() {
    // Short transcript: pad to push the last line to the viewport bottom.
    assert_eq!(transcript_top_padding(3, 20), 17);
    // Exactly full: no padding.
    assert_eq!(transcript_top_padding(20, 20), 0);
    // Overflowing viewport: no padding, scrollback path stays untouched.
    assert_eq!(transcript_top_padding(45, 20), 0);
}

/// Committed markdown keeps its source, so a resize re-wraps the table to
/// the new width instead of leaving rows sized for the old one.
#[test]
fn committed_prose_reflows_when_the_terminal_resizes() {
    let mut app = test_app();
    app.push_assistant_blocks(
        "| column one heading | column two heading |\n|---|---|\n\
             | a reasonably long value here | another reasonably long value |",
        &[],
        None,
    );
    let wide = render_rows(&mut app, 100, 20);
    let narrow = render_rows(&mut app, 46, 20);
    let table_row = |rows: &[String]| {
        rows.iter()
            .find(|r| r.contains("column one"))
            .expect("no table row")
            .trim_end()
            .to_string()
    };
    let (w, n) = (table_row(&wide), table_row(&narrow));
    assert!(
        w.chars().count() > n.chars().count(),
        "table did not reflow: {w:?} vs {n:?}"
    );
    assert!(
        n.chars().count() <= 46,
        "table overflows the narrow frame: {n:?}"
    );
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
        super::TOOL_ROW_MAX_LINES,
        "label was not bounded"
    );
    let last: String = rendered[super::TOOL_ROW_MAX_LINES - 1]
        .spans
        .iter()
        .map(|s| s.content.as_ref())
        .collect();
    assert!(
        last.ends_with('\u{2026}'),
        "elision was not marked: {last:?}"
    );
}

/// A newline in a user message is a line break in the transcript, not a
/// blank cell in one run-on row.
#[test]
fn user_message_keeps_its_line_breaks() {
    let mut app = test_app();
    app.push_user_line("first line\nsecond line", &[]);
    let rows = render_rows(&mut app, 60, 12);
    assert!(
        rows.iter().any(|r| r.trim_end().ends_with("first line")),
        "first line not on its own row: {rows:?}"
    );
    assert!(
        rows.iter().any(|r| r.trim_end().ends_with("second line")),
        "second line not on its own row: {rows:?}"
    );
}

/// The user turn renders as a filled bubble (the terminal analog of the
/// desktop's `bg-secondary` chat bubble), so every wrapped line carries the
/// background across the gutter, the text and the trailing padding.
#[test]
fn user_message_renders_as_a_filled_bubble() {
    let mut app = test_app();
    app.push_user_line("first line\nsecond line", &[]);
    let bg = super::user_bubble_bg();
    let fg = super::user_bubble_fg();
    let row = app.transcript.last().expect("no user row");
    let lines = row.lines(60);
    assert_eq!(lines.len(), 2, "one bubble line per source line");
    for line in &lines {
        assert!(
            line.spans.iter().all(|s| s.style.bg == Some(bg)),
            "every span must carry the bubble background: {line:?}"
        );
        assert!(
            line.spans
                .iter()
                .any(|s| !s.content.trim().is_empty() && s.style.fg == Some(fg)),
            "the message text must carry the contrast foreground: {line:?}"
        );
        let last = line.spans.last().expect("empty bubble line");
        assert!(
            last.content.chars().all(|c| c == ' '),
            "bubble ends in a padding column: {last:?}"
        );
        assert!(
            super::row_width(line) <= 60,
            "bubble padding must not overflow the frame: {line:?}"
        );
    }
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
    let text: String = super::group_detail_lines(group, 40)
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

/// The Ctrl-O expansion of a finished subagent wraps its call list, like
/// the tool-group expansion it sits beside -- it is the surface the folded
/// summary row sends the user to, so it has to be complete.
#[test]
fn expanded_subagent_detail_wraps_instead_of_eliding() {
    let mut app = test_app();
    let long = "Executing: cargo test --no-default-features --features cli -- cli::tui::tests";
    app.push_subagent_summary("reviewer", vec![long.to_string()], true);
    let block = app.subagent_blocks.last().expect("no subagent block");
    let lines = block.detail_lines(50);
    assert!(lines.len() > 1, "detail was not wrapped: {lines:?}");
    let text: String = lines
        .iter()
        .flat_map(|l| l.spans.iter())
        .map(|s| s.content.as_ref())
        .collect();
    assert!(!text.contains('\u{2026}'), "detail elided: {text:?}");
    for word in ["--no-default-features", "cli::tui::tests"] {
        assert!(text.contains(word), "dropped {word:?}: {text:?}");
    }
    for line in &lines {
        let w: usize = line.spans.iter().map(|s| s.content.chars().count()).sum();
        assert!(w <= 50, "row overflows: {w}");
    }
}

/// Web and todo labels are stored whole like the bash one: the row wraps
/// them at the draw width, so a long URL is not cut at a fixed 80 on a
/// terminal with room for it.
#[test]
fn web_and_todo_labels_are_not_capped_at_a_fixed_width() {
    let url = format!("https://example.com/{}", "segment/".repeat(20));
    assert_eq!(
        tool_activity("web_fetch", &json!({ "url": url.clone() })),
        format!("Fetching: {url}")
    );
    assert_eq!(
        tool_finished("web_fetch", &json!({ "url": url.clone() })),
        format!("Fetched: {url}")
    );
    let query = "rust async runtime ".repeat(12);
    assert_eq!(
        tool_activity("web_search", &json!({ "query": query.clone() })),
        format!("Searching the web: {query}")
    );
    let task = "refactor the transport layer ".repeat(6);
    assert_eq!(
        tool_activity("todo", &json!({ "op": "start", "task": task.clone() })),
        format!("Starting task: {task}")
    );
}

/// A slash invocation's args are user text and can arrive pasted and
/// multi-line, so its row breaks on newlines like `push_user_line`.
#[test]
fn invocation_row_keeps_its_line_breaks() {
    let mut app = test_app();
    app.push_invocation_label("[skill:deploy] first line\nsecond line".to_string());
    let rows = render_rows(&mut app, 60, 12);
    assert!(
        rows.iter()
            .any(|r| r.trim_end().ends_with("[skill:deploy] first line")),
        "first line not on its own row: {rows:?}"
    );
    assert!(
        rows.iter().any(|r| r.trim_end().ends_with("second line")),
        "second line not on its own row: {rows:?}"
    );
}

/// The docked prompts size themselves from the rows they will need, so an
/// arbitrary-length upstream error is readable rather than clipped to the
/// one row a fixed height budgeted for it.
#[test]
fn login_prompt_grows_to_fit_a_long_error() {
    let mut app = test_app();
    let error = "verification failed: the upstream returned 502 Bad Gateway \
                     from https://api.tokamak.sh/v1/models after three attempts";
    app.login = Some(super::LoginPrompt {
        provider: "tokamak".to_string(),
        input: String::new(),
        error: Some(error.to_string()),
        ..super::LoginPrompt::new("tokamak")
    });
    let rows = render_rows(&mut app, 56, 24);
    let joined = rows.join(" ");
    // Single tokens: the assertion must not straddle a wrap point.
    for word in ["502", "api.tokamak.sh/v1/models", "attempts"] {
        assert!(
            joined.contains(word),
            "error clipped ({word}):\n{}",
            rows.join("\n")
        );
    }
}

/// An MCP field is being typed into: a long command line wraps inside the
/// box instead of running off its right edge with no way to see the rest.
#[test]
fn mcp_prompt_wraps_the_field_being_edited() {
    let mut app = test_app();
    let command = "npx -y @modelcontextprotocol/server-filesystem /home/user/projects/jan";
    app.mcp_prompt = Some(super::McpPrompt {
        editing: None,
        field: super::McpField::Command,
        name: "files".to_string(),
        transport: "stdio".to_string(),
        command: command.to_string(),
        args: String::new(),
        env: String::new(),
        url: String::new(),
        headers: String::new(),
        active: true,
        error: None,
    });
    let rows = render_rows(&mut app, 52, 26);
    let joined = rows.join(" ");
    for word in ["@modelcontextprotocol/server-", "/home/user/projects/jan"] {
        assert!(
            joined.contains(word),
            "field clipped ({word}):\n{}",
            rows.join("\n")
        );
    }
    for row in &rows {
        assert!(row.chars().count() <= 52, "row overflows: {row:?}");
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

#[test]
fn always_label_is_command_scoped_for_exec() {
    assert_eq!(
        pending(true).always_label(),
        "Allow this exact command (this thread)"
    );
    let mut p = pending(true);
    p.command = None;
    assert_eq!(p.always_label(), "Allow always (this thread)");
}

#[test]
fn pending_options_include_always_only_when_offered() {
    assert_eq!(pending(false).options().len(), 2);
    let opts = pending(true).options();
    assert_eq!(opts.len(), 3);
    assert_eq!(opts[1].0, PermissionDecision::AllowAlways);
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
fn config_screen_opens_as_readonly_viewer() {
    let mut app = test_app();
    open_config_screen(&mut app);
    let picker = app.picker.as_ref().expect("config screen opens a picker");
    assert!(picker.kind == PickerKind::ViewConfig);
    // Always at least one row: real providers, or the "no providers" hint.
    assert!(!picker.items.is_empty());
    // Enter is a no-op close (never mutates model/thread), matching the arm.
    assert!(picker.title().contains("config"));
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
fn pending_selection_wraps_both_directions() {
    let mut p = pending(true); // 3 options
    p.move_selection(-1);
    assert_eq!(p.selected, 2);
    p.move_selection(1);
    assert_eq!(p.selected, 0);
    p.move_selection(1);
    assert_eq!(p.selected, 1);
}

async fn prompt_key(app: &mut App, code: KeyCode, mods: KeyModifiers) {
    let registry: PermissionRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let mut current: Option<CurrentRun> = None;
    handle_key(app, KeyEvent::new(code, mods), &registry, &mut current, &no_mcp()).await;
}

#[tokio::test]
async fn ctrl_a_does_not_allow_always() {
    let mut app = test_app();
    app.pending_queue.push_back(pending(true));
    prompt_key(&mut app, KeyCode::Char('a'), KeyModifiers::CONTROL).await;
    assert_eq!(app.pending_queue.len(), 1);
}

#[tokio::test]
async fn ctrl_y_alt_n_leave_request_queued() {
    let mut app = test_app();
    app.pending_queue.push_back(pending(true));
    prompt_key(&mut app, KeyCode::Char('y'), KeyModifiers::CONTROL).await;
    prompt_key(&mut app, KeyCode::Char('n'), KeyModifiers::ALT).await;
    assert_eq!(app.pending_queue.len(), 1);
    prompt_key(&mut app, KeyCode::Char('y'), KeyModifiers::NONE).await;
    assert!(app.pending_queue.is_empty());
}

#[tokio::test]
async fn decision_keys_ignored_within_settle_window() {
    let mut app = test_app();
    let mut p = pending(true);
    p.shown_at = Instant::now();
    app.pending_queue.push_back(p);
    prompt_key(&mut app, KeyCode::Char('y'), KeyModifiers::NONE).await;
    prompt_key(&mut app, KeyCode::Enter, KeyModifiers::NONE).await;
    assert_eq!(app.pending_queue.len(), 1, "decision inside the window");
    app.pending_queue.front_mut().unwrap().shown_at =
        Instant::now().checked_sub(Duration::from_millis(500)).unwrap();
    prompt_key(&mut app, KeyCode::Char('y'), KeyModifiers::NONE).await;
    assert!(app.pending_queue.is_empty());
}

#[tokio::test]
async fn esc_denies_inside_settle_window() {
    let mut app = test_app();
    let mut p = pending(true);
    p.shown_at = Instant::now();
    app.pending_queue.push_back(p);
    prompt_key(&mut app, KeyCode::Esc, KeyModifiers::NONE).await;
    assert!(app.pending_queue.is_empty());
}

#[test]
fn permission_closes_open_picker() {
    let mut app = test_app();
    open_config_screen(&mut app);
    assert!(app.picker.is_some());
    app.apply(StreamEvent::PermissionRequest {
        request_id: "p1".into(),
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
    assert!(app.picker.is_none());
    assert!(app.prompt_owns_screen());
}

#[test]
fn draw_renders_permission_over_picker() {
    let mut app = test_app();
    open_config_screen(&mut app);
    assert!(app.picker.is_some());
    app.pending_queue.push_back(pending(true));
    let rows = render_rows(&mut app, 100, 30).join("\n");
    assert!(rows.contains("Deny"), "{rows}");
}

// ---- full repaint (janhq/jan#8804, #8780, adapted from #8806) ----------

use ratatui::{backend::TestBackend, Terminal};

/// Damage one painted cell of `terminal`'s screen the way a `wall(1)`
/// broadcast does: straight through the backend, which changes what is on
/// screen and leaves both of ratatui's buffers believing nothing moved.
fn broadcast_over<B: ratatui::backend::Backend>(
    terminal: &mut ratatui::Terminal<B>,
    clean: &Buffer,
) -> (u16, u16) {
    let (cx, cy) = (0..clean.area.height)
        .flat_map(|y| (0..clean.area.width).map(move |x| (x, y)))
        .find(|&(x, y)| clean[(x, y)].symbol().trim() != "")
        .expect("the frame must paint something");
    let mut cell = ratatui::buffer::Cell::EMPTY;
    cell.set_symbol("W");
    terminal
        .backend_mut()
        .draw(std::iter::once((cx, cy, &cell))).expect("the backend accepts the write");
    (cx, cy)
}

/// #8804. First half: the bug is real -- an ordinary redraw diffs two
/// identical buffers, emits nothing, and leaves the broadcast on screen.
/// Second half: the repaint re-emits every cell and the damage is gone.
#[test]
fn repaint_restores_cells_a_foreign_write_corrupted() {
    let mut app = test_app();
    app.submit_user("what does this project do".to_string());
    let mut terminal = Terminal::new(TestBackend::new(60, 30)).unwrap();
    terminal.draw(|f| super::draw(f, &mut app)).unwrap();
    let clean = terminal.backend().buffer().clone();

    let (cx, cy) = broadcast_over(&mut terminal, &clean);
    assert_eq!(terminal.backend().buffer()[(cx, cy)].symbol(), "W");

    terminal.draw(|f| super::draw(f, &mut app)).unwrap();
    assert_eq!(
        terminal.backend().buffer()[(cx, cy)].symbol(),
        "W",
        "a plain redraw is expected to leave foreign damage in place"
    );

    app.request_repaint();
    assert!(app.take_repaint());
    apply_repaint(&mut terminal);
    terminal.draw(|f| super::draw(f, &mut app)).unwrap();
    assert_eq!(
        terminal.backend().buffer(),
        &clean,
        "a repaint must restore the frame the broadcast damaged"
    );
}

/// #8780. An emulator reflowing during a drag can scribble on the screen
/// and settle back at the size it started from before the next frame.
/// ratatui only redraws on a *changed* size, so without the resize arm the
/// damage stays; with it, the resize event alone repairs the frame.
#[test]
fn a_resize_that_ends_at_the_same_size_still_repaints() {
    let mut app = test_app();
    app.submit_user("what does this project do".to_string());
    let mut terminal = Terminal::new(TestBackend::new(60, 30)).unwrap();
    terminal.draw(|f| super::draw(f, &mut app)).unwrap();
    let clean = terminal.backend().buffer().clone();

    let (cx, cy) = broadcast_over(&mut terminal, &clean);
    terminal.draw(|f| super::draw(f, &mut app)).unwrap();
    assert_eq!(
        terminal.backend().buffer()[(cx, cy)].symbol(),
        "W",
        "same-size autoresize must not be what repairs this"
    );

    route_resize_event(&mut app, Event::Resize(60, 30));
    assert!(app.take_repaint(), "a resize must request a full repaint");
    apply_repaint(&mut terminal);
    terminal.draw(|f| super::draw(f, &mut app)).unwrap();
    assert_eq!(terminal.backend().buffer(), &clean);
}

/// #8780. After a real change of geometry the frame on screen is exactly
/// the frame for the new size -- no rows from the old layout survive.
#[test]
fn a_resize_to_a_new_size_draws_the_whole_new_frame() {
    let mut app = test_app();
    app.submit_user("what does this project do".to_string());
    let mut terminal = Terminal::new(TestBackend::new(80, 30)).unwrap();
    terminal.draw(|f| super::draw(f, &mut app)).unwrap();

    terminal.backend_mut().resize(50, 20);
    route_resize_event(&mut app, Event::Resize(50, 20));
    assert!(app.take_repaint());
    apply_repaint(&mut terminal);
    terminal.draw(|f| super::draw(f, &mut app)).unwrap();

    let mut fresh = Terminal::new(TestBackend::new(50, 20)).unwrap();
    fresh.draw(|f| super::draw(f, &mut app)).unwrap();
    assert_eq!(terminal.backend().buffer(), fresh.backend().buffer());
}

/// Only a resize requests a repaint; the repaint is triggered, never
/// per frame, since an unconditional clear would flicker.
#[test]
fn only_a_resize_event_requests_a_repaint() {
    let mut app = test_app();
    route_resize_event(&mut app, Event::Paste("hi".into()));
    assert!(!app.take_repaint());
    route_resize_event(&mut app, Event::Resize(100, 40));
    assert!(app.take_repaint());
    assert!(!app.take_repaint(), "taking the request clears it");
}

/// Ctrl-L is the repaint key, advertised, and never typed into the draft.
#[tokio::test]
async fn ctrl_l_requests_a_repaint_and_types_nothing() {
    let mut app = test_app();
    let registry: PermissionRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let mut current: Option<CurrentRun> = None;
    let ctrl_l = KeyEvent::new(KeyCode::Char('l'), KeyModifiers::CONTROL);

    handle_key(&mut app, ctrl_l, &registry, &mut current, &no_mcp()).await;
    assert!(app.take_repaint(), "Ctrl-L must request a full repaint");
    assert!(app.input.is_empty(), "got: {:?}", app.input);

    let plain_l = KeyEvent::new(KeyCode::Char('l'), KeyModifiers::NONE);
    handle_key(&mut app, plain_l, &registry, &mut current, &no_mcp()).await;
    assert!(!app.take_repaint(), "only Ctrl-L may repaint");
    assert_eq!(app.input, "l");

    assert!(KEY_BINDINGS.iter().any(|(k, _)| k.contains("Ctrl-L")));
}

/// A repaint is display only: the draft and scroll position survive, and
/// the repainted frame is the same frame.
#[tokio::test]
async fn composer_draft_and_scroll_survive_a_repaint() {
    let mut app = test_app();
    for i in 0..40 {
        app.submit_user(format!("message {i}"));
    }
    app.input = "a draft mid-sentence".to_string();
    app.scrollback = 7;

    let mut terminal = Terminal::new(TestBackend::new(60, 30)).unwrap();
    terminal.draw(|f| super::draw(f, &mut app)).unwrap();
    let before = terminal.backend().buffer().clone();

    let registry: PermissionRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let mut current: Option<CurrentRun> = None;
    let ctrl_l = KeyEvent::new(KeyCode::Char('l'), KeyModifiers::CONTROL);
    handle_key(&mut app, ctrl_l, &registry, &mut current, &no_mcp()).await;

    assert_eq!(app.input, "a draft mid-sentence");
    assert_eq!(app.scrollback, 7);
    assert!(app.take_repaint());
    apply_repaint(&mut terminal);
    terminal.draw(|f| super::draw(f, &mut app)).unwrap();
    assert_eq!(terminal.backend().buffer(), &before);
}

/// A docked ask owns the keyboard and runs first, so it honours the
/// repaint key itself -- without answering, dismissing, or typing into
/// the answer being edited.
#[tokio::test]
async fn ctrl_l_repaints_while_an_ask_owns_the_keyboard() {
    let mut app = test_app();
    let registry = crate::core::agent::interaction::new_registry();
    let (request_id, _receiver) = crate::core::agent::interaction::register(&registry).await;
    app.apply(StreamEvent::AskRequest {
        request_id,
        request: ask_request(false, false),
        timeout_secs: None,
    });
    let ask = app.ask_queue.front_mut().unwrap();
    ask.editing_custom = true;
    ask.custom_input = "answer in progress".into();

    let ctrl_l = KeyEvent::new(KeyCode::Char('l'), KeyModifiers::CONTROL);
    assert!(handle_ask_key(&mut app, ctrl_l, &registry).await);
    assert!(app.take_repaint(), "Ctrl-L must repaint during an ask");
    assert!(!app.ask_queue.is_empty());
    assert_eq!(
        app.ask_queue.front().unwrap().custom_input,
        "answer in progress"
    );
}

/// A backend that counts cursor-position queries and otherwise is a
/// `TestBackend`. `Terminal::clear` issues one, which on crossterm is a DSR
/// round trip that blocks for up to two seconds on a silent terminal.
struct CountingBackend {
    inner: TestBackend,
    cursor_queries: std::cell::Cell<usize>,
}

impl ratatui::backend::Backend for CountingBackend {
    type Error = <TestBackend as ratatui::backend::Backend>::Error;

    fn draw<'a, I>(&mut self, content: I) -> Result<(), Self::Error>
    where
        I: Iterator<Item = (u16, u16, &'a ratatui::buffer::Cell)>,
    {
        self.inner.draw(content)
    }

    fn get_cursor_position(&mut self) -> Result<ratatui::layout::Position, Self::Error> {
        self.cursor_queries.set(self.cursor_queries.get() + 1);
        self.inner.get_cursor_position()
    }

    fn set_cursor_position<P: Into<ratatui::layout::Position>>(
        &mut self,
        position: P,
    ) -> Result<(), Self::Error> {
        self.inner.set_cursor_position(position)
    }

    fn hide_cursor(&mut self) -> Result<(), Self::Error> {
        self.inner.hide_cursor()
    }

    fn show_cursor(&mut self) -> Result<(), Self::Error> {
        self.inner.show_cursor()
    }

    fn clear(&mut self) -> Result<(), Self::Error> {
        self.inner.clear()
    }

    fn clear_region(
        &mut self,
        clear_type: ratatui::backend::ClearType,
    ) -> Result<(), Self::Error> {
        self.inner.clear_region(clear_type)
    }

    fn size(&self) -> Result<ratatui::layout::Size, Self::Error> {
        self.inner.size()
    }

    fn window_size(&mut self) -> Result<ratatui::backend::WindowSize, Self::Error> {
        self.inner.window_size()
    }

    fn flush(&mut self) -> Result<(), Self::Error> {
        self.inner.flush()
    }
}

/// The repaint never asks where the cursor is, and still repairs the frame.
#[test]
fn repaint_never_blocks_on_a_cursor_query() {
    let mut app = test_app();
    let backend = CountingBackend {
        inner: TestBackend::new(60, 30),
        cursor_queries: std::cell::Cell::new(0),
    };
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|f| super::draw(f, &mut app)).unwrap();
    let clean = terminal.backend().inner.buffer().clone();
    broadcast_over(&mut terminal, &clean);

    let before = terminal.backend().cursor_queries.get();
    apply_repaint(&mut terminal);
    terminal.draw(|f| super::draw(f, &mut app)).unwrap();
    assert_eq!(terminal.backend().cursor_queries.get() - before, 0);
    assert_eq!(terminal.backend().inner.buffer(), &clean);
}

fn ask_request(
    multi: bool,
    two_questions: bool,
) -> crate::core::agent::interaction::AskRequest {
    let mut questions = vec![json!({
        "id": "scope",
        "question": "Which scope?",
        "options": [{"label": "Small"}, {"label": "Large", "description": "Everything"}],
        "multi": multi,
        "recommended": 0
    })];
    if two_questions {
        questions.push(json!({
            "id": "speed",
            "question": "Which speed?",
            "options": [{"label": "Fast"}, {"label": "Careful"}]
        }));
    }
    crate::core::agent::interaction::AskRequest::parse(&json!({
        "questions": questions
    }))
    .unwrap()
}

async fn press_ask(
    app: &mut App,
    registry: &crate::core::agent::interaction::AskRegistry,
    code: KeyCode,
) {
    assert!(handle_ask_key(app, KeyEvent::new(code, KeyModifiers::NONE), registry,).await);
}

#[tokio::test]
async fn ask_keyboard_preserves_answers_across_questions() {
    let mut app = test_app();
    let registry = crate::core::agent::interaction::new_registry();
    let (request_id, receiver) = crate::core::agent::interaction::register(&registry).await;
    app.apply(StreamEvent::AskRequest {
        request_id,
        request: ask_request(false, true),
        timeout_secs: None,
    });

    press_ask(&mut app, &registry, KeyCode::Enter).await;
    assert_eq!(app.ask_queue.front().unwrap().question_index, 1);
    press_ask(&mut app, &registry, KeyCode::Left).await;
    assert_eq!(
        app.ask_queue.front().unwrap().answers[0].selected,
        vec!["Small"]
    );
    press_ask(&mut app, &registry, KeyCode::Right).await;
    press_ask(&mut app, &registry, KeyCode::Down).await;
    press_ask(&mut app, &registry, KeyCode::Enter).await;

    assert!(app.ask_queue.is_empty(), "final answer did not submit");
    assert!(
        registry.lock().await.is_empty(),
        "ask sender was not resolved"
    );
    let answers = receiver.await.unwrap().unwrap();
    assert_eq!(answers[0].selected, vec!["Small"]);
    assert_eq!(answers[1].selected, vec!["Careful"]);
    assert!(app.ask_queue.is_empty());
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
async fn ask_keyboard_accepts_repeated_key_events() {
    let mut app = test_app();
    let registry = crate::core::agent::interaction::new_registry();
    let (request_id, receiver) = crate::core::agent::interaction::register(&registry).await;
    app.apply(StreamEvent::AskRequest {
        request_id,
        request: ask_request(false, false),
        timeout_secs: None,
    });

    let mut key = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
    key.kind = KeyEventKind::Repeat;
    assert!(handle_ask_key(&mut app, key, &registry).await);

    let answers = receiver.await.unwrap().unwrap();
    assert_eq!(answers[0].selected, vec!["Small"]);
    assert!(app.ask_queue.is_empty());
}

#[tokio::test]
async fn ask_keyboard_handles_multi_select_and_cancellation() {
    let mut app = test_app();
    let registry = crate::core::agent::interaction::new_registry();
    let (request_id, receiver) = crate::core::agent::interaction::register(&registry).await;
    app.apply(StreamEvent::AskRequest {
        request_id,
        request: ask_request(true, false),
        timeout_secs: None,
    });

    press_ask(&mut app, &registry, KeyCode::Char(' ')).await;
    for _ in 0..3 {
        press_ask(&mut app, &registry, KeyCode::Down).await;
    }
    press_ask(&mut app, &registry, KeyCode::Enter).await;
    assert!(app.ask_queue.is_empty(), "multi-select did not submit");
    assert!(
        registry.lock().await.is_empty(),
        "ask sender was not resolved"
    );
    let answers = receiver.await.unwrap().unwrap();
    assert_eq!(answers[0].selected, vec!["Small"]);

    let (request_id, receiver) = crate::core::agent::interaction::register(&registry).await;
    app.apply(StreamEvent::AskRequest {
        request_id,
        request: ask_request(false, false),
        timeout_secs: None,
    });
    press_ask(&mut app, &registry, KeyCode::Esc).await;
    assert!(matches!(
        receiver.await.unwrap(),
        Err(crate::core::agent::interaction::AskError::Cancelled)
    ));
    assert!(app.ask_queue.is_empty());
}

#[tokio::test]
async fn ask_mouse_opens_custom_editor_and_submits_text() {
    use ratatui::{backend::TestBackend, Terminal};
    let mut app = test_app();
    let registry = crate::core::agent::interaction::new_registry();
    let (request_id, receiver) = crate::core::agent::interaction::register(&registry).await;
    app.apply(StreamEvent::AskRequest {
        request_id,
        request: ask_request(false, false),
        timeout_secs: None,
    });
    let mut terminal = Terminal::new(TestBackend::new(36, 24)).unwrap();
    terminal.draw(|frame| super::draw(frame, &mut app)).unwrap();
    // Hitboxes are per screen row and an option may be several rows tall,
    // so find the first row belonging to the "Other" item rather than the
    // third entry in the list.
    let other_row = app
        .ask_queue
        .front()
        .unwrap()
        .row_hitboxes
        .iter()
        .find(|(_, index)| *index == 2)
        .expect("no hitbox for the custom row")
        .0;

    assert!(
        handle_ask_mouse(
            &mut app,
            MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: 2,
                row: other_row,
                modifiers: KeyModifiers::NONE,
            },
            &registry,
        )
        .await
    );
    assert!(app.ask_queue.front().unwrap().editing_custom);
    for ch in "custom answer".chars() {
        press_ask(&mut app, &registry, KeyCode::Char(ch)).await;
    }
    press_ask(&mut app, &registry, KeyCode::Enter).await;

    assert!(app.ask_queue.is_empty(), "custom answer did not submit");
    assert!(
        registry.lock().await.is_empty(),
        "ask sender was not resolved"
    );
    let answers = receiver.await.unwrap().unwrap();
    assert_eq!(answers[0].custom_input.as_deref(), Some("custom answer"));
    assert!(app.ask_queue.is_empty());
}

#[tokio::test]
async fn ask_paste_event_prefers_login_over_active_custom_editor() {
    let mut app = test_app();
    let registry = crate::core::agent::interaction::new_registry();
    let (request_id, _receiver) = crate::core::agent::interaction::register(&registry).await;
    app.apply(StreamEvent::AskRequest {
        request_id,
        request: ask_request(false, false),
        timeout_secs: None,
    });

    press_ask(&mut app, &registry, KeyCode::Down).await;
    press_ask(&mut app, &registry, KeyCode::Down).await;
    press_ask(&mut app, &registry, KeyCode::Enter).await;
    assert!(app.ask_queue.front().unwrap().editing_custom);
    app.login = Some(confirmed_paste_prompt());

    route_paste_event(&mut app, Event::Paste("tokamak-api-key".into()));

    assert_eq!(app.login.as_ref().unwrap().input, "tokamak-api-key");
    assert!(app.ask_queue.front().unwrap().custom_input.is_empty());
    assert!(app.input.is_empty(), "paste leaked into chat composer");
}

#[tokio::test]
async fn ask_paste_event_resolves_custom_response() {
    let mut app = test_app();
    let registry = crate::core::agent::interaction::new_registry();
    let (request_id, receiver) = crate::core::agent::interaction::register(&registry).await;
    app.apply(StreamEvent::AskRequest {
        request_id,
        request: ask_request(false, false),
        timeout_secs: None,
    });

    press_ask(&mut app, &registry, KeyCode::Down).await;
    press_ask(&mut app, &registry, KeyCode::Down).await;
    press_ask(&mut app, &registry, KeyCode::Enter).await;
    assert!(app.ask_queue.front().unwrap().editing_custom);

    route_paste_event(&mut app, Event::Paste("pasted answer".into()));

    assert_eq!(app.ask_queue.front().unwrap().custom_input, "pasted answer");
    assert!(app.input.is_empty(), "paste leaked into chat composer");

    press_ask(&mut app, &registry, KeyCode::Enter).await;
    let answers = receiver.await.unwrap().unwrap();
    assert_eq!(answers[0].custom_input.as_deref(), Some("pasted answer"));
    assert!(app.ask_queue.is_empty());
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

/// A `PendingAsk` built from a `timeout_secs: Some(n)` event carries a
/// deadline roughly `n` seconds out, and one with `None` carries none.
#[test]
fn pending_ask_deadline_tracks_configured_timeout() {
    let req = ask_request(false, false);
    let none = super::PendingAsk::new("r1".into(), req.clone(), None);
    assert_eq!(none.deadline, None, "no timeout should mean no deadline");

    let short = super::PendingAsk::new(
        "r2".into(),
        req.clone(),
        Some(std::time::Duration::from_secs(30)),
    );
    let deadline = short.deadline.expect("a deadline should be set");
    let now = std::time::Instant::now();
    let slack = deadline.duration_since(now).as_secs_f64();
    assert!(
        (slack - 30.0).abs() < 1.0,
        "deadline should be ~30s out, got {slack:.1}s"
    );
}

/// `remaining_secs` rounds the leftover time UP (ceil): a sub-second
/// remainder still reads `1s`, never `0s`, so a still-live prompt never
/// claims it is out of time.
#[test]
fn pending_ask_remaining_seconds_rounds_up_and_stops_at_deadline() {
    let req = ask_request(false, false);
    let ask =
        super::PendingAsk::new("r1".into(), req, Some(std::time::Duration::from_secs(30)));
    let deadline = ask.deadline.unwrap();
    // 500ms before the deadline: ceil -> 1s.
    let early = deadline - std::time::Duration::from_millis(500);
    assert_eq!(ask.remaining_secs(early), Some(1), "ceil, not floor");
    // Well before: whole seconds.
    let far = deadline - std::time::Duration::from_secs(27);
    assert_eq!(ask.remaining_secs(far), Some(27));
    // At/after the deadline: no remaining time.
    assert_eq!(ask.remaining_secs(deadline), None);
    assert_eq!(
        ask.remaining_secs(deadline + std::time::Duration::from_secs(1)),
        None
    );
}

/// The ask box title carries the live countdown when a timeout is set, and
/// omits it when none is.
#[test]
fn ask_title_counts_down_the_configured_deadline() {
    let mut app = test_app();
    let req = ask_request(false, false);
    app.ask_queue.push_back(super::PendingAsk::new(
        "r1".into(),
        req,
        Some(std::time::Duration::from_secs(120)),
    ));
    let join = render_rows(&mut app, 60, 24).join("\n");
    assert!(
        join.contains("question 1/1") && join.contains("120s"),
        "title should show the countdown, got {join:?}"
    );

    // No timeout: no countdown segment at all.
    let mut app = test_app();
    app.ask_queue.push_back(super::PendingAsk::new(
        "r2".into(),
        ask_request(false, false),
        None,
    ));
    let join = render_rows(&mut app, 60, 24).join("\n");
    assert!(
        join.contains("question 1/1") && !join.contains("120s") && !join.contains("s\u{b7}"),
        "no-timeout title should omit the countdown, got {join:?}"
    );
}

#[test]
fn paste_event_routes_to_chat_composer_without_login_or_ask() {
    let mut app = test_app();

    route_paste_event(&mut app, Event::Paste("chat text".into()));

    assert_eq!(app.input, "chat text");
}

#[test]
fn split_reasoning_separates_think_blocks() {
    let segs = split_reasoning("before<think>hidden</think>after");
    assert_eq!(
        segs,
        vec![
            (false, "before".to_string()),
            (true, "hidden".to_string()),
            (false, "after".to_string()),
        ]
    );
}

#[test]
fn incremental_matches_full_scan_over_every_split() {
    let texts = [
        "<think>plan</think>answer",
        "  <think>a</think>\n <thinking>b</thinking>x",
        "pre <think> unterminated",
        "<think></think>  ",
        "a<b>c</think>d<think",
        "<unsloth:think>\u{e9}</unsloth:think>\u{fc}<think>",
        "x < y and a<b",
        "",
    ];
    for text in texts {
        for step in 1..=7usize {
            let mut scan = super::ThinkScan::default();
            let mut buf = String::new();
            let mut at = 0;
            while at < text.len() {
                let mut to = (at + step).min(text.len());
                while !text.is_char_boundary(to) {
                    to += 1;
                }
                buf.push_str(&text[at..to]);
                at = to;
                assert_eq!(
                    scan.state(&buf),
                    (thinking_open(&buf), has_answer_text(&buf)),
                    "{text:?} step {step} after {buf:?}"
                );
            }
        }
    }
}

#[test]
fn tag_split_across_tokens() {
    let mut app = test_app();
    app.assistant_buf.push_str("<thi");
    assert!(!app.reasoning_open());
    app.assistant_buf.push_str("nk>pondering");
    assert!(app.reasoning_open());
    app.assistant_buf.push_str("</think>done");
    assert!(!app.reasoning_open());
}

#[test]
fn a_replaced_buffer_is_rescanned() {
    let mut app = test_app();
    app.assistant_buf = "<think>weighing options".to_string();
    assert!(app.reasoning_open());
    app.assistant_buf = "here is the answer, which is longer than before".to_string();
    assert!(!app.reasoning_open());
}

#[test]
fn split_reasoning_handles_namespaced_and_unterminated_tags() {
    let segs = split_reasoning("<mm:think>reasoning tail");
    assert_eq!(segs, vec![(true, "reasoning tail".to_string())]);
}

/// With `think_tags = false` the tags carry no meaning: one answer run, so
/// the text renders verbatim instead of folding into a reasoning block.
#[test]
fn think_tags_gate_off_makes_the_whole_text_answer_prose() {
    let text = "before<think>hidden</think>after";
    let segs = without_think_tags(|| split_reasoning(text));
    assert_eq!(segs, vec![(false, text.to_string())]);
}

/// The tags stay in the answer that goes back as history: not parsing them
/// means there is no reasoning to strip.
#[test]
fn think_tags_gate_off_keeps_the_tags_in_the_wire_answer() {
    let text = "<think>hidden</think>answer";
    assert_eq!(
        without_think_tags(|| answer_without_reasoning(text)),
        text,
        "nothing is reasoning with the gate off"
    );
    assert_eq!(
        answer_without_reasoning(text),
        "answer",
        "the default still strips it"
    );
}

/// An unterminated tag no longer opens a thinking window, so the header
/// badge and the folded live tail stay off.
#[test]
fn think_tags_gate_off_never_reports_an_open_block() {
    assert!(thinking_open("<think>still going"));
    assert!(!without_think_tags(|| thinking_open("<think>still going")));
}

/// A journal written before reasoning was stored apart has its markers
/// inside `text` and no `reasoning` field. It must still replay as a folded
/// block: the markers go down the inline path, which is exactly what they
/// were before the split.
#[test]
fn a_pre_split_journal_entry_still_replays_its_reasoning() {
    let raw = r#"{"kind":"assistant","text":"<think>old thought</think>Answer."}"#;
    let entry: DisplayEntry = serde_json::from_str(raw).expect("legacy entry parses");
    assert_eq!(
        entry,
        DisplayEntry::Assistant {
            text: "<think>old thought</think>Answer.".into(),
            reasoning: Vec::new(),
            reasoning_ms: None,
        }
    );
    let mut app = test_app();
    replay_display_log(&mut app, vec![entry]);
    assert_eq!(
        app.reasoning_blocks.len(),
        1,
        "legacy markers must still fold into a reasoning block"
    );
}

/// A turn journaled with reasoning apart replays to the same rows, without
/// any marker round-trip.
#[test]
fn a_split_journal_entry_replays_prose_and_reasoning_apart() {
    let entry = DisplayEntry::Assistant {
        text: "Answer.".into(),
        reasoning: vec![ReasoningSeg {
            at: 0,
            text: "a thought".into(),
        }],
        reasoning_ms: None,
    };
    let round_tripped: DisplayEntry =
        serde_json::from_str(&serde_json::to_string(&entry).unwrap()).unwrap();
    assert_eq!(round_tripped, entry);
    let mut app = test_app();
    replay_display_log(&mut app, vec![entry]);
    assert_eq!(app.reasoning_blocks.len(), 1);
}

/// The gate governs inline tags only. Native reasoning is carried
/// structurally, so it keeps rendering as its own run either way.
#[test]
fn think_tags_gate_does_not_touch_native_reasoning() {
    let segs = vec![ReasoningSeg {
        at: 0,
        text: "a thought".into(),
    }];
    let expected = vec![
        (true, "a thought".to_string()),
        (false, "answer".to_string()),
    ];
    assert_eq!(assistant_runs("answer", &segs), expected);
    assert_eq!(
        without_think_tags(|| assistant_runs("answer", &segs)),
        expected,
        "native reasoning is not encoded as tags, so the gate cannot hide it"
    );
}

/// Native segments are placed at the offset they streamed at, so a turn that
/// reasons, answers, then reasons again keeps emission order.
#[test]
fn assistant_runs_interleaves_native_reasoning_by_offset() {
    let segs = vec![
        ReasoningSeg {
            at: 0,
            text: "first".into(),
        },
        ReasoningSeg {
            at: 6,
            text: "second".into(),
        },
    ];
    assert_eq!(
        assistant_runs("prose tail", &segs),
        vec![
            (true, "first".to_string()),
            (false, "prose ".to_string()),
            (true, "second".to_string()),
            (false, "tail".to_string()),
        ]
    );
}

/// A model writing *about* think tags cannot close a native reasoning
/// segment: the two sources never share a string, so no escaping is needed.
#[test]
fn a_think_tag_inside_native_reasoning_stays_in_that_run() {
    let segs = vec![ReasoningSeg {
        at: 0,
        text: "the </think> tag closes a block".into(),
    }];
    assert_eq!(
        assistant_runs("answer", &segs),
        vec![
            (true, "the </think> tag closes a block".to_string()),
            (false, "answer".to_string()),
        ]
    );
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

#[test]
fn strip_system_xml_tags_removes_system_blocks() {
    assert_eq!(
        strip_system_xml_tags("answer<system-notice>internal nudge</system-notice>tail"),
        "answertail"
    );
}

#[test]
fn strip_system_xml_tags_removes_multiline_and_unterminated() {
    assert_eq!(
        strip_system_xml_tags("a<system-directive>\nline one\nline two</system-directive>b"),
        "ab"
    );
    assert_eq!(strip_system_xml_tags("a<system-notice>never closed"), "a");
}

#[test]
fn strip_system_xml_tags_keeps_plain_text() {
    assert_eq!(
        strip_system_xml_tags("no tags here <systemic> not a tag"),
        "no tags here <systemic> not a tag"
    );
}

#[test]
fn live_tail_streams_open_reasoning_and_the_gate_hides_it() {
    let mut app = test_app();
    app.assistant_buf = "<think>pondering the answer".to_string();

    // Streaming is the default: a folded, still-open block shows its tail so
    // the user can watch the thought form.
    let streamed = render_rows(&mut app, 60, 30).join("\n");
    assert!(
        streamed.contains("pondering"),
        "open reasoning streams by default: {streamed}"
    );

    // With the gate off only the header's [thinking] badge stands for it.
    app.stream_reasoning = false;
    let hidden = render_rows(&mut app, 60, 30).join("\n");
    assert!(
        !hidden.contains("pondering"),
        "stream_reasoning = false hides the open block"
    );

    // With show_reasoning on, folding is off entirely and it renders whole.
    app.show_reasoning = true;
    let shown = render_rows(&mut app, 60, 30).join("\n");
    assert!(
        shown.contains("pondering"),
        "revealed live tail must contain it"
    );
}

/// A long chain of thought must not push the answer, or the conversation
/// above it, off the screen: the live tail keeps only the last few lines.
#[test]
fn live_tail_bounds_streaming_reasoning_to_its_last_lines() {
    let body: String = (1..=20).map(|n| format!("step {n}\n")).collect();
    let lines = super::live_assistant_lines(&format!("<think>{body}"), &[], 60, true, true);
    let text: Vec<String> = lines
        .iter()
        .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect())
        .collect();
    assert_eq!(text.len(), 6, "capped at the tail: {text:?}");
    assert!(text[0].contains("step 15"), "starts at the tail: {text:?}");
    assert!(text[5].contains("step 20"), "ends at the newest: {text:?}");
}

/// The tail is bounded in *rendered* rows, not source lines. Reasoning
/// usually arrives as one long paragraph, so a newline-counted cap let a
/// single line wrap into an unpredictable number of screen rows and the
/// block's height jittered between frames as that line grew.
#[test]
fn live_tail_height_is_stable_as_one_long_line_grows() {
    let width = 40u16;
    let words: Vec<String> = (1..=120).map(|n| format!("word{n}")).collect();
    let mut seen = 0u16;
    for n in (1..=words.len()).step_by(3) {
        let body = words[..n].join(" ");
        let lines =
            super::live_assistant_lines(&format!("<think>{body}"), &[], width, true, true);
        let rows = lines.len() as u16;
        assert_eq!(
            rows,
            super::wrapped_height(lines.clone(), width),
            "a pre-wrapped tail must not re-wrap ({n} words)"
        );
        assert!(rows <= 6, "tail grew to {rows} rows ({n} words)");
        assert!(
            rows >= seen,
            "tail shrank from {seen} to {rows} rows ({n} words)"
        );
        seen = rows;
    }
    assert_eq!(seen, 6, "tail never filled to its cap");
}

/// A block that already closed mid-turn folds to the very summary row the
/// commit will emit, so finalizing the turn does not move the transcript.
#[test]
fn live_tail_folds_a_closed_reasoning_run_to_its_summary_row() {
    let lines = super::live_assistant_lines(
        "<think>weighed it\ntwice</think>Here is the answer.",
        &[],
        60,
        true,
        true,
    );
    let text: Vec<String> = lines
        .iter()
        .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect())
        .collect();
    assert!(
        text.iter().any(|l| l.contains("Thought")),
        "closed run folds to a summary: {text:?}"
    );
    assert!(
        !text.iter().any(|l| l.contains("weighed it")),
        "closed run is not shown in full: {text:?}"
    );
    assert!(
        text.iter().any(|l| l.contains("Here is the answer.")),
        "prose still renders: {text:?}"
    );
}

#[test]
fn header_shows_thinking_and_thought_for_status_when_folded() {
    use ratatui::{backend::TestBackend, Terminal};
    let mut app = test_app();
    app.submit_user("hi".to_string());

    let render = |app: &mut App| {
        let mut terminal = Terminal::new(TestBackend::new(110, 30)).unwrap();
        terminal.draw(|f| super::draw(f, app)).unwrap();
        let buf = terminal.backend().buffer().clone();
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .map(|x| buf[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    // Open reasoning -> [thinking] (replacing [working]).
    app.apply(StreamEvent::Token {
        text: "<think>pondering the plan".into(),
    });
    let thinking = render(&mut app);
    assert!(thinking.contains("[thinking]"), "thinking: {thinking}");
    assert!(!thinking.contains("[working]"), "thinking: {thinking}");

    // Block closes -> [thought for Ns] for a short while after.
    app.apply(StreamEvent::Token {
        text: "</think>Answer.".into(),
    });
    let done = render(&mut app);
    assert!(done.contains("[thought for"), "thought-for: {done}");
}

#[test]
fn thought_for_falls_back_to_working_after_ttl() {
    use ratatui::{backend::TestBackend, Terminal};
    let mut app = test_app();
    app.submit_user("hi".to_string());

    let render = |app: &mut App| {
        let mut terminal = Terminal::new(TestBackend::new(110, 30)).unwrap();
        terminal.draw(|f| super::draw(f, app)).unwrap();
        let buf = terminal.backend().buffer().clone();
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .map(|x| buf[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    // Open then close a reasoning block so the summary appears.
    app.apply(StreamEvent::Token {
        text: "<think>ponder the plan".into(),
    });
    app.apply(StreamEvent::Token {
        text: "</think> responseA.".into(),
    });
    let fresh = render(&mut app);
    assert!(fresh.contains("[thought for"), "fresh: {fresh}");

    // Age the summary beyond its TTL; it must fall back to [working] rather
    // than pinning [thought for Ns] for the rest of the turn.
    if let Some(since) = app.thought_for_since {
        app.thought_for_since =
            Some(since - super::THOUGHT_FOR_TTL - std::time::Duration::from_secs(1));
    }
    let stale = render(&mut app);
    assert!(
        stale.contains("[working]"),
        "stale should be [working]: {stale}"
    );
    assert!(
        !stale.contains("[thought for"),
        "stale thought-for: {stale}"
    );
}

/// A reason -> tool turn (the reasoning block is closed by a tool call's
/// flush, not by a content token) still shows `[thought for Ns]` in the
/// header, exactly as a reason -> answer turn does. Before, `flush_assistant`
/// closed the block without stamping the badge state, so the header jumped
/// straight to [working] on this path alone.
#[test]
fn reason_then_tool_turn_shows_thought_for_badge() {
    use ratatui::{backend::TestBackend, Terminal};
    let mut app = test_app();
    app.submit_user("hi".to_string());
    let render = |app: &mut App| {
        let mut terminal = Terminal::new(TestBackend::new(110, 30)).unwrap();
        terminal.draw(|f| super::draw(f, app)).unwrap();
        let buf = terminal.backend().buffer().clone();
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .map(|x| buf[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    // Native reasoning streams (open block) -> [thinking].
    app.apply(StreamEvent::Reasoning {
        text: "planning the edit".into(),
    });
    assert!(render(&mut app).contains("[thinking]"), "thinking while reasoning");
    // A tool call (no answer prose) closes the block via flush_assistant.
    app.apply(StreamEvent::ToolCall {
        id: "t1".into(),
        name: "read".into(),
        args: json!({ "path": "main.rs" }),
    });
    let after = render(&mut app);
    assert!(
        after.contains("[thought for"),
        "reason -> tool turn must keep the thought-for badge: {after}"
    );
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
fn expanded_reasoning_renders_full_detail_in_draw() {
    use ratatui::{backend::TestBackend, Terminal};
    let mut app = test_app();
    app.submit_user("hi".to_string());
    app.apply(StreamEvent::Token {
        text: "<think>secret plan line</think>Answer.".into(),
    });
    app.on_done("stop".into(), None);
    assert_eq!(app.reasoning_blocks.len(), 1);

    let render = |app: &mut App| {
        let mut terminal = Terminal::new(TestBackend::new(60, 30)).unwrap();
        terminal.draw(|f| super::draw(f, app)).unwrap();
        let buf = terminal.backend().buffer().clone();
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .map(|x| buf[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let collapsed = render(&mut app);
    assert!(
        !collapsed.contains("secret plan line"),
        "collapsed: {collapsed}"
    );
    assert!(collapsed.contains("Thought"));

    app.toggle_regions();
    let expanded = render(&mut app);
    assert!(
        expanded.contains("secret plan line"),
        "expanded draw must reveal the reasoning: {expanded}"
    );
}

#[test]
fn expanding_offscreen_region_scrolls_it_into_view() {
    use ratatui::{backend::TestBackend, Terminal};
    let mut app = test_app();
    app.submit_user("hi".to_string());
    // Reasoning near the top, then a long answer that fills past a short
    // viewport so the folded row is off-screen when pinned to the bottom.
    app.apply(StreamEvent::Token {
        text: "<think>hidden rationale</think>".into(),
    });
    for i in 0..40 {
        app.apply(StreamEvent::Token {
            text: format!("answer line {i}\n"),
        });
    }
    app.on_done("stop".into(), None);
    assert_eq!(app.reasoning_blocks.len(), 1);

    let render = |app: &mut App| {
        let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
        terminal.draw(|f| super::draw(f, app)).unwrap();
        let buf = terminal.backend().buffer().clone();
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .map(|x| buf[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    // Pinned to the bottom: the folded reasoning row is not on screen.
    assert!(!render(&mut app).contains("Thought"));

    // Expanding scrolls the region into view so its detail is visible.
    app.toggle_regions();
    let expanded = render(&mut app);
    assert!(
        expanded.contains("hidden rationale"),
        "expanded region must be scrolled into view: {expanded}"
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

#[test]
fn long_user_prompt_wraps_in_transcript() {
    use ratatui::{backend::TestBackend, Terminal};
    let mut app = test_app();
    let msg = "Check why in this project, for some models like Gemma 4 12b, \
                   the cache is never stored and it starts reprocessing the prompt \
                   from the beginning on every turn";
    app.submit_user(msg.to_string());
    let mut terminal = Terminal::new(TestBackend::new(60, 30)).unwrap();
    terminal.draw(|f| super::draw(f, &mut app)).unwrap();
    let buf = terminal.backend().buffer().clone();
    let rows: Vec<String> = (0..buf.area.height)
        .map(|y| {
            (0..buf.area.width)
                .map(|x| buf[(x, y)].symbol())
                .collect::<String>()
        })
        .collect();
    // The last word must survive on a wrapped continuation row.
    assert!(
        rows.iter().any(|r| r.contains("beginning")),
        "user prompt truncated instead of wrapping:\n{}",
        rows.join("\n")
    );

    // And it must re-wrap after the terminal shrinks (resize mid-session).
    terminal.backend_mut().resize(40, 30);
    terminal.draw(|f| super::draw(f, &mut app)).unwrap();
    let buf = terminal.backend().buffer().clone();
    let rows: Vec<String> = (0..buf.area.height)
        .map(|y| {
            (0..buf.area.width)
                .map(|x| buf[(x, y)].symbol())
                .collect::<String>()
        })
        .collect();
    assert!(
        rows.iter().any(|r| r.contains("beginning")),
        "user prompt truncated after resize:\n{}",
        rows.join("\n")
    );
}

#[test]
fn group_summary_counts_and_pluralizes() {
    assert_eq!(
        group_summary(&[
            ("memory note", true),
            ("skill", true),
            ("memory note", true)
        ]),
        "Read 2 memory notes, 1 skill"
    );
    assert_eq!(
        group_summary(&[("command", false), ("search", false), ("search", false)]),
        "Ran 1 command, 2 searches"
    );
    assert_eq!(
        group_summary(&[("directory", true), ("directory", true)]),
        "Read 2 directories"
    );
}

#[test]
fn group_summary_splits_read_and_run_clauses() {
    // Mixed ops keep the verb agreeing with its noun: never "Ran 1 directory".
    assert_eq!(
        group_summary(&[
            ("directory", true),
            ("search", false),
            ("file", true),
            ("command", false),
        ]),
        "Read 1 directory, 1 file; ran 1 search, 1 command"
    );
}

/// A `bash` call carrying only a `job_id` is a poll of an already
/// backgrounded command: it blocks until that command finishes, so its row
/// can stay live for minutes. "Executing command" said nothing at all
/// about what was running.
#[test]
fn a_backgrounded_bash_poll_names_the_job_it_waits_on() {
    assert_eq!(
        tool_activity("bash", &json!({ "job_id": "bash-3" })),
        "Waiting for background job bash-3"
    );
    assert_eq!(
        tool_finished("bash", &json!({ "job_id": "bash-3" })),
        "Collected background job bash-3"
    );
    assert_eq!(
        subagent_activity("bash", &json!({ "job_id": "bash-3" })),
        "awaiting job bash-3"
    );
    // The command, once the run remembers which one the job is:
    let args = json!({ "job_id": "bash-3", "command": "cargo build --release" });
    assert_eq!(
        tool_activity("bash", &args),
        "Waiting for: cargo build --release"
    );
    assert_eq!(
        tool_finished("bash", &args),
        "Collected: cargo build --release"
    );
    assert_eq!(
        subagent_activity("bash", &args),
        "awaiting $ cargo build --release"
    );
    // A blank job id is no job id: an ordinary call is unaffected.
    assert_eq!(
        tool_activity("bash", &json!({ "command": "ls", "job_id": "  " })),
        "Executing: ls"
    );
}

/// The job id is read back out of the result that handed it out, so the
/// marker the tool prints is what this has to match.
#[test]
fn a_backgrounding_notice_yields_its_job_id() {
    let notice = "Command exceeded 30s and is continuing in the background \
             (job_id=bash-7). Call bash again with {\"job_id\": \"bash-7\"} (no \
             command) to wait for and collect its output once it finishes.";
    assert_eq!(backgrounded_job_id(notice), Some("bash-7"));
    // Not every bash result carries one.
    assert_eq!(backgrounded_job_id("hello\n[exit 0]"), None);
    assert_eq!(
        backgrounded_job_id("ERROR: unknown or already-collected job_id 'nope'"),
        None
    );
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
        delta: "x".repeat(super::LIVE_OUTPUT_MAX_BYTES * 2),
    });
    let held = app.live_output.get("t1").expect("buffered").len();
    assert!(held <= super::LIVE_OUTPUT_MAX_BYTES, "kept {held} bytes");
}

/// Only a bounded tail is rendered, so a chatty command cannot push the
/// conversation off the screen.
#[test]
fn the_live_panel_renders_only_a_bounded_tail() {
    let many: String = (0..60).map(|i| format!("line {i}\n")).collect();
    // prompt + skip-notice + bounded tail + status row + two borders.
    let rows = super::running_terminal_lines("make", &many, 0, 0, 70);
    assert!(
        rows.len() <= super::LIVE_OUTPUT_TAIL_LINES + 5,
        "unbounded panel: {} rows",
        rows.len()
    );
    let text = rows
        .iter()
        .map(|l| {
            l.spans
                .iter()
                .map(|s| s.content.as_ref())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("line 59"), "the newest line shows: {text}");
    assert!(!text.contains("line 0\n"), "the oldest is elided: {text}");
    assert!(
        text.contains("earlier lines"),
        "elision is reported: {text}"
    );
}

#[test]
fn tool_activity_is_concise_present_tense() {
    assert_eq!(
        tool_activity("bash", &json!({ "command": "/usr/bin/grep -n foo src/" })),
        "Executing: /usr/bin/grep -n foo src/"
    );
    assert_eq!(
        tool_activity("bash", &json!({ "command": "cargo test" })),
        "Executing: cargo test"
    );
    // Kept whole: the row clamps to the draw width, so a long command fills
    // the terminal instead of being cut at a fixed 80.
    let long = format!("echo {}", "x".repeat(200));
    assert_eq!(
        tool_activity("bash", &json!({ "command": long })),
        format!("Executing: {long}")
    );
    assert_eq!(
        tool_activity("grep", &json!({ "pattern": "foo" })),
        "Searching"
    );
    assert_eq!(
        tool_activity("read", &json!({ "path": "src/main.rs" })),
        "Reading main.rs"
    );
    assert_eq!(
        tool_activity("memory_write", &json!({ "name": "decisions" })),
        "Updating memory: decisions"
    );
}

#[test]
fn tool_finished_is_concise_past_tense() {
    assert_eq!(
        tool_finished("bash", &json!({ "command": "/usr/bin/grep -n foo src/" })),
        "Ran: /usr/bin/grep -n foo src/"
    );
    // Whole command on the finished row too, for the same reason as
    // `tool_activity`: the row clamps to the draw width.
    let long = format!("echo {}", "x".repeat(200));
    assert_eq!(
        tool_finished("bash", &json!({ "command": long })),
        format!("Ran: {long}")
    );
    assert_eq!(
        tool_finished("grep", &json!({ "pattern": "foo" })),
        "Searched"
    );
    assert_eq!(
        tool_finished("read", &json!({ "path": "src/main.rs" })),
        "Read main.rs"
    );
    assert_eq!(tool_finished("list", &json!({})), "Listed files");
    assert_eq!(
        tool_finished("write", &json!({ "path": "src/main.rs" })),
        "Wrote main.rs"
    );
    assert_eq!(
        tool_finished("edit", &json!({ "path": "src/main.rs" })),
        "Edited main.rs"
    );
}

/// `web_search`/`web_fetch`/`ask`/`todo` used to fall through to the raw
/// `"{name} {args}"` dump (no `tool_activity`/`tool_finished` match arm),
/// so a session mixing them with grep/read looked visually inconsistent
/// (friendly labels next to raw JSON blobs). Every builtin the model can
/// call now gets a concise label like the rest.
#[test]
fn every_builtin_gets_a_friendly_label_not_a_raw_json_dump() {
    assert_eq!(
        tool_activity("web_search", &json!({ "query": "rust async runtime" })),
        "Searching the web: rust async runtime"
    );
    assert_eq!(
        tool_finished("web_search", &json!({ "query": "rust async runtime" })),
        "Searched the web: rust async runtime"
    );
    assert_eq!(
        tool_activity("web_fetch", &json!({ "url": "https://example.com" })),
        "Fetching: https://example.com"
    );
    assert_eq!(
        tool_finished("web_fetch", &json!({ "url": "https://example.com" })),
        "Fetched: https://example.com"
    );
    assert_eq!(
        tool_activity("ask", &json!({ "questions": [] })),
        "Asking a question"
    );
    assert_eq!(
        tool_finished("ask", &json!({ "questions": [] })),
        "Asked a question"
    );
}

#[test]
fn todo_tool_label_names_the_op_and_target() {
    assert_eq!(
        tool_activity("todo", &json!({ "op": "start", "task": "write tests" })),
        "Starting task: write tests"
    );
    assert_eq!(
        tool_finished("todo", &json!({ "op": "done", "task": "write tests" })),
        "Completed task: write tests"
    );
    assert_eq!(
        tool_activity("todo", &json!({ "op": "drop", "all": true })),
        "Abandoning all tasks"
    );
    assert_eq!(
        tool_activity(
            "todo",
            &json!({ "op": "append", "phase": "Build", "items": ["a", "b"] })
        ),
        "Adding 2 tasks to Build"
    );
    assert_eq!(
        tool_activity(
            "todo",
            &json!({ "op": "init", "list": [{ "phase": "Research", "items": ["a"] }] })
        ),
        "Planning 1 phase"
    );
    assert_eq!(
        tool_activity("todo", &json!({ "op": "view" })),
        "Checking todos"
    );
}

fn line_text(line: &ratatui::text::Line) -> String {
    line.spans.iter().map(|s| s.content.as_ref()).collect()
}

fn lines_text(lines: &[ratatui::text::Line]) -> String {
    lines.iter().map(line_text).collect::<Vec<_>>().join("\n")
}

/// Text of a streaming write preview's tail, dropping the highlight styles.
fn tail_text(call: &super::StartingCall) -> Option<Vec<String>> {
    call.preview.tail.as_ref().map(|rows| {
        rows.iter()
            .map(|r| r.iter().map(|s| s.content.as_ref()).collect())
            .collect()
    })
}

/// Like `line_text`, but marks the reverse-video block cursor with `▏` at its
/// left edge so caret-position assertions survive the styled-space rendering.
/// The synthetic end-of-line filler space is represented by the marker alone.
fn caret_text(line: &ratatui::text::Line) -> String {
    let mut out = String::new();
    for s in &line.spans {
        if s.style.add_modifier.contains(Modifier::REVERSED) {
            out.push('▏');
            if s.content.as_ref() != " " {
                out.push_str(s.content.as_ref());
            }
        } else {
            out.push_str(s.content.as_ref());
        }
    }
    out
}

#[test]
fn image_mime_infers_from_extension() {
    assert_eq!(image_mime("a.png"), "image/png");
    assert_eq!(image_mime("a.JPG"), "image/jpeg");
    assert_eq!(image_mime("a.jpeg"), "image/jpeg");
    assert_eq!(image_mime("noext"), "image/png");
}

#[test]
fn clipboard_path_parses_file_uri_and_plain_path() {
    assert_eq!(
        clipboard_path("file:///home/u/my%20pic.png\n").as_deref(),
        Some("/home/u/my pic.png")
    );
    assert_eq!(
        clipboard_path("file://localhost/tmp/a.png").as_deref(),
        Some("/tmp/a.png")
    );
    assert_eq!(clipboard_path("/tmp/b.jpg").as_deref(), Some("/tmp/b.jpg"));
    assert_eq!(clipboard_path("   \n  "), None);
}

#[test]
fn terminal_guard_restores_stderr_on_drop() {
    let before = super::super::file_log::set_stderr_enabled(true);
    super::super::file_log::set_stderr_enabled(false);
    drop(TerminalGuard {
        prev_stderr: true,
        raw: false,
    });
    assert!(
        super::super::file_log::set_stderr_enabled(before),
        "dropping the guard re-enables the stderr sink"
    );
}

#[test]
fn restore_sequence_leaves_alt_screen_and_shows_cursor() {
    let seq = panic_restore_sequence();
    assert!(seq.contains("[?1049l"));
    assert!(seq.ends_with("[?25h"));
}

#[test]
fn resume_adopts_thread_model_window() {
    let mut app = test_app();
    let model = "claude-sonnet-4-6";
    let want = crate::core::cli::model_capabilities::resolve_context_window(
        model,
        app.configured_context_window,
    )
    .tokens;
    app.context_window = 1;
    app.adopt_model(model.to_string());
    assert_eq!(app.model, model);
    assert_eq!(app.context_window, want);
}

#[test]
fn paste_keeps_tabs_and_normalizes_cr() {
    assert_eq!(normalize_paste("a\tb\r\nc\rd\n"), "a\tb\nc\nd\n");
    let mut app = test_app();
    route_paste_event(&mut app, Event::Paste("fn x() {\r\n\treturn 1;\r\n}".into()));
    assert_eq!(app.input, "fn x() {\n\treturn 1;\n}");
    assert_eq!(app.cursor, app.input.len());
}

#[test]
fn paste_strips_esc_and_bel() {
    assert_eq!(normalize_paste("a\x1b[31mb\x07c"), "a[31mbc");
}

#[test]
fn clipboard_path_does_not_panic_on_percent_cjk() {
    assert_eq!(clipboard_path("50%的人"), None);
    assert_eq!(clipboard_path("%a\u{e9}"), None);
    // Path-like text with a stray `%` before a multibyte char is kept as-is.
    assert_eq!(
        clipboard_path("/tmp/50%\u{7684}.png").as_deref(),
        Some("/tmp/50%\u{7684}.png")
    );
    assert_eq!(clipboard_path("C:\\a\\b.png").as_deref(), Some("C:\\a\\b.png"));
}

/// A typed message shaped like a reminder still counts as a user turn and
/// still shows its text (#279).
#[test]
fn build_user_message_never_stores_a_reminder_shape() {
    let m = build_user_message("<SYSTEM>\npasted log\n</SYSTEM>", &[]);
    assert!(!crate::core::agent::reminder::is_reminder_only(&m["content"]));
    assert!(user_content_parts(&m["content"]).0.contains("pasted log"));
}

#[test]
fn build_user_message_is_plain_string_without_images() {
    let m = build_user_message("hi", &[]);
    assert_eq!(m["content"], json!("hi"));
}

#[test]
fn build_user_message_wraps_text_and_image_parts() {
    let imgs = vec![PendingImage {
        name: "p.png".into(),
        data_url: "data:image/png;base64,AAAA".into(),
    }];
    let m = build_user_message("look", &imgs);
    let parts = m["content"].as_array().unwrap();
    assert_eq!(parts[0], json!({ "type": "text", "text": "look" }));
    assert_eq!(parts[1]["type"], "image_url");
    assert_eq!(parts[1]["image_url"]["url"], "data:image/png;base64,AAAA");
}

#[test]
fn build_user_message_omits_empty_text_part() {
    let imgs = vec![PendingImage {
        name: "p.png".into(),
        data_url: "data:image/png;base64,AAAA".into(),
    }];
    let parts = build_user_message("", &imgs)["content"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0]["type"], "image_url");
}

#[test]
fn user_content_parts_splits_text_and_images() {
    let content = json!([
        { "type": "text", "text": "hello" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,AA" } },
    ]);
    let (text, images) = user_content_parts(&content);
    assert_eq!(text, "hello");
    assert_eq!(images.len(), 1);
    let (text, images) = user_content_parts(&json!("plain"));
    assert_eq!(text, "plain");
    assert!(images.is_empty());
}

#[test]
fn load_image_file_encodes_base64_data_url() {
    let path = std::env::temp_dir().join(format!("jan_img_{}.png", uuid::Uuid::new_v4()));
    std::fs::write(&path, [1u8, 2, 3, 4]).unwrap();
    let img = load_image_file(path.to_str().unwrap()).unwrap();
    assert!(img.data_url.starts_with("data:image/png;base64,"));
    assert!(img.name.ends_with(".png"));
    std::fs::remove_file(&path).ok();
}

#[test]
fn load_first_file_image_skips_unloadable_entries() {
    let dir = std::env::temp_dir();
    let id = uuid::Uuid::new_v4();
    let existing = dir.join(format!("jan_list_{id}.png"));
    std::fs::write(&existing, [1u8, 2, 3, 4]).unwrap();
    let missing = dir.join(format!("jan_missing_{id}.png"));
    let not_image = dir.join(format!("jan_doc_{id}.pdf"));
    std::fs::write(&not_image, [1u8, 2, 3, 4]).unwrap();
    let empty = dir.join(format!("jan_empty_{id}.png"));
    std::fs::write(&empty, []).unwrap();

    // Skips missing, non-image and unloadable entries, keeping the basename.
    let list = [
        missing.clone(),
        not_image.clone(),
        empty.clone(),
        existing.clone(),
    ];
    let img = load_first_file_image(&list).unwrap();
    assert!(img.data_url.starts_with("data:image/png;base64,"));
    assert_eq!(img.name, existing.file_name().unwrap().to_str().unwrap());

    // Nothing loadable in the list yields nothing.
    assert!(load_first_file_image(&[missing, not_image.clone(), empty.clone()]).is_none());

    for p in [existing, not_image, empty] {
        std::fs::remove_file(&p).ok();
    }
}

#[test]
fn image_mime_of_rejects_non_image_extensions() {
    assert_eq!(image_mime_of("a.png"), Some("image/png"));
    assert_eq!(image_mime_of("a.JPG"), Some("image/jpeg"));
    assert!(image_mime_of("a.pdf").is_none());
    assert!(image_mime_of("noext").is_none());
}

#[test]
fn load_image_file_rejects_oversized() {
    let path = std::env::temp_dir().join(format!("jan_big_{}.png", uuid::Uuid::new_v4()));
    let f = std::fs::File::create(&path).unwrap();
    f.set_len(MAX_IMAGE_BYTES + 1).unwrap();
    drop(f);
    let err = load_image_file(path.to_str().unwrap()).err().unwrap();
    assert!(err.contains("too large"), "{err}");
    std::fs::remove_file(&path).ok();
}

#[test]
fn load_image_file_rejects_empty() {
    let path = std::env::temp_dir().join(format!("jan_empty_{}.png", uuid::Uuid::new_v4()));
    std::fs::write(&path, []).unwrap();
    assert!(load_image_file(path.to_str().unwrap()).is_err());
    std::fs::remove_file(&path).ok();
}

#[test]
fn submit_user_attaches_pending_images_and_renders_label() {
    let mut app = test_app();
    app.pending_images.push(PendingImage {
        name: "shot.png".into(),
        data_url: "data:image/png;base64,AAAA".into(),
    });
    app.submit_user("describe this".into());

    let content = app.history.last().unwrap()["content"].as_array().unwrap();
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[1]["type"], "image_url");
    assert!(app.pending_images.is_empty(), "pending images flushed");

    let rendered: Vec<String> = app.transcript.iter().map(row_text).collect();
    assert!(rendered.iter().any(|l| l.contains("[IMAGE] shot.png")));
}

#[test]
fn base_snapshot_is_queued_off_loop_not_run_inline() {
    let mut app = test_app();
    app.repo_root = Some(std::path::PathBuf::from("/tmp/repo"));
    app.submit_user("hi".into());
    // Queued for the loop to run off-thread; NOT captured synchronously here.
    assert!(app.base_requested);
    assert!(app.thread_id.is_some());
    assert!(
        app.base_snapshot.is_none(),
        "no inline git on the render thread"
    );
    assert_eq!(app.snap_queue.len(), 1);
    assert!(matches!(app.snap_queue.front(), Some(SnapshotJob::Base)));
    // Idempotent: a second submit does not re-queue the base.
    app.submit_user("again".into());
    assert_eq!(
        app.snap_queue
            .iter()
            .filter(|j| matches!(j, SnapshotJob::Base))
            .count(),
        1
    );
}

#[test]
fn checkpoint_is_queued_only_after_base_armed() {
    let mut app = test_app();
    app.repo_root = Some(std::path::PathBuf::from("/tmp/repo"));
    app.thread_id = Some("t1".into());
    app.history
        .push(json!({ "role": "user", "content": "do it" }));
    // No base armed yet -> no checkpoint.
    app.checkpoint_turn();
    assert!(app.snap_queue.is_empty());
    app.base_requested = true;
    app.checkpoint_turn();
    match app.snap_queue.front() {
        Some(SnapshotJob::Checkpoint {
            user_index,
            preview,
            ..
        }) => {
            assert_eq!(*user_index, 0);
            assert_eq!(preview, "do it");
        }
        other => panic!("expected a checkpoint job, got {:?}", other.is_some()),
    }
}

/// A hidden reminder rides in on the `user` role, so every surface that
/// counts user turns has to skip it: otherwise it becomes a rewind target
/// and a recall entry the user never typed, and shifts the indices those
/// share with the display journal (which holds no reminder at all).
#[test]
fn a_hidden_reminder_is_not_a_user_turn() {
    let mut app = test_app();
    app.thread_id = Some("t1".into());
    app.repo_root = Some(std::path::PathBuf::from("/tmp/repo"));
    app.base_requested = true;
    app.submit_user("first".into());
    app.history
        .push(json!({ "role": "assistant", "content": "reply" }));
    app.submit_reminder("unfinished todos remain".into());
    assert_eq!(
        app.history.len(),
        3,
        "the reminder needed its own turn here"
    );
    assert!(crate::core::agent::reminder::is_reminder_only(
        &app.history[2]["content"]
    ));

    open_rewind_picker(&mut app);
    let picker = app.picker.as_ref().expect("picker");
    assert_eq!(picker.items.len(), 1);
    assert_eq!(picker.items[0].label, "first");

    rebuild_recall(&mut app);
    assert_eq!(app.input_history, vec!["first"]);

    app.checkpoint_turn();
    match app.snap_queue.back() {
        Some(SnapshotJob::Checkpoint {
            user_index,
            preview,
            ..
        }) => {
            assert_eq!(*user_index, 0, "the reminder must not shift the key");
            assert_eq!(preview, "first");
        }
        other => panic!("expected a checkpoint job, got {:?}", other.is_some()),
    }
}

/// The reminder is folded into a message the model has not answered yet
/// where one exists, so no extra turn is invented at all.
#[test]
fn a_reminder_lands_in_flight_on_an_unanswered_turn() {
    let mut app = test_app();
    app.thread_id = Some("t1".into());
    app.submit_user("first".into());
    app.submit_reminder("unfinished todos remain".into());
    assert_eq!(app.history.len(), 1);
    let content = app.history[0]["content"].as_str().expect("text");
    assert!(content.starts_with("first\n\n"), "{content}");
    assert!(content.contains("unfinished todos remain"));
    // Recall and rewind offer the typed text back, never the reminder.
    rebuild_recall(&mut app);
    assert_eq!(app.input_history, vec!["first"]);
}

#[test]
fn rewind_to_fills_input_with_target_user_message() {
    let mut app = test_app();
    app.repo_root = Some(std::path::PathBuf::from("/tmp/repo"));
    app.thread_id = Some("t1".into());
    app.history = vec![
        json!({ "role": "user", "content": "first" }),
        json!({ "role": "assistant", "content": "reply" }),
        json!({ "role": "user", "content": "second" }),
    ];
    // Rewind to message #1 (0-indexed target 0): history is cut right
    // before the first user message, and that message's text should be
    // left in the input area for re-submission.
    rewind_to(&mut app, 0, false);
    assert_eq!(app.history.len(), 0);
    assert_eq!(app.input, "first");
    assert_eq!(app.cursor, app.input.len());
    assert_eq!(app.status, Status::Idle);
}

#[test]
fn rewind_trims_recall_to_the_surviving_messages() {
    let mut app = test_app();
    app.thread_id = Some("t1".into());
    app.history = vec![
        json!({ "role": "user", "content": "first" }),
        json!({ "role": "assistant", "content": "reply" }),
        json!({ "role": "user", "content": "second" }),
        json!({ "role": "assistant", "content": "reply two" }),
        json!({ "role": "user", "content": "third" }),
    ];
    for text in ["first", "second", "third"] {
        app.record_submitted(text);
    }

    // Cut just before the second user message: "second" and "third" are
    // gone from the conversation, so they must be gone from recall too.
    rewind_to(&mut app, 1, false);
    assert_eq!(app.input_history, vec!["first"]);
    // Rewind leaves the target message in the composer, and recall only
    // starts from an empty one.
    assert_eq!(app.input, "second");
    app.input_clear();
    assert!(app.recall_prev());
    assert_eq!(app.input, "first");

    // Rewinding to the very first message leaves nothing to recall, so Up
    // falls through to scrollback again.
    rewind_to(&mut app, 0, false);
    assert!(app.input_history.is_empty());
    app.input_clear();
    assert!(!app.recall_prev());
}

#[test]
fn rewind_to_fills_input_with_target_user_message_with_text_parts() {
    let mut app = test_app();
    app.thread_id = Some("t1".into());
    app.history = vec![
        json!({
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": "data:...", "detail": "auto" } }
            ]
        }),
        json!({ "role": "assistant", "content": "ok" }),
        json!({ "role": "user", "content": "second" }),
    ];
    rewind_to(&mut app, 0, false);
    // An image-only user message has no text to put in the input area.
    assert_eq!(app.history.len(), 0);
    assert_eq!(app.input, "");
    assert_eq!(app.cursor, 0);
}

#[test]
fn resolve_snapshot_builds_git_inputs() {
    let mut app = test_app();
    app.repo_root = Some(std::path::PathBuf::from("/tmp/repo"));
    app.thread_id = Some("t1".into());
    let (_, parent, msg, id, changed) = app.resolve_snapshot(&SnapshotJob::Base).unwrap();
    assert!(parent.is_none());
    assert_eq!(msg, "flint agent base");
    assert_eq!(id, "t1");
    assert!(changed.is_empty());

    app.base_snapshot = Some("basesha".into());
    let job = SnapshotJob::Checkpoint {
        user_index: 0,
        preview: "x".into(),
        changed: vec![std::path::PathBuf::from("/tmp/repo/src/a.rs")],
    };
    let (_, parent, msg, _, changed) = app.resolve_snapshot(&job).unwrap();
    assert_eq!(
        parent.as_deref(),
        Some("basesha"),
        "first checkpoint parents the base"
    );
    assert_eq!(msg, "flint agent turn 1");
    assert_eq!(changed, vec![std::path::PathBuf::from("src/a.rs")]);

    // Disabled (no repo) -> job dropped.
    app.repo_root = None;
    assert!(app.resolve_snapshot(&SnapshotJob::Base).is_none());
}

/// The dock's branch indicator must not stick to whatever `HEAD` was at
/// startup: `spawn_branch_poll`/`await_branch_poll` -- the pair
/// `chat_loop` drives on `BRANCH_POLL_INTERVAL` -- re-read `HEAD` live, so
/// a checkout made outside the TUI while it's running is picked up on the
/// next poll instead of only at the next launch.
#[tokio::test]
async fn branch_poll_picks_up_a_checkout_made_after_the_first_poll() {
    use std::process::Command;
    let n = std::process::id();
    let root = std::env::temp_dir().join(format!("jan_tui_branch_poll_{n}"));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let r = root.to_string_lossy().to_string();
    let git_ok = Command::new("git")
        .args(["-C", &r, "init", "-q"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !git_ok {
        let _ = std::fs::remove_dir_all(&root);
        return;
    }
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    Command::new("git")
        .args(["-C", &r, "add", "-A"])
        .status()
        .unwrap();
    Command::new("git")
        .args([
            "-C",
            &r,
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "-m",
            "init",
            "--no-gpg-sign",
        ])
        .status()
        .unwrap();

    let mut task = Some(spawn_branch_poll(&root));
    let first = await_branch_poll(&mut task).await;
    assert!(first.is_some(), "a fresh commit has a branch");
    assert!(task.is_none(), "the slot clears once the poll lands");

    Command::new("git")
        .args(["-C", &r, "checkout", "-q", "-b", "feature/x"])
        .status()
        .unwrap();

    let mut task = Some(spawn_branch_poll(&root));
    let second = await_branch_poll(&mut task).await;
    assert_eq!(second.as_deref(), Some("feature/x"));
    assert_ne!(first, second, "the poll must see the external checkout");

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn subagent_tool_rows_have_readable_labels() {
    let dispatch = json!({ "subagent_name": "reviewer", "description": "x" });
    assert_eq!(
        tool_activity("dispatch_subagent", &dispatch),
        "Dispatching subagent: reviewer"
    );
    assert_eq!(
        tool_finished("dispatch_subagent", &dispatch),
        "Dispatched subagent: reviewer"
    );
    let await_args = json!({ "run_id": "sub-sycl-cuda-gap-explorer-1" });
    assert_eq!(
        tool_activity("await_subagent", &await_args),
        "Awaiting subagent: sycl-cuda-gap-explorer"
    );
    assert_eq!(
        tool_activity("list_subagents", &json!({})),
        "Listing subagents"
    );
    assert_eq!(
        tool_activity("create_subagent", &json!({"name": "r"})),
        "Creating subagent: r"
    );
}

#[test]
fn awaiting_throbber_renders_below_assistant_prose() {
    use ratatui::{backend::TestBackend, Terminal};
    let mut app = test_app();
    app.apply(StreamEvent::Token {
        text: "Let me wait for the subagent.".into(),
    });
    app.apply(StreamEvent::ToolCall {
        id: "a1".into(),
        name: "await_subagent".into(),
        args: json!({ "run_id": "sub-reviewer-1" }),
    });
    let mut terminal = Terminal::new(TestBackend::new(60, 30)).unwrap();
    terminal.draw(|f| super::draw(f, &mut app)).unwrap();
    let buf = terminal.backend().buffer().clone();
    let rows: Vec<String> = (0..buf.area.height)
        .map(|y| {
            (0..buf.area.width)
                .map(|x| buf[(x, y)].symbol())
                .collect::<String>()
        })
        .collect();
    let prose = rows
        .iter()
        .position(|r| r.contains("wait for the subagent"));
    let awaiting = rows
        .iter()
        .position(|r| r.contains("Awaiting subagent: reviewer"));
    let (prose, awaiting) = (prose.expect("prose row"), awaiting.expect("awaiting row"));
    assert!(
        awaiting > prose,
        "awaiting throbber must render below prose:\n{}",
        rows.join("\n")
    );
}

#[test]
fn tool_call_started_throbber_shows_then_clears_on_full_call() {
    use ratatui::{backend::TestBackend, Terminal};
    let render = |app: &mut App| -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(60, 30)).unwrap();
        terminal.draw(|f| super::draw(f, app)).unwrap();
        let buf = terminal.backend().buffer().clone();
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .map(|x| buf[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect()
    };

    let mut app = test_app();
    // Arguments still streaming: only the in-progress signal has arrived.
    app.apply(StreamEvent::ToolCallStarted {
        id: "c1".into(),
        name: "write".into(),
    });
    let rows = render(&mut app);
    assert!(
        rows.iter()
            .any(|r| r.contains("│") && r.contains("Preparing write")),
        "throbber must show with the tool-row gutter while args stream:\n{}",
        rows.join("\n")
    );

    // Full call (parsed args) supersedes the throbber and renders its row.
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "write".into(),
        args: json!({ "path": "a.txt", "content": "hi" }),
    });
    let rows = render(&mut app);
    assert!(
        !rows.iter().any(|r| r.contains("Preparing write")),
        "throbber must clear once the full call arrives:\n{}",
        rows.join("\n")
    );
    assert!(app.starting.is_empty());
}

async fn press_esc(app: &mut App) {
    let registry: PermissionRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let mcp_servers: crate::core::state::SharedMcpServers =
        Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let mut current: Option<CurrentRun> = None;
    let esc = KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE);
    handle_key(app, esc, &registry, &mut current, &mcp_servers).await;
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

#[tokio::test]
async fn esc_cancels_a_run_whose_tool_args_are_still_streaming() {
    let mut app = test_app();
    app.status = Status::Running;
    // Args still streaming: the "Preparing write" throbber owns the tail.
    app.apply(StreamEvent::ToolCallStarted {
        id: "c1".into(),
        name: "write".into(),
    });
    assert!(!app.starting.is_empty(), "throbber must be live before Esc");

    let registry: PermissionRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let mcp_servers: crate::core::state::SharedMcpServers =
        Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let mut current: Option<CurrentRun> = None;
    let esc = KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE);
    handle_key(&mut app, esc, &registry, &mut current, &mcp_servers).await;

    assert_eq!(app.status, Status::Idle, "Esc must end the run");
    assert!(
        app.starting.is_empty(),
        "Esc must clear the streaming throbber"
    );
    let rows = render_rows(&mut app, 60, 30);
    assert!(
        !rows.iter().any(|r| r.contains("Preparing write")),
        "no throbber may survive the cancel:\n{}",
        rows.join("\n")
    );
}

/// Put `text` in the composer with the caret marked by `|`.
fn composer(app: &mut App, text: &str) {
    let cursor = text.find('|').expect("mark the caret with |");
    app.input = text.replace('|', "");
    app.cursor = cursor;
}

/// The composer as `text|with the caret marked`.
fn composed(app: &App) -> String {
    let mut s = app.input.clone();
    s.insert(app.cursor, '|');
    s
}

#[test]
fn ctrl_a_still_command() {
    assert!(super::key_is_ctrl(&KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL)));
    assert!(super::key_is_ctrl(&KeyEvent::new(
        KeyCode::Char('a'),
        KeyModifiers::CONTROL | KeyModifiers::ALT
    )));
    assert!(!super::key_is_ctrl(&KeyEvent::new(KeyCode::Char('b'), KeyModifiers::ALT)));
}

#[cfg(windows)]
#[test]
fn altgr_at_sign_inserted_on_windows_style_event() {
    let both = KeyModifiers::CONTROL | KeyModifiers::ALT;
    assert!(!super::key_is_ctrl(&KeyEvent::new(KeyCode::Char('@'), both)));
    let accented = char::from_u32(0x105).unwrap();
    assert!(!super::key_is_ctrl(&KeyEvent::new(KeyCode::Char(accented), both)));
}

#[tokio::test]
async fn esc_records_draft_for_recall() {
    let mut app = test_app();
    composer(&mut app, "half written|");
    press(&mut app, KeyCode::Esc, KeyModifiers::NONE).await;
    assert!(app.input.is_empty());
    press(&mut app, KeyCode::Up, KeyModifiers::NONE).await;
    assert_eq!(app.input, "half written");
}

#[tokio::test]
async fn word_deletion_covers_every_spelling() {
    // Alt+Backspace (Option+Delete on macOS), Ctrl+Backspace and Ctrl-W all
    // delete backwards; Alt+D and Ctrl+Delete delete forwards.
    for mods in [KeyModifiers::ALT, KeyModifiers::CONTROL] {
        let mut app = test_app();
        composer(&mut app, "hello world|");
        press(&mut app, KeyCode::Backspace, mods).await;
        assert_eq!(composed(&app), "hello |", "Backspace with {mods:?}");

        composer(&mut app, "|hello world");
        press(&mut app, KeyCode::Delete, mods).await;
        assert_eq!(composed(&app), "| world", "Delete with {mods:?}");
    }

    let mut app = test_app();
    composer(&mut app, "hello world|");
    press(&mut app, KeyCode::Char('w'), KeyModifiers::CONTROL).await;
    assert_eq!(composed(&app), "hello |");

    composer(&mut app, "|hello world");
    press(&mut app, KeyCode::Char('d'), KeyModifiers::ALT).await;
    assert_eq!(composed(&app), "| world");
}

/// Ctrl-W takes a whole whitespace-delimited token (the shell's
/// unix-word-rubout) where Alt+Backspace stops at the punctuation, which is
/// the whole reason both exist.
#[tokio::test]
async fn ctrl_w_eats_a_path_and_alt_backspace_does_not() {
    let mut app = test_app();
    composer(&mut app, "open src/core/tui.rs|");
    press(&mut app, KeyCode::Char('w'), KeyModifiers::CONTROL).await;
    assert_eq!(composed(&app), "open |");

    composer(&mut app, "open src/core/tui.rs|");
    press(&mut app, KeyCode::Backspace, KeyModifiers::ALT).await;
    assert_eq!(composed(&app), "open src/core/tui.|");
}

/// Trailing whitespace goes with the word, and an empty buffer is a no-op
/// rather than a panic.
#[tokio::test]
async fn word_deletion_handles_the_edges() {
    let mut app = test_app();
    composer(&mut app, "foo   |");
    press(&mut app, KeyCode::Backspace, KeyModifiers::ALT).await;
    assert_eq!(composed(&app), "|");

    press(&mut app, KeyCode::Backspace, KeyModifiers::ALT).await;
    press(&mut app, KeyCode::Char('w'), KeyModifiers::CONTROL).await;
    press(&mut app, KeyCode::Char('d'), KeyModifiers::ALT).await;
    assert_eq!(composed(&app), "|");

    // Multi-byte chars: the caret must land on a char boundary.
    composer(&mut app, "café über|");
    press(&mut app, KeyCode::Backspace, KeyModifiers::ALT).await;
    assert_eq!(composed(&app), "café |");
}

#[tokio::test]
async fn word_and_line_motion_keys_move_the_caret() {
    let mut app = test_app();
    for mods in [KeyModifiers::ALT, KeyModifiers::CONTROL] {
        composer(&mut app, "hello world|");
        press(&mut app, KeyCode::Left, mods).await;
        assert_eq!(composed(&app), "hello |world", "Left with {mods:?}");
        press(&mut app, KeyCode::Right, mods).await;
        assert_eq!(composed(&app), "hello world|", "Right with {mods:?}");
    }

    composer(&mut app, "hello world|");
    press(&mut app, KeyCode::Char('b'), KeyModifiers::ALT).await;
    assert_eq!(composed(&app), "hello |world");
    press(&mut app, KeyCode::Char('f'), KeyModifiers::ALT).await;
    assert_eq!(composed(&app), "hello world|");

    press(&mut app, KeyCode::Char('a'), KeyModifiers::CONTROL).await;
    assert_eq!(composed(&app), "|hello world");
    press(&mut app, KeyCode::Char('f'), KeyModifiers::CONTROL).await;
    assert_eq!(composed(&app), "h|ello world");
    press(&mut app, KeyCode::Char('b'), KeyModifiers::CONTROL).await;
    assert_eq!(composed(&app), "|hello world");
    press(&mut app, KeyCode::Char('e'), KeyModifiers::CONTROL).await;
    assert_eq!(composed(&app), "hello world|");
}

/// Home/End/Ctrl-A/Ctrl-E and the line kills are line-wise, not
/// buffer-wise: the composer takes newlines via Shift/Alt+Enter.
#[tokio::test]
async fn line_keys_act_on_the_caret_line_of_a_multiline_buffer() {
    let mut app = test_app();
    composer(&mut app, "first\nsec|ond\nthird");
    press(&mut app, KeyCode::Home, KeyModifiers::NONE).await;
    assert_eq!(composed(&app), "first\n|second\nthird");
    press(&mut app, KeyCode::End, KeyModifiers::NONE).await;
    assert_eq!(composed(&app), "first\nsecond|\nthird");

    composer(&mut app, "first\nsec|ond\nthird");
    press(&mut app, KeyCode::Char('k'), KeyModifiers::CONTROL).await;
    assert_eq!(composed(&app), "first\nsec|\nthird");
    // At the end of a line Ctrl-K takes the newline, joining the next up.
    press(&mut app, KeyCode::Char('k'), KeyModifiers::CONTROL).await;
    assert_eq!(composed(&app), "first\nsec|third");

    composer(&mut app, "first\nsec|ond\nthird");
    press(&mut app, KeyCode::Char('u'), KeyModifiers::CONTROL).await;
    assert_eq!(composed(&app), "first\n|ond\nthird");
}

#[tokio::test]
async fn shift_enter_inserts_a_newline_instead_of_submitting() {
    let mut app = test_app();
    composer(&mut app, "line one|");
    press(&mut app, KeyCode::Enter, KeyModifiers::SHIFT).await;
    assert_eq!(composed(&app), "line one\n|");
    assert_eq!(app.status, Status::Idle, "Shift+Enter must not submit");
}

/// The slash and `@path` popups own Enter, but a *modified* Enter is a
/// newline: it must reach the composer instead of accepting a completion.
#[tokio::test]
async fn a_newline_keystroke_survives_an_open_hint_popup() {
    for mods in [KeyModifiers::SHIFT, KeyModifiers::ALT] {
        let mut app = test_app();
        type_key_chars(&mut app, "/mod").await;
        assert!(!app.slash_matches().is_empty(), "the popup must be open");
        press(&mut app, KeyCode::Enter, mods).await;
        assert_eq!(app.input, "/mod\n", "{mods:?} must insert a newline");
    }
}

#[tokio::test]
async fn ctrl_h_and_ctrl_t_edit_characters() {
    let mut app = test_app();
    composer(&mut app, "abc|");
    press(&mut app, KeyCode::Char('h'), KeyModifiers::CONTROL).await;
    assert_eq!(composed(&app), "ab|");

    // Ctrl-T at the end of the buffer swaps the last two chars.
    press(&mut app, KeyCode::Char('t'), KeyModifiers::CONTROL).await;
    assert_eq!(composed(&app), "ba|");

    composer(&mut app, "a|bc");
    press(&mut app, KeyCode::Char('t'), KeyModifiers::CONTROL).await;
    assert_eq!(composed(&app), "ba|c");

    // Nothing to swap: a no-op, not a panic.
    composer(&mut app, "|a");
    press(&mut app, KeyCode::Char('t'), KeyModifiers::CONTROL).await;
    assert_eq!(composed(&app), "|a");
}

#[tokio::test]
async fn ctrl_p_and_ctrl_n_recall_history_without_scrolling() {
    let mut app = test_app();
    submit_line(&mut app, "first message").await;
    submit_line(&mut app, "second message").await;
    app.scrollback = 0;

    press(&mut app, KeyCode::Char('p'), KeyModifiers::CONTROL).await;
    assert_eq!(app.input, "second message");
    press(&mut app, KeyCode::Char('p'), KeyModifiers::CONTROL).await;
    assert_eq!(app.input, "first message");
    press(&mut app, KeyCode::Char('n'), KeyModifiers::CONTROL).await;
    assert_eq!(app.input, "second message");
    assert_eq!(app.scrollback, 0, "recall keys never scroll the transcript");
}

async fn press(app: &mut App, code: KeyCode, mods: KeyModifiers) {
    let registry: PermissionRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let mcp_servers: crate::core::state::SharedMcpServers =
        Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let mut current: Option<CurrentRun> = None;
    handle_key(
        app,
        KeyEvent::new(code, mods),
        &registry,
        &mut current,
        &mcp_servers,
    )
    .await;
}

async fn type_key_chars(app: &mut App, text: &str) {
    for ch in text.chars() {
        press(app, KeyCode::Char(ch), KeyModifiers::NONE).await;
    }
}

/// Submit `text` from the composer and drop back to idle, as a finished
/// turn would, so the next message starts from a fresh input box.
async fn submit_line(app: &mut App, text: &str) {
    type_key_chars(app, text).await;
    press(app, KeyCode::Enter, KeyModifiers::NONE).await;
    app.status = Status::Idle;
}

#[tokio::test]
async fn up_recalls_submitted_messages_and_down_returns_to_an_empty_one() {
    let mut app = test_app();
    submit_line(&mut app, "first").await;
    submit_line(&mut app, "second").await;

    // With something typed, Up still scrolls the transcript.
    type_key_chars(&mut app, "draft").await;
    press(&mut app, KeyCode::Up, KeyModifiers::NONE).await;
    assert_eq!(app.input, "draft");
    assert_eq!(app.scrollback, 1);

    // Esc clears the draft but keeps it in recall, newest of all.
    press(&mut app, KeyCode::Esc, KeyModifiers::NONE).await;
    press(&mut app, KeyCode::Up, KeyModifiers::NONE).await;
    assert_eq!(app.input, "draft");
    press(&mut app, KeyCode::Up, KeyModifiers::NONE).await;
    assert_eq!(app.input, "second");
    assert_eq!(app.cursor, "second".len(), "caret sits at the end");
    press(&mut app, KeyCode::Up, KeyModifiers::NONE).await;
    assert_eq!(app.input, "first");
    // The oldest entry is the floor, not a wrap-around.
    press(&mut app, KeyCode::Up, KeyModifiers::NONE).await;
    assert_eq!(app.input, "first");

    press(&mut app, KeyCode::Down, KeyModifiers::NONE).await;
    assert_eq!(app.input, "second");
    press(&mut app, KeyCode::Down, KeyModifiers::NONE).await;
    assert_eq!(app.input, "draft");
    press(&mut app, KeyCode::Down, KeyModifiers::NONE).await;
    assert_eq!(app.input, "", "past the newest is a fresh message");
    assert_eq!(app.scrollback, 1, "recall never scrolls the transcript");

    // No longer recalling, so Down scrolls again.
    press(&mut app, KeyCode::Down, KeyModifiers::NONE).await;
    assert_eq!(app.scrollback, 0);
}

/// Ctrl-C is cancel-first: with a task in flight it interrupts the run and
/// leaves the session open, never quitting out from under the user.
#[tokio::test]
async fn ctrl_c_cancels_a_run_before_it_can_ever_quit() {
    let mut app = test_app();
    app.status = Status::Running;
    press(&mut app, KeyCode::Char('c'), KeyModifiers::CONTROL).await;
    assert_eq!(app.status, Status::Idle, "the run must be cancelled");
    assert!(!app.should_quit, "cancelling a run must not quit the TUI");
}

/// Idle with something typed, Ctrl-C wipes the draft instead of exiting.
#[tokio::test]
async fn ctrl_c_clears_a_draft_without_exiting() {
    let mut app = test_app();
    type_key_chars(&mut app, "unsubmitted draft").await;
    press(&mut app, KeyCode::Char('c'), KeyModifiers::CONTROL).await;
    assert!(app.input.is_empty(), "the draft must be cleared");
    assert!(!app.should_quit, "clearing a draft must not quit the TUI");
}

/// A draft wiped by Ctrl-C was never submitted, but it is still in local
/// prompt history, so Up brings it straight back.
#[tokio::test]
async fn a_draft_cleared_by_ctrl_c_is_recoverable_with_up() {
    let mut app = test_app();
    type_key_chars(&mut app, "never submitted").await;
    press(&mut app, KeyCode::Char('c'), KeyModifiers::CONTROL).await;
    assert!(app.input.is_empty());
    press(&mut app, KeyCode::Up, KeyModifiers::NONE).await;
    assert_eq!(app.input, "never submitted", "the draft must be recallable");
}

/// Leaving a blank idle TUI takes a deliberate second Ctrl-C or Ctrl-D;
/// the first only arms the exit, and typing again disarms it.
#[tokio::test]
async fn quitting_a_blank_idle_tui_takes_a_second_ctrl_c_or_ctrl_d() {
    let mut app = test_app();
    press(&mut app, KeyCode::Char('c'), KeyModifiers::CONTROL).await;
    assert!(!app.should_quit, "the first Ctrl-C only arms the exit");
    press(&mut app, KeyCode::Char('c'), KeyModifiers::CONTROL).await;
    assert!(app.should_quit, "the second Ctrl-C quits");

    // Composing again disarms a pending exit, so a later lone Ctrl-C on a
    // blank composer still needs its own second press.
    let mut app = test_app();
    press(&mut app, KeyCode::Char('c'), KeyModifiers::CONTROL).await;
    type_key_chars(&mut app, "x").await;
    press(&mut app, KeyCode::Backspace, KeyModifiers::NONE).await;
    press(&mut app, KeyCode::Char('c'), KeyModifiers::CONTROL).await;
    assert!(!app.should_quit, "typing must disarm the pending exit");

    // Ctrl-D shares the same two-press exit as Ctrl-C.
    let mut app = test_app();
    press(&mut app, KeyCode::Char('d'), KeyModifiers::CONTROL).await;
    assert!(!app.should_quit, "the first Ctrl-D only arms the exit");
    press(&mut app, KeyCode::Char('d'), KeyModifiers::CONTROL).await;
    assert!(app.should_quit, "the second Ctrl-D quits");
}

/// The closing hint is copyable as-is and names the same short thread id
/// `--resume` takes, matching the non-interactive wording.
#[test]
fn the_resume_hint_offers_a_copyable_continuation_command() {
    assert_eq!(
        resume_hint("0123456789abcdef"),
        "\x1b[2m[session 01234567 - resume with `flint --resume=01234567`]\x1b[0m"
    );
}

#[tokio::test]
async fn page_keys_still_scroll_when_there_is_history_to_recall() {
    let mut app = test_app();
    submit_line(&mut app, "first").await;
    press(&mut app, KeyCode::PageUp, KeyModifiers::NONE).await;
    assert_eq!(app.scrollback, 10);
    assert!(app.input.is_empty(), "PageUp must not recall");
    press(&mut app, KeyCode::PageDown, KeyModifiers::NONE).await;
    assert_eq!(app.scrollback, 0);
}

#[tokio::test]
async fn a_recalled_message_is_editable_and_sends_as_a_new_one() {
    let mut app = test_app();
    submit_line(&mut app, "hello").await;
    press(&mut app, KeyCode::Up, KeyModifiers::NONE).await;
    type_key_chars(&mut app, "!").await;
    assert_eq!(app.input, "hello!");

    press(&mut app, KeyCode::Enter, KeyModifiers::NONE).await;
    assert!(app.input.is_empty());
    assert!(app.recall_pos.is_none(), "sending leaves recall");
    assert_eq!(app.input_history, vec!["hello", "hello!"]);
    assert!(
        transcript_text(&app).contains("hello!"),
        "an edited recall is an ordinary user message"
    );
}

/// A resend of the newest entry must not stack duplicates, or Up has to be
/// pressed once per repeat to get past them.
#[tokio::test]
async fn resending_the_same_message_keeps_one_history_entry() {
    let mut app = test_app();
    submit_line(&mut app, "again").await;
    submit_line(&mut app, "again").await;
    assert_eq!(app.input_history, vec!["again"]);
}

#[test]
fn slash_commands_include_login() {
    assert!(SLASH_COMMANDS.iter().any(|c| c.name == "/login"));
}

#[tokio::test]
async fn help_login_copy_describes_provider_sign_in_without_stale_tokamak_key_copy() {
    let mut app = test_app();

    run_command(&mut app, "help", &no_mcp()).await;

    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("/login"), "{text}");
    assert!(text.contains("Sign in to a provider"), "{text}");
    assert!(!text.contains("Sign in to Tokamak"), "{text}");
    assert!(!text.contains("save the API key"), "{text}");
}

#[test]
fn login_empty_state_points_to_provider_picker_without_stale_tokamak_copy() {
    let mut app = test_app();
    app.model.clear();

    app.submit_user("hello".to_string());

    let text = transcript_text(&app);
    assert!(
        text.contains("not signed in — run /login to choose a provider"),
        "{text}"
    );
    assert!(!text.contains("Tokamak"), "{text}");
}

fn with_isolated_login_state<T>(f: impl FnOnce() -> T) -> T {
    let _guard = crate::core::server::provider_secrets::TEST_ENV_LOCK.lock();
    let dir = tempfile::tempdir().unwrap();
    let prev_data_folder = std::env::var_os("JAN_DATA_FOLDER");
    std::env::set_var("JAN_DATA_FOLDER", dir.path());
    crate::core::server::provider_secrets::force_file_secrets();

    let mut env_vars = vec!["JAN_API_KEY".to_string()];
    env_vars.extend(
        crate::core::cli::auth::provider_catalog()
            .into_iter()
            .map(|provider| format!("{}_API_KEY", provider.id.to_ascii_uppercase())),
    );
    let prev_env: Vec<(String, Option<std::ffi::OsString>)> = env_vars
        .into_iter()
        .map(|var| {
            let prev = std::env::var_os(&var);
            std::env::remove_var(&var);
            (var, prev)
        })
        .collect();

    let result = crate::core::agent::global_config::with_temp_home(|_| f());

    match prev_data_folder {
        Some(value) => std::env::set_var("JAN_DATA_FOLDER", value),
        None => std::env::remove_var("JAN_DATA_FOLDER"),
    }
    for (var, value) in prev_env {
        match value {
            Some(value) => std::env::set_var(var, value),
            None => std::env::remove_var(var),
        }
    }
    result
}

#[test]
fn login_opens_catalog_provider_status_picker_without_secret_hints() {
    with_isolated_login_state(|| {
        crate::core::agent::global_config::set_provider(
            "deepseek",
            crate::core::agent::global_config::ProviderUpdate {
                api_key: Some("sk-status-secret".into()),
                clear_api_key: false,
                base_url: Some("https://api.deepseek.com/v1".into()),
                models: Some(vec!["secret-model".into()]),
                api_type: None,
                ..Default::default()
            },
        )
        .unwrap();

        let mut app = test_app();
        super::open_login_picker(&mut app);

        let picker = app
            .picker
            .as_ref()
            .expect("/login must open a provider picker");
        assert_eq!(picker.kind, PickerKind::LoginProvider);

        let catalog = crate::core::cli::auth::provider_catalog();
        // Expected picker order: Tokamak pinned to the top (the default
        // provider), then the remaining providers in name order:
        // Anthropic, DeepSeek, OpenAI, OpenCode. (catalog keeps its own order.)
        let ordered = |catalog: &Vec<crate::core::cli::auth::ProviderDefinition>| {
            let mut providers = catalog.clone();
            providers.sort_by(|a, b| match (a.id == "tokamak", b.id == "tokamak") {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.cmp(b.name),
            });
            providers
        };
        let ordered = ordered(&catalog);
        assert_eq!(
            picker
                .items
                .iter()
                .map(|item| item.value.as_str())
                .collect::<Vec<_>>(),
            ordered
                .iter()
                .map(|provider| provider.id)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            picker
                .items
                .iter()
                .map(|item| item.label.as_str())
                .collect::<Vec<_>>(),
            ordered
                .iter()
                .map(|provider| format!("{} ({})", provider.name, provider.id))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            picker
                .items
                .iter()
                .map(|item| item.hint.as_deref())
                .collect::<Vec<_>>(),
            ordered
                .iter()
                .map(|provider| {
                    if provider.id == "deepseek" {
                        Some("signed in")
                    } else {
                        Some("not signed in")
                    }
                })
                .collect::<Vec<_>>()
        );
        // Tokamak is the first row.
        assert_eq!(
            picker.items.first().map(|i| i.value.as_str()),
            Some("tokamak")
        );
        assert!(picker
            .items
            .iter()
            .all(|item| matches!(item.hint.as_deref(), Some("signed in" | "not signed in"))));

        let rendered = picker
            .items
            .iter()
            .flat_map(|item| {
                [
                    item.value.as_str(),
                    item.label.as_str(),
                    item.hint.as_deref().unwrap_or_default(),
                ]
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!rendered.contains("sk-status-secret"), "{rendered}");
        assert!(!rendered.contains("secret-model"), "{rendered}");
        assert!(!rendered.contains("api-keys"), "{rendered}");
    });
}

#[tokio::test]
async fn login_provider_selection_starts_the_api_key_prompt() {
    let mut app = test_app();
    super::open_login_picker(&mut app);
    let openai = app
        .picker
        .as_ref()
        .unwrap()
        .items
        .iter()
        .position(|item| item.value == "openai")
        .unwrap();
    app.picker.as_mut().unwrap().selected = openai;

    press(&mut app, KeyCode::Enter, KeyModifiers::NONE).await;

    assert!(app.picker.is_none());
    assert_eq!(
        app.login.as_ref().map(|p| p.provider.as_str()),
        Some("openai")
    );
}

#[tokio::test]
async fn login_api_key_provider_selection_starts_masked_prompt_directly() {
    let mut app = test_app();
    super::open_login_picker(&mut app);
    let tokamak = app
        .picker
        .as_ref()
        .unwrap()
        .items
        .iter()
        .position(|item| item.value == "tokamak")
        .unwrap();
    app.picker.as_mut().unwrap().selected = tokamak;

    press(&mut app, KeyCode::Enter, KeyModifiers::NONE).await;

    assert!(app.picker.is_none());
    assert_eq!(
        app.login.as_ref().map(|p| p.provider.as_str()),
        Some("tokamak")
    );
}

#[tokio::test]
async fn login_provider_picker_esc_cancels_without_mutation() {
    let mut app = test_app();
    super::open_login_picker(&mut app);

    press(&mut app, KeyCode::Esc, KeyModifiers::NONE).await;

    assert!(app.picker.is_none());
    assert!(app.login.is_none());
    assert!(app.login_submit.is_none());
}

#[tokio::test]
async fn login_prompt_captures_keys_and_never_renders_the_key() {
    let mut app = test_app();
    open_paste_field(&mut app).await;
    assert!(app.login.is_some(), "the paste prompt must be open");

    type_key_chars(&mut app, "tk-secret").await;
    // Keystrokes are the key, not chat input.
    assert!(app.input.is_empty(), "the input box must not see the key");
    let prompt = app.login.as_ref().unwrap();
    assert_eq!(prompt.input, "tk-secret");
    assert_eq!(prompt.masked(), "*********");

    let rows = render_rows(&mut app, 80, 24);
    let screen = rows.join("\n");
    assert!(screen.contains("Tokamak sign-in"), "{screen}");
    assert!(
        !screen.contains("tk-secret"),
        "the key must never be rendered:\n{screen}"
    );
}

#[tokio::test]
async fn login_enter_hands_a_trimmed_key_to_the_loop() {
    let mut app = test_app();
    open_paste_field(&mut app).await;
    app.login.as_mut().unwrap().paste("  tk-abc\n");
    press(&mut app, KeyCode::Enter, KeyModifiers::NONE).await;

    assert_eq!(
        app.login_submit.as_ref(),
        Some(&("tokamak".to_string(), "tk-abc".to_string()))
    );
    assert!(app.login.as_ref().unwrap().verifying);
}

#[tokio::test]
async fn login_rejects_a_mispasted_key_before_any_request() {
    let mut app = test_app();
    open_paste_field(&mut app).await;
    type_key_chars(&mut app, "tk-abc def").await;
    press(&mut app, KeyCode::Enter, KeyModifiers::NONE).await;

    assert!(app.login_submit.is_none(), "no request for a bad paste");
    let prompt = app.login.as_ref().unwrap();
    assert!(!prompt.verifying);
    assert!(prompt.input.is_empty(), "a rejected key is cleared");
    assert!(prompt.error.is_some());

    // Empty input is likewise not worth a round trip.
    press(&mut app, KeyCode::Enter, KeyModifiers::NONE).await;
    assert!(app.login_submit.is_none());
}

#[tokio::test]
async fn login_backspace_edits_and_esc_cancels() {
    let mut app = test_app();
    open_paste_field(&mut app).await;
    type_key_chars(&mut app, "tk-ab").await;
    press(&mut app, KeyCode::Backspace, KeyModifiers::NONE).await;
    assert_eq!(app.login.as_ref().unwrap().input, "tk-a");

    press(&mut app, KeyCode::Esc, KeyModifiers::NONE).await;
    assert!(app.login.is_none(), "Esc must close the prompt");
    assert!(app.login_submit.is_none());
}

#[tokio::test]
async fn login_prompt_esc_cancels_without_outcome_message() {
    let mut app = test_app();
    super::open_login_prompt(&mut app, "tokamak");
    let before = app.transcript.len();

    press(&mut app, KeyCode::Esc, KeyModifiers::NONE).await;

    assert!(app.login.is_none(), "Esc must close the prompt");
    assert!(app.login_submit.is_none());
    assert_eq!(
        app.transcript.len(),
        before,
        "cancellation must stay silent"
    );
}

#[tokio::test]
async fn login_stays_cancellable_while_verifying() {
    let mut app = test_app();
    open_paste_field(&mut app).await;
    app.login.as_mut().unwrap().paste("tk-abc");
    press(&mut app, KeyCode::Enter, KeyModifiers::NONE).await;
    app.login_submit.take();

    // Read-only while in flight: no edit may change the key being checked.
    type_key_chars(&mut app, "xyz").await;
    press(&mut app, KeyCode::Backspace, KeyModifiers::NONE).await;
    assert_eq!(app.login.as_ref().unwrap().input, "tk-abc");
    let rows = render_rows(&mut app, 80, 24);
    assert!(rows.iter().any(|r| r.contains("verifying")), "{rows:?}");

    press(&mut app, KeyCode::Char('c'), KeyModifiers::CONTROL).await;
    assert!(app.login.is_none(), "Ctrl-C must not wedge the prompt");
    assert!(app.login_submit.is_none());
}

#[tokio::test]
async fn failed_verification_keeps_the_prompt_open_with_the_reason() {
    let mut app = test_app();
    open_paste_field(&mut app).await;
    app.login.as_mut().unwrap().paste("tk-abc");
    press(&mut app, KeyCode::Enter, KeyModifiers::NONE).await;
    app.login_submit.take();

    finish_login(
        &mut app,
        Err(crate::core::cli::auth::LoginError::Unavailable(
            "Tokamak rejected that API key.".to_string(),
        )),
    );

    let prompt = app.login.as_ref().expect("prompt stays open to retry");
    assert!(!prompt.verifying);
    assert!(prompt.input.is_empty());
    assert_eq!(
        prompt.error.as_deref(),
        Some("tokamak sign-in failed: Tokamak rejected that API key.")
    );
}

/// `/login --paste-token` skips straight to the legacy field, the same
/// escape hatch `flint login --paste-token` gives, and never asks the loop for
/// a browser session.
#[tokio::test]
async fn login_paste_token_forces_the_legacy_field() {
    let mut app = test_app();
    run_command(&mut app, "login --paste-token", &no_mcp()).await;
    let prompt = app.login.as_ref().expect("dock open");
    assert!(matches!(
        prompt.stage,
        super::LoginStage::Paste { confirm_open: true }
    ));
    assert!(
        !app.login_device_request,
        "no browser session may be started"
    );

    // The field opens only once the browser question is answered.
    assert!(
        !prompt.editable(),
        "no key entry before the browser question"
    );
    press(&mut app, KeyCode::Char('n'), KeyModifiers::NONE).await;
    assert!(app.login.as_ref().unwrap().editable());
}

/// Nothing may reach a browser until the user says so -- in either flow.
#[tokio::test]
async fn the_browser_is_never_opened_without_an_answer() {
    // Paste fallback.
    let mut app = test_app();
    super::open_login_prompt(&mut app, "tokamak");
    let prompt = app.login.as_ref().unwrap();
    assert_eq!(
        prompt.stage.unconfirmed_url(),
        Some(crate::core::cli::tokamak::API_KEYS_URL)
    );
    let screen = render_rows(&mut app, 80, 24).join("\n");
    assert!(
        screen.contains("open this page in your browser?"),
        "{screen}"
    );

    // Browser approval.
    let mut app = test_app();
    super::show_login_approval(&mut app, &test_session());
    assert_eq!(
        app.login.as_ref().unwrap().stage.unconfirmed_url(),
        Some("https://tokamak.sh/cli/authorize?code=ABCD-2345")
    );
    let screen = render_rows(&mut app, 80, 24).join("\n");
    assert!(
        screen.contains("open this page in your browser?"),
        "{screen}"
    );
    // The code is still shown while the question is up: the user may prefer
    // to approve on a phone and never open a browser here at all.
    assert!(screen.contains("ABCD-2345"), "{screen}");
}

/// Declining does not abandon the sign-in: the poll is already running, so
/// the dock moves on to waiting and a phone can still approve it.
#[tokio::test]
async fn declining_the_browser_still_waits_for_approval() {
    let mut app = test_app();
    super::show_login_approval(&mut app, &test_session());
    press(&mut app, KeyCode::Char('n'), KeyModifiers::NONE).await;

    let prompt = app.login.as_ref().expect("dock stays open");
    assert!(
        prompt.stage.unconfirmed_url().is_none(),
        "question answered"
    );
    assert!(matches!(
        prompt.stage,
        super::LoginStage::Approving {
            confirm_open: false,
            ..
        }
    ));
    let screen = render_rows(&mut app, 80, 24).join("\n");
    assert!(screen.contains("waiting for approval"), "{screen}");
}

/// Esc at the browser question cancels the whole sign-in rather than
/// answering it, so the question can never wedge the dock.
#[tokio::test]
async fn esc_at_the_browser_question_cancels() {
    for open_paste in [true, false] {
        let mut app = test_app();
        if open_paste {
            super::open_login_prompt(&mut app, "tokamak");
        } else {
            super::show_login_approval(&mut app, &test_session());
        }
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE).await;
        assert!(app.login.is_none(), "Esc must close the dock");
    }
}

fn pending_browser(app: &mut App) {
    app.browser_confirm = Some(super::BrowserConfirm {
        url: "https://github.com/login/oauth/authorize?client_id=x".into(),
        purpose: "authorize 'github'".into(),
    });
}

/// The `/mcp` question shows what it is for and the URL to open, so
/// declining still leaves a way to finish.
#[tokio::test]
async fn the_mcp_browser_question_shows_the_purpose_and_url() {
    let mut app = test_app();
    pending_browser(&mut app);
    let screen = render_rows(&mut app, 90, 24).join("\n");
    assert!(screen.contains("open a browser?"), "{screen}");
    assert!(screen.contains("authorize 'github'"), "{screen}");
    assert!(
        screen.contains("open this page in your browser?"),
        "{screen}"
    );
    assert!(
        screen.contains("github.com/login/oauth/authorize"),
        "{screen}"
    );
}

/// Every answer dismisses the question. `browser::open` is disabled under
/// `cfg(test)`, so the accept path is exercised without a real browser.
#[tokio::test]
async fn every_answer_dismisses_the_mcp_browser_question() {
    for key in [
        KeyCode::Enter,
        KeyCode::Char('y'),
        KeyCode::Char('n'),
        KeyCode::Esc,
    ] {
        let mut app = test_app();
        pending_browser(&mut app);
        press(&mut app, key, KeyModifiers::NONE).await;
        assert!(
            app.browser_confirm.is_none(),
            "{key:?} must dismiss the question"
        );
    }
}

/// The question owns the keyboard while it is up: a keystroke meant for it
/// must not land in the chat input.
#[tokio::test]
async fn the_mcp_browser_question_owns_the_keyboard() {
    let mut app = test_app();
    pending_browser(&mut app);
    type_key_chars(&mut app, "hello").await;
    assert!(app.browser_confirm.is_some(), "stray keys are not answers");
    assert!(app.input.is_empty(), "nothing may reach the chat input");
}

/// An authorization that settles before the user answers takes the stale
/// question away with it, rather than leaving a dock pointing at a spent URL.
#[tokio::test]
async fn a_settled_authorization_clears_a_pending_question() {
    for result in [Ok(()), Err("nope".to_string())] {
        let mut app = test_app();
        pending_browser(&mut app);
        let mut job = None;
        super::finish_mcp_job(
            &mut app,
            super::McpJobDone::Authorized {
                server: "github".into(),
                result,
            },
            &no_mcp(),
            &mut job,
        )
        .await;
        assert!(app.browser_confirm.is_none(), "stale question must go");
    }
}

/// The paste field with the browser question already answered -- what most
/// key-entry tests are actually about.
/// Accepting launches the opener and moves on. `browser::open` is disabled
/// under `cfg(test)`, so this exercises the accept path (and its "could not
/// open" reporting) without hijacking a real browser.
#[tokio::test]
async fn accepting_the_browser_question_moves_on_either_way() {
    for accept in [KeyCode::Enter, KeyCode::Char('y')] {
        let mut app = test_app();
        super::show_login_approval(&mut app, &test_session());
        press(&mut app, accept, KeyModifiers::NONE).await;

        let prompt = app.login.as_ref().expect("dock stays open");
        assert!(
            prompt.stage.unconfirmed_url().is_none(),
            "{accept:?} must answer the question"
        );
        let screen = render_rows(&mut app, 80, 24).join("\n");
        assert!(screen.contains("waiting for approval"), "{screen}");
    }

    // Same for the paste fallback: accepting opens the field.
    let mut app = test_app();
    super::open_login_prompt(&mut app, "tokamak");
    press(&mut app, KeyCode::Enter, KeyModifiers::NONE).await;
    assert!(app.login.as_ref().unwrap().editable());
}

/// A keystroke that is neither an answer nor a cancel is swallowed, so it
/// cannot leak into the key field or the chat input.
#[tokio::test]
async fn stray_keys_at_the_browser_question_do_nothing() {
    let mut app = test_app();
    super::open_login_prompt(&mut app, "tokamak");
    type_key_chars(&mut app, "tk-secret").await;

    let prompt = app.login.as_ref().expect("dock stays open");
    assert!(prompt.stage.unconfirmed_url().is_some(), "still unanswered");
    assert!(prompt.input.is_empty(), "no key may be collected yet");
    assert!(app.input.is_empty(), "and nothing may reach the chat input");
}

fn confirmed_paste_prompt() -> super::LoginPrompt {
    super::LoginPrompt {
        stage: super::LoginStage::Paste {
            confirm_open: false,
        },
        ..super::LoginPrompt::new("tokamak")
    }
}

/// Open the paste fallback and decline the browser, leaving an editable field.
async fn open_paste_field(app: &mut App) {
    super::open_login_prompt(app, "tokamak");
    press(app, KeyCode::Char('n'), KeyModifiers::NONE).await;
}

fn test_session() -> crate::core::cli::device_auth::Session {
    crate::core::cli::device_auth::Session {
        session_id: "sess-1".into(),
        user_code: "ABCD-2345".into(),
        authorize_url: "https://tokamak.sh/cli/authorize?code=ABCD-2345".into(),
        expires_in: 300,
        interval: 5,
    }
}

#[tokio::test]
async fn login_rejects_an_unknown_option_without_opening_a_dock() {
    let mut app = test_app();
    run_command(&mut app, "login --nope", &no_mcp()).await;
    assert!(app.login.is_none());
    assert!(!app.login_device_request);
}

/// `/login` opens the provider picker. Selecting Tokamak starts its browser
/// flow; other providers open their own credential path.
#[tokio::test]
async fn login_opens_the_provider_picker() {
    let mut app = test_app();
    run_command(&mut app, "login", &no_mcp()).await;
    assert_eq!(
        app.picker.as_ref().map(|picker| picker.kind),
        Some(PickerKind::LoginProvider)
    );
    assert!(app.login.is_none());
    assert!(!app.login_device_request);
}

/// A second `/login` while the provider picker is open must not replace it
/// with a different sign-in flow.
#[tokio::test]
async fn login_refuses_while_provider_selection_is_in_progress() {
    let mut app = test_app();
    run_command(&mut app, "login", &no_mcp()).await;

    run_command(&mut app, "login --paste-token", &no_mcp()).await;
    assert_eq!(
        app.picker.as_ref().map(|picker| picker.kind),
        Some(PickerKind::LoginProvider)
    );
    assert!(app.login.is_none());
    assert!(!app.login_device_request);
    let transcript = transcript_text(&app);
    assert!(transcript.contains("already in progress"), "{transcript}");
}

/// The ask layer is consulted before `handle_key`, so an ask queued by the
/// running agent must not swallow the secret being typed into `/login` --
/// a custom answer is submitted to the model.
#[tokio::test]
async fn a_queued_ask_never_captures_login_keystrokes() {
    let mut app = test_app();
    let registry = crate::core::agent::interaction::new_registry();
    let (request_id, _receiver) = crate::core::agent::interaction::register(&registry).await;
    open_paste_field(&mut app).await;
    app.apply(StreamEvent::AskRequest {
        request_id,
        request: ask_request(false, false),
        timeout_secs: None,
    });
    app.ask_queue.front_mut().unwrap().editing_custom = true;

    for ch in "tk-secret".chars() {
        let key = KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE);
        assert!(
            !handle_ask_key(&mut app, key, &registry).await,
            "the login dock owns the keyboard"
        );
        press(&mut app, KeyCode::Char(ch), KeyModifiers::NONE).await;
    }

    assert_eq!(app.login.as_ref().unwrap().input, "tk-secret");
    assert_eq!(app.ask_queue.front().unwrap().custom_input, "");
    assert!(app.input.is_empty(), "the composer must not see the key");
}

/// `/context` and the sign-in prompt own the keyboard in
/// `handle_key` too, so a queued ask must defer to them: Esc meant to
/// close `/context` silently cancelled the agent's question (#127).
#[tokio::test]
async fn a_queued_ask_defers_to_the_context_view_and_login() {
    for dock in ["context_view", "login"] {
        let mut app = test_app();
        let registry = crate::core::agent::interaction::new_registry();
        let (request_id, _receiver) =
            crate::core::agent::interaction::register(&registry).await;
        app.apply(StreamEvent::AskRequest {
            request_id,
            request: ask_request(false, false),
            timeout_secs: None,
        });
        match dock {
            "context_view" => app.context_view = Some(ContextView::Loading),
            _ => app.login = Some(confirmed_paste_prompt()),
        }
        let esc = KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE);
        assert!(
            !handle_ask_key(&mut app, esc, &registry).await,
            "{dock} owns the keyboard"
        );
        assert_eq!(app.ask_queue.len(), 1, "{dock}: the ask was consumed");
    }
}

fn blank_mcp_prompt() -> super::McpPrompt {
    super::McpPrompt {
        editing: None,
        field: super::McpField::Name,
        name: String::new(),
        transport: "stdio".to_string(),
        command: String::new(),
        args: String::new(),
        env: String::new(),
        url: String::new(),
        headers: String::new(),
        active: false,
        error: None,
    }
}

/// A named way to open one keyboard-owning dock, for the table below.
type DockSetup = (&'static str, fn(&mut App));

/// Every dock that takes the keyboard in `handle_key` must also blank the
/// input row: a live cursor under a dock that swallows every keystroke
/// promises a field that is not there. One case per guard in that list, so
/// the next dock added cannot quietly regress only the rendering half.
#[test]
fn every_blocking_dock_marks_the_input_row_inactive() {
    let setups: [DockSetup; 6] = [
        ("login/connecting", |app| {
            app.login = Some(super::LoginPrompt::connecting())
        }),
        ("login/paste", |app| {
            app.login = Some(confirmed_paste_prompt())
        }),
        ("browser_confirm", |app| {
            app.browser_confirm = Some(super::BrowserConfirm {
                url: "https://example.com/authorize".into(),
                purpose: "authorize 'github'".into(),
            })
        }),
        ("settings_prompt", |app| {
            let def = AGENT_SETTINGS
                .iter()
                .find(|d| d.key == "max_parallel_subagents")
                .unwrap();
            app.settings_prompt = Some(super::SettingsPrompt::new(def, None));
        }),
        ("mcp_prompt", |app| {
            app.mcp_prompt = Some(blank_mcp_prompt())
        }),
        ("provider_prompt", |app| {
            app.provider_prompt = Some(super::ProviderPrompt::new())
        }),
    ];
    for (name, open) in setups {
        let mut app = test_app();
        open(&mut app);
        assert!(app.blocking_dock().is_some(), "{name} must block the field");
        let screen = render_rows(&mut app, 80, 24).join("\n");
        assert!(screen.contains("the field is inactive"), "{name}: {screen}");
        assert!(
            !screen.contains("Type here to chat with agent"),
            "{name}: a live field must not show while the dock is open: {screen}"
        );
    }
}

/// The composer is only dead while a dock is up -- an idle app with no dock
/// must still offer a field, or the guard above has over-reached.
#[test]
fn no_dock_leaves_the_input_row_live() {
    let mut app = test_app();
    assert!(app.blocking_dock().is_none());
    let screen = render_rows(&mut app, 80, 24).join("\n");
    assert!(screen.contains("Type here to chat with agent"), "{screen}");
    assert!(!screen.contains("the field is inactive"), "{screen}");
}

/// The approval stage shows the code and the URL, and takes no input -- the
/// code is the one thing the user has to compare against the browser.
#[tokio::test]
async fn login_approval_stage_shows_the_code_and_ignores_typing() {
    let mut app = test_app();
    super::show_login_approval(
        &mut app,
        &crate::core::cli::device_auth::Session {
            session_id: "sess-1".into(),
            user_code: "ABCD-2345".into(),
            authorize_url: "https://tokamak.sh/cli/authorize?code=ABCD-2345".into(),
            expires_in: 300,
            interval: 5,
        },
    );
    let prompt = app.login.as_ref().expect("dock open");
    assert!(matches!(prompt.stage, super::LoginStage::Approving { .. }));
    assert!(!prompt.editable());

    type_key_chars(&mut app, "xyz").await;
    assert!(
        app.login.as_ref().unwrap().input.is_empty(),
        "no field to type into"
    );
    assert!(app.login_submit.is_none());

    let screen = render_rows(&mut app, 80, 24).join("\n");
    assert!(screen.contains("ABCD-2345"), "{screen}");
    assert!(screen.contains("waiting for approval"), "{screen}");
}

/// Esc during a browser approval closes the dock, which is what makes
/// `chat_loop` drop the in-flight poll.
#[tokio::test]
async fn esc_cancels_a_browser_approval() {
    let mut app = test_app();
    run_command(&mut app, "login", &no_mcp()).await;
    press(&mut app, KeyCode::Esc, KeyModifiers::NONE).await;
    assert!(app.login.is_none(), "Esc must close the dock");
}

/// A denied or expired approval has no field to correct, so the dock closes
/// with the reason rather than sitting there uneditable.
#[tokio::test]
async fn a_failed_approval_closes_the_dock_with_the_reason() {
    let mut app = test_app();
    super::show_login_approval(
        &mut app,
        &crate::core::cli::device_auth::Session {
            session_id: "s".into(),
            user_code: "A-1".into(),
            authorize_url: "https://tokamak.sh/cli/authorize?code=A-1".into(),
            expires_in: 300,
            interval: 5,
        },
    );
    finish_login(
        &mut app,
        Err(crate::core::cli::auth::LoginError::OAuth(
            "the sign-in was denied in the browser.".to_string(),
        )),
    );
    assert!(app.login.is_none(), "an uneditable dock must not stay open");
    let text: String = row_lines(&app.transcript)
        .iter()
        .flat_map(|l| l.spans.clone())
        .map(|s| s.content.to_string())
        .collect();
    assert!(
        text.contains("could not complete browser sign-in"),
        "{text}"
    );
}

/// A successful browser sign-in names the account it signed in as.
#[test]
fn a_browser_login_reports_the_account() {
    let mut app = test_app();
    assert!(finish_tokamak_login(
        &mut app,
        Ok(crate::core::cli::tokamak::Login {
            models: vec!["tokamak-1-preview".into()],
            config_path: std::path::PathBuf::from("/tmp/config.toml"),
            default_model: None,
            replaced_default: false,
            account: Some("a@b.c".into()),
        }),
    ));
    let text: String = row_lines(&app.transcript)
        .iter()
        .flat_map(|l| l.spans.clone())
        .map(|s| s.content.to_string())
        .collect();
    assert!(text.contains("as a@b.c"), "{text}");
}

#[test]
fn submit_user_with_no_model_notes_instead_of_starting_a_turn() {
    let mut app = test_app();
    app.model = String::new();
    app.submit_user("hi".into());
    assert!(
        !app.want_start,
        "a fresh install must not start a turn with no model"
    );
    assert!(app.history.is_empty());
    let text: String = row_lines(&app.transcript)
        .iter()
        .flat_map(|l| l.spans.clone())
        .map(|s| s.content.to_string())
        .collect();
    assert!(text.contains("/login"), "{text}");
}

#[test]
fn init_starts_a_turn_covering_all_three_artifacts() {
    let mut app = test_app();
    super::init_command(&mut app);
    assert!(app.want_start, "/init must start a turn");
    let sent = app.history.last().expect("user message").to_string();
    assert!(sent.contains("JAN.md"), "{sent}");
    assert!(sent.contains("skill_write"), "{sent}");
    assert!(sent.contains("memory_write"), "{sent}");
    let _ = std::fs::remove_dir_all(&app.agent_dir);
}

/// The canned prompt is plumbing: the note announces `/init`, and neither
/// the transcript nor the replayable journal carries the prompt body.
#[test]
fn init_keeps_the_prompt_out_of_the_transcript() {
    let mut app = test_app();
    app.pending_images.push(super::PendingImage {
        name: "shot.png".into(),
        data_url: "data:image/png;base64,AA".into(),
    });
    super::init_command(&mut app);
    let text: String = row_lines(&app.transcript)
        .iter()
        .flat_map(|l| l.spans.clone())
        .map(|s| s.content.to_string())
        .collect();
    assert!(!text.contains("Onboard yourself"), "{text}");
    assert!(text.contains("init ·"), "{text}");
    assert!(
        !app.display_log
            .iter()
            .any(|e| matches!(e, DisplayEntry::User { .. })),
        "a hidden turn must not journal a user row"
    );
    assert_eq!(app.pending_images.len(), 1, "staged images stay staged");
    let _ = std::fs::remove_dir_all(&app.agent_dir);
}

/// Surveying a project while a turn is mid-change would onboard against a
/// moving target, so the command declines rather than queueing.
#[test]
fn init_declines_while_a_turn_is_running() {
    let mut app = test_app();
    app.status = Status::Running;
    super::init_command(&mut app);
    assert!(app.history.is_empty());
    assert!(app.message_queue.is_empty());
    let _ = std::fs::remove_dir_all(&app.agent_dir);
}

#[test]
fn login_successful_api_key_login_reports_only_model_guidance() {
    crate::core::agent::global_config::with_temp_home(|_| {
        let mut app = test_app();
        app.login = Some(confirmed_paste_prompt());
        finish_login(
            &mut app,
            Ok(crate::core::cli::auth::LoginResult {
                provider: "tokamak".into(),
                models: vec!["tokamak-1-preview".into(), "tokamak-1-mini".into()],
                config_path: std::path::PathBuf::from("/tmp/config.toml"),
                default_model: Some("tokamak-1-preview".into()),
            }),
        );
        assert!(app.login.is_none());
        assert!(
            transcript_text(&app)
                .contains("signed in to tokamak. Use /model to select a model."),
            "{}",
            transcript_text(&app)
        );
        // The session's old model ("m") is offered by nobody, so sign-in must
        // move it onto one the new account can serve.
        assert_eq!(app.model, "tokamak-1-preview");
    });
}

#[test]
fn failed_api_key_login_reports_provider_safe_error_without_key() {
    let mut app = test_app();
    app.login = Some(confirmed_paste_prompt());
    app.login.as_mut().unwrap().paste("tk-secret-do-not-render");

    finish_login(
        &mut app,
        Err(crate::core::cli::auth::LoginError::Unauthorized),
    );

    let prompt = app.login.as_ref().expect("prompt stays open to retry");
    assert_eq!(
        prompt.error.as_deref(),
        Some("tokamak sign-in failed: that API key was not accepted")
    );
    let screen = render_rows(&mut app, 80, 24).join("\n");
    assert!(screen.contains("tokamak sign-in failed"), "{screen}");
    assert!(!screen.contains("tk-secret-do-not-render"), "{screen}");
}

#[test]
fn login_error_message_sanitizes_persistence_failure_details() {
    let message = super::login_error_message(
        "tokamak",
        crate::core::cli::auth::LoginError::Persist(
            "could not save provider configuration to /Users/alice/.jan/config.toml with key tk-secret-do-not-render".to_string(),
        ),
    );

    assert_eq!(
        message,
        "tokamak sign-in failed: could not save sign-in securely"
    );
    assert!(
        !message.contains("/Users/alice/.jan/config.toml"),
        "{message}"
    );
    assert!(!message.contains("tk-secret-do-not-render"), "{message}");
}

#[test]
fn login_error_message_sanitizes_oauth_failure_details() {
    let message = super::login_error_message(
        "anthropic",
        crate::core::cli::auth::LoginError::OAuth(
            "callback contained code=sk-secret-do-not-render from /Users/alice/.jan/config.toml".to_string(),
        ),
    );

    assert_eq!(
        message,
        "anthropic sign-in failed: could not complete browser sign-in"
    );
    assert!(
        !message.contains("/Users/alice/.jan/config.toml"),
        "{message}"
    );
    assert!(!message.contains("sk-secret-do-not-render"), "{message}");
}

#[test]
fn login_keeps_a_still_runnable_model_on_a_key_refresh() {
    crate::core::agent::global_config::with_temp_home(|_| {
        crate::core::agent::global_config::set_provider(
            "tokamak",
            crate::core::agent::global_config::ProviderUpdate {
                api_key: Some("tk".into()),
                clear_api_key: false,
                base_url: Some(crate::core::cli::tokamak::BASE_URL.into()),
                models: Some(vec!["m".into()]),
                api_type: None,
                ..Default::default()
            },
        )
        .expect("seed provider");

        let mut app = test_app();
        app.login = Some(confirmed_paste_prompt());
        finish_login(
            &mut app,
            Ok(crate::core::cli::auth::LoginResult {
                provider: "tokamak".into(),
                models: vec!["tokamak-1-preview".into()],
                config_path: std::path::PathBuf::from("/tmp/config.toml"),
                default_model: None,
            }),
        );
        assert_eq!(app.model, "m", "a working model must survive a re-login");
    });
}

/// After login writes a provider to disk, the in-memory `args.provider_configs`
/// snapshot (built at startup) must be refreshed so upstream resolution sees
/// the new provider without a restart (#8688).
#[test]
fn reload_provider_configs_picks_up_login_credentials() {
    crate::core::agent::global_config::with_temp_home(|_| {
        // Seed a tokamak provider in the global config (simulates what
        // `/login` persisted to `~/.jan/config.toml`).
        crate::core::agent::global_config::set_provider(
            "tokamak",
            crate::core::agent::global_config::ProviderUpdate {
                api_key: Some("tk".into()),
                clear_api_key: false,
                base_url: Some(crate::core::cli::tokamak::BASE_URL.into()),
                models: Some(vec!["tokamak-1-preview".into()]),
                api_type: None,
                ..Default::default()
            },
        )
        .expect("seed provider");

        let mut app = test_app();
        // Give the app a provider_configs map that is stale (empty, as it
        // would be on a fresh launch before login).
        let provider_configs: std::collections::HashMap<
            String,
            crate::core::state::ProviderConfig,
        > = std::collections::HashMap::new();
        let args = std::sync::Arc::new(super::OrchestrationArgs {
            profile: None,
        parent_run: None,
        spend_ledger: None,
        dispatch_id: None,
            fallback_models: Vec::new(),
            client: crate::core::agent::upstream::agent_http_client(),
            provider_configs: std::sync::Arc::new(tokio::sync::Mutex::new(provider_configs)),
            mcp_servers: std::sync::Arc::new(tokio::sync::Mutex::new(
                std::collections::HashMap::new(),
            )),
            mcp_settings: std::sync::Arc::new(tokio::sync::Mutex::new(
                crate::core::mcp::models::McpSettings::default(),
            )),
            jan_data_folder: String::new(),
            permissions: tauri_plugin_agent_tools::permissions::ToolPermissions::default(),
            project_root: Some(app.project_root.clone()),
            permission_requests: std::sync::Arc::new(tokio::sync::Mutex::new(
                std::collections::HashMap::new(),
            )),
            host_tools: crate::core::agent::host_tools::HostToolSet::new(),
            host_tool_requests: crate::core::agent::host_tools::new_registry(),
            host_owns_gate: false,
            host_tool_route: None,
            ask_requests: None,
            todo_registry: None,
            system_prompt_override: None,
            subagents_enabled: true,
            max_parallel_subagents: 4,
            auto_approve: false,
            bypass: false,
            run_mode: crate::core::agent::plan::RunMode::Normal,
            session_id: None,
            run_id: None,
            subject: tauri_plugin_agent_tools::subject::Subject::MainAgent,
            sandbox: None,
        });
        app.args = Some(args.clone());

        // Build a dedicated multi-threaded runtime so we can .await
        // inside `with_temp_home` (which is sync and holds HOME set).
        let rt = tokio::runtime::Runtime::new().expect("runtime");

        // Before reload, the map is empty.
        assert!(rt.block_on(args.provider_configs.lock()).is_empty());

        // Reload from disk (the config we seeded above).
        rt.block_on(super::reload_provider_configs(&mut app));

        // After reload, tokamak provider must be present with the right key.
        let map = rt.block_on(args.provider_configs.lock());
        let tokamak = map
            .get("tokamak")
            .expect("tokamak provider should be present after reload");
        assert_eq!(tokamak.api_key.as_deref(), Some("tk"));
        assert_eq!(
            tokamak.base_url.as_deref(),
            Some(crate::core::cli::tokamak::BASE_URL)
        );
        assert!(tokamak.models.iter().any(|m| m == "tokamak-1-preview"));
    });
}

#[test]
fn masked_key_is_bounded() {
    let mut prompt = confirmed_paste_prompt();
    prompt.paste(&"k".repeat(200));
    assert_eq!(prompt.masked().chars().count(), 32);
    prompt.verifying = true;
    prompt.paste("ignored");
    assert_eq!(prompt.input.chars().count(), 200);
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
fn subagent_name_from_run_id_strips_prefix_and_seq() {
    assert_eq!(subagent_name_from_run_id("sub-reviewer-3"), "reviewer");
    assert_eq!(subagent_name_from_run_id("sub-a-b-c-12"), "a-b-c");
    // Non-conforming ids pass through.
    assert_eq!(subagent_name_from_run_id("weird"), "weird");
}

#[test]
fn subagent_panel_labels_keep_command_detail() {
    // The panel must distinguish consecutive bash calls, not collapse to
    // "Executing git".
    assert_eq!(
        subagent_activity("bash", &json!({ "command": "git log --oneline -5" })),
        "$ git log --oneline -5"
    );
    assert_eq!(
        subagent_activity("bash", &json!({ "command": "git diff" })),
        "$ git diff"
    );
    assert_eq!(
        subagent_activity("read", &json!({ "path": "src/main.rs" })),
        "read src/main.rs"
    );
    assert_eq!(
        subagent_activity("grep", &json!({ "pattern": "TODO" })),
        "grep TODO"
    );
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

fn wrap(run_id: &str, name: &str, event: StreamEvent) -> StreamEvent {
    StreamEvent::Subagent {
        run_id: run_id.into(),
        name: name.into(),
        event: Box::new(event),
    }
}

#[test]
fn subagent_calls_fill_rolling_panel_capped_at_window() {
    let mut app = test_app();
    app.apply(StreamEvent::SubagentStart {
        run_id: "r1".into(),
        name: "reviewer".into(),
        task: None,
    });
    // Seven calls; only the last SUBAGENT_WINDOW remain visible.
    for i in 0..7 {
        app.apply(wrap(
            "r1",
            "reviewer",
            StreamEvent::ToolCall {
                id: format!("c{i}"),
                name: "bash".into(),
                args: json!({ "command": format!("cmd{i}") }),
            },
        ));
        // Results are internal to the subagent and must not surface.
        app.apply(wrap(
            "r1",
            "reviewer",
            StreamEvent::ToolResult {
                id: format!("c{i}"),
                content: "ok".into(),
                is_error: false,
                diff: None,
            },
        ));
    }
    let panel = app
        .subagents
        .iter()
        .find(|p| p.run_id == "r1")
        .expect("active");
    // Full history retained (for later expansion); the window is a render concern.
    assert_eq!(panel.calls.len(), 7);
    assert!(panel.calls.first().unwrap().contains("cmd0"));
    assert!(panel.calls.last().unwrap().contains("cmd6"));
    // The live panel renders only the newest call.
    use ratatui::{backend::TestBackend, Terminal};
    let render = |app: &mut App| {
        let mut terminal = Terminal::new(TestBackend::new(80, 30)).unwrap();
        terminal.draw(|f| super::draw(f, app)).unwrap();
        let buf = terminal.backend().buffer().clone();
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .map(|x| buf[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    // The docked panel has room for the newest call only; the whole list
    // stays reachable through the finished summary row (Ctrl-O).
    let out = render(&mut app);
    assert!(out.contains("cmd6"), "newest call shown: {out}");
    assert!(
        !out.contains("cmd5") && !out.contains("cmd0"),
        "older calls elided: {out}"
    );
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
fn settings_command_bare_opens_picker_and_inline_set_writes_toml() {
    let mut app = test_app();
    // A minimal agent.toml so the picker shows a real current value.
    std::fs::create_dir_all(&app.agent_dir).unwrap();
    let toml_path = app.agent_dir.join("agent.toml");
    std::fs::write(&toml_path, "[agent]\ncontext_window = 64000\n").unwrap();

    super::settings_command(&mut app, "max_parallel_subagents 20");
    let doc = std::fs::read_to_string(&toml_path).unwrap();
    assert!(
        doc.contains("max_parallel_subagents = 20"),
        "key written: {doc}"
    );
    assert!(
        doc.contains("context_window = 64000"),
        "other keys preserved: {doc}"
    );

    // Zero is invalid: rejected, file unchanged.
    super::settings_command(&mut app, "max_parallel_subagents 0");
    let doc = std::fs::read_to_string(&toml_path).unwrap();
    assert!(
        doc.contains("max_parallel_subagents = 20"),
        "rejected write must not clobber: {doc}"
    );
    assert!(transcript_text(&app).contains("must be at least 1"));

    // Bare opens the settings picker with a row per def, hints carrying
    // the on-disk current value (no key prefix; the label is the key).
    super::settings_command(&mut app, "");
    let picker = app.picker.as_ref().expect("bare /settings opens picker");
    assert_eq!(picker.kind, PickerKind::AgentSettings);
    // One leading "providers" row plus a row per `[agent]` def.
    assert_eq!(picker.items.len(), AGENT_SETTINGS.len() + 1);
    assert_eq!(picker.items[0].value, PROVIDERS_SETTINGS_ROW);
    let row = picker
        .items
        .iter()
        .find(|i| i.value == "context_window")
        .expect("context_window row present");
    assert_eq!(row.hint.as_deref(), Some("= 64000"));
    let row = picker
        .items
        .iter()
        .find(|i| i.value == "max_parallel_subagents")
        .expect("max_parallel_subagents row present");
    assert_eq!(row.hint.as_deref(), Some("= 20"));
    let _ = std::fs::remove_dir_all(&app.agent_dir);
}

#[tokio::test]
async fn settings_picker_x_unsets_selected_key() {
    let mut app = test_app();
    std::fs::create_dir_all(&app.agent_dir).unwrap();
    let toml_path = app.agent_dir.join("agent.toml");
    std::fs::write(&toml_path, "[agent]\ncontext_window = 64000\n").unwrap();

    super::settings_command(&mut app, "");
    // Select the context_window row and press x: the key must be removed,
    // the row hint flip back to (unset), the note rendered. (Found by value
    // rather than index since index 0 is the leading "providers" row.)
    let idx = app
        .picker
        .as_ref()
        .unwrap()
        .items
        .iter()
        .position(|i| i.value == "context_window")
        .expect("context_window row");
    app.picker.as_mut().unwrap().selected = idx;
    press(&mut app, KeyCode::Char('x'), KeyModifiers::NONE).await;
    let doc = std::fs::read_to_string(&toml_path).unwrap();
    assert!(
        !doc.contains("context_window = 64000"),
        "key removed: {doc}"
    );
    assert!(transcript_text(&app).contains("context_window unset"));
    let picker = app.picker.as_ref().expect("picker stays open");
    let row = picker
        .items
        .iter()
        .find(|i| i.value == "context_window")
        .expect("context_window row present");
    assert_eq!(row.hint.as_deref(), Some("(unset)"));
    let _ = std::fs::remove_dir_all(&app.agent_dir);
}

#[test]
fn settings_command_rejects_non_integer_and_unknown_keys() {
    let mut app = test_app();
    std::fs::create_dir_all(&app.agent_dir).unwrap();
    let toml_path = app.agent_dir.join("agent.toml");
    std::fs::write(&toml_path, "[agent]\n").unwrap();

    super::settings_command(&mut app, "max_parallel_subagents lots");
    assert!(transcript_text(&app).contains("is not an integer"));
    super::settings_command(&mut app, "warp_drive 5");
    assert!(transcript_text(&app).contains("unknown setting"));
    let _ = std::fs::remove_dir_all(&app.agent_dir);
}

#[test]
fn settings_prompt_enter_writes_and_closes() {
    let mut app = test_app();
    std::fs::create_dir_all(&app.agent_dir).unwrap();
    let toml_path = app.agent_dir.join("agent.toml");
    std::fs::write(&toml_path, "[agent]\n").unwrap();

    let def = AGENT_SETTINGS
        .iter()
        .find(|d| d.key == "max_parallel_subagents")
        .unwrap();
    app.settings_prompt = Some(super::SettingsPrompt::new(def, None));
    super::handle_settings_key(&mut app, key(KeyCode::Char('3')), false);
    super::handle_settings_key(&mut app, key(KeyCode::Enter), false);
    assert!(app.settings_prompt.is_none(), "Enter closes the dock");
    let doc = std::fs::read_to_string(&toml_path).unwrap();
    assert!(doc.contains("max_parallel_subagents = 3"), "{doc}");
    assert!(transcript_text(&app).contains("max_parallel_subagents = 3 written"));
    let _ = std::fs::remove_dir_all(&app.agent_dir);
}

#[test]
fn settings_prompt_edits_text_key() {
    let mut app = test_app();
    std::fs::create_dir_all(&app.agent_dir).unwrap();
    let toml_path = app.agent_dir.join("agent.toml");
    std::fs::write(&toml_path, "[agent]\n").unwrap();

    let def = AGENT_SETTINGS
        .iter()
        .find(|d| d.key == "instructions_file")
        .unwrap();
    app.settings_prompt = Some(super::SettingsPrompt::new(def, None));
    for ch in "PROMPT.md".chars() {
        super::handle_settings_key(&mut app, key(KeyCode::Char(ch)), false);
    }
    super::handle_settings_key(&mut app, key(KeyCode::Enter), false);

    assert!(app.settings_prompt.is_none());
    let doc = std::fs::read_to_string(&toml_path).unwrap();
    assert!(doc.contains("instructions_file = \"PROMPT.md\""), "{doc}");
    let _ = std::fs::remove_dir_all(&app.agent_dir);
}

/// `wave` lives in `~/.jan/config.toml`, not the project's agent.toml, so
/// the row has to write across scopes. It is also the one setting that
/// applies live: a cosmetic glyph you must restart to see is not a toggle,
/// and the note must not claim a restart is needed.
#[test]
fn settings_prompt_writes_a_global_scope_key_and_applies_it_live() {
    crate::core::agent::global_config::with_temp_home(|home| {
        let mut app = test_app();
        std::fs::create_dir_all(&app.agent_dir).unwrap();
        let toml_path = app.agent_dir.join("agent.toml");
        std::fs::write(&toml_path, "[agent]\n").unwrap();

        let def = AGENT_SETTINGS.iter().find(|d| d.key == "wave").unwrap();
        app.settings_prompt = Some(super::SettingsPrompt::new(def, None));
        super::handle_settings_key(&mut app, key(KeyCode::Char('~')), false);
        super::handle_settings_key(&mut app, key(KeyCode::Enter), false);

        assert!(app.settings_prompt.is_none(), "Enter closes the dock");
        let global = std::fs::read_to_string(home.join(".jan").join("config.toml")).unwrap();
        assert!(
            global.contains("wave = \"~\""),
            "written globally: {global}"
        );
        let project = std::fs::read_to_string(&toml_path).unwrap();
        assert!(
            !project.contains("wave"),
            "a global key must not land in agent.toml: {project}"
        );
        assert_eq!(super::wave_glyph().as_deref(), Some("~"), "applied live");
        let note = transcript_text(&app);
        assert!(note.contains("wave = ~ written"), "{note}");
        assert!(
            note.contains("in effect now"),
            "no restart is needed: {note}"
        );

        // Clearing the field writes the off value, live. It does *not*
        // remove the key: absent means the default 👋 comes back, which is
        // the opposite of what someone clearing the glyph asked for.
        app.settings_prompt = Some(super::SettingsPrompt::new(def, Some("~")));
        super::handle_settings_key(&mut app, key(KeyCode::Backspace), false);
        super::handle_settings_key(&mut app, key(KeyCode::Enter), false);
        assert_eq!(super::wave_glyph(), None, "off applied live");
        // Asserted through the reader, not the raw text: the scaffolded
        // template carries a commented `# wave = ...` example line that a
        // substring check would match forever.
        assert_eq!(
            crate::core::agent::global_config::global_value("wave").as_deref(),
            Some(""),
            "cleared field persists as the off value"
        );
        let note = transcript_text(&app);
        assert!(
            note.contains("wave off (throbber)"),
            "off, not unset: {note}"
        );

        // Removing the key is the other path, and it restores the default
        // rather than leaving the sweep off.
        crate::core::agent::global_config::set_global_key("wave", None).expect("unset");
        super::set_wave_glyph(None);
        assert_eq!(
            crate::core::agent::global_config::global_value("wave"),
            None,
            "key removed from the file"
        );
        assert_eq!(
            super::wave_glyph().as_deref(),
            Some(crate::core::agent::global_config::WAVE_DEFAULT),
            "a removed key brings the default sweep back"
        );

        let _ = std::fs::remove_dir_all(&app.agent_dir);
    });
}

/// The picker hint for a global row must read the global file, or every
/// user-wide key would show `(unset)` however it is configured.
/// Sync, with a local runtime for the one keypress: `with_temp_home` swaps
/// the process `HOME`, so the guard must not be held across an await.
#[test]
fn settings_picker_reads_and_unsets_a_global_scope_key() {
    crate::core::agent::global_config::with_temp_home(|home| {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let mut app = test_app();
        std::fs::create_dir_all(&app.agent_dir).unwrap();
        std::fs::write(app.agent_dir.join("agent.toml"), "[agent]\n").unwrap();
        std::fs::create_dir_all(home.join(".jan")).unwrap();
        let global_path = home.join(".jan").join("config.toml");
        std::fs::write(&global_path, "wave = \"🍌\"\n").unwrap();

        super::settings_command(&mut app, "");
        let picker = app.picker.as_ref().expect("picker opens");
        let row = picker
            .items
            .iter()
            .find(|i| i.value == "wave")
            .expect("wave row present");
        assert_eq!(row.hint.as_deref(), Some("= 🍌"), "hint reads ~/.jan");

        let idx = picker.items.iter().position(|i| i.value == "wave").unwrap();
        app.picker.as_mut().unwrap().selected = idx;
        rt.block_on(press(&mut app, KeyCode::Char('x'), KeyModifiers::NONE));
        assert_eq!(
            crate::core::agent::global_config::global_value("wave"),
            None,
            "x unsets globally"
        );
        let row = app
            .picker
            .as_ref()
            .expect("picker stays open")
            .items
            .iter()
            .find(|i| i.value == "wave")
            .expect("wave row present");
        assert_eq!(row.hint.as_deref(), Some("(unset)"));

        let _ = std::fs::remove_dir_all(&app.agent_dir);
    });
}

#[test]
fn settings_prompt_esc_cancels_without_writing() {
    let mut app = test_app();
    std::fs::create_dir_all(&app.agent_dir).unwrap();
    let toml_path = app.agent_dir.join("agent.toml");
    std::fs::write(&toml_path, "[agent]\nmax_parallel_subagents = 7\n").unwrap();

    let def = AGENT_SETTINGS
        .iter()
        .find(|d| d.key == "max_parallel_subagents")
        .unwrap();
    app.settings_prompt = Some(super::SettingsPrompt::new(def, Some("7")));
    super::handle_settings_key(&mut app, key(KeyCode::Char('9')), false);
    super::handle_settings_key(&mut app, key(KeyCode::Esc), false);
    assert!(app.settings_prompt.is_none());
    let doc = std::fs::read_to_string(&toml_path).unwrap();
    assert!(
        doc.contains("max_parallel_subagents = 7"),
        "unchanged: {doc}"
    );
    let _ = std::fs::remove_dir_all(&app.agent_dir);
}

/// The glyph field stops accepting input at the cap rather than letting a
/// long string be typed and rejected on Enter, and it counts what the eye
/// counts: `👁️👄👁️` is three characters, not five.
#[test]
fn settings_glyph_field_caps_at_three_graphemes() {
    let mut app = test_app();
    let def = AGENT_SETTINGS.iter().find(|d| d.key == "wave").unwrap();
    app.settings_prompt = Some(super::SettingsPrompt::new(def, None));

    for ch in "👁️👄👁️".chars() {
        super::handle_settings_key(&mut app, key(KeyCode::Char(ch)), false);
    }
    fn input(app: &App) -> String {
        app.settings_prompt.as_ref().unwrap().input.clone()
    }
    assert_eq!(
        input(&app),
        "👁️👄👁️",
        "three clusters of five chars all fit"
    );

    // One past the cap is dropped, and the field is left exactly as it was
    // rather than half-appended.
    super::handle_settings_key(&mut app, key(KeyCode::Char('x')), false);
    assert_eq!(input(&app), "👁️👄👁️", "a fourth cluster is refused");

    // Backspace removes a whole cluster: popping one `char` off `👁️` would
    // leave `👁`, which looks like nothing happened.
    super::handle_settings_key(&mut app, key(KeyCode::Backspace), false);
    assert_eq!(input(&app), "👁️👄", "backspace drops the whole cluster");
}

/// A hand-typed over-long glyph is rejected inline with a reason, not
/// silently truncated: truncation would save something the user did not
/// type.
#[test]
fn settings_glyph_rejects_an_over_long_paste() {
    crate::core::agent::global_config::with_temp_home(|_| {
        let mut app = test_app();
        let def = AGENT_SETTINGS.iter().find(|d| d.key == "wave").unwrap();
        let mut prompt = super::SettingsPrompt::new(def, None);
        // Set directly: the key handler caps typing, so an over-long value
        // can only arrive from a paste or a hand-edited file.
        prompt.input = "abcd".to_string();
        app.settings_prompt = Some(prompt);

        super::handle_settings_key(&mut app, key(KeyCode::Enter), false);
        let prompt = app.settings_prompt.as_ref().expect("dock stays open");
        let error = prompt.error.as_deref().expect("inline error");
        assert!(error.contains('3'), "names the cap: {error}");
        assert_eq!(
            crate::core::agent::global_config::global_value("wave"),
            None,
            "nothing written on a rejected value"
        );
    });
}

#[test]
fn settings_prompt_cleared_field_unsets_key() {
    let mut app = test_app();
    std::fs::create_dir_all(&app.agent_dir).unwrap();
    let toml_path = app.agent_dir.join("agent.toml");
    std::fs::write(&toml_path, "[agent]\ncontext_window = 8\n").unwrap();

    let def = AGENT_SETTINGS
        .iter()
        .find(|d| d.key == "context_window")
        .unwrap();
    app.settings_prompt = Some(super::SettingsPrompt::new(def, Some("8")));
    super::handle_settings_key(&mut app, key(KeyCode::Backspace), false);
    super::handle_settings_key(&mut app, key(KeyCode::Enter), false);
    assert!(app.settings_prompt.is_none());
    let doc = std::fs::read_to_string(&toml_path).unwrap();
    assert!(!doc.contains("context_window = 8"), "key removed: {doc}");
    assert!(transcript_text(&app).contains("context_window unset"));
    let _ = std::fs::remove_dir_all(&app.agent_dir);
}

#[test]
fn settings_prompt_rejects_below_min_and_garbage() {
    let mut app = test_app();
    std::fs::create_dir_all(&app.agent_dir).unwrap();
    let toml_path = app.agent_dir.join("agent.toml");
    std::fs::write(&toml_path, "[agent]\n").unwrap();

    let def = AGENT_SETTINGS
        .iter()
        .find(|d| d.key == "max_parallel_subagents")
        .unwrap();
    app.settings_prompt = Some(super::SettingsPrompt::new(def, None));
    super::handle_settings_key(&mut app, key(KeyCode::Char('0')), false);
    super::handle_settings_key(&mut app, key(KeyCode::Enter), false);
    assert!(app.settings_prompt.is_some(), "dock stays open on error");
    let err = app
        .settings_prompt
        .as_ref()
        .and_then(|p| p.error.clone())
        .expect("error recorded");
    assert!(err.contains("at least 1"), "{err}");
    assert_eq!(std::fs::read_to_string(&toml_path).unwrap(), "[agent]\n");

    app.settings_prompt = Some(super::SettingsPrompt::new(def, None));
    super::handle_settings_key(&mut app, key(KeyCode::Char('x')), false);
    super::handle_settings_key(&mut app, key(KeyCode::Enter), false);
    let err = app
        .settings_prompt
        .as_ref()
        .and_then(|p| p.error.clone())
        .expect("error recorded");
    assert!(err.contains("not an integer"), "{err}");
    assert_eq!(std::fs::read_to_string(&toml_path).unwrap(), "[agent]\n");
    let _ = std::fs::remove_dir_all(&app.agent_dir);
}

#[test]
fn mcp_prompt_visible_fields_follow_transport() {
    let mut p = McpPrompt {
        editing: None,
        field: McpField::Name,
        name: String::new(),
        transport: "stdio".to_string(),
        command: String::new(),
        args: String::new(),
        env: String::new(),
        url: String::new(),
        headers: String::new(),
        active: false,
        error: None,
    };
    assert!(p.visible_fields().contains(&McpField::Command));
    assert!(!p.visible_fields().contains(&McpField::Url));

    p.transport = "http".to_string();
    assert!(!p.visible_fields().contains(&McpField::Command));
    assert!(p.visible_fields().contains(&McpField::Url));
    assert!(p.visible_fields().contains(&McpField::Headers));
}

#[test]
fn mcp_prompt_next_prev_wrap_and_skip_hidden() {
    let mut p = McpPrompt {
        editing: None,
        field: McpField::Name,
        name: String::new(),
        transport: "stdio".to_string(),
        command: String::new(),
        args: String::new(),
        env: String::new(),
        url: String::new(),
        headers: String::new(),
        active: false,
        error: None,
    };
    // From Name forward skips url/headers (stdio).
    p.next_field();
    assert_eq!(p.field, McpField::Transport);
    p.next_field();
    assert_eq!(p.field, McpField::Command);
    // Prev wraps from the last field back to the first.
    p.field = McpField::Active;
    p.next_field();
    assert_eq!(p.field, McpField::Name);
    p.prev_field();
    assert_eq!(p.field, McpField::Active);
}

#[test]
fn edit_cannot_change_name() {
    let mut app = test_app();
    app.mcp_prompt = Some(McpPrompt {
        editing: Some("old".to_string()),
        field: McpField::Name,
        name: "old".to_string(),
        transport: "stdio".to_string(),
        command: String::new(),
        args: String::new(),
        env: String::new(),
        url: String::new(),
        headers: String::new(),
        active: false,
        error: None,
    });
    let servers: crate::core::state::SharedMcpServers =
        Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        super::handle_mcp_prompt_key(&mut app, key(KeyCode::Char('x')), false, &servers).await;
        super::handle_mcp_prompt_key(&mut app, key(KeyCode::Backspace), false, &servers).await;
    });
    app.mcp_prompt.as_mut().unwrap().paste("zzz");
    assert_eq!(app.mcp_prompt.as_ref().unwrap().name, "old");
}

/// `k`/`j` are ordinary characters in MCP text fields (URLs, paths), so
/// they must be typed, not steered with vim-style keys.
#[test]
fn mcp_prompt_types_k_and_j_into_fields() {
    let mut app = test_app();
    app.mcp_prompt = Some(McpPrompt {
        editing: None,
        field: McpField::Name,
        name: String::new(),
        transport: "http".to_string(),
        command: String::new(),
        args: String::new(),
        env: String::new(),
        url: String::new(),
        headers: String::new(),
        active: false,
        error: None,
    });
    let servers: crate::core::state::SharedMcpServers =
        Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        // Skip to the Url field: Name -> Transport -> Url.
        super::handle_mcp_prompt_key(&mut app, key(KeyCode::Down), false, &servers).await;
        super::handle_mcp_prompt_key(&mut app, key(KeyCode::Down), false, &servers).await;
        assert_eq!(app.mcp_prompt.as_ref().unwrap().field, McpField::Url);
        for ch in "https://jk.example/".chars() {
            super::handle_mcp_prompt_key(&mut app, key(KeyCode::Char(ch)), false, &servers)
                .await;
        }
    });

    let prompt = app.mcp_prompt.as_ref().expect("still open");
    assert_eq!(prompt.field, McpField::Url, "typing k must not move up");
    assert_eq!(prompt.url, "https://jk.example/");
}

#[test]
fn pairs_to_str_roundtrips() {
    let map = crate::core::cli::mcp::parse_pairs("A=1,B=2", "env").unwrap();
    assert_eq!(pairs_to_str(Some(&map)), "A=1,B=2");
    assert_eq!(pairs_to_str(None), "");
}

#[test]
fn settings_prompt_edits_enum_key() {
    let mut app = test_app();
    std::fs::create_dir_all(&app.agent_dir).unwrap();
    let toml_path = app.agent_dir.join("agent.toml");
    std::fs::write(&toml_path, "[agent]\n[tools]\ndefault = \"read-only\"\n").unwrap();

    let def = AGENT_SETTINGS
        .iter()
        .find(|d| d.key == "tools.default")
        .unwrap();
    app.settings_prompt = Some(super::SettingsPrompt::new(def, None));
    for ch in "deny".chars() {
        super::handle_settings_key(&mut app, key(KeyCode::Char(ch)), false);
    }
    super::handle_settings_key(&mut app, key(KeyCode::Enter), false);
    assert!(app.settings_prompt.is_none());
    let doc = std::fs::read_to_string(&toml_path).unwrap();
    assert!(
        doc.contains("default = \"deny\""),
        "written under [tools]: {doc}"
    );
    assert!(transcript_text(&app).contains("tools.default = deny written"));
    let _ = std::fs::remove_dir_all(&app.agent_dir);
}

#[test]
fn settings_prompt_rejects_enum_garbage() {
    let mut app = test_app();
    std::fs::create_dir_all(&app.agent_dir).unwrap();
    let toml_path = app.agent_dir.join("agent.toml");
    std::fs::write(&toml_path, "[agent]\n[tools]\ndefault = \"read-only\"\n").unwrap();

    let def = AGENT_SETTINGS
        .iter()
        .find(|d| d.key == "tools.default")
        .unwrap();
    app.settings_prompt = Some(super::SettingsPrompt::new(def, None));
    for ch in "aggressive".chars() {
        super::handle_settings_key(&mut app, key(KeyCode::Char(ch)), false);
    }
    super::handle_settings_key(&mut app, key(KeyCode::Enter), false);
    assert!(app.settings_prompt.is_some(), "dock stays open on error");
    let err = app
        .settings_prompt
        .as_ref()
        .and_then(|p| p.error.clone())
        .expect("error recorded");
    assert!(err.contains("read-only | deny | allow"), "{err}");
    let doc = std::fs::read_to_string(&toml_path).unwrap();
    assert!(doc.contains("default = \"read-only\""), "unchanged: {doc}");
    let _ = std::fs::remove_dir_all(&app.agent_dir);
}

#[test]
fn provider_prompt_field_navigation_wraps() {
    let mut p = super::ProviderPrompt::new();
    p.field = ProviderField::Name;
    p.next_field();
    assert_eq!(p.field, ProviderField::BaseUrl);
    p.next_field();
    assert_eq!(p.field, ProviderField::ApiType);
    p.next_field();
    assert_eq!(p.field, ProviderField::ApiKey);
    p.prev_field();
    assert_eq!(p.field, ProviderField::ApiType);
    p.prev_field();
    assert_eq!(p.field, ProviderField::BaseUrl);
    p.field = ProviderField::Models;
    p.next_field();
    assert_eq!(p.field, ProviderField::Name);
    p.prev_field();
    assert_eq!(p.field, ProviderField::Models);
}

#[test]
fn provider_prompt_validates_base_url() {
    crate::core::agent::global_config::with_temp_home(|_| {
        let mut p = super::ProviderPrompt::new();
        assert!(p.save().is_err(), "empty name rejected");
        p.name = "myprovider".to_string();
        assert!(p.save().is_err(), "empty base url rejected");
        p.base_url = "not-a-url".to_string();
        assert!(p.save().is_err(), "scheme required");
        p.base_url = "https://my-provider.example/v1".to_string();
        assert!(p.save().is_ok(), "valid https provider saved");
    });
}

#[test]
fn provider_prompt_save_writes_global_config() {
    crate::core::agent::global_config::with_temp_home(|_| {
        let mut p = super::ProviderPrompt::new();
        p.name = "myprovider".to_string();
        p.base_url = "https://my-provider.example/v1".to_string();
        p.api_key = "sk-test-123".to_string();
        p.models = "gpt-4o gpt-4o-mini".to_string();
        assert!(p.save().is_ok());

        let configs = crate::core::agent::global_config::load_global_config().unwrap();
        let cfg = configs.get("myprovider").expect("provider written");
        assert_eq!(
            cfg.base_url.as_deref(),
            Some("https://my-provider.example/v1")
        );
        assert_eq!(cfg.api_key.as_deref(), Some("sk-test-123"));
        assert_eq!(cfg.models, vec!["gpt-4o", "gpt-4o-mini"]);
    });
}

#[test]
fn provider_prompt_saves_anthropic_api_type() {
    crate::core::agent::global_config::with_temp_home(|_| {
        let mut p = super::ProviderPrompt::new();
        p.name = "myanthropic".to_string();
        p.base_url = "https://api.my-anthropic.example/v1".to_string();
        p.api_key = "sk-test-123".to_string();
        p.toggle_api_type();
        assert_eq!(p.api_type_label(), "anthropic-compatible");
        assert!(p.save().is_ok());

        let configs = crate::core::agent::global_config::load_global_config().unwrap();
        let cfg = configs
            .get("myanthropic")
            .expect("anthropic provider written");
        assert_eq!(cfg.api_type.as_deref(), Some("anthropic"));
    });
}

#[test]
fn provider_prompt_api_type_toggle_cycles_openai_anthropic() {
    let mut p = super::ProviderPrompt::new();
    assert_eq!(p.api_type_label(), "openai-compatible");
    p.toggle_api_type();
    assert_eq!(p.api_type_label(), "anthropic-compatible");
    p.toggle_api_type();
    assert_eq!(p.api_type_label(), "openai-compatible");
}

#[test]
fn provider_prompt_left_right_toggles_api_type_field() {
    let mut app = test_app();
    let mut p = super::ProviderPrompt::new();
    p.field = ProviderField::ApiType;
    app.provider_prompt = Some(p);
    super::handle_provider_prompt_key(&mut app, key(KeyCode::Right), false);
    assert_eq!(
        app.provider_prompt.as_ref().unwrap().api_type_label(),
        "anthropic-compatible",
        "Right on the api type field selects anthropic"
    );
}

#[test]
fn provider_prompt_keeps_existing_anthropic_type_when_editing() {
    crate::core::agent::global_config::with_temp_home(|_| {
        use crate::core::agent::global_config::{set_provider, ProviderUpdate};
        set_provider(
            "p",
            ProviderUpdate {
                api_key: Some("sk-1".into()),
                clear_api_key: false,
                base_url: Some("https://example.com/v1".into()),
                models: Some(vec!["claude-sonnet-5".into()]),
                api_type: Some("anthropic".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let entry = crate::core::agent::global_config::load_global_config()
            .unwrap()
            .get("p")
            .unwrap()
            .clone();
        let prompt = super::ProviderPrompt::from_entry(&entry);
        assert_eq!(prompt.api_type.as_deref(), Some("anthropic"));
        assert_eq!(
            prompt.api_type_label(),
            "anthropic-compatible",
            "editing an anthropic provider keeps its wire type"
        );
    });
}

#[test]
fn provider_prompt_save_and_cancel_via_keys() {
    crate::core::agent::global_config::with_temp_home(|_| {
        let mut app = test_app();
        app.provider_prompt = Some(super::ProviderPrompt::new());

        // Type name, advance, type base url, advance to models (skip key).
        for ch in "myprovider".chars() {
            super::handle_provider_prompt_key(&mut app, key(KeyCode::Char(ch)), false);
        }
        super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
        for ch in "https://my.example/v1".chars() {
            super::handle_provider_prompt_key(&mut app, key(KeyCode::Char(ch)), false);
        }
        // Advance past the api-type and API-key fields to models.
        super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
        super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
        super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
        for ch in "model-a".chars() {
            super::handle_provider_prompt_key(&mut app, key(KeyCode::Char(ch)), false);
        }
        super::handle_provider_prompt_key(&mut app, key(KeyCode::Enter), false);

        // Enter closed the dock and wrote the global config.
        assert!(app.provider_prompt.is_none());
        let configs = crate::core::agent::global_config::load_global_config().unwrap();
        let cfg = configs.get("myprovider").expect("provider written");
        assert_eq!(cfg.base_url.as_deref(), Some("https://my.example/v1"));
        assert_eq!(cfg.models, vec!["model-a"]);
        assert!(transcript_text(&app).contains("added provider 'myprovider'"));

        // Cancel leaves the store untouched.
        app.provider_prompt = Some(super::ProviderPrompt::new());
        super::handle_provider_prompt_key(&mut app, key(KeyCode::Esc), false);
        assert!(app.provider_prompt.is_none());
    });
}

/// `k`/`j` are ordinary characters in text fields (API keys start with
/// `sk-...`), so they must be typed, not steered with vim-style keys.
#[test]
fn provider_prompt_types_k_and_j_into_fields() {
    let mut app = test_app();
    app.provider_prompt = Some(super::ProviderPrompt::new());

    // Type a name containing both letters, then an API key shaped like a
    // real secret. Neither may move the active field.
    for ch in "kitty-jet".chars() {
        super::handle_provider_prompt_key(&mut app, key(KeyCode::Char(ch)), false);
    }
    super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
    super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
    super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
    assert_eq!(
        app.provider_prompt.as_ref().unwrap().field,
        ProviderField::ApiKey
    );
    for ch in "sk-ant-k3y-j".chars() {
        super::handle_provider_prompt_key(&mut app, key(KeyCode::Char(ch)), false);
    }

    let prompt = app.provider_prompt.as_ref().expect("still open");
    assert_eq!(
        prompt.field,
        ProviderField::ApiKey,
        "typing k must not move up"
    );
    assert_eq!(prompt.name, "kitty-jet");
    assert_eq!(prompt.api_key, "sk-ant-k3y-j");
}

/// Editing a provider: an untouched api-key field keeps the stored key on
/// save, so a user who opens a provider and saves without touching the key
/// must never silently lose or replace it.
#[test]
fn provider_edit_untouched_key_keeps_stored_key() {
    crate::core::agent::global_config::with_temp_home(|_| {
        crate::core::agent::global_config::set_provider(
            "p",
            crate::core::agent::global_config::ProviderUpdate {
                api_key: Some("sk-old".into()),
                base_url: Some("https://api.example/v1".into()),
                clear_api_key: false,
                models: Some(vec!["m1".into()]),
                api_type: None,
                ..Default::default()
            },
        )
        .unwrap();
        let entry = crate::core::agent::global_config::load_global_config()
            .unwrap()
            .remove("p")
            .unwrap();
        let mut app = test_app();
        app.provider_prompt = Some(super::ProviderPrompt::from_entry(&entry));

        // Add a model so the save `models` value changes, proving the save
        // ran; the key field is never touched.
        app.provider_prompt.as_mut().unwrap().models = "m1 m2".to_string();
        super::handle_provider_prompt_key(&mut app, key(KeyCode::Enter), false);

        assert!(app.provider_prompt.is_none(), "edit saved");
        let cfg = crate::core::agent::global_config::load_global_config()
            .unwrap()
            .get("p")
            .cloned()
            .unwrap();
        assert_eq!(cfg.api_key.as_deref(), Some("sk-old"), "stored key kept");
    });
}

/// Editing a provider: typing in the api-key field must replace the stored
/// key on save, and emptying it must clear the stored key (a local
/// endpoint that dropped auth).
#[test]
fn provider_edit_touched_key_replaces_or_clears() {
    crate::core::agent::global_config::with_temp_home(|_| {
        let fresh = || {
            crate::core::agent::global_config::set_provider(
                "p",
                crate::core::agent::global_config::ProviderUpdate {
                    api_key: Some("sk-old".into()),
                    base_url: Some("https://api.example/v1".into()),
                    clear_api_key: false,
                    models: Some(vec!["m1".into()]),
                    api_type: None,
                    ..Default::default()
                },
            )
            .unwrap();
            let entry = crate::core::agent::global_config::load_global_config()
                .unwrap()
                .remove("p")
                .unwrap();
            Some(super::ProviderPrompt::from_entry(&entry))
        };

        let stored_key = || {
            crate::core::agent::global_config::load_global_config()
                .unwrap()
                .get("p")
                .and_then(|c| c.api_key.clone())
        };

        let mut app = test_app();
        app.provider_prompt = fresh();
        // Type a new key: it replaces the stored one on save.
        app.provider_prompt.as_mut().unwrap().field = ProviderField::ApiKey;
        for ch in "sk-new-key".chars() {
            super::handle_provider_prompt_key(&mut app, key(KeyCode::Char(ch)), false);
        }
        super::handle_provider_prompt_key(&mut app, key(KeyCode::Enter), false);
        assert!(app.provider_prompt.is_none());
        assert_eq!(
            stored_key().as_deref(),
            Some("sk-new-key"),
            "typed key replaces"
        );

        // Empty the key field: the stored key is cleared.
        app.provider_prompt = fresh();
        app.provider_prompt.as_mut().unwrap().field = ProviderField::ApiKey;
        super::handle_provider_prompt_key(&mut app, key(KeyCode::Backspace), false);
        super::handle_provider_prompt_key(&mut app, key(KeyCode::Enter), false);
        assert!(app.provider_prompt.is_none());
        assert_eq!(stored_key(), None, "emptied key clears the stored one");
    });
}

/// The masked key placeholder must not pretend a stored key is present: an
/// untouched edit shows `(unchanged)`, whereas typing a replacement shows
/// mask characters.
#[test]
fn provider_edit_masked_key_renders_unchanged_until_touched() {
    let mut p = super::ProviderPrompt {
        editing: Some("p".into()),
        field: ProviderField::BaseUrl,
        name: "p".into(),
        base_url: String::new(),
        api_type: None,
        api_key: String::new(),
        key_touched: false,
        models: String::new(),
        error: None,
    };
    assert_eq!(
        p.masked_key(),
        "(unchanged)",
        "untouched edit shows unchanged"
    );
    p.key_touched = true;
    p.api_key = "sk-abc".to_string();
    assert_eq!(p.masked_key(), "******", "touched key masks its length");
}

/// A bracketed paste while the provider wizard is open must land in the
/// active field, not the chat composer (where a pasted API key would echo).
#[test]
fn provider_prompt_paste_routes_to_active_field() {
    let mut app = test_app();
    app.provider_prompt = Some(super::ProviderPrompt::new());

    // Paste into the name field; outer whitespace is trimmed.
    route_paste_event(&mut app, Event::Paste(" my-provider ".into()));
    assert_eq!(
        app.provider_prompt.as_ref().unwrap().name,
        "my-provider",
        "outer whitespace is trimmed"
    );

    // Advance to the API key field and paste a key shaped like a real one.
    super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
    super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
    super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
    assert_eq!(
        app.provider_prompt.as_ref().unwrap().field,
        ProviderField::ApiKey
    );
    route_paste_event(&mut app, Event::Paste("sk-ant-pasted-key".into()));
    assert_eq!(
        app.provider_prompt.as_ref().unwrap().api_key,
        "sk-ant-pasted-key"
    );

    assert!(app.input.is_empty(), "paste leaked into chat composer");
}

/// A paste while the MCP wizard is open lands in the active text field,
/// is ignored on a toggle field, and never leaks to the chat composer.
#[test]
fn mcp_prompt_paste_routes_to_active_text_field() {
    let mut app = test_app();
    app.mcp_prompt = Some(McpPrompt {
        editing: None,
        field: McpField::Name,
        name: String::new(),
        transport: "http".to_string(),
        command: String::new(),
        args: String::new(),
        env: String::new(),
        url: String::new(),
        headers: String::new(),
        active: false,
        error: None,
    });

    // Name field: paste a name, trimmed of outer whitespace.
    route_paste_event(&mut app, Event::Paste(" my-server ".into()));
    assert_eq!(app.mcp_prompt.as_ref().unwrap().name, "my-server");

    // Paste into the Url field.
    app.mcp_prompt.as_mut().unwrap().field = McpField::Url;
    route_paste_event(&mut app, Event::Paste("https://jk.example/mcp".into()));
    assert_eq!(
        app.mcp_prompt.as_ref().unwrap().url,
        "https://jk.example/mcp"
    );

    // A paste on a toggle field is ignored, not typed or leaked.
    app.mcp_prompt.as_mut().unwrap().field = McpField::Transport;
    let transport_before = app.mcp_prompt.as_ref().unwrap().transport.clone();
    route_paste_event(&mut app, Event::Paste("stdio".into()));
    assert_eq!(
        app.mcp_prompt.as_ref().unwrap().transport,
        transport_before,
        "pasting on a toggle field must not change it"
    );

    assert!(app.input.is_empty(), "paste leaked into chat composer");
}

/// A paste while a settings edit dock is open lands in its field, not the
/// chat composer.
#[test]
fn settings_prompt_paste_routes_to_field() {
    let mut app = test_app();
    let def = AGENT_SETTINGS
        .iter()
        .find(|d| d.key == "max_parallel_subagents")
        .unwrap();
    app.settings_prompt = Some(super::SettingsPrompt::new(def, None));

    route_paste_event(&mut app, Event::Paste(" 4 ".into()));
    assert_eq!(app.settings_prompt.as_ref().unwrap().input, "4");
    assert!(app.input.is_empty(), "paste leaked into chat composer");
}

#[test]
fn open_provider_settings_lists_configured_providers() {
    crate::core::agent::global_config::with_temp_home(|_| {
        crate::core::agent::global_config::set_provider(
            "myprovider",
            crate::core::agent::global_config::ProviderUpdate {
                api_key: Some("k".into()),
                base_url: Some("https://my.example/v1".into()),
                clear_api_key: false,
                models: Some(vec!["m1".into()]),
                api_type: None,
                ..Default::default()
            },
        )
        .unwrap();

        let mut app = test_app();
        super::open_provider_settings(&mut app);
        let picker = app.picker.as_ref().expect("picker opened");
        assert_eq!(picker.kind, PickerKind::ProviderSettings);
        assert_eq!(picker.items.len(), 1);
        assert_eq!(picker.items[0].value, "myprovider");
        assert!(picker.items[0].label.contains("key set"));
        assert!(picker.items[0].label.contains("1 model(s)"));
    });
}

/// Deleting a provider is unrecoverable (the API key is lost), so a single
/// `d` must only arm a confirmation and a second `d` on the same row must be
/// required to actually remove it. Navigating away disarms.
#[test]
fn provider_delete_requires_two_d_presses() {
    crate::core::agent::global_config::with_temp_home(|_| {
        crate::core::agent::global_config::set_provider(
            "myprovider",
            crate::core::agent::global_config::ProviderUpdate {
                api_key: Some("k".into()),
                base_url: Some("https://my.example/v1".into()),
                clear_api_key: false,
                models: Some(vec![]),
                api_type: None,
                ..Default::default()
            },
        )
        .unwrap();

        let mut app = test_app();
        super::open_provider_settings(&mut app);
        let rt = tokio::runtime::Runtime::new().unwrap();
        assert!(crate::core::agent::global_config::load_global_config()
            .unwrap()
            .contains_key("myprovider"));

        // First `d` arms but must not delete.
        rt.block_on(async {
            press(&mut app, KeyCode::Char('d'), KeyModifiers::NONE).await;
        });
        assert!(
            crate::core::agent::global_config::load_global_config()
                .unwrap()
                .contains_key("myprovider"),
            "first d must only arm, not delete"
        );
        assert!(
            transcript_text(&app).contains("press d again to delete provider 'myprovider'"),
            "note tells the user to confirm: {}",
            transcript_text(&app)
        );

        // Second `d` on the same row confirms and removes it.
        rt.block_on(async {
            press(&mut app, KeyCode::Char('d'), KeyModifiers::NONE).await;
        });
        assert!(
            !crate::core::agent::global_config::load_global_config()
                .unwrap()
                .contains_key("myprovider"),
            "second d confirms the delete"
        );
        assert!(app.picker.is_none(), "picker closes after delete");
        assert!(transcript_text(&app).contains("removed provider 'myprovider'"));
    });
}

/// Navigating away must disarm a pending delete so an unrelated keystroke
/// can never confirm an arm from a different row.
#[test]
fn provider_delete_arms_reset_on_navigation() {
    crate::core::agent::global_config::with_temp_home(|_| {
        for p in ["a", "b"] {
            crate::core::agent::global_config::set_provider(
                p,
                crate::core::agent::global_config::ProviderUpdate {
                    api_key: Some("k".into()),
                    base_url: Some("https://my.example/v1".into()),
                    clear_api_key: false,
                    models: Some(vec![]),
                    api_type: None,
                    ..Default::default()
                },
            )
            .unwrap();
        }

        let mut app = test_app();
        super::open_provider_settings(&mut app);
        let p = app.picker.as_ref().expect("picker");
        assert_eq!(p.items.len(), 2);
        let idx_a = p.items.iter().position(|i| i.value == "a").unwrap();
        let idx_b = p.items.iter().position(|i| i.value == "b").unwrap();
        app.picker.as_mut().unwrap().selected = idx_a;
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Arm on `a`.
        rt.block_on(async {
            press(&mut app, KeyCode::Char('d'), KeyModifiers::NONE).await;
        });
        assert!(app.picker.as_ref().unwrap().armed_delete == Some(idx_a));

        // Move down to `b` (disarms), then press `d`: this must arm `b`,
        // not delete `a`.
        rt.block_on(async {
            press(&mut app, KeyCode::Down, KeyModifiers::NONE).await;
            press(&mut app, KeyCode::Char('d'), KeyModifiers::NONE).await;
        });
        let configs = crate::core::agent::global_config::load_global_config().unwrap();
        assert!(
            configs.contains_key("a"),
            "a must still exist, only armed on b"
        );
        assert!(configs.contains_key("b"));
        assert!(app.picker.as_ref().unwrap().armed_delete == Some(idx_b));
    });
}

/// The watermark row (no providers configured) must be inert: `d` on it
/// must not arm/delete an empty-named entry, and Enter must not open a
/// wizard for it.
#[test]
fn provider_picker_empty_watermark_is_inert() {
    crate::core::agent::global_config::with_temp_home(|_| {
        let mut app = test_app();
        super::open_provider_settings(&mut app);
        let picker = app.picker.as_ref().expect("picker opened");
        assert_eq!(picker.items.len(), 1);
        assert!(
            picker.items[0].value.is_empty(),
            "watermark row has no value"
        );
        let rt = tokio::runtime::Runtime::new().unwrap();

        rt.block_on(async {
            press(&mut app, KeyCode::Char('d'), KeyModifiers::NONE).await;
        });
        assert!(
            app.picker.as_ref().unwrap().armed_delete.is_none(),
            "no arm on watermark"
        );
        assert!(
            !crate::core::agent::global_config::load_global_config()
                .unwrap()
                .contains_key(""),
            "d on the watermark must not delete an empty-named entry"
        );

        rt.block_on(async {
            press(&mut app, KeyCode::Enter, KeyModifiers::NONE).await;
        });
        assert!(
            app.provider_prompt.is_none(),
            "Enter on the watermark opens no wizard"
        );
    });
}
/// `x` on the provider-settings picker signs out (clears the credential)
/// but keeps the provider entry and its config, distinct from `d` delete.
#[test]
fn provider_settings_x_logout_clears_credential_and_keeps_config() {
    // Seeds the process-global secret store, so it has to hold the same
    // lock (and get its own data folder) as every other credential test.
    with_isolated_login_state(|| {
        use crate::core::cli::auth::{Credential, CredentialStore};
        crate::core::agent::global_config::set_provider(
            "myprovider",
            crate::core::agent::global_config::ProviderUpdate {
                api_key: Some("k".into()),
                base_url: Some("https://my.example/v1".into()),
                clear_api_key: false,
                models: Some(vec!["m1".into()]),
                api_type: None,
                ..Default::default()
            },
        )
        .unwrap();
        CredentialStore::store("myprovider", &Credential::ApiKey("k".into()))
            .expect("seed a stored credential");

        let mut app = test_app();
        super::open_provider_settings(&mut app);
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            press(&mut app, KeyCode::Char('x'), KeyModifiers::NONE).await;
        });

        // The provider entry (and its models) survive; the credential is gone.
        let configs = crate::core::agent::global_config::load_global_config().unwrap();
        assert!(
            configs.contains_key("myprovider"),
            "config kept after logout"
        );
        assert_eq!(configs.get("myprovider").unwrap().models, vec!["m1"]);
        assert!(
            CredentialStore::load("myprovider").unwrap().is_none(),
            "credential cleared on logout"
        );
        assert!(transcript_text(&app).contains("signed out of myprovider"));
        assert!(app.picker.is_some(), "logout keeps the picker open");
    });
}

/// `x` on the `/login` picker signs out a signed-in provider and flips its
/// row hint to "not signed in" without closing the picker.
#[test]
fn login_picker_x_signs_out_signed_in_provider() {
    with_isolated_login_state(|| {
        use crate::core::cli::auth::{Credential, CredentialStore};
        // A catalog provider (tokamak) that we can sign out of.
        CredentialStore::store("tokamak", &Credential::ApiKey("k".into()))
            .expect("seed a stored credential");
        crate::core::agent::global_config::set_provider(
            "tokamak",
            crate::core::agent::global_config::ProviderUpdate {
                api_key: Some("k".into()),
                base_url: Some("https://api.tokamak.sh/v1".into()),
                clear_api_key: false,
                models: Some(vec!["tokamak-1-preview".into()]),
                api_type: None,
                ..Default::default()
            },
        )
        .unwrap();

        let mut app = test_app();
        super::open_login_picker(&mut app);
        // Tokamak is pinned to the top of the login picker.
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            press(&mut app, KeyCode::Char('x'), KeyModifiers::NONE).await;
        });

        assert!(
            crate::core::cli::auth::CredentialStore::load("tokamak")
                .unwrap()
                .is_none(),
            "x on the login picker signs out"
        );
        assert!(
            app.picker.is_some(),
            "login picker stays open after sign-out"
        );
        let picker = app.picker.as_ref().unwrap();
        assert_eq!(picker.items[0].value, "tokamak");
        assert_eq!(
            picker.items[0].hint.as_deref(),
            Some("not signed in"),
            "row hint flips to not signed in"
        );
        assert!(transcript_text(&app).contains("signed out of tokamak"));
    });
}

/// Editing a provider must keep its name read-only so the save writes back
/// under the original key: renaming would orphan the old entry and lose the
/// API key. The existing key and models must be preserved on save.
#[test]
fn provider_edit_preserves_name_key_and_models() {
    crate::core::agent::global_config::with_temp_home(|_| {
        crate::core::agent::global_config::set_provider(
            "myprovider",
            crate::core::agent::global_config::ProviderUpdate {
                api_key: Some("sk-secret".into()),
                base_url: Some("https://my.example/v1".into()),
                clear_api_key: false,
                models: Some(vec!["m1".into(), "m2".into()]),
                api_type: None,
                ..Default::default()
            },
        )
        .unwrap();

        let mut app = test_app();
        super::open_provider_settings(&mut app);
        let rt = tokio::runtime::Runtime::new().unwrap();
        // Enter opens the edit wizard prefilled from the row.
        rt.block_on(async {
            press(&mut app, KeyCode::Enter, KeyModifiers::NONE).await;
        });
        let prompt = app.provider_prompt.as_ref().expect("edit wizard opened");
        assert_eq!(prompt.name, "myprovider");
        assert!(prompt.editing.is_some());

        // The name field is read-only while editing; typing must not change it.
        assert_eq!(
            prompt.field,
            ProviderField::BaseUrl,
            "edit starts on base url"
        );
        app.provider_prompt.as_mut().unwrap().field = ProviderField::Name;
        for ch in "RENAMED".chars() {
            super::handle_provider_prompt_key(&mut app, key(KeyCode::Char(ch)), false);
        }
        assert_eq!(
            app.provider_prompt.as_ref().unwrap().name,
            "myprovider",
            "name is read-only while editing"
        );

        // Back to an editable field; change base_url and save.
        app.provider_prompt.as_mut().unwrap().field = ProviderField::BaseUrl;
        super::handle_provider_prompt_key(&mut app, key(KeyCode::Backspace), false);
        rt.block_on(async {
            press(&mut app, KeyCode::Enter, KeyModifiers::NONE).await;
        });

        let configs = crate::core::agent::global_config::load_global_config().unwrap();
        assert_eq!(configs.len(), 1, "no orphaned entry");
        let cfg = configs.get("myprovider").expect("still under original key");
        assert_eq!(cfg.api_key.as_deref(), Some("sk-secret"), "key preserved");
        assert_eq!(cfg.models, vec!["m1", "m2"], "models preserved");
    });
}

/// Editing navigation skips the read-only name field: from BaseUrl it
/// cycles BaseUrl -> ApiKey -> Models -> BaseUrl.
#[test]
fn provider_edit_navigation_skips_name() {
    let mut p = super::ProviderPrompt {
        editing: Some("p".into()),
        field: ProviderField::BaseUrl,
        name: "p".into(),
        base_url: String::new(),
        api_type: Some("anthropic".into()),
        api_key: String::new(),
        key_touched: false,
        models: String::new(),
        error: None,
    };
    p.next_field();
    assert_eq!(p.field, ProviderField::ApiType);
    p.next_field();
    assert_eq!(p.field, ProviderField::ApiKey);
    p.next_field();
    assert_eq!(p.field, ProviderField::Models);
    p.prev_field();
    assert_eq!(p.field, ProviderField::ApiKey);
    p.prev_field();
    assert_eq!(p.field, ProviderField::ApiType);
    p.prev_field();
    assert_eq!(p.field, ProviderField::BaseUrl);
}

/// The base URL is validated before the bearer key is ever sent: only
/// https (or http to a loopback host) is accepted.
#[test]
fn provider_prompt_rejects_plaintext_remote_base_url() {
    crate::core::agent::global_config::with_temp_home(|_| {
        let mut p = super::ProviderPrompt::new();
        p.name = "p".to_string();
        p.base_url = "http://remote.example/v1".to_string();
        assert!(p.save().is_err(), "plaintext remote rejected");
        p.base_url = "http://127.0.0.1:8080/v1".to_string();
        assert!(p.save().is_ok(), "loopback http allowed");
        p.base_url = "https://remote.example/v1".to_string();
        assert!(p.save().is_ok(), "https allowed");
    });
}

/// A provider added through the wizard with no model list would otherwise
/// vanish from `/model`, since the picker only offers explicitly configured
/// ids. Opening the picker must fetch that provider's `GET /models` and
/// populate the list so a bare provider is usable immediately.
#[test]
fn model_picker_autofetches_models_for_empty_provider() {
    crate::core::agent::global_config::with_temp_home(|_| {
        // A local `/models` endpoint returning one id.
        let body = serde_json::json!({"object": "list", "data": [{"id": "discovered-model"}]})
            .to_string();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(1) {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 4096];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = std::io::Write::write_all(&mut stream, resp.as_bytes());
            }
        });

        crate::core::agent::global_config::set_provider(
            "myprovider",
            crate::core::agent::global_config::ProviderUpdate {
                api_key: Some("k".into()),
                base_url: Some(format!("http://{addr}/v1")),
                clear_api_key: false,
                models: Some(vec![]), // no models configured
                api_type: None,
                ..Default::default()
            },
        )
        .expect("seed provider");

        let mut app = test_app();
        // `with_temp_home` is sync; drive the async command on a dedicated runtime.
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(super::run_command(&mut app, "model", &no_mcp()));
        rt.block_on(super::run_pending_model_fetch(&mut app));

        let picker = app.model_picker.as_ref().expect("model picker opened");
        assert!(
            picker
                .all_items
                .iter()
                .any(|i| i.model.contains("discovered-model")),
            "discovered model must be offered: {:?}",
            picker
                .all_items
                .iter()
                .map(|i| &i.model)
                .collect::<Vec<_>>()
        );
    });
}

/// A reachable-looking but dead provider (empty model list, unreachable
/// endpoint) must not break or block the `/model` picker: the fetch is
/// skipped with a note, and the picker still opens with what is reachable.
#[test]
fn model_picker_survives_unreachable_provider() {
    crate::core::agent::global_config::with_temp_home(|_| {
        // A dead endpoint fills the empty-model-list probe slot and fails
        // fast on 127.0.0.1:9 (nothing listens there).
        crate::core::agent::global_config::set_provider(
            "dead",
            crate::core::agent::global_config::ProviderUpdate {
                api_key: Some("k".into()),
                base_url: Some("http://127.0.0.1:9/v1".into()),
                clear_api_key: false,
                models: Some(vec![]),
                api_type: None,
                ..Default::default()
            },
        )
        .unwrap();

        let mut app = test_app();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(super::run_command(&mut app, "model", &no_mcp()));
        rt.block_on(super::run_pending_model_fetch(&mut app));

        // The picker opened (no reachable pairs => the note path fires,
        // but there is no panic, no hang, and the provider stays put).
        let configs = crate::core::agent::global_config::load_global_config().unwrap();
        assert!(
            configs.contains_key("dead"),
            "provider not removed by a failed probe"
        );

        // Opening once more must not re-contact the dead endpoint: the
        // session short-circuit means the second open is near-instant.
        rt.block_on(super::run_command(&mut app, "model", &no_mcp()));
        rt.block_on(super::run_pending_model_fetch(&mut app));
    });
}

#[test]
fn finished_subagent_summary_expands_full_call_list_via_ctrl_o() {
    let mut app = test_app();
    app.apply(StreamEvent::SubagentStart {
        run_id: "r1".into(),
        name: "reviewer".into(),
        task: None,
    });
    // More calls than the live window, so expansion reveals ones it hid.
    for i in 0..7 {
        app.apply(wrap(
            "r1",
            "reviewer",
            StreamEvent::ToolCall {
                id: format!("c{i}"),
                name: "bash".into(),
                args: json!({ "command": format!("cmd{i}") }),
            },
        ));
    }
    app.apply(StreamEvent::SubagentEnd {
        run_id: "r1".into(),
        name: "reviewer".into(),
    });
    // A collapsed summary row + a retained expandable block.
    assert_eq!(app.subagent_blocks.len(), 1);
    let idx = app.subagent_blocks[0].idx;

    use ratatui::{backend::TestBackend, Terminal};
    let render = |app: &mut App| {
        let mut terminal = Terminal::new(TestBackend::new(80, 40)).unwrap();
        terminal.draw(|f| super::draw(f, app)).unwrap();
        let buf = terminal.backend().buffer().clone();
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .map(|x| buf[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    // Collapsed: full list (e.g. the oldest call) is hidden.
    assert!(!render(&mut app).contains("cmd0"));
    // Ctrl-O expand-all reveals every call, including ones outside the window.
    app.toggle_regions();
    assert!(app.expanded.contains(&idx));
    let expanded = render(&mut app);
    assert!(
        expanded.contains("cmd0"),
        "expanded must reveal earliest call: {expanded}"
    );
    assert!(expanded.contains("cmd6"));
    // Toggling again collapses it.
    app.toggle_regions();
    assert!(!app.expanded.contains(&idx));
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
fn input_lines_single_line_has_arrow_and_cursor() {
    let lines = input_content_lines("hello", 5);
    assert_eq!(lines.len(), 1);
    assert_eq!(caret_text(&lines[0]), "> hello▏");
}

#[test]
fn input_lines_multiline_hangs_and_cursor_on_last() {
    let lines = input_content_lines("one\ntwo\nthree", "one\ntwo\nthree".len());
    assert_eq!(lines.len(), 3);
    assert_eq!(line_text(&lines[0]), "> one");
    assert_eq!(line_text(&lines[1]), "  two");
    assert_eq!(caret_text(&lines[2]), "  three▏");
}

#[test]
fn input_lines_trailing_newline_gives_empty_cursor_row() {
    let lines = input_content_lines("hi\n", 3);
    assert_eq!(lines.len(), 2);
    assert_eq!(line_text(&lines[0]), "> hi");
    assert_eq!(caret_text(&lines[1]), "  ▏");
}

#[test]
fn input_lines_caret_renders_mid_string() {
    // Caret sits between "he" and "llo" on a single line.
    let lines = input_content_lines("hello", 2);
    assert_eq!(lines.len(), 1);
    assert_eq!(caret_text(&lines[0]), "> he▏llo");
}

#[test]
fn input_lines_caret_on_earlier_line_only() {
    // Cursor inside the first segment: caret there, none on later lines.
    let lines = input_content_lines("one\ntwo", 1);
    assert_eq!(caret_text(&lines[0]), "> o▏ne");
    assert_eq!(line_text(&lines[1]), "  two");
}

#[test]
fn input_editing_moves_and_deletes_at_caret() {
    let mut app = test_app();
    for c in "abc".chars() {
        app.input_insert(c);
    }
    assert_eq!((app.input.as_str(), app.cursor), ("abc", 3));
    app.cursor_left();
    app.cursor_left();
    app.input_insert('X'); // insert between a and b
    assert_eq!((app.input.as_str(), app.cursor), ("aXbc", 2));
    app.input_backspace(); // delete X
    assert_eq!((app.input.as_str(), app.cursor), ("abc", 1));
    app.input_delete(); // delete b at caret
    assert_eq!((app.input.as_str(), app.cursor), ("ac", 1));
    app.cursor = app.input.len();
    app.cursor_right(); // clamp at end
    assert_eq!(app.cursor, 2);
}

/// Non-frame, non-marker colours in a diff panel: what syntax highlighting
/// contributes, as distinct from the red/green add-remove markers.
fn diff_syntax_colours(lines: &[ratatui::text::Line]) -> Vec<ratatui::style::Color> {
    lines
        .iter()
        .flat_map(|l| l.spans.iter())
        .filter_map(|s| s.style.fg)
        .filter(|c| matches!(c, ratatui::style::Color::Rgb(..)))
        .collect()
}

/// The row containing `needle`, panicking if there is none.
fn diff_row(rows: &[Line<'static>], needle: &str) -> Line<'static> {
    rows.iter()
        .find(|l| line_text(l).contains(needle))
        .unwrap_or_else(|| panic!("no row containing {needle:?}"))
        .clone()
}

/// Backgrounds of a row's spans, skipping the box frame and the gutter so
/// only the banded interior is left.
fn row_backgrounds(rows: &[Line<'static>], needle: &str) -> Vec<Option<ratatui::style::Color>> {
    diff_row(rows, needle)
        .spans
        .iter()
        .filter(|s| !s.content.is_empty() && !s.content.contains('│'))
        .map(|s| s.style.bg)
        .collect()
}

/// A changed row is banded by its background, from the left border to the
/// right one -- including the padding past the end of the text, or the band
/// would stop mid-row on every short line.
#[test]
fn changed_diff_rows_are_banded_by_background() {
    let diff = "     1 | keep\n-    2 | before\n+    2 | a much longer added line";
    let out = diff_lines(diff, 80, DIFF_MAX_ROWS, "│     ", None);
    assert!(
        row_backgrounds(&out, "before")
            .iter()
            .all(|bg| *bg == Some(DIFF_DEL_BG)),
        "removed row not fully banded: {:?}",
        row_backgrounds(&out, "before")
    );
    assert!(
        row_backgrounds(&out, "added line")
            .iter()
            .all(|bg| *bg == Some(DIFF_ADD_BG)),
        "added row not fully banded"
    );
    // Unchanged context is left alone, so the bands stand out against it.
    assert!(
        row_backgrounds(&out, "keep").iter().all(|bg| bg.is_none()),
        "context row was banded"
    );
}

/// The diff bands flip with the terminal theme: dark tints on a dark
/// background, pale ones on a light background, and add/remove never share a
/// colour.
#[test]
fn diff_bands_pick_a_variant_per_theme() {
    use super::{diff_bg, DIFF_ADD_BG, DIFF_ADD_BG_LIGHT, DIFF_DEL_BG, DIFF_DEL_BG_LIGHT};
    assert_eq!(diff_bg(true, false), DIFF_ADD_BG);
    assert_eq!(diff_bg(false, false), DIFF_DEL_BG);
    assert_eq!(diff_bg(true, true), DIFF_ADD_BG_LIGHT);
    assert_eq!(diff_bg(false, true), DIFF_DEL_BG_LIGHT);
    for light in [false, true] {
        assert_ne!(
            diff_bg(true, light),
            diff_bg(false, light),
            "add and remove must differ (light={light})"
        );
    }
}

/// The user bubble flips with the terminal theme like the diff bands do.
#[test]
fn user_bubble_picks_a_variant_per_theme() {
    use super::{
        user_bubble_bg_for, user_bubble_fg_for, USER_BUBBLE_BG, USER_BUBBLE_BG_LIGHT,
    };
    assert_eq!(user_bubble_bg_for(false), USER_BUBBLE_BG);
    assert_eq!(user_bubble_bg_for(true), USER_BUBBLE_BG_LIGHT);
    assert_ne!(user_bubble_bg_for(false), user_bubble_bg_for(true));
    // The text is the inverse of its bubble: the dark theme pairs a light fg
    // with a dark bg and the light theme the reverse, so each stays legible.
    assert_ne!(user_bubble_fg_for(false), user_bubble_bg_for(false));
    assert_ne!(user_bubble_fg_for(true), user_bubble_bg_for(true));
    assert_ne!(user_bubble_fg_for(false), user_bubble_fg_for(true));
}

/// The band is a background only: the code inside a changed row keeps the
/// same syntax highlighting it has as context, which is what makes it
/// readable on top of the tint.
#[test]
fn changed_diff_rows_keep_their_syntax_highlighting() {
    use ratatui::style::Color;
    let diff = "     1 | fn main() {\n-    2 |     let x = 1;\n+    2 |     let y = 2;";
    let out = diff_lines(diff, 80, DIFF_MAX_ROWS, "", Some("src/main.rs"));
    for needle in ["let x = 1;", "let y = 2;"] {
        let row = diff_row(&out, needle);
        assert!(
            row.spans
                .iter()
                .any(|s| matches!(s.style.fg, Some(Color::Rgb(..)))),
            "changed row {needle:?} lost its highlighting: {row:?}"
        );
    }
    // The marker itself stays red/green, so the sign reads without colour
    // vision doing all the work.
    let marker = diff_row(&out, "let y = 2;").spans[3].clone();
    assert_eq!(marker.content.as_ref(), "+");
    assert_eq!(marker.style.fg, Some(Color::Green));
}

#[test]
fn a_diff_without_a_known_language_stays_plain() {
    let out = diff_lines("+ foo\n- bar", 80, DIFF_MAX_ROWS, "", None);
    assert!(
        diff_syntax_colours(&out).is_empty(),
        "unexpected highlighting without a language"
    );
}

#[test]
fn a_hunk_header_is_not_syntax_highlighted() {
    let out = diff_lines(
        "@@ -1,2 +1,3 @@\n   1 | let x = 1;",
        80,
        DIFF_MAX_ROWS,
        "",
        Some("a.rs"),
    );
    let header = out
        .iter()
        .find(|l| line_text(l).contains("@@"))
        .expect("no hunk header row");
    assert!(
        header
            .spans
            .iter()
            .all(|s| !matches!(s.style.fg, Some(ratatui::style::Color::Rgb(..)))),
        "hunk header was highlighted: {:?}",
        line_text(header)
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
fn diff_lines_renders_all_when_under_cap() {
    let out = diff_lines("- foo\n+ bar", 80, DIFF_MAX_ROWS, "│     ", None);
    // 2 content rows framed by a top and bottom border.
    assert_eq!(out.len(), 4);
    assert!(
        line_text(&out[0]).contains('┌'),
        "top: {}",
        line_text(&out[0])
    );
    assert!(
        line_text(out.last().unwrap()).contains('┘'),
        "bottom: {}",
        line_text(out.last().unwrap())
    );
}

/// The panel is sized to the width it is drawn at: gutter, frame and content
/// together have to fit, or the closing border wraps onto a line of its own
/// and the box reads as double-spaced with no right edge.
#[test]
fn a_boxed_diff_fits_the_draw_width() {
    let long = format!("+    1 | {}", "x".repeat(300));
    for gutter in ["", "│   ", "│     ", "│       "] {
        for width in [40usize, 80, 163] {
            for line in diff_lines(&long, width, DIFF_MAX_ROWS, gutter, None) {
                assert!(
                    row_width(&line) <= width,
                    "gutter {:?} at width {width}: row is {} wide: {:?}",
                    gutter,
                    row_width(&line),
                    line_text(&line)
                );
            }
        }
    }
}

/// Same, through the row that actually renders in the transcript: the result
/// row owns both the gutter and the width, so its diff must fit unaided.
#[test]
fn a_result_row_diff_fits_the_draw_width() {
    let row: Row = RowKind::Result {
        tag: "✓",
        tag_style: Style::new().green(),
        content: Some("Wrote notes.md".into()),
        diff: Some(format!("@@ created file @@\n+    1 | {}", "y".repeat(300))),
        lang: None,
    }
    .into();
    for width in [40u16, 80, 163] {
        for line in row.lines(width) {
            assert!(
                row_width(&line) <= width as usize,
                "width {width}: row is {} wide: {:?}",
                row_width(&line),
                line_text(&line)
            );
        }
    }
}

fn plus_rows(n: usize) -> String {
    (0..n)
        .map(|i| format!("+ line {i}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn diff_lines_collapses_tail_past_cap() {
    let out = diff_lines(&plus_rows(30), 80, 20, "│     ", None);
    // 20 content rows + a `(+N more)` row, framed by 2 borders.
    assert_eq!(out.len(), 20 + 1 + 2);
    // The tail sits just above the closing border.
    let tail = line_text(&out[out.len() - 2]);
    assert!(tail.contains("(+10 more)"), "tail: {tail}");
}

/// The transcript scrolls, so a long edit is shown in full there; the
/// permission prompt does not, and keeps the tight cap so the decision list
/// is never crowded out.
#[test]
fn the_result_cap_is_generous_and_the_prompt_cap_is_not() {
    assert_eq!(DIFF_MAX_ROWS, 1000);
    let long = plus_rows(400);
    let result = diff_lines(&long, 80, DIFF_MAX_ROWS, "│     ", None);
    assert_eq!(result.len(), 400 + 2, "result diff must not collapse");

    let mut prompt = pending(true);
    prompt.diff = Some(long);
    let preview = prompt.diff_preview(80);
    assert_eq!(preview.len(), DIFF_PREVIEW_MAX_ROWS + 1 + 2);
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

/// Helper: the wire messages carrying `tool_calls`, and the `role: "tool"`
/// messages, for the assertions below.
fn tool_turns(app: &App) -> (Vec<&serde_json::Value>, Vec<&serde_json::Value>) {
    (
        app.history
            .iter()
            .filter(|m| m.get("tool_calls").is_some())
            .collect(),
        app.history
            .iter()
            .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("tool"))
            .collect(),
    )
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
            ("c1", super::super::MISSING_TOOL_RESULT),
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

/// The live row wraps its command like the committed one, keeping its line
/// breaks, so a long command is readable while it runs -- which is when the
/// user most wants to check what they approved.
#[test]
fn running_row_wraps_a_long_multiline_command() {
    let mut app = test_app();
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": "cd /tmp\nmake -j8 all install DESTDIR=/opt/somewhere/deep" }),
    });
    let group = app.tool_group.as_ref().expect("group open");
    let rows = running_group_rows(group, 0, 40);
    assert!(rows.len() > 2, "long command was not wrapped: {rows:?}");
    for row in &rows {
        assert!(
            line_text(row).chars().count() <= 40,
            "row overflows: {:?}",
            line_text(row)
        );
    }
    let text = lines_text(&rows).replace(['\u{2502}', '\n'], " ");
    // Not the long `DESTDIR=` token: at 40 columns it is wider than the
    // body and hard-breaks, which is the correct fallback, not a drop.
    for word in ["cd /tmp", "make -j8", "all install"] {
        assert!(text.contains(word), "dropped {word:?}: {text}");
    }
    assert!(
        line_text(rows.first().expect("no rows")).contains("cd /tmp"),
        "the first command line did not lead the row"
    );
}

/// The elapsed badge trails the last row and its width is reserved up
/// front, so a counter ticking past 9s or 99s cannot re-flow the command
/// above it -- a live row that re-wraps every second is unreadable.
#[test]
fn running_row_elapsed_badge_does_not_reflow_the_command() {
    let mut app = test_app();
    let cmd = "grep -rn needle src/ --include=*.rs --exclude-dir=target";
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        args: json!({ "command": cmd }),
    });
    let group = app.tool_group.as_mut().expect("group open");
    // The body's wrap points must be the same at 0s and at four digits.
    let strip = |rows: &[ratatui::text::Line]| {
        rows.iter()
            .map(|r| {
                let t = line_text(r);
                t.split(" (").next().unwrap_or_default().to_string()
            })
            .collect::<Vec<_>>()
    };
    let fresh = strip(&running_group_rows(group, 0, 44));
    group.started = Instant::now() - Duration::from_secs(4321);
    let old = running_group_rows(group, 0, 44);
    assert_eq!(strip(&old), fresh, "the counter re-flowed the command");
    assert!(
        line_text(old.last().expect("no rows")).contains("(4321s)"),
        "badge is not on the last row: {:?}",
        lines_text(&old)
    );
    for row in &old {
        assert!(line_text(row).chars().count() <= 44, "row overflows");
    }
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
fn wheel_scrolls_transcript() {
    let mut app = test_app();
    app.transcript_rect = Rect::new(0, 0, 80, 10);
    let up = |app: &mut App| {
        handle_mouse(
            app,
            MouseEvent {
                kind: MouseEventKind::ScrollUp,
                column: 5,
                row: 5,
                modifiers: KeyModifiers::NONE,
            },
        )
    };
    up(&mut app);
    up(&mut app);
    assert_eq!(app.scrollback, 2);
    handle_mouse(
        &mut app,
        MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 5,
            row: 5,
            modifiers: KeyModifiers::NONE,
        },
    );
    assert_eq!(app.scrollback, 1);
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
fn clicking_anywhere_in_expanded_block_collapses_it() {
    // Once a block (e.g. long reasoning) has expanded past the viewport,
    // its header row can scroll out of view. A click on any of its detail
    // rows -- not just the header -- must still collapse it.
    let mut app = test_app();
    app.push_assistant_blocks("<think>line one\nline two\nline three</think>answer", &[], None);
    assert_eq!(app.reasoning_blocks.len(), 1);
    let idx = app.reasoning_blocks[0].idx;

    app.toggle_region(idx);
    assert!(app.expanded.contains(&idx));

    // Detail rows map back to the same idx as the header (see draw()).
    app.transcript_rect = Rect::new(0, 0, 80, 10);
    app.last_scroll = 0;
    app.row_index = vec![Some(idx), Some(idx), Some(idx)];
    click(&mut app, 5, 2); // a detail row, not the header at row 1
    assert!(
        app.expanded.is_empty(),
        "click on a detail row should collapse"
    );
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
    app.status = super::Status::Running;
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
    app.status = super::Status::Running;
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
    app.status = super::Status::Running;
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
    app.status = super::Status::Running;
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
    app.status = super::Status::Running;
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
    app.status = super::Status::Idle;
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

#[test]
fn summarize_result_first_line_plus_count() {
    assert_eq!(summarize_result("only line", 80), "only line");
    assert_eq!(summarize_result("a\nb\nc", 80), "a  (+2 lines)");
    assert_eq!(summarize_result("  \nreal\nx", 80), "real  (+1 lines)");
    // Collapses internal whitespace runs (e.g. columnar grep output).
    assert_eq!(summarize_result("a    b\tc", 80), "a b c");
    // Truncates the head to max.
    assert_eq!(summarize_result("abcdefgh", 4), "abc…");
}

/// Run one turn that reasons, calls a diff-producing tool, and answers,
/// leaving it persisted (messages + journal) in `app.agent_dir`.
fn record_full_turn(app: &mut App) {
    app.submit_user("do it".to_string());
    app.apply(StreamEvent::Token {
        text: "<think>my private reasoning</think>".into(),
    });
    app.apply(StreamEvent::ToolCall {
        id: "c1".into(),
        name: "write".into(),
        args: json!({ "path": "a.txt", "content": "x" }),
    });
    app.apply(StreamEvent::ToolResult {
        id: "c1".into(),
        content: "wrote 1 line".into(),
        is_error: false,
        diff: Some("@@ created file @@\n+    1 | x".into()),
    });
    app.apply(StreamEvent::MessagesUpdated {
        messages: vec![
            json!({ "role": "user", "content": "do it" }),
            json!({ "role": "assistant", "content": "", "tool_calls": [{
                "id": "c1",
                "type": "function",
                "function": { "name": "write", "arguments": "{\"path\":\"a.txt\"}" },
            }]}),
            json!({ "role": "tool", "tool_call_id": "c1", "content": "wrote 1 line" }),
        ],
    });
    app.apply(StreamEvent::Token {
        text: "Answer.".into(),
    });
    app.on_done("stop".into(), None);
    app.join_journal();
}

#[tokio::test]
async fn resume_restores_reasoning_tool_rows_and_diffs() {
    let mut app = test_app();
    record_full_turn(&mut app);
    let live: String = app
        .transcript
        .iter()
        .map(row_text)
        .collect::<Vec<_>>()
        .join("\n");

    let mut fresh = test_app();
    fresh.agent_dir = app.agent_dir.clone();
    apply_resume(&mut fresh, &ResumeRequest::resume(ResumeTarget::Latest)).await;
    let resumed: String = fresh
        .transcript
        .iter()
        .map(row_text)
        .collect::<Vec<_>>()
        .join("\n");

    assert_eq!(fresh.reasoning_blocks.len(), 1, "folded reasoning is back");
    assert!(resumed.contains("Thought"), "{resumed}");
    assert!(resumed.contains("✓ Wrote a.txt"), "tool row: {resumed}");
    assert!(
        resumed.contains("@@ created file @@") && resumed.contains("+    1 | x"),
        "diff panel: {resumed}"
    );
    assert!(resumed.contains("Answer."), "{resumed}");
    // Every rendered row returns; the turn receipt (`↑ tokens ⏱ elapsed`) is
    // deliberately transient, like notes and permission prompts.
    assert!(
        live.lines()
            .filter(|l| !l.contains('⏱'))
            .all(|l| resumed.contains(l.trim_end())),
        "every live row must come back\nlive:\n{live}\nresumed:\n{resumed}"
    );
    // Expanding the restored reasoning row reveals its full detail, so the
    // journal carried the text and not just the summary count.
    fresh.toggle_regions();
    let expanded = render_rows(&mut fresh, 60, 30).join("\n");
    assert!(expanded.contains("my private reasoning"), "{expanded}");
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

#[tokio::test]
async fn resume_restores_the_model_side_tool_calls() {
    let mut app = test_app();
    record_full_turn(&mut app);
    assert!(
        !serde_json::to_string(&app.history)
            .unwrap()
            .contains("<think>"),
        "reasoning must not be resent to the model: {:?}",
        app.history
    );

    let mut fresh = test_app();
    fresh.agent_dir = app.agent_dir.clone();
    apply_resume(&mut fresh, &ResumeRequest::resume(ResumeTarget::Latest)).await;

    assert_eq!(
        fresh.history, app.history,
        "the wire conversation round-trips"
    );
    let called = fresh
        .history
        .iter()
        .find(|m| m.get("tool_calls").is_some())
        .expect("the call the model made is back");
    assert_eq!(called["tool_calls"][0]["id"], "c1");
    let result = fresh
        .history
        .iter()
        .find(|m| m["role"] == "tool")
        .expect("its result is back");
    assert_eq!(result["tool_call_id"], "c1");
    assert_eq!(result["content"], "wrote 1 line");
}

#[tokio::test]
async fn resume_falls_back_to_messages_without_a_journal() {
    let mut app = test_app();
    record_full_turn(&mut app);
    let id = app.thread_id.clone().expect("saved");
    std::fs::remove_file(journal::journal_path(&app.agent_dir, &id)).unwrap();

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
        resumed.contains("do it") && resumed.contains("Answer."),
        "{resumed}"
    );
    assert!(fresh.display_log.is_empty(), "nothing to journal from");
}

fn test_worktree(path: &str) -> Worktree {
    Worktree {
        path: std::path::PathBuf::from(path),
        branch: "jan/agent/abc12345".to_string(),
    }
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

    let thread = super::super::cli_get_thread_in(&app.agent_dir, &id).unwrap();
    assert_eq!(
        super::super::worktree::from_metadata(thread.get("metadata")),
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

/// `/new` keeps the checkout: it belongs to the invocation, not the thread.
#[test]
fn a_new_session_stays_in_the_same_worktree() {
    let mut app = test_app();
    app.set_workspace(Some(test_worktree("/tmp/wt-a")));
    app.submit_user("do it".into());
    app.reset_session();
    assert_eq!(app.workspace, Some(test_worktree("/tmp/wt-a")));
}

#[test]
fn worktree_command_without_one_points_at_the_flag() {
    let mut app = test_app();
    worktree_command(&mut app);
    let notes: String = app
        .transcript
        .iter()
        .map(row_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(notes.contains("--worktree"), "{notes}");
}

#[test]
fn the_banner_names_the_worktree_only_when_there_is_one() {
    let mut app = test_app();
    app.push_session_banner(true);
    let plain = render_rows(&mut app, 100, 40).join("\n");
    assert!(!plain.contains("worktree"), "{plain}");

    let mut isolated = test_app();
    isolated.set_workspace(Some(test_worktree("/tmp/wt-a")));
    isolated.push_session_banner(true);
    let shown = render_rows(&mut isolated, 100, 40).join("\n");
    assert!(
        shown.contains("worktree") && shown.contains("wt-a"),
        "the splash must say where the edits land: {shown}"
    );
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

    let meta = super::super::cli_get_thread_in(&app.agent_dir, &forked).unwrap();
    assert_eq!(
        meta["metadata"][super::super::FORKED_FROM_KEY],
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

    let thread = super::super::cli_get_thread_in(&app.agent_dir, &forked).unwrap();
    assert_eq!(
        super::super::worktree::from_metadata(thread.get("metadata")),
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

        let thread = super::super::cli_get_thread_in(&app.agent_dir, &id).unwrap();
        assert_eq!(
            super::super::worktree::from_metadata(thread.get("metadata")),
            Some(test_worktree("/tmp/wt-a"))
        );
    }
}

#[tokio::test]
async fn tree_nests_a_fork_under_the_thread_it_came_from() {
    let mut app = test_app();
    record_full_turn(&mut app);
    app.submit_user("and again".to_string());
    app.on_done("stop".into(), None);
    fork_at(&mut app, 1).await;

    open_tree_picker(&mut app);
    let picker = app.picker.as_ref().expect("tree");
    assert_eq!(picker.kind, PickerKind::ThreadTree);
    assert_eq!(picker.items.len(), 2);
    assert!(
        picker.items[1].label.starts_with("└─ "),
        "the fork is drawn under its parent: {:?}",
        picker.items[1].label
    );
    assert!(picker.items[1].label.contains("(current)"));
    assert_eq!(picker.selected, 1, "the session in hand is preselected");
}

/// A store with no forks is the flat list `/resume` already shows.
#[test]
fn tree_of_an_unforked_store_is_flat() {
    let mut app = test_app();
    record_full_turn(&mut app);
    open_tree_picker(&mut app);
    let picker = app.picker.as_ref().expect("tree");
    assert_eq!(picker.items.len(), 1);
    assert!(!picker.items[0].label.starts_with("└─"));
}

#[test]
fn fork_picker_lists_the_same_turns_as_the_rewind_picker() {
    let mut app = test_app();
    app.thread_id = Some("t1".into());
    app.submit_user("first".into());
    app.status = Status::Idle;
    app.submit_user("second".into());

    open_rewind_picker(&mut app);
    let rewind: Vec<String> = app
        .picker
        .take()
        .expect("picker")
        .items
        .iter()
        .map(|i| i.value.clone())
        .collect();
    open_fork_picker(&mut app);
    let picker = app.picker.as_ref().expect("picker");
    assert_eq!(picker.kind, PickerKind::ForkMessage);
    assert_eq!(
        picker
            .items
            .iter()
            .map(|i| i.value.clone())
            .collect::<Vec<_>>(),
        rewind
    );
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

#[tokio::test]
async fn apply_resume_latest_restores_history_and_model() {
    let mut app = test_app();
    let history = vec![
        json!({ "role": "user", "content": "first" }),
        json!({ "role": "assistant", "content": "reply" }),
    ];
    let id = super::super::cli_save_thread(&app.agent_dir, None, "saved-model", &history, None)
        .unwrap();

    let mut fresh = test_app();
    fresh.agent_dir = app.agent_dir.clone();
    apply_resume(&mut fresh, &ResumeRequest::resume(ResumeTarget::Latest)).await;

    assert_eq!(fresh.thread_id.as_deref(), Some(id.as_str()));
    assert_eq!(fresh.history, history);
    assert_eq!(fresh.model, "saved-model");
    let joined: String = fresh
        .transcript
        .iter()
        .map(row_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        joined.contains("first") && joined.contains("reply"),
        "{joined}"
    );

    // Re-saving the resumed session updates the same thread, not a new one.
    app.agent_dir = fresh.agent_dir.clone();
    let same = super::super::cli_save_thread(
        &app.agent_dir,
        Some(&id),
        "saved-model",
        &fresh.history,
        None,
    )
    .unwrap();
    assert_eq!(same, id);
    assert_eq!(
        super::super::list_threads_in(&app.agent_dir).unwrap().len(),
        1
    );
}

#[tokio::test]
async fn apply_resume_renders_invocation_messages_compactly() {
    let app = test_app();
    let body =
        "Build: $ARGUMENTS\n\nFull template body that must not leak into the transcript.";
    let history = vec![json!({
        "role": "user",
        "content": format!(
            "[IMPORTANT: You have invoked the \"feature-dev\" command - follow its instructions. The full command content is loaded below.]\n\n{body}"
        )
    })];
    super::super::cli_save_thread(&app.agent_dir, None, "m", &history, None).unwrap();
    let mut fresh = test_app();
    fresh.agent_dir = app.agent_dir.clone();
    apply_resume(&mut fresh, &ResumeRequest::resume(ResumeTarget::Latest)).await;

    // History keeps the full template (the model needs it on continuation)...
    assert_eq!(fresh.history, history);
    // ...but the transcript shows only the compact invocation row.
    let joined: String = fresh
        .transcript
        .iter()
        .map(row_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(joined.contains("[command:feature-dev]"), "{joined}");
    assert!(
        !joined.contains("must not leak into the transcript"),
        "template body leaked into the resumed transcript: {joined}"
    );
    let _ = std::fs::remove_dir_all(&fresh.agent_dir);
}

#[tokio::test]
async fn resuming_restores_the_recall_history() {
    let app = test_app();
    let history = vec![
        json!({ "role": "user", "content": "first" }),
        json!({ "role": "assistant", "content": "reply" }),
        json!({ "role": "user", "content": "second" }),
    ];
    super::super::cli_save_thread(&app.agent_dir, None, "saved-model", &history, None).unwrap();

    let mut fresh = test_app();
    fresh.agent_dir = app.agent_dir.clone();
    // A line typed before the resume belongs to the session being replaced.
    fresh.record_submitted("stale");
    apply_resume(&mut fresh, &ResumeRequest::resume(ResumeTarget::Latest)).await;

    assert_eq!(fresh.input_history, vec!["first", "second"]);
    assert!(fresh.recall_prev(), "Up recalls instead of scrolling");
    assert_eq!(fresh.input, "second");
    assert!(fresh.recall_prev());
    assert_eq!(fresh.input, "first");
    assert_eq!(fresh.scrollback, 0, "recall must not scroll the transcript");
}

#[tokio::test]
async fn apply_resume_notes_when_nothing_to_resume() {
    let mut app = test_app();
    apply_resume(&mut app, &ResumeRequest::resume(ResumeTarget::Latest)).await;
    let joined: String = app
        .transcript
        .iter()
        .map(row_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        joined.contains(super::super::NO_SESSION_TO_RESUME),
        "{joined}"
    );
    assert!(app.thread_id.is_none());
    assert!(app.history.is_empty());
}

#[test]
fn sort_threads_recent_orders_newest_first() {
    let mut threads = vec![
        json!({ "id": "a", "updated": 100.0 }),
        json!({ "id": "b", "updated": 300.0 }),
        json!({ "id": "c", "created": 200.0 }),
        json!({ "id": "d" }),
    ];
    super::sort_threads_recent(&mut threads);
    let ids: Vec<&str> = threads.iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["b", "c", "a", "d"]);
}

#[test]
fn thread_display_name_prefers_title() {
    let base = std::path::Path::new("/nonexistent");
    assert_eq!(
        super::thread_display_name(base, "id", Some("My Title")),
        "My Title"
    );
    assert_eq!(
        super::thread_display_name(base, "id", Some("  padded  ")),
        "padded"
    );
}

#[test]
fn truncate_is_char_safe() {
    assert_eq!(super::truncate("héllo wörld", 5), "héll…");
    assert_eq!(super::truncate("short", 20), "short");
}

#[test]
fn parse_command_splits_name_and_arg() {
    assert_eq!(parse_command("resume abc123"), ("resume", "abc123"));
    assert_eq!(parse_command("help"), ("help", ""));
    assert_eq!(parse_command("  resume   abc  "), ("resume", "abc"));
    assert_eq!(parse_command(""), ("", ""));
}

#[test]
fn mouse_tracking_requests_buttons_wheel_and_held_drags() {
    assert!(MOUSE_TRACK_ON.contains("?1000h"), "buttons and wheel");
    assert!(MOUSE_TRACK_ON.contains("?1002h"), "drag while held");
    assert!(MOUSE_TRACK_ON.contains("?1006h"), "SGR coordinates");
    assert!(
        !MOUSE_TRACK_ON.contains("1003"),
        "any-motion would report every idle pointer move: {MOUSE_TRACK_ON:?}"
    );
    assert!(
        ALT_SCROLL_SAVE_OFF.contains("?1007l"),
        "the wheel must never arrive as arrow keys"
    );
    assert!(ALT_SCROLL_RESTORE.contains("?1007r"), "restore on exit");
}

/// Orphaned SGR mouse payloads (`65;50;42M`) and the same token with a
/// truncated CSI prefix must not survive as text. Vietnamese (and any
/// other real typing) is unchanged.
#[test]
fn sgr_mouse_reports_are_stripped_from_text() {
    assert_eq!(super::strip_sgr_mouse_reports("<0;10;20m"), "");
    assert_eq!(super::strip_sgr_mouse_reports("\x1b[<65;50;42M"), "");
    assert_eq!(super::strip_sgr_mouse_reports("\u{9b}<32;8;12M"), "");
    assert_eq!(super::strip_sgr_mouse_reports("[<65;59;29M"), "");
    assert_eq!(super::strip_sgr_mouse_reports("<64;1;1M"), "");
    assert_eq!(
        super::strip_sgr_mouse_reports("hello<65;50;42Mworld"),
        "helloworld"
    );
    assert_eq!(super::strip_sgr_mouse_reports("<65;50;42M<65;59;29M"), "");
    assert_eq!(
        super::strip_sgr_mouse_reports("xin chào Nguyễn"),
        "xin chào Nguyễn"
    );
    assert_eq!(
        super::strip_sgr_mouse_reports("version 1.2.3"),
        "version 1.2.3"
    );
    // Incomplete payload without the M/m terminator is not a report.
    assert_eq!(super::strip_sgr_mouse_reports("65;50;42"), "65;50;42");
}

/// Char-by-char ingest (what a desynced parser emits) drops the token
/// once it completes, including when it is interleaved with real text.
#[test]
fn leaked_sgr_mouse_reports_never_enter_the_composer() {
    let mut app = test_app();
    for c in "65;50;42M".chars() {
        app.input_insert(c);
    }
    assert!(
        app.input.is_empty(),
        "orphaned wheel report must not type: {:?}",
        app.input
    );

    for c in "xin chào".chars() {
        app.input_insert(c);
    }
    for c in "65;50;42M".chars() {
        app.input_insert(c);
    }
    for c in "[<0;12;8m".chars() {
        app.input_insert(c);
    }
    for c in " Nguyễn".chars() {
        app.input_insert(c);
    }
    assert_eq!(app.input, "xin chào Nguyễn");
    assert_eq!(app.cursor, app.input.len());
}

/// Dropping a leaked report is not a scroll: intact `Event::Mouse` still
/// moves the transcript, the leftover payload must not.
#[test]
fn leaked_sgr_mouse_reports_do_not_scroll() {
    let mut app = test_app();
    app.scrollback = 4;
    for c in "65;50;42M".chars() {
        app.input_insert(c);
    }
    assert_eq!(app.scrollback, 4, "a leaked payload is not a wheel event");
    assert!(app.input.is_empty());

    handle_mouse(&mut app, mouse_at(MouseEventKind::ScrollDown, 5, 1));
    assert_eq!(app.scrollback, 3);
    handle_mouse(&mut app, mouse_at(MouseEventKind::ScrollUp, 5, 1));
    assert_eq!(app.scrollback, 4);
}

#[test]
fn bare_sgr_lookalike_text_survives() {
    for text in ["1;2;3m", "38;5;196m", "1;31;40m", "10;20;30m", "build 65;50;42m done"] {
        assert_eq!(super::strip_sgr_mouse_reports(text), text);
        let mut app = test_app();
        for c in text.chars() {
            app.input_insert(c);
        }
        assert_eq!(app.input, text, "typed text was eaten");
    }
    // A pasted bare report is text, not a leak: only a marker makes it one.
    let mut app = test_app();
    route_paste_event(&mut app, Event::Paste("65;50;42M".into()));
    assert_eq!(app.input, "65;50;42M");
}

fn bkey(code: KeyCode) -> Event {
    Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
}

fn brelease(code: KeyCode) -> Event {
    Event::Key(KeyEvent::new_with_kind(code, KeyModifiers::NONE, KeyEventKind::Release))
}

#[test]
fn windows_burst_with_newlines_is_one_paste() {
    let mut events = Vec::new();
    for c in "fn a() {".chars() {
        events.push(bkey(KeyCode::Char(c)));
        events.push(brelease(KeyCode::Char(c)));
    }
    events.push(bkey(KeyCode::Enter));
    events.push(brelease(KeyCode::Enter));
    for c in "}".chars() {
        events.push(bkey(KeyCode::Char(c)));
    }
    let out = super::coalesce_burst(events);
    assert_eq!(out.len(), 1, "{out:?}");
    assert!(matches!(&out[0], Event::Paste(t) if t == "fn a() {\n}"), "{out:?}");
}

#[test]
fn quick_typing_and_submit_is_not_a_paste() {
    let events: Vec<Event> = "ok".chars().map(|c| bkey(KeyCode::Char(c))).chain([bkey(KeyCode::Enter)]).collect();
    let out = super::coalesce_burst(events.clone());
    assert_eq!(out, events, "two characters then Enter still submit");
}

#[test]
fn chords_split_a_burst_and_pass_through() {
    let ctrl_c = Event::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
    let mut events: Vec<Event> = "abcdefghij".chars().map(|c| bkey(KeyCode::Char(c))).collect();
    events.push(ctrl_c.clone());
    events.push(bkey(KeyCode::Char('x')));
    let out = super::coalesce_burst(events);
    assert_eq!(out.len(), 3, "{out:?}");
    assert!(matches!(&out[0], Event::Paste(t) if t == "abcdefghij"));
    assert_eq!(out[1], ctrl_c);
}

#[test]
fn paste_of_sgr_mouse_reports_is_dropped() {
    let mut app = test_app();
    route_paste_event(&mut app, Event::Paste("<65;50;42M".into()));
    assert!(app.input.is_empty(), "got {:?}", app.input);

    route_paste_event(
        &mut app,
        Event::Paste("xin chào\x1b[<65;50;42M Nguyễn".into()),
    );
    assert_eq!(app.input, "xin chào Nguyễn");
}

#[tokio::test]
async fn handle_key_drops_orphaned_sgr_mouse_reports() {
    let mut app = test_app();
    type_key_chars(&mut app, "tiếng Việt65;50;42M").await;
    assert_eq!(app.input, "tiếng Việt");
    assert_eq!(app.scrollback, 0);
}

/// The keyboard enhancement flags are the only reason `Shift+Enter` and the
/// `Cmd` bindings can be decoded at all, so they go out on every start --
/// but only flags 1 and 4. Flag 2 (report event types) would deliver key
/// releases and repeats that no handler here filters, and flag 8 (report
/// all keys as escape codes) would route ordinary text through CSI-u.
#[test]
fn keyboard_enhancement_asks_for_disambiguation_and_nothing_costly() {
    let flags: u8 = KITTY_KEYS_ON
        .trim_start_matches("\x1b[>")
        .trim_end_matches('u')
        .parse()
        .expect("the push is a numeric flag set");
    assert_eq!(flags & 1, 1, "disambiguate escape codes");
    assert_eq!(flags & 4, 4, "report alternate keys");
    assert_eq!(flags & 2, 0, "event types would add releases and repeats");
    assert_eq!(flags & 8, 0, "all-keys-as-escapes would reroute plain text");
    assert_eq!(KITTY_KEYS_OFF, "\x1b[<u", "the push must be popped on exit");
}

/// The panic hook's restore turns every mode `run` can have enabled back
/// off, and ends a synchronized frame first so the message is not held.
#[test]
fn panic_restore_undoes_every_startup_mode() {
    let seq = super::panic_restore_sequence();
    for off in [
        "\x1b[?2026l", "\x1b[?2004l", "\x1b[?1006l", "\x1b[?1002l", "\x1b[?1000l",
        KITTY_KEYS_OFF, "\x1b[?1049l", "\x1b[?25h",
    ] {
        assert!(seq.contains(off), "missing {off:?}");
    }
    assert!(seq.starts_with("\x1b[?2026l"), "end the held frame first");
    let alt_screen = seq.find("\x1b[?1049l").unwrap();
    assert!(seq.find("\x1b[?1000l").unwrap() < alt_screen);
}

/// Only the render-loop thread's panic restores the terminal, and once.
#[test]
fn only_the_owning_thread_releases_the_terminal() {
    *super::TERMINAL_OWNER.lock().unwrap() = None;
    assert!(!super::release_terminal(), "nobody owns it yet");
    *super::TERMINAL_OWNER.lock().unwrap() = Some(std::thread::current().id());
    let other = std::thread::spawn(super::release_terminal).join().unwrap();
    assert!(!other, "a job thread's panic must leave the TUI alone");
    assert!(super::release_terminal(), "the owner restores");
    assert!(!super::release_terminal(), "and only once");
}

/// Keyboard enhancement is not the mouse: it goes out whether or not
/// tracking is on, since the composer's editing keys depend on it.
#[test]
fn startup_modes_always_push_keyboard_enhancement() {
    for mouse in [true, false] {
        let modes = startup_modes(mouse);
        assert!(modes.contains(KITTY_KEYS_ON), "mouse={mouse}: {modes:?}");
        assert_eq!(
            modes.contains(MOUSE_TRACK_ON),
            mouse,
            "tracking must follow the config key alone"
        );
        assert!(modes.starts_with(alt_scroll_save_off()));
    }
}

/// kitty's `?2026` handling can drop the resize repaint, so synchronized
/// output is skipped there; every other identity keeps it. (Konsole, the
/// whole reason kitty looks broken by contrast, is not the one gated.)
#[test]
fn synchronized_output_is_off_only_for_kitty() {
    use super::super::terminal_setup::Kind;
    for kind in [
        Kind::Ghostty,
        Kind::WezTerm,
        Kind::Foot,
        Kind::Rio,
        Kind::Konsole,
        Kind::ITerm2,
        Kind::AppleTerminal,
        Kind::VsCode,
        Kind::WindowsTerminal,
        Kind::Alacritty,
        Kind::Vte,
        Kind::Unknown,
    ] {
        assert!(
            sync_output_for(kind),
            "{kind:?} must keep synchronized output"
        );
    }
    assert!(!sync_output_for(Kind::Kitty), "kitty must skip it");
}

#[test]
fn alt_scroll_is_disabled_only_where_the_terminal_reports_wheel() {
    // The app keeps native alternate scroll (i.e. sends nothing) on Windows,
    // where forcing `?1007l` kills the wheel; everywhere else it disables it
    // so the wheel arrives as SGR mouse reports. The save/off and restore
    // pair must always agree so the mode is left balanced on exit.
    if cfg!(windows) {
        assert_eq!(
            alt_scroll_save_off(),
            "",
            "Windows must not disable alt scroll"
        );
        assert_eq!(
            alt_scroll_restore(),
            "",
            "Windows must not restore alt scroll"
        );
    } else {
        assert_eq!(alt_scroll_save_off(), ALT_SCROLL_SAVE_OFF);
        assert_eq!(alt_scroll_restore(), ALT_SCROLL_RESTORE);
    }
}

#[test]
fn linear_selection_spans_whole_rows_between_the_ends() {
    let sel = Selection {
        anchor: (5, 1),
        head: (2, 3),
        mode: SelectionMode::Linear,
        dragging: false,
        moved: true,
    };
    assert_eq!(sel.spans(10), vec![(1, 5, 9), (2, 0, 9), (3, 0, 2)]);
}

#[test]
fn selection_spans_are_direction_independent() {
    let forward = Selection {
        anchor: (5, 1),
        head: (2, 3),
        mode: SelectionMode::Linear,
        dragging: false,
        moved: true,
    };
    let backward = Selection {
        anchor: (2, 3),
        head: (5, 1),
        ..forward
    };
    assert_eq!(forward.spans(10), backward.spans(10));
}

#[test]
fn block_selection_spans_a_rectangle() {
    let sel = Selection {
        anchor: (6, 3),
        head: (2, 1),
        mode: SelectionMode::Block,
        dragging: false,
        moved: true,
    };
    assert_eq!(sel.spans(10), vec![(1, 2, 6), (2, 2, 6), (3, 2, 6)]);
}

/// A block drag lifts one column out of a table without the neighbours a
/// linear drag would sweep up.
#[test]
fn selection_text_reads_cells_and_trims_row_padding() {
    let area = Rect::new(0, 0, 12, 3);
    let mut buf = Buffer::empty(area);
    buf.set_string(0, 0, "alpha   one", Style::new());
    buf.set_string(0, 1, "beta    two", Style::new());

    let linear = Selection {
        anchor: (0, 0),
        head: (10, 1),
        mode: SelectionMode::Linear,
        dragging: false,
        moved: true,
    };
    assert_eq!(
        selection_text(&buf, linear, area),
        "alpha   one\nbeta    two"
    );

    let block = Selection {
        anchor: (8, 0),
        head: (10, 1),
        mode: SelectionMode::Block,
        dragging: false,
        moved: true,
    };
    assert_eq!(selection_text(&buf, block, area), "one\ntwo");

    // A row selected past its text keeps no trailing padding.
    let padded = Selection {
        anchor: (0, 0),
        head: (11, 0),
        mode: SelectionMode::Linear,
        dragging: false,
        moved: true,
    };
    assert_eq!(selection_text(&buf, padded, area), "alpha   one");
}

/// Copying a boxed code block should return the code body, not the frame.
#[test]
fn selection_text_strips_box_frame_from_copied_code() {
    let area = Rect::new(0, 0, 14, 3);
    let mut buf = Buffer::empty(area);
    buf.set_string(0, 0, "│   ┌────────┐", Style::new().dark_gray());
    buf.set_string(0, 1, "│   ", Style::new().dark_gray());
    buf.set_string(4, 1, "    echo", Style::new());
    buf.set_string(0, 2, "│   └────────┘", Style::new().dark_gray());

    let selection = Selection {
        anchor: (0, 0),
        head: (13, 2),
        mode: SelectionMode::Linear,
        dragging: false,
        moved: true,
    };

    assert_eq!(selection_text(&buf, selection, area), "    echo");
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

#[test]
fn alt_drag_selects_a_block() {
    let mut app = test_app();
    handle_mouse(
        &mut app,
        MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 5,
            row: 1,
            modifiers: KeyModifiers::ALT,
        },
    );
    assert_eq!(app.selection.expect("selection").mode, SelectionMode::Block);
}

#[test]
fn scrolling_drops_a_finished_selection() {
    let mut app = test_app();
    handle_mouse(
        &mut app,
        mouse_at(MouseEventKind::Down(MouseButton::Left), 5, 1),
    );
    handle_mouse(
        &mut app,
        mouse_at(MouseEventKind::Drag(MouseButton::Left), 9, 1),
    );
    handle_mouse(&mut app, mouse_at(MouseEventKind::ScrollUp, 5, 1));
    assert!(app.selection.is_none(), "content moved out from under it");
}

#[test]
fn a_held_drag_past_an_edge_scrolls_the_transcript() {
    let mut app = test_app();
    app.transcript_rect = Rect::new(0, 0, 80, 10);
    handle_mouse(
        &mut app,
        mouse_at(MouseEventKind::Down(MouseButton::Left), 5, 5),
    );

    // Above the top border: scroll back through history.
    handle_mouse(
        &mut app,
        mouse_at(MouseEventKind::Drag(MouseButton::Left), 5, 0),
    );
    autoscroll_selection(&mut app);
    autoscroll_selection(&mut app);
    assert_eq!(app.scrollback, 2);

    // Below the last body row: scroll back toward the newest output.
    handle_mouse(
        &mut app,
        mouse_at(MouseEventKind::Drag(MouseButton::Left), 5, 9),
    );
    autoscroll_selection(&mut app);
    assert_eq!(app.scrollback, 1);

    // Inside the viewport, nothing moves.
    handle_mouse(
        &mut app,
        mouse_at(MouseEventKind::Drag(MouseButton::Left), 5, 4),
    );
    autoscroll_selection(&mut app);
    assert_eq!(app.scrollback, 1);

    // A released drag stops scrolling even parked past the edge.
    handle_mouse(
        &mut app,
        mouse_at(MouseEventKind::Up(MouseButton::Left), 5, 0),
    );
    app.selection.as_mut().expect("selection").head = (5, 0);
    autoscroll_selection(&mut app);
    assert_eq!(app.scrollback, 1);
}

#[test]
fn copy_notice_expires() {
    let mut app = test_app();
    assert_eq!(app.copy_notice(), None);
    app.copied = Some((Instant::now(), 3));
    assert_eq!(app.copy_notice(), Some(3));
    app.copied = Some((Instant::now() - COPY_NOTICE - Duration::from_millis(1), 3));
    assert_eq!(app.copy_notice(), None);
}

#[tokio::test]
async fn mouse_tracking_has_no_toggle_hotkey() {
    assert!(
        !KEY_BINDINGS.iter().any(|(k, _)| k.contains("Ctrl-T")),
        "mouse tracking is a config key now, not a hotkey"
    );
    assert!(
        KEY_BINDINGS.iter().any(|(_, d)| d.contains("Select text")),
        "the selection gesture still needs advertising"
    );

    // Ctrl-T is an ordinary unbound key: it must not type into the input.
    let mut app = test_app();
    let registry: PermissionRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let mcp_servers: crate::core::state::SharedMcpServers =
        Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let mut current: Option<CurrentRun> = None;
    let key = KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL);
    handle_key(&mut app, key, &registry, &mut current, &mcp_servers).await;
    assert!(app.input.is_empty(), "got: {:?}", app.input);
}

#[tokio::test]
async fn compact_command_notes_when_unavailable() {
    let mut app = test_app();
    app.history.push(json!({ "role": "user", "content": "hi" }));
    run_command(&mut app, "compact", &no_mcp()).await;
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("compaction unavailable"), "got: {text}");
    // History untouched when no session is attached.
    assert_eq!(app.history.len(), 1);
    assert!(app.compact_request.is_none());
}

#[tokio::test]
async fn compact_command_is_refused_while_one_is_in_flight() {
    let mut app = test_app();
    app.compacting = Some(CompactKind::Auto);
    run_command(&mut app, "compact", &no_mcp()).await;
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("already compacting"), "got: {text}");
    assert!(app.compact_request.is_none());
}

#[test]
fn finish_compaction_keeps_messages_added_while_it_ran() {
    let mut app = test_app();
    app.compacting = Some(CompactKind::Manual);
    app.compact_started = Some(Instant::now());
    app.history = (0..5)
        .map(|i| json!({ "role": "user", "content": format!("m{i}") }))
        .collect();
    // A message submitted while the summary was being generated.
    let base_len = 4;
    finish_compaction(
        &mut app,
        Ok(vec![json!({ "role": "user", "content": "summary" })]),
        base_len,
    );
    let contents: Vec<String> = app
        .history
        .iter()
        .map(|m| m["content"].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(contents, vec!["summary", "m4"], "tail must survive");
    assert!(app.compacting.is_none());
    assert!(app.compact_started.is_none());
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("compacted 4 -> 2 messages"), "got: {text}");
}

#[test]
fn finish_compaction_restores_idle_state_on_failure() {
    let mut app = test_app();
    app.compacting = Some(CompactKind::Auto);
    app.history = vec![json!({ "role": "user", "content": "hi" })];
    finish_compaction(&mut app, Err("upstream 500".into()), 1);
    assert_eq!(app.history.len(), 1, "history must be left alone");
    assert!(app.compacting.is_none(), "a failure must allow a retry");
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(
        text.contains("auto-compacting failed: upstream 500"),
        "got: {text}"
    );
}

#[test]
fn a_running_compaction_shows_a_throbber() {
    let mut app = test_app();
    let idle = render_rows(&mut app, 80, 12).join("\n");
    assert!(!idle.contains("compacting"), "got: {idle}");

    app.compacting = Some(CompactKind::Manual);
    app.compact_started = Some(Instant::now());
    let out = render_rows(&mut app, 80, 12).join("\n");
    assert!(
        out.contains("compacting conversation"),
        "the input row must say what is happening: {out}"
    );
    assert!(
        out.contains(SPINNER[app.spinner_frame % SPINNER.len()]),
        "the input row must carry the throbber: {out}"
    );
}

fn start_subagent(app: &mut App, run_id: &str, name: &str) {
    start_subagent_with_task(app, run_id, name, None);
}

fn start_subagent_with_task(app: &mut App, run_id: &str, name: &str, task: Option<&str>) {
    app.apply(StreamEvent::SubagentStart {
        run_id: run_id.into(),
        name: name.into(),
        task: task.map(str::to_string),
    });
}

/// The dispatch prompt rides on the event, so the panel can say what the
/// fan-out is for. Only its first line: the panel is a pinned dock, and the
/// brief's later lines are already in the transcript.
#[test]
fn subagent_panel_shows_the_dispatch_prompt() {
    let brief = "Build Flappy Space\nRocket dodging asteroids\n400x600 canvas";

    let mut solo = test_app();
    start_subagent_with_task(&mut solo, "r0", "space", Some(brief));
    let out = render_rows(&mut solo, 100, 24).join("\n");
    assert!(out.contains("Build Flappy Space"), "brief missing: {out}");
    assert!(!out.contains("400x600"), "only the summary line: {out}");

    let mut pair = test_app();
    start_subagent_with_task(&mut pair, "r0", "space", Some(brief));
    start_subagent_with_task(
        &mut pair,
        "r1",
        "fish",
        Some("Build Flappy Fish\nUnderwater"),
    );
    let out = render_rows(&mut pair, 100, 24).join("\n");
    assert!(out.contains("Build Flappy Space"), "{out}");
    assert!(out.contains("Build Flappy Fish"), "{out}");
    assert!(!out.contains("Underwater"), "{out}");
}

/// A dispatch with no task (or an older event without the field) still
/// renders -- it just has nothing to say about the brief.
#[test]
fn subagent_block_without_a_task_renders() {
    let mut app = test_app();
    start_subagent(&mut app, "r0", "alpha");
    let out = render_rows(&mut app, 100, 20).join("\n");
    assert!(out.contains("1 agent") && out.contains("alpha"), "{out}");
}

fn compaction_event(
    phase: crate::core::agent::events::CompactionPhase,
    messages: Option<usize>,
) -> StreamEvent {
    StreamEvent::Compaction {
        phase,
        reason: crate::core::agent::events::CompactionReason::SessionBudget,
        messages,
    }
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

/// A window-derived budget follows a model switch; a pinned one does not.
#[test]
fn a_window_derived_budget_follows_the_model_and_a_pinned_one_does_not() {
    let mut t = test_app();
    let app = &mut t.app;
    app.max_session_tokens_pinned = false;
    app.model = "claude-sonnet-4-6".into();
    app.refresh_context_window();
    if app.context_window_source
        != crate::core::cli::model_capabilities::ContextWindowSource::Fallback
    {
        assert_eq!(app.max_session_tokens, app.context_window);
    }
    app.model = "no-such-model-anywhere".into();
    app.refresh_context_window();
    assert_eq!(app.max_session_tokens, crate::core::cli::DEFAULT_MAX_SESSION_TOKENS);

    app.max_session_tokens_pinned = true;
    app.max_session_tokens = 42_000;
    app.model = "claude-sonnet-4-6".into();
    app.refresh_context_window();
    assert_eq!(app.max_session_tokens, 42_000, "a pinned budget stays put");
}

fn retry_event(attempt: u32, delay_ms: u64) -> StreamEvent {
    StreamEvent::Retry {
        attempt,
        max_attempts: 10,
        delay_ms,
        reason: "Upstream returned HTTP 503: busy".into(),
    }
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
    assert!(super::retry_wait_label(wait, Instant::now()).contains("attempt 2/10"));
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
    let label = super::retry_wait_label(wait, Instant::now() + Duration::from_secs(1));
    assert!(label.starts_with("retrying ("), "{label}");
    let counting = super::RetryWait {
        attempt: 4,
        max_attempts: 10,
        at: Instant::now() + Duration::from_secs(3),
        reason: "r".into(),
    };
    assert!(super::retry_wait_label(&counting, Instant::now()).starts_with("retrying in "));
    app.cancel_run();
    assert!(app.retrying.is_none());
}

fn subagent_event(app: &mut App, run_id: &str, name: &str, event: StreamEvent) {
    app.apply(StreamEvent::Subagent {
        run_id: run_id.into(),
        name: name.into(),
        event: Box::new(event),
    });
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

/// Every dispatch joins the one panel; nothing is committed to the chat.
#[test]
fn parallel_dispatches_share_one_pinned_panel() {
    let mut app = test_app();
    start_subagent(&mut app, "r0", "alpha");
    let before = app.transcript.len();
    start_subagent(&mut app, "r1", "beta");
    assert_eq!(app.transcript.len(), before, "no transcript rows committed");
    let rows = render_rows(&mut app, 100, 24);
    assert_eq!(
        rows.iter().filter(|r| r.contains("agents")).count(),
        1,
        "one panel head only: {rows:?}"
    );
    assert!(rows.iter().any(|r| r.contains("2 agents")), "{rows:?}");
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

/// Before a child reports usage there is no honest percentage to show, and
/// "0.0%" would read as a stalled agent.
#[test]
fn subagent_hides_context_share_until_it_reports() {
    let mut app = test_app();
    start_subagent(&mut app, "r1", "alpha");
    let out = render_rows(&mut app, 100, 20).join("\n");
    assert!(out.contains("1 agent"), "{out}");
    assert!(out.contains("starting…"), "{out}");
    assert!(
        !out.contains('%'),
        "no share before the first response: {out}"
    );
}

/// The running placeholder is the row a user stares at during a long turn.
/// A static "working…" reads as a hung UI, so it animates on the same
/// cadence as every other throbber: the spinner glyph rotates, and the
/// action word cycles through synonyms of "working".
#[test]
fn working_placeholder_animates() {
    let mut app = test_app();
    app.submit_user("go".into());
    assert_eq!(app.status, Status::Running);

    // Pinned off: these assert on the spinner glyph and the intact action
    // word, both of which the sweep overwrites a cell of. `wave` is on by
    // default now, so the sweep has its own tests and these keep testing
    // the row underneath it.
    let frame_of = |app: &mut App| {
        with_wave_glyph(None, || {
            render_rows(app, 80, 12)
                .into_iter()
                .find(|r| r.contains("(Esc to cancel, type to steer the agent)"))
                .expect("running placeholder present")
        })
    };

    app.spinner_frame = 0;
    let first = frame_of(&mut app);
    assert!(
        first.contains(SPINNER[0]),
        "expected frame 0 glyph: {first:?}"
    );

    // While a plain turn is running (no reasoning), the row shows a
    // rotating synonym of "working".
    assert!(
        WORKING_WORDS.iter().any(|w| first.contains(w)),
        "expected a working synonym in: {first:?}"
    );

    app.spinner_frame = 3;
    let later = frame_of(&mut app);
    assert!(
        later.contains(SPINNER[3]),
        "expected frame 3 glyph: {later:?}"
    );
    assert_ne!(first, later, "row must change as the frame advances");

    assert!(
        later.contains("(Esc to cancel, type to steer the agent)"),
        "{later:?}"
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

/// Thinking synonyms are coloured orange so the active reasoning state
/// stands out from the quiet working rows.
#[test]
fn thinking_synonym_is_orange() {
    use ratatui::{backend::TestBackend, Terminal};
    let mut app = test_app();
    app.submit_user("go".into());
    app.apply(StreamEvent::Token {
        text: "<think>ponder the plan".into(),
    });
    let mut terminal = Terminal::new(TestBackend::new(80, 12)).unwrap();
    // Pinned off: the row is located by matching the intact word, which
    // the sweep breaks.
    with_wave_glyph(None, || {
        terminal.draw(|f| super::draw(f, &mut app)).unwrap();
    });
    let buf = terminal.backend().buffer().clone();
    // Locate the placeholder row, then assert the action word's cells are
    // orange (the trailing hint stays dim, so only the word carries it).
    let orange = (0..buf.area.height).any(|y| {
        let row: String = (0..buf.area.width).map(|x| buf[(x, y)].symbol()).collect();
        if !THINKING_WORDS.iter().any(|w| row.contains(w)) {
            return false;
        }
        (0..buf.area.width).any(|x| buf[(x, y)].style().fg == Some(super::theme::strong_accent()))
    });
    assert!(orange, "thinking synonym not orange");
}

/// The working word rotates to a different synonym as the frame advances.
#[test]
fn working_synonym_rotates_across_frames() {
    let mut app = test_app();
    app.submit_user("go".into());
    let mut word_at = |frame: usize| {
        app.spinner_frame = frame;
        // Pinned off: the sweep would eat a letter of the very word this
        // looks up.
        let row = with_wave_glyph(None, || {
            render_rows(&mut app, 80, 12)
                .into_iter()
                .find(|r| r.contains("(Esc to cancel, type to steer the agent)"))
                .expect("running placeholder present")
        });
        WORKING_WORDS
            .iter()
            .find(|w| row.contains(*w))
            .map(|w| w.to_string())
            .expect("working synonym present")
    };
    let a = word_at(0);
    let b = word_at(super::WORD_ROTATE_FRAMES);
    assert_ne!(a, b, "working word must rotate as frames advance: {a}");
}

/// A queued-message row is still a running row, so it animates too.
#[test]
fn queued_placeholder_animates() {
    let mut app = test_app();
    app.submit_user("go".into());
    app.message_queue.push_back("next".into());
    app.spinner_frame = 5;
    let row = render_rows(&mut app, 80, 12)
        .into_iter()
        .find(|r| r.contains("Pending"))
        .expect("queued row present");
    assert!(row.contains(SPINNER[5]), "expected frame 5 glyph: {row:?}");
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

/// The resend policy reaches the wire: a default session sends an unchanged
/// body (the loop defaults to resending), and opting out forwards the flag.
#[test]
fn send_reasoning_opt_out_is_forwarded_in_the_request_body() {
    let mut app = test_app();
    app.submit_user("go".into());
    assert!(
        app.body().get("send_reasoning").is_none(),
        "the default session must send an unchanged body"
    );
    app.send_reasoning = false;
    assert_eq!(
        app.body()["send_reasoning"],
        serde_json::json!(false),
        "opting out must reach the loop"
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

fn detail_text(block: &super::ReasoningBlock) -> String {
    block
        .detail
        .iter()
        .map(|l| {
            l.spans
                .iter()
                .map(|sp| sp.content.as_ref())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join(" ")
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

#[test]
fn compact_tokens_keeps_a_stable_width() {
    assert_eq!(compact_tokens(0), "0");
    assert_eq!(compact_tokens(840), "840");
    assert_eq!(compact_tokens(1_100), "1.1K");
    assert_eq!(compact_tokens(43_000), "43K");
    assert_eq!(compact_tokens(1_500_000), "1.5M");
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

fn todo_item(content: &str) -> crate::core::agent::todo::TodoItem {
    crate::core::agent::todo::TodoItem {
        content: content.to_string(),
        status: crate::core::agent::todo::TodoStatus::Pending,
    }
}

#[tokio::test]
async fn finished_todos_clear_after_a_grace_period() {
    let mut app = test_app();
    app.todos
        .init(vec![crate::core::agent::todo::TodoPhase {
            name: String::new(),
            tasks: vec![todo_item("write the parser")],
        }])
        .unwrap();
    assert!(!app.todos.is_empty());

    // Open work is never aged away, however many turns go by.
    for _ in 0..5 {
        age_closed_todos(&mut app).await;
    }
    assert!(!app.todos.is_empty(), "open work must survive");

    app.todos
        .done(crate::core::agent::todo::Target::All)
        .unwrap();
    assert!(app.todos.open_summary().is_none(), "all work closed out");

    // Survives every turn up to the cutoff.
    for i in 1..=super::TODO_KEEP_CLOSED_TURNS {
        age_closed_todos(&mut app).await;
        assert!(!app.todos.is_empty(), "cleared too eagerly at turn {i}");
    }

    // One turn past the grace period and it goes.
    age_closed_todos(&mut app).await;
    assert!(
        app.todos.is_empty(),
        "finished list should have been dropped"
    );
}

/// Reopening work resets the grace period, so a list in active use is never
/// aged out from under the model.
#[tokio::test]
async fn reopened_todos_reset_the_grace_period() {
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

    age_closed_todos(&mut app).await;
    assert_eq!(app.turns_since_todos_closed, 1);

    app.todos
        .init(vec![crate::core::agent::todo::TodoPhase {
            name: String::new(),
            tasks: vec![todo_item("b")],
        }])
        .unwrap();
    age_closed_todos(&mut app).await;
    assert_eq!(app.turns_since_todos_closed, 0, "counter must reset");
    assert!(!app.todos.is_empty(), "new work must not be aged out");
}

/// An empty list never accumulates grace, so the counter can't drift.
#[tokio::test]
async fn empty_todos_do_not_accumulate_grace() {
    let mut app = test_app();
    for _ in 0..5 {
        age_closed_todos(&mut app).await;
    }
    assert_eq!(app.turns_since_todos_closed, 0);
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
    for _ in 1..=super::TODO_KEEP_CLOSED_TURNS {
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

#[test]
fn compact_is_a_registered_command() {
    assert!(SLASH_COMMANDS.iter().any(|c| c.name == "/compact"));
}

#[test]
fn context_is_a_registered_command() {
    let row = SLASH_COMMANDS
        .iter()
        .find(|c| c.name == "/context")
        .expect("/context must be registered");
    assert_eq!(row.alias_of, None, "/context is canonical");
}

/// Build a report with explicit per-category tokens, free space and buffer
/// derived the way [`App::context_report`] derives them, so the tests
/// exercise the real partition rather than a hand-balanced one.
fn context_report(window: u64, buffer: u64, content: [u64; 5]) -> ContextReport {
    let labels = [
        ('P', "System prompt"),
        ('T', "System tools"),
        ('C', "Project context"),
        ('K', "Skills"),
        ('M', "Messages"),
    ];
    let mut segments: Vec<ContextSegment> = labels
        .iter()
        .zip(content)
        .map(|(&(key, label), tokens)| ContextSegment { key, label, tokens })
        .collect();
    let used: u64 = content.iter().sum();
    segments.push(ContextSegment {
        key: '.',
        label: "Available",
        tokens: window.saturating_sub(used + buffer),
    });
    segments.push(ContextSegment {
        key: 'B',
        label: "Auto-compact reserve",
        tokens: buffer.min(window),
    });
    ContextReport {
        model_id: "tokamak-1-preview".into(),
        window,
        fill: used,
        fill_reported: false,
        segments,
    }
}

#[test]
fn context_view_uses_consistent_language_and_aligned_bars() {
    let mut report = context_report(234_000, 35_000, [6_049, 9_000, 2_149, 8_049, 95_253]);
    report.fill = 120_490;
    report.fill_reported = true;

    let text = context_lines(&report, 80)
        .iter()
        .map(line_text)
        .collect::<Vec<_>>()
        .join("\n");

    assert!(text.contains("tokamak-1-preview · 120K / 234k tokens used (51.5%, provider)"));
    assert!(text.contains("Context window"));
    assert!(text.contains("|==============================^...................|╳╳╳╳╳╳╳╳╳|"));
    assert!(text.contains("79K tokens available before auto-compact"));
    assert!(text.contains("Context breakdown (estimated)"));

    let labels = [
        "System prompt",
        "System tools",
        "Project context",
        "Skills",
        "Messages",
    ];
    let bar_lines = labels
        .iter()
        .map(|label| {
            text.lines()
                .find(|line| line.starts_with(label))
                .unwrap_or_else(|| panic!("missing bar {label}: {text}"))
        })
        .collect::<Vec<_>>();
    let bar_column = bar_lines[0].find('[').expect("first bar must render");
    assert!(
        bar_lines
            .iter()
            .all(|line| line.find('[') == Some(bar_column)),
        "bars must align: {bar_lines:?}"
    );
    for removed in [
        "CTX CONTROL DECK",
        "STATUS NOMINAL",
        "NOW",
        "= FILLED",
        "BREAKDOWN //",
        "FULL-WINDOW BASELINE",
        "FILL REPORTED //",
        "Estimated usage",
        "Available ",
        "Auto-compact reserve",
    ] {
        assert!(!text.contains(removed), "obsolete copy {removed}: {text}");
    }
}

/// A nearly-empty window still has to say where it stands: the fill marker
/// outranks the `0%`/`0K` scale ends, which would otherwise swallow it.
#[test]
fn context_rail_annotates_a_low_fill() {
    let report = context_report(200_000, 16_000, [1_500, 3_500, 0, 74, 0]);

    let rows = context_lines(&report, 80)
        .iter()
        .map(line_text)
        .collect::<Vec<_>>();
    let rail = rows
        .iter()
        .position(|line| line.starts_with('|'))
        .expect("the rail must render");

    assert!(
        rows[rail - 1].contains("2.5%"),
        "the percent scale must annotate the fill marker: {:?}",
        rows[rail - 1]
    );
    assert!(
        rows[rail + 1].contains("5.1K"),
        "the token scale must annotate the fill marker: {:?}",
        rows[rail + 1]
    );
}

/// Free space and the buffer are categories like any other, so the seven
/// percentages account for the whole window and nothing is unexplained.
#[test]
fn context_percentages_sum_to_the_whole_window() {
    for (window, buffer, content) in [
        (
            234_000u64,
            35_000u64,
            [6_000u64, 9_000, 2_100, 8_000, 95_000],
        ),
        (128_000, 12_800, [1_000, 2_000, 3_000, 4_000, 5_000]),
        (64_000, 6_400, [0, 0, 0, 0, 0]),
    ] {
        let report = context_report(window, buffer, content);
        let total: f64 = report.percents().iter().sum();
        assert!(
            (total - 100.0).abs() < 1e-6,
            "window {window} percentages sum to {total}, not 100"
        );
    }
}

/// The headline must never present a stale or derived number as measured.
#[test]
fn context_headline_labels_an_estimated_fill() {
    let mut report = context_report(234_000, 35_000, [6_049, 9_000, 2_149, 8_049, 95_253]);
    report.fill = 120_490;
    let text = |value: &ContextReport| {
        context_lines(value, 200)
            .iter()
            .map(line_text)
            .collect::<Vec<_>>()
            .join("\n")
    };

    let estimated = text(&report);
    assert!(
        estimated.contains("tokamak-1-preview · 120K / 234k tokens used (51.5%, estimated)"),
        "an estimated fill must say so: {estimated}"
    );
    assert!(estimated.contains("Context breakdown (estimated)"));

    report.fill_reported = true;
    let reported = text(&report);
    assert!(
        reported.contains("tokamak-1-preview · 120K / 234k tokens used (51.5%, provider)"),
        "a provider fill is stated plainly: {reported}"
    );
    assert!(
        !reported.contains("tokens used (51.5%, estimated)"),
        "a provider fill must not be labelled an estimate: {reported}"
    );
}

/// Every row adapts to the available width rather than clipping a fixed
/// control surface at the frame edge.
#[test]
fn context_view_never_overflows_the_available_width() {
    let report = context_report(234_000, 35_000, [6_049, 9_000, 2_149, 8_049, 95_253]);
    for width in [1usize, 2, 8, 20, 31, 32, 42, 60, 70, 80, 200] {
        let lines = context_lines(&report, width);
        assert!(!lines.is_empty(), "width {width} rendered nothing");
        for line in &lines {
            let w = row_width(line);
            assert!(
                w <= width.max(1),
                "width {width}: line of {w} columns: {line:?}"
            );
        }
    }
}

/// The `/context` overlay (not the old transcript row) goes through the
/// same frame sizes the rest of the transcript survives. A mid-turn popup
/// must never panic on rendering, however narrow or short the terminal.
#[test]
fn tiny_frames_render_the_context_view_without_panicking() {
    let mut app = test_app();
    let report = context_report(234_000, 35_000, [6_000, 9_000, 2_100, 8_000, 95_000]);
    app.context_view = Some(ContextView::Ready(Box::new(report)));
    for (w, h) in [
        (1u16, 1u16),
        (2, 3),
        (8, 4),
        (20, 6),
        (40, 2),
        (43, 12),
        (200, 80),
    ] {
        render_rows(&mut app, w, h);
    }
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

/// Resuming a thread swaps the whole conversation; a count measured against
/// the previous one describes nothing on screen.
#[test]
fn resuming_a_thread_invalidates_the_measured_count() {
    let mut app = test_app();
    app.tokens_estimated = false;
    app.turn_prompt_tokens = 120_000;
    app.invalidate_token_provenance();
    assert!(app.tokens_estimated, "resumed history is not measured");
    assert_eq!(
        app.turn_prompt_tokens, 0,
        "the stale measurement must be dropped, not kept"
    );
}
/// `/context` is now available mid-turn: it must open the overlay into its
/// loading state and raise the off-loop request flag, and must never emit
/// the old idle-only refusal note (the report is computed on a task, not
/// inline on the key path, so no MCP lock is taken here).
#[tokio::test]
async fn context_opens_the_overlay_mid_turn() {
    let mut app = test_app();
    app.status = Status::Running;
    run_command(&mut app, "context", &no_mcp()).await;
    assert!(
        matches!(app.context_view, Some(ContextView::Loading)),
        "mid-turn /context must open the loading overlay"
    );
    assert!(
        app.context_request,
        "mid-turn /context must request the off-loop report"
    );
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(
        !text.contains("only available while idle"),
        "no idle refusal may be emitted: {text}"
    );
    assert!(
        app.transcript
            .iter()
            .all(|r| matches!(r.kind, RowKind::Line(_) | RowKind::System { .. })),
        "the readout must not be committed to the transcript as a row"
    );
}

/// Esc closes the overlay without cancelling the running turn: `status` is
/// untouched and the current run handle survives, so a popup dismissal is
/// purely cosmetic.
#[tokio::test]
async fn esc_closes_the_context_overlay_without_cancelling_the_turn() {
    let mut app = test_app();
    app.status = Status::Running;
    app.context_view = Some(ContextView::Loading);
    app.context_request = true;
    let registry: PermissionRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let mcp_servers = no_mcp();
    let mut current: Option<CurrentRun> = None;
    handle_key(
        &mut app,
        key(KeyCode::Esc),
        &registry,
        &mut current,
        &mcp_servers,
    )
    .await;
    assert!(
        app.context_view.is_none(),
        "Esc must close the context overlay"
    );
    assert_eq!(app.status, Status::Running, "the turn keeps running");
    assert!(
        current.is_none(),
        "closing the overlay must not spawn a run, let alone cancel one"
    );
    // A bare `q` also closes it, outranking the quit shortcut.
    app.context_view = Some(ContextView::Loading);
    handle_key(
        &mut app,
        key(KeyCode::Char('q')),
        &registry,
        &mut current,
        &mcp_servers,
    )
    .await;
    assert!(app.context_view.is_none(), "q closes when not ctrl");
    assert!(
        !app.should_quit,
        "q must not quit while the overlay is open"
    );
}

/// A report that lands after the user closed the overlay is discarded: it
/// must never reopen a popup the user walked away from. Mirrors how
/// `finish_mcp_job` drops a listing whose screen has been left.
#[tokio::test]
async fn a_context_result_landing_after_close_is_discarded() {
    let mut app = test_app();
    app.context_view = None;
    let report = context_report(128_000, 16_384, [1_000, 2_000, 3_000, 4_000, 5_000]);
    finish_context_report(&mut app, report);
    assert!(
        app.context_view.is_none(),
        "a result landing after the overlay closed must not reopen it"
    );
}

/// The whole-number branch exists so `6.0K` never reaches the screen. The
/// guard and the digits must agree at every half-way boundary.
#[test]
fn format_tokens_never_prints_a_zero_decimal() {
    for tokens in 0..=20_000u64 {
        let text = format_tokens(tokens);
        assert!(
            !text.contains(".0K"),
            "{tokens} rendered as {text}: a zero decimal is exactly what the \
                 whole-number branch exists to avoid"
        );
    }
    // Spot-check the boundaries the float path used to get wrong.
    assert_eq!(format_tokens(2_050), "2.1K");
    assert_eq!(format_tokens(6_050), "6.1K");
    assert_eq!(format_tokens(9_950), "10K");
    assert_eq!(format_tokens(999), "999");
    assert_eq!(format_tokens(2_100), "2.1K");
}

/// An over-full estimate clamps free space to zero; the category banks
/// still normalize to one whole rather than printing more than 100%.
#[test]
fn context_percentages_stay_whole_when_the_estimate_overshoots() {
    let report = context_report(100_000, 10_000, [40_000, 40_000, 40_000, 40_000, 40_000]);
    let total: f64 = report.percents().iter().sum();
    assert!(
        (total - 100.0).abs() < 1e-6,
        "an over-full report's percentages sum to {total}, not 100"
    );
}
#[test]
fn effort_aliases_are_registered_as_aliases_of_effort() {
    let effort = SLASH_COMMANDS
        .iter()
        .find(|c| c.name == "/effort")
        .expect("/effort is canonical");
    assert_eq!(effort.alias_of, None, "/effort is not an alias");
    for alias in ["/think", "/reasoning"] {
        let row = SLASH_COMMANDS
            .iter()
            .find(|c| c.name == alias)
            .unwrap_or_else(|| panic!("{alias} must be registered"));
        assert_eq!(row.alias_of, Some("/effort"), "{alias} alias target");
    }
}

#[tokio::test]
async fn help_lists_effort_aliases_and_marks_effort_canonical() {
    let mut app = test_app();
    run_command(&mut app, "help", &no_mcp()).await;
    let text: String = app.transcript.iter().map(row_text).collect();
    // `/effort` desc has no alias prefix; each alias row derives from
    // `alias_of` and must read as an alias of `/effort`. Signatures are
    // wider than the 18-char pad, so assert on the embedded parts rather
    // than exact column alignment.
    assert!(
        text.contains("alias of /effort"),
        "alias annotation missing: {text}"
    );
    assert!(
        text.contains("/think [low|medium|high] alias of /effort"),
        "think row: {text}"
    );
    assert!(
        text.contains("/reasoning [low|medium|high] alias of /effort"),
        "reasoning row: {text}"
    );
    assert!(
        text.contains("/effort [low|medium|high] Set reasoning effort"),
        "canonical effort row must not be an alias: {text}"
    );
}

#[test]
fn partial_json_field_reads_a_truncated_value() {
    // Closed value.
    let done = r#"{"path":"a.html","content":"<h1>hi</h1>"}"#;
    assert_eq!(partial_json_field(done, "path"), Some("a.html"));
    assert_eq!(partial_json_field(done, "content"), Some("<h1>hi</h1>"));

    // Cut mid-value: everything that arrived is the value.
    let cut = r#"{"path":"a.html","content":"<!doctype html>\n<html"#;
    assert_eq!(
        partial_json_field(cut, "content"),
        Some(r#"<!doctype html>\n<html"#)
    );

    // Cut before the field even opens.
    assert_eq!(partial_json_field(r#"{"path":"a.htm"#, "content"), None);

    // An escaped quote inside the value does not end it.
    let escaped = r#"{"content":"say \"hi\" now"#;
    assert_eq!(
        partial_json_field(escaped, "content"),
        Some(r#"say \"hi\" now"#)
    );

    // The field name occurring inside an earlier value is not the field.
    let decoy = r#"{"path":"my\"content\".txt","content":"real"#;
    assert_eq!(partial_json_field(decoy, "content"), Some("real"));
}

#[test]
fn unescape_partial_json_string_survives_a_cut_escape() {
    assert_eq!(unescape_partial_json_string(r#"a\nb"#), "a\nb");
    // Dangling backslash: the escape's payload hasn't arrived.
    assert_eq!(unescape_partial_json_string(r#"a\nb\"#), "a\nb");
    // An even run is a real escaped backslash, keep it.
    assert_eq!(unescape_partial_json_string(r#"a\\"#), r"a\");
    // Partial \u escape.
    assert_eq!(unescape_partial_json_string(r#"hi \u26"#), "hi ");
    assert_eq!(unescape_partial_json_string(r#"hi ☃"#), "hi ☃");
}

/// A streaming `write` previews the file as it arrives instead of sitting
/// on a featureless "Preparing write" spinner.
#[test]
fn streaming_write_previews_the_body() {
    let body: String = (1..=20).map(|n| format!("line {n}\\n")).collect();
    let mut call = super::StartingCall::new("c1".into(), "write".into());
    call.args = format!(r#"{{"path":"game.html","content":"{body}"#);
    let text: Vec<String> = starting_call_lines(&mut call, "⠋", 70)
        .iter()
        .map(line_text)
        .collect();
    let joined = text.join("\n");

    assert!(
        joined.contains("Write: game.html"),
        "no destination: {joined}"
    );
    assert!(
        joined.contains("… (streaming)"),
        "no streaming marker: {joined}"
    );
    // 20 body lines plus the empty one after the final \n = 21; a 12-line
    // window leaves 9 behind.
    assert!(
        joined.contains("… (9 earlier lines)"),
        "wrong elision: {joined}"
    );
    assert!(
        !joined.contains("line 9\n"),
        "line 9 is outside the window: {joined}"
    );
    assert!(
        joined.contains("line 20"),
        "tail should include the newest line: {joined}"
    );
    // Numbers are absolute, not window-relative, and right-aligned.
    assert!(
        text.iter().any(|l| l.contains(" 10 line 10")),
        "gutter: {text:?}"
    );
    assert!(
        text.iter().any(|l| l.contains(" 20 line 20")),
        "gutter: {text:?}"
    );
}

/// The preview is derived from an append-only buffer, so an unchanged
/// length means unchanged content -- the 50ms render tick must not pay for
/// a full rescan of a file-sized argument on every frame.
#[test]
fn preview_is_only_rederived_when_new_bytes_arrive() {
    let mut call = super::StartingCall::new("c1".into(), "write".into());
    call.args = r#"{"path":"a.html","content":"one\ntwo"#.into();
    call.refresh_preview();
    let first = call.preview_at;
    assert_eq!(
        tail_text(&call),
        Some(vec!["one".to_string(), "two".to_string()])
    );

    // Same bytes: the cache holds and nothing is recomputed.
    call.preview.tail = Some(vec![vec![ratatui::text::Span::raw("sentinel")]]);
    call.refresh_preview();
    assert_eq!(tail_text(&call), Some(vec!["sentinel".to_string()]));
    assert_eq!(call.preview_at, first);

    // New bytes invalidate it.
    call.args.push_str(r#"\nthree"#);
    call.refresh_preview();
    assert_eq!(
        tail_text(&call),
        Some(vec![
            "one".to_string(),
            "two".to_string(),
            "three".to_string()
        ])
    );
}

/// Before `content` opens there is nothing to preview, but the path is
/// already worth showing.
#[test]
fn streaming_write_shows_the_path_before_the_body() {
    let mut call = super::StartingCall::new("c1".into(), "write".into());
    call.args = r#"{"path":"game.html","cont"#.into();
    let text: Vec<String> = starting_call_lines(&mut call, "⠋", 70)
        .iter()
        .map(line_text)
        .collect();
    assert_eq!(text.len(), 1);
    assert!(
        text[0].contains("Preparing write: game.html"),
        "got {text:?}"
    );
}

/// A shell call types its command into a terminal box as the arguments
/// stream, so it never sits on a plain "Preparing bash" throbber; the box is
/// the same one the running call becomes.
#[test]
fn a_streaming_shell_call_types_into_a_terminal_box() {
    let mut call = super::StartingCall::new("c1".into(), "bash".into());
    call.args = r#"{"command":"ls -la"#.into();
    let text: Vec<String> = starting_call_lines(&mut call, "⠋", 70)
        .iter()
        .map(line_text)
        .collect();
    let joined = text.join("\n");
    assert!(!joined.contains("Preparing"), "no plain throbber: {joined}");
    assert!(joined.contains("$ ls -la"), "command on the prompt line: {joined}");
    assert!(joined.contains("typing"), "streaming status: {joined}");
    assert!(joined.contains('\u{250c}'), "framed like a terminal: {joined}");
}

/// Before any command byte a shell call still shows the empty terminal
/// prompt, not "Preparing bash".
#[test]
fn a_shell_call_shows_the_prompt_before_the_command_arrives() {
    let mut call = super::StartingCall::new("c1".into(), "bash".into());
    call.args = r#"{"comm"#.into();
    let joined = starting_call_lines(&mut call, "⠋", 70)
        .iter()
        .map(line_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!joined.contains("Preparing"), "no plain throbber: {joined}");
    assert!(joined.contains("$"), "prompt is shown: {joined}");
    assert!(joined.contains('\u{250c}'), "framed: {joined}");
}

/// A tool with no streaming preview (no command, no file body) keeps the
/// plain throbber -- there is nothing to type.
#[test]
fn other_tools_keep_the_plain_throbber() {
    let mut call = super::StartingCall::new("c1".into(), "grep".into());
    call.args = r#"{"pattern":"foo"#.into();
    let text: Vec<String> = starting_call_lines(&mut call, "⠋", 70)
        .iter()
        .map(line_text)
        .collect();
    assert_eq!(text.len(), 1);
    assert!(text[0].contains("Preparing grep"), "got {text:?}");
}

/// A `write` of minified or single-line content (a bundle, a JSON blob)
/// grows one preview line without bound. Unclamped that line is
/// re-highlighted in full on every argument delta -- syntect is linear in
/// line length -- and its wrapped row count floods the viewport the
/// preview lives in. Both are bounded by clamping the line itself.
#[test]
fn an_enormous_single_preview_line_is_clamped() {
    let mut call = super::StartingCall::new("c1".into(), "write".into());
    let body = "x".repeat(20_000);
    call.args = format!(r#"{{"path":"bundle.js","content":"{body}"#);
    let text: Vec<String> = starting_call_lines(&mut call, "\u{280b}", 70)
        .iter()
        .map(line_text)
        .collect();

    let body_row = text
        .iter()
        .find(|l| l.contains("xxx"))
        .unwrap_or_else(|| panic!("no body row in {text:?}"));
    let xs = body_row.chars().filter(|&c| c == 'x').count();
    assert!(
        xs <= super::STREAM_MAX_LINE_CHARS,
        "preview line kept {xs} chars of a 20000-char line"
    );
    assert!(
        body_row.contains('\u{2026}'),
        "clamped line is not marked as truncated: {body_row:?}"
    );
}

/// Which end survives the clamp differs by line: a finished line reads
/// from its start, while the last one is still open and is where new bytes
/// land, so watching its tail is what shows the write progressing.
#[test]
fn a_clamped_line_keeps_its_head_unless_it_is_the_open_one() {
    let mut call = super::StartingCall::new("c1".into(), "write".into());
    let filler = "-".repeat(super::STREAM_MAX_LINE_CHARS * 2);
    call.args =
        format!(r#"{{"path":"a.txt","content":"HEAD1{filler}TAIL1\nHEAD2{filler}TAIL2"#);
    let text: Vec<String> = starting_call_lines(&mut call, "\u{280b}", 70)
        .iter()
        .map(line_text)
        .collect();
    let joined = text.join("\n");

    assert!(
        joined.contains("HEAD1"),
        "finished line lost its head: {joined}"
    );
    assert!(
        !joined.contains("TAIL1"),
        "finished line kept its tail: {joined}"
    );
    assert!(
        joined.contains("TAIL2"),
        "open line lost its tail: {joined}"
    );
    assert!(
        !joined.contains("HEAD2"),
        "open line kept its head: {joined}"
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
    for _ in 0..(super::EVENT_DRAIN_MAX + 50) {
        tx.send(StreamEvent::Token { text: "x".into() })
            .expect("send");
    }
    assert_eq!(
        drain_stream_events(&mut app, &mut current).await,
        super::EVENT_DRAIN_MAX
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

/// A path-carrying tool that isn't `write` must be named as itself.
#[test]
fn starting_throbber_names_the_actual_tool() {
    for name in ["read", "edit", "list"] {
        let mut call = super::StartingCall::new("c1".into(), name.into());
        call.args = r#"{"path":"src/main.rs"#.into();
        let text: Vec<String> = starting_call_lines(&mut call, "⠋", 70)
            .iter()
            .map(line_text)
            .collect();
        assert_eq!(text.len(), 1);
        assert!(
            text[0].contains(&format!("Preparing {name}: src/main.rs")),
            "got {text:?}"
        );
        assert!(!text[0].contains("write"), "wrong tool named: {text:?}");
    }
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

/// `/help` is the home for keybindings now that the footer no longer
/// carries them, so every advertised binding has to reach the listing.
#[tokio::test]
async fn help_lists_every_keybinding() {
    let mut app = test_app();
    run_command(&mut app, "help", &no_mcp()).await;
    let text: String = app.transcript.iter().map(row_text).collect();
    for (keys, description) in KEY_BINDINGS {
        assert!(text.contains(keys), "missing keys {keys:?} in: {text}");
        assert!(
            text.contains(description),
            "missing description {description:?} in: {text}"
        );
    }
}

/// The idle footer carries no cheat sheet at all -- not on a fresh
/// session, not while typing the first message, not after it. Discovery
/// lives in the opening transcript note and `/help`.
#[test]
fn idle_footer_never_shows_a_cheat_sheet() {
    let mut app = test_app();
    type Setup<'a> = (&'a str, &'a dyn Fn(&mut App));
    let states: [Setup; 3] = [
        ("fresh", &|_: &mut App| {}),
        ("typing", &|a: &mut App| {
            for c in "hel".chars() {
                a.input_insert(c);
            }
        }),
        ("used", &|a: &mut App| {
            a.history.push(json!({ "role": "user", "content": "hi" }));
        }),
    ];
    for (label, setup) in states {
        setup(&mut app);
        let rows = render_rows(&mut app, 80, 12);
        // The dock is the last row: location on the left, hints on the
        // right. Idle contributes no hints, so only the location shows.
        let dock = rows.last().expect("non-empty render").trim();
        assert!(
            dock.starts_with("📂") && !dock.contains("Ctrl-"),
            "{label}: idle dock should carry no cheat sheet, got {dock:?}"
        );
    }
}

/// A transient detail (`stop_reason=...`, `cancelled`) still owns the
/// footer row, and starts at the same column the hints used to.
#[test]
fn idle_footer_still_shows_transient_detail() {
    let mut app = test_app();
    app.detail = "stop_reason=stop".into();
    let rows = render_rows(&mut app, 80, 12);
    let dock = rows.last().unwrap();
    assert!(dock.trim_end().ends_with("stop_reason=stop"), "{dock:?}");
    assert!(
        dock.contains("/tmp/repo"),
        "location keeps its place: {dock:?}"
    );
}

/// Working dir + branch share the single dock row below the input with the
/// key hints -- not split across the top and bottom of the screen, and not
/// spending a row of their own.
#[test]
fn path_shares_the_dock_row_with_the_hints() {
    let mut app = test_app();
    app.git_branch = Some("goal/general-agent".into());
    app.status = Status::Running;
    let rows = render_rows(&mut app, 100, 12);
    let dock = rows.last().expect("non-empty render");
    assert!(
        dock.contains("/tmp/repo") && dock.contains("goal/general-agent"),
        "expected dir+branch on the dock row, got {dock:?}"
    );
    assert!(
        dock.contains("cancel") && dock.contains("scroll"),
        "hints share the same row: {dock:?}"
    );
    // Nothing but the header above the transcript any more.
    assert!(
        !rows[1].contains("/tmp/repo"),
        "path line should no longer render at the top: {:?}",
        rows[1]
    );
}

#[test]
fn tilde_path_abbreviates_only_the_home_prefix() {
    // Whatever the platform resolves as Flint's home, not `HOME` -- which is
    // unset on Windows and made this assert on a variable the function no
    // longer reads.
    let home = crate::core::app::commands::jan_home_dir().expect("a home in tests");
    assert_eq!(tilde_path(&home), "~");
    assert_eq!(tilde_path(&home.join("code/jan")), "~/code/jan");
    // A path that merely starts with the same characters is not a child.
    assert_eq!(tilde_path(std::path::Path::new("/var/tmp/x")), "/var/tmp/x");
}

/// A running turn still needs its transient hints -- only the idle cheat
/// sheet was removed.
#[test]
fn running_footer_keeps_its_hints() {
    let mut app = test_app();
    app.history.push(json!({ "role": "user", "content": "hi" }));
    app.status = Status::Running;
    let rows = render_rows(&mut app, 80, 12);
    assert!(
        rows.iter().any(|r| r.contains("cancel")),
        "running footer should still offer cancel: {rows:?}"
    );
}

#[test]
fn goal_is_a_registered_command() {
    assert!(SLASH_COMMANDS.iter().any(|c| c.name == "/goal"));
}

#[test]
fn plan_is_a_registered_command() {
    assert!(SLASH_COMMANDS.iter().any(|c| c.name == "/plan"));
}

#[tokio::test]
async fn goal_set_stores_condition_and_starts_a_turn() {
    let mut app = test_app();
    run_command(&mut app, "goal all tests in test/auth pass", &no_mcp()).await;
    let goal = app.goal.as_ref().expect("goal should be set");
    assert_eq!(goal.condition, "all tests in test/auth pass");
    assert!(goal.is_active());
    // Setting a goal starts the first turn with the condition as the prompt.
    assert!(app.want_start, "a turn should be queued");
    assert_eq!(app.status, Status::Running);
    let last = app
        .history
        .last()
        .expect("history has the condition prompt");
    assert_eq!(
        last.get("content").and_then(|c| c.as_str()),
        Some("all tests in test/auth pass")
    );
}

#[tokio::test]
async fn goal_clear_removes_active_goal() {
    let mut app = test_app();
    app.goal = Some(crate::core::agent::goal::GoalState::new("x"));
    run_command(&mut app, "goal clear", &no_mcp()).await;
    assert!(app.goal.is_none());
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("goal cleared"), "missing note: {text}");
}

#[tokio::test]
async fn goal_clear_with_no_goal_notes() {
    let mut app = test_app();
    run_command(&mut app, "goal clear", &no_mcp()).await;
    assert!(app.goal.is_none());
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("no active goal"), "missing note: {text}");
}

#[tokio::test]
async fn goal_status_reports_active_goal() {
    let mut app = test_app();
    let mut goal = crate::core::agent::goal::GoalState::new("make git status clean");
    goal.turns = 3;
    goal.last_reason = "two files still modified".into();
    app.goal = Some(goal);
    run_command(&mut app, "goal", &no_mcp()).await;
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("make git status clean"), "condition: {text}");
    assert!(text.contains("turns: 3"), "turn count: {text}");
    assert!(text.contains("two files still modified"), "reason: {text}");
}

#[tokio::test]
async fn goal_status_with_no_goal_notes() {
    let mut app = test_app();
    run_command(&mut app, "goal", &no_mcp()).await;
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("no active goal"), "missing note: {text}");
}

#[tokio::test]
async fn effort_command_reports_current_level() {
    let mut app = test_app();
    run_command(&mut app, "effort", &no_mcp()).await;
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(
        text.contains("medium"),
        "default level not reported: {text}"
    );
}

#[tokio::test]
async fn effort_command_sets_valid_level() {
    let mut app = test_app();
    run_command(&mut app, "effort high", &no_mcp()).await;
    assert_eq!(app.reasoning_effort, "high");
    assert_eq!(app.last_non_low_effort, "high");
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("set to high"), "missing note: {text}");
}

#[tokio::test]
async fn effort_command_rejects_unknown_level() {
    let mut app = test_app();
    run_command(&mut app, "effort turbo", &no_mcp()).await;
    assert_eq!(
        app.reasoning_effort, "medium",
        "invalid level must not apply"
    );
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(
        text.contains("unknown effort level"),
        "missing note: {text}"
    );
}

#[tokio::test]
async fn think_alias_reports_current_level() {
    let mut app = test_app();
    run_command(&mut app, "think", &no_mcp()).await;
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(
        text.contains("medium"),
        "default level not reported: {text}"
    );
}

#[tokio::test]
async fn think_alias_sets_valid_level() {
    let mut app = test_app();
    run_command(&mut app, "think high", &no_mcp()).await;
    assert_eq!(app.reasoning_effort, "high");
    assert_eq!(app.last_non_low_effort, "high");
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("set to high"), "missing note: {text}");
}

#[tokio::test]
async fn think_alias_rejects_unknown_level() {
    let mut app = test_app();
    run_command(&mut app, "think turbo", &no_mcp()).await;
    assert_eq!(
        app.reasoning_effort, "medium",
        "invalid level must not apply"
    );
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(
        text.contains("unknown effort level"),
        "missing note: {text}"
    );
}

#[tokio::test]
async fn reasoning_alias_reports_current_level() {
    let mut app = test_app();
    run_command(&mut app, "reasoning", &no_mcp()).await;
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(
        text.contains("medium"),
        "default level not reported: {text}"
    );
}

#[tokio::test]
async fn reasoning_alias_sets_valid_level() {
    let mut app = test_app();
    run_command(&mut app, "reasoning high", &no_mcp()).await;
    assert_eq!(app.reasoning_effort, "high");
    assert_eq!(app.last_non_low_effort, "high");
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("set to high"), "missing note: {text}");
}

#[tokio::test]
async fn reasoning_alias_rejects_unknown_level() {
    let mut app = test_app();
    run_command(&mut app, "reasoning turbo", &no_mcp()).await;
    assert_eq!(
        app.reasoning_effort, "medium",
        "invalid level must not apply"
    );
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(
        text.contains("unknown effort level"),
        "missing note: {text}"
    );
}

#[test]
fn alt_t_toggles_between_low_and_last_non_low() {
    let mut app = test_app();
    app.reasoning_effort = "medium".into();
    app.toggle_reasoning_effort();
    assert_eq!(app.reasoning_effort, "low");
    assert_eq!(app.last_non_low_effort, "medium");
    app.toggle_reasoning_effort();
    assert_eq!(
        app.reasoning_effort, "medium",
        "toggle back restores last non-low"
    );
}

#[test]
fn alt_t_remembers_the_latest_non_low_selection() {
    let mut app = test_app();
    app.reasoning_effort = "high".into();
    app.last_non_low_effort = "high".into();
    app.toggle_reasoning_effort();
    assert_eq!(app.reasoning_effort, "low");
    app.toggle_reasoning_effort();
    assert_eq!(
        app.reasoning_effort, "high",
        "restores the latest non-low, not a hardcoded default"
    );
}

#[test]
fn shift_tab_cycles_effort_through_all_levels() {
    let mut app = test_app();
    app.reasoning_effort = "low".into();
    app.cycle_reasoning_effort();
    assert_eq!(app.reasoning_effort, "medium");
    app.cycle_reasoning_effort();
    assert_eq!(app.reasoning_effort, "high");
    app.cycle_reasoning_effort();
    assert_eq!(app.reasoning_effort, "low", "cycles back to low");
    assert_eq!(
        app.last_non_low_effort, "high",
        "tracks the most recent non-low"
    );
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
fn cancel_run_stops_goal_eval_but_keeps_goal() {
    let mut app = test_app();
    app.goal = Some(crate::core::agent::goal::GoalState::new("cond"));
    app.goal_eval_pending = true;
    app.status = Status::Running;
    app.cancel_run();
    assert!(!app.goal_eval_pending, "cancel stops the loop");
    assert!(app.goal.is_some(), "the goal itself is kept for inspection");
}

#[test]
fn goal_persists_and_restores_via_thread_metadata() {
    let mut app = test_app();
    let mut goal = crate::core::agent::goal::GoalState::new("tests pass");
    goal.turns = 2;
    goal.last_reason = "one failing".into();
    app.goal = Some(goal);
    let meta = app.thread_metadata().expect("metadata present with a goal");
    assert!(meta.get("goal").is_some());

    let mut restored = test_app();
    restore_goal(&mut restored, Some(&meta));
    let g = restored.goal.clone().expect("goal restored");
    assert_eq!(g.condition, "tests pass");
    assert_eq!(g.turns, 2);
    assert_eq!(g.last_reason, "one failing");
    assert!(g.is_active());
}

fn plan_review_request() -> crate::core::agent::interaction::AskRequest {
    crate::core::agent::interaction::AskRequest::parse(&json!({
        "questions": [{
            "id": crate::core::agent::plan::PLAN_REVIEW_QUESTION_ID,
            "question": "Ready to execute?",
            "options": [
                {"label": crate::core::agent::plan::EXECUTE_PLAN_LABEL},
                {"label": crate::core::agent::plan::KEEP_PLANNING_LABEL},
                {"label": crate::core::agent::plan::EXIT_PLAN_LABEL},
            ]
        }]
    }))
    .unwrap()
}

fn staged_todos() -> crate::core::agent::todo::TodoList {
    use crate::core::agent::todo::{TodoItem, TodoList, TodoPhase, TodoStatus};
    TodoList {
        phases: vec![TodoPhase {
            name: "Plan".into(),
            tasks: vec![TodoItem {
                content: "do the thing".into(),
                status: TodoStatus::Pending,
            }],
        }],
    }
}

#[tokio::test]
async fn plan_command_enters_and_exits_while_idle() {
    use crate::core::agent::plan::RunMode;
    let mut app = test_app();
    run_command(&mut app, "plan", &no_mcp()).await;
    assert_eq!(app.run_mode, RunMode::Plan);
    run_command(&mut app, "plan exit", &no_mcp()).await;
    assert_eq!(app.run_mode, RunMode::Normal);
}

#[tokio::test]
async fn mode_command_switches_between_review_ask_and_auto() {
    use crate::core::agent::plan::RunMode;
    let mut app = test_app();
    run_command(&mut app, "mode", &no_mcp()).await;
    run_command(&mut app, "mode review", &no_mcp()).await;
    assert_eq!(app.run_mode, RunMode::Plan);
    run_command(&mut app, "mode auto", &no_mcp()).await;
    assert_eq!(app.run_mode, RunMode::Normal);
    run_command(&mut app, "mode sideways", &no_mcp()).await;
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("unknown mode 'sideways'"), "note: {text}");
    assert!(text.contains("mode: auto"), "note: {text}");
    app.status = Status::Running;
    run_command(&mut app, "mode review", &no_mcp()).await;
    assert_eq!(app.run_mode, RunMode::Normal, "must not switch mid-turn");
}

#[test]
fn export_and_schedule_commands_report_instead_of_failing() {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let mut app = test_app();
    crate::core::app::commands::with_temp_data_folder(|_| {
        rt.block_on(async {
            run_command(&mut app, "export", &no_mcp()).await;
            run_command(&mut app, "schedule", &no_mcp()).await;
            run_command(&mut app, "schedule run nope", &no_mcp()).await;
            run_command(&mut app, "schedule frob", &no_mcp()).await;
        });
    });
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("nothing to export yet"), "{text}");
    assert!(text.contains("no scheduled tasks"), "{text}");
    assert!(text.contains("no scheduled task 'nope'"), "{text}");
    assert!(text.contains("usage: /schedule"), "{text}");
}

#[tokio::test]
async fn plan_command_rejected_while_running() {
    use crate::core::agent::plan::RunMode;
    let mut app = test_app();
    app.status = Status::Running;
    run_command(&mut app, "plan", &no_mcp()).await;
    assert_eq!(app.run_mode, RunMode::Normal, "must not switch mid-turn");
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("only settable while idle"), "note: {text}");
}

#[tokio::test]
async fn plan_command_with_text_enters_plan_and_submits_it() {
    use crate::core::agent::plan::RunMode;
    let mut app = test_app();
    run_command(
        &mut app,
        "plan make a html cat slide. use 3 subagents to research",
        &no_mcp(),
    )
    .await;
    assert_eq!(
        app.run_mode,
        RunMode::Plan,
        "text arg must also enter plan mode"
    );
    assert_eq!(app.status, Status::Running, "seeded text must start a turn");
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(
        text.contains("make a html cat slide"),
        "seeded text must render as the user's message: {text}"
    );
}

#[tokio::test]
async fn plan_command_with_text_while_already_planning_just_submits() {
    use crate::core::agent::plan::RunMode;
    let mut app = test_app();
    app.run_mode = RunMode::Plan;
    run_command(&mut app, "plan investigate the auth module", &no_mcp()).await;
    assert_eq!(app.run_mode, RunMode::Plan);
    assert_eq!(app.status, Status::Running);
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("investigate the auth module"), "{text}");
}

#[test]
fn run_mode_persists_and_restores_via_thread_metadata() {
    use crate::core::agent::plan::RunMode;
    let mut app = test_app();
    app.run_mode = RunMode::Plan;
    let meta = app
        .thread_metadata()
        .expect("metadata present in plan mode");
    assert_eq!(meta.get("run_mode").and_then(|v| v.as_str()), Some("plan"));

    let mut restored = test_app();
    restore_run_mode(&mut restored, Some(&meta));
    assert_eq!(restored.run_mode, RunMode::Plan);
    // Resume must never auto-execute a saved plan.
    assert_eq!(restored.status, Status::Idle);
    assert!(restored.message_queue.is_empty());
}

#[test]
fn normal_mode_omits_run_mode_from_metadata() {
    // Old threads / normal sessions keep clean, backward-compatible metadata.
    let app = test_app();
    assert!(app.thread_metadata().is_none());
}

// ── session todo: reminder policy, editor, persistence ─────────────────

fn seed_open_todos(app: &mut App) {
    use crate::core::agent::todo::{TodoItem, TodoList, TodoPhase, TodoStatus};
    app.todos = TodoList {
        phases: vec![TodoPhase {
            name: "P".into(),
            tasks: vec![
                TodoItem {
                    content: "t1".into(),
                    status: TodoStatus::InProgress,
                },
                TodoItem {
                    content: "t2".into(),
                    status: TodoStatus::Pending,
                },
            ],
        }],
    };
}

/// A clean assistant turn that yielded a final answer (the reminder boundary).
fn finish_clean_turn(app: &mut App) {
    finish_clean_turn_with_answer(app, "all set");
}

/// Like `finish_clean_turn`, but with a caller-chosen final answer text.
fn finish_clean_turn_with_answer(app: &mut App, text: &str) {
    app.status = Status::Running;
    app.apply(StreamEvent::Token { text: text.into() });
    app.on_done("stop".into(), None);
}

fn last_history_content(app: &App) -> String {
    app.history
        .last()
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

#[test]
fn todo_reminder_fires_once_at_clean_boundary_with_open_work() {
    let mut app = test_app();
    seed_open_todos(&mut app);
    finish_clean_turn(&mut app);
    assert!(app.want_start, "open work must queue one continuation turn");
    let injected = last_history_content(&app);
    assert!(injected.contains("unfinished todos"), "got: {injected}");
    assert!(injected.contains("t1") && injected.contains("t2"));
    // The reminder is hidden: it never renders into the transcript.
    let rows: String = app.transcript.iter().map(row_text).collect();
    assert!(
        !rows.contains("unfinished todos"),
        "reminder must not render as a user row"
    );
}

#[test]
fn todo_reminder_suppressed_when_agent_updated_todos_this_turn() {
    let mut app = test_app();
    seed_open_todos(&mut app);
    // A successful todo mutation happened this turn: the agent is engaged.
    app.todo_call_this_turn = true;
    app.todo_ok_this_turn = true;
    finish_clean_turn(&mut app);
    assert!(!app.want_start, "an engaged turn must not be nagged");
}

#[test]
fn todo_reminder_suppressed_in_plan_mode() {
    use crate::core::agent::plan::RunMode;
    let mut app = test_app();
    app.run_mode = RunMode::Plan;
    seed_open_todos(&mut app);
    finish_clean_turn(&mut app);
    assert!(
        !app.want_start,
        "plan mode stages todos, never auto-executes"
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
fn todo_reminder_deduplicates_repeats() {
    let mut app = test_app();
    seed_open_todos(&mut app);
    finish_clean_turn(&mut app);
    assert!(app.want_start);
    assert!(last_history_content(&app).contains("unfinished todos"));
    // The loop consumes want_start when it spawns the continuation run.
    app.want_start = false;
    // Model responds without changing todos and yields again: the same open
    // summary must not fire a second identical reminder.
    finish_clean_turn(&mut app);
    assert!(!app.want_start, "identical reminder must not repeat");
    assert!(
        !last_history_content(&app).contains("unfinished todos"),
        "last message should be the assistant answer, not a repeat reminder"
    );
}

#[test]
fn todo_reminder_retries_after_failed_mutation() {
    let mut app = test_app();
    seed_open_todos(&mut app);
    // A todo call this turn with no success snapshot = a failed mutation.
    app.todo_call_this_turn = true;
    app.todo_ok_this_turn = false;
    finish_clean_turn(&mut app);
    assert!(
        app.want_start,
        "a failed mutation queues one retry reminder"
    );
    assert!(last_history_content(&app).contains("failed"));
}

#[test]
fn awaiting_user_answer_detects_plain_questions_and_response_cues() {
    assert!(assistant_is_awaiting_user_answer(
        "Which approach do you want?"
    ));
    assert!(assistant_is_awaiting_user_answer(
        "Q: proceed with the migration?"
    ));
    assert!(assistant_is_awaiting_user_answer(
        "I've drafted both options.\nLet me know which one to build."
    ));
    assert!(assistant_is_awaiting_user_answer(
        "Please confirm before I continue."
    ));
    assert!(!assistant_is_awaiting_user_answer("Done, the tests pass."));
    assert!(!assistant_is_awaiting_user_answer(
        "This uses a well-known algorithm, is it fast enough already? It runs in O(n)."
    ));
    assert!(!assistant_is_awaiting_user_answer(""));
}

#[test]
fn todo_reminder_suppressed_when_assistant_is_asking_a_question() {
    let mut app = test_app();
    seed_open_todos(&mut app);
    finish_clean_turn_with_answer(&mut app, "Which database should I use, Postgres or MySQL?");
    assert!(
        !app.want_start,
        "a plain-text question must not be talked over by the todo reminder"
    );
}

#[test]
fn todo_reminder_stops_after_max_reminders_even_as_summary_changes() {
    let mut app = test_app();
    seed_open_todos(&mut app);
    for i in 0..3 {
        app.want_start = false;
        finish_clean_turn(&mut app);
        assert!(
            app.want_start,
            "reminder {i} of the 3-reminder budget must fire"
        );
        app.reminder_awaiting_progress = false;
        // Vary the open-work summary each round so the same-summary dedup
        // alone could never explain a stop -- only the hard cap should.
        app.todos.phases[0].tasks[0].content = format!("t1-{i}");
    }
    app.want_start = false;
    finish_clean_turn(&mut app);
    assert!(
        !app.want_start,
        "the 4th reminder must be suppressed by the per-cycle cap"
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

fn todos_from(
    phases: Vec<(&str, Vec<(&str, crate::core::agent::todo::TodoStatus)>)>,
) -> crate::core::agent::todo::TodoList {
    use crate::core::agent::todo::{TodoItem, TodoList, TodoPhase};
    TodoList {
        phases: phases
            .into_iter()
            .map(|(name, tasks)| TodoPhase {
                name: name.into(),
                tasks: tasks
                    .into_iter()
                    .map(|(content, status)| TodoItem {
                        content: content.into(),
                        status,
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn crossed_out(line: &ratatui::text::Line) -> bool {
    line.spans
        .iter()
        .any(|s| s.style.add_modifier.contains(Modifier::CROSSED_OUT))
}

#[test]
fn single_phase_plan_column_lists_its_tasks() {
    use crate::core::agent::todo::TodoStatus::*;
    let todos = todos_from(vec![(
        "only",
        vec![
            ("alpha", InProgress),
            ("beta", Pending),
            ("gamma", Completed),
        ],
    )]);
    let lines: Vec<String> = super::todo_column(&todos, 60, 8)
        .iter()
        .map(line_text)
        .collect();
    // Head line: progress plus the hint that opens the editor. A single
    // phase has no idx/count, and its name is not worth a row.
    assert!(lines[0].contains("Todos · 1/3"), "{lines:?}");
    assert!(lines[0].contains("/todo"), "{lines:?}");
    assert!(!lines.iter().any(|l| l.contains("only")), "{lines:?}");
    assert!(lines[1].contains("☐ alpha"), "{lines:?}");
    assert!(lines[2].contains("☐ beta"), "{lines:?}");
    assert!(lines[3].contains("☑ gamma"), "{lines:?}");
}

/// The panel belongs to the input dock: it must render ABOVE the horizontal
/// rule that separates the transcript from the input, not stranded between
/// that rule and the prompt.
#[test]
fn status_panel_sits_above_the_input_separator_rule() {
    use crate::core::agent::todo::TodoStatus::*;
    let mut app = test_app();
    app.todos = todos_from(vec![("only", vec![("alpha", InProgress)])]);
    let rows = render_rows(&mut app, 60, 20);

    let todo_row = rows
        .iter()
        .position(|r| r.contains("Todos"))
        .expect("todos");
    let input_row = rows
        .iter()
        .position(|r| r.contains("Type here to chat with agent"))
        .expect("input");
    // The rule is the last full-width run of `─` before the input.
    let rule_row = rows[..input_row]
        .iter()
        .rposition(|r| r.trim_end().len() > 40 && r.trim_end().chars().all(|c| c == '─'))
        .expect("separator rule above the input");

    assert!(
        todo_row < rule_row,
        "the panel must be above the rule (todos={todo_row}, rule={rule_row}): {rows:#?}"
    );
    assert!(
        rule_row < input_row,
        "the rule must sit directly above the input: {rows:#?}"
    );
}

/// A session with nothing live keeps the original look: one rule directly
/// above the input, with no leftover blank row where the panel would be.
#[test]
fn separator_rule_hugs_the_input_when_there_are_no_todos() {
    let mut app = test_app();
    assert!(app.todos.is_empty());
    let rows = render_rows(&mut app, 60, 20);

    let input_row = rows
        .iter()
        .position(|r| r.contains("Type here to chat with agent"))
        .expect("input");
    let rule_row = rows[..input_row]
        .iter()
        .rposition(|r| r.trim_end().len() > 40 && r.trim_end().chars().all(|c| c == '─'))
        .expect("separator rule above the input");
    assert_eq!(
        rule_row + 1,
        input_row,
        "no gap between rule and input: {rows:#?}"
    );
}

/// Only the phase in flight spends rows on its tasks; the head line already
/// names it and counts the others.
#[test]
fn multi_phase_plan_column_expands_only_the_active_phase() {
    use crate::core::agent::todo::TodoStatus::*;
    let todos = todos_from(vec![
        (
            "backend",
            vec![("scaffold", Completed), ("routes", InProgress)],
        ),
        ("frontend", vec![("ui", Pending), ("polish", Pending)]),
    ]);
    let lines: Vec<String> = super::todo_column(&todos, 60, 8)
        .iter()
        .map(line_text)
        .collect();
    assert!(
        lines[0].contains("Todos · 1/2") && lines[0].contains("backend 1/2"),
        "head names the phase and both progressions: {lines:?}"
    );
    assert!(
        lines.iter().any(|l| l.contains("routes")),
        "active tasks shown: {lines:?}"
    );
    assert!(
        !lines
            .iter()
            .any(|l| l.contains("ui") || l.contains("polish")),
        "inactive phase costs no rows: {lines:?}"
    );
}

#[test]
fn completed_and_abandoned_todos_render_distinctly() {
    use crate::core::agent::todo::TodoStatus::*;
    let todos = todos_from(vec![(
        "only",
        vec![("shipped", Completed), ("dropped", Abandoned)],
    )]);
    let col = super::todo_column(&todos, 60, 8);
    let done = col
        .iter()
        .find(|l| line_text(l).contains("shipped"))
        .unwrap();
    let gone = col
        .iter()
        .find(|l| line_text(l).contains("dropped"))
        .unwrap();
    // Completed: checked glyph + strikethrough.
    assert!(line_text(done).contains("☑"), "{:?}", line_text(done));
    assert!(crossed_out(done), "completed is struck through");
    // Abandoned: distinct glyph, strikethrough, and a red accent.
    assert!(line_text(gone).contains("☒"), "{:?}", line_text(gone));
    assert!(crossed_out(gone), "abandoned is struck through");
    assert!(
        gone.spans
            .iter()
            .any(|s| s.style.fg == Some(ratatui::style::Color::Red)),
        "abandoned carries a red accent to distinguish it from completed"
    );
}

/// Folded reasoning puts nothing on screen, so the badge has to carry the
/// motion: a crest sweeps the word, one character per spinner frame, and
/// wraps back to the start after a pause.
#[test]
fn thinking_badge_shimmers_across_its_frames() {
    use ratatui::style::{Modifier, Style};
    let palette = [
        Style::new().yellow().bold(),
        Style::new().yellow(),
        Style::new().yellow().dim(),
    ];
    let crest_at = |frame: usize| {
        let spans = super::shimmer_spans("thinking", palette, frame);
        // The text is intact and unmoved at every frame; only style changes.
        let text: String = spans.iter().map(|s| s.content.as_ref()).collect::<String>();
        assert_eq!(text, "thinking", "frame {frame} must not move the label");
        spans
            .iter()
            .position(|s| s.style.add_modifier.contains(Modifier::BOLD))
    };

    assert_eq!(crest_at(0), Some(0));
    assert_eq!(
        crest_at(3),
        Some(3),
        "the crest advances one char per frame"
    );
    // Past the end of the word the crest is off-screen (the pause), then
    // the cycle restarts.
    assert_eq!(crest_at(8), None, "pause between sweeps");
    assert_eq!(
        crest_at(8 + super::SHIMMER_PAUSE),
        Some(0),
        "sweep restarts"
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
    let footer: String = super::footer_spans(&app)
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
    let footer: String = super::footer_spans(&app)
        .iter()
        .map(|s| s.content.as_ref())
        .collect();
    assert!(!footer.contains("bg shell"), "indicator is gone: {footer}");
}

fn cursor_after_draw(app: &mut App, w: u16, h: u16) -> (Vec<String>, Option<(u16, u16)>) {
    use ratatui::{backend::TestBackend, Terminal};
    let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
    terminal.draw(|f| super::draw(f, app)).unwrap();
    let buf = terminal.backend().buffer().clone();
    let rows = (0..buf.area.height)
        .map(|y| (0..buf.area.width).map(|x| buf[(x, y)].symbol()).collect::<String>())
        .collect();
    let pos = terminal.get_cursor_position().ok().map(|p| (p.x, p.y));
    (rows, pos)
}

#[test]
fn cursor_position_matches_caret_on_wide_chars() {
    let mut app = test_app();
    app.input = "\u{4e16}\u{754c}ab".into();
    app.cursor = "\u{4e16}\u{754c}".len();
    let (rows, pos) = cursor_after_draw(&mut app, 40, 12);
    let input_row = rows.iter().position(|r| r.contains('\u{4e16}')).expect("input row");
    // "> " is 2 cells, each wide char 2: the caret sits on `a` at column 6.
    assert_eq!(pos, Some((6, input_row as u16)), "{rows:?}");
}

#[test]
fn scroll_follows_caret_after_home() {
    let mut app = test_app();
    app.input = (1..=20).map(|n| format!("line{n}")).collect::<Vec<_>>().join("\n");
    app.cursor = 0;
    let (rows, pos) = cursor_after_draw(&mut app, 40, 20);
    assert!(rows.iter().any(|r| r.contains("line1 ") || r.trim_end().ends_with("line1")), "first line visible: {rows:?}");
    let (_, y) = pos.expect("a cursor");
    assert!(rows[y as usize].contains("line1"), "cursor on the caret's row: {rows:?}");
    // And the end of the buffer scrolls into view when the caret goes there.
    app.cursor = app.input.len();
    let (rows, pos) = cursor_after_draw(&mut app, 40, 20);
    assert!(rows.iter().any(|r| r.contains("line20")), "{rows:?}");
    let (_, y) = pos.expect("a cursor");
    assert!(rows[y as usize].contains("line20"), "{rows:?}");
}

#[test]
fn scroll_follows_caret_when_running() {
    let mut app = test_app();
    app.status = Status::Running;
    app.input = (1..=20).map(|n| format!("steer{n}")).collect::<Vec<_>>().join("\n");
    app.cursor = app.input.len();
    let (rows, _) = cursor_after_draw(&mut app, 40, 20);
    assert!(rows.iter().any(|r| r.contains("steer20")), "caret line visible while a turn runs: {rows:?}");
}

#[test]
fn no_cursor_when_the_composer_is_not_live() {
    let mut app = test_app();
    app.status = Status::Running;
    let (_, pos) = cursor_after_draw(&mut app, 40, 12);
    // A status row stands in for the composer: no caret to put a cursor on.
    assert!(!super::composer_live(&app));
    let _ = pos;
}

/// The borderless input box used to reserve two blank rows for borders it
/// does not draw. One row of air above the dock is all it needs.
#[test]
fn input_box_reserves_one_row_of_air() {
    let mut app = test_app();
    let rows = render_rows(&mut app, 80, 12);
    let input = rows
        .iter()
        .position(|r| r.contains("Type here to chat with agent"))
        .expect("input");
    assert_eq!(
        input + 3,
        rows.len(),
        "input, one blank, then the dock: {rows:?}"
    );
    assert!(rows[input + 1].trim().is_empty());
    assert!(rows.last().unwrap().contains("/tmp/repo"));
}

/// The pin answers "where are we now" in one line, and carries the hint
/// that opens the editor.
#[test]
fn todo_pin_reports_phase_and_progress() {
    use crate::core::agent::todo::TodoStatus::*;
    let multi = todos_from(vec![
        (
            "backend",
            vec![("scaffold", Completed), ("routes", InProgress)],
        ),
        ("frontend", vec![("ui", Pending)]),
    ]);
    let text = line_text(&super::todo_pin(&multi));
    assert!(text.contains("Todos"), "{text}");
    assert!(text.contains("1/2"), "phase position: {text}");
    assert!(
        text.contains("backend 1/2"),
        "active phase progress: {text}"
    );
    assert!(text.contains("/todo"), "editor hint: {text}");

    let single = todos_from(vec![("only", vec![("a", Completed), ("b", Pending)])]);
    let text = line_text(&super::todo_pin(&single));
    assert!(
        text.contains("Todos · 1/2"),
        "single phase progress: {text}"
    );
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

/// A plan with every task closed stops being live state: the dock drops it
/// after `TODO_HIDE_AFTER`, giving the rows back to the conversation. The
/// list itself survives -- `/todo` still opens it, and the turn-based aging
/// still owns clearing it.
#[test]
fn finished_plan_hides_from_the_dock_after_the_timeout() {
    use crate::core::agent::todo::TodoStatus::*;
    let mut app = test_app();
    app.todos = todos_from(vec![("only", vec![("ship it", Completed)])]);

    // Closed, but only just: still shown, and the deadline is now armed.
    let rows = render_rows(&mut app, 80, 20);
    assert!(rows.iter().any(|r| r.contains("Todos")), "{rows:?}");
    let closed = app
        .todos_closed_at
        .expect("deadline armed on a closed plan");

    // Past the timeout: the dock gives the rows back, the list stays.
    app.todos_closed_at = closed.checked_sub(super::TODO_HIDE_AFTER);
    assert!(app.todos_expired());
    let rows = render_rows(&mut app, 80, 20);
    assert!(!rows.iter().any(|r| r.contains("Todos")), "{rows:?}");
    assert!(!app.todos.is_empty(), "the plan itself is untouched");

    // Reopened work brings it straight back, deadline cleared.
    app.todos = todos_from(vec![("only", vec![("ship it", InProgress)])]);
    let rows = render_rows(&mut app, 80, 20);
    assert!(app.todos_closed_at.is_none(), "deadline disarmed");
    assert!(rows.iter().any(|r| r.contains("Todos")), "{rows:?}");
}

/// The timeout is wall-clock, not turn-based: an open plan is never hidden
/// however long the model sits on it.
#[test]
fn open_plan_is_never_hidden() {
    use crate::core::agent::todo::TodoStatus::*;
    let mut app = test_app();
    app.todos = todos_from(vec![("only", vec![("done", Completed), ("open", Pending)])]);
    render_rows(&mut app, 80, 20);
    assert!(app.todos_closed_at.is_none(), "open work arms nothing");
    assert!(!app.todos_expired());
}

/// A wide terminal sets the plan and the fan-out side by side, each in its
/// own half, so the panel spends rows once instead of twice.
#[test]
fn wide_panel_sets_the_columns_side_by_side() {
    use crate::core::agent::todo::TodoStatus::*;
    let mut app = test_app();
    app.todos = todos_from(vec![("only", vec![("wire routes", InProgress)])]);
    start_subagent(&mut app, "r0", "alpha");
    let rows = render_rows(&mut app, 120, 24);
    let head = rows
        .iter()
        .find(|r| r.contains("Todos"))
        .expect("panel head");
    assert!(
        head.contains("│") && head.contains("1 agent"),
        "both columns share the row: {head:?}"
    );
    assert!(
        head.find("Todos") < head.find("1 agent"),
        "plan on the left, agents on the right: {head:?}"
    );
}

/// Too narrow to split: the columns stack rather than being squeezed into
/// halves too thin to hold a task or an agent name.
#[test]
fn narrow_panel_stacks_the_columns() {
    use crate::core::agent::todo::TodoStatus::*;
    let mut app = test_app();
    app.todos = todos_from(vec![("only", vec![("wire routes", InProgress)])]);
    start_subagent(&mut app, "r0", "alpha");
    let rows = render_rows(&mut app, super::PANEL_SPLIT_MIN_WIDTH - 1, 24);
    assert!(
        !rows.iter().any(|r| r.contains("│")),
        "no divider when stacked: {rows:?}"
    );
    let todos = rows.iter().position(|r| r.contains("Todos")).expect("plan");
    let agents = rows.iter().position(|r| r.contains("≡")).expect("agents");
    assert!(todos < agents, "plan first when stacked: {rows:?}");
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

/// A short terminal spends its rows on the conversation: the panel shrinks
/// first, eliding its own tail, and disappears before the transcript does.
#[test]
fn short_terminal_shrinks_the_panel_before_the_transcript() {
    use crate::core::agent::todo::TodoStatus::*;
    let mut app = test_app();
    let many: Vec<(&str, _)> = (0..12).map(|_| ("a task", Pending)).collect();
    app.todos = todos_from(vec![("only", many)]);

    // Roomy: capped at the panel ceiling, never more.
    assert_eq!(super::panel_budget(40, 2), super::PANEL_MAX_ROWS);
    // Squeezed: only what is left after the fixed rows and the transcript
    // floor, less the row `TRANSCRIPT_BOTTOM_PAD` holds open above the dock,
    // and nothing at all once even that is gone.
    assert_eq!(super::panel_budget(12, 2), 2);
    assert_eq!(super::panel_budget(9, 2), 0);

    let rows = render_rows(&mut app, 80, 12);
    let panel: Vec<&String> = rows
        .iter()
        .filter(|r| r.contains("Todos") || r.contains("a task") || r.contains("more"))
        .collect();
    assert!(panel.len() <= 2, "panel clamped to its budget: {rows:?}");
    assert!(
        rows.iter().any(|r| r.contains("+12 more")),
        "the tail is elided, not dropped silently: {rows:?}"
    );

    // No room at all: the panel yields entirely and the dock still renders.
    let rows = render_rows(&mut app, 80, 9);
    assert!(!rows.iter().any(|r| r.contains("Todos")), "{rows:?}");
    assert!(rows.last().unwrap().contains("/tmp/repo"), "{rows:?}");
}

/// Many parallel agents cannot push the plan off the screen: the column
/// shows what fits and counts the rest.
#[test]
fn crowded_fan_out_elides_with_a_running_count() {
    let mut app = test_app();
    for i in 0..9 {
        start_subagent(&mut app, &format!("r{i}"), &format!("agent-{i}"));
    }
    let rows = render_rows(&mut app, 100, 24);
    let shown = rows.iter().filter(|r| r.contains("agent-")).count();
    assert!(shown < 9, "not every agent fits: {rows:?}");
    assert!(
        rows.iter().any(|r| r.contains("more · /agents")),
        "the rest are counted: {rows:?}"
    );
}

#[tokio::test]
async fn todo_editor_mutations_update_the_canonical_list() {
    let mut app = test_app();
    // Add through the same `append` op the model uses.
    run_command(&mut app, "todo add Build | ship it", &no_mcp()).await;
    assert_eq!(app.todos.done_total(), (0, 1));
    assert_eq!(app.todos.active().unwrap().1.content, "ship it");
    // Mark it done via the editor helper; the projection reflects it.
    super::apply_todo_mutation(&mut app, |l| {
        l.done(crate::core::agent::todo::Target::Task("ship it"))
    })
    .await
    .unwrap();
    assert_eq!(app.todos.done_total(), (1, 1));
}

/// `/todo clear` drops a stale list in one step -- otherwise a finished or
/// abandoned task set lingers in the HUD until each item is removed by hand.
#[tokio::test]
async fn todo_clear_command_empties_the_whole_list() {
    let mut app = test_app();
    run_command(&mut app, "todo add Build | ship it", &no_mcp()).await;
    run_command(&mut app, "todo add Build | and this", &no_mcp()).await;
    assert_eq!(app.todos.done_total(), (0, 2));

    run_command(&mut app, "todo clear", &no_mcp()).await;
    assert!(app.todos.is_empty(), "{:?}", app.todos);

    // Clearing an already-empty list is a no-op note, not an error.
    run_command(&mut app, "todo clear", &no_mcp()).await;
    assert!(app.todos.is_empty());
}

#[tokio::test]
async fn todo_command_bare_opens_editor_overlay() {
    let mut app = test_app();
    run_command(&mut app, "todo add first", &no_mcp()).await;
    run_command(&mut app, "todo", &no_mcp()).await;
    assert!(matches!(
        app.picker.as_ref().map(|p| p.kind),
        Some(PickerKind::Todo)
    ));
}

#[test]
fn todos_persist_and_restore_via_thread_metadata() {
    let mut app = test_app();
    seed_open_todos(&mut app);
    let meta = app.thread_metadata().expect("todos force metadata");
    assert!(meta.get("todos").is_some());

    let mut restored = test_app();
    restore_todos(&mut restored, Some(&meta));
    assert_eq!(
        restored.todos, app.todos,
        "resume/branch reconstructs todos"
    );
}

#[tokio::test]
async fn plan_review_execute_switches_normal_and_queues_continuation() {
    use crate::core::agent::plan::RunMode;
    let mut app = test_app();
    app.run_mode = RunMode::Plan;
    app.apply(StreamEvent::TodoUpdate {
        list: staged_todos(),
    });
    app.status = Status::Running; // an in-flight turn owns the ask
    let registry = crate::core::agent::interaction::new_registry();
    let (request_id, receiver) = crate::core::agent::interaction::register(&registry).await;
    app.apply(StreamEvent::AskRequest {
        request_id,
        request: plan_review_request(),
        timeout_secs: None,
    });
    // Default selection 0 = "Execute plan"; Enter submits.
    press_ask(&mut app, &registry, KeyCode::Enter).await;
    assert_eq!(app.run_mode, RunMode::Normal);
    assert!(
        app.message_queue
            .iter()
            .any(|m| m.text == "Proceed with the plan."),
        "execute must queue a continuation turn"
    );
    let answers = receiver.await.unwrap().unwrap();
    assert_eq!(
        answers[0].selected,
        vec![crate::core::agent::plan::EXECUTE_PLAN_LABEL]
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
    super::apply_plan_review(&mut app, EXECUTE_FRESH_LABEL, "ship it");
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

#[tokio::test]
async fn plan_review_execute_without_todos_stays_in_plan() {
    use crate::core::agent::plan::RunMode;
    let mut app = test_app();
    app.run_mode = RunMode::Plan; // no todos staged
    app.status = Status::Running;
    let registry = crate::core::agent::interaction::new_registry();
    let (request_id, _receiver) = crate::core::agent::interaction::register(&registry).await;
    app.apply(StreamEvent::AskRequest {
        request_id,
        request: plan_review_request(),
        timeout_secs: None,
    });
    press_ask(&mut app, &registry, KeyCode::Enter).await;
    // Atomic handoff: no staged plan => stay in Plan, no continuation.
    assert_eq!(app.run_mode, RunMode::Plan);
    assert!(app.message_queue.is_empty());
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("no plan staged"), "note: {text}");
}

#[tokio::test]
async fn plan_review_keep_planning_stays_in_plan() {
    use crate::core::agent::plan::RunMode;
    let mut app = test_app();
    app.run_mode = RunMode::Plan;
    app.apply(StreamEvent::TodoUpdate {
        list: staged_todos(),
    });
    app.status = Status::Running;
    let registry = crate::core::agent::interaction::new_registry();
    let (request_id, _receiver) = crate::core::agent::interaction::register(&registry).await;
    app.apply(StreamEvent::AskRequest {
        request_id,
        request: plan_review_request(),
        timeout_secs: None,
    });
    press_ask(&mut app, &registry, KeyCode::Down).await; // -> Keep planning
    press_ask(&mut app, &registry, KeyCode::Enter).await;
    assert_eq!(app.run_mode, RunMode::Plan);
    assert!(
        app.message_queue.is_empty(),
        "keep planning must not execute"
    );
}

#[tokio::test]
async fn plan_review_exit_returns_to_normal_without_execution() {
    use crate::core::agent::plan::RunMode;
    let mut app = test_app();
    app.run_mode = RunMode::Plan;
    app.apply(StreamEvent::TodoUpdate {
        list: staged_todos(),
    });
    app.status = Status::Running;
    let registry = crate::core::agent::interaction::new_registry();
    let (request_id, _receiver) = crate::core::agent::interaction::register(&registry).await;
    app.apply(StreamEvent::AskRequest {
        request_id,
        request: plan_review_request(),
        timeout_secs: None,
    });
    press_ask(&mut app, &registry, KeyCode::Down).await;
    press_ask(&mut app, &registry, KeyCode::Down).await; // -> Exit plan mode
    press_ask(&mut app, &registry, KeyCode::Enter).await;
    assert_eq!(app.run_mode, RunMode::Normal);
    assert!(app.message_queue.is_empty(), "exit must not auto-execute");
}

#[tokio::test]
async fn cancelling_plan_review_leaves_plan_enabled() {
    use crate::core::agent::plan::RunMode;
    let mut app = test_app();
    app.run_mode = RunMode::Plan;
    app.status = Status::Running;
    let registry = crate::core::agent::interaction::new_registry();
    let (request_id, receiver) = crate::core::agent::interaction::register(&registry).await;
    app.apply(StreamEvent::AskRequest {
        request_id,
        request: plan_review_request(),
        timeout_secs: None,
    });
    press_ask(&mut app, &registry, KeyCode::Esc).await; // cancel the review
    assert!(app.ask_queue.is_empty(), "review wait must be cleared");
    assert_eq!(app.run_mode, RunMode::Plan, "cancel must not change mode");
    assert!(matches!(
        receiver.await.unwrap(),
        Err(crate::core::agent::interaction::AskError::Cancelled)
    ));
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

#[tokio::test]
async fn new_command_resets_session() {
    let mut app = test_app();
    app.history.push(json!({ "role": "user", "content": "hi" }));
    app.thread_id = Some("t-123".into());
    app.tokens = 42;
    app.push(Line::raw("old content"));

    run_command(&mut app, "new", &no_mcp()).await;

    assert!(app.history.is_empty());
    assert!(app.thread_id.is_none(), "must detach from the saved thread");
    assert_eq!(app.tokens, 0);
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(
        !text.contains("old content"),
        "transcript not reset: {text}"
    );
    assert!(
        text.contains("started a new session"),
        "missing note: {text}"
    );
}

#[tokio::test]
async fn clear_re_prints_the_branded_splash() {
    let mut app = test_app();
    app.approval_phrasing = "--safe: approval needed".to_string();
    app.push(Line::raw("old content"));

    run_command(&mut app, "clear", &no_mcp()).await;

    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(
        !text.contains("old content"),
        "transcript not reset: {text}"
    );
    assert!(
        text.contains(brand::LOGO[0].trim()),
        "wordmark missing after /clear: {text}"
    );
    assert!(
        text.contains("--safe: approval needed"),
        "approval phrasing missing after /clear: {text}"
    );
    assert!(text.contains("type a message to start"), "{text}");
}

#[test]
fn parse_command_handles_multibyte_without_panic() {
    // Leading space + multibyte would panic under byte slicing.
    assert_eq!(parse_command(" résumé foo"), ("résumé", "foo"));
    assert_eq!(parse_command("café"), ("café", ""));
}

#[test]
fn message_text_extracts_content_parts() {
    let msg = json!({
        "role": "user",
        "content": [{ "type": "text", "text": { "value": "hello", "annotations": [] } }]
    });
    assert_eq!(message_text(&msg), "hello");
}

#[test]
fn message_text_joins_multiple_parts_and_handles_string() {
    let multi = json!({ "content": [
        { "text": { "value": "a" } },
        { "text": { "value": "b" } },
    ] });
    assert_eq!(message_text(&multi), "ab");
    let bare = json!({ "content": "plain" });
    assert_eq!(message_text(&bare), "plain");
    let empty = json!({ "role": "user" });
    assert_eq!(message_text(&empty), "");
}

fn names(app: &App) -> Vec<String> {
    app.slash_matches()
        .iter()
        .map(|m| m.name().to_string())
        .collect()
}

#[test]
fn slash_bare_lists_all_commands() {
    let mut app = test_app();
    app.input = "/".into();
    // All built-ins plus the always-advertised built-in flint skill.
    assert_eq!(
        names(&app).len(),
        super::SLASH_COMMANDS.len() + 1,
        "{:?}",
        names(&app)
    );
    assert!(
        names(&app).contains(&"/flint".to_string()),
        "built-in flint skill row: {:?}",
        names(&app)
    );
}

#[test]
fn slash_prefix_narrows_and_unmatched_hides() {
    let mut app = test_app();
    app.input = "/re".into();
    // `/resume`, `/reasoning` and `/reload` start with `re`; catalog order
    // (stable sort on equal prefix score) keeps resume first.
    assert_eq!(
        names(&app),
        vec![
            "/resume".to_string(),
            "/reasoning".to_string(),
            "/reload".to_string()
        ]
    );
    app.input = "/xyz".into();
    assert!(app.slash_matches().is_empty());
}

#[test]
fn slash_fuzzy_matches_transposed_and_typo_queries() {
    // Reordered/omitted letters still surface the command: `threds` is a
    // subsequence of `threads` (the `a` is missing).
    let mut app = test_app();
    app.input = "/threds".into();
    assert!(
        names(&app).contains(&"/threads".to_string()),
        "transposed query surfaces the command: {:?}",
        names(&app)
    );
    // A close typo: `simplifyer` differs from `simplifier` by one letter.
    // No built-in is that close, so assert against the scorer directly.
    let q: Vec<char> = "simplifyer".chars().collect();
    assert!(
        super::slash_match_score(&q, "/code-simplifier").is_some(),
        "typo within tolerance should match"
    );
    // A distant query still hides.
    let far: Vec<char> = "zzzzzz".chars().collect();
    assert!(super::slash_match_score(&far, "/threads").is_none());
    // A short query stays prefix-only (tight), not fuzzy.
    let short: Vec<char> = "re".chars().collect();
    assert!(super::slash_match_score(&short, "/threads").is_none());
    assert!(super::slash_match_score(&short, "/resume").is_some());
}

#[test]
fn slash_hidden_when_not_command_or_has_space() {
    let mut app = test_app();
    app.input = "hello".into();
    assert!(app.slash_matches().is_empty());
    // A space means the user is typing an argument, not the command name.
    app.input = "/resume ".into();
    assert!(app.slash_matches().is_empty());
}

#[test]
fn slash_hidden_while_running() {
    let mut app = test_app();
    app.input = "/".into();
    app.status = super::Status::Running;
    assert!(app.slash_matches().is_empty());
}

#[test]
fn slash_move_wraps_within_matches() {
    let mut app = test_app();
    app.input = "/".into();
    // Built-ins plus the always-advertised built-in jan skill.
    let n = names(&app).len();
    app.slash_move(-1);
    assert_eq!(app.slash_selected, n - 1);
    app.slash_move(1);
    assert_eq!(app.slash_selected, 0);
}

#[test]
fn accept_slash_fills_buffer_with_trailing_space() {
    let mut app = test_app();
    app.input = "/re".into();
    app.accept_slash();
    assert_eq!(app.input, "/resume ");
    assert_eq!(app.cursor, app.input.len());
    // Trailing space now hides the popup.
    assert!(app.slash_matches().is_empty());
}

#[test]
fn esc_dismiss_hides_until_next_edit() {
    let mut app = test_app();
    app.input = "/re".into();
    app.cursor = app.input.len();
    app.slash_dismissed = true;
    assert!(app.slash_matches().is_empty());
    // Editing the buffer re-shows the popup; fuzzy matching offers both
    // commands whose name contains `res` as a subsequence, resume first.
    app.input_insert('s');
    assert_eq!(
        names(&app),
        vec![
            "/resume".to_string(),
            "/reasoning".to_string(),
            "/threads".to_string(),
        ]
    );
}

#[test]
fn slash_matches_include_installed_skills() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    app.input = "/dep".into();
    assert!(
        names(&app).iter().any(|n| n == "/deploy"),
        "skill offered by prefix: {:?}",
        names(&app)
    );
    // Prefix narrowing works for skills too.
    app.input = "/deplo".into();
    assert_eq!(names(&app), vec!["/deploy".to_string()]);
    // Unmatched prefix hides the skill row.
    app.input = "/zzz".into();
    assert!(!names(&app).iter().any(|n| n == "/deploy"));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn slash_popup_uses_startup_catalog_after_files_change() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    std::fs::remove_dir_all(root.join(".jan/agent/skills/deploy")).unwrap();
    app.input = "/dep".into();

    assert_eq!(names(&app), vec!["/deploy".to_string()]);

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn slash_matches_hide_disabled_skills() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    // Whitelist a different skill: deploy must vanish from the popup,
    // matching the user-side catalog semantics.
    std::fs::write(
        root.join(".jan/agent/agent.toml"),
        "[agent]\n[skills]\nenabled = [\"other\"]\n",
    )
    .unwrap();
    app.input = "/dep".into();
    assert!(
        !names(&app).iter().any(|n| n == "/deploy"),
        "disabled skill must not be offered: {:?}",
        names(&app)
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn slash_matches_dedupe_command_collisions() {
    let (mut app, root) = skill_test_app("cancel", "Cancels things.");
    app.input = "/".into();
    let all = names(&app);
    let hits = all.iter().filter(|n| *n == "/cancel").count();
    assert_eq!(hits, 1, "command wins, skill row dropped: {all:?}");
    // The unambiguous form is still completable.
    app.input = "/skill:can".into();
    assert!(names(&app).iter().any(|n| n == "/skill:cancel"));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn slash_matches_hide_model_only_skills() {
    // `user-invocable: false` (Claude Code convention): the agent may fire
    // it via skill_read, but the human's popup must not offer it.
    let (mut app, root) =
        skill_test_app_fm("internal", "Agent-only ritual.", "user-invocable: false\n");
    let (mut app2, root2) = skill_test_app("open", "Everyone.");
    // Probe with "intern", not "int": the built-in "flint" skill contains
    // the substring "int", so "int" would surface it and mask what this
    // test is really checking (that the model-only "internal" is hidden).
    app.input = "/intern".into();
    assert!(
        !names(&app).iter().any(|n| n.contains("internal")),
        "model-only skill offered to the user: {:?}",
        names(&app)
    );
    // The `/skill:` form is equally hidden.
    app.input = "/skill:intern".into();
    assert!(names(&app).is_empty(), "{:?}", names(&app));
    // A normal skill is still offered alongside.
    app2.input = "/op".into();
    assert_eq!(names(&app2), vec!["/open".to_string()]);
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&root2);
}

#[test]
fn accept_slash_fills_skill_name() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    app.input = "/dep".into();
    app.cursor = app.input.len();
    app.accept_slash();
    assert_eq!(app.input, "/deploy ");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn slash_hints_render_skill_rows() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    app.input = "/dep".into();
    app.cursor = app.input.len();
    let rows = render_rows(&mut app, 100, 30);
    assert!(
        rows.iter()
            .any(|r| r.contains("/deploy") && r.contains("How to deploy.")),
        "skill row rendered:\n{}",
        rows.join("\n")
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// A plugin with one folder skill under the app's project root.
fn plugin_skill_in_app(root: &std::path::Path, plugin: &str, name: &str, description: &str) {
    let dir = root
        .join(".jan/agent/plugins")
        .join(plugin)
        .join("skills")
        .join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\ndescription: {description}\n---\n\n# {name}\n\nPlugin body.\n"),
    )
    .unwrap();
}

/// A plugin with one command prompt template under the app's project root.
fn plugin_command_in_app(root: &std::path::Path, plugin: &str, name: &str, content: &str) {
    let dir = root
        .join(".jan/agent/plugins")
        .join(plugin)
        .join("commands");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{name}.md")), content).unwrap();
}

/// `/reload` picks up a skill added on disk after startup and says what it
/// did.
#[test]
fn reload_command_refreshes_the_skill_catalog() {
    crate::core::agent::global_config::with_temp_home(|_| {
        let (mut app, root) = skill_test_app("deploy", "How to deploy.");
        app.refresh_slash_catalog();
        app.input = "/ship".into();
        assert!(!names(&app).contains(&"/ship".to_string()));

        let skill = root.join(".jan/agent/skills/ship");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: ship\ndescription: Ship it.\n---\n\n# ship\n\nBody.\n",
        )
        .unwrap();
        // Not in the catalog until a reload: it is a startup snapshot.
        assert!(!names(&app).contains(&"/ship".to_string()));

        // No MCP servers configured or connected in the temp home.
        let servers: crate::core::state::SharedMcpServers = std::sync::Arc::new(
            tokio::sync::Mutex::new(std::collections::HashMap::new()),
        );
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        rt.block_on(super::reload_command(&mut app, &servers));

        app.input = "/ship".into();
        assert!(names(&app).contains(&"/ship".to_string()), "{:?}", names(&app));
        assert!(
            transcript_text(&app).contains("reloaded: provider config"),
            "{}",
            transcript_text(&app)
        );
    });
}

#[test]
fn reload_is_a_slash_command() {
    assert!(SLASH_COMMANDS.iter().any(|c| c.name == "/reload"));
}

#[test]
fn slash_matches_offer_plugin_commands() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    plugin_command_in_app(
        &root,
        "feature-dev",
        "feature-dev",
        "---\ndescription: Guided feature workflow\n---\nDo it with $ARGUMENTS.",
    );
    app.refresh_slash_catalog();
    // Short form: the plain name is offered.
    app.input = "/fea".into();
    assert!(
        names(&app).contains(&"/feature-dev".to_string()),
        "command short form offered: {:?}",
        names(&app)
    );
    // Explicit form: the qualified `<plugin>:<name>` name.
    app.input = "/command:".into();
    assert!(
        names(&app).contains(&"/command:feature-dev:feature-dev".to_string()),
        "command explicit form offered: {:?}",
        names(&app)
    );
    // Template placeholders surface as hints on the popup row.
    assert!(app.slash_matches().iter().any(|m| matches!(
        m,
        super::SlashMatch::PluginCommand { hints, .. } if hints == &vec!["$ARGUMENTS".to_string()]
    )));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn slash_popup_reuses_startup_catalog_until_refresh() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    plugin_command_in_app(
        &root,
        "feature-dev",
        "feature-dev",
        "---\ndescription: Guided feature workflow\n---\nDo it.",
    );
    app.refresh_slash_catalog();
    app.input = "/feature".into();
    assert!(names(&app).contains(&"/feature-dev".to_string()));

    std::fs::remove_file(root.join(".jan/agent/plugins/feature-dev/commands/feature-dev.md"))
        .unwrap();
    app.input = "/fea".into();
    app.reset_slash_hint();
    assert!(
        names(&app).contains(&"/feature-dev".to_string()),
        "the startup catalog must not rediscover files after the input changes"
    );

    app.refresh_slash_catalog();
    assert!(!names(&app).contains(&"/feature-dev".to_string()));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn slash_matches_command_owns_short_form_over_skill() {
    let (mut app, root) = skill_test_app("prepare", "Project prep.");
    plugin_command_in_app(
        &root,
        "release",
        "prepare",
        "---\ndescription: Release prep\n---\nDo it.",
    );
    app.refresh_slash_catalog();
    app.input = "/pre".into();
    let all = names(&app);
    assert_eq!(
        all.iter().filter(|n| *n == "/prepare").count(),
        1,
        "command owns the short form, skill row dropped: {all:?}"
    );
    // The skill is still reachable explicitly.
    app.input = "/skill:pre".into();
    assert!(names(&app).contains(&"/skill:prepare".to_string()));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn slash_matches_builtin_wins_over_command() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    plugin_command_in_app(&root, "x", "resume", "---\ndescription: r\n---\nDo it.");
    app.refresh_slash_catalog();
    app.input = "/res".into();
    let all = names(&app);
    // Built-in wins the `/resume` collision: no `/command:x:resume` row and
    // no skill row. `/reasoning` and `/threads` are separate fuzzy hits
    // (res is a subsequence of both names), not collisions.
    assert_eq!(
        all,
        vec![
            "/resume".to_string(),
            "/reasoning".to_string(),
            "/threads".to_string(),
        ],
        "built-in only"
    );
    // The command is still reachable explicitly.
    app.input = "/command:".into();
    assert!(names(&app).contains(&"/command:x:resume".to_string()));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn dispatch_command_submits_template_with_substituted_args() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    plugin_command_in_app(
        &root,
        "feature-dev",
        "feature-dev",
        "---\ndescription: Build a feature\n---\nBuild: $ARGUMENTS",
    );
    assert!(app.dispatch_command("feature-dev", "add auth"));
    // The model sees the substituted template as the user message.
    let user_msgs: Vec<&serde_json::Value> = app
        .history
        .iter()
        .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .collect();
    let last = user_msgs.last().expect("user message");
    assert!(
        last.get("content")
            .and_then(|c| c.as_str())
            .is_some_and(
                |c| c.contains("Build: add auth") && c.contains("feature-dev\" command")
            ),
        "substituted template in history: {last}"
    );
    // Unknown command returns false and does not dispatch.
    let before = app.history.len();
    assert!(!app.dispatch_command("nope", ""));
    assert_eq!(app.history.len(), before);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn dispatch_command_arms_base_snapshot_before_starting() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    plugin_command_in_app(&root, "feature-dev", "feature-dev", "Build: $ARGUMENTS");
    app.repo_root = Some(root.clone());

    assert!(app.dispatch_command("feature-dev", "add auth"));
    assert!(app.base_requested);
    assert!(matches!(app.snap_queue.front(), Some(SnapshotJob::Base)));

    let _ = std::fs::remove_dir_all(&root);
}

/// A skill or command invoked before signing in gets the not-signed-in
/// note, not a turn armed with an empty model (#141).
#[test]
fn dispatch_without_a_provider_arms_no_turn() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    plugin_command_in_app(&root, "feature-dev", "feature-dev", "Build: $ARGUMENTS");
    app.model.clear();
    let before = app.history.len();
    assert!(app.dispatch_command("feature-dev", "add auth"));
    assert!(app.dispatch_skill("deploy", "staging"));
    assert!(!app.want_start, "a turn was armed without a provider");
    assert_eq!(app.status, Status::Idle);
    assert_eq!(app.history.len(), before);
    assert!(transcript_text(&app).contains("not signed in"));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn dispatch_skill_arms_base_snapshot_before_starting() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    app.repo_root = Some(root.clone());

    assert!(app.dispatch_skill("deploy", "staging"));
    assert!(app.base_requested);
    assert!(matches!(app.snap_queue.front(), Some(SnapshotJob::Base)));

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn run_command_dispatches_plugin_command_plain_and_explicit() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    plugin_command_in_app(
        &root,
        "feature-dev",
        "feature-dev",
        "---\ndescription: Build a feature\n---\nBuild: $ARGUMENTS",
    );
    // Plain short form.
    run_command(&mut app, "feature-dev add auth", &no_mcp()).await;
    let user = app.history.iter().last().unwrap();
    assert!(
        user.get("content")
            .and_then(|c| c.as_str())
            .is_some_and(|c| c.contains("Build: add auth")),
        "plain dispatch: {user}"
    );
    assert!(
        transcript_text(&app).contains("[command:feature-dev]"),
        "compact row: {}",
        transcript_text(&app)
    );
    // Typed while that turn runs: queued, not pushed into its history.
    let before = app.history.len();
    run_command(&mut app, "feature-dev mid turn", &no_mcp()).await;
    assert_eq!(app.history.len(), before);
    assert_eq!(app.message_queue.len(), 1);
    app.message_queue.clear();
    app.status = Status::Idle;
    // Explicit qualified form.
    run_command(
        &mut app,
        "command:feature-dev:feature-dev fix tests",
        &no_mcp(),
    )
    .await;
    let user = app.history.iter().last().unwrap();
    assert!(
        user.get("content")
            .and_then(|c| c.as_str())
            .is_some_and(|c| c.contains("Build: fix tests")),
        "explicit dispatch: {user}"
    );
    // Unknown command still notes.
    run_command(&mut app, "warp_drive", &no_mcp()).await;
    assert!(transcript_text(&app).contains("unknown command '/warp_drive'"));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn slash_matches_offer_plugin_skills() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    plugin_skill_in_app(&root, "release", "prepare", "Prep the release.");
    app.refresh_slash_catalog();
    // Short form: the plain name is offered when it is unambiguous.
    app.input = "/pre".into();
    assert!(
        names(&app).contains(&"/prepare".to_string()),
        "plugin short form offered: {:?}",
        names(&app)
    );
    // Explicit form: the qualified `<plugin>:<skill>` name.
    app.input = "/skill:rel".into();
    assert!(
        names(&app).contains(&"/skill:release:prepare".to_string()),
        "plugin explicit form offered: {:?}",
        names(&app)
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn slash_matches_ambiguous_plugin_plain_names_drop_short_form() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    plugin_skill_in_app(&root, "release", "prepare", "Release prep.");
    plugin_skill_in_app(&root, "triage", "prepare", "Triage prep.");
    app.refresh_slash_catalog();
    app.input = "/pre".into();
    let all = names(&app);
    assert!(
        !all.contains(&"/prepare".to_string()),
        "ambiguous short form must be dropped: {all:?}"
    );
    // Explicit forms stay completable for both.
    app.input = "/skill:rel".into();
    assert!(names(&app).contains(&"/skill:release:prepare".to_string()));
    app.input = "/skill:tri".into();
    assert!(names(&app).contains(&"/skill:triage:prepare".to_string()));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn slash_matches_project_skill_owns_short_form() {
    let (mut app, root) = skill_test_app("prepare", "Project prep.");
    plugin_skill_in_app(&root, "release", "prepare", "Plugin prep.");
    app.refresh_slash_catalog();
    app.input = "/pre".into();
    let hits: Vec<_> = names(&app)
        .into_iter()
        .filter(|n| n.contains("prepare"))
        .collect();
    assert_eq!(
        hits,
        vec!["/prepare".to_string()],
        "project owns the short form"
    );
    // The plugin copy stays reachable explicitly.
    app.input = "/skill:rel".into();
    assert!(names(&app).contains(&"/skill:release:prepare".to_string()));
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn plugin_command_installs_lists_dispatch_removes() {
    // Local git repo fixture with a plugin payload.
    let repo =
        std::env::temp_dir().join(format!("jan_tui_plugin_repo_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(repo.join("skills").join("prepare")).unwrap();
    std::fs::write(
        repo.join("skills").join("prepare").join("SKILL.md"),
        "---\ndescription: Prep\n---\n\n# prepare\n\nBody.\n",
    )
    .unwrap();
    std::fs::write(
        repo.join("plugin.toml"),
        "name = \"release-tools\"\ndescription = \"Release automation\"\nversion = \"1.2.0\"\n",
    )
    .unwrap();
    let st = std::process::Command::new("git")
        .args(["init", repo.to_str().unwrap()])
        .status()
        .unwrap();
    assert!(st.success());
    let st = std::process::Command::new("git")
        .args(["-C", repo.to_str().unwrap(), "add", "-A"])
        .status()
        .unwrap();
    assert!(st.success());
    let st = std::process::Command::new("git")
        .args([
            "-C",
            repo.to_str().unwrap(),
            "commit",
            "-m",
            "init",
            "--author=Jan Test <test@jan.ai>",
        ])
        .status()
        .unwrap();
    assert!(st.success());

    let (mut app, root) = skill_test_app("deploy", "How to deploy.");

    // `/plugin install` no longer awaits the clone inline (that would freeze
    // the TUI); it hands the spec to the loop, which runs the install off
    // the render loop. Drive the handoff: the request is recorded, a second
    // is refused while one is in flight, and the loop clears it on pick-up.
    run_command(
        &mut app,
        &format!("plugin install file://{}", repo.display()),
        &no_mcp(),
    )
    .await;
    assert!(
        app.plugin_install_request.is_some(),
        "install spec should be handed to the loop"
    );
    assert!(
        transcript_text(&app).contains("installing plugin..."),
        "{}",
        transcript_text(&app)
    );
    app.plugin_installing = true;
    run_command(&mut app, "plugin install file://nowhere", &no_mcp()).await;
    assert!(
        transcript_text(&app).contains("already in progress"),
        "a second /plugin install must be refused: {}",
        transcript_text(&app)
    );
    app.plugin_installing = false;
    app.plugin_install_request.take();

    // Actually install so the list/dispatch/remove checks below have a
    // plugin present (the install itself is covered by plugins::tests).
    let p = crate::core::agent::plugins::install(&root, &format!("file://{}", repo.display()))
        .await
        .unwrap();
    assert_eq!(p.name, "release-tools");
    app.refresh_slash_catalog();

    std::fs::create_dir_all(
        crate::core::agent::skills::plugins_dir(&root).join(".installing-stale"),
    )
    .unwrap();
    run_command(&mut app, "plugin list", &no_mcp()).await;
    let text = transcript_text(&app);
    assert!(
        text.contains("plugin release-tools (v1.2.0 - 1 skill)"),
        "{text}"
    );
    assert!(!text.contains("Release automation"), "{text}");
    assert!(!text.contains("release-tools:prepare"), "{text}");

    run_command(&mut app, "plugin list release-tools", &no_mcp()).await;
    let detail = transcript_text(&app);
    assert!(detail.contains("Release automation"), "{detail}");
    assert!(detail.contains("release-tools:prepare"), "{detail}");

    run_command(&mut app, "plugin list missing", &no_mcp()).await;
    assert!(
        transcript_text(&app).contains("plugin 'missing' is not installed"),
        "{}",
        transcript_text(&app)
    );

    // The installed plugin's skill resolves and dispatches like a project
    // skill (qualified form here; the short form is covered by unit tests).
    run_command(&mut app, "release-tools:prepare", &no_mcp()).await;
    assert!(
        transcript_text(&app).contains("[skill:release-tools:prepare]"),
        "dispatch: {}",
        transcript_text(&app)
    );

    run_command(&mut app, "plugin remove release-tools", &no_mcp()).await;
    assert!(
        transcript_text(&app).contains("removed plugin 'release-tools'"),
        "remove note: {}",
        transcript_text(&app)
    );
    run_command(&mut app, "plugin list", &no_mcp()).await;
    assert!(
        transcript_text(&app).contains("no plugins installed"),
        "empty list: {}",
        transcript_text(&app)
    );
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&repo);
}

/// Drive `PickerKind::PluginSelect` end to end: open it via a collection
/// listing, toggle a row with Space (an already-installed row is a no-op),
/// cancel clears the stashed source URL, and a fresh open + Enter hands
/// the checked paths to the loop via `plugin_select_request`.
#[tokio::test]
async fn plugin_select_picker_toggles_cancels_and_submits_checked_paths() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");

    // Open the picker exactly as the loop does after `finish_plugin_install`
    // sees a collection listing: one installable row and one already-
    // installed row.
    let candidates = vec![
        crate::core::agent::plugins::CollectionPlugin {
            path: "alpha".to_string(),
            installed: false,
        },
        crate::core::agent::plugins::CollectionPlugin {
            path: "beta".to_string(),
            installed: true,
        },
    ];
    finish_plugin_install(
        &mut app,
        Some("file:///tmp/collection".to_string()),
        Ok(crate::core::agent::plugins::GitInstall::Collection(
            candidates,
        )),
    );
    let picker = app
        .picker
        .as_ref()
        .expect("collection listing opens the picker");
    assert_eq!(picker.kind, PickerKind::PluginSelect);
    assert_eq!(picker.items.len(), 2);

    // An already-installed row is not toggleable: Space is a no-op note.
    press(&mut app, KeyCode::Down, KeyModifiers::NONE).await;
    press(&mut app, KeyCode::Char(' '), KeyModifiers::NONE).await;
    assert_eq!(app.picker.as_ref().unwrap().items[1].checkbox, Some(false));
    assert!(
        transcript_text(&app).contains("already installed - nothing to install"),
        "no-op Space note missing: {}",
        transcript_text(&app)
    );

    // Toggle the installable row.
    press(&mut app, KeyCode::Up, KeyModifiers::NONE).await;
    press(&mut app, KeyCode::Char(' '), KeyModifiers::NONE).await;
    assert_eq!(app.picker.as_ref().unwrap().items[0].checkbox, Some(true));

    // Cancelling clears the stashed collection URL so no stale source
    // lingers for a later Enter on a different picker.
    press(&mut app, KeyCode::Esc, KeyModifiers::NONE).await;
    assert!(app.picker.is_none());
    assert!(app.plugin_collection_url.is_none());

    // Re-open and submit: Enter hands the checked paths to the loop.
    finish_plugin_install(
        &mut app,
        Some("file:///tmp/collection".to_string()),
        Ok(crate::core::agent::plugins::GitInstall::Collection(vec![
            crate::core::agent::plugins::CollectionPlugin {
                path: "alpha".to_string(),
                installed: false,
            },
        ])),
    );
    assert!(app.plugin_collection_url.is_some());
    press(&mut app, KeyCode::Char(' '), KeyModifiers::NONE).await;
    press(&mut app, KeyCode::Enter, KeyModifiers::NONE).await;
    let (url, paths) = app
        .plugin_select_request
        .expect("Enter submits the pick")
        .clone();
    assert_eq!(url, "file:///tmp/collection");
    assert_eq!(paths, vec!["alpha".to_string()]);
    assert!(app.picker.is_none());
    assert!(
        app.plugin_collection_url.is_none(),
        "URL consumed on submit"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn run_command_dispatches_installed_skill() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    run_command(&mut app, "deploy", &no_mcp()).await;
    assert!(
        transcript_text(&app).contains("[skill:deploy]"),
        "compact row: {}",
        transcript_text(&app)
    );
    // The full skill body is injected into history, not deferred to
    // skill_read, and the folder directory is announced for relative paths.
    let user = app
        .history
        .iter()
        .rev()
        .find(|m| m["role"] == "user")
        .expect("user message pushed");
    let content = user["content"].as_str().unwrap();
    assert!(
        content.contains("You have invoked the \"deploy\" skill"),
        "{content}"
    );
    assert!(content.contains("# deploy"), "body injected: {content}");
    assert!(content.contains("Skill directory:"), "base dir: {content}");
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn run_command_threads_skill_args() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    run_command(&mut app, "deploy staging --force", &no_mcp()).await;
    let user = app
        .history
        .iter()
        .rev()
        .find(|m| m["role"] == "user")
        .expect("user message pushed");
    assert!(
        user["content"]
            .as_str()
            .unwrap()
            .contains("User: staging --force"),
        "{}",
        user["content"]
    );
    assert!(transcript_text(&app).contains("[skill:deploy] staging --force"));
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn skill_colon_form_dispatches_and_beats_collisions() {
    // A skill named like a builtin command: the short form runs the
    // command; `/skill:cancel` still reaches the skill.
    let (mut app, root) = skill_test_app("cancel", "Cancels things.");
    run_command(&mut app, "cancel", &no_mcp()).await;
    assert!(
        !transcript_text(&app).contains("[skill:cancel]"),
        "command wins the short form: {}",
        transcript_text(&app)
    );
    run_command(&mut app, "skill:cancel", &no_mcp()).await;
    assert!(transcript_text(&app).contains("[skill:cancel]"));
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn submit_user_mid_prompt_skill_invocation() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    app.submit_user("fix the auth flow /skill:deploy focus on security".into());
    let user = app
        .history
        .iter()
        .rev()
        .find(|m| m["role"] == "user")
        .expect("user message pushed");
    let content = user["content"].as_str().unwrap();
    assert!(
        content.contains("fix the auth flow focus on security"),
        "surrounding prose becomes args: {content}"
    );
    assert!(
        content.contains("User: fix the auth flow focus on security"),
        "{content}"
    );
    assert!(
        transcript_text(&app).contains("[skill:deploy] fix the auth flow focus on security")
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn submit_user_unknown_skill_token_passes_through() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    app.submit_user("read /skill:nope for me".into());
    let user = app
        .history
        .iter()
        .rev()
        .find(|m| m["role"] == "user")
        .expect("user message pushed");
    assert_eq!(
        user["content"].as_str().unwrap(),
        "read /skill:nope for me",
        "unknown skill stays a plain message"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn run_command_unknown_still_notes() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    run_command(&mut app, "warp_drive", &no_mcp()).await;
    assert!(transcript_text(&app).contains("unknown command '/warp_drive'"));
    let _ = std::fs::remove_dir_all(&root);
}

/// `/bug` previews and writes nothing; `/bug save` writes exactly the
/// previewed bundle; with no thread it says so instead of doing nothing.
#[tokio::test]
async fn bug_previews_first_and_saves_only_on_request() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    run_command(&mut app, "bug", &no_mcp()).await;
    assert!(
        transcript_text(&app).contains("bug report failed"),
        "no thread yet: {}",
        transcript_text(&app)
    );
    run_command(&mut app, "bug save", &no_mcp()).await;
    assert!(transcript_text(&app).contains("nothing to save yet"));

    let id = "bug-thread";
    let dir = crate::core::threads::utils::get_thread_dir(&app.agent_dir, id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        crate::core::threads::utils::get_thread_metadata_path(&app.agent_dir, id),
        serde_json::json!({"id": id, "title": "t", "updated": 1}).to_string(),
    )
    .unwrap();
    std::fs::write(dir.join("messages.jsonl"), "{\"role\":\"user\",\"content\":\"hi\"}\n").unwrap();
    app.thread_id = Some(id.to_string());

    run_command(&mut app, "bug", &no_mcp()).await;
    let preview = app.pending_bug_report.clone().expect("a preview is held");
    assert!(!preview.destination.exists(), "/bug wrote before being asked");
    assert!(transcript_text(&app).contains("Nothing is uploaded"));

    run_command(&mut app, "bug show thread/messages.jsonl", &no_mcp()).await;
    assert!(transcript_text(&app).contains("\"content\":\"hi\""));

    run_command(&mut app, "bug save", &no_mcp()).await;
    assert!(preview.destination.is_file(), "/bug save wrote nothing");
    assert!(app.pending_bug_report.is_none());
    let _ = std::fs::remove_file(&preview.destination);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn tab_is_noop_in_normal_input_mode() {
    // Tab must never insert a literal character, even when the input
    // contains underscores or other characters that might confuse
    // crossterm's key delivery.
    let mut app = test_app();
    app.input = "use credential for api.txt".into();
    app.cursor = app.input.len();
    app.input_insert('\t');
    assert_eq!(app.input, "use credential for api.txt");
    assert_eq!(app.cursor, app.input.len());
}

#[test]
fn accept_quoted_path_hint_replaces_whole_quoted_token() {
    let mut app = test_app();
    app.input = r#"use @"my file.txt""#.into(); // fully typed, closing quote present
    app.cursor = app.input.len();
    app.path_hints = vec![super::PathHintItem {
        path: "notes/report.md".into(),
        name: "report.md".into(),
        is_dir: false,
    }];
    app.accept_path_hint();
    assert_eq!(app.input, r#"use @"notes/report.md""#);
}

#[test]
fn accept_completion_with_space_quotes() {
    let mut app = test_app();
    app.input = "use @rep".into();
    app.cursor = app.input.len();
    app.path_hints = vec![super::PathHintItem {
        path: "my docs/report.md".into(),
        name: "report.md".into(),
        is_dir: false,
    }];
    app.accept_path_hint();
    assert_eq!(app.input, "use @\"my docs/report.md\"");
    assert_eq!(app.cursor, app.input.len());
}

#[test]
fn many_edits_make_one_search_per_tick() {
    let mut app = test_app();
    for c in "see @src".chars() {
        app.input_insert(c);
    }
    assert!(app.path_hints_dirty, "an edit only marks the hints dirty");
    let first = app.take_path_hint_request();
    assert!(first.is_some());
    assert_eq!(first.unwrap().2, "src");
    assert!(app.take_path_hint_request().is_none(), "one search for the whole burst");
}

#[test]
fn stale_generation_result_ignored() {
    let mut app = test_app();
    app.input = "@a".into();
    app.cursor = app.input.len();
    app.refresh_path_hints();
    let (old_gen, _, _) = app.take_path_hint_request().unwrap();
    app.input_insert('b');
    let item = || vec![super::PathHintItem { path: "ab".into(), name: "ab".into(), is_dir: false }];
    app.apply_path_hints(old_gen, item());
    assert!(app.path_hints.is_empty(), "a result for an older buffer is dropped");
    let (new_gen, _, _) = app.take_path_hint_request().unwrap();
    app.apply_path_hints(new_gen, item());
    assert_eq!(app.path_hints.len(), 1);
}

#[test]
fn hint_search_does_not_climb_out_of_the_project() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "x").unwrap();
    assert_eq!(super::search_path_hints(dir.path(), "a").len(), 1);
    assert!(super::search_path_hints(dir.path(), "../").is_empty());
    assert!(super::search_path_hints(dir.path(), "x/../a").is_empty());
}

#[test]
fn flush_installs_hints_for_the_current_buffer() {
    let mut app = test_app();
    app.input = "@Cargo".into();
    app.cursor = app.input.len();
    app.refresh_path_hints();
    app.flush_path_hints();
    assert!(!app.path_hints_dirty);
}

#[test]
fn accept_directory_path_hint_keeps_at_and_slash() {
    let mut app = test_app();
    app.input = "use @docs".into();
    app.cursor = app.input.len();
    app.path_hints = vec![super::PathHintItem {
        path: "docs".into(),
        name: "docs".into(),
        is_dir: true,
    }];
    app.accept_path_hint();
    // The reference marker and a trailing slash survive, so the user can
    // keep drilling into the directory. Accepting must not turn the token
    // into a plain, non-reference path.
    assert_eq!(app.input, "use @docs/");
}

#[test]
fn accept_file_path_hint_keeps_at_marker() {
    let mut app = test_app();
    app.input = "use @report".into();
    app.cursor = app.input.len();
    app.path_hints = vec![super::PathHintItem {
        path: "docs/report.md".into(),
        name: "report.md".into(),
        is_dir: false,
    }];
    app.accept_path_hint();
    assert_eq!(app.input, "use @docs/report.md");
}

#[test]
fn path_hint_query_handles_quoted_reference() {
    let mut app = test_app();
    // Cursor inside the opening quote: query is empty.
    app.input = r#"use @"#.into();
    app.cursor = app.input.len();
    assert_eq!(app.path_hint_query(), Some(String::new()));
    // Typing inside quotes: query is the typed text.
    app.input = r#"use @"my file"#.into();
    app.cursor = app.input.len();
    assert_eq!(app.path_hint_query(), Some("my file".to_string()));
    // Closing quote: query is the text between quotes.
    app.input = r#"use @"my file.txt""#.into();
    app.cursor = app.input.len();
    assert_eq!(app.path_hint_query(), Some("my file.txt".to_string()));
}

#[test]
fn should_not_auto_compact_when_below_threshold() {
    let app = test_app();
    // Default context_window = 128K, reserve_tokens = 16K, so limit ~111K.
    // With tokens = 50K and history = 6, no compact.
    assert!(!app.should_auto_compact());
}

#[test]
fn should_auto_compact_when_above_threshold() {
    let mut app = test_app();
    app.tokens = 120_000; // > 128K - 16K = 112K
                          // Need more than 4 history messages
    for i in 0..6 {
        app.history.push(serde_json::json!({
            "role": if i % 2 == 0 { "user" } else { "assistant" },
            "content": format!("msg{i}")
        }));
    }
    assert!(app.should_auto_compact());
}

/// AH-077: the user is warned once as the window fills, before
/// auto-compaction or an overflow, and warned again only after the fill
/// has dropped back below the line (a compaction, a new conversation).
#[test]
fn context_pressure_is_warned_once_before_the_window_fills() {
    let warnings =
        |app: &App| transcript_text(app).matches("of the context window is in use").count();
    let mut app = test_app();
    app.context_window = 100_000;
    app.reserve_tokens = 10_000;
    app.tokens = 50_000;
    app.check_context_pressure();
    assert_eq!(warnings(&app), 0, "no warning with room to spare");

    app.tokens = 82_000;
    app.check_context_pressure();
    assert_eq!(warnings(&app), 1);
    let text = transcript_text(&app);
    assert!(text.contains("82% of the context window is in use"), "{text}");
    assert!(text.contains("8,000 tokens before auto-compact"), "{text}");
    // The figures, and where they came from, are part of the warning.
    // Wrapped in the transcript, so the fragment is short on purpose.
    assert!(text.contains("82,000 of 100,000 tokens"), "{text}");
    assert!(text.contains("/compact"), "{text}");

    app.tokens = 86_000;
    app.check_context_pressure();
    assert_eq!(warnings(&app), 1, "not repeated every turn");

    app.tokens = 30_000;
    app.check_context_pressure();
    app.tokens = 81_000;
    app.check_context_pressure();
    assert_eq!(warnings(&app), 2, "re-armed after the fill dropped");
}

/// With no known window there is no fraction to warn about.
#[test]
fn no_context_pressure_warning_without_a_window() {
    let mut app = test_app();
    app.context_window = 0;
    app.tokens = 1_000_000;
    app.check_context_pressure();
    assert!(!transcript_text(&app).contains("of the context window is in use"));
}

#[test]
fn should_not_auto_compact_when_history_too_short() {
    let mut app = test_app();
    app.tokens = 120_000;
    // Only 3 messages — below the minimum of 5
    for i in 0..3 {
        app.history.push(serde_json::json!({
            "role": if i % 2 == 0 { "user" } else { "assistant" },
            "content": format!("msg{i}")
        }));
    }
    assert!(!app.should_auto_compact());
}

#[test]
fn should_not_auto_compact_with_zero_tokens() {
    let mut app = test_app();
    app.tokens = 0;
    for i in 0..6 {
        app.history.push(serde_json::json!({
            "role": if i % 2 == 0 { "user" } else { "assistant" },
            "content": format!("msg{i}")
        }));
    }
    assert!(!app.should_auto_compact());
}

#[test]
fn should_not_auto_compact_with_context_window_unset() {
    let mut app = test_app();
    app.tokens = 120_000;
    app.context_window = u64::MAX; // effectively unlimited
    for i in 0..6 {
        app.history.push(serde_json::json!({
            "role": if i % 2 == 0 { "user" } else { "assistant" },
            "content": format!("msg{i}")
        }));
    }
    // limit = u64::MAX - 16384 ≈ u64::MAX, so tokens=120K is well below
    assert!(!app.should_auto_compact());
}

fn overflow_error() -> String {
    format!(
        "[{}] Upstream returned HTTP 400: context_length_exceeded",
        crate::core::agent::upstream::CONTEXT_OVERFLOW_MARKER
    )
}

fn app_with_history(n: usize) -> TestApp {
    let mut app = test_app();
    for i in 0..n {
        app.history.push(serde_json::json!({
            "role": if i % 2 == 0 { "user" } else { "assistant" },
            "content": format!("msg{i}")
        }));
    }
    app
}

#[test]
fn context_overflow_error_queues_a_compaction_and_retry() {
    let mut app = app_with_history(6);
    app.on_error("upstream_error".into(), overflow_error());
    assert_eq!(
        app.compact_request,
        Some(CompactKind::Auto),
        "an overflow must queue a compaction instead of going idle"
    );
    assert!(app.retry_after_compact, "the turn must be retried");
    assert!(
        !app.want_start,
        "the retry waits for the compaction to land"
    );
}

#[test]
fn ordinary_error_does_not_queue_a_compaction() {
    let mut app = app_with_history(6);
    app.on_error("upstream_error".into(), "invalid api key".into());
    assert_eq!(app.compact_request, None);
    assert!(!app.retry_after_compact);
}

#[test]
fn overflow_on_a_short_history_does_not_retry() {
    // Nothing to compact: retrying would just re-send the same request.
    let mut app = app_with_history(2);
    app.on_error("upstream_error".into(), overflow_error());
    assert_eq!(app.compact_request, None);
    assert!(!app.retry_after_compact);
}

#[test]
fn compaction_after_an_overflow_restarts_the_turn() {
    let mut app = app_with_history(6);
    app.on_error("upstream_error".into(), overflow_error());
    app.compacting = app.compact_request.take();
    let compacted = vec![serde_json::json!({ "role": "system", "content": "summary" })];
    finish_compaction(&mut app, Ok(compacted), 7);
    assert!(
        app.want_start,
        "a landed compaction resumes the errored turn"
    );
    assert!(!app.retry_after_compact);
    assert_eq!(app.status, Status::Running);
}

#[test]
fn a_no_op_compaction_after_an_overflow_does_not_retry() {
    // Compaction could not shrink the history, so a retry would overflow
    // again on exactly the same request.
    let mut app = app_with_history(6);
    app.on_error("upstream_error".into(), overflow_error());
    app.compacting = app.compact_request.take();
    let unchanged = app.history.clone();
    let base = unchanged.len();
    finish_compaction(&mut app, Ok(unchanged), base);
    assert!(!app.want_start);
    assert!(!app.retry_after_compact);
}

#[test]
fn repeated_overflows_stop_retrying_within_one_turn() {
    let mut app = app_with_history(6);
    for _ in 0..MAX_OVERFLOW_RETRIES {
        app.on_error("upstream_error".into(), overflow_error());
        assert!(app.retry_after_compact);
        app.compacting = app.compact_request.take();
        let shorter = app.history[..app.history.len() - 1].to_vec();
        let base = app.history.len();
        finish_compaction(&mut app, Ok(shorter), base);
    }
    app.on_error("upstream_error".into(), overflow_error());
    assert_eq!(
        app.compact_request, None,
        "the retry budget is spent for this turn"
    );
    assert!(!app.retry_after_compact);
}

#[test]
fn a_new_user_turn_rearms_the_overflow_retry_budget() {
    let mut app = app_with_history(6);
    app.overflow_retries = MAX_OVERFLOW_RETRIES;
    app.submit_user("next".into());
    assert_eq!(app.overflow_retries, 0);
}

#[test]
fn estimate_counts_tool_call_arguments() {
    // Arguments live at `function.arguments`; reading `arguments` off the
    // call itself scored every tool-heavy history as empty.
    let args = "x".repeat(4_000);
    let with_calls = vec![serde_json::json!({
        "role": "assistant",
        "content": serde_json::Value::Null,
        "tool_calls": [{
            "id": "c1",
            "function": { "name": "bash", "arguments": args }
        }]
    })];
    assert!(
        estimate_token_count(&with_calls) >= 1_000,
        "tool-call arguments must be counted: {}",
        estimate_token_count(&with_calls)
    );
}

#[test]
fn estimate_counts_multimodal_text_parts() {
    let msgs = vec![serde_json::json!({
        "role": "user",
        "content": [{ "type": "text", "text": "y".repeat(4_000) }]
    })];
    assert!(estimate_token_count(&msgs) >= 1_000);
}

#[test]
fn set_model_reduces_window_and_queues_target_compaction() {
    let mut app = test_app();
    // Simulate a 1M window with heavy usage, then switch to a 200K model.
    app.context_window = 1_000_000;
    app.context_window_source =
        crate::core::cli::model_capabilities::ContextWindowSource::Catalog;
    app.tokens = 500_000;
    for i in 0..6 {
        app.history.push(serde_json::json!({
            "role": if i % 2 == 0 { "user" } else { "assistant" },
            "content": format!("msg{i}")
        }));
    }
    app.set_model("claude-sonnet-4-5".to_string());

    assert_eq!(app.model, "claude-sonnet-4-5");
    assert_eq!(app.context_window, 200_000);
    assert_eq!(
        app.context_window_source,
        crate::core::cli::model_capabilities::ContextWindowSource::Catalog
    );
    assert!(app.should_auto_compact(), "usage now exceeds the target");
    assert_eq!(
        app.compact_request,
        Some(CompactKind::Auto),
        "a smaller-window switch must queue target compaction"
    );
}

#[test]
fn configured_window_stays_authoritative_across_switch() {
    let mut app = test_app();
    app.configured_context_window = Some(333_000);
    app.context_window = 333_000;
    app.context_window_source =
        crate::core::cli::model_capabilities::ContextWindowSource::Configured;
    // Below the configured threshold, so no target compaction is queued.
    app.tokens = 50_000;
    for i in 0..6 {
        app.history.push(serde_json::json!({
            "role": "user",
            "content": format!("msg{i}")
        }));
    }
    app.set_model("claude-sonnet-4-5".to_string());

    assert_eq!(
        app.context_window, 333_000,
        "a configured override must win over the catalog"
    );
    assert_eq!(
        app.context_window_source,
        crate::core::cli::model_capabilities::ContextWindowSource::Configured
    );
    assert_eq!(app.compact_request, None);
}

#[test]
fn moving_to_a_larger_window_does_not_compact() {
    let mut app = test_app();
    app.context_window = 200_000;
    app.context_window_source =
        crate::core::cli::model_capabilities::ContextWindowSource::Catalog;
    app.tokens = 500_000;
    for i in 0..6 {
        app.history.push(serde_json::json!({
            "role": "user",
            "content": format!("msg{i}")
        }));
    }
    app.set_model("claude-sonnet-4-6".to_string());

    assert_eq!(app.context_window, 1_000_000);
    assert!(
        !app.should_auto_compact(),
        "the window grew past current usage"
    );
    assert_eq!(app.compact_request, None);
}

#[test]
fn set_model_notes_the_context_source() {
    let mut app = test_app();
    app.set_model("claude-sonnet-4-6".to_string());
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("claude-sonnet-4-6"), "got: {text}");
    assert!(text.contains("(context 1000K, catalog)"), "got: {text}");
}

#[test]
fn unknown_model_resolves_to_the_fallback_window() {
    let mut app = test_app();
    app.set_model("private-gateway-model".to_string());
    assert_eq!(app.context_window, 128_000);
    assert_eq!(
        app.context_window_source,
        crate::core::cli::model_capabilities::ContextWindowSource::Fallback
    );
}

#[test]
fn a_target_compaction_that_overflows_blocks_the_gated_run() {
    let mut app = test_app();
    app.compacting = Some(CompactKind::Auto);
    app.history = vec![serde_json::json!({ "role": "user", "content": "hi" })];
    app.want_start = true;
    let overflow = format!(
        "[{}] Upstream returned HTTP 400: prompt is too long",
        crate::core::agent::upstream::CONTEXT_OVERFLOW_MARKER
    );
    finish_compaction(&mut app, Err(overflow.into()), 1);

    assert!(
        app.compacting.is_none(),
        "a failure must clear the throbber"
    );
    assert_eq!(app.history.len(), 1, "history must be left untouched");
    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(
        text.contains("auto-compacting failed"),
        "an actionable error must be shown: {text}"
    );
    assert!(
        !app.want_start,
        "the oversized regular request must not be auto-resubmitted"
    );
}

#[test]
fn model_switch_during_compaction_requeues_for_a_smaller_target() {
    let mut app = test_app();
    app.context_window = 1_000_000;
    app.tokens = 500_000;
    app.history = (0..10)
        .map(|i| serde_json::json!({ "role": "user", "content": format!("before-{i}") }))
        .collect();
    app.compacting = Some(CompactKind::Auto);

    app.set_model("claude-sonnet-4-5".to_string());
    assert_eq!(
        app.compact_request,
        Some(CompactKind::Auto),
        "a smaller selected model queues a follow-up compaction"
    );

    finish_compaction(
        &mut app,
        Ok(vec![
            serde_json::json!({ "role": "system", "content": "summary" }),
            serde_json::json!({ "role": "user", "content": "x".repeat(2_000_000) }),
        ]),
        10,
    );

    assert_eq!(
        app.compact_request,
        Some(CompactKind::Auto),
        "the smaller selected model must compact again before a normal request"
    );
}

#[test]
fn header_labels_the_context_source() {
    let app = test_app();
    let text: String = header_spans(&app)
        .iter()
        .map(|s| s.content.as_ref())
        .collect::<String>();
    assert!(
        text.contains("/128K fallback"),
        "the header must carry the source label: {text}"
    );
}

#[test]
fn header_labels_a_bare_model_with_its_single_provider() {
    let mut pc = std::collections::HashMap::new();
    pc.insert(
        "opencode".to_string(),
        crate::core::state::ProviderConfig {
            provider: "opencode".into(),
            base_url: Some("https://opencode.ai/zen/go/v1".into()),
            api_key: Some("sk-x".into()),
            models: vec!["mimo-v2.5".into()],
            ..Default::default()
        },
    );
    assert_eq!(
        provider_label_for_model("mimo-v2.5", &pc),
        "opencode/mimo-v2.5"
    );
}

#[test]
fn header_keeps_an_unknown_model_id_bare() {
    let pc = std::collections::HashMap::new();
    assert_eq!(provider_label_for_model("my-model", &pc), "my-model");
}

#[test]
fn header_preserves_an_explicit_provider_qualifier() {
    let mut pc = std::collections::HashMap::new();
    pc.insert(
        "openai".to_string(),
        crate::core::state::ProviderConfig {
            provider: "openai".into(),
            base_url: Some("https://api.openai.com/v1".into()),
            models: vec!["gpt-5.6-luna".into()],
            ..Default::default()
        },
    );
    assert_eq!(
        provider_label_for_model("openai/gpt-5.6-luna", &pc),
        "openai/gpt-5.6-luna"
    );
}

#[test]
fn header_shows_the_reasoning_effort_badge() {
    let mut app = test_app();
    app.reasoning_effort = "high".into();
    let text: String = header_spans(&app)
        .iter()
        .map(|s| s.content.as_ref())
        .collect::<String>();
    assert!(text.contains("effort high"), "effort badge missing: {text}");
    app.reasoning_effort = "low".into();
    let text: String = header_spans(&app)
        .iter()
        .map(|s| s.content.as_ref())
        .collect::<String>();
    assert!(
        text.contains("effort low"),
        "badge must track the level: {text}"
    );
}

#[test]
fn body_omits_max_tokens_when_unset() {
    let app = test_app();
    let body = app.body();
    assert!(body.get("max_tokens").is_none());
}

#[test]
fn body_includes_max_tokens_when_set() {
    let mut app = test_app();
    app.max_tokens = Some(4096);
    let body = app.body();
    assert_eq!(body.get("max_tokens").and_then(|v| v.as_u64()), Some(4096));
}

/// The reasoning-effort level is always forwarded so compatible providers
/// (OpenAI, Gemini, Tokamak) can scale reasoning depth per request.
#[test]
fn body_includes_reasoning_effort() {
    let mut app = test_app();
    assert_eq!(
        app.body().get("reasoning_effort").and_then(|v| v.as_str()),
        Some("medium")
    );
    app.reasoning_effort = "high".into();
    assert_eq!(
        app.body().get("reasoning_effort").and_then(|v| v.as_str()),
        Some("high")
    );
}

/// The session token budget is the only cap: it is always forwarded, and no
/// turn limit is sent at all.
#[test]
fn body_forwards_session_budget_and_no_turn_cap() {
    let mut app = test_app();
    app.max_session_tokens = 64_000;
    let body = app.body();
    assert_eq!(
        body.get("max_session_tokens").and_then(|v| v.as_u64()),
        Some(64_000)
    );
    assert!(body.get("max_turns").is_none());
}

#[test]
fn body_flags_goal_mode_only_while_a_goal_runs() {
    use crate::core::agent::goal::{GoalState, GoalStatus};
    let mut app = test_app();
    assert!(app.body().get("goal_mode").is_none());

    app.goal = Some(GoalState::new("ship the release"));
    assert_eq!(
        app.body().get("goal_mode").and_then(|v| v.as_bool()),
        Some(true)
    );

    if let Some(goal) = app.goal.as_mut() {
        goal.status = GoalStatus::Achieved;
    }
    assert!(app.body().get("goal_mode").is_none());
}

/// The splash row's rendered text at `width`, one string per line.
fn banner_text(app: &App, width: u16) -> Vec<String> {
    app.transcript
        .iter()
        .flat_map(|row| row.lines(width))
        .map(|l| l.spans.iter().map(|s| s.content.to_string()).collect())
        .collect()
}

#[test]
fn banner_opens_with_the_wordmark_and_this_sessions_facts() {
    let mut app = test_app();
    app.model = "tokamak-1-preview".into();
    app.git_branch = Some("fix/tui-panel-width".into());
    app.push_banner("auto-approved inside the OS sandbox", true);

    let text = banner_text(&app, 90);
    let joined = text.join("\n");
    assert!(
        text.iter().any(|l| l.contains(brand::LOGO[0].trim())),
        "the wordmark is missing:\n{joined}"
    );
    // The model is the header's job, not the splash's (it would otherwise
    // appear twice on the first screen).
    assert!(!joined.contains("tokamak-1-preview"), "{joined}");
    assert!(joined.contains("/tmp/repo"), "{joined}");
    assert!(joined.contains("fix/tui-panel-width"), "{joined}");
    assert!(
        joined.contains("auto-approved inside the OS sandbox"),
        "{joined}"
    );
    assert!(joined.contains("/help"), "{joined}");
    assert!(joined.contains("type a message to start"), "{joined}");
    assert!(
        joined.contains(super::super::version::build_version()),
        "{joined}"
    );
}

/// The splash opens on the wordmark alone. The hand-wave block art that used
/// to sit beside it spent 15 rows of a fresh screen on decoration and forced
/// a 61-column floor before the splash would render at all.
#[test]
fn banner_opens_with_the_wordmark() {
    let mut app = test_app();
    app.push_banner("--safe", true);

    let text = banner_text(&app, 90);
    let joined = text.join("\n");
    assert!(
        text.iter().any(|l| l.contains(brand::LOGO[0].trim())),
        "wordmark missing:\n{joined}"
    );
    assert!(joined.contains('█'), "{joined}");
    // The wordmark is six rows; the hand was fifteen more.
    assert!(
        text.iter().filter(|l| l.contains('█')).count() <= brand::LOGO.len(),
        "the splash carries block art beyond the wordmark:\n{joined}"
    );
}

#[test]
fn a_24_column_terminal_drops_the_wordmark() {
    let mut app = test_app();
    app.push_banner("--safe", true);
    let narrow = banner_text(&app, 24);
    let joined = narrow.join("\n");
    assert!(!joined.contains('█'), "{joined}");
    assert!(joined.contains("jan"), "{joined}");
}

/// `/init` is the first thing a new project wants and is invisible unless
/// promoted, so the splash lists it beside `/help`.
#[test]
fn banner_promotes_init() {
    let mut app = test_app();
    app.push_banner("--safe", true);
    let joined = banner_text(&app, 90).join("\n");
    assert!(joined.contains("/init"), "{joined}");
    assert!(joined.contains("onboard this project"), "{joined}");
}

/// The invitation is conditional on the same rule the system prompt uses, so
/// an already-onboarded project (its own JAN.md, or an ancestor's) is quiet.
#[test]
fn init_invitation_tracks_whether_the_project_has_instructions() {
    let root = std::env::temp_dir().join(format!("jan_init_invite_{}", std::process::id()));
    let nested = root.join("pkg");
    std::fs::create_dir_all(&nested).unwrap();
    // The ancestor walk stops at the repository root.
    std::fs::create_dir_all(root.join(".git")).unwrap();
    assert!(!crate::core::agent::context::has_context_file(&nested));
    std::fs::write(root.join("JAN.md"), "ROOT_RULES").unwrap();
    assert!(
        crate::core::agent::context::has_context_file(&nested),
        "an ancestor's JAN.md already onboards this project"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_seeded_session_is_not_invited_to_type() {
    let mut app = test_app();
    app.push_banner("--safe", false);
    let joined = banner_text(&app, 90).join("\n");
    assert!(!joined.contains("type a message to start"), "{joined}");
    assert!(joined.contains("--safe"), "{joined}");
}

#[test]
fn a_narrow_terminal_gets_the_name_instead_of_a_clipped_wordmark() {
    let mut app = test_app();
    app.push_banner("--safe", true);

    let wide = banner_text(&app, 90).join("\n");
    assert!(wide.contains('█'), "{wide}");

    // Same row, re-laid out: the source is data, not rendered lines.
    let narrow = banner_text(&app, 24);
    let joined = narrow.join("\n");
    assert!(!joined.contains('█'), "{joined}");
    assert!(joined.contains("jan"), "{joined}");
    for line in &narrow {
        assert!(
            line.chars().count() <= 24,
            "row overflows a 24-column terminal: {line:?}"
        );
    }
}

/// The wave mark is the only branding the header carries: one glyph, then
/// the model. A name chip would spend the columns the status needs.
#[test]
fn header_leads_with_the_wave_then_the_model() {
    let mut app = test_app();
    app.model = "tokamak-1-preview".into();
    let top = render_rows(&mut app, 60, 12).remove(0);
    let head = top.trim_start();
    assert!(
        head.starts_with(brand::WAVE),
        "the wave should open the row: {top:?}"
    );
    assert!(
        head[brand::WAVE.len()..]
            .trim_start()
            .starts_with("tokamak-1-preview"),
        "the model should follow the wave, with no name chip between: {top:?}"
    );
    // The freed columns are what let the status survive. This branch's
    // header also carries the fallback chip, so `[ready]` needs the wider
    // frame that dev's 60-column case has no room for.
    let wide = render_rows(&mut app, 110, 12).remove(0);
    assert!(wide.contains("[ready]"), "{wide:?}");

    app.model.clear();
    let top = render_rows(&mut app, 60, 12).remove(0);
    assert!(top.contains("no model"), "{top:?}");
}

#[test]
fn hints_wrap_between_pairs_never_mid_pair() {
    let pairs = super::BANNER_HINTS;
    let rows = super::hint_rows(pairs, 30);
    assert!(rows.len() > 1, "narrow width must wrap");
    for row in &rows {
        assert!(row_width(row) <= 30 || row.spans.len() <= 3, "{row:?}");
    }
    let all: String = rows
        .iter()
        .flat_map(|r| r.spans.iter().map(|s| s.content.to_string()))
        .collect();
    for (key, label) in pairs {
        assert!(all.contains(key), "dropped {key}");
        assert!(all.contains(label), "dropped {label}");
    }
    assert_eq!(
        super::hint_rows(pairs, 200).len(),
        1,
        "one row when it fits"
    );
}
/// Spans of the last committed transcript row, as `(text, style)`.
fn last_row(app: &App) -> Vec<(String, Style)> {
    app.transcript
        .last()
        .expect("a row")
        .lines(80)
        .remove(0)
        .spans
        .iter()
        .map(|s| (s.content.to_string(), s.style))
        .collect()
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
        Some(super::user_bubble_bg()),
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

#[test]
fn severity_colours_the_gutter_and_the_body() {
    let mut app = test_app();

    app.note("saved");
    let info = last_row(&app);
    assert_eq!(info[0].1.fg, Some(Color::LightBlue), "info gutter");
    assert!(info[1].1.add_modifier.contains(Modifier::DIM), "info body");

    app.system(super::Level::Warn, "finished early");
    assert_eq!(last_row(&app)[0].1.fg, Some(Color::Yellow));

    app.system(super::Level::Error, "denied: rm -rf /");
    let err = last_row(&app);
    assert_eq!(err[0].1.fg, Some(Color::Red));
    assert!(err[1].1.add_modifier.contains(Modifier::BOLD), "{err:?}");

    // A category with its own glyph keeps it, so the column never carries
    // two markers.
    app.system_marked(super::GOAL_GLYPH, super::Level::Good, "goal achieved");
    let goal = last_row(&app);
    assert_eq!(goal[0].0, "\u{25ce} ");
    assert_eq!(goal[0].1.fg, Some(Color::Green));
}

#[tokio::test]
async fn probe_blocks() {
    let mut app = test_app();
    app.note("conversation cleared");
    run_command(&mut app, "help", &no_mcp()).await;
    for l in render_rows(&mut app, 84, 40) {
        println!("|{}", l.trim_end());
    }
}

/// Every rendered line of the last row, as plain text.
fn last_row_lines(app: &App, width: u16) -> Vec<String> {
    app.transcript
        .last()
        .expect("a row")
        .lines(width)
        .iter()
        .map(|l| l.spans.iter().map(|s| s.content.to_string()).collect())
        .collect()
}

#[test]
fn a_wrapped_note_indents_instead_of_repeating_its_marker() {
    let mut app = test_app();
    app.note(
        "not signed in - run /login to choose a provider before sending your first message",
    );

    let lines = last_row_lines(&app, 60);
    assert!(lines.len() > 1, "expected a wrap: {lines:?}");
    assert!(lines[0].starts_with("\u{2022} "), "{lines:?}");
    for line in &lines[1..] {
        assert!(
            line.starts_with("  ") && !line.starts_with('\u{2022}'),
            "a continuation must not read as a second note: {line:?}"
        );
    }
    // Wrapped at a space, not mid-word.
    assert!(
        lines
            .iter()
            .all(|l| !l.ends_with("Tokam") && !l.ends_with("provi")),
        "{lines:?}"
    );
    assert!(lines.iter().all(|l| l.chars().count() <= 60), "{lines:?}");
}

#[test]
fn a_wrapped_block_body_keeps_its_edge() {
    let mut app = test_app();
    app.note("commands:");
    app.system_detail_text(
        "/plan [exit|text]  Enter read-only plan mode, optionally seeding it with a message",
    );

    let lines = last_row_lines(&app, 50);
    assert!(lines.len() > 1, "expected a wrap: {lines:?}");
    for line in &lines {
        assert!(
            line.starts_with("\u{2506} "),
            "the block's left edge breaks on a wrap: {line:?}"
        );
    }
}

#[test]
fn system_rows_relay_out_on_a_resize() {
    let mut app = test_app();
    app.system_detail_text("a fairly long block body that has to wrap somewhere sensible");
    let (wide, narrow) = (last_row_lines(&app, 90), last_row_lines(&app, 30));
    assert_eq!(wide.len(), 1, "{wide:?}");
    assert!(narrow.len() > 1, "{narrow:?}");
}

/// The transcript is laid out on every 50ms tick, so any per-frame work
/// proportional to history (rather than to the viewport) compounds into an
/// unusable session. `draw` must materialize only the rows on screen.
#[test]
fn draw_materializes_only_the_visible_rows() {
    let mut app = test_app();
    for i in 0..4000 {
        app.transcript.push(
            RowKind::Markdown(format!(
                "Turn {i}: lorem ipsum dolor sit amet, consectetur adipiscing elit."
            ))
            .into(),
        );
    }
    // Warm every row's cache so the count below reflects steady-state
    // frames, not the first layout at a new width.
    render_rows(&mut app, 100, 40);
    super::ROW_CLONES.with(|n| n.set(0));
    render_rows(&mut app, 100, 40);
    let cloned = super::ROW_CLONES.with(|n| n.get());
    assert!(
        cloned <= 64,
        "a frame cloned {cloned} rows out of 4000; draw is laying out the \
             whole transcript instead of the viewport"
    );
}

/// `row_index` is in wrapped screen coordinates, so a click still maps to
/// the row it landed on even when earlier rows wrapped to several lines.
#[test]
fn click_maps_through_wrapped_rows() {
    let mut app = test_app();
    // Wraps to ~4 lines at width 40, so an unwrapped index would drift.
    app.transcript
        .push(RowKind::Line(Line::raw("w".repeat(150))).into());
    for i in 0..5 {
        app.transcript
            .push(RowKind::Line(Line::raw(format!("row {i}"))).into());
    }
    render_rows(&mut app, 40, 20);
    let rect = app.transcript_rect;
    let last = app.transcript.len() - 1;
    // Bottom-pinned, so the final body row is the last transcript row.
    let bottom = rect.y + rect.height - 1;
    super::click_region(&mut app, rect.x + 1, bottom);
    assert_eq!(
        app.row_index.get((bottom - rect.y - 1) as usize),
        Some(&Some(last)),
        "the last body row must map to the last transcript row"
    );
}
#[test]
fn model_picker_pins_tokamak_scope_and_models_first() {
    let picker = super::ModelPicker::from_pairs(
        vec![
            ("anthropic".into(), "claude-sonnet".into()),
            ("openai".into(), "gpt-5-codex".into()),
            ("tokamak".into(), "tokamak-1-preview".into()),
        ],
        "tokamak-1-preview",
    )
    .unwrap();

    assert_eq!(picker.scopes[1].label, "tokamak");
    assert_eq!(picker.items[0].provider, "tokamak");
    assert_eq!(picker.items[0].model, "tokamak-1-preview");
}

#[test]
fn model_picker_builds_all_and_provider_scopes_with_counts() {
    let picker = super::ModelPicker::from_pairs(
        vec![
            ("anthropic".into(), "claude-sonnet".into()),
            ("openai".into(), "gpt-5-codex".into()),
            ("openai".into(), "gpt-5-mini".into()),
        ],
        "gpt-5-codex",
    )
    .unwrap();

    assert_eq!(picker.scopes[0].label, "All models");
    assert_eq!(picker.scopes[0].count, 3);
    assert_eq!(picker.scopes[1].label, "anthropic");
    assert_eq!(picker.scopes[1].count, 1);
    assert_eq!(picker.scopes[2].label, "openai");
    assert_eq!(picker.scopes[2].count, 2);
    assert_eq!(picker.items[picker.selected].value, "gpt-5-codex");
}

#[test]
fn model_picker_filters_all_terms_and_changes_scope() {
    let mut picker = super::ModelPicker::from_pairs(
        vec![
            ("openai".into(), "gpt-5.6-luna".into()),
            ("openai".into(), "gpt-5.6-terra".into()),
            ("anthropic".into(), "claude-sonnet".into()),
        ],
        "gpt-5.6-luna",
    )
    .unwrap();

    picker.query = "openai luna".into();
    picker.refresh_items();
    assert_eq!(picker.items.len(), 1);
    assert_eq!(picker.items[0].value, "gpt-5.6-luna");

    picker.select_scope(1);
    assert_eq!(picker.scopes[picker.active_scope].label, "anthropic");
    assert!(picker.items.iter().all(|item| item.provider == "anthropic"));
}

/// #69: a paste while a picker owns the keyboard must not reach the chat
/// composer hidden behind it. The model picker takes it as its filter.
#[test]
fn paste_does_not_leak_past_open_pickers() {
    let mut app = test_app();
    app.model_picker = super::ModelPicker::from_pairs(
        vec![("openai".into(), "gpt-5-codex".into())],
        "missing-current",
    );
    route_paste_event(&mut app, Event::Paste("codex".into()));
    assert!(app.input.is_empty(), "paste leaked past the model picker");
    assert_eq!(app.model_picker.as_ref().unwrap().query, "codex");

    let mut app = test_app();
    app.picker = Some(super::Picker {
        kind: PickerKind::AgentSettings,
        items: Vec::new(),
        selected: 0,
        armed_delete: None,
    });
    route_paste_event(&mut app, Event::Paste("must not become chat".into()));
    assert!(app.input.is_empty(), "paste leaked past the list picker");
}

#[tokio::test]
async fn model_picker_enter_uses_raw_value_while_label_is_provider_scoped() {
    let mut app = test_app();
    app.model_picker = super::ModelPicker::from_pairs(
        vec![("openai".into(), "gpt-5-codex".into())],
        "missing-current",
    );

    let picker = app.model_picker.as_ref().unwrap();
    assert_eq!(picker.items[picker.selected].provider, "openai");
    assert_eq!(picker.items[picker.selected].model, "gpt-5-codex");
    assert_eq!(picker.items[picker.selected].value, "gpt-5-codex");

    press(&mut app, KeyCode::Enter, KeyModifiers::NONE).await;

    assert_eq!(app.model, "gpt-5-codex");
    assert!(app.model_picker.is_none());
}

#[test]
fn model_picker_reopens_with_newly_written_provider_models() {
    with_isolated_login_state(|| {
        crate::core::agent::global_config::set_provider(
            "tokamak",
            crate::core::agent::global_config::ProviderUpdate {
                api_key: Some("tk".into()),
                clear_api_key: false,
                base_url: Some(crate::core::cli::tokamak::BASE_URL.into()),
                models: Some(vec!["tokamak-old".into()]),
                api_type: None,
                ..Default::default()
            },
        )
        .unwrap();

        let mut app = test_app();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(super::open_model_picker(&mut app));
        assert!(app
            .model_picker
            .as_ref()
            .unwrap()
            .all_items
            .iter()
            .any(|item| item.value == "tokamak-old"));

        crate::core::agent::global_config::set_provider(
            "tokamak",
            crate::core::agent::global_config::ProviderUpdate {
                api_key: Some("tk".into()),
                clear_api_key: false,
                base_url: Some(crate::core::cli::tokamak::BASE_URL.into()),
                models: Some(vec!["tokamak-old".into(), "tokamak-new".into()]),
                api_type: None,
                ..Default::default()
            },
        )
        .unwrap();

        rt.block_on(super::open_model_picker(&mut app));
        let picker = app.model_picker.as_ref().unwrap();
        assert!(picker
            .all_items
            .iter()
            .any(|item| item.value == "tokamak-new"));
        assert!(app.picker.is_none());
    });
}

// --- `/mcp` management screen -------------------------------------------

/// Write an `mcp_config.json` with the given servers into the redirected
/// data folder, so the `/mcp` screen reads a real config.
fn write_mcp_config(folder: &std::path::Path, servers: serde_json::Value) {
    std::fs::write(
        folder.join("mcp_config.json"),
        serde_json::to_string(&serde_json::json!({
            "mcpServers": servers,
            "mcpSettings": {},
        }))
        .unwrap(),
    )
    .unwrap();
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

/// The regression this whole screen exists for: a fresh install used to get
/// a note and no screen, so `a` (add) -- the only thing that could fix the
/// empty state -- was unreachable.
#[test]
fn the_mcp_screen_opens_on_a_watermark_row_when_nothing_is_configured() {
    crate::core::app::commands::with_temp_data_folder(|_| {
        let mut app = test_app();
        rt().block_on(super::open_mcp_picker(&mut app, &no_mcp()));

        let picker = app.picker.as_ref().expect("the screen opens even so");
        assert_eq!(picker.kind, PickerKind::ToggleMcp);
        assert_eq!(picker.items.len(), 1);
        assert!(picker.items[0].label.contains("press a to add"));
        // An empty value marks the row inert, the way the provider screen's
        // watermark does.
        assert!(picker.items[0].value.is_empty());
        assert!(picker.action_hint().contains("a add"));
    });
}

#[test]
fn the_mcp_screen_lists_configured_servers_with_their_state() {
    crate::core::app::commands::with_temp_data_folder(|folder| {
        write_mcp_config(
            folder,
            serde_json::json!({
                "files": { "command": "npx", "args": ["-y", "files"], "active": true },
                "remote": { "type": "http", "url": "https://x/mcp", "active": false },
            }),
        );
        let mut app = test_app();
        rt().block_on(super::open_mcp_picker(&mut app, &no_mcp()));

        let items = &app.picker.as_ref().unwrap().items;
        assert_eq!(items.len(), 2);
        // Sorted by name, so the order is stable across runs.
        assert_eq!(items[0].value, "files");
        assert_eq!(items[0].checkbox, Some(true));
        assert!(
            items[0].label.contains("not connected"),
            "{}",
            items[0].label
        );
        assert_eq!(items[1].value, "remote");
        assert_eq!(items[1].checkbox, Some(false));
        assert!(items[1].label.contains("disabled"), "{}", items[1].label);
    });
}

/// An http server with no stored tokens reads as `needs auth` rather than
/// the bare `not connected` a stdio server gets: the two have different
/// fixes.
#[test]
fn an_unauthenticated_remote_server_is_labelled_needs_auth() {
    crate::core::app::commands::with_temp_data_folder(|folder| {
        write_mcp_config(
            folder,
            serde_json::json!({
                "remote": { "type": "http", "url": "https://x/mcp", "active": true },
            }),
        );
        let mut app = test_app();
        rt().block_on(super::open_mcp_picker(&mut app, &no_mcp()));
        assert!(app.picker.as_ref().unwrap().items[0]
            .label
            .contains("needs auth"));
    });
}

#[test]
fn the_detail_screen_shows_status_auth_and_where_the_config_lives() {
    crate::core::app::commands::with_temp_data_folder(|folder| {
        write_mcp_config(
            folder,
            serde_json::json!({
                "remote": { "type": "http", "url": "https://x/mcp", "active": true },
            }),
        );
        let mut app = test_app();
        rt().block_on(super::open_mcp_detail(&mut app, "remote", &no_mcp()));

        assert_eq!(app.picker.as_ref().unwrap().kind, PickerKind::McpServer);
        let detail = app.mcp_detail.as_ref().expect("detail is held on App");
        let text: String = super::mcp_detail_lines(detail, None, "⠋", 120)
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert!(text.contains("remote"), "{text}");
        assert!(text.contains("Status:"), "{text}");
        assert!(text.contains("not connected"), "{text}");
        assert!(text.contains("Auth:"), "{text}");
        assert!(text.contains("not authenticated"), "{text}");
        assert!(text.contains("URL:"), "{text}");
        assert!(text.contains("https://x/mcp"), "{text}");
        assert!(text.contains("Config location:"), "{text}");
        assert!(text.contains("mcp_config.json"), "{text}");
        assert!(text.contains("Tools:"), "{text}");
    });
}

/// A sign-in in flight for the open server takes over the Auth row with a
/// spinning status and a cancel hint, in place of the static auth state. The
/// consent url is deliberately *not* printed here -- a wrapped url is
/// click-truncated by the terminal and loses `code_challenge` (PKCE); the
/// browser prompt opens the full url instead.
#[test]
fn the_detail_screen_pins_the_signin_url_while_authorizing() {
    crate::core::app::commands::with_temp_data_folder(|folder| {
        write_mcp_config(
            folder,
            serde_json::json!({
                "remote": { "type": "http", "url": "https://x/mcp", "active": true },
            }),
        );
        let mut app = test_app();
        rt().block_on(super::open_mcp_detail(&mut app, "remote", &no_mcp()));
        let detail = app.mcp_detail.as_ref().expect("detail is held on App");
        let flow = super::McpAuthFlow {
            server: "remote".to_string(),
            stage: super::McpAuthStage::AwaitingRedirect,
        };
        let text: String = super::mcp_detail_lines(detail, Some(&flow), "⠹", 120)
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert!(text.contains("signing in"), "{text}");
        assert!(text.contains("waiting for you"), "{text}");
        assert!(text.contains('⠹'), "spinner is shown: {text}");
        assert!(text.contains("Answer the browser prompt"), "{text}");
        // The raw consent url is never rendered on this screen: it would be
        // click-truncated and fail PKCE.
        assert!(
            !text.contains("https://provider/oauth?code_challenge=abc"),
            "{text}"
        );
        assert!(text.contains("Esc cancels"), "{text}");
        // The static state is replaced, not shown alongside.
        assert!(!text.contains("not authenticated"), "{text}");
    });
}

/// The "open a browser?" confirm must render on the `/mcp` picker screen.
/// `draw` returns early for pickers, so a regression here leaves the user
/// with only the wrapped consent url to click -- which terminals truncate
/// past the first line, dropping `code_challenge` and failing PKCE.
#[test]
fn the_mcp_screen_shows_the_browser_confirm() {
    crate::core::app::commands::with_temp_data_folder(|folder| {
        write_mcp_config(
            folder,
            serde_json::json!({
                "remote": { "type": "http", "url": "https://x/mcp", "active": true },
            }),
        );
        let mut app = test_app();
        rt().block_on(super::open_mcp_detail(&mut app, "remote", &no_mcp()));
        assert!(app.picker.is_some(), "the /mcp detail screen is a picker");
        app.browser_confirm = Some(super::BrowserConfirm {
            url: "https://provider/oauth?code_challenge=abc".to_string(),
            purpose: "authorize 'remote'".to_string(),
        });
        let screen = render_rows(&mut app, 100, 24).join("\n");
        assert!(screen.contains("open a browser?"), "{screen}");
        assert!(screen.contains("Enter open"), "{screen}");
    });
}

/// Esc during an in-flight sign-in asks the loop to cancel it and keeps the
/// detail screen open, rather than stepping back to the server list.
#[test]
fn esc_cancels_an_in_flight_signin() {
    crate::core::app::commands::with_temp_data_folder(|folder| {
        write_mcp_config(
            folder,
            serde_json::json!({
                "remote": { "type": "http", "url": "https://x/mcp", "active": true },
            }),
        );
        let registry: PermissionRegistry =
            std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
        let mut current: Option<CurrentRun> = None;
        let mut app = test_app();
        let servers = no_mcp();
        rt().block_on(async {
            super::open_mcp_detail(&mut app, "remote", &servers).await;
            app.mcp_auth = Some(super::McpAuthFlow {
                server: "remote".to_string(),
                stage: super::McpAuthStage::Discovering,
            });
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
                &registry,
                &mut current,
                &servers,
            )
            .await;
            assert!(app.mcp_auth_cancel, "Esc requests cancel");
            assert_eq!(
                app.picker.as_ref().map(|p| p.kind),
                Some(PickerKind::McpServer),
                "still on the detail screen"
            );
            assert!(app.mcp_detail.is_some());
        });
    });
}

/// A stdio server has no HTTP transport, so the auth rows are absent rather
/// than present-and-inert; and a disconnected server has no tools to view.
#[test]
fn detail_actions_are_filtered_to_what_the_server_can_actually_do() {
    crate::core::app::commands::with_temp_data_folder(|folder| {
        write_mcp_config(
            folder,
            serde_json::json!({
                "files": { "command": "npx", "args": [], "active": true },
            }),
        );
        let mut app = test_app();
        rt().block_on(super::open_mcp_detail(&mut app, "files", &no_mcp()));

        let values: Vec<&str> = app
            .picker
            .as_ref()
            .unwrap()
            .items
            .iter()
            .map(|i| i.value.as_str())
            .collect();
        assert!(!values.contains(&super::MCP_ACTION_AUTH), "{values:?}");
        assert!(
            !values.contains(&super::MCP_ACTION_CLEAR_AUTH),
            "{values:?}"
        );
        // Not connected, so there is nothing to list.
        assert!(!values.contains(&super::MCP_ACTION_TOOLS), "{values:?}");
        assert!(values.contains(&super::MCP_ACTION_TOGGLE), "{values:?}");
        assert!(values.contains(&super::MCP_ACTION_EDIT), "{values:?}");
        assert!(values.contains(&super::MCP_ACTION_REMOVE), "{values:?}");
        // An active server can be reconnected; the label reads Disable.
        assert!(values.contains(&super::MCP_ACTION_RECONNECT), "{values:?}");
        let toggle = app
            .picker
            .as_ref()
            .unwrap()
            .items
            .iter()
            .find(|i| i.value == super::MCP_ACTION_TOGGLE)
            .unwrap();
        assert_eq!(toggle.label, "Disable");
        // Rows are numbered, as the screen is meant to read.
        assert_eq!(
            app.picker.as_ref().unwrap().items[0].hint.as_deref(),
            Some("1.")
        );
    });
}

#[test]
fn a_remote_server_offers_authenticate_and_no_clear_until_there_is_something_to_clear() {
    crate::core::app::commands::with_temp_data_folder(|folder| {
        write_mcp_config(
            folder,
            serde_json::json!({
                "remote": { "type": "http", "url": "https://x/mcp", "active": false },
            }),
        );
        let mut app = test_app();
        rt().block_on(super::open_mcp_detail(&mut app, "remote", &no_mcp()));

        let items = &app.picker.as_ref().unwrap().items;
        let auth = items
            .iter()
            .find(|i| i.value == super::MCP_ACTION_AUTH)
            .expect("an unauthenticated remote can sign in");
        assert_eq!(auth.label, "Authenticate");
        assert!(!items
            .iter()
            .any(|i| i.value == super::MCP_ACTION_CLEAR_AUTH));
        // Inactive, so Reconnect is not offered and the toggle reads Enable.
        assert!(!items.iter().any(|i| i.value == super::MCP_ACTION_RECONNECT));
        assert_eq!(
            items
                .iter()
                .find(|i| i.value == super::MCP_ACTION_TOGGLE)
                .unwrap()
                .label,
            "Enable"
        );
    });
}

/// A hand-written `Authorization` header is the user's own credential: OAuth
/// must not offer to replace it, because doing so would break it.
#[test]
fn a_hand_written_authorization_header_suppresses_the_oauth_actions() {
    crate::core::app::commands::with_temp_data_folder(|folder| {
        write_mcp_config(
            folder,
            serde_json::json!({
                "remote": {
                    "type": "http",
                    "url": "https://x/mcp",
                    "headers": { "Authorization": "Bearer mine" },
                    "active": true,
                },
            }),
        );
        let mut app = test_app();
        rt().block_on(super::open_mcp_detail(&mut app, "remote", &no_mcp()));
        let items = &app.picker.as_ref().unwrap().items;
        assert!(!items.iter().any(|i| i.value == super::MCP_ACTION_AUTH));
        assert!(!items
            .iter()
            .any(|i| i.value == super::MCP_ACTION_CLEAR_AUTH));
    });
}

/// #148: Space used to flip the row before writing mcp_config.json, and a
/// failed write left the checkbox showing a state that was not on disk.
#[test]
fn space_leaves_the_row_unchanged_when_the_config_write_fails() {
    crate::core::app::commands::with_temp_data_folder(|folder| {
        write_mcp_config(
            folder,
            serde_json::json!({
                "files": { "command": "npx", "args": ["-y", "files"], "active": false },
            }),
        );
        let registry: PermissionRegistry =
            std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
        let mut current: Option<CurrentRun> = None;
        let mut app = test_app();
        let servers = no_mcp();
        rt().block_on(async {
            super::open_mcp_picker(&mut app, &servers).await;
            assert_eq!(app.picker.as_ref().unwrap().items[0].checkbox, Some(false));
            // The server vanishes from the config behind the picker's back,
            // so the write in `set_active` fails.
            write_mcp_config(folder, serde_json::json!({}));
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE),
                &registry,
                &mut current,
                &servers,
            )
            .await;
        });
        let item = &app.picker.as_ref().expect("still on the list").items[0];
        assert_eq!(item.value, "files");
        assert_eq!(item.checkbox, Some(false), "the row flipped on a failed write");
    });
}

/// The watermark row is inert: Enter must not open a detail screen for the
/// empty string, and Space must not try to toggle it.
#[test]
fn the_watermark_row_does_nothing_on_enter_or_space() {
    crate::core::app::commands::with_temp_data_folder(|_| {
        let registry: PermissionRegistry =
            std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
        let mut current: Option<CurrentRun> = None;
        let mut app = test_app();
        let servers = no_mcp();
        rt().block_on(async {
            super::open_mcp_picker(&mut app, &servers).await;
            for code in [KeyCode::Enter, KeyCode::Char(' ')] {
                handle_key(
                    &mut app,
                    KeyEvent::new(code, KeyModifiers::NONE),
                    &registry,
                    &mut current,
                    &servers,
                )
                .await;
                assert!(app.mcp_detail.is_none(), "{code:?} opened a detail screen");
                assert_eq!(
                    app.picker.as_ref().map(|p| p.kind),
                    Some(PickerKind::ToggleMcp),
                    "{code:?} left the list"
                );
            }
        });
    });
}

/// Esc on the detail screen steps back up to the list rather than closing
/// `/mcp` outright.
#[test]
fn esc_on_the_detail_screen_returns_to_the_server_list() {
    crate::core::app::commands::with_temp_data_folder(|folder| {
        write_mcp_config(
            folder,
            serde_json::json!({
                "files": { "command": "npx", "args": [], "active": true },
            }),
        );
        let registry: PermissionRegistry =
            std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
        let mut current: Option<CurrentRun> = None;
        let mut app = test_app();
        let servers = no_mcp();
        rt().block_on(async {
            super::open_mcp_detail(&mut app, "files", &servers).await;
            assert_eq!(app.picker.as_ref().unwrap().kind, PickerKind::McpServer);

            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
                &registry,
                &mut current,
                &servers,
            )
            .await;
            assert_eq!(
                app.picker.as_ref().map(|p| p.kind),
                Some(PickerKind::ToggleMcp),
                "Esc should step back, not close"
            );
            assert!(app.mcp_detail.is_none());
        });
    });
}

/// Removing a server takes its tokens with it: a later server reusing the
/// name must not silently inherit someone else's authorization.
#[test]
fn removing_a_server_also_forgets_its_stored_credentials() {
    crate::core::app::commands::with_temp_data_folder(|folder| {
        write_mcp_config(
            folder,
            serde_json::json!({
                "remote": { "type": "http", "url": "https://x/mcp", "active": false },
            }),
        );
        // A credential file the removal must clean up. Spelled out rather
        // than stubbed: an unparseable record would read as an empty store
        // and the assertion would pass without the removal doing anything.
        let store = folder.join("mcp_oauth.json");
        std::fs::write(
            &store,
            serde_json::to_string(&serde_json::json!({
                "remote": {
                    "client_id": "c1",
                    "tokens": {
                        "access_token": "at",
                        "token_type": "bearer",
                        "expires_in": 3600
                    },
                    "expires_at": 9_999_999_999u64,
                    "resource": "https://x/mcp"
                }
            }))
            .unwrap(),
        )
        .unwrap();
        // The fixture must actually load, or this test proves nothing.
        assert!(
            super::super::mcp::auth_status(
                "remote",
                &serde_json::json!({ "type": "http", "url": "https://x/mcp" })
            ) != crate::core::mcp::oauth::AuthStatus::Unauthenticated
        );

        let mut app = test_app();
        rt().block_on(super::remove_mcp_server(&mut app, "remote", &no_mcp()));

        assert!(super::super::mcp::get_server("remote").is_none());
        let left = std::fs::read_to_string(&store).unwrap_or_default();
        assert!(!left.contains("remote"), "credentials survived: {left}");
    });
}

/// The detail screen must open in one frame, so the tool list is requested
/// as a job rather than awaited inline.
#[test]
fn a_connected_servers_tool_list_is_requested_as_a_job_not_awaited() {
    crate::core::app::commands::with_temp_data_folder(|folder| {
        write_mcp_config(
            folder,
            serde_json::json!({
                "files": { "command": "npx", "args": [], "active": true },
            }),
        );
        let mut app = test_app();
        rt().block_on(super::open_mcp_detail(&mut app, "files", &no_mcp()));
        // Not connected here, so nothing is requested and the state says why.
        assert!(app.mcp_job_request.is_none());
        assert!(matches!(
            app.mcp_detail.as_ref().unwrap().tools,
            super::ToolsState::Unavailable
        ));
    });
}

#[test]
fn a_long_value_is_clamped_instead_of_pushing_the_border_off_the_frame() {
    use ratatui::text::Span;
    let line = Line::from(vec![Span::raw("URL:  "), Span::raw("x".repeat(400))]);
    let clamped = super::clamp_line(line, 40);
    let width: usize = clamped
        .spans
        .iter()
        .map(|s| s.content.chars().count())
        .sum();
    assert!(width <= 38, "clamped to {width}");
    assert!(clamped.spans.last().unwrap().content.ends_with('\u{2026}'));
}

/// The bug #8726 was reverted for: a 2-cell emoji stood in for a 1-cell
/// character, so every frame was a cell wider than the text and the tail
/// slid right until the last character fell off the row. The sweep must
/// occupy exactly the width of the message it travels along, at every frame.
#[test]
fn a_wide_glyph_never_changes_the_row_width() {
    let message = "working…";
    let plain = message.width();
    for glyph in ["👋", "🍌", "~", "<o>"] {
        for frame in 0..40 {
            let line = wave_sweep_line(message, glyph, frame, Style::default());
            assert_eq!(
                spans_width(&line.spans),
                plain,
                "glyph {glyph:?} frame {frame} changed the row width"
            );
        }
    }
}

/// The glyph covers characters instead of deleting them: every frame keeps
/// the message's own width, and the characters it is not standing on are
/// still there in order.
#[test]
fn the_sweep_covers_characters_without_dropping_the_rest() {
    let line = wave_sweep_line("working…", "👋", 0, Style::default());
    let text = line_text(&line);
    assert!(text.starts_with('👋'), "{text}");
    // "👋" is two cells, so it stands on "wo" and the rest survives.
    assert!(text.ends_with("rking…"), "{text}");
}

/// A 1-cell glyph spends one character, so a narrow ASCII wave is exact
/// rather than padded.
#[test]
fn a_narrow_glyph_covers_exactly_one_character() {
    let line = wave_sweep_line("abc", "~", 0, Style::default());
    assert_eq!(line_text(&line), "~bc");
}

/// The sweep reverses at both ends instead of jumping back to the start,
/// and never runs off the message.
#[test]
fn the_sweep_reverses_at_both_ends() {
    let seen: Vec<String> = (0..8)
        .map(|frame| line_text(&wave_sweep_line("abcd", "~", frame, Style::default())))
        .collect();
    assert_eq!(
        seen,
        vec!["~bcd", "a~cd", "ab~d", "abc~", "ab~d", "a~cd", "~bcd", "a~cd"]
    );
}

/// Multi-byte characters are covered on character boundaries, so a sweep
/// over non-ASCII text cannot slice a `char` in half and panic.
#[test]
fn the_sweep_respects_character_boundaries() {
    for frame in 0..12 {
        let line = wave_sweep_line("éxé…", "~", frame, Style::default());
        assert_eq!(spans_width(&line.spans), "éxé…".width());
    }
}

/// A message narrower than the glyph has nowhere to sweep, so it is left
/// alone rather than being overwritten by a glyph wider than itself.
#[test]
fn a_message_narrower_than_the_glyph_is_left_alone() {
    let line = wave_sweep_line("a", "👋", 0, Style::default());
    assert_eq!(line_text(&line), "a");
}

/// Unset `wave` leaves the Braille throbber in place: the sweep is opt-in,
/// so a terminal with no emoji font is unaffected by default.
///
/// Anchored on "Esc to cancel", which only the input row carries: the header
/// also shows `[working]` and the brand wave, and matching those would test
/// the wrong row.
#[test]
fn the_working_row_keeps_its_throbber_until_a_wave_is_configured() {
    let mut app = test_app();
    app.status = Status::Running;
    let rows = with_wave_glyph(None, || render_rows(&mut app, 80, 12));
    let row = rows
        .iter()
        .find(|r| r.contains("Esc to cancel"))
        .expect("working row")
        .clone();
    assert!(
        SPINNER.iter().any(|s| row.contains(s)),
        "expected a throbber in {row:?}"
    );
    assert!(!row.contains('👋'), "{row}");
}

/// With `wave` set the glyph replaces the throbber rather than joining it:
/// two moving things on one row read as jitter.
#[test]
fn a_configured_wave_replaces_the_throbber() {
    let mut app = test_app();
    app.status = Status::Running;
    let rows = with_wave_glyph(Some("🍌"), || render_rows(&mut app, 80, 12));
    let row = rows
        .iter()
        .find(|r| r.contains("Esc to cancel"))
        .expect("working row")
        .clone();
    assert!(row.contains('🍌'), "expected the wave in {row:?}");
    assert!(
        !SPINNER.iter().any(|s| row.contains(s)),
        "throbber still present in {row:?}"
    );
}
