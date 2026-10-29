#[test]
fn permission_modes_map_to_the_two_switches() {
    assert_eq!(PermissionMode::resolve(None, false, false), Ok((true, false)));
    assert_eq!(PermissionMode::resolve(None, true, true), Ok((false, true)));
    assert_eq!(PermissionMode::resolve(Some("ask"), false, false), Ok((false, false)));
    assert_eq!(PermissionMode::resolve(Some("Auto"), false, false), Ok((true, false)));
    assert_eq!(PermissionMode::resolve(Some("bypass"), false, false), Ok((true, false)));
    assert_eq!(PermissionMode::resolve(Some("review"), false, false), Ok((false, true)));
    assert!(PermissionMode::resolve(Some("ask"), true, false).is_err());
    assert!(PermissionMode::resolve(Some("nope"), false, false).is_err());
    assert_eq!(PermissionMode::parse("review").unwrap().as_str(), "review");
}

/// `agent status` names every contributor to the prompt and where `[prompt]`
/// put it, and says which ones the policy demoted. A policy that cannot be
/// honored fails the command with the same message a run gives.
#[test]
fn agent_status_reports_where_each_contributor_lands() {
    let root = tempfile::tempdir().unwrap();
    let agent_dir = root.path().join(".jan").join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("agent.toml"),
        "[prompt]\nprefix_allow = [\"assistant_instructions\", \"guidelines\"]\n",
    )
    .unwrap();

    let status = cli_agent_status(
        root.path().to_str().unwrap(),
        &ProviderOverrides::default(),
    )
    .expect("status");
    let components = status["prompt"]["components"].as_array().expect("components");
    let find = |id: &str| {
        components
            .iter()
            .find(|c| c["id"] == id)
            .unwrap_or_else(|| panic!("{id} not reported"))
    };
    assert_eq!(find("guidelines")["placement"], "prefix");
    assert_eq!(find("guidelines")["demoted"], false);
    assert_eq!(find("skills")["placement"], "tail");
    assert_eq!(find("skills")["demoted"], true);
    // Varies while a run works: below the line by its own declaration, not
    // because the policy demoted it.
    assert_eq!(find("todo_upkeep")["placement"], "tail");
    assert_eq!(find("todo_upkeep")["demoted"], false);
    assert_eq!(find("tool_schemas")["placement"], "prefix");
    assert_eq!(status["prompt"]["prefix_allow"].as_array().map(Vec::len), Some(2));

    std::fs::write(
        agent_dir.join("agent.toml"),
        "[prompt]\nprefix_allow = [\"todo_upkeep\"]\n",
    )
    .unwrap();
    let error = cli_agent_status(
        root.path().to_str().unwrap(),
        &ProviderOverrides::default(),
    )
    .expect_err("a per-turn contributor cannot lead the prompt");
    assert!(error.contains("todo_upkeep"), "{error}");
}

/// #200: every colored line goes through `color::paint`, so NO_COLOR and
/// non-terminal stderr are honored. Neither source may hold an SGR
/// sequence of its own, whether escaped or as a raw ESC character.
#[test]
fn cli_sources_hold_no_raw_escape_sequences() {
    let escaped = concat!("\\", "x1b[");
    for (name, src) in [
        ("core/cli/mod.rs", include_str!("mod.rs")),
        ("bin/flint.rs", include_str!("../../bin/flint.rs")),
    ] {
        assert!(!src.contains(escaped), "{name} writes an escape sequence directly");
        assert!(!src.contains('\u{1b}'), "{name} holds a raw ESC character");
    }
}

/// #143: deleting a thread drops its snapshot ref in the repository the
/// thread recorded, not only the scratch index.
#[test]
fn deleting_a_thread_drops_its_snapshot_ref() {
    use crate::core::agent::git;
    let git_in = |dir: &std::path::Path, args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git");
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    let repo = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    git_in(repo.path(), &["init", "-q"]);
    // The empty tree (stdin is empty), written so commit-tree can use it.
    let tree = git_in(repo.path(), &["hash-object", "-t", "tree", "-w", "--stdin"]);
    let sha = git_in(
        repo.path(),
        &[
            "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
            "commit-tree", &tree, "-m", "s",
        ],
    );
    let id = "cli-delete-drops-ref";
    git::update_ref(repo.path(), id, &sha).unwrap();
    let reference = git::snapshot_ref(id);
    git_in(repo.path(), &["rev-parse", "--verify", &reference]);

    let meta_path = super::get_thread_metadata_path(data.path(), id);
    std::fs::create_dir_all(meta_path.parent().unwrap()).unwrap();
    std::fs::write(
        &meta_path,
        serde_json::json!({
            "id": id,
            "metadata": { super::SNAPSHOT_REPO_KEY: repo.path().to_string_lossy() },
        })
        .to_string(),
    )
    .unwrap();

    super::delete_thread_at(data.path(), id).unwrap();

    let still = std::process::Command::new("git")
        .args(["rev-parse", "--verify", "--quiet", &reference])
        .current_dir(repo.path())
        .output()
        .unwrap();
    assert!(!still.status.success(), "snapshot ref survived the delete");
    assert!(!meta_path.exists());
}

/// AH-181: a declared density is read, and anything that is not one is
/// refused rather than quietly treated as the default -- a run that says
/// less than somebody asked it to is a run whose log is missing what they
/// wanted to read.
#[test]
fn an_output_density_is_read_or_refused_by_name() {
    use super::Density;
    assert_eq!(Density::parse("compact"), Ok(Density::Compact));
    assert_eq!(Density::parse(" QUIET "), Ok(Density::Compact));
    assert_eq!(Density::parse("normal"), Ok(Density::Normal));
    // Unset in a config file reads as the default rather than as an error.
    assert_eq!(Density::parse(""), Ok(Density::Normal));
    assert_eq!(Density::parse("verbose"), Ok(Density::Verbose));
    assert_eq!(Density::default(), Density::Normal);

    let err = Density::parse("loud").unwrap_err();
    assert!(err.contains("not an output density"), "{err}");
    assert!(err.contains("compact, normal or verbose"), "{err}");
}

/// A headless run's conversation survives being saved and resumed, tool
/// calls and all.
///
/// This is what stops a resumed turn showing the model a transcript in
/// which it described work and never called a tool -- an example of the
/// wrong behaviour, which a model will imitate. Observed against a real
/// provider before the run's conversation was persisted: the model
/// narrated tool calls it had not made and reported their results.
#[test]
fn a_resumed_turn_still_shows_the_model_the_tools_it_ran() {
    let base = std::env::temp_dir().join(format!(
        "flint-cli-resume-tools-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();

    // What the loop publishes: the prompt, the call, its result, the answer.
    let conversation = vec![
        serde_json::json!({ "role": "user", "content": "how many files?" }),
        serde_json::json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": { "name": "ls", "arguments": "{\"path\":\".\"}" }
            }]
        }),
        serde_json::json!({ "role": "tool", "tool_call_id": "call_1", "content": "a.py b.py" }),
        serde_json::json!({ "role": "assistant", "content": "Two." }),
    ];
    let id = cli_save_thread(&base, None, "m", &conversation, None).expect("saved");

    let resumed = load_resume_history(&base, &ResumeRequest::resume(ResumeTarget::Id(id.clone())))
        .expect("the thread resumes");
    let roles: Vec<&str> = resumed
        .history
        .iter()
        .filter_map(|m| m.get("role").and_then(|v| v.as_str()))
        .collect();
    assert_eq!(
        roles,
        ["user", "assistant", "tool", "assistant"],
        "the resumed history is not the conversation: {roles:?}"
    );
    let call = resumed
        .history
        .iter()
        .find(|m| m.get("tool_calls").is_some())
        .expect("the assistant's tool call survived");
    assert_eq!(call["tool_calls"][0]["function"]["name"], "ls");
    let result = resumed
        .history
        .iter()
        .find(|m| m.get("role").and_then(|v| v.as_str()) == Some("tool"))
        .expect("the tool's result survived");
    assert_eq!(result["tool_call_id"], "call_1");
    assert_eq!(result["content"], "a.py b.py");
    let _ = std::fs::remove_dir_all(&base);
}

use super::*;

/// The duplex channel end to end over a pipe: a follow-up is queued for the
/// steering handshake, a permission reply reaches the waiting run, a
/// malformed line is survivable, and `abort` stops the reader.
///
/// Driven through `read_input_lines` rather than the built binary because a
/// cargo test cannot own process stdin; the binary is exercised by hand.
#[tokio::test]
async fn a_duplex_client_steers_answers_and_aborts_over_one_pipe() {
    let input = Arc::new(StreamInput::default());
    let registry: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
    let (answer_tx, answer) = tokio::sync::oneshot::channel();
    registry.lock().await.insert("perm-1".to_string(), answer_tx);

    let script = [
        r#"{"type":"user","text":"also check the tests"}"#,
        "   ",
        "{ not json",
        r#"{"type":"permission","request_id":"perm-1","decision":"allow_once"}"#,
        r#"{"type":"user","text":"and the docs"}"#,
        r#"{"type":"abort"}"#,
        r#"{"type":"user","text":"never read"}"#,
    ];
    let (lines_tx, lines) = mpsc::unbounded_channel();
    for line in script {
        lines_tx
            .send(ClientLine {
                text: line.to_string(),
                oversized: false,
            })
            .expect("reader is alive");
    }
    drop(lines_tx);
    read_input_lines(
        lines,
        Arc::clone(&input),
        Arc::clone(&registry),
        crate::core::agent::host_tools::new_registry(),
        mpsc::unbounded_channel().0,
        OutputFormat::Json,
    )
    .await;

    assert_eq!(
        answer.await.expect("the run's permission wait is answered"),
        PermissionDecision::AllowOnce
    );
    let queued = input.take_queued();
    assert_eq!(queued.len(), 2, "the bad line cost neither follow-up");
    assert_eq!(queued[0]["content"], "also check the tests");
    assert_eq!(queued[1]["content"], "and the docs");
    // Lines after `abort` are not read: the run is already ending.
    assert!(input.take_queued().is_empty());
    input.aborted().await;
}

