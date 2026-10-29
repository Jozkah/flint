//! Headless agent runs: the run entry points, the turn loop, persistence of a
//! finished run and the steered/durable-subagent variants. Moved verbatim out
//! of `mod.rs`.

use super::*;

/// Autonomous run: as many turns as the task needs, bounded by a `max_turns`
/// cap when one is set, and by the session token budget.
///
/// The failure is classified (AH-009), so the caller can choose an exit status
/// and a message from what went wrong rather than from how it was worded.
#[allow(clippy::too_many_arguments)]
pub async fn cli_agent_run(
    project: &str,
    task: &str,
    model: Option<String>,
    overrides: ProviderOverrides,
    flags: SessionFlags,
    resume: Option<ResumeRequest>,
    format: OutputFormat,
    input_format: InputFormat,
    host_tools: Option<&str>,
    host_gate: bool,
) -> Result<(), tauri_plugin_agent_tools::harness_error::HarnessError> {
    run_agent_loop(
        project, task, model, false, overrides, flags, resume, format, input_format,
        host_tools,
        host_gate,
    )
    .await
}

/// Single-turn run for debugging: the turn cap is pinned to 1 here and
/// outranks any `--max-turns`.
pub async fn cli_agent_step(
    project: &str,
    task: &str,
    model: Option<String>,
    overrides: ProviderOverrides,
    flags: SessionFlags,
) -> Result<(), tauri_plugin_agent_tools::harness_error::HarnessError> {
    run_agent_loop(
        project,
        task,
        model,
        true,
        overrides,
        flags,
        None,
        OutputFormat::Text,
        InputFormat::Text,
        // `step` is a debugging path with no client on stdin, so there is
        // nothing that could execute a host tool.
        None,
        false,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_cli_orchestration_args(
    project_root: PathBuf,
    permissions: tauri_plugin_agent_tools::permissions::ToolPermissions,
    provider_configs: HashMap<String, crate::core::state::ProviderConfig>,
    mcp_servers: crate::core::state::SharedMcpServers,
    mcp_settings: McpSettings,
    permission_requests: PermissionRegistry,
    host_tools: crate::core::agent::host_tools::HostToolSet,
    host_tool_requests: crate::core::agent::host_tools::HostToolRegistry,
    auto_approve: bool,
    bypass: bool,
    plan: bool,
    max_parallel_subagents: u32,
    sandbox: Option<bool>,
    // `[agent].fallback`: providers to try when the model cannot be reached
    // (AH-193). Empty unless the project configured a chain.
    fallback_models: Vec<String>,
    // The named profile this run was started under (AH-186).
    profile: Option<String>,
) -> OrchestrationArgs {
    OrchestrationArgs {
        profile,
        fallback_models,
        // A CLI run is nobody's child.
        parent_run: None,
        spend_ledger: None,
        dispatch_id: None,
        client: crate::core::agent::upstream::agent_http_client(),
        provider_configs: Arc::new(Mutex::new(provider_configs)),
        mcp_servers,
        mcp_settings: Arc::new(Mutex::new(mcp_settings)),
        jan_data_folder: resolve_jan_data_folder().to_string_lossy().into_owned(),
        permissions,
        project_root: Some(project_root),
        permission_requests,
        host_tools,
        host_tool_requests,
        host_owns_gate: false,
        host_tool_route: None,
        ask_requests: None,
        todo_registry: None,
        system_prompt_override: None,
        subagents_enabled: true,
        max_parallel_subagents,
        auto_approve,
        bypass,
        run_mode: if plan {
            crate::core::agent::plan::RunMode::Plan
        } else {
            crate::core::agent::plan::RunMode::Normal
        },
        // Key the persistent bash `/tmp` scratch to this session. Generated per
        // run/session: a one-shot CLI wipes it after its single run; the TUI
        // reuses `args` across turns and wipes it when the interactive session
        // ends.
        session_id: Some(uuid::Uuid::new_v4().to_string()),
        // The top-level run is not a child: no dispatch gave it an id.
        run_id: None,
        // `--sandbox` only when passed; unset falls through to the project's
        // `[tools].sandbox` and then the user's global `sandbox`.
        subject: tauri_plugin_agent_tools::subject::Subject::MainAgent,
        sandbox,
    }
}

/// First 8 chars of a thread id, the form the TUI shows in `/threads`.
pub(super) fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

/// Read a host's tool declarations from the file `--host-tools` names.
///
/// Every failure is the host's to fix and is reported with the path, since a
/// host that mistyped one is otherwise left guessing which of its tools the run
/// disagreed with.
pub(super) fn load_host_tools(path: &str) -> Result<crate::core::agent::host_tools::HostToolSet, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read --host-tools file '{path}': {e}"))?;
    let decls: Vec<crate::core::agent::host_tools::HostToolDecl> = serde_json::from_str(&raw)
        .map_err(|e| format!("--host-tools file '{path}' is not a list of tool declarations: {e}"))?;
    crate::core::agent::host_tools::HostToolSet::declare(decls)
        .map_err(|e| format!("--host-tools file '{path}': {e}"))
}

/// Check how the run was asked to start and load the host tools it declared.
///
/// Every refusal here is a setup failure like any other, so the caller reports
/// it the way `prepare_agent_run`'s is: one `result` record with
/// `error.code: "setup_error"`. Returning early instead would leave a machine
/// consumer an empty stdout and a human string on stderr, which is the one
/// thing this channel promises never to do -- and a mistyped `--host-tools`
/// path is the first failure a host is likely to hit.
fn setup_host_tools(
    input_format: InputFormat,
    format: OutputFormat,
    host_tools: Option<&str>,
    host_gate: bool,
) -> Result<crate::core::agent::host_tools::HostToolSet, String> {
    if input_format.is_stream_json() && !format.is_stream_json() {
        return Err(
            "--input-format stream-json requires --output-format stream-json (the client \
             answers permission requests, so it must be reading them)"
                .to_string(),
        );
    }
    // Declared before anything is spent: a malformed or unacceptable tool
    // set is the host's own mistake, and finding out at the first call --
    // mid-task, after paid requests -- is worse than refusing to start.
    // Handing the gate to a host that declared no tools would be a no-op
    // the caller probably did not mean; say so rather than ignore it.
    if host_gate && host_tools.is_none() {
        return Err("--host-gate requires --host-tools".to_string());
    }
    match host_tools {
        Some(path) => {
            if !input_format.is_stream_json() {
                return Err(
                    "--host-tools requires --input-format stream-json (a host tool call is \
                     answered with a tool_result message on stdin)"
                        .to_string(),
                );
            }
            load_host_tools(path)
        }
        None => Ok(crate::core::agent::host_tools::HostToolSet::new()),
    }
}

/// Turn a setup failure into the error a run returns. A machine format also
/// gets its `result` record first: a setup failure never reaches the event
/// stream, so a JSON consumer would otherwise get an empty stdout and have to
/// parse the human error off stderr.
fn setup_failure(format: OutputFormat, started: std::time::Instant, message: String) -> tauri_plugin_agent_tools::harness_error::HarnessError {
    if format.is_machine() {
        print_report(
            format,
            RunReport::setup_failure(&message).finish(None, "", started.elapsed().as_millis(), None),
        );
    }
    // Setup failed before a provider was ever reached: the run never started,
    // which is a startup failure and not the model's.
    tauri_plugin_agent_tools::harness_error::HarnessError::new(tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput, message)
        .at(tauri_plugin_agent_tools::harness_error::Stage::Startup)
}

/// Block until the active MCP servers connect, so tools (collected once per run)
/// are present on the first turn.
async fn await_mcp_connect(mcp_task: Option<tokio::task::JoinHandle<mcp::ConnectOutcome>>) {
    if let Some(task) = mcp_task {
        match task.await {
            Ok(outcome) => {
                if !outcome.connected.is_empty() {
                    log::info!("MCP: connected {}", outcome.connected.join(", "));
                }
                // Headless has no transcript to note into, so these stay logs.
                for failure in &outcome.failed {
                    log::warn!("MCP: {failure}");
                }
                // Signing in needs a browser and a keypress, neither of which
                // exists here, so the fix is named rather than attempted.
                if !outcome.needs_auth.is_empty() {
                    log::warn!(
                        "MCP: {} need authentication - run `jan` and use /mcp to sign in",
                        outcome.needs_auth.join(", ")
                    );
                }
            }
            Err(e) => log::warn!("MCP connect task failed: {e}"),
        }
    }
}

/// AH-181: how much this run says about itself. The flag outranks the
/// project's declaration, and an unreadable declaration refuses the run
/// rather than quietly printing a different amount than was asked for.
fn resolve_density(
    asked: Option<Density>,
    declared: Option<&str>,
) -> Result<Density, tauri_plugin_agent_tools::harness_error::HarnessError> {
    match asked {
        Some(density) => Ok(density),
        None => {
            Density::parse(declared.unwrap_or_default()).map_err(|e| {
                tauri_plugin_agent_tools::harness_error::HarnessError::new(
                    tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
                    format!("[output].density: {e}"),
                )
                .at(tauri_plugin_agent_tools::harness_error::Stage::Startup)
            })
        }
    }
}

/// AH-026: put the turn in flight on disk, so a run killed mid-turn can be
/// resumed without losing it.
fn begin_checkpoint(
    persist: &PersistTarget,
    format: OutputFormat,
    started: std::time::Instant,
) -> Result<std::sync::Arc<std::sync::Mutex<Option<inflight::Writer>>>, tauri_plugin_agent_tools::harness_error::HarnessError> {
    // The thread is written when the run starts, not only when it ends: a run
    // killed mid-turn otherwise leaves a checkpoint in a thread that no
    // listing knows, and `--resume` cannot name it.
    if let Some(thread) = persist.thread_id.as_deref().filter(|_| !persist.ephemeral) {
        let meta = worktree_metadata(&persist.agent_dir, Some(thread), persist.workspace.as_ref());
        if let Err(e) = cli_save_thread(&persist.agent_dir, Some(thread), &persist.model, &persist.history, meta) {
            eprintln!("(could not save session before the run: {e})");
        }
    }
    let writer = match persist.thread_id.as_deref().filter(|_| !persist.ephemeral) {
        Some(thread) => match inflight::Writer::begin(
            &get_thread_dir(&persist.agent_dir, thread),
            &persist.model,
            persist.history.clone(),
        ) {
            Ok(w) => Some(w),
            Err(e) => {
                // The init line is already out: close the stream with a result
                // line so a JSON consumer is not left waiting for one.
                if format.is_machine() {
                    print_report(
                        format,
                        RunReport::setup_failure(&e.to_string()).finish(
                            None,
                            "",
                            started.elapsed().as_millis(),
                            None,
                        ),
                    );
                }
                return Err(e);
            }
        },
        None => None,
    };
    Ok(std::sync::Arc::new(std::sync::Mutex::new(writer)))
}

/// What the event consumer needs from the run that spawned it.
struct EventConsumer {
    pressure_window: u64,
    pressure_reserve: u64,
    notify: Option<crate::core::agent::notify::Notify>,
    session: String,
    root: std::path::PathBuf,
    checkpoint: std::sync::Arc<std::sync::Mutex<Option<inflight::Writer>>>,
    client: Option<Arc<StreamInput>>,
    host_tool_requests: crate::core::agent::host_tools::HostToolRegistry,
    permission_requests: PermissionRegistry,
    density: Density,
    format: OutputFormat,
}

/// Drain the run's events: fold them into the report, mirror them into the
/// checkpoint, warn as the window fills, notify on a permission wait, and print
/// or answer each one in the run's output format. Returns the report and the
/// last conversation the loop published.
async fn consume_events(
    mut rx: mpsc::UnboundedReceiver<StreamEvent>,
    ctx: EventConsumer,
) -> (RunReport, Option<Vec<serde_json::Value>>) {
    let EventConsumer {
        pressure_window,
        pressure_reserve,
        notify: notify_for_prompts,
        session: prompt_session,
        root: prompt_root,
        checkpoint: checkpoint_for_printer,
        client,
        host_tool_requests,
        permission_requests,
        density,
        format,
    } = ctx;
    // The last conversation the loop published, kept for the save below.
    let mut conversation: Option<Vec<serde_json::Value>> = None;
    let mut report = RunReport::default();
    let mut warned_about_context = false;
    while let Some(ev) = rx.recv().await {
        report.observe(&ev);
        // Said before the reply that would overflow, not after: the point
        // of the warning is that there is still a choice to make.
        if let StreamEvent::TurnUsage { usage, .. } = &ev {
            let used = usage.total_tokens.or(usage.prompt_tokens).unwrap_or(0);
            match crate::core::agent::context_pressure::pressure(
                used,
                pressure_window,
                pressure_reserve,
                // The headless path reports the provider's own numbers.
                true,
            ) {
                Some(found) if !warned_about_context => {
                    warned_about_context = true;
                    eprintln!(
                        "\n{}",
                        color::paint(
                            "33",
                            format_args!(
                                "[context] {}",
                                crate::core::agent::context_pressure::line(&found),
                            ),
                        ),
                    );
                }
                Some(_) => {}
                None => warned_about_context = false,
            }
        }
        // The run's own conversation, as the loop last published it. A
        // headless run used to save only the prompt and the final answer,
        // so a `--resume` turn handed the model a transcript in which it
        // had *described* work and never called a tool -- which is an
        // example of exactly the wrong behaviour, and the model imitates
        // it. Keeping the calls and their results is what makes a resumed
        // turn continue the same run rather than re-enact a summary of it.
        if let StreamEvent::MessagesUpdated { messages } = &ev {
            conversation = Some(messages.clone());
        }
        if let Ok(mut guard) = checkpoint_for_printer.lock() {
            if let Some(writer) = guard.as_mut() {
                match &ev {
                    StreamEvent::MessagesUpdated { messages } => writer.conversation(messages),
                    StreamEvent::Token { text } => writer.text(text),
                    _ => {}
                }
            }
        }
        // A run that has stopped to wait for a person is the moment
        // worth interrupting somebody for: nothing else happens until
        // they answer.
        if let (Some(notify), StreamEvent::PermissionRequest { tool_name, .. }) =
            (notify_for_prompts.as_ref(), &ev)
        {
            let note = crate::core::agent::notify::Notification::new(
                crate::core::agent::notify::Moment::NeedsAttention,
                &prompt_session,
                None,
                format!("waiting for approval of a {tool_name} call"),
            );
            for outcome in crate::core::agent::notify::deliver(
                notify,
                &note,
                &prompt_root,
                crate::core::agent::notify::Moment::NeedsAttention,
            )
            .await
            {
                if let crate::core::agent::notify::Delivered::Failed(why) = outcome {
                    log::warn!("notify: {why}");
                }
            }
        }
        // Asked per event, not once per run: the client owns the decision
        // only while it is still reading. Once stdin has closed, the CLI
        // takes its own path back, which on a pipe is an auto-deny.
        let duplex = client.as_ref().is_some_and(|c| !c.client_gone());
        // Only the client can answer a host tool call. If it has already
        // left, the call is failed here: `strand_all` fired when stdin
        // closed, so nothing else will ever release this one and the turn
        // would park forever.
        if let StreamEvent::ToolRequest { request_id, .. } = &ev {
            if !duplex {
                // The request is already on stdout, so its withdrawal is
                // too; printed here because this task is the stream's order.
                if crate::core::agent::host_tools::strand(&host_tool_requests, request_id)
                    .await
                {
                    let cancelled = request_cancelled(request_id, CANCEL_CLIENT_GONE);
                    report.observe(&cancelled);
                    if format.is_stream_json() {
                        print_json_line(&cancelled);
                    }
                }
                continue;
            }
        }
        match format {
            OutputFormat::Text => {
                print_event(ev, &permission_requests, density, duplex).await
            }
            OutputFormat::Json => {
                resolve_permission_silently(ev, &permission_requests, duplex).await;
            }
            OutputFormat::StreamJson => {
                print_json_line(&ev);
                if let Some((request_id, decision)) =
                    resolve_permission_silently(ev, &permission_requests, duplex).await
                {
                    print_json_line(&PermissionDecisionRecord::new(&request_id, decision));
                }
            }
        }
    }
    (report, conversation)
}

/// AH-185/AH-184: the run is over, whoever started it has moved on, and this
/// says so. How it ended, and nothing of what it did.
async fn notify_run_ended(
    notify: &Option<crate::core::agent::notify::Notify>,
    session: &str,
    root: &std::path::Path,
    result: &Result<serde_json::Value, tauri_plugin_agent_tools::harness_error::HarnessError>,
) {
    if let Some(notify) = notify.as_ref() {
        let summary = match result.as_ref() {
            Ok(_) => "the run ended: completed".to_string(),
            Err(e) => format!("the run ended: {} ({})", e.kind().tag(), e.stage().tag()),
        };
        let note = crate::core::agent::notify::Notification::new(
            crate::core::agent::notify::Moment::RunEnded,
            session,
            None,
            summary,
        );
        for outcome in crate::core::agent::notify::deliver(
            notify,
            &note,
            root,
            crate::core::agent::notify::Moment::RunEnded,
        )
        .await
        {
            if let crate::core::agent::notify::Delivered::Failed(why) = outcome {
                log::warn!("notify: {why}");
            }
        }
    }
}

/// Everything after the run: save the turn back so the session stays
/// continuable with --resume, close the checkpoint, print the result in the
/// run's format and clean up.
#[allow(clippy::too_many_arguments)]
async fn finish_run(
    persist: PersistTarget,
    result: Result<serde_json::Value, tauri_plugin_agent_tools::harness_error::HarnessError>,
    conversation: Option<Vec<serde_json::Value>>,
    mut report: RunReport,
    session_id: &str,
    checkpoint: &std::sync::Mutex<Option<inflight::Writer>>,
    format: OutputFormat,
    started: std::time::Instant,
    scratch_session: Option<&str>,
    aborted: bool,
) -> Result<(), tauri_plugin_agent_tools::harness_error::HarnessError> {
    // Write the turn back so the session stays continuable with --resume.
    let model = persist.model.clone();
    let structured = result.as_ref().ok().and_then(|c| c.get("structured_output").cloned());
    let structured_error = result
        .as_ref()
        .ok()
        .and_then(|c| c.get("structured_output_error"))
        .and_then(|v| v.as_str().map(str::to_string));
    report.set_structured(structured.clone(), structured_error.clone());
    let persisted = persist_headless_run(persist, &result, conversation, Some(session_id));
    let (session_id, final_text) = (persisted.session_id, persisted.final_text);
    // Saved, so nothing is in flight any more. A run that failed before its
    // thread could be written keeps its checkpoint: its completed steps are
    // still the only copy.
    if persisted.saved || result.is_ok() {
        if let Some(writer) = checkpoint.lock().ok().and_then(|mut g| g.take()) {
            writer.finish();
        }
    }
    if persisted.saved && !format.is_machine() {
        if let Some(id) = session_id.as_deref() {
            eprintln!(
                "{}",
                color::paint(
                    "2",
                    format_args!(
                        "[session {} - resume with `flint --resume={}`]",
                        short_id(id),
                        short_id(id),
                    ),
                ),
            );
        }
    }
    if format.is_machine() {
        print_report(
            format,
            report.finish(
                session_id.as_deref().map(short_id).as_deref(),
                &model,
                started.elapsed().as_millis(),
                final_text.as_deref(),
            ),
        );
    }
    // The validated value on its own line, for a caller reading stdout in text
    // mode. Machine formats carry it as `structured_output` in the result.
    if !format.is_machine() {
        if let Some(value) = structured.as_ref() {
            println!("{value}");
        }
    }
    if let Some(reason) = structured_error.as_deref() {
        eprintln!("Error: the final answer never validated against --json-schema: {reason}");
    }
    // The stream belongs to this run (AH-183); a later command in the same
    // process is not it.
    tauri_plugin_agent_tools::event_log::unwatch();
    // The one-shot CLI runs exactly one turn, so its session ends here: wipe
    // the persistent bash `/tmp` scratch this run used.
    if let Some(session) = scratch_session {
        let _ = workspace::remove_scratch_dir(session).await;
    }
    if aborted {
        return Ok(());
    }
    if let Some(reason) = structured_error {
        return Err(tauri_plugin_agent_tools::harness_error::HarnessError::new(
            tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
            format!("the final answer never validated against --json-schema: {reason}"),
        ));
    }
    result.map(|_| ())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_agent_loop(
    project: &str,
    task: &str,
    model_override: Option<String>,
    single_turn: bool,
    overrides: ProviderOverrides,
    flags: SessionFlags,
    resume: Option<ResumeRequest>,
    format: OutputFormat,
    input_format: InputFormat,
    host_tools: Option<&str>,
    host_gate: bool,
) -> Result<(), tauri_plugin_agent_tools::harness_error::HarnessError> {
    // A duplex run switches off both of the CLI's own answer paths, so the
    // client is the only thing that can resolve a permission request -- and it
    // can only do that if it is being told the request ids. `text` prints them
    // to stderr and `json` prints nothing at all until the run ends, so either
    // pairing leaves a gated call unanswerable. Rejected rather than silently
    // upgraded: a caller parsing plain text should not have the format changed
    // under it.
    let started = std::time::Instant::now();
    // Read before the flags are handed on: this is the run's own answer about
    // how much to say, and it is wanted after the run as well as during it.
    let asked_density = flags.density;
    // Every refusal below is a setup failure like any other, so it is reported
    // the way `prepare_agent_run`'s is: one `result` record with
    // `error.code: "setup_error"`. Returning early instead would leave a
    // machine consumer an empty stdout and a human string on stderr, which is
    // the one thing this channel promises never to do -- and a mistyped
    // `--host-tools` path is the first failure a host is likely to hit.
    let host_tools = match setup_host_tools(input_format, format, host_tools, host_gate) {
        Ok(host_tools) => host_tools,
        Err(e) => return Err(setup_failure(format, started, e)),
    };
    let prepared = prepare_agent_run(
        project,
        task,
        model_override,
        single_turn,
        overrides,
        flags,
        resume,
    );
    let PreparedRun {
        mut args,
        body,
        limits,
        permission_requests,
        mcp_task,
        persist,
    } = match prepared {
        Ok(prepared) => prepared,
        Err(e) => return Err(setup_failure(format, started, e)),
    };
    // Installed after the session is built, since host tools are declared per
    // run rather than per project: the same session config serves a run with
    // them and one without.
    args.host_tools = host_tools;
    // `--host-gate`: the host's own callback is the approval step, so Jan
    // raises no `permission_request` for a host tool of any class.
    args.host_owns_gate = host_gate;

    await_mcp_connect(mcp_task).await;

    // AH-077: the headless run warns as the window fills, once per approach,
    // with the same words the TUI uses.
    let pressure_window = limits.context_window;
    let pressure_reserve = limits.reserve_tokens;
    // AH-185/AH-184: who to tell, checked before the run rather than when it
    // ends and nobody is told. A project that declares nothing costs nothing.
    // CLIA-006: read with the run's profile folded in, as the rest of the
    // run's settings were, so a profile's `notify` / `[output].density` apply.
    let run_cfg = crate::core::agent::project::load_agent_config_with_profile(
        std::path::Path::new(project),
        args.profile.as_deref(),
    )
    .map_err(|e| {
        tauri_plugin_agent_tools::harness_error::HarnessError::new(
            tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
            e,
        )
        .at(tauri_plugin_agent_tools::harness_error::Stage::Startup)
    })?;
    let notify = crate::core::agent::notify::check(&run_cfg.notify)?;
    let notify_root = std::path::PathBuf::from(project);
    let notify_session = args.session_id.clone().unwrap_or_default();
    // The session this run saves under, decided here rather than at save time
    // so the `init` record can name it: a client learns the id it can `--resume`
    // from the first line of the stream, and a run killed mid-flight still told
    // it which id to look for.
    let session_id = persist
        .thread_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    // The run's own id becomes the session id, so the one a client is handed,
    // the one its requests are correlated under, and the one a provenance
    // record names are the same id: three spellings of a session would only
    // ever be a way to lose the thread between them.
    args.session_id = Some(session_id.clone());

    // The handshake, before anything else can reach stdout. Printed here rather
    // than from the printer task for exactly that reason: nothing has been
    // spawned yet, so "first line" is a property of the code's order rather than
    // a race against the run's own events.
    if format.is_stream_json() {
        print_json_line(&init_record(&args, &session_id, &persist.model, input_format).await);
    }

    // The client on stdin, when there is one: it owns every permission decision
    // and can steer or stop the run while it is in flight.
    let input = input_format
        .is_stream_json()
        .then(|| Arc::new(StreamInput::default()));
    // Created before the reader so it can report the host requests it releases
    // on the same channel as the run's events: the printer then orders those
    // records before the final result, which it prints only once every sender
    // (the reader's included) has dropped.
    let (tx, rx) = mpsc::unbounded_channel::<StreamEvent>();
    let reader = input.as_ref().map(|input| {
        spawn_input_reader(
            Arc::clone(input),
            Arc::clone(&permission_requests),
            Arc::clone(&args.host_tool_requests),
            tx.clone(),
            format,
        )
    });
    let client = input.clone();
    let host_tool_requests = Arc::clone(&args.host_tool_requests);

    // The report is folded in both formats from the same stream the printer
    // reads, so the JSON envelope can never disagree with the text output.
    let density = resolve_density(asked_density, run_cfg.output.density.as_deref())?;
    let checkpoint = begin_checkpoint(&persist, format, started)?;
    let printer = tokio::spawn(consume_events(
        rx,
        EventConsumer {
            pressure_window,
            pressure_reserve,
            notify: notify.clone(),
            session: notify_session.clone(),
            root: notify_root.clone(),
            checkpoint: checkpoint.clone(),
            client,
            host_tool_requests,
            permission_requests,
            density,
            format,
        },
    ));

    // `None` when the client aborted: the run produced no completion, but a
    // deliberate stop is an outcome rather than a failure, so it is reported on
    // the stream and the process still exits 0.
    let outcome = match input.as_ref() {
        Some(input) => run_steered(&tx, &body, &args, input).await,
        None => Some(run_orchestration_streamed(&tx, &body, &args).await),
    };
    if let Some(reader) = reader {
        reader.abort();
    }
    // A request still registered now belongs to a call the run dropped (it
    // failed or stopped mid-batch); nothing will await its answer, so the host
    // is told to stop working on it before the result record closes the stream.
    for id in crate::core::agent::host_tools::cancel_all(&args.host_tool_requests).await {
        let _ = tx.send(request_cancelled(&id, CANCEL_ABORTED));
    }
    let aborted = outcome.is_none();
    let result = outcome.unwrap_or_else(|| Err(ABORTED_BY_CLIENT.into()));
    drop(tx);
    let (report, conversation) = printer.await.unwrap_or_default();
    if let Some(input) = input.as_ref() {
        report_dropped_follow_ups(input, format);
    }

    notify_run_ended(&notify, &notify_session, &notify_root, &result).await;

    finish_run(
        persist,
        result,
        conversation,
        report,
        &session_id,
        &checkpoint,
        format,
        started,
        args.session_id.as_deref(),
        aborted,
    )
    .await
}

/// What writing a finished headless run back produced.
pub(crate) struct PersistedRun {
    /// The thread the run lives in: the one it resumed, or the one just saved.
    pub session_id: Option<String>,
    pub final_text: Option<String>,
    /// Whether this call wrote the thread.
    pub saved: bool,
}

/// Write a finished headless run to the project's thread store so `--resume`
/// can continue it. Shared by `flint cli agent run` and the JSON API (AH-182), so
/// the two cannot save a run differently.
pub(super) fn persist_headless_run(
    persist: PersistTarget,
    result: &Result<serde_json::Value, tauri_plugin_agent_tools::harness_error::HarnessError>,
    conversation: Option<Vec<serde_json::Value>>,
    save_as: Option<&str>,
) -> PersistedRun {
    let PersistTarget {
        agent_dir,
        thread_id,
        model,
        mut history,
        workspace,
        ephemeral,
    } = persist;
    let mut session_id = thread_id.clone();
    let mut final_text = None;
    let mut saved = false;
    if ephemeral {
        // Not written anywhere, and not resumable: the answer is all there is.
        return PersistedRun {
            session_id: None,
            final_text: result.as_ref().ok().and_then(completion_text),
            saved: false,
        };
    }
    if let Ok(completion) = result.as_ref() {
        final_text = completion_text(completion);
        // What the run actually did, when the loop published it: the user's
        // prompt, every tool call the model made, every result it got back,
        // and the answer. Falling back to prompt-and-answer only when no
        // conversation was published (a run that never reached a turn).
        match conversation {
            Some(messages) if !messages.is_empty() => {
                history = messages;
                if let Some(text) = final_text.as_ref() {
                    let already = history
                        .last()
                        .and_then(|m| m.get("content"))
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|last| last == text);
                    if !already {
                        history.push(
                            serde_json::json!({ "role": "assistant", "content": text.clone() }),
                        );
                    }
                }
            }
            _ => {
                if let Some(text) = final_text.as_ref() {
                    history
                        .push(serde_json::json!({ "role": "assistant", "content": text.clone() }));
                }
            }
        }
        let save_id = thread_id.as_deref().or(save_as);
        let meta = worktree_metadata(&agent_dir, save_id, workspace.as_ref());
        match cli_save_thread(&agent_dir, save_id, &model, &history, meta) {
            Ok(id) => {
                session_id = Some(id);
                saved = true;
            }
            Err(e) => eprintln!("(could not save session: {e})"),
        }
    }
    PersistedRun { session_id, final_text, saved }
}

/// The `init` handshake of a `--output-format stream-json` run, assembled from
/// the same parts the run itself uses: the session it saves under, the model it
/// dispatches to, and the tools its first turn will advertise, so the record
/// cannot describe a run other than this one.
pub(super) async fn init_record(
    args: &OrchestrationArgs,
    session_id: &str,
    model: &str,
    input_format: InputFormat,
) -> Init {
    let tools: Vec<String> = crate::core::agent::r#loop::context_advertised_tools(
        &args.mcp_servers,
        &args.mcp_settings,
        &args.permissions,
        args.project_root.as_deref(),
        args.run_mode,
        args.subagents_enabled,
        args.max_parallel_subagents,
        args.ask_requests.is_some(),
        args.todo_registry.is_some(),
        &args.host_tools,
    )
    .await
    .iter()
    .filter_map(tool_name)
    .collect();
    // Only the host tools' schemas are echoed, not every advertised tool's: the
    // host is comparing these against what it sent, and a built-in's schema is
    // this process's own business.
    //
    // Filtered to what `tools` actually advertises rather than to everything
    // declared. A deny list, an allowlist or Plan mode can withhold a host tool,
    // and a host that saw its schema echoed anyway would conclude the tool was
    // live and wait for a call that is never coming. Echoing the advertised set
    // lets it detect the suppression instead.
    let tool_specs = args
        .host_tools
        .schemas()
        .into_iter()
        .filter(|spec| {
            tool_name(spec).is_some_and(|name| tools.iter().any(|t| t == &name))
        })
        .collect();
    // The project root the run's tools are confined to, as the run itself sees
    // it. A caller that built these args without one gets `null`: any path
    // substituted here would claim a confinement the run does not have.
    let cwd = args
        .project_root
        .as_deref()
        .map(|root| root.to_string_lossy().into_owned());
    // A run that does not read stdin accepts nothing, and says so: an empty
    // list is a client's answer that there is no reply path, which is more use
    // than an absent field or a list of kinds the run will ignore.
    let input_kinds = if input_format.is_stream_json() {
        INPUT_KINDS.to_vec()
    } else {
        Vec::new()
    };
    // The caps go with the kinds: a client that can send an image should learn
    // the limits from the handshake rather than by having a message rejected.
    let input_content_parts = input_format
        .is_stream_json()
        .then(InputContentParts::current);
    Init::new(
        session_id,
        model,
        cwd,
        tools,
        tool_specs,
        input_kinds,
        input_content_parts,
    )
}

