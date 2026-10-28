/// A proposed memory is asked about, answered, and the answer sticks.
///
/// This asserts on the DOM *and* on the file. A card that renders from renderer
/// state while nothing is written, and a record that is written while no card
/// renders, are both failures that a DOM-only or a file-only check reports as a
/// pass.
///
/// No message is sent: a turn would put a provider round trip between this
/// scenario and the thing it tests, and a proposal is keyed to the chat rather
/// than to anything in the transcript. The route, the components and the
/// commands are the production ones.
fn scenario_memory_proposal(ctx: &Ctx) -> ScenarioResult {
    let records = match memory_records_path("session.jsonl") {
        Some(p) => p,
        None => bail!("JAN_DATA_FOLDER is not set, so the store cannot be inspected"),
    };
    // Start from a store with no proposals in it, so "the card is gone" below
    // means this scenario's proposal was answered rather than that an earlier
    // scenario's never appeared.
    let _ = std::fs::remove_file(&records);

    let thread_id = "smoke-memory-proposal";
    let open_chat = |ctx: &Ctx| -> ScenarioResult {
        // Leaving the route and coming back is what remounts the surface, and
        // remounting is what re-reads the store. `goto` on the route that is
        // already current does nothing at all, which is the trap here. A full
        // page reload is not an option: it tears down the channel this harness
        // evaluates over.
        ctx.goto("/")?;
        ctx.settle();
        ctx.goto(&format!("/threads/{thread_id}"))?;
        ctx.wait_until(
            "the conversation to render",
            "return !!document.querySelector('[data-testid=\"chat-input\"]');",
            Duration::from_secs(45),
        )
    };
    open_chat(ctx)?;

    // Propose over real IPC, the way the model-facing path does. Automatic
    // saving is off by default, so this has to come back as a question.
    let outcome = ctx.eval_string(&format!(
        r#"const c = await window.__TAURI_INTERNALS__.invoke('get_app_configurations');
           const out = await window.__TAURI_INTERNALS__.invoke(
             'plugin:agent-tools|memory_record_propose_inferred',
             {{
               location: {{ dataFolder: c.data_folder, sessionId: {thread_id:?} }},
               scope: 'chat',
               content: 'The user prefers tabs for indentation.',
               sourceSessionId: {thread_id:?},
               sourceMessageId: 'smoke-1',
             }},
           );
           return JSON.stringify(out);"#
    ))?;
    ensure!(
        outcome.contains("needsApproval"),
        "an inferred memory saved itself with automatic saving off: {outcome}"
    );
    ensure!(
        outcome.contains("automatic-saving-disabled"),
        "the reason was not the one the card explains: {outcome}"
    );

    // On disk before anything is clicked: the question survives the turn.
    let on_disk = std::fs::read_to_string(&records).unwrap_or_default();
    ensure!(
        on_disk.contains(r#""state":"proposed""#),
        "the proposal was not recorded, so it could not survive a restart"
    );
    ensure!(
        !on_disk.contains(r#""state":"active""#),
        "an unanswered proposal was stored as an active memory"
    );

    // Does the backend offer it? Asked separately so "the list is empty" and
    // "the list has it and nothing rendered" cannot be reported as one failure.
    let listed = ctx.eval_string(&format!(
        r#"const c = await window.__TAURI_INTERNALS__.invoke('get_app_configurations');
           const out = await window.__TAURI_INTERNALS__.invoke(
             'plugin:agent-tools|memory_proposals_list',
             {{ location: {{ dataFolder: c.data_folder, sessionId: {thread_id:?} }} }},
           );
           return JSON.stringify(out);"#
    ))?;
    ensure!(
        listed.contains("prefers tabs"),
        "the backend did not offer the proposal to the renderer: {listed}"
    );

    // And in the DOM, in the conversation it came from. A question the user has
    // not answered has to still be there when they come back to the chat.
    open_chat(ctx)?;
    ctx.wait_until(
        "the approval card",
        "return !!document.querySelector('[data-testid=\"memory-proposal-card\"]');",
        Duration::from_secs(30),
    )?;
    let shown = ctx.eval_string(
        r#"const card = document.querySelector('[data-testid="memory-proposal-card"]');
           const text = (sel) => {
             const el = card.querySelector(sel);
             return el ? el.textContent : '';
           };
           return JSON.stringify({
             reason: card.getAttribute('data-reason'),
             content: text('[data-testid="memory-proposal-content"]'),
             explanation: text('[data-testid="memory-proposal-explanation"]'),
             approvable: !!card.querySelector('[data-testid="memory-proposal-approve"]'),
           });"#,
    )?;
    ensure!(
        shown.contains("automatic-saving-disabled"),
        "the card did not carry the backend's reason: {shown}"
    );
    ensure!(
        shown.contains("waiting for you"),
        "the card explained nothing specific: {shown}"
    );
    ensure!(
        shown.contains("prefers tabs"),
        "the card did not show what would be remembered: {shown}"
    );
    ensure!(
        shown.contains("\"approvable\":true"),
        "an approvable proposal offered no way to approve it: {shown}"
    );

    // Approve it. The card is not the decision -- the click round-trips, and
    // the file is what says whether it took.
    ctx.eval(
        "document.querySelector('[data-testid=\"memory-proposal-approve\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the card to clear",
        "return !document.querySelector('[data-testid=\"memory-proposal-card\"]');",
        Duration::from_secs(30),
    )?;
    let after = std::fs::read_to_string(&records).unwrap_or_default();
    ensure!(
        after.contains(r#""state":"active""#),
        "approving did not make the memory real: {after}"
    );
    ensure!(
        !after.contains(r#""state":"proposed""#),
        "the answered question was left in the store as a proposal"
    );

    // Come back again. The decision is a fact on disk, not renderer state, and
    // re-entering the conversation re-reads the store: the answered question is
    // not there to ask.
    open_chat(ctx)?;
    ctx.settle();
    let reappeared = ctx
        .eval_bool("return !!document.querySelector('[data-testid=\"memory-proposal-card\"]');")?;
    ensure!(
        !reappeared,
        "a question that was already answered was asked again on re-entry"
    );

    // A contradiction is a different question, and it must never render as
    // something to wave through.
    //
    // Each side names one option and not the other, on purpose: `detect_conflicts`
    // ignores a pair where both records mention both sides, so "prefers tabs over
    // spaces" and "prefers spaces over tabs" are *not* reported as a conflict. That
    // is deliberate conservatism -- an unresolved conflict withholds both records,
    // so a false one silently costs the user two good memories.
    let conflict = ctx.eval_string(&format!(
        r#"const c = await window.__TAURI_INTERNALS__.invoke('get_app_configurations');
           const out = await window.__TAURI_INTERNALS__.invoke(
             'plugin:agent-tools|memory_record_propose_inferred',
             {{
               location: {{ dataFolder: c.data_folder, sessionId: {thread_id:?} }},
               scope: 'chat',
               content: 'The user prefers spaces for indentation.',
               sourceSessionId: {thread_id:?},
               sourceMessageId: 'smoke-2',
             }},
           );
           return JSON.stringify(out);"#
    ))?;
    ensure!(
        conflict.contains("conflicts-with-existing"),
        "a contradiction was not detected: {conflict}"
    );
    open_chat(ctx)?;
    ctx.wait_until(
        "the conflict card",
        "return !!document.querySelector('[data-testid=\"memory-proposal-card\"]');",
        Duration::from_secs(30),
    )?;
    let conflict_card = ctx.eval_string(
        r#"const card = document.querySelector('[data-testid="memory-proposal-card"]');
           return JSON.stringify({
             reason: card.getAttribute('data-reason'),
             approve: !!card.querySelector('[data-testid="memory-proposal-approve"]'),
             review: !!card.querySelector('[data-testid="memory-proposal-resolve-conflict"]'),
           });"#,
    )?;
    ensure!(
        conflict_card.contains("\"approve\":false"),
        "a conflicted proposal offered an Approve button: {conflict_card}"
    );
    ensure!(
        conflict_card.contains("\"review\":true"),
        "a conflicted proposal offered no way to settle it: {conflict_card}"
    );

    // Leave the store as this scenario found it.
    let _ = std::fs::remove_file(&records);
    Ok(())
}

// ---------------------------------------------------------------------------
// Durability and integration regressions (the batch-1 fixes, end to end)
// ---------------------------------------------------------------------------

/// Everything the prompt log holds, as text.
fn prompts_text() -> Result<String, Failure> {
    let path = data_folder()?.join("audit").join("prompts.jsonl");
    Ok(std::fs::read_to_string(path).unwrap_or_default())
}

/// AH-083: forgetting a memory reaches the requests it was already sent in.
/// The snapshot stays -- the run still happened -- but the words are replaced
/// by a marker saying why, so the inspector, the CLI and any export show a
/// redaction rather than the forgotten text.
fn scenario_memory_forget_redacts_prompts(ctx: &Ctx) -> ScenarioResult {
    const FORGETTABLE: &str = "Smoke privacy fact: the staging host is called larkspur.";
    ctx.script_model("plain", &[])?;
    new_cowork_session(ctx)?;
    attach_folder(ctx, &ctx.project)?;
    send_cowork(ctx, "first turn, before the memory")?;
    let session = current_cowork_session(ctx)?;

    let id = commit_session_memory(ctx, &session, FORGETTABLE)?;
    send_cowork(ctx, "second turn, carrying the memory")?;
    let system = last_system_prompt(ctx)?;
    ensure!(
        system.contains("larkspur"),
        "the memory never reached the model, so there is nothing to forget from: {system}"
    );
    let before = prompts_text()?;
    ensure!(before.contains("larkspur"), "the prompt log did not keep the request");

    forget_session_memory(ctx, &session, &id)?;

    // The words are gone from every snapshot that carried them, and the
    // requests are still there.
    let deadline = Instant::now() + Duration::from_secs(30);
    let after = loop {
        let text = prompts_text()?;
        if !text.contains("larkspur") {
            break text;
        }
        ensure!(
            Instant::now() < deadline,
            "the forgotten memory is still in the prompt log"
        );
        std::thread::sleep(Duration::from_millis(500));
    };
    ensure!(
        after.contains("[redacted: forgotten memory]"),
        "the redaction left no trace of why: {}",
        after.chars().take(400).collect::<String>()
    );
    ensure!(
        after.contains("second turn, carrying the memory"),
        "the request itself was lost with the memory"
    );
    ensure!(
        after.lines().filter(|l| !l.trim().is_empty()).count()
            == before.lines().filter(|l| !l.trim().is_empty()).count(),
        "a snapshot was dropped instead of redacted"
    );

    // And what the CLI-facing reader shows agrees with the file.
    let (ok, page) = ipc(
        ctx,
        "agent_prompt_snapshots",
        &serde_json::json!({ "session": session, "snapshotId": null, "run": null }).to_string(),
    )?;
    if ok {
        let shown = page.to_string();
        ensure!(!shown.contains("larkspur"), "the snapshot reader still shows the forgotten text");
    }
    Ok(())
}

/// The canonical events of one session, newest last.
fn session_events(ctx: &Ctx, session: &str) -> Result<Vec<Value>, Failure> {
    let (ok, page) = ipc(
        ctx,
        "agent_events_list",
        &serde_json::json!({ "session": session, "afterSeq": 0, "limit": 500 }).to_string(),
    )?;
    ensure!(ok, "agent_events_list failed: {page}");
    Ok(page["events"].as_array().cloned().unwrap_or_default())
}

/// The thread the chat is showing, from the route.
fn current_thread_id(ctx: &Ctx) -> Result<String, Failure> {
    ctx.eval_string(
        "const m = (location.hash || location.pathname).match(/threads\\/([^/?#]+)/);
         return m ? m[1] : '';",
    )
}

/// The owner both halves of the durable-job pair use.
const JOB_RECORD_OWNER: &str = "smoke-job-record";

/// AH-101/AH-102, first half: a background job is written down durably, with
/// its provenance and a redacted command, and its ending is recorded.
fn scenario_background_job_record(ctx: &Ctx) -> ScenarioResult {
    let data = std::env::var("JAN_DATA_FOLDER").map_err(|_| Failure("JAN_DATA_FOLDER unset".into()))?;
    // Long enough that it is still running when this half ends, so the second
    // half has something for the next process to decide about.
    let command = "Start-Sleep -Seconds 240; echo token=sk-live_abcdefghijklmnop0123456789";
    let (ok, started) = ipc(
        ctx,
        "plugin:agent-tools|execute_tool",
        &format!(
            "{{ dataFolder: {data:?}, threadId: {JOB_RECORD_OWNER:?}, name: 'bash', \
               args: {{ command: {command:?}, background: true }}, callId: 'job-record-1' }}"
        ),
    )?;
    let content = started.get("content").and_then(Value::as_str).unwrap_or("").to_string();
    if !ok || content.contains("bash is unavailable") {
        bail!("BLOCKED: this host starts no sandboxed shell, so no background job can run: {started}");
    }
    let job = content
        .split("job_id=")
        .nth(1)
        .and_then(|rest| rest.split(')').next())
        .map(str::to_string)
        .ok_or_else(|| Failure(format!("no job id in: {content}")))?;

    let records = |session: &str| -> Result<Vec<Value>, Failure> {
        let (ok, v) = ipc(
            ctx,
            "agent_background_jobs",
            &serde_json::json!({ "session": session }).to_string(),
        )?;
        ensure!(ok, "agent_background_jobs failed: {v}");
        Ok(v.as_array().cloned().unwrap_or_default())
    };

    let mine = records(JOB_RECORD_OWNER)?;
    let record = mine
        .iter()
        .find(|r| r["id"] == job.as_str())
        .cloned()
        .ok_or_else(|| Failure(format!("the job was not written down: {mine:?}")))?;
    println!("      record: {}", serde_json::to_string(&record).unwrap_or_default());
    ensure!(record["state"] == "running", "a running job is not recorded as running: {record}");
    ensure!(
        record["identity"]["pid"].as_u64().unwrap_or(0) > 0
            && record["identity"]["created"].as_u64().unwrap_or(0) > 0,
        "the record cannot identify its process again: {record}"
    );
    let summary = record["summary"].as_str().unwrap_or_default();
    ensure!(
        !summary.contains("sk-live_abcdefghijklmnop0123456789"),
        "the recorded command kept a credential: {summary}"
    );
    ensure!(summary.contains("Start-Sleep"), "the record says nothing about the command: {summary}");
    // Another conversation sees nothing of it.
    ensure!(
        records("smoke-job-record-other")?.is_empty(),
        "another conversation was shown this job"
    );

    // A second job, stopped on request, is recorded as stopped.
    let (ok, second) = ipc(
        ctx,
        "plugin:agent-tools|execute_tool",
        &format!(
            "{{ dataFolder: {data:?}, threadId: {JOB_RECORD_OWNER:?}, name: 'bash', \
               args: {{ command: 'Start-Sleep -Seconds 240', background: true }}, callId: 'job-record-2' }}"
        ),
    )?;
    let text = second.get("content").and_then(Value::as_str).unwrap_or("").to_string();
    ensure!(ok, "the second job did not start: {second}");
    let stoppable = text
        .split("job_id=")
        .nth(1)
        .and_then(|rest| rest.split(')').next())
        .map(str::to_string)
        .ok_or_else(|| Failure(format!("no job id in: {text}")))?;
    let (ok, cancelled) = ipc(
        ctx,
        "plugin:agent-tools|execute_tool",
        &format!(
            "{{ dataFolder: {data:?}, threadId: {JOB_RECORD_OWNER:?}, name: 'bash', \
               args: {{ action: 'cancel', job_id: {stoppable:?} }}, callId: 'job-record-3' }}"
        ),
    )?;
    ensure!(ok, "the cancel failed: {cancelled}");
    let after = records(JOB_RECORD_OWNER)?;
    let stopped = after
        .iter()
        .find(|r| r["id"] == stoppable.as_str())
        .cloned()
        .ok_or_else(|| Failure(format!("the stopped job left no record: {after:?}")))?;
    ensure!(stopped["state"] == "cancelled", "a stopped job is not recorded as stopped: {stopped}");
    ensure!(
        stopped["identity"]["pid"].as_u64().unwrap_or(0) == 0,
        "an ended job kept a pid something could act on later: {stopped}"
    );
    Ok(())
}

/// AH-101/AH-102, second half, after a real restart: the record is still
/// there, and the job whose process died with the app reads as interrupted --
/// not as still running, and not as completed, because nobody saw it end.
fn scenario_background_job_record_restart(ctx: &Ctx) -> ScenarioResult {
    let (ok, v) = ipc(
        ctx,
        "agent_background_jobs",
        &serde_json::json!({ "session": JOB_RECORD_OWNER }).to_string(),
    )?;
    ensure!(ok, "agent_background_jobs failed after the restart: {v}");
    let records = v.as_array().cloned().unwrap_or_default();
    ensure!(
        !records.is_empty(),
        "the jobs the earlier process started were not kept"
    );
    println!("      after restart: {}", serde_json::to_string(&records).unwrap_or_default());
    for record in &records {
        let state = record["state"].as_str().unwrap_or_default();
        let pid = record["identity"]["pid"].as_u64().unwrap_or(0);
        ensure!(
            state != "completed",
            "an ending nobody saw was reported as completion: {record}"
        );
        ensure!(
            matches!(state, "running" | "interrupted" | "orphaned" | "cancelled" | "failed"),
            "unexpected state {state:?}: {record}"
        );
        if state == "running" {
            // Either the process really did outlive the app -- which is the
            // whole point -- and was re-identified by pid *and* creation time,
            // or it should have been settled. What must never happen is a job
            // reading "running" with nothing to identify it by.
            ensure!(
                pid > 0 && record["identity"]["created"].as_u64().unwrap_or(0) > 0,
                "a job reads as running with nothing to identify it by: {record}"
            );
        } else {
            ensure!(
                pid == 0,
                "a settled job kept a pid that could be reused: {record}"
            );
        }
    }
    // The job that was stopped before the restart keeps its ending, whatever
    // became of the other one.
    ensure!(
        records.iter().any(|r| r["state"] == "cancelled"),
        "the job stopped before the restart lost its ending: {records:?}"
    );
    // And every job the earlier process left is accounted for: either settled,
    // or still running and provably the same process.
    ensure!(
        records.iter().all(|r| r["state"] != "running"
            || r["identity"]["created"].as_u64().unwrap_or(0) > 0),
        "a job was carried over without being re-identified: {records:?}"
    );
    Ok(())
}

/// AH-008: an id that was not parsed never reaches storage, and no spelling
/// of one session's id reads another's record.
///
/// Driven through the same commands the renderer calls. The hostile ids are
/// the ones that would matter: a path separator (the record is a file named
/// after the session), a parent directory, a control character, and an id that
/// merely begins with a real one.
fn scenario_identity_boundary(ctx: &Ctx) -> ScenarioResult {
    new_cowork_session(ctx)?;
    let session = current_cowork_session(ctx)?;
    ensure!(!session.is_empty(), "the cowork session has no id");

    // Something real to try to reach.
    let (ok, wrote) = ipc(
        ctx,
        "agent_events_record",
        &serde_json::json!({
            "events": [{
                "id": "identity:marker",
                "session": session,
                "run": format!("{session}#run-identity"),
                "invocation": "",
                "kind": "run.started",
                "payload": { "model": "smoke-model", "source": "identity-scenario" },
            }],
        })
        .to_string(),
    )?;
    ensure!(ok, "the marker event was not recorded: {wrote}");
    ensure!(
        session_events(ctx, &session)?
            .iter()
            .any(|e| e["id"] == "identity:marker"),
        "the marker is not in this session's record"
    );

    // An id that could name a place on disk is refused, and writes nothing.
    for hostile in [
        format!("{session}/../other"),
        format!("../{session}"),
        format!("{session}\\other"),
        format!("{session}{}", char::from(7u8)),
        "  ".to_string(),
    ] {
        let (ok, answer) = ipc(
            ctx,
            "agent_events_record",
            &serde_json::json!({
                "events": [{
                    "id": "identity:forged",
                    "session": hostile,
                    "run": "",
                    "invocation": "",
                    "kind": "run.started",
                    "payload": {},
                }],
            })
            .to_string(),
        )?;
        // Either the command refuses, or it reports the event as not written:
        // what must never happen is the event appearing anywhere.
        let written = answer.to_string().contains("identity:forged")
            && !answer.to_string().contains("error");
        ensure!(
            !ok || !written,
            "an unparsed session id was accepted: {hostile:?} -> {answer}"
        );
        // Reading with the same spelling either refuses or finds nothing;
        // what it must never do is hand back another session's record.
        let (read_ok, page) = ipc(
            ctx,
            "agent_events_list",
            &serde_json::json!({ "session": hostile, "afterSeq": 0, "limit": 50 }).to_string(),
        )?;
        let text = page.to_string();
        ensure!(
            !read_ok || !text.contains("identity:marker"),
            "{hostile:?} read another session's record: {text}"
        );
        ensure!(
            !text.contains("identity:forged"),
            "{hostile:?} stored an event: {text}"
        );
    }

    // A near-miss id -- one that merely begins with a real session's -- is a
    // different session, with nothing in it.
    let lookalike = format!("{session}x");
    ensure!(
        session_events(ctx, &lookalike)?.is_empty(),
        "an id that only starts the same read the real session's record"
    );

    // The other readers agree: a run of this session is not readable by a
    // hostile spelling of it, and is a typed refusal rather than a silence.
    let (ok, refused) = ipc(
        ctx,
        "agent_run_tree",
        &serde_json::json!({ "session": format!("{session}/..") }).to_string(),
    )?;
    ensure!(!ok, "a hostile id produced a run tree: {refused}");
    let (ok, tree) = ipc(
        ctx,
        "agent_run_tree",
        &serde_json::json!({ "session": session }).to_string(),
    )?;
    ensure!(ok, "the real session has no run tree: {tree}");
    Ok(())
}

/// AH-172: a session with a very long record still opens, and stays bounded.
///
/// Five thousand events are recorded into a real session through the command
/// the renderer uses, and the Timeline is opened on it. What is asserted is
/// what a person would notice: the panel appears within a few seconds, it
/// draws a bounded number of rows rather than one per event, the last event is
/// the one in view, a filter still narrows it, and the keyboard still moves
/// through it. The rows are untrusted text -- a tool name carrying markup and
/// a path carrying a traversal -- so this also shows them rendered as text.
fn scenario_timeline_stays_bounded(ctx: &Ctx) -> ScenarioResult {
    const EVENTS: usize = 5_000;
    ctx.script_model("plain", &[])?;
    new_cowork_session(ctx)?;
    let session = current_cowork_session(ctx)?;

    // Written through the same command the renderer records with, in batches,
    // so this is the real path and the real envelope.
    let started = Instant::now();
    let (ok, wrote) = ipc(
        ctx,
        "agent_events_record",
        &serde_json::json!({
            "events": [{
                "id": "long:run:started",
                "session": session,
                "run": "long-run",
                "invocation": "",
                "kind": "run.started",
                "payload": { "model": "smoke-model", "source": "synthetic" },
            }],
        })
        .to_string(),
    )?;
    ensure!(ok, "the synthetic run could not be started: {wrote}");
    let batches = EVENTS / 250;
    for batch in 0..batches {
        let events: Vec<serde_json::Value> = (0..250)
            .map(|i| {
                let n = batch * 250 + i;
                serde_json::json!({
                    "id": format!("long:{n}"),
                    "session": session,
                    "run": "long-run",
                    "invocation": format!("long-run#{}", n / 5),
                    "kind": "message.completed",
                    "payload": {
                        // Untrusted-looking text: a row must render it, not run it.
                        "phase": "completed",
                        "textChars": n,
                        "toolCalls": 0,
                        "detail": "<img src=x onerror=alert(1)> ../../etc/passwd",
                    },
                })
            })
            .collect();
        let (ok, wrote) = ipc(
            ctx,
            "agent_events_record",
            &serde_json::json!({ "events": events }).to_string(),
        )?;
        ensure!(ok, "batch {batch} was refused: {wrote}");
    }
    let (ok, wrote) = ipc(
        ctx,
        "agent_events_record",
        &serde_json::json!({
            "events": [{
                "id": "long:run:ended",
                "session": session,
                "run": "long-run",
                "invocation": "",
                "kind": "run.ended",
                "payload": { "stoppedBy": "done", "source": "synthetic" },
            }],
        })
        .to_string(),
    )?;
    ensure!(ok, "the synthetic run could not be ended: {wrote}");
    println!("      recorded {EVENTS} events in {:?}", started.elapsed());

    // The panel opens on that record.
    let opened = Instant::now();
    show_timeline(ctx)?;
    ctx.wait_until(
        "the long record's rows",
        "return document.querySelectorAll('[data-testid=\"timeline-row\"]').length > 0;",
        Duration::from_secs(30),
    )?;
    let took = opened.elapsed();
    println!("      the timeline opened in {took:?}");
    ensure!(
        took < Duration::from_secs(20),
        "the timeline took {took:?} to show a record of {EVENTS}"
    );

    // Bounded: a row per event would be 5,000 of them.
    let drawn = ctx.eval_string(
        "const list = document.querySelector('[data-testid=\"timeline-list\"]');
         return JSON.stringify({
           rows: document.querySelectorAll('[data-testid=\"timeline-row\"]').length,
           virtual: list ? list.dataset.virtual : 'no-list',
         });",
    )?;
    let drawn: serde_json::Value = serde_json::from_str(&drawn)
        .map_err(|e| Failure(format!("the timeline did not answer JSON ({e}): {drawn}")))?;
    let rows = drawn["rows"].as_u64().unwrap_or(0);
    println!("      {rows} rows drawn for {EVENTS} events (virtual={})", drawn["virtual"]);
    ensure!(rows > 0, "the timeline drew nothing: {drawn}");
    ensure!(
        rows < 400,
        "the timeline drew {rows} rows for {EVENTS} events, which is not bounded"
    );
    ensure!(
        drawn["virtual"] == "true",
        "the long record is not virtualized: {drawn}"
    );

    // The untrusted text is text, not markup.
    let inert = ctx.eval_bool(
        "return !document.querySelector('[data-testid=\"timeline-list\"] img')
           && !/onerror=/.test(document.querySelector('[data-testid=\"timeline-list\"]')?.innerHTML || '');",
    )?;
    ensure!(inert, "a row rendered untrusted text as markup");

    // A filter still narrows it, and everything comes back.
    let before = rows;
    ctx.eval("document.querySelector('[data-testid=\"timeline-filter-messages\"]').click(); return true;")?;
    ctx.settle();
    let narrowed = ctx.eval_string(
        "return String(document.querySelectorAll('[data-testid=\"timeline-row\"]').length);",
    )?;
    let narrowed: u64 = narrowed.trim().parse().unwrap_or(u64::MAX);
    ensure!(
        narrowed < before,
        "turning the messages filter off changed nothing ({before} -> {narrowed})"
    );
    ctx.eval("document.querySelector('[data-testid=\"timeline-filter-messages\"]').click(); return true;")?;
    ctx.settle();

    // And the keyboard still moves through it.
    let moved = ctx.eval_bool(
        "const rows = [...document.querySelectorAll('[data-testid=\"timeline-row\"]')];
         if (!rows.length) return false;
         rows[0].focus();
         const before = document.activeElement;
         rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
         return document.activeElement !== before || rows.length > 1;",
    )?;
    ensure!(moved, "the keyboard does not move through a long timeline");
    Ok(())
}

/// AH-032: a finished run replays from the canonical record.
///
/// A real Cowork turn with a tool call is run, then the same commands the UI
/// calls are asked what replaying that run would do: which request, which
/// stored payload, and which tools the original used -- which the plan shows
/// and the replay never runs. Beginning one hands back the payload from disk
/// and opens a run of its own that names its source; settling it closes that
/// run. The source run is left exactly as it was, and another session's run
/// is refused.
fn scenario_replay_from_record(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("tools", &["ls:{\"path\":\".\"}"])?;
    new_cowork_session(ctx)?;
    attach_folder(ctx, &ctx.project)?;
    send_cowork(ctx, "list the folder, then stop")?;
    let session = current_cowork_session(ctx)?;

    // Wait for the run the turn produced, and its tool call, to be recorded.
    let deadline = Instant::now() + Duration::from_secs(90);
    let (run, _) = loop {
        let events = session_events(ctx, &session)?;
        // The run that dispatched: a Cowork turn also opens a chat run for the
        // SDK's own steps, and only the one that recorded its payload can be
        // replayed from the record.
        let dispatched = events
            .iter()
            .find(|e| e["kind"] == "message.completed" && e["payload"]["phase"] == "dispatched")
            .and_then(|e| e["run"].as_str())
            .map(str::to_string);
        if let Some(run) = dispatched {
            let ended = events
                .iter()
                .any(|e| e["kind"] == "run.ended" && e["run"] == run.as_str());
            if ended {
                break (run, events.len());
            }
        }
        if Instant::now() >= deadline {
            let (_, snaps) = ipc(
                ctx,
                "agent_prompt_snapshots",
                &serde_json::json!({ "session": session }).to_string(),
            )?;
            let kinds: Vec<String> = session_events(ctx, &session)?
                .iter()
                .map(|e| format!("{}|{}", e["kind"].as_str().unwrap_or(""), e["run"].as_str().unwrap_or("")))
                .collect();
            return Err(Failure(format!(
                "the turn never finished recording. kinds={kinds:?} snapshots={}",
                snaps.as_array().map(|a| a.len()).unwrap_or(0)
            )));
        }
        std::thread::sleep(Duration::from_millis(500));
    };
    ensure!(!run.is_empty(), "the recorded run has no id");

    // What would be replayed, before anything is sent.
    let (ok, plan) = ipc(
        ctx,
        "agent_replay_plan",
        &serde_json::json!({ "session": session, "run": run }).to_string(),
    )?;
    ensure!(ok, "agent_replay_plan failed: {plan}");
    ensure!(plan["run"] == run.as_str(), "the plan is of another run: {plan}");
    ensure!(plan["stoppedBy"] == "done", "the plan misreports the ending: {plan}");
    let steps = plan["steps"].as_array().cloned().unwrap_or_default();
    ensure!(!steps.is_empty(), "the plan has no request to replay: {plan}");
    ensure!(
        steps.iter().any(|s| s["sendable"] == true
            && s["snapshotId"].as_str().is_some_and(|id| !id.is_empty())),
        "no step carries a stored payload: {plan}"
    );
    let tools = plan["toolCalls"].as_array().cloned().unwrap_or_default();
    ensure!(
        tools.iter().any(|t| t == "ls"),
        "the plan does not say what the original ran: {plan}"
    );

    // The deterministic half: the run's own events, read back, nothing sent.
    let (ok, recorded) = ipc(
        ctx,
        "agent_replay_recorded",
        &serde_json::json!({ "session": session, "run": run }).to_string(),
    )?;
    ensure!(ok, "agent_replay_recorded failed: {recorded}");
    let recorded = recorded.as_array().cloned().unwrap_or_default();
    ensure!(
        recorded.iter().all(|e| e["run"] == run.as_str()),
        "the recorded run carries another run's events"
    );
    let before = recorded.len();

    // A run of a session that does not own it is refused, typed.
    let (ok, refused) = ipc(
        ctx,
        "agent_replay_plan",
        &serde_json::json!({ "session": "not-this-session", "run": run }).to_string(),
    )?;
    ensure!(!ok, "another session was allowed to plan this run: {refused}");
    ensure!(
        refused.to_string().contains("unknown-run"),
        "the refusal is not typed: {refused}"
    );

    // Beginning one hands back the stored payload and opens its own run.
    let (ok, started) = ipc(
        ctx,
        "agent_replay_run_begin",
        &serde_json::json!({ "session": session, "run": run, "invocation": null }).to_string(),
    )?;
    ensure!(ok, "agent_replay_run_begin failed: {started}");
    ensure!(
        started["payload"]["messages"].is_array(),
        "the replay was not handed the stored request: {started}"
    );
    let replay_id = started["record"]["id"].as_str().unwrap_or_default().to_string();
    ensure!(!replay_id.is_empty(), "the replay has no id: {started}");
    let replay_run = format!("replay-{replay_id}");

    let (ok, settled) = ipc(
        ctx,
        "agent_replay_run_settle",
        &serde_json::json!({
            "session": session,
            "replayId": replay_id,
            "outcome": { "status": "completed", "text": "replayed" },
        })
        .to_string(),
    )?;
    ensure!(ok, "agent_replay_run_settle failed: {settled}");

    let after = session_events(ctx, &session)?;
    let replay_events: Vec<&Value> =
        after.iter().filter(|e| e["run"] == replay_run.as_str()).collect();
    ensure!(
        replay_events.iter().any(|e| e["kind"] == "run.started"
            && e["payload"]["replayOf"] == run.as_str()
            && e["payload"]["source"] == "replay"),
        "the replay did not record whose replay it is: {replay_events:?}"
    );
    ensure!(
        replay_events
            .iter()
            .any(|e| e["kind"] == "run.ended" && e["payload"]["stoppedBy"] == "done"),
        "the replay's end was not recorded: {replay_events:?}"
    );
    let source_now = after.iter().filter(|e| e["run"] == run.as_str()).count();
    ensure!(
        source_now == before,
        "replaying wrote into the source run ({before} -> {source_now})"
    );
    Ok(())
}

/// AH-004: a Chat turn writes the same canonical record a Cowork turn does --
/// the run, every tool phase, what the request cost, what the reply was made
/// of, and how the turn ended -- all under one run and joined by the
/// invocation of the request that caused them.
fn scenario_chat_execution_record(ctx: &Ctx) -> ScenarioResult {
    let was_on = set_builtin_web_search(ctx, false)?;
    let result = (|| {
        ctx.script_model("tools", &["web_search:{\"query\":\"execution record query\"}"])?;
        new_chat(ctx)?;
        ctx.type_into("[data-testid=\"chat-input\"]", "search the web for the record query")?;
        ctx.wait_until(
            "the send control to arm",
            "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
             return !!b && b.disabled !== true;",
            Duration::from_secs(60),
        )?;
        ctx.eval("document.querySelector('[data-test-id=\"send-message-button\"]').click(); return true;")?;
        ctx.wait_until(
            "the approval request",
            "return !!document.querySelector('[data-testid=\"inline-approval-card\"]')
               || (document.body.innerText || '').includes('This tool needs your approval before it runs.');",
            Duration::from_secs(60),
        )?;
        let clicked = ctx.eval_bool(
            "const b = [...document.querySelectorAll('button')]
               .find(x => /^allow once$/i.test((x.textContent || '').trim()));
             if (!b) return false; b.click(); return true;",
        )?;
        ensure!(clicked, "no Allow Once control on the approval card");
        ctx.wait_until(
            "the turn to finish",
            "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
            Duration::from_secs(120),
        )?;
        let session = current_thread_id(ctx)?;
        ensure!(!session.is_empty(), "the chat has no thread id in its route");

        // The record, as the app reports it back.
        let deadline = Instant::now() + Duration::from_secs(60);
        let events = loop {
            let events = session_events(ctx, &session)?;
            let kinds: Vec<&str> = events.iter().filter_map(|e| e["kind"].as_str()).collect();
            let complete = [
                "run.started",
                "tool.requested",
                "tool.succeeded",
                "usage.reported",
                "message.completed",
                "run.ended",
            ]
            .iter()
            .all(|k| kinds.contains(k));
            if complete {
                break events;
            }
            ensure!(Instant::now() < deadline, "the chat turn never reached the record: {kinds:?}");
            std::thread::sleep(Duration::from_millis(500));
        };
        let kinds: Vec<&str> = events.iter().filter_map(|e| e["kind"].as_str()).collect();
        for kind in [
            "run.started",
            "tool.requested",
            "tool.succeeded",
            "usage.reported",
            "message.completed",
            "run.ended",
        ] {
            ensure!(kinds.contains(&kind), "{kind} is missing from the chat record: {kinds:?}");
        }
        ensure!(
            kinds.iter().any(|k| *k == "tool.awaiting-permission" || *k == "tool.allowed"),
            "the approval is not in the record: {kinds:?}"
        );

        // One run, and the tool joined to the request that asked for it.
        let field = |e: &Value, name: &str| e[name].as_str().unwrap_or_default().to_string();
        let runs: Vec<String> = events.iter().map(|e| field(e, "run")).filter(|r| !r.is_empty()).collect();
        let first_run = runs.first().cloned().unwrap_or_default();
        ensure!(!first_run.is_empty(), "the chat events carry no run: {events:?}");
        ensure!(runs.iter().all(|r| *r == first_run), "one turn wrote more than one run: {runs:?}");
        let tool_invocation = events
            .iter()
            .find(|e| field(e, "kind") == "tool.requested")
            .map(|e| field(e, "invocation"))
            .unwrap_or_default();
        ensure!(!tool_invocation.is_empty(), "the tool call names no request");
        let usage_invocations: Vec<String> = events
            .iter()
            .filter(|e| field(e, "kind") == "usage.reported")
            .map(|e| field(e, "invocation"))
            .collect();
        ensure!(
            usage_invocations.contains(&tool_invocation),
            "no request's usage matches the tool call's invocation: {usage_invocations:?} vs {tool_invocation}"
        );
        ensure!(
            usage_invocations.iter().collect::<std::collections::BTreeSet<_>>().len() == usage_invocations.len(),
            "two requests share one invocation: {usage_invocations:?}"
        );
        let ended = events
            .iter()
            .find(|e| field(e, "kind") == "run.ended")
            .cloned()
            .unwrap_or(Value::Null);
        ensure!(
            ended["payload"]["stoppedBy"] == "done" && ended["payload"]["source"] == "chat",
            "the chat run did not end cleanly: {ended}"
        );
        ensure!(
            ended["payload"]["steps"].as_u64().unwrap_or(0) >= 2,
            "a turn with a tool call took fewer than two requests: {ended}"
        );

        // And the usage is the provider's own counts, not an estimate.
        let usage = events
            .iter()
            .find(|e| field(e, "kind") == "usage.reported")
            .cloned()
            .unwrap_or(Value::Null);
        ensure!(
            usage["payload"]["inputTokens"].as_u64().unwrap_or(0) > 0,
            "the recorded usage has no input tokens: {usage}"
        );

        // AH-032/AH-083: the record says which payload each request sent, so a
        // Chat turn can be replayed from the record rather than reconstructed.
        let dispatched: Vec<&Value> = events
            .iter()
            .filter(|e| field(e, "kind") == "message.completed"
                && e["payload"]["phase"] == "dispatched")
            .collect();
        ensure!(
            dispatched.len() >= 2,
            "a two-request turn recorded {} dispatches: {events:?}",
            dispatched.len()
        );
        ensure!(
            dispatched.iter().all(|e| e["payload"]["snapshotId"]
                .as_str()
                .is_some_and(|id| !id.is_empty())),
            "a dispatch names no stored request: {dispatched:?}"
        );
        let (ok, plan) = ipc(
            ctx,
            "agent_replay_plan",
            &serde_json::json!({ "session": session, "run": first_run }).to_string(),
        )?;
        ensure!(ok, "a Chat run cannot be replayed from the record: {plan}");
        ensure!(
            plan["steps"].as_array().map(|s| s.len()).unwrap_or(0) >= 2
                && plan["steps"][0]["sendable"] == true,
            "the Chat run's plan has no sendable request: {plan}"
        );

        // Nothing of this turn reached another session's log.
        let other = session_events(ctx, "a-thread-that-never-ran")?;
        ensure!(other.is_empty(), "another session's log is not empty: {other:?}");
        println!("      chat record: {} events, run {first_run}", events.len());
        Ok(())
    })();
    let _ = set_builtin_web_search(ctx, was_on);
    result
}

const AGENT_PROVENANCE_EXPECTED: &str = "agent-provenance-expected.json";
const PROVENANCE_AGENT: &str = "scribe";

/// The undo journal of `session`, as the app reports it.
fn undo_journal_of(ctx: &Ctx, session: &str) -> Result<Value, Failure> {
    let data = data_folder()?.to_string_lossy().to_string();
    let (ok, journal) = ipc(
        ctx,
        "plugin:agent-tools|undo_journal",
        &serde_json::json!({ "dataFolder": data, "sessionId": session }).to_string(),
    )?;
    ensure!(ok, "undo_journal failed: {journal}");
    Ok(journal)
}

/// Who the journal says changed each file, as `<file name> -> <actor id>`.
fn journal_actors(journal: &Value) -> Vec<(String, String)> {
    journal
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|turn| turn["changes"].as_array().into_iter().flatten())
        .map(|change| {
            let path = change["path"].as_str().unwrap_or_default();
            let name = path.rsplit(['/', '\\']).next().unwrap_or(path).to_string();
            let actor = change["actor"]["id"].as_str().unwrap_or("unknown").to_string();
            (name, actor)
        })
        .collect()
}

/// What the Changes panel says about who made each turn's changes.
fn shown_actor_ids(ctx: &Ctx) -> Result<String, Failure> {
    ctx.eval_string(
        "return [...document.querySelectorAll('[data-testid=\"turn-undo-actor\"]')]
           .map(e => e.getAttribute('data-actor-ids') || '').join(' | ');",
    )
}

fn shown_actor_text(ctx: &Ctx) -> Result<String, Failure> {
    ctx.eval_string(
        "return [...document.querySelectorAll('[data-testid=\"turn-undo-actor\"]')]
           .map(e => e.textContent || '').join(' | ');",
    )
}

/// AH-110: every change says which agent made it -- the primary agent, a
/// saved custom agent, or one of Jan's roles -- in the journal, in the
/// Changes panel and on the Timeline.
fn scenario_agent_provenance(ctx: &Ctx) -> ScenarioResult {
    // A saved custom agent, so the run has a named agent as well as a role.
    let subagents = data_folder()?.join("agent-workspace").join("subagents");
    std::fs::create_dir_all(&subagents).map_err(|e| Failure(e.to_string()))?;
    std::fs::write(
        subagents.join(format!("{PROVENANCE_AGENT}.toml")),
        format!(
            "name = \"{PROVENANCE_AGENT}\"\n\
             description = \"Writes one file, for the provenance scenario.\"\n\
             system_prompt = \"Write the file you are asked for and stop.\"\n\
             allowed_tools = [\"write\", \"read\", \"ls\"]\n"
        ),
    )
    .map_err(|e| Failure(e.to_string()))?;

    let write_call = |file: &str, body: &str| {
        format!(
            "write:{}",
            serde_json::json!({ "path": file, "content": body })
        )
    };
    let routes = serde_json::json!([
        {
            "match": "PROV-SCRIBE",
            "tools": [write_call("prov-scribe.txt", "written by the custom agent\n")],
            "summary": "scribe finished",
        },
        {
            "match": "PROV-IMPL",
            "tools": [write_call("prov-implementer.txt", "written by the role\n")],
            "summary": "implementer finished",
        },
    ]);
    let parent_calls = vec![
        write_call("prov-main.txt", "written by the primary agent\n"),
        format!(
            "task:{}",
            serde_json::json!({ "subagent_name": PROVENANCE_AGENT, "description": "PROV-SCRIBE: write the file" })
        ),
        format!(
            "task:{}",
            serde_json::json!({ "subagent_name": "implementer", "description": "PROV-IMPL: write the file" })
        ),
    ];
    let port = ctx.mock_port;
    ensure!(
        ctx.eval_bool(&format!(
            r#"const res = await fetch('http://127.0.0.1:{port}/__control', {{
                 method: 'POST', headers: {{ 'Content-Type': 'application/json' }},
                 body: JSON.stringify({{ script: 'tools', tools: {}, routes: {routes} }}),
               }});
               return res.ok;"#,
            serde_json::to_string(&parent_calls).unwrap()
        ))?,
        "could not script the provenance run"
    );

    new_cowork_session(ctx)?;
    choose_mode(ctx, "Autonomous")?;
    ctx.type_into("[data-testid=\"chat-input\"]", "Write the three files.")?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]'); return !!b && !b.disabled;",
        Duration::from_secs(60),
    )?;
    ctx.eval("document.querySelector('[data-test-id=\"send-message-button\"]').click(); return true;")?;
    let session = {
        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            let _ = ctx.eval(
                "const b = [...document.querySelectorAll('button')].find(x =>
                   /^allow once$/i.test((x.textContent || '').trim()));
                 if (b) b.click();
                 return true;",
            );
            let answered = |who: &str| {
                mock_requests(ctx).unwrap_or_default().iter().any(|r| {
                    r["messages"].as_array().into_iter().flatten().any(|m| {
                        m["role"] == "tool" && m["content"].to_string().contains(&format!("{who} finished"))
                    })
                })
            };
            let idle = ctx
                .eval_bool("return !!document.querySelector('[data-test-id=\"send-message-button\"]');")
                .unwrap_or(false);
            if answered("scribe") && answered("implementer") && idle {
                break current_cowork_session(ctx)?;
            }
            if Instant::now() >= deadline {
                bail!("the run did not finish with both children answered");
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    };

    // The journal: one actor per file, each the agent that wrote it.
    let journal = undo_journal_of(ctx, &session)?;
    let actors = journal_actors(&journal);
    let of = |file: &str| {
        actors
            .iter()
            .find(|(name, _)| name == file)
            .map(|(_, id)| id.clone())
            .unwrap_or_default()
    };
    ensure!(of("prov-main.txt") == "agent", "main's change: {actors:?}");
    ensure!(
        of("prov-scribe.txt") == format!("agent:{PROVENANCE_AGENT}"),
        "the custom agent's change: {actors:?}"
    );
    ensure!(
        of("prov-implementer.txt") == "role:implementer",
        "the role's change: {actors:?}"
    );

    // The Changes panel says the same thing in words.
    open_turn_undo(ctx)?;
    ctx.wait_until(
        "the panel to name an agent",
        "return !!document.querySelector('[data-testid=\"turn-undo-actor\"]');",
        Duration::from_secs(30),
    )?;
    let ids = shown_actor_ids(ctx)?;
    for id in ["agent", &format!("agent:{PROVENANCE_AGENT}"), "role:implementer"] {
        ensure!(ids.contains(id), "{id} is not shown in the Changes panel: {ids}");
    }
    let words = shown_actor_text(ctx)?;
    for phrase in ["the primary agent", PROVENANCE_AGENT, "implementer role"] {
        ensure!(words.contains(phrase), "{phrase:?} is not said in the Changes panel: {words}");
    }
    ensure!(!words.contains("unknown agent"), "a change was left unattributed: {words}");

    // And the Timeline attributes the same calls.
    show_timeline(ctx)?;
    let timeline = ctx.eval_string(
        "return [...document.querySelectorAll('[data-testid=\"timeline-row-actor\"]')]
           .map(e => e.getAttribute('data-actor-id') || '').join(' ');",
    )?;
    for id in ["agent", &format!("agent:{PROVENANCE_AGENT}"), "role:implementer"] {
        ensure!(timeline.contains(id), "{id} is not on the Timeline: {timeline}");
    }

    // A refused change leaves nothing to attribute: Review mode withholds
    // `write` altogether, so the journal must not grow.
    let before = journal_actors(&undo_journal_of(ctx, &session)?).len();
    ctx.script_model("tools", &[write_call("prov-refused.txt", "should never be written\n").as_str()])?;
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    choose_mode(ctx, "Review first")?;
    send_cowork(ctx, "try to write the refused file")?;
    let after = journal_actors(&undo_journal_of(ctx, &session)?);
    ensure!(after.len() == before, "a refused write reached the journal: {after:?}");
    ensure!(
        !after.iter().any(|(name, _)| name == "prov-refused.txt"),
        "the refused file is in the journal: {after:?}"
    );

    std::fs::write(
        data_folder()?.join(AGENT_PROVENANCE_EXPECTED),
        serde_json::json!({ "session": session }).to_string(),
    )
    .map_err(|e| Failure(format!("could not record the session: {e}")))?;
    Ok(())
}

