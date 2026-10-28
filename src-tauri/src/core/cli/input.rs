//! Headless run input: the stdin line reader, bounded line reads, input-line
//! application and the follow-up/permission bookkeeping around it. Moved
//! verbatim out of `mod.rs`.

use super::*;

/// What a client line asks the reader to do next.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum InputFlow {
    Continue,
    /// A permission request was answered; the id and decision are echoed on the
    /// stream so it stays a complete account of the run.
    Decided(String, PermissionDecision),
    /// An `abort`: stop reading, the run is ending.
    Stop,
}

/// The registries a client line can resolve against.
pub(super) struct InputTargets<'a> {
    pub(super) permissions: &'a PermissionRegistry,
    pub(super) host_tools: &'a crate::core::agent::host_tools::HostToolRegistry,
}

/// Apply one client line. `Err` is the message reported back to the client; it
/// is never fatal, since this is a peer process's output and one malformed line
/// must not cost the work already done.
pub(super) async fn apply_input_line(
    line: &str,
    input: &StreamInput,
    targets: &InputTargets<'_>,
) -> Result<InputFlow, String> {
    let registry = targets.permissions;
    match parse_input_line(line)? {
        InputMessage::User(text) => {
            input.queue_user(text);
            Ok(InputFlow::Continue)
        }
        InputMessage::UserParts(parts) => {
            input.queue_user_parts(parts);
            Ok(InputFlow::Continue)
        }
        InputMessage::Abort => {
            input.abort();
            Ok(InputFlow::Stop)
        }
        InputMessage::Permission {
            request_id,
            decision,
        } => {
            // Taking the sender is what makes a decision single-use: a second
            // reply for the same id finds nothing and is reported, rather than
            // silently overwriting an answer the run already acted on.
            let sender = registry.lock().await.remove(&request_id);
            let Some(sender) = sender else {
                return Err(format!("no permission request '{request_id}' is pending"));
            };
            let _ = sender.send(decision);
            Ok(InputFlow::Decided(request_id, decision))
        }
        InputMessage::ToolResult { request_id, result } => {
            // Same single-use rule as a permission decision, and the same
            // reason: the run has already fed this answer to the model, so a
            // second one cannot be applied and must be reported rather than
            // silently dropped.
            crate::core::agent::host_tools::respond(targets.host_tools, &request_id, Ok(result))
                .await?;
            Ok(InputFlow::Continue)
        }
    }
}

/// One line from the client, bounded.
pub(super) struct ClientLine {
    pub(super) text: String,
    /// True when the line went past [`MAX_LINE_BYTES`] and was cut: `text` is
    /// then the echo-sized prefix, and the line is rejected without being
    /// parsed.
    pub(super) oversized: bool,
}

/// Client lines, read on a detached OS thread.
///
/// Not `tokio::io::stdin`: that parks the read on the runtime's blocking pool,
/// which shutdown waits for, so a client that keeps stdin open -- which is what
/// a duplex client does for the whole run -- leaves the process alive after its
/// terminal record has been printed. A plain thread dies with the process.
///
/// The read is bounded rather than line-at-a-time: a line is only as long as
/// the client says it is, and `BufRead::lines` would hold whatever arrives in
/// memory before the cap could be applied to it.
pub(super) fn stdin_lines() -> mpsc::UnboundedReceiver<ClientLine> {
    let (tx, rx) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        let mut reader = std::io::stdin().lock();
        while let Ok(Some(line)) = read_bounded_line(&mut reader) {
            if tx.send(line).is_err() {
                return;
            }
        }
    });
    rx
}

/// Read one line, keeping at most [`MAX_LINE_BYTES`] of it and discarding the
/// rest rather than growing to hold it.
///
/// A line over the cap keeps only its first [`MAX_ECHO_BYTES`]: it can never be
/// parsed, so the only use its bytes have left is the echo in `input_error`.
/// Cutting there can split a character, which is why the kept bytes go through
/// `from_utf8_lossy` -- the echo is for a human, and a line that is over the cap
/// is already being refused.
pub(super) fn read_bounded_line<R: std::io::BufRead>(
    reader: &mut R,
) -> std::io::Result<Option<ClientLine>> {
    let mut bytes: Vec<u8> = Vec::new();
    let mut oversized = false;
    let mut saw_any = false;
    loop {
        let available = match reader.fill_buf()? {
            [] => break,
            buf => buf,
        };
        saw_any = true;
        let newline = available.iter().position(|b| *b == b'\n');
        let take = newline.map_or(available.len(), |i| i + 1);
        if !oversized {
            let room = MAX_LINE_BYTES.saturating_sub(bytes.len());
            if take <= room {
                bytes.extend_from_slice(&available[..take]);
            } else {
                bytes.truncate(MAX_ECHO_BYTES.min(bytes.len()));
                oversized = true;
            }
        }
        reader.consume(take);
        if newline.is_some() {
            break;
        }
    }
    if !saw_any {
        return Ok(None);
    }
    while matches!(bytes.last(), Some(b'\n') | Some(b'\r')) {
        bytes.pop();
    }
    Ok(Some(ClientLine {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        oversized,
    }))
}

