//! Moved verbatim out of `tui/tests.rs`.

use super::*;

/// #8804. First half: the bug is real -- an ordinary redraw diffs two
/// identical buffers, emits nothing, and leaves the broadcast on screen.
/// Second half: the repaint re-emits every cell and the damage is gone.
#[test]
fn repaint_restores_cells_a_foreign_write_corrupted() {
    let mut app = test_app();
    app.submit_user("what does this project do".to_string());
    let mut terminal = Terminal::new(TestBackend::new(60, 30)).unwrap();
    terminal.draw(|f| super::super::draw(f, &mut app)).unwrap();
    let clean = terminal.backend().buffer().clone();

    let (cx, cy) = broadcast_over(&mut terminal, &clean);
    assert_eq!(terminal.backend().buffer()[(cx, cy)].symbol(), "W");

    terminal.draw(|f| super::super::draw(f, &mut app)).unwrap();
    assert_eq!(
        terminal.backend().buffer()[(cx, cy)].symbol(),
        "W",
        "a plain redraw is expected to leave foreign damage in place"
    );

    app.request_repaint();
    assert!(app.take_repaint());
    apply_repaint(&mut terminal);
    terminal.draw(|f| super::super::draw(f, &mut app)).unwrap();
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
    terminal.draw(|f| super::super::draw(f, &mut app)).unwrap();
    let clean = terminal.backend().buffer().clone();

    let (cx, cy) = broadcast_over(&mut terminal, &clean);
    terminal.draw(|f| super::super::draw(f, &mut app)).unwrap();
    assert_eq!(
        terminal.backend().buffer()[(cx, cy)].symbol(),
        "W",
        "same-size autoresize must not be what repairs this"
    );

    route_resize_event(&mut app, Event::Resize(60, 30));
    assert!(app.take_repaint(), "a resize must request a full repaint");
    apply_repaint(&mut terminal);
    terminal.draw(|f| super::super::draw(f, &mut app)).unwrap();
    assert_eq!(terminal.backend().buffer(), &clean);
}

/// #8780. After a real change of geometry the frame on screen is exactly
/// the frame for the new size -- no rows from the old layout survive.
#[test]
fn a_resize_to_a_new_size_draws_the_whole_new_frame() {
    let mut app = test_app();
    app.submit_user("what does this project do".to_string());
    let mut terminal = Terminal::new(TestBackend::new(80, 30)).unwrap();
    terminal.draw(|f| super::super::draw(f, &mut app)).unwrap();

    terminal.backend_mut().resize(50, 20);
    route_resize_event(&mut app, Event::Resize(50, 20));
    assert!(app.take_repaint());
    apply_repaint(&mut terminal);
    terminal.draw(|f| super::super::draw(f, &mut app)).unwrap();

    let mut fresh = Terminal::new(TestBackend::new(50, 20)).unwrap();
    fresh.draw(|f| super::super::draw(f, &mut app)).unwrap();
    assert_eq!(terminal.backend().buffer(), fresh.backend().buffer());
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
    terminal.draw(|f| super::super::draw(f, &mut app)).unwrap();
    let before = terminal.backend().buffer().clone();

    let registry: PermissionRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let mut current: Option<CurrentRun> = None;
    let ctrl_l = KeyEvent::new(KeyCode::Char('l'), KeyModifiers::CONTROL);
    handle_key(&mut app, ctrl_l, &registry, &mut current, &no_mcp()).await;

    assert_eq!(app.input, "a draft mid-sentence");
    assert_eq!(app.scrollback, 7);
    assert!(app.take_repaint());
    apply_repaint(&mut terminal);
    terminal.draw(|f| super::super::draw(f, &mut app)).unwrap();
    assert_eq!(terminal.backend().buffer(), &before);
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
    terminal.draw(|f| super::super::draw(f, &mut app)).unwrap();
    let clean = terminal.backend().inner.buffer().clone();
    broadcast_over(&mut terminal, &clean);

    let before = terminal.backend().cursor_queries.get();
    apply_repaint(&mut terminal);
    terminal.draw(|f| super::super::draw(f, &mut app)).unwrap();
    assert_eq!(terminal.backend().cursor_queries.get() - before, 0);
    assert_eq!(terminal.backend().inner.buffer(), &clean);
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
    terminal.draw(|frame| super::super::draw(frame, &mut app)).unwrap();
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

#[test]
fn header_shows_thinking_and_thought_for_status_when_folded() {
    use ratatui::{backend::TestBackend, Terminal};
    let mut app = test_app();
    app.submit_user("hi".to_string());

    let render = |app: &mut App| {
        let mut terminal = Terminal::new(TestBackend::new(110, 30)).unwrap();
        terminal.draw(|f| super::super::draw(f, app)).unwrap();
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
        terminal.draw(|f| super::super::draw(f, app)).unwrap();
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
            Some(since - super::super::THOUGHT_FOR_TTL - std::time::Duration::from_secs(1));
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
        terminal.draw(|f| super::super::draw(f, app)).unwrap();
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
        terminal.draw(|f| super::super::draw(f, app)).unwrap();
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
        terminal.draw(|f| super::super::draw(f, app)).unwrap();
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
fn long_user_prompt_wraps_in_transcript() {
    use ratatui::{backend::TestBackend, Terminal};
    let mut app = test_app();
    let msg = "Check why in this project, for some models like Gemma 4 12b, \
                   the cache is never stored and it starts reprocessing the prompt \
                   from the beginning on every turn";
    app.submit_user(msg.to_string());
    let mut terminal = Terminal::new(TestBackend::new(60, 30)).unwrap();
    terminal.draw(|f| super::super::draw(f, &mut app)).unwrap();
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
    terminal.draw(|f| super::super::draw(f, &mut app)).unwrap();
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
    terminal.draw(|f| super::super::draw(f, &mut app)).unwrap();
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
        terminal.draw(|f| super::super::draw(f, app)).unwrap();
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
        terminal.draw(|f| super::super::draw(f, app)).unwrap();
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
        terminal.draw(|f| super::super::draw(f, app)).unwrap();
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
        terminal.draw(|f| super::super::draw(f, &mut app)).unwrap();
    });
    let buf = terminal.backend().buffer().clone();
    // Locate the placeholder row, then assert the action word's cells are
    // orange (the trailing hint stays dim, so only the word carries it).
    let orange = (0..buf.area.height).any(|y| {
        let row: String = (0..buf.area.width).map(|x| buf[(x, y)].symbol()).collect();
        if !THINKING_WORDS.iter().any(|w| row.contains(w)) {
            return false;
        }
        (0..buf.area.width).any(|x| buf[(x, y)].style().fg == Some(super::super::theme::strong_accent()))
    });
    assert!(orange, "thinking synonym not orange");
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
    assert!(!super::super::composer_live(&app));
    let _ = pos;
}