/// A subagent's prompt arrives wrapped in `Subagent`; it must be answered
/// (denied with no terminal) like the parent's own or the child's loop parks.
#[tokio::test]
async fn a_subagent_permission_prompt_is_denied_when_nobody_can_answer() {
    use std::io::IsTerminal;
    if std::io::stdin().is_terminal() {
        return;
    }
    let prompt = || StreamEvent::Subagent {
        run_id: "sub-explore-1".into(),
        name: "explore".into(),
        event: Box::new(StreamEvent::PermissionRequest {
            request_id: "perm-1".into(),
            tool_name: "write".into(),
            capability: "write".into(),
            path: Some("child.txt".into()),
            command: None,
            diff: None,
            patch: None,
            prompt_kind: "write".into(),
            offers_always: true,
            reason: None,
            args_digest: None,
            call_id: None,
        }),
    };
    let registry: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
    let (answer_tx, answer) = tokio::sync::oneshot::channel();
    registry.lock().await.insert("perm-1".to_string(), answer_tx);

    // A client on stdin owns the decision: nothing is answered here.
    assert!(resolve_permission_silently(prompt(), &registry, true).await.is_none());
    assert!(registry.lock().await.contains_key("perm-1"));

    let decided = resolve_permission_silently(prompt(), &registry, false).await;
    assert_eq!(decided, Some(("perm-1".to_string(), PermissionDecision::Deny)));
    assert_eq!(answer.await.expect("the child's wait is answered"), PermissionDecision::Deny);
}

/// A decision is single-use. The second reply has no sender left to take,
/// which is what keeps a client from answering a request the run already
/// acted on.
#[tokio::test]
async fn a_second_reply_to_one_request_is_rejected() {
    let input = StreamInput::default();
    let registry: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
    let (tx, _rx) = tokio::sync::oneshot::channel();
    registry.lock().await.insert("perm-1".to_string(), tx);
    let line = r#"{"type":"permission","request_id":"perm-1","decision":"deny"}"#;

    let host_tools = crate::core::agent::host_tools::new_registry();
    let targets = InputTargets {
        permissions: &registry,
        host_tools: &host_tools,
    };
    assert_eq!(
        apply_input_line(line, &input, &targets).await,
        Ok(InputFlow::Decided(
            "perm-1".to_string(),
            PermissionDecision::Deny
        ))
    );
    let err = apply_input_line(line, &input, &targets)
        .await
        .expect_err("nothing is pending any more");
    assert!(err.contains("no permission request 'perm-1'"), "{err}");
}

