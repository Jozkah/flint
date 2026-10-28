#[test]
fn model_delete_ids_stay_inside_the_models_folder() {
    assert!(super::is_model_dir_name("qwen3-8b"));
    assert!(super::is_model_dir_name("model.v2"));
    for bad in ["..", ".", "", "../x", "a/b", "a\\b", "/etc", "C:\\x", "C:"] {
        assert!(!super::is_model_dir_name(bad), "{bad}");
    }
}

#[test]
fn data_dir_is_pre_parsed_before_the_task_separator() {
    let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter();
    assert_eq!(super::pre_parse_data_dir(args(&["serve", "--data-dir", "D"])).as_deref(), Some("D"));
    assert_eq!(super::pre_parse_data_dir(args(&["stop", "--data-dir=E"])).as_deref(), Some("E"));
    assert_eq!(super::pre_parse_data_dir(args(&["x", "--", "--data-dir", "D"])), None);
}

#[test]
fn api_key_dash_reads_stdin_trimmed() {
    let key = super::resolve_api_key(Some("-".into()), None, || Ok("  sk-from-stdin\n".into()));
    assert_eq!(key, Ok(Some("sk-from-stdin".to_string())));
    assert!(super::resolve_api_key(Some("-".into()), None, || Ok("\n".into())).is_err());
    let inline = super::resolve_api_key(Some("sk-inline".into()), None, || panic!("stdin must not be read"));
    assert_eq!(inline, Ok(Some("sk-inline".to_string())));
    assert_eq!(super::resolve_api_key(None, None, || panic!("no")), Ok(None));
}

#[test]
fn mcp_serve_token_file_conflicts_with_token() {
    assert!(Cli::try_parse_from(["flint", "mcp", "serve", "--token", "a", "--token-file", "f"]).is_err());
    let cli = Cli::parse_from(["flint", "mcp", "serve", "--token-file", "f"]);
    let Some(Commands::Mcp { cmd: McpServeCommands::Serve { token, token_file, .. } }) = cli.command else {
        panic!("expected mcp serve");
    };
    assert!(token.is_none());
    assert_eq!(token_file.as_deref(), Some(std::path::Path::new("f")));
}

