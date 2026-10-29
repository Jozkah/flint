//! Moved verbatim out of `tui/tests.rs`.

use super::*;

/// #133: a value above i64::MAX used to be cast with `as i64`, wrapping
/// negative into agent.toml and bricking the next startup.
#[test]
fn int_setting_refuses_values_that_do_not_fit_a_toml_integer() {
    use super::super::parse_int_setting;
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
    let bg = super::super::user_bubble_bg();
    let fg = super::super::user_bubble_fg();
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
            super::super::row_width(line) <= 60,
            "bubble padding must not overflow the frame: {line:?}"
        );
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
    app.login = Some(super::super::LoginPrompt {
        provider: "tokamak".to_string(),
        input: String::new(),
        error: Some(error.to_string()),
        ..super::super::LoginPrompt::new("tokamak")
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
    app.mcp_prompt = Some(super::super::McpPrompt {
        editing: None,
        field: super::super::McpField::Command,
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

/// A `PendingAsk` built from a `timeout_secs: Some(n)` event carries a
/// deadline roughly `n` seconds out, and one with `None` carries none.
#[test]
fn pending_ask_deadline_tracks_configured_timeout() {
    let req = ask_request(false, false);
    let none = super::super::PendingAsk::new("r1".into(), req.clone(), None);
    assert_eq!(none.deadline, None, "no timeout should mean no deadline");

    let short = super::super::PendingAsk::new(
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
        super::super::PendingAsk::new("r1".into(), req, Some(std::time::Duration::from_secs(30)));
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
    app.ask_queue.push_back(super::super::PendingAsk::new(
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
    app.ask_queue.push_back(super::super::PendingAsk::new(
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
            let mut scan = super::super::ThinkScan::default();
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
    let lines = super::super::live_assistant_lines(&format!("<think>{body}"), &[], 60, true, true);
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
            super::super::live_assistant_lines(&format!("<think>{body}"), &[], width, true, true);
        let rows = lines.len() as u16;
        assert_eq!(
            rows,
            super::super::wrapped_height(lines.clone(), width),
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
    let lines = super::super::live_assistant_lines(
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

/// Only a bounded tail is rendered, so a chatty command cannot push the
/// conversation off the screen.
#[test]
fn the_live_panel_renders_only_a_bounded_tail() {
    let many: String = (0..60).map(|i| format!("line {i}\n")).collect();
    // prompt + skip-notice + bounded tail + status row + two borders.
    let rows = super::super::running_terminal_lines("make", &many, 0, 0, 70);
    assert!(
        rows.len() <= super::super::LIVE_OUTPUT_TAIL_LINES + 5,
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
    let before = super::super::super::file_log::set_stderr_enabled(true);
    super::super::super::file_log::set_stderr_enabled(false);
    drop(TerminalGuard {
        prev_stderr: true,
        raw: false,
    });
    assert!(
        super::super::super::file_log::set_stderr_enabled(before),
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

/// Nothing may reach a browser until the user says so -- in either flow.
#[tokio::test]
async fn the_browser_is_never_opened_without_an_answer() {
    // Paste fallback.
    let mut app = test_app();
    super::super::open_login_prompt(&mut app, "tokamak");
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
    super::super::show_login_approval(&mut app, &test_session());
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
        super::super::finish_mcp_job(
            &mut app,
            super::super::McpJobDone::Authorized {
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

/// A keystroke that is neither an answer nor a cancel is swallowed, so it
/// cannot leak into the key field or the chat input.
#[tokio::test]
async fn stray_keys_at_the_browser_question_do_nothing() {
    let mut app = test_app();
    super::super::open_login_prompt(&mut app, "tokamak");
    type_key_chars(&mut app, "tk-secret").await;

    let prompt = app.login.as_ref().expect("dock stays open");
    assert!(prompt.stage.unconfirmed_url().is_some(), "still unanswered");
    assert!(prompt.input.is_empty(), "no key may be collected yet");
    assert!(app.input.is_empty(), "and nothing may reach the chat input");
}

/// Every dock that takes the keyboard in `handle_key` must also blank the
/// input row: a live cursor under a dock that swallows every keystroke
/// promises a field that is not there. One case per guard in that list, so
/// the next dock added cannot quietly regress only the rendering half.
#[test]
fn every_blocking_dock_marks_the_input_row_inactive() {
    let setups: [DockSetup; 6] = [
        ("login/connecting", |app| {
            app.login = Some(super::super::LoginPrompt::connecting())
        }),
        ("login/paste", |app| {
            app.login = Some(confirmed_paste_prompt())
        }),
        ("browser_confirm", |app| {
            app.browser_confirm = Some(super::super::BrowserConfirm {
                url: "https://example.com/authorize".into(),
                purpose: "authorize 'github'".into(),
            })
        }),
        ("settings_prompt", |app| {
            let def = AGENT_SETTINGS
                .iter()
                .find(|d| d.key == "max_parallel_subagents")
                .unwrap();
            app.settings_prompt = Some(super::super::SettingsPrompt::new(def, None));
        }),
        ("mcp_prompt", |app| {
            app.mcp_prompt = Some(blank_mcp_prompt())
        }),
        ("provider_prompt", |app| {
            app.provider_prompt = Some(super::super::ProviderPrompt::new())
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
    super::super::show_login_approval(
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
    assert!(matches!(prompt.stage, super::super::LoginStage::Approving { .. }));
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

/// A denied or expired approval has no field to correct, so the dock closes
/// with the reason rather than sitting there uneditable.
#[tokio::test]
async fn a_failed_approval_closes_the_dock_with_the_reason() {
    let mut app = test_app();
    super::super::show_login_approval(
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
    let message = super::super::login_error_message(
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
    let message = super::super::login_error_message(
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
        let args = std::sync::Arc::new(super::super::OrchestrationArgs {
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
        rt.block_on(super::super::reload_provider_configs(&mut app));

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
fn pairs_to_str_roundtrips() {
    let map = crate::core::cli::mcp::parse_pairs("A=1,B=2", "env").unwrap();
    assert_eq!(pairs_to_str(Some(&map)), "A=1,B=2");
    assert_eq!(pairs_to_str(None), "");
}

#[test]
fn provider_prompt_field_navigation_wraps() {
    let mut p = super::super::ProviderPrompt::new();
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
        let mut p = super::super::ProviderPrompt::new();
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
        let mut p = super::super::ProviderPrompt::new();
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
        let mut p = super::super::ProviderPrompt::new();
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
    let mut p = super::super::ProviderPrompt::new();
    assert_eq!(p.api_type_label(), "openai-compatible");
    p.toggle_api_type();
    assert_eq!(p.api_type_label(), "anthropic-compatible");
    p.toggle_api_type();
    assert_eq!(p.api_type_label(), "openai-compatible");
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
        let prompt = super::super::ProviderPrompt::from_entry(&entry);
        assert_eq!(prompt.api_type.as_deref(), Some("anthropic"));
        assert_eq!(
            prompt.api_type_label(),
            "anthropic-compatible",
            "editing an anthropic provider keeps its wire type"
        );
    });
}

/// The masked key placeholder must not pretend a stored key is present: an
/// untouched edit shows `(unchanged)`, whereas typing a replacement shows
/// mask characters.
#[test]
fn provider_edit_masked_key_renders_unchanged_until_touched() {
    let mut p = super::super::ProviderPrompt {
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
    app.settings_prompt = Some(super::super::SettingsPrompt::new(def, None));

    route_paste_event(&mut app, Event::Paste(" 4 ".into()));
    assert_eq!(app.settings_prompt.as_ref().unwrap().input, "4");
    assert!(app.input.is_empty(), "paste leaked into chat composer");
}

/// Editing navigation skips the read-only name field: from BaseUrl it
/// cycles BaseUrl -> ApiKey -> Models -> BaseUrl.
#[test]
fn provider_edit_navigation_skips_name() {
    let mut p = super::super::ProviderPrompt {
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
        let mut p = super::super::ProviderPrompt::new();
        p.name = "p".to_string();
        p.base_url = "http://remote.example/v1".to_string();
        assert!(p.save().is_err(), "plaintext remote rejected");
        p.base_url = "http://127.0.0.1:8080/v1".to_string();
        assert!(p.save().is_ok(), "loopback http allowed");
        p.base_url = "https://remote.example/v1".to_string();
        assert!(p.save().is_ok(), "https allowed");
    });
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
    use super::super::{diff_bg, DIFF_ADD_BG, DIFF_ADD_BG_LIGHT, DIFF_DEL_BG, DIFF_DEL_BG_LIGHT};
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
    use super::super::{
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
fn summarize_result_first_line_plus_count() {
    assert_eq!(summarize_result("only line", 80), "only line");
    assert_eq!(summarize_result("a\nb\nc", 80), "a  (+2 lines)");
    assert_eq!(summarize_result("  \nreal\nx", 80), "real  (+1 lines)");
    // Collapses internal whitespace runs (e.g. columnar grep output).
    assert_eq!(summarize_result("a    b\tc", 80), "a b c");
    // Truncates the head to max.
    assert_eq!(summarize_result("abcdefgh", 4), "abc…");
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

#[tokio::test]
async fn apply_resume_latest_restores_history_and_model() {
    let mut app = test_app();
    let history = vec![
        json!({ "role": "user", "content": "first" }),
        json!({ "role": "assistant", "content": "reply" }),
    ];
    let id = super::super::super::cli_save_thread(&app.agent_dir, None, "saved-model", &history, None)
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
    let same = super::super::super::cli_save_thread(
        &app.agent_dir,
        Some(&id),
        "saved-model",
        &fresh.history,
        None,
    )
    .unwrap();
    assert_eq!(same, id);
    assert_eq!(
        super::super::super::list_threads_in(&app.agent_dir).unwrap().len(),
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
    super::super::super::cli_save_thread(&app.agent_dir, None, "m", &history, None).unwrap();
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
    super::super::super::cli_save_thread(&app.agent_dir, None, "saved-model", &history, None).unwrap();

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
        joined.contains(super::super::super::NO_SESSION_TO_RESUME),
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
    super::super::sort_threads_recent(&mut threads);
    let ids: Vec<&str> = threads.iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["b", "c", "a", "d"]);
}

#[test]
fn thread_display_name_prefers_title() {
    let base = std::path::Path::new("/nonexistent");
    assert_eq!(
        super::super::thread_display_name(base, "id", Some("My Title")),
        "My Title"
    );
    assert_eq!(
        super::super::thread_display_name(base, "id", Some("  padded  ")),
        "padded"
    );
}

#[test]
fn truncate_is_char_safe() {
    assert_eq!(super::super::truncate("héllo wörld", 5), "héll…");
    assert_eq!(super::super::truncate("short", 20), "short");
}

/// F2x1-008: the `/settings` box shows a global row's value from the global
/// config, never a same-named key that happens to sit in the project's
/// `agent.toml`.
#[test]
fn settings_prompt_shows_a_global_rows_value_from_its_own_scope() {
    use crate::core::cli::tui::commands::SettingsPrompt;
    use crate::core::cli::tui::render::settings_prompt_lines;
    let dir = tempfile::tempdir().unwrap();
    let toml_path = dir.path().join("agent.toml");
    std::fs::write(&toml_path, "[agent]\nask_timeout_secs = 987654\n").unwrap();
    let prompt = SettingsPrompt { key: "ask_timeout_secs", input: String::new(), error: None };
    let text: String = settings_prompt_lines(&prompt, &toml_path, 200)
        .iter()
        .flat_map(|l| l.spans.iter().map(|s| s.content.to_string()))
        .collect();
    assert!(!text.contains("987654"), "project value shown for a global row: {text}");
}

/// P2C-014: truncation, clipping and panel padding are measured in terminal
/// cells, so a CJK or emoji row keeps the panel's right border aligned.
#[test]
fn panels_measure_wide_glyphs_in_cells() {
    use crate::core::cli::tui::render::{boxed_panel, clip_spans};
    use ratatui::text::{Line, Span};
    use unicode_width::UnicodeWidthStr;
    // 日本語 is six cells: five cells leave room for 日本 plus the ellipsis,
    // four for 日 plus the ellipsis (本 would straddle the limit).
    assert_eq!(super::super::truncate("日本語", 5), "日本…");
    assert_eq!(super::super::truncate("日本語", 4), "日…");
    assert_eq!(super::super::truncate("日本語", 6), "日本語");
    let clipped = clip_spans(vec![Span::raw("ab日本")], 5);
    assert_eq!(clipped.iter().map(|s| s.content.width()).sum::<usize>(), 4, "the half-fitting 本 is dropped");
    let rows = vec![Line::from("日本語"), Line::from("🙂 emoji"), Line::from("ascii")];
    let widths: std::collections::HashSet<usize> = boxed_panel(rows, 40, "  ")
        .iter()
        .map(|l| l.spans.iter().map(|s| s.content.width()).sum())
        .collect();
    assert_eq!(widths.len(), 1, "right border misaligned: {widths:?}");
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
    assert_eq!(super::super::strip_sgr_mouse_reports("<0;10;20m"), "");
    assert_eq!(super::super::strip_sgr_mouse_reports("\x1b[<65;50;42M"), "");
    assert_eq!(super::super::strip_sgr_mouse_reports("\u{9b}<32;8;12M"), "");
    assert_eq!(super::super::strip_sgr_mouse_reports("[<65;59;29M"), "");
    assert_eq!(super::super::strip_sgr_mouse_reports("<64;1;1M"), "");
    assert_eq!(
        super::super::strip_sgr_mouse_reports("hello<65;50;42Mworld"),
        "helloworld"
    );
    assert_eq!(super::super::strip_sgr_mouse_reports("<65;50;42M<65;59;29M"), "");
    assert_eq!(
        super::super::strip_sgr_mouse_reports("xin chào Nguyễn"),
        "xin chào Nguyễn"
    );
    assert_eq!(
        super::super::strip_sgr_mouse_reports("version 1.2.3"),
        "version 1.2.3"
    );
    // Incomplete payload without the M/m terminator is not a report.
    assert_eq!(super::super::strip_sgr_mouse_reports("65;50;42"), "65;50;42");
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
        assert_eq!(super::super::strip_sgr_mouse_reports(text), text);
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
    let seq = super::super::panic_restore_sequence();
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
    *super::super::TERMINAL_OWNER.lock().unwrap() = None;
    assert!(!super::super::release_terminal(), "nobody owns it yet");
    *super::super::TERMINAL_OWNER.lock().unwrap() = Some(std::thread::current().id());
    let other = std::thread::spawn(super::super::release_terminal).join().unwrap();
    assert!(!other, "a job thread's panic must leave the TUI alone");
    assert!(super::super::release_terminal(), "the owner restores");
    assert!(!super::super::release_terminal(), "and only once");
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
    use super::super::super::terminal_setup::Kind;
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
    let b = word_at(super::super::WORD_ROTATE_FRAMES);
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

#[test]
fn compact_tokens_keeps_a_stable_width() {
    assert_eq!(compact_tokens(0), "0");
    assert_eq!(compact_tokens(840), "840");
    assert_eq!(compact_tokens(1_100), "1.1K");
    assert_eq!(compact_tokens(43_000), "43K");
    assert_eq!(compact_tokens(1_500_000), "1.5M");
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
    for i in 1..=super::super::TODO_KEEP_CLOSED_TURNS {
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
    let mut call = super::super::StartingCall::new("c1".into(), "write".into());
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
    let mut call = super::super::StartingCall::new("c1".into(), "write".into());
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
    let mut call = super::super::StartingCall::new("c1".into(), "write".into());
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
    let mut call = super::super::StartingCall::new("c1".into(), "bash".into());
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
    let mut call = super::super::StartingCall::new("c1".into(), "bash".into());
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
    let mut call = super::super::StartingCall::new("c1".into(), "grep".into());
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
    let mut call = super::super::StartingCall::new("c1".into(), "write".into());
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
        xs <= super::super::STREAM_MAX_LINE_CHARS,
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
    let mut call = super::super::StartingCall::new("c1".into(), "write".into());
    let filler = "-".repeat(super::super::STREAM_MAX_LINE_CHARS * 2);
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

/// A path-carrying tool that isn't `write` must be named as itself.
#[test]
fn starting_throbber_names_the_actual_tool() {
    for name in ["read", "edit", "list"] {
        let mut call = super::super::StartingCall::new("c1".into(), name.into());
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
    let lines: Vec<String> = super::super::todo_column(&todos, 60, 8)
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
    let lines: Vec<String> = super::super::todo_column(&todos, 60, 8)
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
    let col = super::super::todo_column(&todos, 60, 8);
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
        let spans = super::super::shimmer_spans("thinking", palette, frame);
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
        crest_at(8 + super::super::SHIMMER_PAUSE),
        Some(0),
        "sweep restarts"
    );
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
    let text = line_text(&super::super::todo_pin(&multi));
    assert!(text.contains("Todos"), "{text}");
    assert!(text.contains("1/2"), "phase position: {text}");
    assert!(
        text.contains("backend 1/2"),
        "active phase progress: {text}"
    );
    assert!(text.contains("/todo"), "editor hint: {text}");

    let single = todos_from(vec![("only", vec![("a", Completed), ("b", Pending)])]);
    let text = line_text(&super::super::todo_pin(&single));
    assert!(
        text.contains("Todos · 1/2"),
        "single phase progress: {text}"
    );
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
    app.todos_closed_at = closed.checked_sub(super::super::TODO_HIDE_AFTER);
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
    let rows = render_rows(&mut app, super::super::PANEL_SPLIT_MIN_WIDTH - 1, 24);
    assert!(
        !rows.iter().any(|r| r.contains("│")),
        "no divider when stacked: {rows:?}"
    );
    let todos = rows.iter().position(|r| r.contains("Todos")).expect("plan");
    let agents = rows.iter().position(|r| r.contains("≡")).expect("agents");
    assert!(todos < agents, "plan first when stacked: {rows:?}");
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
    assert_eq!(super::super::panel_budget(40, 2), super::super::PANEL_MAX_ROWS);
    // Squeezed: only what is left after the fixed rows and the transcript
    // floor, less the row `TRANSCRIPT_BOTTOM_PAD` holds open above the dock,
    // and nothing at all once even that is gone.
    assert_eq!(super::super::panel_budget(12, 2), 2);
    assert_eq!(super::super::panel_budget(9, 2), 0);

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

#[test]
fn slash_bare_lists_all_commands() {
    let mut app = test_app();
    app.input = "/".into();
    // All built-ins plus the always-advertised built-in flint skill.
    assert_eq!(
        names(&app).len(),
        super::super::SLASH_COMMANDS.len() + 1,
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
        super::super::slash_match_score(&q, "/code-simplifier").is_some(),
        "typo within tolerance should match"
    );
    // A distant query still hides.
    let far: Vec<char> = "zzzzzz".chars().collect();
    assert!(super::super::slash_match_score(&far, "/threads").is_none());
    // A short query stays prefix-only (tight), not fuzzy.
    let short: Vec<char> = "re".chars().collect();
    assert!(super::super::slash_match_score(&short, "/threads").is_none());
    assert!(super::super::slash_match_score(&short, "/resume").is_some());
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
    app.status = super::super::Status::Running;
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
        super::super::SlashMatch::PluginCommand { hints, .. } if hints == &vec!["$ARGUMENTS".to_string()]
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
fn dispatch_skill_arms_base_snapshot_before_starting() {
    let (mut app, root) = skill_test_app("deploy", "How to deploy.");
    app.repo_root = Some(root.clone());

    assert!(app.dispatch_skill("deploy", "staging"));
    assert!(app.base_requested);
    assert!(matches!(app.snap_queue.front(), Some(SnapshotJob::Base)));

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
    app.path_hints = vec![super::super::PathHintItem {
        path: "notes/report.md".into(),
        name: "report.md".into(),
        is_dir: false,
    }];
    app.accept_path_hint();
    assert_eq!(app.input, r#"use @"notes/report.md""#);
}

#[test]
fn accept_unterminated_quoted_hint_keeps_text_after_the_cursor() {
    let mut app = test_app();
    app.input = r#"look @"src/fo and more"#.into();
    app.cursor = r#"look @"src/fo"#.len();
    app.path_hints = vec![super::super::PathHintItem {
        path: "src/foo.rs".into(),
        name: "foo.rs".into(),
        is_dir: false,
    }];
    app.accept_path_hint();
    assert_eq!(app.input, r#"look @"src/foo.rs" and more"#);
}

#[test]
fn accept_completion_with_space_quotes() {
    let mut app = test_app();
    app.input = "use @rep".into();
    app.cursor = app.input.len();
    app.path_hints = vec![super::super::PathHintItem {
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
    let item = || vec![super::super::PathHintItem { path: "ab".into(), name: "ab".into(), is_dir: false }];
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
    assert_eq!(super::super::search_path_hints(dir.path(), "a").len(), 1);
    assert!(super::super::search_path_hints(dir.path(), "../").is_empty());
    assert!(super::super::search_path_hints(dir.path(), "x/../a").is_empty());
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
    app.path_hints = vec![super::super::PathHintItem {
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
    app.path_hints = vec![super::super::PathHintItem {
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
        joined.contains(super::super::super::version::build_version()),
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
    let pairs = super::super::BANNER_HINTS;
    let rows = super::super::hint_rows(pairs, 30);
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
        super::super::hint_rows(pairs, 200).len(),
        1,
        "one row when it fits"
    );
}

#[test]
fn severity_colours_the_gutter_and_the_body() {
    let mut app = test_app();

    app.note("saved");
    let info = last_row(&app);
    assert_eq!(info[0].1.fg, Some(Color::LightBlue), "info gutter");
    assert!(info[1].1.add_modifier.contains(Modifier::DIM), "info body");

    app.system(super::super::Level::Warn, "finished early");
    assert_eq!(last_row(&app)[0].1.fg, Some(Color::Yellow));

    app.system(super::super::Level::Error, "denied: rm -rf /");
    let err = last_row(&app);
    assert_eq!(err[0].1.fg, Some(Color::Red));
    assert!(err[1].1.add_modifier.contains(Modifier::BOLD), "{err:?}");

    // A category with its own glyph keeps it, so the column never carries
    // two markers.
    app.system_marked(super::super::GOAL_GLYPH, super::super::Level::Good, "goal achieved");
    let goal = last_row(&app);
    assert_eq!(goal[0].0, "\u{25ce} ");
    assert_eq!(goal[0].1.fg, Some(Color::Green));
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
    super::super::ROW_CLONES.with(|n| n.set(0));
    render_rows(&mut app, 100, 40);
    let cloned = super::super::ROW_CLONES.with(|n| n.get());
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
    super::super::click_region(&mut app, rect.x + 1, bottom);
    assert_eq!(
        app.row_index.get((bottom - rect.y - 1) as usize),
        Some(&Some(last)),
        "the last body row must map to the last transcript row"
    );
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
        rt().block_on(super::super::open_mcp_detail(&mut app, "remote", &no_mcp()));
        let detail = app.mcp_detail.as_ref().expect("detail is held on App");
        let flow = super::super::McpAuthFlow {
            server: "remote".to_string(),
            stage: super::super::McpAuthStage::AwaitingRedirect,
        };
        let text: String = super::super::mcp_detail_lines(detail, Some(&flow), "⠹", 120)
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
            super::super::super::mcp::auth_status(
                "remote",
                &serde_json::json!({ "type": "http", "url": "https://x/mcp" })
            ) != crate::core::mcp::oauth::AuthStatus::Unauthenticated
        );

        let mut app = test_app();
        rt().block_on(super::super::remove_mcp_server(&mut app, "remote", &no_mcp()));

        assert!(super::super::super::mcp::get_server("remote").is_none());
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
        rt().block_on(super::super::open_mcp_detail(&mut app, "files", &no_mcp()));
        // Not connected here, so nothing is requested and the state says why.
        assert!(app.mcp_job_request.is_none());
        assert!(matches!(
            app.mcp_detail.as_ref().unwrap().tools,
            super::super::ToolsState::Unavailable
        ));
    });
}

#[test]
fn a_long_value_is_clamped_instead_of_pushing_the_border_off_the_frame() {
    use ratatui::text::Span;
    let line = Line::from(vec![Span::raw("URL:  "), Span::raw("x".repeat(400))]);
    let clamped = super::super::clamp_line(line, 40);
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