/// The same single-use rule for a host tool answer, and the same reason:
/// the first result has already been fed to the model.
#[tokio::test]
async fn a_second_tool_result_for_one_request_is_rejected() {
    let input = StreamInput::default();
    let registry: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
    let host_tools = crate::core::agent::host_tools::new_registry();
    // The id comes from the registry: the counter is process-wide, so a
    // literal would depend on which tests ran first.
    let (id, answer) = crate::core::agent::host_tools::register(&host_tools).await;
    let targets = InputTargets {
        permissions: &registry,
        host_tools: &host_tools,
    };
    let line = format!(r#"{{"type":"tool_result","request_id":"{id}","content":"moved"}}"#);
    let line = line.as_str();

    assert_eq!(
        apply_input_line(line, &input, &targets).await,
        Ok(InputFlow::Continue)
    );
    assert_eq!(
        answer.await.expect("the run's tool wait is answered"),
        Ok(crate::core::agent::host_tools::HostToolResult {
            content: "moved".to_string(),
            parts: None,
            details: None,
            is_error: false,
        })
    );
    let err = apply_input_line(line, &input, &targets)
        .await
        .expect_err("nothing is pending any more");
    assert!(err.contains(&format!("no host tool request '{id}'")), "{err}");
}

/// The wedge this guards: with a client on stdin the CLI answers nothing
/// itself, so a request still pending when the pipe closes had no way out.
/// Dropping the sender is what resolves the run's wait to `Deny`.
#[tokio::test]
async fn closing_stdin_releases_a_request_the_client_never_answered() {
    let input = Arc::new(StreamInput::default());
    let registry: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
    let (answer_tx, answer) = tokio::sync::oneshot::channel();
    registry
        .lock()
        .await
        .insert("perm-1".to_string(), answer_tx);

    // No lines at all: the client opened the pipe and closed it again.
    let (lines_tx, lines) = mpsc::unbounded_channel::<ClientLine>();
    drop(lines_tx);
    read_input_lines(
        lines,
        Arc::clone(&input),
        Arc::clone(&registry),
        crate::core::agent::host_tools::new_registry(),
        mpsc::unbounded_channel().0,
        OutputFormat::StreamJson,
    )
    .await;

    assert!(
        answer.await.is_err(),
        "the sender is dropped, which the run reads as Deny"
    );
    assert!(registry.lock().await.is_empty());
    assert!(
        input.client_gone(),
        "later requests must not be recorded as the client's to answer"
    );
}

/// The same wedge for a host tool, where it is sharper: only the client can
/// answer a `tool_request`, so a pipe that closes mid-call would park the
/// turn forever rather than merely losing a decision default.
#[tokio::test]
async fn a_pending_host_tool_call_is_released_when_the_client_leaves() {
    let input = Arc::new(StreamInput::default());
    let registry: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
    let host_tools = crate::core::agent::host_tools::new_registry();
    let (id, answer) = crate::core::agent::host_tools::register(&host_tools).await;

    let (lines_tx, lines) = mpsc::unbounded_channel::<ClientLine>();
    drop(lines_tx);
    let (events_tx, mut events) = mpsc::unbounded_channel();
    read_input_lines(
        lines,
        Arc::clone(&input),
        Arc::clone(&registry),
        Arc::clone(&host_tools),
        events_tx,
        OutputFormat::StreamJson,
    )
    .await;

    assert_eq!(
        answer.await.expect("the wait is settled, not dropped"),
        Err(crate::core::agent::host_tools::HostToolError::ClientGone)
    );
    assert!(host_tools.lock().await.is_empty());
    // The host is told, on the run's own stream, which request it lost.
    assert_eq!(
        serde_json::to_value(events.recv().await.expect("a record")).unwrap(),
        serde_json::json!({
            "type": "tool_request_cancelled",
            "request_id": id,
            "reason": "client_gone"
        })
    );
    assert!(events.recv().await.is_none(), "one record per released request");
}

/// An `abort` stops the reader but leaves host requests to the run's abort
/// path, which withdraws them as `aborted`; releasing them here as well
/// would report the same request twice under two reasons.
#[tokio::test]
async fn an_abort_leaves_host_requests_to_the_run() {
    let input = Arc::new(StreamInput::default());
    let host_tools = crate::core::agent::host_tools::new_registry();
    let (id, _answer) = crate::core::agent::host_tools::register(&host_tools).await;
    let (lines_tx, lines) = mpsc::unbounded_channel();
    lines_tx
        .send(ClientLine {
            text: r#"{"type":"abort"}"#.to_string(),
            oversized: false,
        })
        .expect("reader is alive");
    drop(lines_tx);
    let (events_tx, mut events) = mpsc::unbounded_channel();
    read_input_lines(
        lines,
        Arc::clone(&input),
        Arc::new(Mutex::new(HashMap::new())),
        Arc::clone(&host_tools),
        events_tx,
        OutputFormat::StreamJson,
    )
    .await;
    assert!(events.recv().await.is_none());
    assert!(host_tools.lock().await.contains_key(&id));
    // What the abort path then does: the host is told, and a reply the
    // host was already writing is refused as no longer pending.
    let released = crate::core::agent::host_tools::cancel_all(&host_tools).await;
    assert_eq!(released, vec![id.clone()]);
    let late = format!(r#"{{"type":"tool_result","request_id":"{id}","content":"late"}}"#);
    let targets = InputTargets {
        permissions: &Arc::new(Mutex::new(HashMap::new())),
        host_tools: &host_tools,
    };
    let err = apply_input_line(&late, &input, &targets)
        .await
        .expect_err("nothing pending");
    assert!(err.contains("is pending (answered, cancelled, or never issued)"), "{err}");
}

/// An over-cap tool result is refused as a line, and the request is still
/// pending: the host can shrink the image and answer again.
#[tokio::test]
async fn an_over_cap_tool_result_leaves_the_request_pending() {
    let input = StreamInput::default();
    let host_tools = crate::core::agent::host_tools::new_registry();
    let (id, answer) = crate::core::agent::host_tools::register(&host_tools).await;
    let permissions: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
    let targets = InputTargets {
        permissions: &permissions,
        host_tools: &host_tools,
    };
    let big = "A".repeat((stream_input::MAX_IMAGE_BYTES + 3) / 3 * 4);
    let line = serde_json::json!({
        "type": "tool_result",
        "request_id": id,
        "content": [{ "type": "image_url",
                      "image_url": { "url": format!("data:image/png;base64,{big}") } }]
    })
    .to_string();
    let err = apply_input_line(&line, &input, &targets)
        .await
        .expect_err("over the cap");
    assert!(err.contains("byte cap"), "{err}");
    assert!(host_tools.lock().await.contains_key(&id), "still pending");
    let retry = serde_json::json!({
        "type": "tool_result",
        "request_id": id,
        "content": [{ "type": "text", "text": "smaller" }],
        "details": { "retry": 1 }
    })
    .to_string();
    assert_eq!(
        apply_input_line(&retry, &input, &targets).await,
        Ok(InputFlow::Continue)
    );
    let result = answer.await.expect("delivered").expect("answered");
    assert_eq!(result.content, "smaller");
    assert_eq!(result.details, Some(serde_json::json!({ "retry": 1 })));
}

/// The other half of the same wedge, and the sharper half: a request raised
/// *after* the pipe closed. `strand_all` has already run by then, so unless
/// the printer fails this call itself the turn parks on a reply no one is
/// left to send. Asserts the release, not merely that the latch flipped.
#[tokio::test]
async fn a_request_raised_after_the_client_left_is_failed_not_parked() {
    let input = StreamInput::default();
    let host_tools = crate::core::agent::host_tools::new_registry();

    // The client leaves, and the reader drains what was pending.
    input.mark_client_gone();
    crate::core::agent::host_tools::strand_all(&host_tools).await;

    // Only now does the model call a host tool.
    let (request_id, answer) =
        crate::core::agent::host_tools::register(&host_tools).await;
    assert!(input.client_gone());
    crate::core::agent::host_tools::strand(&host_tools, &request_id).await;

    assert_eq!(
        answer.await.expect("the wait is settled, not dropped"),
        Err(crate::core::agent::host_tools::HostToolError::ClientGone)
    );
    assert!(host_tools.lock().await.is_empty());
}

/// `--input-format stream-json` with any other output format leaves the
/// client unable to see the request ids it is expected to answer.
#[tokio::test]
async fn a_duplex_run_is_refused_unless_the_output_is_stream_json() {
    for format in [OutputFormat::Text, OutputFormat::Json] {
        let err = run_agent_loop(
            ".",
            "task",
            None,
            false,
            ProviderOverrides::default(),
            SessionFlags::default(),
            None,
            format,
            InputFormat::StreamJson,
            None,
            false,
        )
        .await
        .expect_err("the pairing is required");
        assert!(
            err.to_string().contains("requires --output-format stream-json"),
            "{err}"
        );
    }
}

/// A content-part follow-up reaches the queue as the client wrote it: the
/// same parts `upstream.rs` hands the provider, not a re-encoding of them.
#[tokio::test]
async fn a_content_part_follow_up_is_queued_verbatim() {
    let input = Arc::new(StreamInput::default());
    let registry: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
    let parts = serde_json::json!([
        { "type": "text", "text": "what is in this shot?" },
        { "type": "image_url",
          "image_url": { "url": "data:image/png;base64,QUJD", "detail": "high" } }
    ]);
    let line = serde_json::json!({ "type": "user", "content": parts }).to_string();
    let (lines_tx, lines) = mpsc::unbounded_channel();
    lines_tx
        .send(ClientLine {
            text: line,
            oversized: false,
        })
        .expect("reader is alive");
    drop(lines_tx);
    read_input_lines(
        lines,
        Arc::clone(&input),
        registry,
        crate::core::agent::host_tools::new_registry(),
        mpsc::unbounded_channel().0,
        OutputFormat::Json,
    )
    .await;

    let queued = input.take_queued();
    assert_eq!(queued.len(), 1, "the follow-up is queued as one turn");
    assert_eq!(queued[0]["role"], "user");
    assert_eq!(queued[0]["content"], parts);
}

/// A line over the cap is refused without being parsed, and what the reader
/// keeps of it is bounded: the cap exists so the bytes are not carried on.
#[test]
fn a_line_over_the_cap_is_refused_and_its_echo_bounded() {
    let mut bytes = vec![b'x'; MAX_LINE_BYTES + 1024];
    bytes.push(b'\n');
    bytes.extend_from_slice(br#"{"type":"user","text":"after"}"#);
    let mut reader = std::io::BufReader::new(std::io::Cursor::new(bytes));

    let first = read_bounded_line(&mut reader).unwrap().expect("a line");
    assert!(first.oversized);
    assert_eq!(first.text.len(), MAX_ECHO_BYTES, "the echo, not the line");
    // Resynchronised on the next line rather than treating the overflow as
    // the end of input.
    let second = read_bounded_line(&mut reader)
        .unwrap()
        .expect("the line after the overflow");
    assert!(!second.oversized);
    assert_eq!(second.text, r#"{"type":"user","text":"after"}"#);
    assert!(read_bounded_line(&mut reader).unwrap().is_none());
}

/// The rejected echo the client sees is the bounded one, so a client that
/// matches on `input_error.line` still can.
#[test]
fn an_over_cap_line_is_reported_with_a_truncated_echo() {
    let line = "x".repeat(MAX_ECHO_BYTES * 3);
    let record = serde_json::to_value(InputErrorRecord::new("line is over the cap", &line))
        .expect("a JSON record");
    assert_eq!(
        record["line"].as_str().expect("a string").len(),
        MAX_ECHO_BYTES
    );
    assert_eq!(record["line_truncated"], serde_json::json!(true));
}

/// A queued follow-up the run never reached is reported rather than
/// vanishing, so the client knows to send it again.
#[test]
fn follow_ups_the_run_never_read_are_reported() {
    let input = StreamInput::default();
    input.queue_user("and the docs".to_string()).unwrap();
    report_dropped_follow_ups(&input, OutputFormat::StreamJson);
    assert!(
        input.take_queued().is_empty(),
        "reporting drains, so a second call cannot double-report"
    );
}

/// Signing in to Tokamak is what unlocks the desktop inherit. Without it the
/// model stays unset so the TUI's sign-in notice fires, instead of the
/// session silently starting on whatever the desktop app last had selected.
#[test]
fn desktop_model_is_inherited_only_when_signed_in() {
    let selection = crate::core::cli::providers::DesktopSelection {
        provider: Some("llamacpp".into()),
        model: Some("gemma-4-E2B-it-IQ4_XS".into()),
    };
    assert_eq!(
        inherit_desktop_model(true, selection.clone()).as_deref(),
        Some("gemma-4-E2B-it-IQ4_XS"),
    );
    assert_eq!(
        inherit_desktop_model(false, selection),
        None,
        "a signed-out session does not adopt the desktop's selection"
    );
}

/// Signed in but the desktop has no selection (or no desktop at all) is not
/// an error -- it just contributes nothing to the chain.
#[test]
fn an_empty_desktop_selection_contributes_nothing() {
    assert_eq!(
        inherit_desktop_model(
            true,
            crate::core::cli::providers::DesktopSelection::default()
        ),
        None
    );
}

// ── resume ─────────────────────────────────────────────────────────────

#[test]
fn resume_target_from_flags() {
    assert_eq!(ResumeTarget::from_flags(None, false), None);
    assert_eq!(
        ResumeTarget::from_flags(None, true),
        Some(ResumeTarget::Latest)
    );
    assert_eq!(
        ResumeTarget::from_flags(Some(None), false),
        Some(ResumeTarget::Latest)
    );
    // A blank --resume value behaves like a bare --resume.
    assert_eq!(
        ResumeTarget::from_flags(Some(Some("  ".into())), false),
        Some(ResumeTarget::Latest)
    );
    assert_eq!(
        ResumeTarget::from_flags(Some(Some(" 3f7a ".into())), false),
        Some(ResumeTarget::Id("3f7a".into()))
    );
}

/// Write a thread with the given id/recency and a single user message.
fn seed_thread(base: &std::path::Path, id: &str, updated: f64) {
    std::fs::create_dir_all(get_thread_dir(base, id)).unwrap();
    std::fs::write(
        get_thread_metadata_path(base, id),
        serde_json::json!({ "id": id, "title": id, "updated": updated }).to_string(),
    )
    .unwrap();
    std::fs::write(
        get_messages_path(base, id),
        serde_json::json!({
            "role": "user",
            "content": [{ "type": "text", "text": { "value": id, "annotations": [] } }],
        })
        .to_string()
            + "\n",
    )
    .unwrap();
}

#[test]
fn find_resume_thread_latest_and_by_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    assert_eq!(
        find_resume_thread(base, &ResumeTarget::Latest).unwrap_err(),
        NO_SESSION_TO_RESUME
    );

    seed_thread(base, "aaaa1111", 100.0);
    seed_thread(base, "bbbb2222", 300.0);
    seed_thread(base, "bbbb3333", 200.0);

    let latest = find_resume_thread(base, &ResumeTarget::Latest).unwrap();
    assert_eq!(latest["id"], "bbbb2222");

    let by_prefix = find_resume_thread(base, &ResumeTarget::Id("aaaa".into())).unwrap();
    assert_eq!(by_prefix["id"], "aaaa1111");

    assert!(find_resume_thread(base, &ResumeTarget::Id("zz".into()))
        .unwrap_err()
        .contains("no thread matches"));
    assert!(find_resume_thread(base, &ResumeTarget::Id("bbbb".into()))
        .unwrap_err()
        .contains("ambiguous"));
}

#[test]
fn find_resume_thread_skips_corrupted_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    seed_thread(base, "good1111", 100.0);
    let bad = "bad02222";
    std::fs::create_dir_all(get_thread_dir(base, bad)).unwrap();
    std::fs::write(get_thread_metadata_path(base, bad), "{not json").unwrap();

    let latest = find_resume_thread(base, &ResumeTarget::Latest).unwrap();
    assert_eq!(latest["id"], "good1111");
}

fn write_thread_files(base: &std::path::Path, id: &str, meta: &str, lines: &[&str]) {
    std::fs::create_dir_all(get_thread_dir(base, id)).unwrap();
    std::fs::write(get_thread_metadata_path(base, id), meta).unwrap();
    std::fs::write(get_messages_path(base, id), format!("{}\n", lines.join("\n"))).unwrap();
}

fn ids_of(v: &[serde_json::Value]) -> Vec<String> {
    v.iter().map(|m| m["id"].as_str().unwrap().to_string()).collect()
}

#[test]
fn list_messages_shows_the_active_versions_unless_all_are_asked_for() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    write_thread_files(
        base,
        "br000001",
        r#"{"id":"br000001","metadata":{}}"#,
        &[
            r#"{"id":"u1","created_at":1,"metadata":{"parentId":null}}"#,
            r#"{"id":"a1","created_at":2,"metadata":{"parentId":"u1"}}"#,
            r#"{"id":"a1b","created_at":3,"metadata":{"parentId":"u1"}}"#,
        ],
    );
    let shown = cli_list_messages_active_in(base, "br000001", false).unwrap();
    assert_eq!(ids_of(&shown), ["u1", "a1b"]);
    let all = cli_list_messages_active_in(base, "br000001", true).unwrap();
    assert_eq!(ids_of(&all), ["u1", "a1", "a1b"]);
}

#[test]
fn list_messages_follows_the_threads_chosen_root() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    write_thread_files(
        base,
        "br000002",
        r#"{"id":"br000002","metadata":{"activeRootId":"r1"}}"#,
        &[
            r#"{"id":"r1","created_at":1,"metadata":{"parentId":null}}"#,
            r#"{"id":"r2","created_at":2,"metadata":{"parentId":null}}"#,
        ],
    );
    let shown = cli_list_messages_active_in(base, "br000002", false).unwrap();
    assert_eq!(ids_of(&shown), ["r1"]);
}

