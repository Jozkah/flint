
/// An empty MCP map, for the `run_command`/`handle_key` paths that take one
/// but whose behaviour under test has nothing to do with MCP.
pub(super) fn no_mcp() -> crate::core::state::SharedMcpServers {
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
pub(super) fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

pub(super) fn mouse_at(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
    MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    }
}

/// Press and release without moving: the gesture that toggles a region.
pub(super) fn click(app: &mut App, column: u16, row: u16) {
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
pub(super) struct TestApp {
    pub(super) app: App,
    pub(super) _dir: tempfile::TempDir,
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

pub(super) fn test_app() -> TestApp {
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

pub(super) fn steering_request(
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

/// App whose project has one installed skill `<name>/SKILL.md` with the
/// given frontmatter description, so slash-popup and dispatch tests run
/// against a real `.jan/agent/skills/` tree. Returns the temp project
/// root for cleanup.
pub(super) fn skill_test_app(name: &str, description: &str) -> (App, std::path::PathBuf) {
    skill_test_app_fm(name, description, "")
}

/// Like `skill_test_app` but with extra frontmatter lines (before the
/// closing `---`), for invocation-flag tests.
pub(super) fn skill_test_app_fm(
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
pub(super) fn render_rows(app: &mut App, w: u16, h: u16) -> Vec<String> {
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

pub(super) fn pending(offers_always: bool) -> Pending {
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

pub(super) fn transcript_text(app: &App) -> String {
    app.transcript.iter().map(message_text_of).collect()
}

pub(super) fn message_text_of(row: &Row) -> String {
    row_text(row)
}

/// Text a committed transcript row renders to at a nominal width, joined
/// across the lines a multi-line row (prose, a diff panel) expands to.
pub(super) fn row_text(row: &Row) -> String {
    row_lines(std::slice::from_ref(row))
        .iter()
        .map(line_text)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every line the given rows render to at a nominal width.
pub(super) fn row_lines(rows: &[Row]) -> Vec<Line<'static>> {
    rows.iter().flat_map(|r| r.lines(80)).collect()
}

pub(super) async fn prompt_key(app: &mut App, code: KeyCode, mods: KeyModifiers) {
    let registry: PermissionRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let mut current: Option<CurrentRun> = None;
    handle_key(app, KeyEvent::new(code, mods), &registry, &mut current, &no_mcp()).await;
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

/// A backend that counts cursor-position queries and otherwise is a
/// `TestBackend`. `Terminal::clear` issues one, which on crossterm is a DSR
/// round trip that blocks for up to two seconds on a silent terminal.
pub(super) struct CountingBackend {
    pub(super) inner: TestBackend,
    pub(super) cursor_queries: std::cell::Cell<usize>,
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

pub(super) fn ask_request(
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

pub(super) async fn press_ask(
    app: &mut App,
    registry: &crate::core::agent::interaction::AskRegistry,
    code: KeyCode,
) {
    assert!(handle_ask_key(app, KeyEvent::new(code, KeyModifiers::NONE), registry,).await);
}

pub(super) fn line_text(line: &ratatui::text::Line) -> String {
    line.spans.iter().map(|s| s.content.as_ref()).collect()
}

pub(super) fn lines_text(lines: &[ratatui::text::Line]) -> String {
    lines.iter().map(line_text).collect::<Vec<_>>().join("\n")
}

/// Text of a streaming write preview's tail, dropping the highlight styles.
pub(super) fn tail_text(call: &super::StartingCall) -> Option<Vec<String>> {
    call.preview.tail.as_ref().map(|rows| {
        rows.iter()
            .map(|r| r.iter().map(|s| s.content.as_ref()).collect())
            .collect()
    })
}

/// Like `line_text`, but marks the reverse-video block cursor with `▏` at its
/// left edge so caret-position assertions survive the styled-space rendering.
/// The synthetic end-of-line filler space is represented by the marker alone.
pub(super) fn caret_text(line: &ratatui::text::Line) -> String {
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

pub(super) async fn press_esc(app: &mut App) {
    let registry: PermissionRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let mcp_servers: crate::core::state::SharedMcpServers =
        Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let mut current: Option<CurrentRun> = None;
    let esc = KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE);
    handle_key(app, esc, &registry, &mut current, &mcp_servers).await;
}

/// Put `text` in the composer with the caret marked by `|`.
pub(super) fn composer(app: &mut App, text: &str) {
    let cursor = text.find('|').expect("mark the caret with |");
    app.input = text.replace('|', "");
    app.cursor = cursor;
}

/// The composer as `text|with the caret marked`.
pub(super) fn composed(app: &App) -> String {
    let mut s = app.input.clone();
    s.insert(app.cursor, '|');
    s
}

#[cfg(windows)]
#[test]
pub(super) fn altgr_at_sign_inserted_on_windows_style_event() {
    let both = KeyModifiers::CONTROL | KeyModifiers::ALT;
    assert!(!super::key_is_ctrl(&KeyEvent::new(KeyCode::Char('@'), both)));
    let accented = char::from_u32(0x105).unwrap();
    assert!(!super::key_is_ctrl(&KeyEvent::new(KeyCode::Char(accented), both)));
}

pub(super) async fn press(app: &mut App, code: KeyCode, mods: KeyModifiers) {
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

pub(super) async fn type_key_chars(app: &mut App, text: &str) {
    for ch in text.chars() {
        press(app, KeyCode::Char(ch), KeyModifiers::NONE).await;
    }
}

/// Submit `text` from the composer and drop back to idle, as a finished
/// turn would, so the next message starts from a fresh input box.
pub(super) async fn submit_line(app: &mut App, text: &str) {
    type_key_chars(app, text).await;
    press(app, KeyCode::Enter, KeyModifiers::NONE).await;
    app.status = Status::Idle;
}

pub(super) fn with_isolated_login_state<T>(f: impl FnOnce() -> T) -> T {
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

pub(super) fn pending_browser(app: &mut App) {
    app.browser_confirm = Some(super::BrowserConfirm {
        url: "https://github.com/login/oauth/authorize?client_id=x".into(),
        purpose: "authorize 'github'".into(),
    });
}

/// Every answer dismisses the question. `browser::open` is disabled under
/// `cfg(test)`, so the accept path is exercised without a real browser.
#[tokio::test]
pub(super) async fn every_answer_dismisses_the_mcp_browser_question() {
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

/// The paste field with the browser question already answered -- what most
/// key-entry tests are actually about.
/// Accepting launches the opener and moves on. `browser::open` is disabled
/// under `cfg(test)`, so this exercises the accept path (and its "could not
/// open" reporting) without hijacking a real browser.
#[tokio::test]
pub(super) async fn accepting_the_browser_question_moves_on_either_way() {
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

pub(super) fn confirmed_paste_prompt() -> super::LoginPrompt {
    super::LoginPrompt {
        stage: super::LoginStage::Paste {
            confirm_open: false,
        },
        ..super::LoginPrompt::new("tokamak")
    }
}

/// Open the paste fallback and decline the browser, leaving an editable field.
pub(super) async fn open_paste_field(app: &mut App) {
    super::open_login_prompt(app, "tokamak");
    press(app, KeyCode::Char('n'), KeyModifiers::NONE).await;
}

pub(super) fn test_session() -> crate::core::cli::device_auth::Session {
    crate::core::cli::device_auth::Session {
        session_id: "sess-1".into(),
        user_code: "ABCD-2345".into(),
        authorize_url: "https://tokamak.sh/cli/authorize?code=ABCD-2345".into(),
        expires_in: 300,
        interval: 5,
    }
}

pub(super) fn blank_mcp_prompt() -> super::McpPrompt {
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
pub(super) type DockSetup = (&'static str, fn(&mut App));

pub(super) fn wrap(run_id: &str, name: &str, event: StreamEvent) -> StreamEvent {
    StreamEvent::Subagent {
        run_id: run_id.into(),
        name: name.into(),
        event: Box::new(event),
    }
}

/// Non-frame, non-marker colours in a diff panel: what syntax highlighting
/// contributes, as distinct from the red/green add-remove markers.
pub(super) fn diff_syntax_colours(lines: &[ratatui::text::Line]) -> Vec<ratatui::style::Color> {
    lines
        .iter()
        .flat_map(|l| l.spans.iter())
        .filter_map(|s| s.style.fg)
        .filter(|c| matches!(c, ratatui::style::Color::Rgb(..)))
        .collect()
}

/// The row containing `needle`, panicking if there is none.
pub(super) fn diff_row(rows: &[Line<'static>], needle: &str) -> Line<'static> {
    rows.iter()
        .find(|l| line_text(l).contains(needle))
        .unwrap_or_else(|| panic!("no row containing {needle:?}"))
        .clone()
}

/// Backgrounds of a row's spans, skipping the box frame and the gutter so
/// only the banded interior is left.
pub(super) fn row_backgrounds(rows: &[Line<'static>], needle: &str) -> Vec<Option<ratatui::style::Color>> {
    diff_row(rows, needle)
        .spans
        .iter()
        .filter(|s| !s.content.is_empty() && !s.content.contains('│'))
        .map(|s| s.style.bg)
        .collect()
}

pub(super) fn plus_rows(n: usize) -> String {
    (0..n)
        .map(|i| format!("+ line {i}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Helper: the wire messages carrying `tool_calls`, and the `role: "tool"`
/// messages, for the assertions below.
pub(super) fn tool_turns(app: &App) -> (Vec<&serde_json::Value>, Vec<&serde_json::Value>) {
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

/// Run one turn that reasons, calls a diff-producing tool, and answers,
/// leaving it persisted (messages + journal) in `app.agent_dir`.
pub(super) fn record_full_turn(app: &mut App) {
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

pub(super) fn test_worktree(path: &str) -> Worktree {
    Worktree {
        path: std::path::PathBuf::from(path),
        branch: "jan/agent/abc12345".to_string(),
    }
}

pub(super) fn bkey(code: KeyCode) -> Event {
    Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
}

pub(super) fn brelease(code: KeyCode) -> Event {
    Event::Key(KeyEvent::new_with_kind(code, KeyModifiers::NONE, KeyEventKind::Release))
}

pub(super) fn start_subagent(app: &mut App, run_id: &str, name: &str) {
    start_subagent_with_task(app, run_id, name, None);
}

pub(super) fn start_subagent_with_task(app: &mut App, run_id: &str, name: &str, task: Option<&str>) {
    app.apply(StreamEvent::SubagentStart {
        run_id: run_id.into(),
        name: name.into(),
        task: task.map(str::to_string),
    });
}

pub(super) fn compaction_event(
    phase: crate::core::agent::events::CompactionPhase,
    messages: Option<usize>,
) -> StreamEvent {
    StreamEvent::Compaction {
        phase,
        reason: crate::core::agent::events::CompactionReason::SessionBudget,
        messages,
    }
}

pub(super) fn retry_event(attempt: u32, delay_ms: u64) -> StreamEvent {
    StreamEvent::Retry {
        attempt,
        max_attempts: 10,
        delay_ms,
        reason: "Upstream returned HTTP 503: busy".into(),
    }
}

pub(super) fn subagent_event(app: &mut App, run_id: &str, name: &str, event: StreamEvent) {
    app.apply(StreamEvent::Subagent {
        run_id: run_id.into(),
        name: name.into(),
        event: Box::new(event),
    });
}

pub(super) fn detail_text(block: &super::ReasoningBlock) -> String {
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

pub(super) fn todo_item(content: &str) -> crate::core::agent::todo::TodoItem {
    crate::core::agent::todo::TodoItem {
        content: content.to_string(),
        status: crate::core::agent::todo::TodoStatus::Pending,
    }
}

/// Build a report with explicit per-category tokens, free space and buffer
/// derived the way [`App::context_report`] derives them, so the tests
/// exercise the real partition rather than a hand-balanced one.
pub(super) fn context_report(window: u64, buffer: u64, content: [u64; 5]) -> ContextReport {
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

pub(super) fn plan_review_request() -> crate::core::agent::interaction::AskRequest {
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

pub(super) fn staged_todos() -> crate::core::agent::todo::TodoList {
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
pub(super) fn finish_clean_turn(app: &mut App) {
    finish_clean_turn_with_answer(app, "all set");
}

/// Like `finish_clean_turn`, but with a caller-chosen final answer text.
pub(super) fn finish_clean_turn_with_answer(app: &mut App, text: &str) {
    app.status = Status::Running;
    app.apply(StreamEvent::Token { text: text.into() });
    app.on_done("stop".into(), None);
}

pub(super) fn last_history_content(app: &App) -> String {
    app.history
        .last()
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

pub(super) fn todos_from(
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

pub(super) fn crossed_out(line: &ratatui::text::Line) -> bool {
    line.spans
        .iter()
        .any(|s| s.style.add_modifier.contains(Modifier::CROSSED_OUT))
}

pub(super) fn cursor_after_draw(app: &mut App, w: u16, h: u16) -> (Vec<String>, Option<(u16, u16)>) {
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

pub(super) fn names(app: &App) -> Vec<String> {
    app.slash_matches()
        .iter()
        .map(|m| m.name().to_string())
        .collect()
}

/// A plugin with one folder skill under the app's project root.
pub(super) fn plugin_skill_in_app(root: &std::path::Path, plugin: &str, name: &str, description: &str) {
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
pub(super) fn plugin_command_in_app(root: &std::path::Path, plugin: &str, name: &str, content: &str) {
    let dir = root
        .join(".jan/agent/plugins")
        .join(plugin)
        .join("commands");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{name}.md")), content).unwrap();
}

pub(super) fn overflow_error() -> String {
    format!(
        "[{}] Upstream returned HTTP 400: context_length_exceeded",
        crate::core::agent::upstream::CONTEXT_OVERFLOW_MARKER
    )
}

pub(super) fn app_with_history(n: usize) -> TestApp {
    let mut app = test_app();
    for i in 0..n {
        app.history.push(serde_json::json!({
            "role": if i % 2 == 0 { "user" } else { "assistant" },
            "content": format!("msg{i}")
        }));
    }
    app
}

/// The splash row's rendered text at `width`, one string per line.
pub(super) fn banner_text(app: &App, width: u16) -> Vec<String> {
    app.transcript
        .iter()
        .flat_map(|row| row.lines(width))
        .map(|l| l.spans.iter().map(|s| s.content.to_string()).collect())
        .collect()
}

/// Spans of the last committed transcript row, as `(text, style)`.
pub(super) fn last_row(app: &App) -> Vec<(String, Style)> {
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

/// Every rendered line of the last row, as plain text.
pub(super) fn last_row_lines(app: &App, width: u16) -> Vec<String> {
    app.transcript
        .last()
        .expect("a row")
        .lines(width)
        .iter()
        .map(|l| l.spans.iter().map(|s| s.content.to_string()).collect())
        .collect()
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

pub(super) fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

mod render;
mod keys;
mod commands;
mod pickers;
mod rows;
mod stream;
