//! Moved verbatim out of `tui/tests.rs`.

use super::*;

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

#[test]
fn ctrl_a_still_command() {
    assert!(super::super::key_is_ctrl(&KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL)));
    assert!(super::super::key_is_ctrl(&KeyEvent::new(
        KeyCode::Char('a'),
        KeyModifiers::CONTROL | KeyModifiers::ALT
    )));
    assert!(!super::super::key_is_ctrl(&KeyEvent::new(KeyCode::Char('b'), KeyModifiers::ALT)));
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

#[tokio::test]
async fn login_provider_selection_starts_the_api_key_prompt() {
    let mut app = test_app();
    super::super::open_login_picker(&mut app);
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
    super::super::open_login_picker(&mut app);
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
    super::super::open_login_picker(&mut app);

    press(&mut app, KeyCode::Esc, KeyModifiers::NONE).await;

    assert!(app.picker.is_none());
    assert!(app.login.is_none());
    assert!(app.login_submit.is_none());
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
    super::super::open_login_prompt(&mut app, "tokamak");
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
        super::super::LoginStage::Paste { confirm_open: true }
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

/// Declining does not abandon the sign-in: the poll is already running, so
/// the dock moves on to waiting and a phone can still approve it.
#[tokio::test]
async fn declining_the_browser_still_waits_for_approval() {
    let mut app = test_app();
    super::super::show_login_approval(&mut app, &test_session());
    press(&mut app, KeyCode::Char('n'), KeyModifiers::NONE).await;

    let prompt = app.login.as_ref().expect("dock stays open");
    assert!(
        prompt.stage.unconfirmed_url().is_none(),
        "question answered"
    );
    assert!(matches!(
        prompt.stage,
        super::super::LoginStage::Approving {
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
            super::super::open_login_prompt(&mut app, "tokamak");
        } else {
            super::super::show_login_approval(&mut app, &test_session());
        }
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE).await;
        assert!(app.login.is_none(), "Esc must close the dock");
    }
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

/// Esc during a browser approval closes the dock, which is what makes
/// `chat_loop` drop the in-flight poll.
#[tokio::test]
async fn esc_cancels_a_browser_approval() {
    let mut app = test_app();
    run_command(&mut app, "login", &no_mcp()).await;
    press(&mut app, KeyCode::Esc, KeyModifiers::NONE).await;
    assert!(app.login.is_none(), "Esc must close the dock");
}

#[tokio::test]
async fn settings_picker_x_unsets_selected_key() {
    let mut app = test_app();
    std::fs::create_dir_all(&app.agent_dir).unwrap();
    let toml_path = app.agent_dir.join("agent.toml");
    std::fs::write(&toml_path, "[agent]\ncontext_window = 64000\n").unwrap();

    super::super::settings_command(&mut app, "");
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
fn settings_prompt_enter_writes_and_closes() {
    let mut app = test_app();
    std::fs::create_dir_all(&app.agent_dir).unwrap();
    let toml_path = app.agent_dir.join("agent.toml");
    std::fs::write(&toml_path, "[agent]\n").unwrap();

    let def = AGENT_SETTINGS
        .iter()
        .find(|d| d.key == "max_parallel_subagents")
        .unwrap();
    app.settings_prompt = Some(super::super::SettingsPrompt::new(def, None));
    super::super::handle_settings_key(&mut app, key(KeyCode::Char('3')), false);
    super::super::handle_settings_key(&mut app, key(KeyCode::Enter), false);
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
    app.settings_prompt = Some(super::super::SettingsPrompt::new(def, None));
    for ch in "PROMPT.md".chars() {
        super::super::handle_settings_key(&mut app, key(KeyCode::Char(ch)), false);
    }
    super::super::handle_settings_key(&mut app, key(KeyCode::Enter), false);

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
        app.settings_prompt = Some(super::super::SettingsPrompt::new(def, None));
        super::super::handle_settings_key(&mut app, key(KeyCode::Char('~')), false);
        super::super::handle_settings_key(&mut app, key(KeyCode::Enter), false);

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
        assert_eq!(super::super::wave_glyph().as_deref(), Some("~"), "applied live");
        let note = transcript_text(&app);
        assert!(note.contains("wave = ~ written"), "{note}");
        assert!(
            note.contains("in effect now"),
            "no restart is needed: {note}"
        );

        // Clearing the field writes the off value, live. It does *not*
        // remove the key: absent means the default 👋 comes back, which is
        // the opposite of what someone clearing the glyph asked for.
        app.settings_prompt = Some(super::super::SettingsPrompt::new(def, Some("~")));
        super::super::handle_settings_key(&mut app, key(KeyCode::Backspace), false);
        super::super::handle_settings_key(&mut app, key(KeyCode::Enter), false);
        assert_eq!(super::super::wave_glyph(), None, "off applied live");
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
        super::super::set_wave_glyph(None);
        assert_eq!(
            crate::core::agent::global_config::global_value("wave"),
            None,
            "key removed from the file"
        );
        assert_eq!(
            super::super::wave_glyph().as_deref(),
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

        super::super::settings_command(&mut app, "");
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
    app.settings_prompt = Some(super::super::SettingsPrompt::new(def, Some("7")));
    super::super::handle_settings_key(&mut app, key(KeyCode::Char('9')), false);
    super::super::handle_settings_key(&mut app, key(KeyCode::Esc), false);
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
    app.settings_prompt = Some(super::super::SettingsPrompt::new(def, None));

    for ch in "👁️👄👁️".chars() {
        super::super::handle_settings_key(&mut app, key(KeyCode::Char(ch)), false);
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
    super::super::handle_settings_key(&mut app, key(KeyCode::Char('x')), false);
    assert_eq!(input(&app), "👁️👄👁️", "a fourth cluster is refused");

    // Backspace removes a whole cluster: popping one `char` off `👁️` would
    // leave `👁`, which looks like nothing happened.
    super::super::handle_settings_key(&mut app, key(KeyCode::Backspace), false);
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
        let mut prompt = super::super::SettingsPrompt::new(def, None);
        // Set directly: the key handler caps typing, so an over-long value
        // can only arrive from a paste or a hand-edited file.
        prompt.input = "abcd".to_string();
        app.settings_prompt = Some(prompt);

        super::super::handle_settings_key(&mut app, key(KeyCode::Enter), false);
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
    app.settings_prompt = Some(super::super::SettingsPrompt::new(def, Some("8")));
    super::super::handle_settings_key(&mut app, key(KeyCode::Backspace), false);
    super::super::handle_settings_key(&mut app, key(KeyCode::Enter), false);
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
    app.settings_prompt = Some(super::super::SettingsPrompt::new(def, None));
    super::super::handle_settings_key(&mut app, key(KeyCode::Char('0')), false);
    super::super::handle_settings_key(&mut app, key(KeyCode::Enter), false);
    assert!(app.settings_prompt.is_some(), "dock stays open on error");
    let err = app
        .settings_prompt
        .as_ref()
        .and_then(|p| p.error.clone())
        .expect("error recorded");
    assert!(err.contains("at least 1"), "{err}");
    assert_eq!(std::fs::read_to_string(&toml_path).unwrap(), "[agent]\n");

    app.settings_prompt = Some(super::super::SettingsPrompt::new(def, None));
    super::super::handle_settings_key(&mut app, key(KeyCode::Char('x')), false);
    super::super::handle_settings_key(&mut app, key(KeyCode::Enter), false);
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
        super::super::handle_mcp_prompt_key(&mut app, key(KeyCode::Char('x')), false, &servers).await;
        super::super::handle_mcp_prompt_key(&mut app, key(KeyCode::Backspace), false, &servers).await;
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
        super::super::handle_mcp_prompt_key(&mut app, key(KeyCode::Down), false, &servers).await;
        super::super::handle_mcp_prompt_key(&mut app, key(KeyCode::Down), false, &servers).await;
        assert_eq!(app.mcp_prompt.as_ref().unwrap().field, McpField::Url);
        for ch in "https://jk.example/".chars() {
            super::super::handle_mcp_prompt_key(&mut app, key(KeyCode::Char(ch)), false, &servers)
                .await;
        }
    });

    let prompt = app.mcp_prompt.as_ref().expect("still open");
    assert_eq!(prompt.field, McpField::Url, "typing k must not move up");
    assert_eq!(prompt.url, "https://jk.example/");
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
    app.settings_prompt = Some(super::super::SettingsPrompt::new(def, None));
    for ch in "deny".chars() {
        super::super::handle_settings_key(&mut app, key(KeyCode::Char(ch)), false);
    }
    super::super::handle_settings_key(&mut app, key(KeyCode::Enter), false);
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
    app.settings_prompt = Some(super::super::SettingsPrompt::new(def, None));
    for ch in "aggressive".chars() {
        super::super::handle_settings_key(&mut app, key(KeyCode::Char(ch)), false);
    }
    super::super::handle_settings_key(&mut app, key(KeyCode::Enter), false);
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
fn provider_prompt_left_right_toggles_api_type_field() {
    let mut app = test_app();
    let mut p = super::super::ProviderPrompt::new();
    p.field = ProviderField::ApiType;
    app.provider_prompt = Some(p);
    super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Right), false);
    assert_eq!(
        app.provider_prompt.as_ref().unwrap().api_type_label(),
        "anthropic-compatible",
        "Right on the api type field selects anthropic"
    );
}

#[test]
fn provider_prompt_save_and_cancel_via_keys() {
    crate::core::agent::global_config::with_temp_home(|_| {
        let mut app = test_app();
        app.provider_prompt = Some(super::super::ProviderPrompt::new());

        // Type name, advance, type base url, advance to models (skip key).
        for ch in "myprovider".chars() {
            super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Char(ch)), false);
        }
        super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
        for ch in "https://my.example/v1".chars() {
            super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Char(ch)), false);
        }
        // Advance past the api-type and API-key fields to models.
        super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
        super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
        super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
        for ch in "model-a".chars() {
            super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Char(ch)), false);
        }
        super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Enter), false);

        // Enter closed the dock and wrote the global config.
        assert!(app.provider_prompt.is_none());
        let configs = crate::core::agent::global_config::load_global_config().unwrap();
        let cfg = configs.get("myprovider").expect("provider written");
        assert_eq!(cfg.base_url.as_deref(), Some("https://my.example/v1"));
        assert_eq!(cfg.models, vec!["model-a"]);
        assert!(transcript_text(&app).contains("added provider 'myprovider'"));

        // Cancel leaves the store untouched.
        app.provider_prompt = Some(super::super::ProviderPrompt::new());
        super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Esc), false);
        assert!(app.provider_prompt.is_none());
    });
}