#[test]
fn list_messages_leaves_a_legacy_linear_thread_whole() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    write_thread_files(
        base,
        "lin00001",
        r#"{"id":"lin00001"}"#,
        &[
            r#"{"id":"m1","role":"user"}"#,
            r#"{"id":"m2","role":"assistant"}"#,
        ],
    );
    let shown = cli_list_messages_active_in(base, "lin00001", false).unwrap();
    assert_eq!(ids_of(&shown), ["m1", "m2"]);
}

#[test]
fn read_messages_lenient_skips_truncated_tail() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    seed_thread(base, "aaaa1111", 100.0);
    let mut raw = std::fs::read_to_string(get_messages_path(base, "aaaa1111")).unwrap();
    raw.push_str("{\"role\":\"assist");
    std::fs::write(get_messages_path(base, "aaaa1111"), raw).unwrap();

    let (messages, skipped) = cli_read_messages_lenient(base, "aaaa1111").unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(skipped, 1);
    // The shared reader accepts this shape too now: an unterminated final
    // line is what an interrupted append leaves, and refusing the whole
    // thread over it made a conversation unreadable (janhq/jan#8019).
    assert_eq!(cli_list_messages_in(base, "aaaa1111").unwrap().len(), 1);
}

#[test]
fn the_shared_reader_still_rejects_corruption_before_the_tail() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    seed_thread(base, "bbbb2222", 100.0);
    let raw = std::fs::read_to_string(get_messages_path(base, "bbbb2222")).unwrap();
    std::fs::write(
        get_messages_path(base, "bbbb2222"),
        format!("not json\n{raw}"),
    )
    .unwrap();

    assert!(cli_list_messages_in(base, "bbbb2222").is_err());
}

#[test]
fn read_messages_lenient_on_missing_thread_is_empty() {
    let dir = tempfile::tempdir().unwrap();
    let (messages, skipped) = cli_read_messages_lenient(dir.path(), "nope").unwrap();
    assert!(messages.is_empty());
    assert_eq!(skipped, 0);
}

#[test]
fn saved_thread_file_has_no_raw_secrets_but_keeps_prose() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    let history = vec![
        serde_json::json!({ "role": "user", "content": "run it" }),
        serde_json::json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "call_1", "type": "function",
                "function": {"name": "bash", "arguments":
                    "{\"command\":\"curl -H 'Authorization: Bearer abcdefghij1234567890' https://x.test\"}"}
            }],
        }),
        serde_json::json!({
            "role": "tool", "tool_call_id": "call_1",
            "content": "API_KEY= hunter2x\n{\"token\":\"abcdefghij\"}\nPATH=/usr/bin max_tokens 4096",
        }),
    ];
    let id = cli_save_thread(base, None, "m", &history, None).unwrap();
    let text = std::fs::read_to_string(get_messages_path(base, &id)).unwrap();
    for secret in ["hunter2x", "abcdefghij1234567890", "abcdefghij\\\""] {
        assert!(!text.contains(secret), "{secret} reached disk: {text}");
    }
    assert!(text.contains("PATH=/usr/bin max_tokens 4096"), "{text}");
    for line in text.lines() {
        serde_json::from_str::<serde_json::Value>(line).expect("line parses");
    }
    let calls = &read_messages_from_file(base, &id).unwrap()[1]["tool_calls"];
    assert_eq!(calls[0]["id"], "call_1");
    let args = calls[0]["function"]["arguments"].as_str().unwrap();
    serde_json::from_str::<serde_json::Value>(args).expect("arguments stay JSON");
}

#[test]
fn resave_keeps_ids_and_timestamps_of_unchanged_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    let mut history = vec![
        serde_json::json!({ "role": "user", "content": "first" }),
        serde_json::json!({ "role": "assistant", "content": "reply" }),
    ];
    let id = cli_save_thread(base, None, "m", &history, None).unwrap();
    let before = read_messages_from_file(base, &id).unwrap();
    history.push(serde_json::json!({ "role": "user", "content": "second" }));
    cli_save_thread(base, Some(&id), "m", &history, None).unwrap();
    let after = read_messages_from_file(base, &id).unwrap();
    assert_eq!(after.len(), 3);
    for i in 0..2 {
        for key in ["id", "created_at", "completed_at"] {
            assert_eq!(before[i][key], after[i][key], "record {i} {key}");
        }
    }
}

#[test]
fn resave_after_edit_mints_new_tail_only() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    let history = vec![
        serde_json::json!({ "role": "user", "content": "first" }),
        serde_json::json!({ "role": "assistant", "content": "reply" }),
        serde_json::json!({ "role": "user", "content": "second" }),
    ];
    let id = cli_save_thread(base, None, "m", &history, None).unwrap();
    let before = read_messages_from_file(base, &id).unwrap();
    let mut edited = history.clone();
    edited[1] = serde_json::json!({ "role": "assistant", "content": "changed" });
    cli_save_thread(base, Some(&id), "m", &edited, None).unwrap();
    let after = read_messages_from_file(base, &id).unwrap();
    assert_eq!(before[0]["id"], after[0]["id"]);
    assert_ne!(before[1]["id"], after[1]["id"]);
    assert_ne!(before[2]["id"], after[2]["id"]);
}

#[test]
fn resume_cycle_preserves_thread_id_and_history() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    let history = vec![
        serde_json::json!({ "role": "user", "content": "first" }),
        serde_json::json!({ "role": "assistant", "content": "reply" }),
    ];
    let id = cli_save_thread(base, None, "m", &history, None).unwrap();

    let resumed =
        load_resume_history(base, &ResumeRequest::resume(ResumeTarget::Latest)).unwrap();
    assert_eq!(resumed.thread_id, id);
    assert_eq!(resumed.history, history);

    // Continue the session and save back: same thread, appended turns.
    let mut extended = resumed.history;
    extended.push(serde_json::json!({ "role": "user", "content": "second" }));
    let same = cli_save_thread(base, Some(&id), "m", &extended, None).unwrap();
    assert_eq!(same, id);
    assert_eq!(list_threads_in(base).unwrap().len(), 1);
    assert_eq!(
        load_resume_history(
            base,
            &ResumeRequest::resume(ResumeTarget::Id(id[..8].to_string())),
        )
        .unwrap()
        .history,
        extended
    );
}

fn call(id: &str, name: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "type": "function",
        "function": { "name": name, "arguments": "{\"path\":\"a.txt\"}" },
    })
}

#[test]
fn tool_calls_and_results_survive_a_save_resume_cycle() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    let history = vec![
        serde_json::json!({ "role": "user", "content": "do it" }),
        serde_json::json!({ "role": "assistant", "content": "", "tool_calls": [call("c1", "write")] }),
        serde_json::json!({ "role": "tool", "tool_call_id": "c1", "content": "wrote 1 line" }),
        serde_json::json!({ "role": "assistant", "content": "Done." }),
    ];
    let id = cli_save_thread(base, None, "m", &history, None).unwrap();

    let resumed =
        load_resume_history(base, &ResumeRequest::resume(ResumeTarget::Latest)).unwrap();
    assert_eq!(resumed.thread_id, id);
    assert_eq!(
        resumed.history, history,
        "the model must see the tools it ran, not just its own text"
    );
}

#[test]
fn a_call_whose_result_was_never_saved_gets_one() {
    // A crash between the call and its result leaves the pair broken, and an
    // OpenAI-compatible upstream rejects an unanswered `tool_call_id`.
    let messages = vec![
        serde_json::json!({ "role": "assistant", "content": "", "tool_calls": [call("c1", "write"), call("c2", "read")] }),
        serde_json::json!({ "role": "tool", "tool_call_id": "c1", "content": "ok" }),
        serde_json::json!({ "role": "user", "content": "next" }),
    ];
    let out = rebuild_wire_history(&messages);
    assert_eq!(out.len(), 4);
    assert_eq!(out[2]["role"], "tool");
    assert_eq!(out[2]["tool_call_id"], "c2");
    assert!(
        out[2]["content"].as_str().unwrap().contains("not saved"),
        "the gap is stated, not invented: {}",
        out[2]["content"]
    );
    assert_eq!(out[3]["role"], "user");
}

#[test]
fn an_orphan_tool_message_is_dropped() {
    let messages = vec![
        serde_json::json!({ "role": "tool", "tool_call_id": "gone", "content": "stale" }),
        serde_json::json!({ "role": "user", "content": "hi" }),
    ];
    let out = rebuild_wire_history(&messages);
    assert_eq!(out.len(), 1, "a result with no call would be rejected");
    assert_eq!(out[0]["role"], "user");
}

#[test]
fn rebuild_drops_messages_that_carry_nothing() {
    let messages = vec![
        serde_json::json!({ "role": "assistant", "content": "" }),
        serde_json::json!({ "role": "user", "content": "hi" }),
        serde_json::json!({ "role": "system", "content": "ignored" }),
    ];
    let out = rebuild_wire_history(&messages);
    assert_eq!(
        out,
        vec![serde_json::json!({ "role": "user", "content": "hi" })]
    );
}