/// A rendered tool schema's name, out of the OpenAI `{"type":"function",
/// "function":{"name":…}}` shape the advertised array carries.
pub(super) fn tool_name(tool: &serde_json::Value) -> Option<String> {
    Some(tool.get("function")?.get("name")?.as_str()?.to_string())
}

/// Stop reason reported for a run the client ended with an `abort` message, and
/// the error the run itself returns -- never printed, since an abort exits 0.
pub(super) const ABORTED_BY_CLIENT: &str = "aborted by client";

/// Drive the run against a duplex client: the orchestration loop's steering
/// handshake is answered from the queue the reader fills, and an `abort`
/// message drops the run. `None` is that abort.
///
/// Dropping the orchestration future is what stops the run, so anything it was
/// awaiting (an upstream request, a tool) is cancelled where it stands; a child
/// process a `bash` call had already spawned outlives it, as it does on the
/// TUI's cancel path.
pub(super) async fn run_steered(
    tx: &mpsc::UnboundedSender<StreamEvent>,
    body: &serde_json::Value,
    args: &OrchestrationArgs,
    input: &Arc<StreamInput>,
) -> Option<Result<serde_json::Value, tauri_plugin_agent_tools::harness_error::HarnessError>> {
    let (steering_tx, mut steering_rx) = mpsc::unbounded_channel::<SteeringRequest>();
    let queue = Arc::clone(input);
    let steerer = tokio::spawn(async move {
        while let Some(request) = steering_rx.recv().await {
            // Empty is the normal answer: the loop asks at every turn boundary.
            let _ = request.reply.send(queue.take_queued());
        }
    });
    let outcome = tokio::select! {
        result = run_orchestration_steered(tx, body, args, Some(&steering_tx)) => Some(result),
        _ = input.aborted() => {
            // A host still holding a request must be told to drop it: the run
            // it would answer is gone. Released here, not by the reader, so
            // the records land before `done` and cannot race the reader's
            // shutdown; `cancel_all` rather than `strand_all` so a child still
            // awaiting one is told it was cancelled, not that the host left.
            for id in crate::core::agent::host_tools::cancel_all(&args.host_tool_requests).await {
                let _ = tx.send(request_cancelled(&id, CANCEL_ABORTED));
            }
            // The loop emits its own terminal event; an abort pre-empts it, so
            // the report is given one here or it would read as a clean stop.
            let _ = tx.send(StreamEvent::Done {
                stop_reason: "aborted".to_string(),
                usage: None,
            });
            None
        }
    };
    steerer.abort();
    outcome
}

