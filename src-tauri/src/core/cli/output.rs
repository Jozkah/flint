//! Headless run output: result envelopes, NDJSON lines, per-event rendering
//! and the terminal permission prompt. Moved verbatim out of `mod.rs`.

use super::*;

/// Render one `StreamEvent` for the terminal. Content tokens go to stdout so a
/// run can be piped; progress/diagnostics go to stderr. `PermissionRequest` is
/// resolved via the terminal (deny when non-interactive).
/// How much a headless run says about itself (AH-181).
///
/// The answer on stdout never changes: a piped run yields exactly the model's
/// completion at every density. What changes is the progress on stderr, which
/// is what a person reads while waiting and what a log keeps afterwards -- and
/// those two want different amounts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Density {
    /// One line per tool call, errors, and the answer. No reasoning, no live
    /// command output, no turn markers, no tool results.
    Compact,
    /// What a run has always printed.
    #[default]
    Normal,
    /// Everything Normal prints, plus each turn's token usage as the provider
    /// reported it.
    Verbose,
}

impl Density {
    /// Read a declared density. Anything else is refused rather than quietly
    /// treated as the default, which would be a run that says less than
    /// somebody asked it to.
    pub fn parse(text: &str) -> Result<Self, String> {
        match text.trim().to_ascii_lowercase().as_str() {
            "compact" | "quiet" => Ok(Density::Compact),
            "normal" | "" => Ok(Density::Normal),
            "verbose" => Ok(Density::Verbose),
            other => Err(format!(
                "{other:?} is not an output density; use compact, normal or verbose"
            )),
        }
    }
}

/// Model and tool text bound for a terminal: control, bidi and C1 characters
/// shown as visible escapes, so streamed output cannot move the cursor, clear
/// lines or retitle the window. A pipe or file gets the text untouched -- it is
/// data there, and the stream-json writer is a different sink entirely.
pub(super) fn sink_safe(text: &str, is_terminal: bool) -> std::borrow::Cow<'_, str> {
    if is_terminal {
        display_safe::display_safe(text)
    } else {
        std::borrow::Cow::Borrowed(text)
    }
}