#[test]
fn completion_text_extracts_assistant_content() {
    let completion = serde_json::json!({ "choices": [{ "message": { "content": "hello" } }] });
    assert_eq!(completion_text(&completion).as_deref(), Some("hello"));
    assert_eq!(completion_text(&serde_json::json!({})), None);
    assert_eq!(
        completion_text(&serde_json::json!({ "choices": [{ "message": { "content": "" } }] })),
        None
    );
}

// ── invocation_label / default_thread_title ────────────────────────────

#[test]
fn invocation_label_recognizes_skill_and_command_wrappers() {
    assert_eq!(
        invocation_label(
            "[IMPORTANT: You have invoked the \"deploy\" skill - follow its instructions. The full skill content is loaded below.]\n\nBody."
        ),
        Some("[skill:deploy]".to_string())
    );
    assert_eq!(
        invocation_label(
            "[IMPORTANT: You have invoked the \"feature-dev\" command - follow its instructions. The full command content is loaded below.]\n\nBuild: $ARGUMENTS"
        ),
        Some("[command:feature-dev]".to_string())
    );
    // Anything that is not the exact machine wrapper stays None.
    assert_eq!(invocation_label("deploy"), None);
    assert_eq!(
        invocation_label("[IMPORTANT: You have invoked the \"\" skill - x"),
        None
    );
    assert_eq!(
        invocation_label("[IMPORTANT: You have invoked the \"deploy\" skill"), // truncated wrapper
        None
    );
    assert_eq!(
        invocation_label("[IMPORTANT: You have invoked the \"deploy\""), // no kind
        None
    );
}

#[test]
fn default_thread_title_uses_invocation_label_for_first_message() {
    let history = serde_json::json!([{
        "role": "user",
        "content": "[IMPORTANT: You have invoked the \"feature-dev\" command - follow its instructions. The full command content is loaded below.]\n\nBuild: auth"
    }]);
    assert_eq!(
        default_thread_title(history.as_array().unwrap()),
        "[command:feature-dev]"
    );
}

#[test]
fn default_thread_title_uses_first_user_message() {
    let history = serde_json::json!([
        { "role": "user", "content": "Explain   the  buffer\nlogic" },
        { "role": "assistant", "content": "sure" },
    ]);
    assert_eq!(
        default_thread_title(history.as_array().unwrap()),
        "Explain the buffer logic"
    );
}

#[test]
fn image_part_survives_save_and_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let url = "data:image/png;base64,QUJD";
    let history = vec![
        serde_json::json!({ "role": "user", "content": [
            { "type": "text", "text": "what is this" },
            { "type": "image_url", "image_url": { "url": url, "detail": "high" } },
        ]}),
        serde_json::json!({ "role": "assistant", "content": "a picture" }),
    ];
    let id = cli_save_thread(dir.path(), None, "m", &history, None).unwrap();
    let (records, _) = cli_read_messages_lenient(dir.path(), &id).unwrap();
    let stored = records[0]["content"].as_array().unwrap();
    assert_eq!(stored[0]["type"], "text");
    assert_eq!(stored[1]["type"], "image_url");
    assert_eq!(stored[1]["image_url"]["url"], url);
    let rebuilt = rebuild_wire_history(&records);
    assert_eq!(rebuilt[0]["content"][0], serde_json::json!({ "type": "text", "text": "what is this" }));
    assert_eq!(rebuilt[0]["content"][1]["image_url"]["url"], url);
    assert_eq!(rebuilt[1]["content"], "a picture");
}

#[test]
fn image_only_message_is_not_dropped_on_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let history = vec![serde_json::json!({ "role": "user", "content": [
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,QUJD" } },
    ]})];
    let id = cli_save_thread(dir.path(), None, "m", &history, None).unwrap();
    let (records, _) = cli_read_messages_lenient(dir.path(), &id).unwrap();
    let rebuilt = rebuild_wire_history(&records);
    assert_eq!(rebuilt.len(), 1);
    assert_eq!(rebuilt[0]["content"][0]["type"], "image_url");
}

#[test]
fn sink_safe_escapes_only_for_a_terminal() {
    assert_eq!(sink_safe("a\u{1b}]0;pwned\u{7}b", true), "a^[]0;pwned^Gb");
    assert!(matches!(sink_safe("a\u{1b}[2Jb", false), std::borrow::Cow::Borrowed(_)));
    assert_eq!(sink_safe("line one\n\tline two", true), "line one\n\tline two");
}

#[test]
fn openai_content_text_reads_multimodal_array() {
    let content = serde_json::json!([
        { "type": "text", "text": "describe" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,AA" } },
    ]);
    assert_eq!(openai_content_text(Some(&content)), "describe");
    assert_eq!(
        openai_content_text(Some(&serde_json::json!("plain"))),
        "plain"
    );
}

#[test]
fn default_thread_title_uses_multimodal_user_text() {
    let history = serde_json::json!([{
        "role": "user",
        "content": [
            { "type": "text", "text": "look at this" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,AA" } },
        ],
    }]);
    assert_eq!(
        default_thread_title(history.as_array().unwrap()),
        "look at this"
    );
}

#[test]
fn default_thread_title_truncates_and_falls_back() {
    let long = "x".repeat(80);
    let history = serde_json::json!([{ "role": "user", "content": long }]);
    let title = default_thread_title(history.as_array().unwrap());
    assert_eq!(title.chars().count(), 50);
    assert!(title.ends_with('…'));

    let no_user = serde_json::json!([{ "role": "assistant", "content": "hi" }]);
    assert_eq!(
        default_thread_title(no_user.as_array().unwrap()),
        "Agent chat"
    );
}

// ── cli_save_thread metadata (snapshot bookkeeping) ────────────────────

#[test]
fn save_thread_persists_and_preserves_snapshot_metadata() {
    let base = std::env::temp_dir().join(format!(
        "jan_savethread_{}_{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let history = serde_json::json!([
        { "role": "user", "content": "hi" },
        { "role": "assistant", "content": "hello" },
    ]);
    let meta = serde_json::json!({
        "base_snapshot": "abc",
        "checkpoints": [{ "user_index": 0, "preview": "hi", "sha": "def" }],
    });

    let id = cli_save_thread(
        &base,
        None,
        "m",
        history.as_array().unwrap(),
        Some(meta.clone()),
    )
    .expect("save");

    let raw = std::fs::read_to_string(get_thread_metadata_path(&base, &id)).expect("read");
    let stored: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(stored["metadata"]["base_snapshot"], "abc");
    assert_eq!(stored["metadata"]["checkpoints"][0]["sha"], "def");

    // A follow-up save with no metadata must preserve the prior snapshot block.
    cli_save_thread(&base, Some(&id), "m", history.as_array().unwrap(), None).expect("resave");
    let raw = std::fs::read_to_string(get_thread_metadata_path(&base, &id)).expect("read2");
    let stored: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(stored["metadata"]["base_snapshot"], "abc");

    let _ = std::fs::remove_dir_all(&base);
}

// ── prepare_agent_session model resolution ────────────────────────────

/// A project's `agent.toml` naming a model must not paper over "nothing can
/// actually serve it": with no provider configured (this repo's own
/// agent.toml pins `tokamak-1-preview`, but a fresh `~/.jan` has no
/// credentials for it), the TUI path must still come back with an empty
/// model so its sign-in notice fires instead of a first-message failure.
#[test]
fn tui_session_ignores_a_project_model_with_no_usable_provider() {
    crate::core::agent::global_config::with_temp_home(|_| {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("agent.toml"),
            "[agent]\nmodel = \"tokamak-1-preview\"\n",
        )
        .unwrap();

        let session = prepare_agent_session(
            dir.path().to_str().unwrap(),
            None,
            ProviderOverrides::default(),
            SessionFlags::default(),
            None,
        )
        .expect("TUI session prep must not fail with nothing configured");
        assert_eq!(session.model, "");
    });
}

/// End-to-end for the sign-in gate, arranged so the pre-existing
/// "nothing usable is configured" guard cannot mask it: a usable non-Tokamak
/// provider is present (so the guard passes) but names no models (so
/// `default_model` contributes nothing), leaving the desktop inherit as the
/// only thing that could supply a model. Signed out, it must not.
#[test]
fn a_signed_out_session_does_not_adopt_the_desktop_model() {
    crate::core::agent::global_config::with_temp_home(|home| {
        crate::core::agent::global_config::set_provider(
            "openai",
            crate::core::agent::global_config::ProviderUpdate {
                api_key: Some("sk-test".into()),
                base_url: Some("https://api.openai.com/v1".into()),
                models: Some(vec![]),
                ..Default::default()
            },
        )
        .expect("seed provider");

        let data = home.join("jan-data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(
            data.join("settings.json"),
            r#"{"model-provider":"{\"state\":{\"selectedProvider\":\"llamacpp\",\"selectedModel\":{\"id\":\"gemma-4-E2B-it-IQ4_XS\"}}}"}"#,
        )
        .unwrap();
        std::env::set_var("JAN_DATA_FOLDER", &data);

        // Sanity: the desktop selection really is readable, so a passing
        // assertion below means the gate fired, not that the fixture is dead.
        assert_eq!(
            crate::core::cli::providers::desktop_selection()
                .model
                .as_deref(),
            Some("gemma-4-E2B-it-IQ4_XS")
        );
        assert!(!crate::core::cli::tokamak::auth_status().signed_in);

        let dir = tempfile::tempdir().unwrap();
        let session = prepare_agent_session(
            dir.path().to_str().unwrap(),
            None,
            ProviderOverrides::default(),
            SessionFlags::default(),
            None,
        )
        .expect("session prep");
        std::env::remove_var("JAN_DATA_FOLDER");

        assert_eq!(
            session.model, "",
            "signed out, the desktop's last selection must not become the session model"
        );
    });
}

/// The same project config, once a provider is actually usable, must be
/// trusted again.
#[test]
fn tui_session_honors_a_project_model_once_a_provider_is_usable() {
    crate::core::agent::global_config::with_temp_home(|_| {
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
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("agent.toml"),
            "[agent]\nmodel = \"tokamak-1-preview\"\n",
        )
        .unwrap();

        let session = prepare_agent_session(
            dir.path().to_str().unwrap(),
            None,
            ProviderOverrides::default(),
            SessionFlags::default(),
            None,
        )
        .expect("session prep");
        assert_eq!(session.model, "tokamak-1-preview");
    });
}