/// The same provenance after a restart, when the custom agent has been
/// renamed, and for a record written before provenance existed.
fn scenario_agent_provenance_restart(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    let raw = std::fs::read_to_string(data_folder()?.join(AGENT_PROVENANCE_EXPECTED)).map_err(|e| {
        Failure(format!(
            "no recorded session ({e}); run agent-provenance first with the same COWORK_SMOKE_KEEP"
        ))
    })?;
    let expected: Value = serde_json::from_str(&raw).map_err(|e| Failure(e.to_string()))?;
    let session = expected["session"].as_str().unwrap_or_default().to_string();
    ensure!(!session.is_empty(), "the recorded session is empty");

    // The custom agent is renamed between the runs: what it changed before
    // must still name the agent that changed it.
    let subagents = data_folder()?.join("agent-workspace").join("subagents");
    let _ = std::fs::remove_file(subagents.join(format!("{PROVENANCE_AGENT}.toml")));
    std::fs::write(
        subagents.join("scribe-renamed.toml"),
        "name = \"scribe-renamed\"\n\
         description = \"The same agent under a new name.\"\n\
         system_prompt = \"Write the file you are asked for and stop.\"\n\
         allowed_tools = [\"write\"]\n",
    )
    .map_err(|e| Failure(e.to_string()))?;

    let journal = undo_journal_of(ctx, &session)?;
    let actors = journal_actors(&journal);
    ensure!(
        actors.iter().any(|(name, id)| name == "prov-scribe.txt" && id == &format!("agent:{PROVENANCE_AGENT}")),
        "the renamed agent's old change lost its identity: {actors:?}"
    );
    ensure!(
        actors.iter().any(|(name, id)| name == "prov-implementer.txt" && id == "role:implementer"),
        "the role's change did not survive the restart: {actors:?}"
    );

    open_cowork_session(ctx, &session)?;
    open_turn_undo(ctx)?;
    ctx.wait_until(
        "the panel to name an agent after the restart",
        "return !!document.querySelector('[data-testid=\"turn-undo-actor\"]');",
        Duration::from_secs(30),
    )?;
    let ids = shown_actor_ids(ctx)?;
    ensure!(
        ids.contains(&format!("agent:{PROVENANCE_AGENT}")) && ids.contains("role:implementer"),
        "the panel lost the agents after the restart: {ids}"
    );
    let words = shown_actor_text(ctx)?;
    ensure!(
        words.contains(PROVENANCE_AGENT) && !words.contains("scribe-renamed"),
        "the renamed agent rewrote an old change: {words}"
    );

    // One session's changes are not another's.
    let other = undo_journal_of(ctx, "a-session-that-never-ran")?;
    ensure!(
        journal_actors(&other).is_empty(),
        "another session's journal is not empty: {other}"
    );

    // A record written before provenance existed reads as unknown, never as
    // the agent running now.
    let path = find_journal_for(&data_folder()?, &session)
        .ok_or_else(|| Failure("the journal file is not where it was expected".into()))?;
    let text = std::fs::read_to_string(&path).map_err(|e| Failure(e.to_string()))?;
    let mut doc: Value = serde_json::from_str(&text).map_err(|e| Failure(e.to_string()))?;
    let mut stripped = false;
    for turn in doc["turns"].as_array_mut().into_iter().flatten() {
        for change in turn["files"].as_array_mut().into_iter().flatten() {
            if change["path"].as_str().unwrap_or_default().ends_with("prov-main.txt") {
                change.as_object_mut().map(|o| o.remove("actor"));
                stripped = true;
            }
        }
    }
    ensure!(stripped, "the primary agent's change is not in {}", path.display());
    std::fs::write(&path, doc.to_string()).map_err(|e| Failure(e.to_string()))?;
    // The panel reads the journal when it mounts, so it is closed and opened
    // again: what is being checked is a fresh read, not what was on screen.
    ctx.eval(
        r#"const b = [...document.querySelectorAll('button')].find(x =>
             /^Changes$|changed/i.test(x.getAttribute('aria-label') || ''));
           if (b && b.getAttribute('aria-pressed') === 'true') b.click();
           return true;"#,
    )?;
    ctx.settle();
    open_turn_undo(ctx)?;
    ctx.wait_until(
        "the panel to reload the journal",
        "return !!document.querySelector('[data-testid=\"turn-undo-actor\"]');",
        Duration::from_secs(30),
    )?;
    let words = shown_actor_text(ctx)?;
    ensure!(
        words.contains("unknown agent"),
        "a record with no agent was not shown as unknown: {words}"
    );
    ensure!(
        words.contains(PROVENANCE_AGENT),
        "the other agents were lost when one became unknown: {words}"
    );
    Ok(())
}