pub(super) async fn print_event(
    ev: StreamEvent,
    registry: &PermissionRegistry,
    density: Density,
    duplex: bool,
) {
    use std::io::IsTerminal;
    match ev {
        // AH-078. The snapshot is already written to the data folder by the
        // dispatcher; this event only says one exists. Headless stdout is the
        // model's completion and nothing else, and the payload is never printed
        // anywhere -- reading a snapshot back is `jan snapshots`, which serves
        // the redacted record. Matched explicitly rather than through a
        // wildcard so a new event still fails this build instead of vanishing.
        StreamEvent::PromptSnapshot { .. } => {}
        // Provenance is machine-facing: an identity record for a harness, not
        // something to draw. The stream-json writer serializes the event itself.
        StreamEvent::RequestProvenance { .. } => {}
        StreamEvent::Token { text } => {
            print!("{}", sink_safe(&text, std::io::stdout().is_terminal()));
            let _ = std::io::stdout().flush();
        }
        // A command's live output is progress, not answer: it goes to stderr so a
        // piped stdout still holds only the model's completion. The full output
        // arrives again with the tool result, which is what the model sees; this
        // is purely so a long command is not silent in a headless run.
        StreamEvent::ToolOutputDelta { delta, .. } => {
            // Live command output is the noisiest thing a run produces, and
            // the whole of it arrives again with the tool result.
            if density != Density::Compact {
                eprint!("{}", color::paint("2", format_args!("{}", sink_safe(&delta, std::io::stderr().is_terminal()))));
                let _ = std::io::stderr().flush();
            }
        }
        // Reasoning is progress, not answer: dimmed on stderr so piping stdout
        // yields only the real completion.
        StreamEvent::Reasoning { text } => {
            if density != Density::Compact {
                eprint!("{}", color::paint("2", format_args!("{}", sink_safe(&text, std::io::stderr().is_terminal()))));
                let _ = std::io::stderr().flush();
            }
        }
        StreamEvent::Step { index, max } => {
            if density != Density::Compact {
                match max {
                    0 => eprintln!("\n{}", color::paint("2", format_args!("[turn {index}]"))),
                    m => eprintln!("\n{}", color::paint("2", format_args!("[turn {index}/{m}]"))),
                }
            }
        }
        // In-progress signal is for the live TUI; the piped log stays quiet
        // until the full call (with args) arrives just below.
        // Headless prints one line per completed call; the in-progress signal
        // and its argument deltas have nothing to render into.
        StreamEvent::ToolCallStarted { .. } | StreamEvent::ToolCallArgsDelta { .. } => {}
        // Headless reports totals once, from the terminal `Done` -- unless the
        // run was asked to say more, in which case each turn's own numbers are
        // worth having, because a total hides which turn was expensive.
        StreamEvent::TurnUsage { usage, .. } => {
            if density == Density::Verbose {
                let (input, output, total) = (
                    usage.prompt_tokens.unwrap_or(0),
                    usage.completion_tokens.unwrap_or(0),
                    usage.total_tokens.unwrap_or(0),
                );
                eprintln!(
                    "{}",
                    color::paint(
                        "2",
                        format_args!(
                            "[turn-usage] in={input} out={output} total={total}",
                        ),
                    ),
                );
            }
        }
        StreamEvent::ToolCall { name, args, .. } => eprintln!(
            "{}",
            color::paint(
                "2",
                format_args!(
                    "[tool] {}",
                    sink_safe(
                        &crate::core::agent::events::describe_tool_call(&name, &args),
                        std::io::stderr().is_terminal()
                    ),
                ),
            ),
        ),
        StreamEvent::ToolResult {
            content, is_error, ..
        } => {
            let tag = if is_error {
                "tool-error"
            } else {
                "tool-result"
            };
            // A failure is never quiet: a compact run drops results, not the
            // news that something did not work.
            if density != Density::Compact || is_error {
                eprintln!(
                    "{}",
                    color::paint("2", format_args!("[{tag}] {}", sink_safe(&content, std::io::stderr().is_terminal())))
                );
            }
        }
        StreamEvent::SubagentStart { name, .. } => {
            eprintln!("{}", color::paint("2", format_args!("[subagent:{name}] started (background)")))
        }
        StreamEvent::SubagentQueued { name, waiting, .. } => {
            eprintln!("{}", color::paint("2", format_args!("[subagent:{name}] queued ({waiting} waiting)")))
        }
        StreamEvent::SubagentTitle { name, title, .. } => {
            eprintln!("{}", color::paint("2", format_args!("[subagent:{name}] {title}")))
        }
        StreamEvent::SubagentEnd { name, .. } => {
            eprintln!("{}", color::paint("2", format_args!("[subagent:{name}] finished")))
        }
        // Progress, not answer: the log is muted in the TUI and quiet elsewhere,
        // so this is the only place an in-run compaction shows.
        StreamEvent::Compaction { phase, reason, messages } => eprintln!(
            "{}",
            color::paint("2", format_args!("[compaction] {}", describe_compaction(phase, reason, messages)))
        ),
        // so this is the only place a long retry shows.
        StreamEvent::Retry { attempt, max_attempts, delay_ms, reason } => eprintln!(
            "{}",
            color::paint("2", format_args!("[retry] {reason}; attempt {attempt}/{max_attempts} in {delay_ms}ms"))
        ),
        StreamEvent::SubagentFinished { name, status, usage, .. } => {
            let tokens = usage
                .as_ref()
                .and_then(|u| u.get("total_tokens"))
                .and_then(|t| t.as_u64())
                .filter(|t| *t > 0);
            let note = match (status.as_str(), tokens) {
                ("turn_limit", _) => " stopped at its turn limit".to_string(),
                ("error", _) => " failed".to_string(),
                (_, Some(t)) => format!(" used {t} tokens"),
                _ => String::new(),
            };
            if !note.is_empty() {
                eprintln!("{}", color::paint("2", format_args!("[subagent:{name}]{note}")));
            }
        }
        StreamEvent::Subagent { name, event, .. } => {
            if let StreamEvent::PermissionRequest {
                request_id,
                tool_name,
                capability,
                path,
                command,
                diff,
                prompt_kind,
                ..
            } = *event
            {
                // The same prompt the parent's request gets: auto-denied with no
                // terminal, left to the client on stdin when one owns the answer.
                let detail = command
                    .map(|c| format!(" ({c})"))
                    .or_else(|| path.map(|p| format!(" on {p}")))
                    .unwrap_or_default();
                let detail = format!("{detail} from subagent '{name}'");
                if let Some(diff) = diff {
                    eprintln!("{}", color::paint("2", format_args!("{diff}")));
                }
                if duplex {
                    eprintln!(
                        "{}",
                        color::paint(
                            "33",
                            format_args!(
                                "[permission] {capability} via '{tool_name}'{detail} - awaiting '{request_id}' on stdin",
                            ),
                        ),
                    );
                    return;
                }
                let decision =
                    prompt_permission(&request_id, tool_name, capability, detail, prompt_kind == "secret").await;
                if let Some(sender) = registry.lock().await.remove(&request_id) {
                    let _ = sender.send(decision);
                }
            } else if let StreamEvent::Compaction { phase, reason, messages } = &*event {
                eprintln!(
                    "{}",
                    color::paint(
                        "2",
                        format_args!(
                            "[subagent:{name}] [compaction] {}",
                            describe_compaction(*phase, *reason, *messages)
                        ),
                    ),
                );
            } else if let StreamEvent::Retry { attempt, max_attempts, delay_ms, reason } = &*event {
                eprintln!(
                    "{}",
                    color::paint(
                        "2",
                        format_args!(
                            "[subagent:{name}] [retry] {reason}; attempt {attempt}/{max_attempts} in {delay_ms}ms"
                        ),
                    ),
                );
            } else if let StreamEvent::ToolCall {
                name: tool, args, ..
            } = *event
            {
                eprintln!(
                    "{}",
                    color::paint(
                        "2",
                        format_args!(
                            "[subagent:{name}] {}",
                            crate::core::agent::events::describe_tool_call(&tool, &args),
                        ),
                    ),
                );
            }
        }
        // AH-174: progress, not answer -- stderr, and only when something ran.
        StreamEvent::RunResources { resources } => {
            if density != Density::Compact {
                let figures = if resources.measured_commands > 0 {
                    format!(
                        "CPU {} ms, peak memory {} bytes, {} processes",
                        resources.cpu_ms, resources.peak_memory_bytes, resources.processes
                    )
                } else {
                    format!(
                        "not measured: {}",
                        resources.unmeasured_reason.as_deref().unwrap_or("unknown")
                    )
                };
                eprintln!(
                    "{}",
                    color::paint(
                        "2",
                        format_args!(
                            "[resources] {figures} ({} of {} commands measured)",
                            resources.measured_commands, resources.commands
                        ),
                    ),
                );
            }
        }
        // One typed ending for every surface (end_reason); a plain finish needs
        // no extra line, anything else says why in words.
        StreamEvent::RunEnded { reason, label, .. } => {
            if reason != "completed" {
                eprintln!("\n{}", color::paint("2", format_args!("[ended:{reason}] {label}")));
            }
        }
        StreamEvent::Done { stop_reason, usage } => {
            let tokens = usage.and_then(|u| u.total_tokens).unwrap_or(0);
            eprintln!("\n{}", color::paint("2", format_args!("[done] stop_reason={stop_reason} tokens={tokens}")));
        }
        StreamEvent::Error { code, message } => {
            // AH-009: the event already carries the classification, so the
            // line says what kind of failure it was once, and a cancellation
            // does not read as a crash.
            if code == "cancelled" {
                eprintln!("\n{}", color::paint("2", format_args!("[stopped] {message}")));
            } else {
                eprintln!("\n{}", color::paint("31", format_args!("[error:{code}] {message}")));
            }
        }
        StreamEvent::AskRequest { .. } => {
            eprintln!("\n{}", color::paint("31", format_args!("[error] interactive ask requires `flint agent ui`")))
        }
        // Headless never renders an ask prompt, so there is nothing to dismiss.
        StreamEvent::AskResolved { .. } => {}
        // The non-interactive CLI doesn't persist session state; a todo update
        // is silently dropped here (mirrors MessagesUpdated below).
        StreamEvent::TodoUpdate { .. } => {}
        // The non-interactive CLI doesn't persist session state, so
        // MessagesUpdated is a no-op here.
        StreamEvent::MessagesUpdated { .. } => {}
        StreamEvent::PermissionRequest {
            request_id,
            tool_name,
            capability,
            path,
            command,
            diff,
            reason,
            prompt_kind,
            ..
        } => {
            // Why a call auto-approval would have run is being asked about.
            if let Some(reason) = &reason {
                eprintln!("{}", color::paint("33", format_args!("[permission] {reason}")));
            }
            let detail = command
                .map(|c| format!(" ({c})"))
                .or_else(|| path.map(|p| format!(" on {p}")))
                .unwrap_or_default();
            if let Some(diff) = diff {
                eprintln!("{}", color::paint("2", format_args!("{diff}")));
            }
            if duplex {
                eprintln!(
                    "{}",
                    color::paint(
                        "33",
                        format_args!(
                            "[permission] {capability} via '{tool_name}'{detail} - awaiting '{request_id}' on stdin",
                        ),
                    ),
                );
                return;
            }
            let decision =
                prompt_permission(&request_id, tool_name, capability, detail, prompt_kind == "secret").await;
            if let Some(sender) = registry.lock().await.remove(&request_id) {
                let _ = sender.send(decision);
            }
        }
        // Only a host process can answer this, and only over the duplex
        // channel; a text-format run cannot declare host tools at all (the
        // flag requires stream-json both ways), so this is diagnostics only.
        StreamEvent::ToolRequest {
            request_id,
            tool_name,
            ..
        } => {
            eprintln!(
                "{}",
                color::paint(
                    "33",
                    format_args!("[host tool] '{tool_name}' - awaiting '{request_id}' on stdin"),
                ),
            );
        }
        StreamEvent::ToolRequestCancelled { request_id, reason } => {
            eprintln!(
                "{}",
                color::paint("2", format_args!("[host tool] '{request_id}' cancelled ({reason})")),
            );
        }
        // Structured data for a host's own display; text output has none.
        StreamEvent::ToolDetails { .. } => {}
    }
}

