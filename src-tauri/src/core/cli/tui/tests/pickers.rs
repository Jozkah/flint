//! Moved verbatim out of `tui/tests.rs`.

use super::*;

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
    std::sync::Arc::make_mut(&mut app.history)
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
        super::super::open_login_picker(&mut app);

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
        super::super::open_provider_settings(&mut app);
        let picker = app.picker.as_ref().expect("picker opened");
        assert_eq!(picker.kind, PickerKind::ProviderSettings);
        assert_eq!(picker.items.len(), 1);
        assert_eq!(picker.items[0].value, "myprovider");
        assert!(picker.items[0].label.contains("key set"));
        assert!(picker.items[0].label.contains("1 model(s)"));
    });
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

#[test]
fn model_picker_pins_tokamak_scope_and_models_first() {
    let picker = super::super::ModelPicker::from_pairs(
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
    let picker = super::super::ModelPicker::from_pairs(
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
    let mut picker = super::super::ModelPicker::from_pairs(
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
    app.model_picker = super::super::ModelPicker::from_pairs(
        vec![("openai".into(), "gpt-5-codex".into())],
        "missing-current",
    );
    route_paste_event(&mut app, Event::Paste("codex".into()));
    assert!(app.input.is_empty(), "paste leaked past the model picker");
    assert_eq!(app.model_picker.as_ref().unwrap().query, "codex");

    let mut app = test_app();
    app.picker = Some(super::super::Picker {
        kind: PickerKind::AgentSettings,
        items: Vec::new(),
        selected: 0,
        armed_delete: None,
    });
    route_paste_event(&mut app, Event::Paste("must not become chat".into()));
    assert!(app.input.is_empty(), "paste leaked past the list picker");
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
        rt.block_on(super::super::open_model_picker(&mut app));
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

        rt.block_on(super::super::open_model_picker(&mut app));
        let picker = app.model_picker.as_ref().unwrap();
        assert!(picker
            .all_items
            .iter()
            .any(|item| item.value == "tokamak-new"));
        assert!(app.picker.is_none());
    });
}

/// The regression this whole screen exists for: a fresh install used to get
/// a note and no screen, so `a` (add) -- the only thing that could fix the
/// empty state -- was unreachable.
#[test]
fn the_mcp_screen_opens_on_a_watermark_row_when_nothing_is_configured() {
    crate::core::app::commands::with_temp_data_folder(|_| {
        let mut app = test_app();
        rt().block_on(super::super::open_mcp_picker(&mut app, &no_mcp()));

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
        rt().block_on(super::super::open_mcp_picker(&mut app, &no_mcp()));

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
        rt().block_on(super::super::open_mcp_picker(&mut app, &no_mcp()));
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
        rt().block_on(super::super::open_mcp_detail(&mut app, "remote", &no_mcp()));

        assert_eq!(app.picker.as_ref().unwrap().kind, PickerKind::McpServer);
        let detail = app.mcp_detail.as_ref().expect("detail is held on App");
        let text: String = super::super::mcp_detail_lines(detail, None, "⠋", 120)
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
        rt().block_on(super::super::open_mcp_detail(&mut app, "remote", &no_mcp()));
        assert!(app.picker.is_some(), "the /mcp detail screen is a picker");
        app.browser_confirm = Some(super::super::BrowserConfirm {
            url: "https://provider/oauth?code_challenge=abc".to_string(),
            purpose: "authorize 'remote'".to_string(),
        });
        let screen = render_rows(&mut app, 100, 24).join("\n");
        assert!(screen.contains("open a browser?"), "{screen}");
        assert!(screen.contains("Enter open"), "{screen}");
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
        rt().block_on(super::super::open_mcp_detail(&mut app, "files", &no_mcp()));

        let values: Vec<&str> = app
            .picker
            .as_ref()
            .unwrap()
            .items
            .iter()
            .map(|i| i.value.as_str())
            .collect();
        assert!(!values.contains(&super::super::MCP_ACTION_AUTH), "{values:?}");
        assert!(
            !values.contains(&super::super::MCP_ACTION_CLEAR_AUTH),
            "{values:?}"
        );
        // Not connected, so there is nothing to list.
        assert!(!values.contains(&super::super::MCP_ACTION_TOOLS), "{values:?}");
        assert!(values.contains(&super::super::MCP_ACTION_TOGGLE), "{values:?}");
        assert!(values.contains(&super::super::MCP_ACTION_EDIT), "{values:?}");
        assert!(values.contains(&super::super::MCP_ACTION_REMOVE), "{values:?}");
        // An active server can be reconnected; the label reads Disable.
        assert!(values.contains(&super::super::MCP_ACTION_RECONNECT), "{values:?}");
        let toggle = app
            .picker
            .as_ref()
            .unwrap()
            .items
            .iter()
            .find(|i| i.value == super::super::MCP_ACTION_TOGGLE)
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
        rt().block_on(super::super::open_mcp_detail(&mut app, "remote", &no_mcp()));

        let items = &app.picker.as_ref().unwrap().items;
        let auth = items
            .iter()
            .find(|i| i.value == super::super::MCP_ACTION_AUTH)
            .expect("an unauthenticated remote can sign in");
        assert_eq!(auth.label, "Authenticate");
        assert!(!items
            .iter()
            .any(|i| i.value == super::super::MCP_ACTION_CLEAR_AUTH));
        // Inactive, so Reconnect is not offered and the toggle reads Enable.
        assert!(!items.iter().any(|i| i.value == super::super::MCP_ACTION_RECONNECT));
        assert_eq!(
            items
                .iter()
                .find(|i| i.value == super::super::MCP_ACTION_TOGGLE)
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
        rt().block_on(super::super::open_mcp_detail(&mut app, "remote", &no_mcp()));
        let items = &app.picker.as_ref().unwrap().items;
        assert!(!items.iter().any(|i| i.value == super::super::MCP_ACTION_AUTH));
        assert!(!items
            .iter()
            .any(|i| i.value == super::super::MCP_ACTION_CLEAR_AUTH));
    });
}