// ── fork ───────────────────────────────────────────────────────────────

/// Three user turns, each with a tool call and its result, plus the journal
/// the TUI would have written for them.
fn seed_forkable(base: &std::path::Path) -> String {
    let mut history = Vec::new();
    for n in 0..3 {
        history.push(serde_json::json!({ "role": "user", "content": format!("turn {n}") }));
        history.push(serde_json::json!({
            "role": "assistant", "content": "", "tool_calls": [call(&format!("c{n}"), "write")]
        }));
        history.push(serde_json::json!({
            "role": "tool", "tool_call_id": format!("c{n}"), "content": "ok"
        }));
        history
            .push(serde_json::json!({ "role": "assistant", "content": format!("done {n}") }));
    }
    let id = cli_save_thread(base, None, "m", &history, None).unwrap();
    let entries: Vec<journal::DisplayEntry> = (0..3)
        .flat_map(|n| {
            vec![
                journal::DisplayEntry::User {
                    text: format!("turn {n}"),
                    images: Vec::new(),
                },
                journal::DisplayEntry::ToolCall {
                    id: format!("c{n}"),
                    name: "write".into(),
                    args: serde_json::json!({ "path": "a.txt" }),
                },
                journal::DisplayEntry::ToolResult {
                    id: format!("c{n}"),
                    content: "ok".into(),
                    is_error: false,
                    diff: None,
                },
                journal::DisplayEntry::Assistant {
                    text: format!("done {n}"),
                    reasoning: Vec::new(),
                    reasoning_ms: None,
                },
            ]
        })
        .collect();
    journal::write_journal(&journal::journal_path(base, &id), &entries).unwrap();
    id
}

#[test]
fn fork_carries_the_prefix_of_both_files_and_leaves_the_source_alone() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    let source = seed_forkable(base);
    let before_messages = std::fs::read(get_messages_path(base, &source)).unwrap();
    let before_journal = std::fs::read(journal::journal_path(base, &source)).unwrap();

    let forked = fork_thread(base, &source, Some(2)).unwrap();
    assert_ne!(forked, source);

    // Two user turns, each still holding its call/result pair.
    let history = load_resume_history(
        base,
        &ResumeRequest::resume(ResumeTarget::Id(forked.clone())),
    )
    .unwrap()
    .history;
    assert_eq!(user_turn_count(&history), 2);
    assert_eq!(history.len(), 8);
    assert!(history
        .iter()
        .all(|m| !thread_message_text(m).contains("turn 2")));
    assert_eq!(
        history
            .iter()
            .filter(|m| m.get("role").and_then(|v| v.as_str()) == Some("tool"))
            .count(),
        2,
        "every carried call keeps its result"
    );

    let journal = journal::read_journal(&journal::journal_path(base, &forked));
    assert_eq!(
        journal.len(),
        8,
        "tool rows were carried, not just the wire history"
    );
    assert!(
        matches!(journal.last(), Some(journal::DisplayEntry::Assistant { text, .. }) if text == "done 1")
    );

    assert_eq!(
        std::fs::read(get_messages_path(base, &source)).unwrap(),
        before_messages,
        "a fork must not touch the thread it came from"
    );
    assert_eq!(
        std::fs::read(journal::journal_path(base, &source)).unwrap(),
        before_journal
    );
}

#[test]
fn fork_records_its_immediate_parent() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    let source = seed_forkable(base);

    let child = fork_thread(base, &source, Some(2)).unwrap();
    let grandchild = fork_thread(base, &child, Some(1)).unwrap();

    let meta =
        |id: &str| cli_get_thread_in(base, id).unwrap()["metadata"][FORKED_FROM_KEY].clone();
    assert_eq!(
        meta(&child),
        serde_json::json!({ "thread_id": source, "user_turn": 2 })
    );
    assert_eq!(
        meta(&grandchild),
        serde_json::json!({ "thread_id": child, "user_turn": 1 }),
        "forking a fork names the fork, not the root"
    );
}

#[test]
fn a_whole_thread_fork_records_every_turn_and_keeps_them() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    let source = seed_forkable(base);

    let forked = fork_thread(base, &source, None).unwrap();
    let thread = cli_get_thread_in(base, &forked).unwrap();
    assert_eq!(thread["metadata"][FORKED_FROM_KEY]["user_turn"], 3);
    assert_eq!(
        journal::read_journal(&journal::journal_path(base, &forked)).len(),
        12
    );
}

#[test]
fn fork_refuses_a_cut_that_would_keep_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    let source = seed_forkable(base);
    assert!(fork_thread(base, &source, Some(0)).is_err());
    assert!(fork_thread(base, &source, Some(9)).is_err());
    assert!(fork_thread(base, "nope", None).is_err());
    assert_eq!(
        list_threads_in(base).unwrap().len(),
        1,
        "a refused fork leaves no half-built thread behind"
    );
}

/// A fork drops the checkpoints for turns it does not have: restoring the
/// workspace to one of them would put the branch in a state it never saw.
#[test]
fn fork_drops_checkpoints_past_the_cut() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    let source = seed_forkable(base);
    let history = cli_read_messages_lenient(base, &source).unwrap().0;
    cli_save_thread(
        base,
        Some(&source),
        "m",
        &rebuild_wire_history(&history),
        Some(serde_json::json!({
            "base_snapshot": "aaa",
            "checkpoints": [
                { "user_index": 0, "preview": "turn 0", "sha": "s0" },
                { "user_index": 2, "preview": "turn 2", "sha": "s2" },
            ],
        })),
    )
    .unwrap();

    let forked = fork_thread(base, &source, Some(2)).unwrap();
    let meta = cli_get_thread_in(base, &forked).unwrap()["metadata"].clone();
    assert_eq!(
        meta["base_snapshot"], "aaa",
        "the branch shares the base commit"
    );
    assert_eq!(meta["checkpoints"].as_array().unwrap().len(), 1);
    assert_eq!(meta["checkpoints"][0]["sha"], "s0");
}

#[test]
fn resume_request_from_flags() {
    assert_eq!(ResumeRequest::from_flags(None, false, false), None);
    assert_eq!(
        ResumeRequest::from_flags(None, false, true),
        Some(ResumeRequest::fork(ResumeTarget::Latest)),
        "--fork-session alone branches the most recent session"
    );
    assert_eq!(
        ResumeRequest::from_flags(Some(Some("3f7a".into())), false, true),
        Some(ResumeRequest::fork(ResumeTarget::Id("3f7a".into())))
    );
    assert_eq!(
        ResumeRequest::from_flags(None, true, false),
        Some(ResumeRequest::resume(ResumeTarget::Latest))
    );
}

#[test]
fn resolve_resume_forks_into_a_new_id_and_leaves_the_source_resumable() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    let source = seed_forkable(base);

    let opened = resolve_resume(base, &ResumeRequest::fork(ResumeTarget::Latest)).unwrap();
    let forked = opened["id"].as_str().unwrap().to_string();
    assert_ne!(forked, source);
    assert_eq!(opened["metadata"][FORKED_FROM_KEY]["thread_id"], source);
    assert_eq!(
        load_resume_history(
            base,
            &ResumeRequest::resume(ResumeTarget::Id(source.clone()))
        )
        .unwrap()
        .thread_id,
        source,
        "the source is still there to resume"
    );
}

#[test]
fn thread_forest_nests_forks_and_keeps_orphans_as_roots() {
    let node = |id: &str, updated: f64, parent: Option<&str>| {
        let mut t = serde_json::json!({ "id": id, "updated": updated, "metadata": {} });
        if let Some(p) = parent {
            t["metadata"][FORKED_FROM_KEY] =
                serde_json::json!({ "thread_id": p, "user_turn": 1 });
        }
        t
    };
    let rows = thread_forest(vec![
        node("root", 1.0, None),
        node("child-old", 2.0, Some("root")),
        node("child-new", 3.0, Some("root")),
        node("grandchild", 4.0, Some("child-new")),
        node("orphan", 5.0, Some("deleted")),
    ]);
    let shape: Vec<(String, usize)> = rows
        .iter()
        .map(|n| (n.thread["id"].as_str().unwrap().to_string(), n.depth))
        .collect();
    assert_eq!(
        shape,
        vec![
            ("orphan".into(), 0),
            ("root".into(), 0),
            ("child-new".into(), 1),
            ("grandchild".into(), 2),
            ("child-old".into(), 1),
        ]
    );
    assert!(
        rows.iter()
            .find(|n| n.thread["id"] == "child-old")
            .unwrap()
            .last
    );
}

/// A store with no forks is today's flat, most-recent-first list.
#[test]
fn thread_forest_of_unforked_threads_is_the_flat_list() {
    let threads = vec![
        serde_json::json!({ "id": "a", "updated": 1.0 }),
        serde_json::json!({ "id": "b", "updated": 2.0 }),
    ];
    let rows = thread_forest(threads);
    assert!(rows.iter().all(|n| n.depth == 0));
    assert_eq!(rows[0].thread["id"], "b");
}

/// A fork cycle is reachable from no root; listing it flat beats dropping
/// the sessions from `/tree` entirely.
#[test]
fn thread_forest_survives_a_cycle() {
    let rows = thread_forest(vec![
        serde_json::json!({ "id": "a", "updated": 1.0, "metadata": { FORKED_FROM_KEY: { "thread_id": "b" } } }),
        serde_json::json!({ "id": "b", "updated": 2.0, "metadata": { FORKED_FROM_KEY: { "thread_id": "a" } } }),
    ]);
    assert_eq!(rows.len(), 2);
}