/// Ask the terminal to approve a gated tool call. Non-interactive stdin (pipe,
/// CI) auto-denies, matching the headless "safe default" contract; blocking
/// stdin is confined to a blocking thread so the loop task keeps running.
///
/// `d` answers later: the call is refused for now and recorded to be answered
/// with `flint cli approvals allow|deny` (it needs a session to resume, and
/// otherwise is just a refusal).
pub(super) async fn prompt_permission(
    request_id: &str,
    tool_name: String,
    capability: String,
    detail: String,
    // A write the credential scan flagged: "write anyway" for this one write,
    // and it is never put off to be answered later.
    secret: bool,
) -> PermissionDecision {
    let request_id = request_id.to_string();
    // What the human approves must be what runs: no escape or carriage return
    // from the model may rewrite the prompt line.
    let tool_name = display_safe::display_safe(&tool_name).into_owned();
    let capability = display_safe::display_safe(&capability).into_owned();
    let detail = display_safe::display_safe(&detail).into_owned();
    use std::io::IsTerminal;
    if !std::io::stdin().is_terminal() {
        eprintln!("{}", color::paint("33", format_args!("[permission] auto-denied {capability} via '{tool_name}' (non-interactive)")));
        return PermissionDecision::Deny;
    }
    tokio::task::spawn_blocking(move || {
        if secret {
            eprint!("{}", color::paint("33", format_args!("[permission] write anyway via '{tool_name}'{detail}? [y/N] ")));
        } else {
            eprint!("{}", color::paint("33", format_args!("[permission] allow {capability} via '{tool_name}'{detail}? [y/N/d=answer later] ")));
        }
        let _ = std::io::stderr().flush();
        let mut line = String::new();
        if std::io::stdin().read_line(&mut line).is_err() {
            return PermissionDecision::Deny;
        }
        match line.trim().to_ascii_lowercase().as_str() {
            "y" | "yes" => PermissionDecision::AllowOnce,
            "d" | "defer" | "later" if !secret => {
                crate::core::agent::approval_flow::mark_defer(&request_id);
                PermissionDecision::Deny
            }
            _ => PermissionDecision::Deny,
        }
    })
    .await
    .unwrap_or(PermissionDecision::Deny)
}