/// `k`/`j` are ordinary characters in text fields (API keys start with
/// `sk-...`), so they must be typed, not steered with vim-style keys.
#[test]
fn provider_prompt_types_k_and_j_into_fields() {
    let mut app = test_app();
    app.provider_prompt = Some(super::super::ProviderPrompt::new());

    // Type a name containing both letters, then an API key shaped like a
    // real secret. Neither may move the active field.
    for ch in "kitty-jet".chars() {
        super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Char(ch)), false);
    }
    super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
    super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
    super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
    assert_eq!(
        app.provider_prompt.as_ref().unwrap().field,
        ProviderField::ApiKey
    );
    for ch in "sk-ant-k3y-j".chars() {
        super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Char(ch)), false);
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
        app.provider_prompt = Some(super::super::ProviderPrompt::from_entry(&entry));

        // Add a model so the save `models` value changes, proving the save
        // ran; the key field is never touched.
        app.provider_prompt.as_mut().unwrap().models = "m1 m2".to_string();
        super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Enter), false);

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
            Some(super::super::ProviderPrompt::from_entry(&entry))
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
            super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Char(ch)), false);
        }
        super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Enter), false);
        assert!(app.provider_prompt.is_none());
        assert_eq!(
            stored_key().as_deref(),
            Some("sk-new-key"),
            "typed key replaces"
        );

        // Empty the key field: the stored key is cleared.
        app.provider_prompt = fresh();
        app.provider_prompt.as_mut().unwrap().field = ProviderField::ApiKey;
        super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Backspace), false);
        super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Enter), false);
        assert!(app.provider_prompt.is_none());
        assert_eq!(stored_key(), None, "emptied key clears the stored one");
    });
}