/// Consume client messages until `abort` or end of input.
///
/// End of input is not an abort: a client that has said everything it means to
/// say may close the pipe and still want its answer. It *is* the end of the
/// only thing that can answer a permission request or run a host tool, though,
/// so the exit is latched and anything already waiting is released -- see
/// [`strand_pending_permissions`] and
/// [`crate::core::agent::host_tools::strand_all`]. Each released host request
/// is reported on `events` as `tool_request_cancelled`.
///
/// An `abort` leaves the host requests alone: the run's abort path withdraws
/// them itself, as `aborted` rather than `client_gone`.
pub(super) async fn read_input_lines(
    mut lines: mpsc::UnboundedReceiver<ClientLine>,
    input: Arc<StreamInput>,
    registry: PermissionRegistry,
    host_tools: crate::core::agent::host_tools::HostToolRegistry,
    events: mpsc::UnboundedSender<StreamEvent>,
    format: OutputFormat,
) {
    let targets = InputTargets {
        permissions: &registry,
        host_tools: &host_tools,
    };
    let mut aborted = false;
    while let Some(line) = lines.recv().await {
        if line.oversized {
            report_input_error(
                format,
                &format!("line is over the {MAX_LINE_BYTES} byte cap"),
                &line.text,
            );
            continue;
        }
        let line = line.text;
        if line.trim().is_empty() {
            continue;
        }
        match apply_input_line(&line, &input, &targets).await {
            Ok(InputFlow::Continue) => {}
            Ok(InputFlow::Decided(request_id, decision)) => {
                if format.is_stream_json() {
                    print_json_line(&PermissionDecisionRecord::new(&request_id, decision));
                }
            }
            Ok(InputFlow::Stop) => {
                aborted = true;
                break;
            }
            Err(message) => report_input_error(format, &message, &line),
        }
    }
    // Latch first: a request raised between the drain and the latch would
    // otherwise be recorded as the client's to answer and find no reader.
    input.mark_client_gone();
    strand_pending_permissions(&registry, format).await;
    if aborted {
        return;
    }
    // A host tool call cannot be answered by anyone else, so a parked turn is
    // released with a typed failure rather than waiting on a dead pipe.
    for id in crate::core::agent::host_tools::strand_all(&host_tools).await {
        let _ = events.send(request_cancelled(&id, CANCEL_CLIENT_GONE));
    }
}

/// Name the follow-ups the run ended before reaching. Queued turns are joined
/// at a turn boundary, so a run that stops first (abort, error, or an answer
/// the model considered final) never consumes them; reported one by one, since
/// the text is what the client needs to decide whether to send it again.
pub(super) fn report_dropped_follow_ups(input: &StreamInput, format: OutputFormat) {
    for turn in input.take_queued() {
        // The text, whether it arrived as a string or as content parts: an
        // image-only follow-up reads as empty here, which is all this report
        // needs to say about it.
        let text = crate::core::cli::user_message::text_of_content(&turn["content"]);
        report_input_error(format, "run ended before this follow-up was read", &text);
    }
}

/// Release every request still waiting on a client that has gone. Dropping the
/// sender is what resolves the run's `rx.await` to `Deny`, so the run declines
/// the call and finishes with its result envelope rather than parking forever.
/// The decision is echoed for the same reason a client-sent one is: the stream
/// stays a complete account of what the run did.
pub(super) async fn strand_pending_permissions(registry: &PermissionRegistry, format: OutputFormat) {
    let stranded: Vec<String> = registry.lock().await.drain().map(|(id, _)| id).collect();
    for request_id in stranded {
        if format.is_stream_json() {
            print_json_line(&PermissionDecisionRecord::new(
                &request_id,
                PermissionDecision::Deny,
            ));
        } else {
            eprintln!(
                "{}",
                color::paint(
                    "33",
                    format_args!(
                        "[permission] auto-denied '{request_id}' (client closed stdin)",
                    ),
                ),
            );
        }
    }
}

pub(super) fn spawn_input_reader(
    input: Arc<StreamInput>,
    registry: PermissionRegistry,
    host_tools: crate::core::agent::host_tools::HostToolRegistry,
    events: mpsc::UnboundedSender<StreamEvent>,
    format: OutputFormat,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(read_input_lines(
        stdin_lines(),
        input,
        registry,
        host_tools,
        events,
        format,
    ))
}

/// Tell the client its line was rejected, on whichever stream it is reading.
pub(super) fn report_input_error(format: OutputFormat, message: &str, line: &str) {
    if format.is_stream_json() {
        print_json_line(&InputErrorRecord::new(message, line));
    } else {
        eprintln!("{}", color::paint("33", format_args!("[input] {message}")));
    }
}