/// Write the result envelope to stdout, the last thing either machine format
/// puts there. `json` pretty-prints it -- those are read by people at least as
/// often as by programs, and `jq` does not care either way -- while
/// `stream-json` must keep it to the one line its contract promises.
pub(super) fn print_report(format: OutputFormat, report: run_report::RunResult) {
    if format.is_stream_json() {
        print_json_line(&report);
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).unwrap_or_default()
        );
    }
}

/// Write one NDJSON record and flush it, so a consumer reading the pipe sees
/// the event as it happens rather than when the block buffer fills.
pub(super) fn print_json_line<T: serde::Serialize>(value: &T) {
    let Some(line) = ndjson_line(value) else {
        return;
    };
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(line.as_bytes());
    let _ = out.flush();
}

/// Answer a permission request without printing progress, for the machine
/// formats. Leaving it unanswered would wedge the run: the loop waits on the
/// reply. Returns the decision so `stream-json` can report it; with no TTY
/// `prompt_permission` denies rather than blocking on a terminal nobody is at.
pub(super) async fn resolve_permission_silently(
    ev: StreamEvent,
    registry: &PermissionRegistry,
    duplex: bool,
) -> Option<(String, PermissionDecision)> {
    // A background subagent's prompt arrives wrapped in `Subagent` and waits on
    // the same registry as the parent's, so it needs the same answer. Left
    // unanswered it parks the run: the child's loop is waiting on the reply.
    let ev = match ev {
        StreamEvent::Subagent { event, .. } => *event,
        other => other,
    };
    let StreamEvent::PermissionRequest {
        request_id,
        tool_name,
        capability,
        path,
        command,
        prompt_kind,
        ..
    } = ev
    else {
        return None;
    };
    // With a client on stdin the decision is its call; answering here would
    // race the reply already on its way.
    if duplex {
        return None;
    }
    let detail = command
        .map(|c| format!(" ({c})"))
        .or_else(|| path.map(|p| format!(" on {p}")))
        .unwrap_or_default();
    let decision =
        prompt_permission(&request_id, tool_name, capability, detail, prompt_kind == "secret").await;
    if let Some(sender) = registry.lock().await.remove(&request_id) {
        let _ = sender.send(decision);
    }
    Some((request_id, decision))
}