/// A bracketed paste while the provider wizard is open must land in the
/// active field, not the chat composer (where a pasted API key would echo).
#[test]
fn provider_prompt_paste_routes_to_active_field() {
    let mut app = test_app();
    app.provider_prompt = Some(super::super::ProviderPrompt::new());

    // Paste into the name field; outer whitespace is trimmed.
    route_paste_event(&mut app, Event::Paste(" my-provider ".into()));
    assert_eq!(
        app.provider_prompt.as_ref().unwrap().name,
        "my-provider",
        "outer whitespace is trimmed"
    );

    // Advance to the API key field and paste a key shaped like a real one.
    super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
    super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
    super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Down), false);
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
        super::super::open_provider_settings(&mut app);
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
        super::super::open_provider_settings(&mut app);
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
        super::super::open_provider_settings(&mut app);
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
        super::super::open_provider_settings(&mut app);
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
        super::super::open_login_picker(&mut app);
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
        super::super::open_provider_settings(&mut app);
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
            super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Char(ch)), false);
        }
        assert_eq!(
            app.provider_prompt.as_ref().unwrap().name,
            "myprovider",
            "name is read-only while editing"
        );

        // Back to an editable field; change base_url and save.
        app.provider_prompt.as_mut().unwrap().field = ProviderField::BaseUrl;
        super::super::handle_provider_prompt_key(&mut app, key(KeyCode::Backspace), false);
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
    let out = super::super::coalesce_burst(events);
    assert_eq!(out.len(), 1, "{out:?}");
    assert!(matches!(&out[0], Event::Paste(t) if t == "fn a() {\n}"), "{out:?}");
}