/// The journal file of `session`, found by its content rather than its name.
fn find_journal_for(data: &Path, session: &str) -> Option<PathBuf> {
    fn walk(dir: &Path, session: &str, out: &mut Option<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, session, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    if text.contains(session) && text.contains("\"turns\"") {
                        *out = Some(path);
                        return;
                    }
                }
            }
            if out.is_some() {
                return;
            }
        }
    }
    let mut found = None;
    walk(data, session, &mut found);
    found
}

/// The methods the web-search fixture has received so far, with times.
fn mcp_methods_seen() -> Result<Vec<(String, f64)>, Failure> {
    let text = std::fs::read_to_string(data_folder()?.join(MCP_METHODS_LOG)).unwrap_or_default();
    Ok(text
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .map(|v| {
            (
                v["method"].as_str().unwrap_or("").to_string(),
                v["at"].as_f64().unwrap_or(0.0),
            )
        })
        .collect())
}

fn wait_for_methods(
    what: &str,
    limit: Duration,
    done: impl Fn(&[(String, f64)]) -> bool,
) -> Result<Vec<(String, f64)>, Failure> {
    let deadline = Instant::now() + limit;
    loop {
        let seen = mcp_methods_seen()?;
        if done(&seen) {
            return Ok(seen);
        }
        if Instant::now() >= deadline {
            let methods: Vec<&str> = seen.iter().map(|(m, _)| m.as_str()).collect();
            bail!("timed out waiting for {what}; the MCP fixture saw {methods:?}");
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// AH-139: the app checks its MCP servers with the protocol `ping`, on a
/// schedule, and a server that dies is found by that probe and restarted.
/// The fixture records every method it receives, so what the app sent is
/// read from the server's side, not inferred.
fn scenario_mcp_liveness(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    let count = |seen: &[(String, f64)], m: &str| seen.iter().filter(|(x, _)| x == m).count();
    // Two pings, 30s apart: the monitor's schedule.
    let seen = wait_for_methods("two liveness pings", Duration::from_secs(100), |s| count(s, "ping") >= 2)?;
    let pings: Vec<f64> = seen.iter().filter(|(m, _)| m == "ping").map(|(_, at)| *at).collect();
    let gap = pings[1] - pings[0];
    ensure!((20.0..=45.0).contains(&gap), "pings were {gap:.1}s apart, not on the 30s schedule");
    ensure!(count(&seen, "initialize") == 1, "the server was restarted while alive: {seen:?}");

    // Stop exactly the fixture (its own pid file), then the next probe must
    // find it gone and the app must bring it back.
    let pid_path = data_folder()?.join(MCP_PID_FILE);
    let pid: u32 = std::fs::read_to_string(&pid_path)
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .ok_or_else(|| Failure("the MCP fixture wrote no pid".into()))?;
    let image = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase())
        .unwrap_or_default();
    ensure!(image.contains("python"), "pid {pid} is not the python fixture: {image}");
    let killed = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    ensure!(killed, "could not stop the MCP fixture (pid {pid})");
    let before = seen.len();
    let back = wait_for_methods("the server to be restarted after it died", Duration::from_secs(120), |s| {
        s.len() > before && s[before..].iter().any(|(m, _)| m == "initialize")
    })?;
    let new_pid = std::fs::read_to_string(&pid_path).unwrap_or_default();
    ensure!(new_pid.trim() != pid.to_string(), "the pid file still names the dead server");
    let logs = std::fs::read_dir(data_folder()?.join("logs"))
        .map(|rd| rd.flatten().filter_map(|e| std::fs::read_to_string(e.path()).ok()).collect::<String>())
        .unwrap_or_default();
    ensure!(
        logs.contains(&format!("MCP server {SMOKE_MCP_WEB_SEARCH} failed health check")),
        "the restart was not the health check's doing"
    );
    // And the restarted server is probed with ping too.
    let after_restart = back.len();
    wait_for_methods("a ping to the restarted server", Duration::from_secs(60), |s| {
        s.len() > after_restart && s[after_restart..].iter().any(|(m, _)| m == "ping")
    })?;
    Ok(())
}

const TRANSFER_EXPECTED: &str = "memory-transfer-expected.json";
const TRANSFER_FACT: &str = "Smoke transfer fact: release builds are signed on the build farm.";
const TRANSFER_FORGOTTEN: &str = "Smoke transfer fact: the staging host is called larkspur.";

/// Click a memory-page button once it is enabled.
fn click_memory_button(ctx: &Ctx, testid: &str) -> ScenarioResult {
    ctx.wait_until(
        &format!("{testid} to be enabled"),
        &format!("const b = document.querySelector('[data-testid=\"{testid}\"]'); return !!b && !b.disabled;"),
        Duration::from_secs(20),
    )?;
    ctx.eval(&format!("document.querySelector('[data-testid=\"{testid}\"]').click(); return true;"))?;
    Ok(())
}

/// Import `file` through the page's Import button and the real picker
/// command (only the OS dialog is scripted); returns the rendered report's
/// imported / duplicates / refused counts.
fn import_through_the_page(ctx: &Ctx, file: &Path) -> Result<(String, String, String), Failure> {
    // A report from an earlier import must not satisfy the wait below.
    ctx.eval("document.querySelector('[data-testid=\"memory-import-report\"]')?.setAttribute('data-stale', '1'); return true;")?;
    ctx.script_dialog(Some(file));
    let clicked = click_memory_button(ctx, "memory-import");
    let landed = clicked.and_then(|()| {
        ctx.wait_until(
            "the import report",
            "const r = document.querySelector('[data-testid=\"memory-import-report\"]'); return !!r && !r.hasAttribute('data-stale');",
            Duration::from_secs(30),
        )
    });
    if let Err(e) = landed {
        let toasts = ctx
            .eval_string("return [...document.querySelectorAll('[data-sonner-toast]')].map(t => t.textContent).join(' || ');")
            .unwrap_or_default();
        let direct = ctx
            .eval_string(&format!(
                r#"const c = await window.__TAURI_INTERNALS__.invoke('get_app_configurations');
                   const picked = await window.__TAURI_INTERNALS__.invoke('open_dialog', {{ options: {{ multiple: false }} }}).catch(e => 'open failed: ' + e);
                   try {{
                     return JSON.stringify({{ picked, report: await window.__TAURI_INTERNALS__.invoke('plugin:agent-tools|memory_import', {{
                       location: {{ dataFolder: c.data_folder }}, scope: 'user', path: {path:?},
                     }}) }});
                   }} catch (e) {{ return JSON.stringify({{ picked, error: String(e?.message ?? e) }}); }}"#,
                path = file.to_string_lossy()
            ))
            .unwrap_or_default();
        ctx.clear_dialog_script();
        bail!("{} (toasts: {toasts}; direct: {direct})", e.0);
    }
    ctx.clear_dialog_script();
    let attr = |a: &str| {
        ctx.eval_string(&format!(
            "return document.querySelector('[data-testid=\"memory-import-report\"]').getAttribute('{a}') || '';"
        ))
    };
    Ok((attr("data-imported")?, attr("data-duplicates")?, attr("data-refused")?))
}

/// AH-083: a user memory leaves in an export with its provenance, is
/// forgotten, and comes back through Import marked as imported, with where it
/// was first written. A record altered after export is refused and named;
/// importing twice adds nothing; forgotten text never reaches the file; the
/// imported memory is recalled into a real request.
fn scenario_memory_export_import(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    // Stored before the page is first opened, so its first load lists them:
    // re-navigating to the same route does not reload the list.
    let kept = commit_memory(ctx, "user", None, TRANSFER_FACT)?;
    let dropped = commit_memory(ctx, "user", None, TRANSFER_FORGOTTEN)?;
    forget_memory(ctx, "user", None, &dropped)?;
    goto_memory_page(ctx)?;
    ctx.wait_until(
        "the memory to list",
        &format!("return !!document.querySelector('[data-testid=\"memory-row\"][data-memory-id={kept:?}]');"),
        Duration::from_secs(20),
    )?;

    // Export through the page's button and the real save_dialog command.
    let dir = data_folder()?.join("smoke-exports");
    std::fs::create_dir_all(&dir).map_err(|e| Failure(e.to_string()))?;
    let export = dir.join("memory-user.json");
    let _ = std::fs::remove_file(&export);
    // The script stays set until the file lands: the click only starts the
    // save, and the picker command runs after it returns.
    ctx.script_dialog(Some(&export));
    let clicked = click_memory_button(ctx, "memory-export");
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while clicked.is_ok() && !export.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(200));
    }
    ctx.clear_dialog_script();
    clicked?;
    let text = std::fs::read_to_string(&export)
        .map_err(|e| Failure(format!("the export was not written to {}: {e}", export.display())))?;
    let file: Value = serde_json::from_str(&text).map_err(|e| Failure(format!("the export is not JSON: {e}")))?;
    ensure!(file["format"] == "jan-memory-export" && file["version"] == 1, "unexpected export header: {text}");
    let export_id = file["exportId"].as_str().unwrap_or_default().to_string();
    let record = file["records"]
        .as_array()
        .and_then(|r| r.iter().find(|m| m["id"] == kept.as_str()))
        .cloned()
        .ok_or_else(|| Failure(format!("the kept memory is not in the export: {text}")))?;
    ensure!(record["sourceType"] == "user-authored", "exported source type: {record}");
    ensure!(!text.contains("larkspur"), "forgotten text reached the export: {text}");

    // Forget it here, then prove a tampered copy is refused and named.
    forget_memory(ctx, "user", None, &kept)?;
    ensure!(!user_store_text(ctx)?.contains("build farm"), "forgotten text is still in the store");
    let mut tampered = file.clone();
    let mut altered = record.clone();
    altered["content"] = Value::String("Smoke transfer fact: release builds are never signed.".into());
    tampered["records"] = Value::Array(vec![altered]);
    let tampered_path = dir.join("memory-user-tampered.json");
    std::fs::write(&tampered_path, tampered.to_string()).map_err(|e| Failure(e.to_string()))?;
    goto_memory_page(ctx)?;
    let (imported, _, refused) = import_through_the_page(ctx, &tampered_path)?;
    ensure!(imported == "0" && refused == "1", "tampered import: imported {imported}, refused {refused}");
    let why = ctx.eval_string("return document.querySelector('[data-testid=\"memory-import-refused\"]')?.textContent || '';")?;
    ensure!(why.contains(&kept) && why.contains("changed after it was exported"), "refusal not named: {why}");
    ensure!(!user_store_text(ctx)?.contains("never signed"), "tampered text reached the store");

    // The real file imports once; a second import adds nothing.
    let (imported, dups, refused) = import_through_the_page(ctx, &export)?;
    ensure!(imported == "1" && refused == "0" && dups == "0", "import: {imported}/{dups}/{refused}");
    let (imported, dups, _) = import_through_the_page(ctx, &export)?;
    ensure!(imported == "0" && dups == "1", "second import: imported {imported}, duplicates {dups}");

    let new_id = listed_user_memory(ctx, "build farm")?;
    ensure!(!new_id.is_empty() && new_id != kept, "the imported memory was not listed under a new id");
    let row = format!("[data-testid=\"memory-row\"][data-memory-id={new_id:?}]");
    ctx.wait_until(
        "the imported row",
        &format!("return !!document.querySelector('{row} [data-testid=\"memory-provenance-imported\"]');"),
        Duration::from_secs(20),
    )?;
    let shown = ctx.eval_string(&format!(
        "const q = s => document.querySelector('{row} ' + s)?.textContent || ''; return [q('[data-testid=\"memory-provenance-source\"]'), q('[data-testid=\"memory-provenance-imported\"]'), q('[data-testid=\"memory-provenance-original\"]')].join(' | ');"
    ))?;
    ensure!(
        shown.starts_with("imported") && shown.contains(&export_id) && shown.contains(&kept) && shown.contains("user-authored"),
        "imported provenance not shown: {shown}"
    );

    // An imported memory is a memory: it is recalled into a real request.
    new_cowork_session(ctx)?;
    attach_folder(ctx, &ctx.project)?;
    send_cowork(ctx, "transfer recall probe")?;
    let system = last_system_prompt(ctx)?;
    ensure!(
        system.contains(&format!("[{new_id}] (user) (source: imported)")) && system.contains("build farm"),
        "the imported memory was not recalled: {system}"
    );

    std::fs::write(
        data_folder()?.join(TRANSFER_EXPECTED),
        serde_json::json!({ "exportId": export_id, "original": kept, "id": new_id }).to_string(),
    )
    .map_err(|e| Failure(format!("could not record the import: {e}")))?;
    Ok(())
}