/// Run one durable subagent from its spec (AH-101). Started by a job
/// supervisor as `flint cli agent run-subagent --spec <file>`; its answer is what
/// it prints, which the supervisor keeps as the job's output.
///
/// Configured exactly as an in-process child is (`configure_child_args`,
/// `child_body`). Nobody is attached to answer a permission prompt, so every
/// prompt is denied and said so on stderr: a durable child does only what its
/// project's rules already allow.
pub async fn run_durable_subagent(
    spec_file: &std::path::Path,
) -> Result<(), tauri_plugin_agent_tools::harness_error::HarnessError> {
    use crate::core::agent::subagent::{self as sub, SubagentRegistry, SubagentRequest};
    use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};

    let spec = crate::core::agent::durable_subagent::read_spec(spec_file)?;
    // The data folder the parent uses: its providers, and where the record of
    // this run belongs. Set before anything reads it.
    if !spec.data_folder.is_empty() {
        std::env::set_var("JAN_DATA_FOLDER", &spec.data_folder);
    }
    let session = prepare_agent_session(
        &spec.project,
        Some(spec.model.clone()),
        ProviderOverrides::default(),
        SessionFlags {
            require_model: true,
            ..Default::default()
        },
        None,
    )
    .map_err(|e| HarnessError::new(ErrorKind::InvalidInput, e).at(Stage::Startup))?;
    let AgentSession {
        mut args,
        permission_requests,
        mcp_task,
        ..
    } = session;
    args.session_id = Some(spec.session.clone());
    args.parent_run = (!spec.parent_run.is_empty()).then(|| spec.parent_run.clone());
    let project_root = args
        .project_root
        .clone()
        .ok_or_else(|| HarnessError::new(ErrorKind::InvalidInput, "no project").at(Stage::Startup))?;
    // The parent checked the project's spawn allowlist; a spec written by
    // anything else is held to it here too.
    sub::check_project_spawn_allowed(&project_root, &spec.subagent_name)
        .map_err(|e| HarnessError::new(ErrorKind::PolicyViolation, e.to_string()).at(Stage::Child))?;
    let registry = SubagentRegistry::load(&project_root);
    let request = SubagentRequest {
        subagent_name: spec.subagent_name.clone(),
        description: spec.description.clone(),
        allowed_tools: spec.allowed_tools.clone(),
        system_prompt: spec.system_prompt.clone(),
        isolate: Some(false),
        fork_context: false,
        durable: true,
        max_turns: spec.max_turns,
        title: None,
    };
    let resolved = sub::resolve_dispatch(&registry, &request, &args.permissions)
        .map_err(|e| HarnessError::new(ErrorKind::InvalidInput, e.to_string()).at(Stage::Child))?;
    let child_args = sub::configure_child_args(args, &resolved, &spec.dispatch_id);
    let parent = sub::ParentRun {
        routing: Vec::new(),
        conversation: None,
        model: spec.model.clone(),
        budget_remaining: spec.max_session_tokens,
        token_rates: None,
        usd_remaining: None,
        send_reasoning: spec.send_reasoning,
        model_settings: sub::load_model_settings(),
    };
    let mut body = sub::child_body(&resolved, &spec.description, &parent, None, spec.max_turns);
    if spec.max_turns.is_none() {
        // A durable job that asked for no limit is unbounded, as it always was.
        body["max_turns"] = serde_json::json!(0);
    }
    // Routed when it was dispatched; the child runs what its parent chose.
    body["model"] = serde_json::json!(spec.model);

    if let Some(task) = mcp_task {
        let _ = task.await;
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();
    let registry = permission_requests.clone();
    let drain = tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if let StreamEvent::PermissionRequest {
                request_id,
                tool_name,
                ..
            } = ev
            {
                eprintln!("(durable subagent: {tool_name} needs approval and nobody is attached to give it; denied)");
                if let Some(sender) = registry.lock().await.remove(&request_id) {
                    let _ = sender.send(PermissionDecision::Deny);
                }
            }
        }
    });
    let result =
        crate::core::agent::r#loop::run_orchestration_streamed(&tx, &body, &child_args).await;
    drop(tx);
    let _ = drain.await;
    match result {
        Ok(completion) => {
            println!("{}", sub::final_assistant_text(&completion));
            Ok(())
        }
        Err(e) => Err(HarnessError::new(ErrorKind::ChildFailed, e.message().to_string()).at(Stage::Child)),
    }
}

/// `tool_request_cancelled` reasons this surface raises: the client stopped the
/// run, or it can no longer answer (stdin closed).
pub(super) const CANCEL_ABORTED: &str = "aborted";

pub(super) const CANCEL_CLIENT_GONE: &str = "client_gone";

pub(super) fn request_cancelled(request_id: &str, reason: &str) -> StreamEvent {
    StreamEvent::ToolRequestCancelled {
        request_id: request_id.to_string(),
        reason: reason.to_string(),
    }
}