// ── worktree ───────────────────────────────────────────────────────────

#[test]
fn a_fork_never_inherits_the_parent_checkout() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    let source = seed_forkable(base);
    let history = cli_read_messages_lenient(base, &source).unwrap().0;
    cli_save_thread(
        base,
        Some(&source),
        "m",
        &rebuild_wire_history(&history),
        Some(serde_json::json!({
            "base_snapshot": "aaa",
            worktree::WORKTREE_KEY: {
                "path": "/home/u/.jan/worktrees/jan-abc/deadbeef",
                "branch": "jan/agent/deadbeef",
            },
        })),
    )
    .unwrap();

    let forked = fork_thread(base, &source, Some(2)).unwrap();
    let meta = cli_get_thread_in(base, &forked).unwrap()["metadata"].clone();
    assert_eq!(
        worktree::from_metadata(Some(&meta)),
        None,
        "two conversations must not edit one checkout"
    );
    assert_eq!(
        meta["base_snapshot"], "aaa",
        "the rest of the bookkeeping is kept"
    );
    // The source still names its own.
    let source_meta = cli_get_thread_in(base, &source).unwrap()["metadata"].clone();
    assert!(worktree::from_metadata(Some(&source_meta)).is_some());
}

/// A fork branches from where the source conversation left off, so the
/// files match the transcript it inherited.
#[test]
fn latest_snapshot_prefers_the_newest_checkpoint() {
    let thread = serde_json::json!({ "metadata": {
        "base_snapshot": "base",
        "checkpoints": [
            { "user_index": 0, "preview": "one", "sha": "s0" },
            { "user_index": 1, "preview": "two", "sha": "s1" },
        ],
    }});
    assert_eq!(latest_snapshot(Some(&thread)).as_deref(), Some("s1"));

    // No checkpoints yet: the base snapshot is still better than HEAD.
    let fresh = serde_json::json!({ "metadata": { "base_snapshot": "base" } });
    assert_eq!(latest_snapshot(Some(&fresh)).as_deref(), Some("base"));
    // Nothing recorded at all leaves the choice to the caller (HEAD).
    assert_eq!(latest_snapshot(None), None);
    assert_eq!(
        latest_snapshot(Some(&serde_json::json!({ "metadata": {} }))),
        None
    );
}

/// Off by default, and off costs nothing: no git call, no directory.
#[test]
fn no_worktree_is_resolved_when_nothing_asks_for_one() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, note) = resolve_workspace(dir.path(), None, None);
    assert_eq!(workspace, None);
    assert_eq!(note, None);
}

/// Asking for a worktree outside a repository is not fatal: the session runs
/// in the project directory and is told why.
#[test]
fn a_worktree_outside_a_repository_falls_back_with_a_reason() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, note) = resolve_workspace(dir.path(), Some(true), None);
    assert_eq!(workspace, None);
    assert!(
        note.is_some_and(|n| n.contains("not a git repository")),
        "the fallback has to say why"
    );
}

/// The regression behind a real failure: a headless run recorded no
/// checkout, so the next `--resume` branched a fresh worktree and the model
/// read a pristine tree, losing everything the run it continued had done.
#[test]
fn a_saved_thread_names_the_checkout_the_run_worked_in() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    let workspace = worktree::Worktree {
        path: std::path::PathBuf::from("/home/u/.jan/worktrees/p-abc/deadbeef"),
        branch: "jan/agent/deadbeef".to_string(),
    };
    let history = vec![serde_json::json!({ "role": "user", "content": "do it" })];

    let meta = worktree_metadata(base, None, Some(&workspace));
    let id = cli_save_thread(base, None, "m", &history, meta).unwrap();
    let saved = cli_get_thread_in(base, &id).unwrap();
    assert_eq!(
        worktree::from_metadata(saved.get("metadata")),
        Some(workspace.clone()),
        "a resume has to be able to find the checkout again"
    );

    // A second turn merges into what is already there rather than replacing
    // it, so the snapshot bookkeeping beside it survives.
    cli_save_thread(
        base,
        Some(&id),
        "m",
        &history,
        Some(serde_json::json!({
            "base_snapshot": "aaa",
            worktree::WORKTREE_KEY: worktree::to_metadata(&workspace),
        })),
    )
    .unwrap();
    let meta = worktree_metadata(base, Some(&id), Some(&workspace)).expect("some");
    assert_eq!(meta["base_snapshot"], "aaa");
    assert_eq!(
        worktree::from_metadata(Some(&meta)),
        Some(workspace),
        "and the pointer is still the one this run used"
    );

    // No worktree: `None` keeps `cli_save_thread`'s preserve-existing path.
    assert_eq!(worktree_metadata(base, Some(&id), None), None);
}

/// `agent run --worktree` has to leave the checkout on the thread it saves,
/// both at the start of the run and when it finishes, or `--resume` opens a
/// fresh worktree and loses the edits.
#[test]
fn headless_worktree_run_records_worktree_key() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    let workspace = worktree::Worktree {
        path: std::path::PathBuf::from("/home/u/.jan/worktrees/p-abc/cafe0001"),
        branch: "jan/agent/cafe0001".to_string(),
    };
    let history = vec![serde_json::json!({ "role": "user", "content": "do it" })];
    let persist = PersistTarget {
        agent_dir: base.to_path_buf(),
        thread_id: None,
        model: "m".to_string(),
        history,
        workspace: Some(workspace.clone()),
        ephemeral: false,
    };
    let result: Result<serde_json::Value, tauri_plugin_agent_tools::harness_error::HarnessError> =
        Ok(serde_json::json!({
            "choices": [{ "message": { "content": "done" } }]
        }));
    let run = persist_headless_run(persist, &result, None, Some("11111111-1111-4111-8111-111111111111"));
    assert!(run.saved);
    let id = run.session_id.expect("session id");
    let saved = cli_get_thread_in(base, &id).unwrap();
    assert_eq!(
        worktree::from_metadata(saved.get("metadata")),
        Some(workspace),
        "resume must find the checkout the run used"
    );
}