#[test]
fn quick_typing_and_submit_is_not_a_paste() {
    let events: Vec<Event> = "ok".chars().map(|c| bkey(KeyCode::Char(c))).chain([bkey(KeyCode::Enter)]).collect();
    let out = super::super::coalesce_burst(events.clone());
    assert_eq!(out, events, "two characters then Enter still submit");
}

#[test]
fn chords_split_a_burst_and_pass_through() {
    let ctrl_c = Event::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
    let mut events: Vec<Event> = "abcdefghij".chars().map(|c| bkey(KeyCode::Char(c))).collect();
    events.push(ctrl_c.clone());
    events.push(bkey(KeyCode::Char('x')));
    let out = super::super::coalesce_burst(events);
    assert_eq!(out.len(), 3, "{out:?}");
    assert!(matches!(&out[0], Event::Paste(t) if t == "abcdefghij"));
    assert_eq!(out[1], ctrl_c);
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
async fn model_picker_enter_uses_raw_value_while_label_is_provider_scoped() {
    let mut app = test_app();
    app.model_picker = super::super::ModelPicker::from_pairs(
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
            super::super::open_mcp_detail(&mut app, "remote", &servers).await;
            app.mcp_auth = Some(super::super::McpAuthFlow {
                server: "remote".to_string(),
                stage: super::super::McpAuthStage::Discovering,
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
            super::super::open_mcp_picker(&mut app, &servers).await;
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
            super::super::open_mcp_picker(&mut app, &servers).await;
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
            super::super::open_mcp_detail(&mut app, "files", &servers).await;
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

#[test]
fn readline_keys_map_to_their_edit_actions() {
    use super::super::{readline_action, EditAction};
    use ratatui::crossterm::event::KeyCode;
    // (code, ctrl, alt, sup) -> action
    let cases = [
        (KeyCode::Char('a'), true, false, false, Some(EditAction::CursorLineStart)),
        (KeyCode::Char('e'), true, false, false, Some(EditAction::CursorLineEnd)),
        (KeyCode::Char('w'), true, false, false, Some(EditAction::DeleteUnixWordLeft)),
        (KeyCode::Char('p'), true, false, false, Some(EditAction::RecallPrev)),
        (KeyCode::Char('n'), true, false, false, Some(EditAction::RecallNext)),
        (KeyCode::Char('b'), false, true, false, Some(EditAction::CursorWordLeft)),
        (KeyCode::Char('d'), false, true, false, Some(EditAction::DeleteWordRight)),
        // Ctrl wins over Alt for the same letter, as the arms were ordered.
        (KeyCode::Char('b'), true, true, false, Some(EditAction::CursorLeft)),
        (KeyCode::Backspace, false, false, true, Some(EditAction::DeleteToLineStart)),
        (KeyCode::Backspace, true, false, false, Some(EditAction::DeleteWordLeft)),
        (KeyCode::Backspace, false, false, false, Some(EditAction::Backspace)),
        (KeyCode::Delete, false, true, false, Some(EditAction::DeleteWordRight)),
        (KeyCode::Left, false, false, true, Some(EditAction::CursorLineStart)),
        (KeyCode::Right, true, false, false, Some(EditAction::CursorWordRight)),
        (KeyCode::Home, false, false, false, Some(EditAction::CursorLineStart)),
        (KeyCode::End, false, false, false, Some(EditAction::CursorLineEnd)),
        // Plain text, session keys and scroll keys are not editing actions.
        (KeyCode::Char('a'), false, false, false, None),
        (KeyCode::Char('j'), true, false, false, None),
        (KeyCode::Enter, false, false, false, None),
        (KeyCode::Up, false, false, false, None),
        (KeyCode::Tab, false, false, false, None),
    ];
    for (code, ctrl, alt, sup, want) in cases {
        assert_eq!(readline_action(code, ctrl, alt, sup), want, "{code:?} ctrl={ctrl} alt={alt} sup={sup}");
    }
}