fn scenario_memory_export_import_restart(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    let raw = std::fs::read_to_string(data_folder()?.join(TRANSFER_EXPECTED)).map_err(|e| {
        Failure(format!(
            "no recorded import ({e}); run memory-export-import first with the same COWORK_SMOKE_KEEP"
        ))
    })?;
    let expected: Value = serde_json::from_str(&raw).map_err(|e| Failure(e.to_string()))?;
    let field = |k: &str| expected[k].as_str().unwrap_or_default().to_string();
    let (export_id, original, id) = (field("exportId"), field("original"), field("id"));
    goto_memory_page(ctx)?;
    let row = format!("[data-testid=\"memory-row\"][data-memory-id={id:?}]");
    ctx.wait_until(
        "the imported memory after a restart",
        &format!("return !!document.querySelector('{row} [data-testid=\"memory-provenance-imported\"]');"),
        Duration::from_secs(30),
    )?;
    let shown = ctx.eval_string(&format!(
        "const q = s => document.querySelector('{row} ' + s)?.textContent || ''; return [q('[data-testid=\"memory-provenance-source\"]'), q('[data-testid=\"memory-provenance-imported\"]'), q('[data-testid=\"memory-provenance-original\"]')].join(' | ');"
    ))?;
    ensure!(
        shown.starts_with("imported") && shown.contains(&export_id) && shown.contains(&original),
        "imported provenance lost across a restart: {shown}"
    );
    let store = user_store_text(ctx)?;
    ensure!(store.contains("imported_from") && store.contains(&export_id), "provenance not persisted");
    ensure!(!store.contains("larkspur") && !store.contains("never signed"), "refused or forgotten text in the store");
    new_cowork_session(ctx)?;
    attach_folder(ctx, &ctx.project)?;
    send_cowork(ctx, "transfer recall after restart")?;
    let system = last_system_prompt(ctx)?;
    ensure!(
        system.contains(&format!("[{id}] (user) (source: imported)")),
        "the imported memory was not recalled, marked imported, after a restart: {system}"
    );
    Ok(())
}