/// A headless run takes no snapshots, so without capturing the source's
/// checkout a fork opens on a pristine `HEAD` while the transcript it
/// inherited describes work that is not in it. Caught against a live model:
/// the fork's first `wc -l` disagreed with the answer it had just read.
#[test]
fn a_fork_base_captures_the_source_checkout_when_there_is_no_snapshot() {
    fn git(args: &[&str]) -> Option<String> {
        let out = std::process::Command::new("git").args(args).output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let r = repo.to_string_lossy().to_string();
    // Skip on a box without git rather than failing the suite.
    if git(&["-C", &r, "init", "-q"]).is_none() {
        return;
    }
    git(&["-C", &r, "config", "user.email", "a@b.c"]);
    git(&["-C", &r, "config", "user.name", "t"]);
    std::fs::write(repo.join("notes.txt"), "one\n").unwrap();
    git(&["-C", &r, "add", "-A"]);
    git(&["-C", &r, "commit", "-q", "-m", "init", "--no-gpg-sign"]).expect("commit");

    // A session worked in its own checkout: one tracked edit, one new file.
    let wt = dir.path().join("wt");
    let head = crate::core::agent::git::head_sha(&repo).expect("HEAD");
    crate::core::agent::git::worktree_add(&repo, &wt, "jan/agent/testfb", &head).unwrap();
    std::fs::write(wt.join("notes.txt"), "one\ntwo\n").unwrap();
    std::fs::write(wt.join("added.txt"), "new\n").unwrap();

    let source = serde_json::json!({
        "id": "src-thread",
        "metadata": { worktree::WORKTREE_KEY: {
            "path": wt.to_string_lossy(), "branch": "jan/agent/testfb",
        }},
    });
    let base = fork_base(Some(&source)).expect("the source checkout is captured");
    assert_ne!(
        base, head,
        "a fork must not start at a HEAD the work predates"
    );

    let show = |path: &str| git(&["-C", &r, "show", &format!("{base}:{path}")]);
    assert_eq!(
        show("notes.txt").as_deref(),
        Some("one\ntwo"),
        "the branch starts from the work the conversation did"
    );
    assert_eq!(
        show("added.txt").as_deref(),
        Some("new"),
        "untracked files the agent created are carried too"
    );

    // A recorded checkout the user deleted leaves the choice to HEAD.
    std::fs::remove_dir_all(&wt).unwrap();
    assert_eq!(fork_base(Some(&source)), None);
    // A source that recorded a snapshot uses it, no capture needed.
    let snapped = serde_json::json!({ "id": "s", "metadata": { "base_snapshot": "cafe" } });
    assert_eq!(fork_base(Some(&snapped)).as_deref(), Some("cafe"));
}

/// `--max-session-tokens` outranks `[budget].max_tokens`, which outranks
/// the built-in default; `0` from either source survives as the unbounded
/// marker `body_session_budget` expects rather than falling through.
/// The money ceiling resolves flag > config > none, and a run that asks
/// for one it cannot price is refused rather than run uncapped.
#[test]
fn a_cost_ceiling_is_refused_rather_than_run_uncapped() {
    let none = std::collections::BTreeMap::new();
    let unpriced = "no-such-model/never-priced";
    assert_eq!(resolve_cost_ceiling(None, None, &none, unpriced), Ok(None));
    let refused = resolve_cost_ceiling(Some(2.0), None, &none, unpriced)
        .expect_err("an unpriceable ceiling must not silently run uncapped");
    assert!(refused.contains("no price is declared"), "{refused}");
    assert!(resolve_cost_ceiling(None, Some(2.0), &none, unpriced).is_err());
    let precedence = resolve_cost_ceiling(Some(2.0), Some(9.0), &none, unpriced)
        .expect_err("still unpriceable");
    assert!(precedence.contains("$2") && !precedence.contains("$9"), "{precedence}");
    let negative = resolve_cost_ceiling(Some(-1.0), None, &none, unpriced)
        .expect_err("a negative ceiling is rejected");
    assert!(negative.contains("non-negative"), "{negative}");
    assert!(resolve_cost_ceiling(Some(f64::NAN), None, &none, unpriced).is_err());

    // A declared price (dollars per million) becomes per-token rates, and
    // a provider-qualified id finds a bare declaration.
    let mut prices = std::collections::BTreeMap::new();
    prices.insert(
        "claude-x".to_string(),
        crate::core::agent::spend::Price {
            input: 3.0,
            output: 15.0,
            cached_input: Some(0.3),
            cache_write: None,
        },
    );
    let ceiling = resolve_cost_ceiling(Some(0.0), None, &prices, "anthropic/claude-x")
        .expect("priced")
        .expect("a ceiling");
    assert_eq!(ceiling.max_usd, 0.0);
    assert!((ceiling.rates.prompt_usd - 3e-6).abs() < 1e-15);
    assert!((ceiling.rates.completion_usd - 15e-6).abs() < 1e-15);
    assert_eq!(ceiling.rates.cache_read_usd, Some(0.3 / 1_000_000.0));

    // It reaches the request body with its rates.
    let mut limits = limits_with(None, 0);
    limits.cost_ceiling = Some(ceiling);
    let body = request_body("m", &limits, true, serde_json::json!([]));
    assert_eq!(body["max_budget_usd"], 0.0);
    assert!(body["token_rates"]["prompt_usd"].as_f64().is_some());
    assert!(body.get("pause_at_usd").is_none(), "no pause unless one is set");

    // A pause with a ceiling travels beside it; a pause alone travels with
    // the rates and no ceiling at all.
    limits.pause_at_usd = Some(0.5);
    let body = request_body("m", &limits, true, serde_json::json!([]));
    assert_eq!(body["pause_at_usd"], 0.5);
    assert_eq!(body["max_budget_usd"], 0.0);
    limits.cost_ceiling = Some(crate::core::agent::session::CostCeiling { max_usd: f64::INFINITY, ..ceiling });
    let body = request_body("m", &limits, true, serde_json::json!([]));
    assert!(body.get("max_budget_usd").is_none(), "{body}");
    assert_eq!(body["pause_at_usd"], 0.5);
    assert!(body["token_rates"]["prompt_usd"].as_f64().is_some());
}

#[test]
fn a_pause_threshold_must_be_a_non_negative_amount() {
    assert_eq!(validate_pause_at_usd(None), Ok(None));
    assert_eq!(validate_pause_at_usd(Some(0.0)), Ok(Some(0.0)));
    assert_eq!(validate_pause_at_usd(Some(2.5)), Ok(Some(2.5)));
    assert!(validate_pause_at_usd(Some(-1.0)).is_err());
    assert!(validate_pause_at_usd(Some(f64::NAN)).is_err());
}

#[test]
fn session_budget_precedence_is_flag_then_config_then_default() {
    assert_eq!(
        resolve_session_budget(None, None, None),
        DEFAULT_MAX_SESSION_TOKENS
    );
    assert_eq!(resolve_session_budget(None, Some(50_000), None), 50_000);
    assert_eq!(resolve_session_budget(Some(20_000), Some(50_000), None), 20_000);
    assert_eq!(resolve_session_budget(Some(20_000), None, None), 20_000);
    assert_eq!(resolve_session_budget(Some(0), Some(50_000), None), 0);
    assert_eq!(resolve_session_budget(None, Some(0), None), 0);

    assert_eq!(session_budget_source(None, None, None), "default");
    assert_eq!(session_budget_source(None, Some(50_000), None), "agent.toml");
    assert_eq!(session_budget_source(Some(0), Some(50_000), None), "flag");
}

/// A known context window sets the ceiling when nothing else does, so a
/// 1M-context model is not compacted at the 128K default; an explicit
/// value still wins, and an unknown model keeps the default.
#[test]
fn a_known_context_window_sets_the_session_budget_by_default() {
    use crate::core::cli::model_capabilities::{
        ContextWindowSource, ResolvedContextWindow,
    };
    let window = Some(1_000_000);
    assert_eq!(resolve_session_budget(None, None, window), 1_000_000);
    assert_eq!(session_budget_source(None, None, window), "context_window");
    assert_eq!(resolve_session_budget(None, Some(50_000), window), 50_000);
    assert_eq!(resolve_session_budget(Some(20_000), None, window), 20_000);
    assert_eq!(resolve_session_budget(None, Some(0), window), 0, "0 still disables");

    let guess = ResolvedContextWindow {
        tokens: 128_000,
        source: ContextWindowSource::Fallback,
    };
    assert_eq!(known_window(guess), None, "the fallback guess is not a window");
    let catalog = ResolvedContextWindow {
        tokens: 1_000_000,
        source: ContextWindowSource::Catalog,
    };
    assert_eq!(known_window(catalog), Some(1_000_000));
}

fn limits_with(max_turns: Option<u64>, max_session_tokens: u64) -> SessionLimits {
    SessionLimits {
        context_window: 128_000,
        context_window_source:
            crate::core::cli::model_capabilities::ContextWindowSource::Fallback,
        reserve_tokens: 16_384,
        compaction: Default::default(),
        max_tokens: None,
        max_session_tokens,
        max_session_tokens_pinned: true,
        max_turns,
        cost_ceiling: None,
        pause_at_usd: None,
    }
}

/// The write side of the caps: the limits have to reach the request body in
/// the encoding `body_turn_cap` / `body_session_budget` read back, or the
/// flags are inert. `max_turns` is absent (not `0`) when unset, so a caller
/// that never passes it is byte-identical to before the flag existed.
#[test]
fn run_limits_reach_the_request_body() {
    let messages = serde_json::json!([]);

    let unset = request_body("m", &limits_with(None, 128_000), true, messages.clone());
    assert!(
        unset.get("max_turns").is_none(),
        "an unset cap must not write the field at all: {unset}"
    );
    assert_eq!(unset["max_session_tokens"], 128_000);

    // What `agent step` pins, and what `--max-turns 5` pins, by the same route.
    let stepped = request_body("m", &limits_with(Some(1), 128_000), true, messages.clone());
    assert_eq!(stepped["max_turns"], 1);
    let capped = request_body("m", &limits_with(Some(5), 20_000), true, messages.clone());
    assert_eq!(capped["max_turns"], 5);
    assert_eq!(capped["max_session_tokens"], 20_000);

    // An explicit 0 is the engine's "unbounded" encoding and must survive as
    // itself rather than being dropped back to the absent case.
    let zero = request_body("m", &limits_with(Some(0), 0), true, messages);
    assert_eq!(zero["max_turns"], 0);
    assert_eq!(zero["max_session_tokens"], 0);
}

/// A project without `.jan/agent/agent.toml` runs under the default
/// policy, so exporting it yields that policy instead of a
/// malformed-state error.
#[test]
fn policy_export_without_agent_toml_exports_the_default_policy() {
    let dir = tempfile::tempdir().unwrap();
    let document = super::cli_policy_export(dir.path().to_str().unwrap())
        .expect("a project without agent.toml exports the default policy");
    assert_eq!(document.default, "read-only");
    assert!(document.allow.is_empty());
    assert!(document.deny.is_empty());
}

/// An agent.toml that exists but cannot be parsed is still refused.
#[test]
fn policy_export_with_malformed_agent_toml_fails() {
    let dir = tempfile::tempdir().unwrap();
    let agent = dir.path().join(".jan").join("agent");
    std::fs::create_dir_all(&agent).unwrap();
    std::fs::write(agent.join("agent.toml"), "this is = = not toml").unwrap();
    assert!(super::cli_policy_export(dir.path().to_str().unwrap()).is_err());
}

const NARROW_POLICY: &str = r#"{"v":1,"default":"deny","allow":[],"deny":[],"allowWrite":[]}"#;

/// An import rewrites `[tools]` and nothing else.
#[test]
fn policy_import_preserves_other_sections() {
    let dir = tempfile::tempdir().unwrap();
    let agent = dir.path().join(".jan").join("agent");
    std::fs::create_dir_all(&agent).unwrap();
    std::fs::write(
        agent.join("agent.toml"),
        "model = \"keep-me\"\n\n[tools]\ndefault = \"allow\"\n",
    )
    .unwrap();
    super::cli_policy_import(dir.path().to_str().unwrap(), NARROW_POLICY, true)
        .expect("import applies");
    let text = std::fs::read_to_string(agent.join("agent.toml")).unwrap();
    assert!(text.contains("model = \"keep-me\""), "other settings kept: {text}");
    assert!(text.contains("default = \"deny\""), "policy replaced: {text}");
    assert!(!agent.join("agent.toml.flint-tmp").exists());
}

/// An agent.toml that cannot be read is left exactly as it is.
#[test]
fn policy_import_refuses_non_utf8_agent_toml_and_leaves_it() {
    let dir = tempfile::tempdir().unwrap();
    let agent = dir.path().join(".jan").join("agent");
    std::fs::create_dir_all(&agent).unwrap();
    let bytes: &[u8] = b"model = \"x\"\n\xff\xfe\n";
    std::fs::write(agent.join("agent.toml"), bytes).unwrap();
    assert!(super::cli_policy_import(dir.path().to_str().unwrap(), NARROW_POLICY, true).is_err());
    assert_eq!(std::fs::read(agent.join("agent.toml")).unwrap(), bytes);
}

/// No agent.toml yet: the import creates one holding the policy.
#[test]
fn policy_import_missing_file_creates_tools_only() {
    let dir = tempfile::tempdir().unwrap();
    super::cli_policy_import(dir.path().to_str().unwrap(), NARROW_POLICY, true)
        .expect("import applies");
    let path = crate::core::agent::project::agent_toml_path(dir.path());
    let text = std::fs::read_to_string(path).unwrap();
    assert!(text.contains("[tools]") && text.contains("default = \"deny\""), "{text}");
}
