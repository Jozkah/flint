//! Moved verbatim out of `tui/tests.rs`.

use super::*;

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
async fn help_login_copy_describes_provider_sign_in_without_stale_tokamak_key_copy() {
    let mut app = test_app();

    run_command(&mut app, "help", &no_mcp()).await;

    let text: String = app.transcript.iter().map(row_text).collect();
    assert!(text.contains("/login"), "{text}");
    assert!(text.contains("Sign in to a provider"), "{text}");
    assert!(!text.contains("Sign in to Tokamak"), "{text}");
    assert!(!text.contains("save the API key"), "{text}");
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

#[test]
fn init_starts_a_turn_covering_all_three_artifacts() {
    let mut app = test_app();
    super::super::init_command(&mut app);
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
    app.pending_images.push(super::super::PendingImage {
        name: "shot.png".into(),
        data_url: "data:image/png;base64,AA".into(),
    });
    super::super::init_command(&mut app);
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
    super::super::init_command(&mut app);
    assert!(app.history.is_empty());
    assert!(app.message_queue.is_empty());
    let _ = std::fs::remove_dir_all(&app.agent_dir);
}

#[test]
fn settings_command_bare_opens_picker_and_inline_set_writes_toml() {
    let mut app = test_app();
    // A minimal agent.toml so the picker shows a real current value.
    std::fs::create_dir_all(&app.agent_dir).unwrap();
    let toml_path = app.agent_dir.join("agent.toml");
    std::fs::write(&toml_path, "[agent]\ncontext_window = 64000\n").unwrap();

    super::super::settings_command(&mut app, "max_parallel_subagents 20");
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
    super::super::settings_command(&mut app, "max_parallel_subagents 0");
    let doc = std::fs::read_to_string(&toml_path).unwrap();
    assert!(
        doc.contains("max_parallel_subagents = 20"),
        "rejected write must not clobber: {doc}"
    );
    assert!(transcript_text(&app).contains("must be at least 1"));

    // Bare opens the settings picker with a row per def, hints carrying
    // the on-disk current value (no key prefix; the label is the key).
    super::super::settings_command(&mut app, "");
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

#[test]
fn settings_command_rejects_non_integer_and_unknown_keys() {
    let mut app = test_app();
    std::fs::create_dir_all(&app.agent_dir).unwrap();
    let toml_path = app.agent_dir.join("agent.toml");
    std::fs::write(&toml_path, "[agent]\n").unwrap();

    super::super::settings_command(&mut app, "max_parallel_subagents lots");
    assert!(transcript_text(&app).contains("is not an integer"));
    super::super::settings_command(&mut app, "warp_drive 5");
    assert!(transcript_text(&app).contains("unknown setting"));
    let _ = std::fs::remove_dir_all(&app.agent_dir);
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
        rt.block_on(super::super::run_command(&mut app, "model", &no_mcp()));
        rt.block_on(super::super::run_pending_model_fetch(&mut app));

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
        rt.block_on(super::super::run_command(&mut app, "model", &no_mcp()));
        rt.block_on(super::super::run_pending_model_fetch(&mut app));

        // The picker opened (no reachable pairs => the note path fires,
        // but there is no panic, no hang, and the provider stays put).
        let configs = crate::core::agent::global_config::load_global_config().unwrap();
        assert!(
            configs.contains_key("dead"),
            "provider not removed by a failed probe"
        );

        // Opening once more must not re-contact the dead endpoint: the
        // session short-circuit means the second open is near-instant.
        rt.block_on(super::super::run_command(&mut app, "model", &no_mcp()));
        rt.block_on(super::super::run_pending_model_fetch(&mut app));
    });
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
fn parse_command_splits_name_and_arg() {
    assert_eq!(parse_command("resume abc123"), ("resume", "abc123"));
    assert_eq!(parse_command("help"), ("help", ""));
    assert_eq!(parse_command("  resume   abc  "), ("resume", "abc"));
    assert_eq!(parse_command(""), ("", ""));
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

#[tokio::test]
async fn todo_editor_mutations_update_the_canonical_list() {
    let mut app = test_app();
    // Add through the same `append` op the model uses.
    run_command(&mut app, "todo add Build | ship it", &no_mcp()).await;
    assert_eq!(app.todos.done_total(), (0, 1));
    assert_eq!(app.todos.active().unwrap().1.content, "ship it");
    // Mark it done via the editor helper; the projection reflects it.
    super::super::apply_todo_mutation(&mut app, |l| {
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
        rt.block_on(super::super::reload_command(&mut app, &servers));

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

#[tokio::test]
async fn probe_blocks() {
    let mut app = test_app();
    app.note("conversation cleared");
    run_command(&mut app, "help", &no_mcp()).await;
    for l in render_rows(&mut app, 84, 40) {
        println!("|{}", l.trim_end());
    }
}