#[test]
fn api_key_file_reads_trimmed() {
    let path = std::env::temp_dir().join(format!("flint_key_{}.txt", std::process::id()));
    std::fs::write(&path, "sk-test-123
").unwrap();
    assert_eq!(super::read_api_key_file(&path).as_deref(), Ok("sk-test-123"));
    std::fs::write(&path, "  
").unwrap();
    assert!(super::read_api_key_file(&path).is_err());
    let _ = std::fs::remove_file(&path);
    assert!(super::read_api_key_file(&path).is_err());
}

#[test]
fn pre_parse_data_dir_only_for_serve_and_stop() {
    let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter();
    assert_eq!(super::pre_parse_data_dir(args(&["mcp", "add", "--data-dir", "D"])), None);
    assert_eq!(super::pre_parse_data_dir(args(&["serve", "--data-dir", "--listen"])), None);
    assert_eq!(super::pre_parse_data_dir(args(&["--safe-mode", "serve", "--data-dir", "D"])).as_deref(), Some("D"));
}

/// A closed stdout/stderr pipe is recognised; nothing else is.
#[test]
fn closed_output_panics_are_recognised() {
    assert!(super::is_closed_output_panic(
        "failed printing to stdout: Broken pipe (os error 32)"
    ));
    assert!(super::is_closed_output_panic(
        "failed printing to stdout: The pipe is being closed. (os error 232)"
    ));
    assert!(super::is_closed_output_panic("failed printing to stderr: Broken pipe (os error 32)"));
    assert!(!super::is_closed_output_panic("index out of bounds"));
    assert!(!super::is_closed_output_panic(""));
}

/// Running out of turns while the model is still calling tools is the one
/// failure the shell can read as a limit rather than a crash. The message is
/// the only marker it has, so the classifier must match that message and not
/// some phrase inside a different one.
#[test]
fn turn_limit_exhaustion_has_its_own_exit_code() {
    use tauri_plugin_agent_tools::harness_error::ErrorKind;
    let limit = super::HarnessError::new(
        ErrorKind::BudgetExhausted,
        "reached the 8-turn limit while the model was still calling tools",
    );
    assert_eq!(super::run_exit_code(&limit), 53);
    let tokens = super::HarnessError::new(ErrorKind::BudgetExhausted, "session token budget spent");
    assert_eq!(super::run_exit_code(&tokens), tokens.exit_code());
    let upstream = super::HarnessError::new(ErrorKind::Upstream, "upstream returned 500");
    assert_eq!(super::run_exit_code(&upstream), upstream.exit_code());
}

#[test]
fn usage_subcommands_parse() {
    let view = |argv: &[&str]| {
        let mut full = vec!["flint", "usage"];
        full.extend_from_slice(argv);
        match Cli::parse_from(full).command {
            Some(Commands::Usage { cmd, .. }) => cmd,
            other => panic!("expected a usage command, got {:?}", other.is_some()),
        }
    };
    assert!(matches!(view(&["account"]), Some(UsageCommands::Account)));
    assert!(matches!(view(&["daily"]), Some(UsageCommands::Daily)));
    assert!(matches!(view(&["requests"]), Some(UsageCommands::Requests)));
    assert!(matches!(view(&["limits"]), Some(UsageCommands::Limits)));
    match view(&["generation", "exec-1"]) {
        Some(UsageCommands::Generation { id }) => assert_eq!(id, "exec-1"),
        _ => panic!("expected a generation lookup"),
    }
    match view(&["correlate", "my-app-request-001"]) {
        Some(UsageCommands::Correlate { client_request_id }) => {
            assert_eq!(client_request_id, "my-app-request-001");
        }
        _ => panic!("expected a correlation lookup"),
    }
    assert!(view(&[]).is_none(), "the subcommand is optional");
    assert!(Cli::try_parse_from(["flint", "usage", "generation"]).is_err());
    assert!(Cli::try_parse_from(["flint", "usage", "correlate"]).is_err());
    assert!(matches!(
        Cli::parse_from(["flint", "usage", "account", "--json"]).command,
        Some(Commands::Usage {
            cmd: Some(UsageCommands::Account),
            json: true
        })
    ));
}

/// Parse `flint cli agent run <task> <extra...>` and pull out its budget args.
fn parsed_budget(extra: &[&str]) -> BudgetArgs {
    let mut argv = vec!["flint", "cli", "agent", "run", "task"];
    argv.extend_from_slice(extra);
    match Cli::parse_from(argv).command {
        Some(Commands::Cli {
            cmd:
                CliCommands::Agent {
                    cmd: AgentCommands::Run { budget, .. },
                },
        }) => budget,
        _ => panic!("expected `cli agent run`"),
    }
}

/// An unpassed limit is `None` so the config files (or nothing, for turns)
/// decide; `0` must survive parsing as the engine's unbounded marker.
#[test]
fn run_limits_parse_and_default_to_unset() {
    let none = parsed_budget(&[]);
    assert_eq!(none.max_turns, None);
    assert_eq!(none.max_session_tokens, None);

    let set = parsed_budget(&["--max-turns", "5", "--max-session-tokens", "20000"]);
    assert_eq!(set.max_turns, Some(5));
    assert_eq!(set.max_session_tokens, Some(20_000));

    let zero = parsed_budget(&["--max-turns", "0", "--max-session-tokens", "0"]);
    assert_eq!(zero.max_turns, Some(0));
    assert_eq!(zero.max_session_tokens, Some(0));

    // A decimal amount, not a token count, and `0` is a real ceiling.
    assert_eq!(parsed_budget(&[]).max_budget_usd, None);
    assert_eq!(
        parsed_budget(&["--max-budget-usd", "2.50"]).max_budget_usd,
        Some(2.50)
    );
    assert_eq!(
        parsed_budget(&["--max-budget-usd", "0"]).max_budget_usd,
        Some(0.0)
    );
}

#[test]
fn per_run_flags_parse_on_agent_run() {
    let cli = Cli::parse_from([
        "flint", "cli", "agent", "run", "task", "--append-system-prompt", "be brief",
        "--allow-tool", "read", "--allow-tool", "grep", "--deny-tool", "bash",
        "--effort", "high", "--ephemeral",
    ]);
    let Some(Commands::Cli { cmd: CliCommands::Agent { cmd: AgentCommands::Run {
        append_system_prompt, allow_tools, deny_tools, effort, ephemeral, ..
    }}}) = cli.command else { panic!("expected `cli agent run`") };
    assert_eq!(append_system_prompt.as_deref(), Some("be brief"));
    assert_eq!(allow_tools, ["read", "grep"]);
    assert_eq!(deny_tools, ["bash"]);
    assert_eq!(effort.as_deref(), Some("high"));
    assert!(ephemeral);
}

#[test]
fn append_prompt_joins_text_and_file_and_refuses_an_empty_file() {
    let dir = std::env::temp_dir().join(format!("flint-append-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let full = dir.join("p.txt");
    let empty = dir.join("e.txt");
    std::fs::write(&full, "from file").unwrap();
    std::fs::write(&empty, "  ").unwrap();
    assert_eq!(resolve_append_prompt(None, None).unwrap(), None);
    assert_eq!(
        resolve_append_prompt(Some("a".into()), full.to_str()).unwrap().as_deref(),
        Some("a\n\nfrom file")
    );
    assert!(resolve_append_prompt(None, empty.to_str()).is_err());
    assert!(resolve_append_prompt(None, Some("/no/such/file")).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn tool_flag_names_follow_the_schedule_rule() {
    use app_lib::core::cli::validate_tool_flags;
    assert!(validate_tool_flags(&["read".into()], &["bash".into()]).is_ok());
    assert!(validate_tool_flags(&["*".into()], &[]).is_err());
    assert!(validate_tool_flags(&[], &["has space".into()]).is_err());
}

#[test]
fn mcp_serve_parses_and_defaults_to_read_only_stdio() {
    let cli = Cli::parse_from(["flint", "mcp", "serve"]);
    let Some(Commands::Mcp {
        cmd:
            McpServeCommands::Serve {
                project,
                transport,
                allow_write,
                allow_exec,
                tools,
                port,
                token,
                ..
            },
    }) = cli.command
    else {
        panic!("expected mcp serve");
    };
    assert_eq!(project, ".");
    assert_eq!(transport, ServeTransport::Stdio);
    assert!(!allow_write);
    assert!(!allow_exec);
    assert!(tools.is_empty());
    assert_eq!(port, 0);
    assert!(token.is_none());
}

#[test]
fn mcp_serve_http_flags_parse() {
    let cli = Cli::parse_from([
        "flint",
        "mcp",
        "serve",
        "--transport",
        "http",
        "--port",
        "7331",
        "--token",
        "abc",
        "--allow-write",
        "--allow-exec",
        "--tool",
        "read",
        "--tool",
        "grep",
    ]);
    let Some(Commands::Mcp {
        cmd:
            McpServeCommands::Serve {
                transport,
                allow_write,
                allow_exec,
                tools,
                port,
                token,
                ..
            },
    }) = cli.command
    else {
        panic!("expected mcp serve");
    };
    assert_eq!(transport, ServeTransport::Http);
    assert!(allow_write);
    assert!(allow_exec);
    assert_eq!(tools, vec!["read".to_string(), "grep".to_string()]);
    assert_eq!(port, 7331);
    assert_eq!(token.as_deref(), Some("abc"));
}

/// The client direction keeps its own place; `flint mcp` must not shadow it.
#[test]
fn mcp_client_subcommand_still_lives_under_cli() {
    let cli = Cli::parse_from(["flint", "cli", "mcp", "list"]);
    assert!(matches!(
        cli.command,
        Some(Commands::Cli {
            cmd: CliCommands::Mcp {
                cmd: McpCommands::List { .. }
            }
        })
    ));
}

use super::*;

#[test]
fn verbose_flag_is_accepted_bare_and_after_a_subcommand() {
    for args in [
        vec!["jan", "--verbose"],
        vec!["jan", "-v"],
        vec!["jan", "plugin", "list", "--verbose"],
        vec!["jan", "-v", "plugin", "list"],
    ] {
        let cli = Cli::try_parse_from(&args)
            .unwrap_or_else(|e| panic!("{args:?} should parse: {e}"));
        assert!(cli.verbose, "{args:?} should set verbose");
    }
    assert!(!Cli::try_parse_from(["jan", "plugin", "list"]).unwrap().verbose);
}

#[test]
fn bug_report_parses_its_flags_and_nothing_else() {
    let cli = Cli::parse_from([
        "jan",
        "bug-report",
        "--thread",
        "abc123",
        "--show",
        "logs/jan.log",
    ]);
    assert!(matches!(
        cli.command,
        Some(Commands::BugReport { thread, show, yes: false, out: None })
            if thread.as_deref() == Some("abc123") && show.as_deref() == Some("logs/jan.log")
    ));
    let cli = Cli::parse_from(["jan", "bug-report", "--yes", "--out", "."]);
    assert!(matches!(
        cli.command,
        Some(Commands::BugReport { yes: true, out: Some(_), .. })
    ));
    // There is deliberately no flag that sends the bundle anywhere.
    for flag in ["--upload", "--submit", "--send", "--open-issue"] {
        assert!(
            Cli::try_parse_from(["jan", "bug-report", flag]).is_err(),
            "{flag} must not exist"
        );
    }
}

/// `--from` without `--body` (or the reverse) is half a send; it must be
/// refused rather than fall through to reading the mailbox (#150).
#[test]
fn agent_mail_refuses_half_a_send() {
    let base = ["jan", "cli", "agent", "mail", "--run", "r1"];
    let with = |extra: &[&'static str]| {
        let mut args = base.to_vec();
        args.extend_from_slice(extra);
        Cli::try_parse_from(args)
    };
    assert!(with(&["--from", "r2"]).is_err(), "--from alone was accepted");
    assert!(with(&["--body", "hi"]).is_err(), "--body alone was accepted");
    assert!(with(&[]).is_ok(), "a plain read must still parse");
    assert!(with(&["--from", "r2", "--body", "hi", "--session", "s"]).is_ok());
}

// `--plan` is a per-invocation startup toggle mirroring `--safe`; it must
// parse on the top-level `jan` command and default off.
#[test]
fn top_level_plan_flag_parses() {
    let cli = Cli::parse_from(["jan", "--plan"]);
    assert!(cli.plan);
    assert!(!cli.safe);
    assert!(cli.command.is_none());

    let cli = Cli::parse_from(["jan"]);
    assert!(!cli.plan);
}

// Permission prompts are opt-in: auto-approval inside the OS sandbox is the
// default, and `--safe` is what turns the gate back on.
#[test]
fn console_accepts_worktree_flags() {
    assert_eq!(Cli::parse_from(["flint", "--worktree"]).worktree.into_flag(), Some(true));
    assert_eq!(Cli::parse_from(["flint", "--no-worktree"]).worktree.into_flag(), Some(false));
    assert_eq!(Cli::parse_from(["flint"]).worktree.into_flag(), None);
    assert!(Cli::try_parse_from(["flint", "--worktree", "--no-worktree"]).is_err());
}

#[test]
fn mode_flag_parses_and_replaces_safe() {
    assert_eq!(Cli::parse_from(["flint", "--mode", "ask"]).mode.as_deref(), Some("ask"));
    let cli = Cli::parse_from(["flint", "--mode", "ask", "--safe"]);
    assert!(app_lib::core::cli::PermissionMode::resolve(cli.mode.as_deref(), cli.safe, cli.plan).is_err());
}

#[test]
fn new_management_commands_parse() {
    for argv in [
        vec!["flint", "cli", "schedule", "add", "--name", "n", "--prompt", "p", "--model", "m/x", "--daily", "09:00", "--allow-tool", "read"],
        vec!["flint", "cli", "schedule", "preview", "--weekly", "mon@09:00"],
        vec!["flint", "cli", "archive", "list", "--kind", "thread"],
        vec!["flint", "cli", "threads", "export", "abc", "--format", "obsidian"],
        vec!["flint", "cli", "skills", "enabled", "a", "b"],
        vec!["flint", "cli", "memory", "list", "project"],
        vec!["flint", "cli", "memory", "audit", "--json", "--stale-days", "30"],
        vec!["flint", "cli", "worktree", "discard", "abcd1234", "--force"],
        vec!["flint", "cli", "mcp", "trust", "demo", "--yes"],
        vec!["flint", "cli", "models", "search", "qwen"],
        vec!["flint", "cli", "net", "endpoint", "localhost", "8080"],
        vec!["flint", "cli", "agent", "audit", "--decision", "refused"],
        vec!["flint", "cli", "import-claude", "scan"],
        vec!["flint", "cli", "data-folder"],
        vec!["flint", "migrate", "plan", "--mode", "copy"],
    ] {
        assert!(Cli::try_parse_from(argv.clone()).is_ok(), "{argv:?}");
    }
}

#[test]
fn safe_flag_parses_and_defaults_off() {
    assert!(!Cli::parse_from(["jan"]).safe);
    assert!(Cli::parse_from(["jan", "--safe"]).safe);
}

/// Parse `flint cli agent run <task> <extra...>` and pull out its output format.
fn parsed_output_format(extra: &[&str]) -> OutputFormat {
    let mut argv = vec!["jan", "cli", "agent", "run", "task"];
    argv.extend_from_slice(extra);
    match Cli::parse_from(argv).command {
        Some(Commands::Cli {
            cmd:
                CliCommands::Agent {
                    cmd: AgentCommands::Run { output_format, .. },
                },
        }) => output_format,
        _ => panic!("expected `cli agent run`"),
    }
}

/// AH-087: a session's requests are listed, the last or a named one is
/// printed in full, and another session's request is not readable by id.
#[test]
fn agent_prompts_lists_and_prints_a_sessions_requests_only() {
    use tauri_plugin_agent_tools::snapshot::{append, capture, Identity};
    let data = std::env::temp_dir().join(format!("jan-prompts-cli-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let ident = |session: &str| Identity { session: session.into(), ..Default::default() };
    let first = capture(
        &serde_json::json!({ "model": "m", "messages": [{ "role": "user", "content": "first question" }] }),
        &ident("s1"),
    );
    let second = capture(
        &serde_json::json!({ "model": "m", "messages": [{ "role": "user", "content": "second question" }] }),
        &ident("s1"),
    );
    let other = capture(
        &serde_json::json!({ "model": "m", "messages": [{ "role": "user", "content": "someone else's" }] }),
        &ident("s2"),
    );
    for s in [&first, &second, &other] {
        append(&data, s);
    }

    let list = agent_prompts_text(&data, "s1", None).unwrap();
    assert!(list.starts_with("2 request(s) for session s1"), "{list}");
    assert!(list.contains(&first.id) && list.contains(&second.id) && !list.contains(&other.id));

    let last = agent_prompts_text(&data, "s1", Some("last")).unwrap();
    assert!(last.contains("second question") && !last.contains("first question"), "{last}");
    let named = agent_prompts_text(&data, "s1", Some(&first.id)).unwrap();
    assert!(named.contains("first question"), "{named}");

    assert!(agent_prompts_text(&data, "s1", Some(&other.id)).is_err(), "another session's request was readable");
    assert!(agent_prompts_text(&data, "s3", None).unwrap_err().contains("no requests"));
    assert!(agent_prompts_text(&data, " ", None).is_err());
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn prompts_is_a_cli_agent_command() {
    let cli = Cli::try_parse_from(["jan", "cli", "agent", "prompts", "s1", "--show", "last"]);
    assert!(cli.is_ok(), "`flint cli agent prompts <session> --show last` must parse");
}

#[test]
fn output_format_parses_and_defaults_to_text() {
    assert_eq!(parsed_output_format(&[]), OutputFormat::Text);
    assert_eq!(
        parsed_output_format(&["--output-format", "json"]),
        OutputFormat::Json
    );
    assert_eq!(
        parsed_output_format(&["--output-format=text"]),
        OutputFormat::Text
    );
    assert!(Cli::try_parse_from([
        "jan",
        "cli",
        "agent",
        "run",
        "task",
        "--output-format",
        "yaml"
    ])
    .is_err());
}

#[test]
fn login_command_parses_and_takes_no_args() {
    let cli = Cli::parse_from(["jan", "login"]);
    assert!(matches!(
        cli.command,
        Some(Commands::Login { paste_token: false })
    ));
    assert!(Cli::try_parse_from(["jan", "login", "sk-key"]).is_err());
}

#[test]
fn login_command_accepts_paste_token_flag() {
    let cli = Cli::parse_from(["jan", "login", "--paste-token"]);
    assert!(matches!(
        cli.command,
        Some(Commands::Login { paste_token: true })
    ));
}

#[test]
fn auth_subcommands_parse() {
    let cli = Cli::parse_from(["jan", "auth", "status"]);
    assert!(matches!(
        cli.command,
        Some(Commands::Auth {
            cmd: AuthCommands::Status
        })
    ));
    let cli = Cli::parse_from(["jan", "auth", "logout"]);
    assert!(matches!(
        cli.command,
        Some(Commands::Auth {
            cmd: AuthCommands::Logout
        })
    ));
}

/// Parse a `flint cli mcp <cmd> <extra...>` argv and pull out the subcommand.
fn parsed_mcp(extra: &[&str]) -> McpCommands {
    let mut argv = vec!["jan", "cli", "mcp"];
    argv.extend_from_slice(extra);
    match Cli::parse_from(argv).command {
        Some(Commands::Cli {
            cmd: CliCommands::Mcp { cmd },
        }) => cmd,
        _ => panic!("expected `cli mcp`"),
    }
}

#[test]
fn mcp_list_parses_and_redacts_by_default() {
    let cmd = parsed_mcp(&["list"]);
    assert!(matches!(
        cmd,
        McpCommands::List {
            show_secrets: false
        }
    ));
    let cmd = parsed_mcp(&["list", "--show-secrets"]);
    assert!(matches!(cmd, McpCommands::List { show_secrets: true }));
}

#[test]
fn mcp_add_parses_stdio_fields() {
    let cmd = parsed_mcp(&[
        "add",
        "files",
        "--command",
        "npx",
        "--arg",
        "-y",
        "--arg",
        "my-mcp",
        "--env",
        "K=V",
        "--active",
    ]);
    match cmd {
        McpCommands::Add {
            name,
            command,
            args,
            env,
            r#type,
            url,
            header,
            scope,
            active,
        } => {
            assert!(scope.is_empty(), "no --scope was given");
            assert_eq!(name, "files");
            assert_eq!(command.as_deref(), Some("npx"));
            assert_eq!(args, vec!["-y", "my-mcp"]);
            assert_eq!(env, vec!["K=V"]);
            assert_eq!(r#type, "stdio");
            assert!(url.is_none());
            assert!(header.is_empty());
            assert!(active);
        }
        _ => panic!("expected add"),
    }
}

#[test]
fn mcp_build_rejects_http_without_url() {
    let err = build_mcp_config(None, vec![], vec![], "http", None, vec![], false, Vec::new()).unwrap_err();
    assert!(err.contains("url"), "{err}");
    let err = build_mcp_config(None, vec![], vec![], "sse", None, vec![], false, Vec::new()).unwrap_err();
    assert!(err.contains("url"), "{err}");
    assert!(build_mcp_config(None, vec![], vec![], "bogus", None, vec![], false, Vec::new()).is_err());
    // stdio needs a command.
    assert!(build_mcp_config(None, vec![], vec![], "stdio", None, vec![], false, Vec::new()).is_err());
}

#[test]
fn mcp_remove_enable_disable_take_one_name() {
    assert!(matches!(
        parsed_mcp(&["remove", "files"]),
        McpCommands::Remove { name } if name == "files"
    ));
    assert!(matches!(
        parsed_mcp(&["enable", "files"]),
        McpCommands::Enable { name } if name == "files"
    ));
    assert!(matches!(
        parsed_mcp(&["disable", "files"]),
        McpCommands::Disable { name } if name == "files"
    ));
}
#[test]
fn plugin_list_defaults_to_compact_output_and_supports_json() {
    let cli = Cli::try_parse_from(["jan", "plugin", "list"]).unwrap();
    assert!(matches!(
        cli.command,
        Some(Commands::Plugin {
            cmd: PluginCommands::List { project, json }
        }) if project == "." && !json
    ));

    let cli = Cli::try_parse_from(["jan", "plugin", "list", "--json"]).unwrap();
    assert!(matches!(
        cli.command,
        Some(Commands::Plugin {
            cmd: PluginCommands::List { json, .. }
        }) if json
    ));
}

#[test]
fn split_kv_rejects_without_separator() {
    assert_eq!(
        split_kv("K=V", "env").unwrap(),
        ("K".to_string(), "V".to_string())
    );
    assert!(split_kv("novalue", "env").is_err());
    assert!(split_kv("=V", "header").is_err());
}

#[test]
fn compact_plugin_list_omits_long_metadata() {
    let plugins = vec![
        InstalledPlugin {
            name: "alpha".into(),
            description: "A long description that should not appear".into(),
            version: "1.2.3".into(),
            repo: "https://example.com/alpha".into(),
            skills: 2,
            commands: 1,
            agents: 3,
            ..Default::default()
        },
        InstalledPlugin {
            name: "beta".into(),
            description: "Another description".into(),
            version: "0.0.0".into(),
            repo: String::new(),
            skills: 0,
            commands: 0,
            agents: 0,
            ..Default::default()
        },
    ];

    let output = format_plugin_list(&plugins);
    assert_eq!(output.lines().count(), 3);
    assert!(output.lines().next().unwrap().contains("PLUGIN"));
    assert!(output.lines().next().unwrap().contains("COMMANDS"));
    assert!(output.lines().next().unwrap().contains("AGENTS"));
    assert!(output.contains("alpha"));
    assert!(output.contains("1.2.3"));
    assert!(output.contains("2"));
    assert!(output.contains("1"));
    assert!(output.contains("3"));
    assert!(!output.contains("long description"));
    assert!(!output.contains("example.com"));
}

#[test]
fn the_command_tree_passes_clap_debug_asserts() {
    Cli::command().debug_assert();
}

#[test]
fn every_subcommand_answers_help() {
    fn walk(cmd: &clap::Command, path: &mut Vec<String>, seen: &mut usize) {
        path.push(cmd.get_name().to_string());
        let mut args = path.clone();
        args.push("--help".to_string());
        let err = Cli::command()
            .try_get_matches_from(&args)
            .expect_err("--help always stops parsing");
        assert_eq!(err.kind(), clap::error::ErrorKind::DisplayHelp, "{args:?}");
        *seen += 1;
        for sub in cmd.get_subcommands() {
            walk(sub, path, seen);
        }
        path.pop();
    }
    let root = Cli::command();
    let mut seen = 0;
    walk(&root, &mut Vec::new(), &mut seen);
    assert!(seen > 30, "walked only {seen} commands");
}