/// Assistant text of a chat-completion response, if any.
pub(super) fn completion_text(completion: &serde_json::Value) -> Option<String> {
    let text = completion
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")
        .and_then(|v| v.as_str())?;
    (!text.is_empty()).then(|| text.to_string())
}

/// Put `section` where the file's `[tools]` block was, keeping everything
/// else exactly as it is: a policy import must not rewrite a project's model,
/// budget or skills.
/// Send this run's canonical events somewhere as they happen (AH-183).
///
/// `-` is stdout, anything else a file that is created or truncated. The
/// events are the same envelopes the session's log holds, one JSON line each,
/// written as they are recorded rather than read back afterwards -- so a
/// caller watching a headless run sees it happen.
///
/// Fails before the run starts when the destination cannot be written: a run
/// whose output nobody can see is not what was asked for.
pub fn stream_events_to(
    destination: &str,
) -> Result<(), tauri_plugin_agent_tools::harness_error::HarnessError> {
    use std::io::Write;
    use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};

    let sink: std::sync::Arc<std::sync::Mutex<Box<dyn Write + Send>>> = if destination == "-" {
        std::sync::Arc::new(std::sync::Mutex::new(Box::new(std::io::stdout())))
    } else {
        let file = std::fs::File::create(destination).map_err(|e| {
            HarnessError::new(
                ErrorKind::Io,
                format!("the event stream could not be opened: {e}"),
            )
            .at(Stage::Startup)
        })?;
        std::sync::Arc::new(std::sync::Mutex::new(Box::new(file)))
    };
    tauri_plugin_agent_tools::event_log::watch(move |envelope| {
        let Ok(line) = serde_json::to_string(envelope) else {
            return;
        };
        if let Ok(mut out) = sink.lock() {
            // A stream nobody is reading any more must not fail the run: the
            // record is on disk either way.
            let _ = writeln!(out, "{line}");
            let _ = out.flush();
        }
    });
    Ok(())
}
