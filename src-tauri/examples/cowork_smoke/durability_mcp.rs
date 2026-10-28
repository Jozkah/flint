fn data_folder() -> Result<PathBuf, Failure> {
    std::env::var("JAN_DATA_FOLDER")
        .map(PathBuf::from)
        .map_err(|_| Failure("JAN_DATA_FOLDER is not set".into()))
}

/// Type into the chat composer, send, and wait for `expect` on the page.
fn send_and_wait(ctx: &Ctx, text: &str, expect: &str) -> ScenarioResult {
    ctx.type_into("[data-testid=\"chat-input\"]", text)?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval(
        "document.querySelector('[data-test-id=\"send-message-button\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        &format!("{expect:?} on the page"),
        &format!("return (document.body.innerText || '').includes({expect:?});"),
        Duration::from_secs(90),
    )
}

/// The thread open in the chat route, and its directory on disk.
fn open_thread_dir(ctx: &Ctx) -> Result<(String, PathBuf), Failure> {
    ctx.wait_until(
        "a thread route",
        "return location.pathname.startsWith('/threads/') && location.pathname.length > 9;",
        Duration::from_secs(30),
    )?;
    let path = ctx.eval_string("return location.pathname;")?;
    let id = path
        .trim_start_matches("/threads/")
        .trim_end_matches('/')
        .to_string();
    Ok((path, data_folder()?.join("threads").join(id)))
}

/// Every line of a messages file, each of which must be a JSON object.
fn message_lines(dir: &Path) -> Result<Vec<Value>, Failure> {
    let text = std::fs::read_to_string(dir.join("messages.jsonl"))
        .map_err(|e| Failure(format!("messages.jsonl: {e}")))?;
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            serde_json::from_str::<Value>(l)
                .map_err(|e| Failure(format!("an unparseable line survived ({e}): {l:.120}")))
        })
        .collect()
}

/// Staging files still present after any in-flight write has had time to
/// finish. The atomic writer creates `<name>.tmp` and renames it over the
/// target, so one seen for an instant is a write in progress, not a leak; one
/// that is still there seconds later is.
fn staging_files(dir: &Path) -> Vec<String> {
    let list = || -> Vec<String> {
        std::fs::read_dir(dir)
            .map(|rd| {
                rd.flatten()
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| n.ends_with(".tmp"))
                    .collect()
            })
            .unwrap_or_default()
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let found = list();
        if found.is_empty() || Instant::now() >= deadline {
            return found;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// janhq/jan#8019. Thread files are replaced atomically (no staging file left
/// behind, every record parses). Ends by tearing the final line the way a
/// crash mid-append does; `a-torn-thread-tail-heals-after-a-restart` checks
/// that it neither hides the conversation nor swallows the next message.
fn scenario_thread_durability(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    ctx.goto("/")?;
    ctx.wait_until(
        "the chat composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.wait_until(
        "the previous run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.ensure_model_selected()?;
    send_and_wait(ctx, "durable message one", "Hello from the smoke model")?;
    let (route, dir) = open_thread_dir(ctx)?;

    // The reply is persisted when its stream ends, not when it is drawn.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let n = message_lines(&dir).map(|l| l.len()).unwrap_or(0);
        if n >= 2 {
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "the exchange never reached {} ({n} records)",
            dir.display()
        );
        std::thread::sleep(Duration::from_millis(300));
    }
    let meta = std::fs::read_to_string(dir.join("thread.json"))
        .map_err(|e| Failure(format!("thread.json: {e}")))?;
    serde_json::from_str::<Value>(&meta)
        .map_err(|e| Failure(format!("thread.json does not parse: {e}")))?;
    let before = message_lines(&dir)?.len();
    ensure!(
        staging_files(&dir).is_empty(),
        "a staging file was left behind: {:?}",
        staging_files(&dir)
    );

    // What a crash mid-append leaves: an unterminated fragment. It is the last
    // thing this process does, so the restart half finds it exactly as a crash
    // would have left it; reloading the page in place instead left the WebView2
    // page unanswered in this harness.
    {
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(dir.join("messages.jsonl"))
            .map_err(|e| Failure(e.to_string()))?;
        f.write_all(TORN_TAIL.as_bytes())
            .map_err(|e| Failure(e.to_string()))?;
    }
    write_handoff(
        ctx,
        TORN_TAIL_HANDOFF,
        &serde_json::json!({ "route": route, "dir": dir, "before": before }),
    )
}

/// The fragment `thread-files-are-atomic` leaves at the end of a thread file.
const TORN_TAIL: &str = r#"{"id":"smoke-torn-tail","role":"assis"#;
const TORN_TAIL_HANDOFF: &str = "torn-tail";

/// Second process on the profile `thread-files-are-atomic` tore: the
/// conversation opens from disk despite the fragment, and the next message is
/// neither glued onto it nor lost (janhq/jan#8019).
fn scenario_torn_tail_after_restart(ctx: &Ctx) -> ScenarioResult {
    let handoff = read_handoff(ctx, TORN_TAIL_HANDOFF, "thread-files-are-atomic")?;
    let route = handoff["route"].as_str().unwrap_or_default().to_string();
    let dir = PathBuf::from(handoff["dir"].as_str().unwrap_or_default());
    let before = handoff["before"].as_u64().unwrap_or(0) as usize;
    let on_disk = std::fs::read_to_string(dir.join("messages.jsonl"))
        .map_err(|e| Failure(format!("messages.jsonl: {e}")))?;
    ensure!(
        on_disk.ends_with(TORN_TAIL),
        "the torn fragment was gone before the restart, so nothing here reads a torn file"
    );

    ctx.goto(&route)?;
    ctx.wait_until(
        "the conversation to survive the torn tail",
        "const t = document.body.innerText || '';
         return t.includes('durable message one') && t.includes('Hello from the smoke model');",
        Duration::from_secs(45),
    )?;

    ctx.ensure_model_selected()?;
    ctx.script_model("plain", &[])?;
    send_and_wait(ctx, "durable message two", "durable message two")?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match message_lines(&dir) {
            Ok(lines) if lines.len() >= before + 2 => {
                let text = serde_json::to_string(&lines).unwrap_or_default();
                ensure!(
                    !text.contains("smoke-torn-tail"),
                    "the torn fragment was kept as a record"
                );
                ensure!(
                    text.contains("durable message two"),
                    "the message sent after the torn tail was lost"
                );
                break;
            }
            Ok(_) => {}
            Err(Failure(e)) if Instant::now() >= deadline => bail!("{e}"),
            Err(_) => {}
        }
        ensure!(
            Instant::now() < deadline,
            "the second exchange never reached disk"
        );
        std::thread::sleep(Duration::from_millis(300));
    }
    ensure!(
        staging_files(&dir).is_empty(),
        "a staging file was left behind: {:?}",
        staging_files(&dir)
    );
    Ok(())
}

/// janhq/jan#8519 and #8911 through the real app. After startup the user's
/// server is still configured and the hosted Exa entry Jan's own migration
/// once switched on is gone; and a config that stops parsing is copied aside
/// before the defaults are written, instead of being overwritten.
fn scenario_mcp_config_durability(ctx: &Ctx) -> ScenarioResult {
    let data = data_folder()?;
    let path = data.join("mcp_config.json");
    let original =
        std::fs::read_to_string(&path).map_err(|e| Failure(format!("mcp_config.json: {e}")))?;
    let config: Value = serde_json::from_str(&original)
        .map_err(|e| Failure(format!("mcp_config.json does not parse: {e}")))?;
    let servers = config
        .get("mcpServers")
        .and_then(Value::as_object)
        .ok_or_else(|| Failure("no mcpServers".into()))?;
    ensure!(
        servers.contains_key(SMOKE_MCP_USER_SERVER),
        "the user's server was dropped at startup: {:?}",
        servers.keys().collect::<Vec<_>>()
    );
    ensure!(
        !servers.contains_key("exa"),
        "the default hosted Exa entry survived the migration"
    );
    let logs = std::fs::read_dir(data.join("logs"))
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| std::fs::read_to_string(e.path()).ok())
                .collect::<String>()
        })
        .unwrap_or_default();
    ensure!(
        !logs.contains("mcp.exa.ai"),
        "the app log mentions mcp.exa.ai, so something tried to reach it"
    );

    // The settings page lists what the file holds.
    ctx.goto("/settings/mcp-servers")?;
    ctx.wait_until(
        "the user's MCP server in the list",
        // Case-insensitive: the page shows names with CSS `capitalize`, which
        // `innerText` applies.
        &format!(
            "return (document.body.innerText || '').toLowerCase().includes({SMOKE_MCP_USER_SERVER:?});"
        ),
        Duration::from_secs(30),
    )?;

    // An unreadable config: kept aside, never destroyed.
    let corrupt = "{ \"mcpServers\": { \"smoke-user-server\": ";
    std::fs::write(&path, corrupt).map_err(|e| Failure(e.to_string()))?;
    let served = ctx.eval_string(
        "return String(await window.__TAURI_INTERNALS__.invoke('get_mcp_configs'));",
    );
    let kept: Vec<PathBuf> = std::fs::read_dir(&data)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .is_some_and(|n| n.to_string_lossy().starts_with("mcp_config.json.corrupt-"))
                })
                .collect()
        })
        .unwrap_or_default();
    let kept_ok = kept
        .iter()
        .any(|p| std::fs::read_to_string(p).ok().as_deref() == Some(corrupt));
    // Put the real config back before judging, so later scenarios keep their
    // servers whatever happened here.
    std::fs::write(&path, &original).map_err(|e| Failure(e.to_string()))?;
    for p in &kept {
        let _ = std::fs::remove_file(p);
    }
    served?;
    ensure!(
        kept_ok,
        "the unreadable config was not kept aside before defaults were written ({} copies)",
        kept.len()
    );
    let after = ctx.eval_string(
        "return String(await window.__TAURI_INTERNALS__.invoke('get_mcp_configs'));",
    )?;
    ensure!(
        after.contains(SMOKE_MCP_USER_SERVER),
        "the restored config did not load: {after:.200}"
    );
    Ok(())
}

/// A model that sends tool-call arguments that are not JSON must not wedge
/// the run or the thread: the call fails, the run ends, the conversation
/// reloads, and the next turn works (janhq/jan#8519's missing-`arguments`
/// replay was one form of this).
fn scenario_malformed_tool_call(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("tools", &["read:{\"path\":"])?;
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.wait_until(
        "the previous run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.ensure_model_selected()?;
    ctx.eval(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /new session/i.test((x.textContent || '').trim()));
         if (b) b.click();
         return true;",
    )?;
    ctx.settle();

    ctx.type_into("[data-testid=\"chat-input\"]", "read with broken arguments")?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval(
        "document.querySelector('[data-test-id=\"send-message-button\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the run to start",
        "return !document.querySelector('[data-test-id=\"send-message-button\"]')
           || (document.body.innerText || '').includes('read with broken arguments');",
        Duration::from_secs(30),
    )?;
    ctx.wait_until(
        "the run to end instead of hanging",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(120),
    )?;

    // The page reloads cleanly with the conversation intact.
    ctx.goto("/")?;
    ctx.settle();
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the conversation after a reload",
        "return (document.body.innerText || '').includes('read with broken arguments');",
        Duration::from_secs(45),
    )?;

    // And the session still works. The history carries a tool result, so the
    // fixture answers with its summary -- which the first run already put on
    // the page, so only a reply drawn after the follow-up counts.
    ctx.script_model("plain", &[])?;
    let before = model_requests(ctx).map(|r| r.len()).unwrap_or(0);
    let answered = send_and_wait(ctx, "are you still there", "are you still there").and_then(|()| {
        ctx.wait_until(
            "a reply after the follow-up",
            "const t = document.body.innerText || '';
             const i = t.lastIndexOf('are you still there');
             return i >= 0 && t.slice(i).includes('Done. I used the tools you allowed.');",
            Duration::from_secs(90),
        )
    });
    if answered.is_err() {
        // Which half failed: a follow-up that never reached the model, or one
        // the model answered and the page did not show.
        let requests = model_requests(ctx).unwrap_or_default();
        println!(
            "      model requests before/after the follow-up: {before}/{}",
            requests.len()
        );
        if let Some(last) = requests.last() {
            let roles: Vec<String> = last
                .get("messages")
                .and_then(Value::as_array)
                .map(|m| {
                    m.iter()
                        .map(|x| {
                            let role = x.get("role").and_then(Value::as_str).unwrap_or("?");
                            let calls = x
                                .get("tool_calls")
                                .map(|c| c.to_string())
                                .unwrap_or_default();
                            format!("{role}{}", if calls.is_empty() { String::new() } else { format!(" {calls:.160}") })
                        })
                        .collect()
                })
                .unwrap_or_default();
            println!("      last request messages: {roles:?}");
        }
        println!(
            "      page tail: {}",
            ctx.eval_string("const t = document.body.innerText || ''; return t.slice(-600);")
                .unwrap_or_default()
        );
    }
    answered
}

/// Second process on a kept profile: the tool activity the first process
/// recorded is drawn again from the record, and hydrating it writes nothing.
fn scenario_tool_activity_after_restart(ctx: &Ctx) -> ScenarioResult {
    let before = activity_events(ctx);
    ensure!(
        !before.is_empty(),
        "the kept profile holds no tool activity; run tool-activity-timeline with COWORK_SMOKE_KEEP first"
    );
    ensure!(
        before.iter().any(|e| e.contains("\"phase\":\"succeeded\"")),
        "the kept record has no finished call to hydrate"
    );
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the recorded tool call after a restart",
        "return !!document.querySelector('[data-testid=\"tool-activity-item\"]');",
        Duration::from_secs(60),
    )?;
    ctx.settle();
    let after = activity_events(ctx);
    let new: Vec<&String> = after[before.len().min(after.len())..]
        .iter()
        .filter(|e| !e.contains("\"phase\":\"stale\""))
        .collect();
    ensure!(
        new.is_empty(),
        "hydrating the timeline wrote {} new event(s): {:?}",
        new.len(),
        new.iter().take(2).collect::<Vec<_>>()
    );
    Ok(())
}

/// Set the words the model fixture answers with.
fn script_reply(ctx: &Ctx, reply: &str) -> ScenarioResult {
    let port = ctx.mock_port;
    let ok = ctx.eval_bool(&format!(
        r#"const res = await fetch('http://127.0.0.1:{port}/__control', {{
             method: 'POST',
             headers: {{ 'Content-Type': 'application/json' }},
             body: JSON.stringify({{ reply: {reply:?} }}),
           }});
           return res.ok;"#
    ))?;
    ensure!(ok, "could not set the fixture reply");
    Ok(())
}

const DEFAULT_REPLY: &str = "Hello from the smoke model.";

/// The chat bodies the fixture received, oldest first.
fn model_requests(ctx: &Ctx) -> Result<Vec<Value>, Failure> {
    let port = ctx.mock_port;
    let raw = ctx.eval_string(&format!(
        "const r = await fetch('http://127.0.0.1:{port}/__requests');
         return JSON.stringify(await r.json());"
    ))?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| Failure(e.to_string()))?;
    Ok(v.get("requests")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// The system prompt of the most recent chat request.
fn last_system_prompt(ctx: &Ctx) -> Result<String, Failure> {
    let requests = model_requests(ctx)?;
    let last = requests
        .last()
        .ok_or_else(|| Failure("the fixture received no chat request".into()))?;
    Ok(last
        .get("messages")
        .and_then(Value::as_array)
        .map(|m| {
            m.iter()
                .filter(|m| m.get("role").and_then(Value::as_str) == Some("system"))
                .map(|m| m.get("content").map(|c| c.to_string()).unwrap_or_default())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default())
}

/// A fresh chat with the smoke model selected.
fn new_chat(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/")?;
    ctx.wait_until(
        "the chat composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.wait_until(
        "the previous run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.ensure_model_selected()
}

/// janhq/jan#8495. Deleting a reply in the middle of a conversation re-links
/// what hung below it, so the later exchange stays on screen and on disk;
/// `a-deleted-reply-stays-deleted-after-a-restart` checks it after a restart.
fn scenario_delete_keeps_later_replies(ctx: &Ctx) -> ScenarioResult {
    let result = (|| {
        ctx.script_model("plain", &[])?;
        new_chat(ctx)?;
        script_reply(ctx, "Reply alpha from the smoke model.")?;
        send_and_wait(ctx, "message alpha", "Reply alpha from the smoke model.")?;
        let (route, dir) = open_thread_dir(ctx)?;
        ctx.wait_until(
            "the first run to finish",
            "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
            Duration::from_secs(60),
        )?;
        script_reply(ctx, "Reply bravo from the smoke model.")?;
        send_and_wait(ctx, "message bravo", "Reply bravo from the smoke model.")?;
        ctx.wait_until(
            "the second run to finish",
            "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
            Duration::from_secs(60),
        )?;
        std::thread::sleep(Duration::from_secs(1));

        // The first reply's own action row: its last button is the trash.
        let clicked = ctx.eval_string(
            r#"const rows = [...document.querySelectorAll('div.group\\/message')];
               const row = rows.find(r => (r.innerText || '').includes('Reply alpha from the smoke model.')
                                       && !(r.innerText || '').includes('message bravo'));
               if (!row) return 'no row';
               const buttons = [...row.querySelectorAll('button')].filter(b => b.querySelector('svg'));
               const trash = buttons.find(b => b.querySelector('svg.lucide-trash-2, svg.tabler-icon-trash'))
                 || buttons[buttons.length - 1];
               if (!trash) return 'no button';
               trash.click();
               return 'clicked';"#,
        )?;
        if clicked != "clicked" {
            ctx.describe("delete-message")?;
            bail!("could not reach the reply's delete control: {clicked}");
        }
        ctx.wait_until(
            "the delete confirmation",
            "return !!document.querySelector('[role=\"dialog\"] button[aria-label=\"Delete Message\"]');",
            Duration::from_secs(15),
        )?;
        ctx.eval(
            "document.querySelector('[role=\"dialog\"] button[aria-label=\"Delete Message\"]').click();
             return true;",
        )?;
        ctx.wait_until(
            "the reply to go",
            "return !(document.body.innerText || '').includes('Reply alpha from the smoke model.');",
            Duration::from_secs(20),
        )?;
        let visible = |ctx: &Ctx| {
            ctx.eval_bool(
                "const t = document.body.innerText || '';
                 return t.includes('message bravo') && t.includes('Reply bravo from the smoke model.');",
            )
        };
        ensure!(visible(ctx)?, "the later exchange vanished with the deleted reply");

        // On disk: the reply is gone and the later exchange is not.
        let lines = message_lines(&dir)?;
        let text = serde_json::to_string(&lines).unwrap_or_default();
        ensure!(
            !text.contains("Reply alpha from the smoke model."),
            "the deleted reply is still on disk"
        );
        ensure!(
            text.contains("Reply bravo from the smoke model.") && text.contains("message bravo"),
            "the later exchange is not on disk"
        );

        // The restart half rebuilds the tree from the record. Reloading the
        // page in place left the WebView2 page unanswered in this harness.
        write_handoff(ctx, DELETE_HANDOFF, &serde_json::json!({ "route": route }))
    })();
    let _ = script_reply(ctx, DEFAULT_REPLY);
    result
}

const DELETE_HANDOFF: &str = "deleted-reply";

/// Second process on the profile `deleting-a-message-keeps-later-replies`
/// left: the tree rebuilt from the record still shows the later exchange and
/// not the deleted reply.
fn scenario_delete_after_restart(ctx: &Ctx) -> ScenarioResult {
    let handoff = read_handoff(ctx, DELETE_HANDOFF, "deleting-a-message-keeps-later-replies")?;
    ctx.goto(handoff["route"].as_str().unwrap_or_default())?;
    ctx.wait_until(
        "the later exchange after a restart",
        "const t = document.body.innerText || '';
         return t.includes('message bravo') && t.includes('Reply bravo from the smoke model.');",
        Duration::from_secs(45),
    )?;
    ensure!(
        !ctx.eval_bool(
            "return (document.body.innerText || '').includes('Reply alpha from the smoke model.');"
        )?,
        "the deleted reply came back after a restart"
    );
    Ok(())
}

/// Where a scenario whose second half needs a restart leaves what that half
/// needs, inside the kept profile.
fn handoff_path(ctx: &Ctx, name: &str) -> PathBuf {
    ctx.workspace.join(format!("handoff-{name}.json"))
}

fn write_handoff(ctx: &Ctx, name: &str, value: &Value) -> ScenarioResult {
    std::fs::write(handoff_path(ctx, name), value.to_string())
        .map_err(|e| Failure(format!("could not leave the restart handoff: {e}")))
}

fn read_handoff(ctx: &Ctx, name: &str, first: &str) -> Result<Value, Failure> {
    let text = std::fs::read_to_string(handoff_path(ctx, name)).map_err(|_| {
        Failure(format!(
            "the kept profile has no handoff from {first}; run it with COWORK_SMOKE_KEEP first"
        ))
    })?;
    serde_json::from_str(&text).map_err(|e| Failure(format!("unreadable handoff: {e}")))
}

/// Open the edit dialog for the assistant named `name`, set its instructions,
/// save, and return what they were.
fn set_assistant_instructions(ctx: &Ctx, name: &str, instructions: &str) -> Result<String, Failure> {
    ctx.goto("/settings/assistant")?;
    ctx.wait_until(
        "the assistant list",
        "return !!document.querySelector('button[title=\"Edit Assistant\"]');",
        Duration::from_secs(30),
    )?;
    let opened = ctx.eval_bool(&format!(
        r#"const edits = [...document.querySelectorAll('button[title="Edit Assistant"]')];
           let target = null;
           for (const b of edits) {{
             let row = b;
             for (let i = 0; i < 6 && row && !(row.innerText || '').includes({name:?}); i++) row = row.parentElement;
             if (row && (row.innerText || '').includes({name:?})) {{ target = b; break; }}
           }}
           if (!target) target = edits[0];
           target.click();
           return true;"#
    ))?;
    ensure!(opened, "no Edit Assistant control");
    ctx.wait_until(
        "the instructions field",
        "return !!document.querySelector('textarea[placeholder=\"Enter instructions\"]');",
        Duration::from_secs(15),
    )?;
    let previous = ctx.eval_string(
        "return document.querySelector('textarea[placeholder=\"Enter instructions\"]').value;",
    )?;
    ctx.type_into("textarea[placeholder=\"Enter instructions\"]", instructions)?;
    std::thread::sleep(Duration::from_millis(300));
    let saved = ctx.eval_bool(
        "const b = [...document.querySelectorAll('[role=\"dialog\"] button')]
           .find(x => (x.textContent || '').trim() === 'Save');
         if (!b) return false; b.click(); return true;",
    )?;
    ensure!(saved, "no Save button in the assistant dialog");
    ctx.wait_until(
        "the dialog to close",
        "return !document.querySelector('textarea[placeholder=\"Enter instructions\"]');",
        Duration::from_secs(15),
    )?;
    Ok(previous)
}

/// janhq/jan#8524. Editing the assistant an open chat uses changes what the
/// next request in that chat carries -- not only new chats.
fn scenario_instructions_reach_open_chat(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    new_chat(ctx)?;
    send_and_wait(ctx, "instructions check one", "Hello from the smoke model")?;
    let (route, dir) = open_thread_dir(ctx)?;
    ctx.wait_until(
        "the run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(60),
    )?;
    let thread: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("thread.json")).map_err(|e| Failure(e.to_string()))?,
    )
    .map_err(|e| Failure(e.to_string()))?;
    let name = thread
        .pointer("/assistants/0/name")
        .and_then(Value::as_str)
        .unwrap_or("Flint")
        .to_string();

    let nonce = format!("SMOKE-INSTRUCTION-{}", std::process::id());
    ensure!(
        !last_system_prompt(ctx)?.contains(&nonce),
        "the nonce was in the prompt before it was set"
    );
    let previous = set_assistant_instructions(ctx, &name, &format!("Always sign off with {nonce}."))?;
    let result = (|| {
        ctx.goto(&route)?;
        ctx.wait_until(
            "the open chat",
            "return (document.body.innerText || '').includes('instructions check one');",
            Duration::from_secs(30),
        )?;
        ctx.ensure_model_selected()?;
        send_and_wait(ctx, "instructions check two", "instructions check two")?;
        ctx.wait_until(
            "the run to finish",
            "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
            Duration::from_secs(60),
        )?;
        let system = last_system_prompt(ctx)?;
        ensure!(
            system.contains(&nonce),
            "the open chat still sent the old instructions: {system:.300}"
        );
        Ok(())
    })();
    // Leave the assistant as it was for every later scenario.
    let restored = set_assistant_instructions(ctx, &name, &previous);
    result?;
    restored.map(|_| ())
}

/// janhq/jan#8760. A custom endpoint that stops a turn with
/// `finish_reason: "length"` has no known context window, so the reply stays as
/// a stopped turn: no "ran out of context" verdict and no Increase Context Size
/// button that would change nothing on a server Jan does not run.
fn scenario_length_stop_on_custom_endpoint(ctx: &Ctx) -> ScenarioResult {
    let result = (|| {
        ctx.script_model("length", &[])?;
        new_chat(ctx)?;
        script_reply(ctx, "A reply the output cap cut short")?;
        send_and_wait(ctx, "write something long", "A reply the output cap cut short")?;
        ctx.wait_until(
            "the run to finish",
            "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
            Duration::from_secs(60),
        )?;
        std::thread::sleep(Duration::from_secs(2));
        let text = ctx.eval_string("return document.body.innerText || '';")?;
        ensure!(
            !text.contains("Increase Context Size"),
            "a custom endpoint was offered Increase Context Size"
        );
        ensure!(
            !text.contains("Model ran out of context size"),
            "an output-cap stop was reported as a context overflow on an unknown window"
        );
        Ok(())
    })();
    let _ = ctx.script_model("plain", &[]);
    let _ = script_reply(ctx, DEFAULT_REPLY);
    result
}

/// Read or set the built-in web search switch; returns the previous state.
fn set_builtin_web_search(ctx: &Ctx, on: bool) -> Result<bool, Failure> {
    ctx.goto("/settings/web-search")?;
    ctx.wait_until(
        "the web search switch",
        "return !!document.querySelector('button[role=\"switch\"]');",
        Duration::from_secs(30),
    )?;
    let was = ctx.eval_bool(
        "return document.querySelector('button[role=\"switch\"]').getAttribute('aria-checked') === 'true';",
    )?;
    if was != on {
        ctx.eval("document.querySelector('button[role=\"switch\"]').click(); return true;")?;
        ctx.wait_until(
            "the switch to move",
            &format!(
                "return document.querySelector('button[role=\"switch\"]').getAttribute('aria-checked') === '{on}';"
            ),
            Duration::from_secs(10),
        )?;
        ctx.settle();
    }
    Ok(was)
}

/// janhq/jan#8777. With built-in web search off, a `web_search` call comes
/// from the MCP server that offers one: it is held for the user's approval
/// and, once allowed, runs on that server -- not auto-approved and sent to
/// Jan's native adapter because of its name.
fn scenario_mcp_web_search_approval(ctx: &Ctx) -> ScenarioResult {
    let log = data_folder()?.join("mcp-web-search-calls.jsonl");
    let calls = || {
        std::fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count()
    };
    let was_on = set_builtin_web_search(ctx, false)?;
    let result = (|| {
        let before = calls();
        ctx.script_model("tools", &["web_search:{\"query\":\"smoke approval query\"}"])?;
        new_chat(ctx)?;
        ctx.type_into("[data-testid=\"chat-input\"]", "search the web for the smoke query")?;
        ctx.wait_until(
            "the send control to arm",
            "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
             return !!b && b.disabled !== true;",
            Duration::from_secs(60),
        )?;
        ctx.eval(
            "document.querySelector('[data-test-id=\"send-message-button\"]').click();
             return true;",
        )?;
        // The prompt offers one button per scope the backend supports; the
        // allow-once scope is always among them.
        let asked = ctx.wait_until(
            "the approval request",
            "return !!document.querySelector('button[data-scope=\"allow-once\"]');",
            Duration::from_secs(60),
        );
        if asked.is_err() {
            println!(
                "      page: {}",
                ctx.eval_string("return (document.body.innerText || '').slice(-800);")
                    .unwrap_or_default()
            );
        }
        asked?;
        ensure!(
            calls() == before,
            "the MCP server ran web_search before the user approved it"
        );
        let clicked = ctx.eval_bool(
            "const b = document.querySelector('button[data-scope=\"allow-once\"]');
             if (!b) return false; b.click(); return true;",
        )?;
        ensure!(clicked, "no allow-once control on the approval card");
        let deadline = Instant::now() + Duration::from_secs(60);
        while calls() == before {
            ensure!(
                Instant::now() < deadline,
                "the approved web_search never reached the MCP server that offered it"
            );
            std::thread::sleep(Duration::from_millis(300));
        }
        let text = std::fs::read_to_string(&log).unwrap_or_default();
        ensure!(
            text.contains("smoke approval query"),
            "the MCP server was called without the model's arguments: {text:.200}"
        );
        ctx.wait_until(
            "the run to finish",
            "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
            Duration::from_secs(90),
        )?;
        let sent = serde_json::to_string(&model_requests(ctx)?).unwrap_or_default();
        ensure!(
            sent.contains("SMOKE-MCP-WEB-SEARCH-RESULT"),
            "the server's result never went back to the model"
        );
        Ok(())
    })();
    let _ = ctx.script_model("plain", &[]);
    let restored = set_builtin_web_search(ctx, was_on);
    result?;
    restored.map(|_| ())
}


// ---------------------------------------------------------------------------
// Beginner workflows (docs/BEGINNER_WORKFLOWS_HANDOFF.md)
// ---------------------------------------------------------------------------

/// Invoke a Tauri command from the page, exactly as the app's own services do.
fn invoke(ctx: &Ctx, command: &str, args: &Value) -> Result<Value, Failure> {
    let args = serde_json::to_string(args).unwrap_or_else(|_| "{}".into());
    ctx.eval(&format!(
        "return await window.__TAURI_INTERNALS__.invoke({command:?}, {args});"
    ))
}

fn mcp_trust_file() -> Result<Value, Failure> {
    let path = data_folder()?.join("mcp-trust.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into());
    serde_json::from_str(&text).map_err(|e| Failure(format!("mcp-trust.json: {e}")))
}

fn trusted_names(trust: &Value) -> Vec<String> {
    trust
        .get("trusted")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|e| e.get("name").and_then(Value::as_str).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn open_model_picker(ctx: &Ctx) -> ScenarioResult {
    let open_js = "return [...document.querySelectorAll('input')].some(i =>
            /search|find|model/i.test(i.getAttribute('placeholder') || ''));";
    for _ in 0..3 {
        if ctx.eval_bool(open_js)? {
            return Ok(());
        }
        ctx.eval_bool(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /select a model|smoke-model|smoke-alt/i.test(
                 (x.getAttribute('aria-label') || '') + ' ' + (x.textContent || '')));
             if (!b) return false; b.click(); return true;",
        )?;
        if ctx
            .wait_until("the model picker to open", open_js, Duration::from_secs(8))
            .is_ok()
        {
            return Ok(());
        }
    }
    bail!("the model picker never opened")
}

/// Rows in the model picker are buttons that Enter selects, so choosing a
/// model does not require a pointer.
fn scenario_picker_rows_keyboard(ctx: &Ctx) -> ScenarioResult {
    new_chat(ctx)?;
    let pick = |model: &str| -> ScenarioResult {
        open_model_picker(ctx)?;
        let dispatched = ctx.eval_bool(&format!(
            "const row = [...document.querySelectorAll('[role=\"button\"][tabindex=\"0\"]')]
               .find(r => (r.textContent || '').includes({model:?}));
             if (!row) return false;
             row.focus();
             if (document.activeElement !== row) return false;
             row.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Enter', bubbles: true }}));
             return true;"
        ))?;
        ensure!(dispatched, "no focusable, keyboard-selectable row for {model}");
        let selected = ctx.wait_until(
            &format!("{model} to be selected by keyboard"),
            &format!(
                "const open = [...document.querySelectorAll('input')].some(i =>
                   /search|find|model/i.test(i.getAttribute('placeholder') || ''));
                 return !open && [...document.querySelectorAll('button')].some(b =>
                   (b.textContent || '').includes({model:?}));"
            ),
            Duration::from_secs(15),
        );
        if selected.is_err() {
            println!(
                "      picker after Enter: {}",
                ctx.eval_string("const rows = [...document.querySelectorAll('[role=\"button\"][tabindex=\"0\"]')]
                       .filter(r => (r.textContent || '').includes('smoke'))
                       .map(r => (r.textContent || '').trim().slice(0, 40) + ' pressed=' + r.getAttribute('aria-pressed'));
                     const open = [...document.querySelectorAll('input')].some(i =>
                       /search|find|model/i.test(i.getAttribute('placeholder') || ''));
                     const triggers = [...document.querySelectorAll('button')]
                       .map(b => (b.textContent || '').trim()).filter(t => /smoke/i.test(t)).slice(0, 4);
                     return JSON.stringify({ open, rows, triggers, active: (document.activeElement && document.activeElement.textContent || '').slice(0, 40) });")
                .unwrap_or_default()
            );
            // Put the default model back by pointer so later scenarios are not
            // judged against a selection this failure left behind.
            let _ = ctx.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                 return true;");
        }
        selected
    };
    pick("smoke-alt")?;
    pick(SMOKE_MODEL)
}

/// "Always allow" for an MCP server is stored in the backend against the
/// server's fingerprint; revoking it in Settings > Permissions removes it,
/// and the next call asks again without running the tool.
fn scenario_always_allow_then_revoke(ctx: &Ctx) -> ScenarioResult {
    let log = data_folder()?.join("mcp-web-search-calls.jsonl");
    let calls = || {
        std::fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count()
    };
    let send_tool_request = |query: &str| -> ScenarioResult {
        ctx.script_model(
            "tools",
            &[&format!("web_search:{{\"query\":\"{query}\"}}")],
        )?;
        new_chat(ctx)?;
        ctx.type_into("[data-testid=\"chat-input\"]", "search the web for the smoke query")?;
        ctx.wait_until(
            "the send control to arm",
            "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
             return !!b && b.disabled !== true;",
            Duration::from_secs(60),
        )?;
        ctx.eval(
            "document.querySelector('[data-test-id=\"send-message-button\"]').click();
             return true;",
        )?;
        ctx.wait_until(
            "the approval request",
            "return !!document.querySelector('button[data-scope=\"allow-once\"]');",
            Duration::from_secs(60),
        )
    };
    let was_on = set_builtin_web_search(ctx, false)?;
    let result = (|| {
        let before = calls();
        send_tool_request("smoke always query")?;
        ensure!(calls() == before, "the tool ran before the user answered");
        let offered_always = ctx.eval_bool(
            "return !!document.querySelector('button[data-scope=\"allow-always\"]');",
        )?;
        ensure!(offered_always, "an MCP server's tool did not offer 'always allow'");
        ctx.eval(
            "document.querySelector('button[data-scope=\"allow-always\"]').click(); return true;",
        )?;
        let deadline = Instant::now() + Duration::from_secs(60);
        while calls() == before {
            ensure!(Instant::now() < deadline, "the always-allowed call never ran");
            std::thread::sleep(Duration::from_millis(300));
        }
        ctx.wait_until(
            "the run to finish",
            "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
            Duration::from_secs(90),
        )?;
        let trust = mcp_trust_file()?;
        let entry = trust
            .get("trusted")
            .and_then(Value::as_array)
            .and_then(|e| {
                e.iter()
                    .find(|x| x.get("name").and_then(Value::as_str) == Some(SMOKE_MCP_WEB_SEARCH))
            })
            .cloned();
        let fingerprint = entry
            .as_ref()
            .and_then(|e| e.get("fingerprint"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        ensure!(
            fingerprint.starts_with("sha256:"),
            "the backend did not record trust bound to a fingerprint: {trust}"
        );

        ctx.goto("/settings/permissions")?;
        let label = format!("Revoke {SMOKE_MCP_WEB_SEARCH}");
        ctx.wait_until(
            "the server on the Permissions page",
            &format!("return !!document.querySelector('button[aria-label={label:?}]');"),
            Duration::from_secs(30),
        )?;
        ctx.eval(&format!(
            "document.querySelector('button[aria-label={label:?}]').click(); return true;"
        ))?;
        let deadline = Instant::now() + Duration::from_secs(20);
        while trusted_names(&mcp_trust_file()?).contains(&SMOKE_MCP_WEB_SEARCH.to_string()) {
            ensure!(Instant::now() < deadline, "revoking in Settings left the backend trust in place");
            std::thread::sleep(Duration::from_millis(300));
        }

        let before_again = calls();
        send_tool_request("smoke after revoke")?;
        ensure!(
            calls() == before_again,
            "after revoking, the server's tool ran without asking"
        );
        let denied = ctx.eval_bool(
            "const group = document.querySelector('[role=\"group\"][aria-label]');
             const deny = group && [...group.querySelectorAll('button')]
               .find(b => (b.textContent || '').trim() === 'Deny');
             if (!deny) return false; deny.click(); return true;",
        )?;
        ensure!(denied, "the renewed approval request offered no Deny");
        ctx.wait_until(
            "the run to finish",
            "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
            Duration::from_secs(90),
        )?;
        ensure!(calls() == before_again, "a denied call reached the MCP server");
        Ok(())
    })();
    let _ = ctx.script_model("plain", &[]);
    let restored = set_builtin_web_search(ctx, was_on);
    result?;
    restored.map(|_| ())
}

/// Trust belongs to a server's identity, not its name: changing what runs
/// stops the grant from applying, deleting the server revokes it, and a
/// server re-added under the same name inherits nothing.
fn scenario_mcp_trust_identity(ctx: &Ctx) -> ScenarioResult {
    let name = SMOKE_MCP_USER_SERVER;
    let fingerprints = invoke(ctx, "mcp_server_fingerprints", &serde_json::json!({}))?;
    let fingerprint = fingerprints
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    ensure!(
        fingerprint.starts_with("sha256:"),
        "no fingerprint for {name}: {fingerprints}"
    );
    invoke(
        ctx,
        "mcp_trust_server",
        &serde_json::json!({ "serverName": name, "fingerprint": fingerprint }),
    )?;
    ensure!(
        trusted_names(&mcp_trust_file()?).contains(&name.to_string()),
        "trusting {name} was not recorded"
    );

    let original = invoke(ctx, "get_mcp_configs", &serde_json::json!({}))?;
    let original = original.as_str().unwrap_or_default().to_string();
    let mut changed: Value =
        serde_json::from_str(&original).map_err(|e| Failure(format!("mcp config: {e}")))?;
    changed["mcpServers"][name]["args"] = serde_json::json!(["--a-different-program-now"]);
    invoke(
        ctx,
        "save_mcp_configs",
        &serde_json::json!({ "configs": changed.to_string() }),
    )?;

    let report = invoke(ctx, "mcp_trust_report", &serde_json::json!({}))?;
    let current = report
        .get("trusted")
        .and_then(Value::as_array)
        .and_then(|e| e.iter().find(|x| x.get("name").and_then(Value::as_str) == Some(name)))
        .and_then(|e| e.get("currentFingerprint"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    ensure!(
        current.as_deref() != Some(fingerprint.as_str()),
        "changing the server's arguments left its fingerprint unchanged: {report}"
    );
    let ticket = invoke(
        ctx,
        "mcp_allow_once",
        &serde_json::json!({ "serverName": name, "toolName": "anything", "fingerprint": fingerprint }),
    );
    ensure!(
        ticket.is_err(),
        "a one-time approval was issued for a configuration the user never saw"
    );

    // Put the original definition back and trust it, then delete it in the UI.
    invoke(ctx, "save_mcp_configs", &serde_json::json!({ "configs": original }))?;
    let fingerprints = invoke(ctx, "mcp_server_fingerprints", &serde_json::json!({}))?;
    let fingerprint = fingerprints.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
    invoke(
        ctx,
        "mcp_trust_server",
        &serde_json::json!({ "serverName": name, "fingerprint": fingerprint }),
    )?;

    // The settings page keeps its own copy of the configuration, so edits made
    // through the backend above are only visible after a full load.
    ctx.eval_detached("window.location.replace('/settings/mcp-servers')")?;
    std::thread::sleep(Duration::from_secs(2));
    ctx.settle();
    let row = ctx.wait_until(
        "the server row",
        &format!("return !!document.querySelector('[data-testid={:?}]');", format!("mcp-status-{name}")),
        Duration::from_secs(45),
    );
    if row.is_err() {
        ctx.describe("mcp-servers-after-config-edit")?;
        println!(
            "      saved config now: {}",
            invoke(ctx, "get_mcp_configs", &serde_json::json!({}))
                .map(|v| v.to_string())
                .unwrap_or_default()
                .chars()
                .take(600)
                .collect::<String>()
        );
    }
    row?;
    let status = format!("mcp-status-{name}");
    let clicked = ctx.eval_bool(&format!(
        "const buttons = [...document.querySelectorAll('button[title=\"Delete MCP Server\"]')];
         const status = document.querySelector('[data-testid={status:?}]');
         const b = buttons.find(btn => {{
           let el = btn;
           for (let i = 0; i < 12 && el; i++) {{
             el = el.parentElement;
             if (el && status && el.contains(status)
                 && el.querySelectorAll('button[title=\"Delete MCP Server\"]').length === 1) return true;
           }}
           return false;
         }});
         if (!b) return false; b.click(); return true;"
    ))?;
    ensure!(clicked, "no delete control on the {name} row");
    let _ = &status;
    ctx.wait_until(
        "the delete confirmation",
        "const d = document.querySelector('[role=\"dialog\"]');
         return !!d && (d.textContent || '').includes('starts with no approvals');",
        Duration::from_secs(15),
    )?;
    ctx.eval(
        "const d = document.querySelector('[role=\"dialog\"]');
         const b = [...d.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Delete');
         b.click(); return true;",
    )?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while trusted_names(&mcp_trust_file()?).contains(&name.to_string()) {
        ensure!(Instant::now() < deadline, "deleting {name} in Settings left its trust in place");
        std::thread::sleep(Duration::from_millis(300));
    }

    // Re-add the same name with the same definition: nothing is inherited.
    invoke(ctx, "save_mcp_configs", &serde_json::json!({ "configs": original }))?;
    let names = invoke(ctx, "mcp_trusted_servers", &serde_json::json!({}))?;
    ensure!(
        !names.to_string().contains(name),
        "a server re-added under the same name inherited trust: {names}"
    );
    Ok(())
}

/// The home guide card is driven by persisted state, its self-confirmed steps
/// persist, its term hint opens and closes without a pointer-only gesture, and
/// hiding it is remembered.
fn scenario_guide_card(ctx: &Ctx) -> ScenarioResult {
    let state = serde_json::json!({
        "state": {
            "status": "in-progress",
            "intent": "documents",
            "threadCountAtStart": 0,
            "confirmedSteps": [],
            "setupPage": "welcome"
        },
        "version": 0
    });
    invoke(
        ctx,
        "settings_set",
        &serde_json::json!({ "key": "onboarding-guide", "value": state.to_string() }),
    )?;
    ctx.eval_detached("window.location.replace('/')")?;
    std::thread::sleep(Duration::from_secs(2));
    ctx.settle();
    ctx.wait_until(
        "the guide card after a reload",
        "return !!document.querySelector('[data-testid=\"getting-started\"]');",
        Duration::from_secs(60),
    )?;
    let confirmed = ctx.eval_bool(
        "const card = document.querySelector('[data-testid=\"getting-started\"]');
         const b = [...card.querySelectorAll('button')].find(x => (x.textContent || '').includes(\"I've done this\"));
         if (!b) return false; b.click(); return true;",
    )?;
    ensure!(confirmed, "the guide offered no self-confirmation for a user step");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let saved = invoke(ctx, "settings_get", &serde_json::json!({ "key": "onboarding-guide" }))?;
        if saved.to_string().contains("add-material") {
            break;
        }
        ensure!(Instant::now() < deadline, "the confirmed step was not persisted: {saved}");
        std::thread::sleep(Duration::from_millis(300));
    }

    let opened = ctx.eval_bool(
        "const b = [...document.querySelectorAll('button[aria-label]')]
           .find(x => x.getAttribute('aria-label') === 'What does \"Context\" mean?');
         if (!b) return false; b.focus(); b.click(); return true;",
    )?;
    ensure!(opened, "the 'Context' term had no explanation control");
    ctx.wait_until(
        "the definition",
        "return (document.body.innerText || '').includes('The information included in the conversation');",
        Duration::from_secs(10),
    )?;
    ctx.eval(
        "document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         return true;",
    )?;
    ctx.wait_until(
        "the definition to close with Escape",
        "return !(document.body.innerText || '').includes('The information included in the conversation');",
        Duration::from_secs(10),
    )?;

    ctx.eval(
        "const card = document.querySelector('[data-testid=\"getting-started\"]');
         [...card.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Hide guide').click();
         return true;",
    )?;
    ctx.wait_until(
        "the guide to hide",
        "return !document.querySelector('[data-testid=\"getting-started\"]');",
        Duration::from_secs(10),
    )?;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let saved = invoke(ctx, "settings_get", &serde_json::json!({ "key": "onboarding-guide" }))?;
        if saved.to_string().contains("skipped") {
            return Ok(());
        }
        ensure!(Instant::now() < deadline, "hiding the guide was not persisted: {saved}");
        std::thread::sleep(Duration::from_millis(300));
    }
}


/// Create a collection through the sidebar dialog and return its id.
fn create_collection(ctx: &Ctx, name: &str) -> Result<String, Failure> {
    ctx.goto("/")?;
    let opened = ctx.eval_bool(
        "const b = [...document.querySelectorAll('a,button,[role=\"button\"],li,div')]
           .filter(e => e.children.length <= 4 && (e.textContent || '').trim().startsWith('New collection'))
           .pop();
         if (!b) return false; (b.closest('a,button,[role=\"button\"],li') || b).click(); return true;",
    )?;
    ensure!(opened, "no 'New collection' entry in the sidebar");
    ctx.wait_until(
        "the collection dialog",
        "return !!document.querySelector('input[placeholder=\"Enter collection name...\"]');",
        Duration::from_secs(15),
    )?;
    ctx.type_into("input[placeholder=\"Enter collection name...\"]", name)?;
    ctx.eval(
        "const d = document.querySelector('[role=\"dialog\"]');
         [...d.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Create').click();
         return true;",
    )?;
    ctx.wait_until(
        "the collection page",
        "return window.location.pathname.startsWith('/project/');",
        Duration::from_secs(20),
    )?;
    let id = ctx.eval_string("return decodeURIComponent(window.location.pathname.split('/')[2] || '');")?;
    ensure!(!id.is_empty(), "the new collection had no id in its route");
    Ok(id)
}

/// The system prompt of the most recent chat request whose messages include
/// `user_text`. Title and other background requests are skipped.
fn system_prompt_for(ctx: &Ctx, user_text: &str) -> Result<String, Failure> {
    let requests = model_requests(ctx)?;
    let request = requests
        .iter()
        .rev()
        .find(|r| {
            r.get("messages")
                .and_then(Value::as_array)
                .map(|m| {
                    m.iter().any(|m| {
                        let content = match m.get("content") {
                            Some(Value::String(text)) => text.trim().to_string(),
                            Some(other) => other
                                .as_array()
                                .map(|parts| {
                                    parts
                                        .iter()
                                        .filter_map(|p| p.get("text").and_then(Value::as_str))
                                        .collect::<Vec<_>>()
                                        .join("")
                                })
                                .unwrap_or_default()
                                .trim()
                                .to_string(),
                            None => String::new(),
                        };
                        m.get("role").and_then(Value::as_str) == Some("user")
                            && (content == user_text || content.starts_with(user_text))
                    })
                })
                .unwrap_or(false)
        })
        .ok_or_else(|| Failure(format!("no chat request carried {user_text:?}")))?;
    Ok(request
        .get("messages")
        .and_then(Value::as_array)
        .map(|m| {
            m.iter()
                .filter(|m| m.get("role").and_then(Value::as_str) == Some("system"))
                .map(|m| m.get("content").map(|c| c.to_string()).unwrap_or_default())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default())
}

/// Commit a project-scope memory for a collection the way Settings > Memory does.
fn commit_collection_memory(ctx: &Ctx, collection: &str, content: &str) -> ScenarioResult {
    let data = data_folder()?.to_string_lossy().to_string();
    let location = serde_json::json!({ "dataFolder": data, "janProjectId": collection });
    let proposal = invoke(
        ctx,
        "plugin:agent-tools|memory_record_propose",
        &serde_json::json!({ "location": location, "scope": "project", "content": content }),
    )?;
    let hash = proposal
        .get("contentHash")
        .and_then(Value::as_str)
        .ok_or_else(|| Failure(format!("proposal had no contentHash: {proposal}")))?
        .to_string();
    invoke(
        ctx,
        "plugin:agent-tools|memory_record_commit",
        &serde_json::json!({
            "location": location, "scope": "project", "content": content, "expectedHash": hash
        }),
    )?;
    Ok(())
}

fn send_in_current_page(ctx: &Ctx, text: &str) -> ScenarioResult {
    ctx.wait_until(
        "the composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.ensure_model_selected()?;
    ctx.type_into("[data-testid=\"chat-input\"]", text)?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval(
        "document.querySelector('[data-test-id=\"send-message-button\"]').click(); return true;",
    )?;
    ctx.wait_until(
        "the reply",
        &format!("return (document.body.innerText || '').includes({DEFAULT_REPLY:?});"),
        Duration::from_secs(90),
    )
}

/// A memory saved for one collection is sent with that collection's chats,
/// never with another collection's or with an ordinary chat, and the context
/// panel verifies it against the recorded request.
fn scenario_collection_memory(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    script_reply(ctx, DEFAULT_REPLY)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let alpha = create_collection(ctx, &format!("Smoke Alpha {stamp}"))?;
    let marker = "SMOKE-ALPHA-DEPLOYS-WITH-MAKE-SHIP";
    commit_collection_memory(ctx, &alpha, &format!("The team deploys with {marker}."))?;

    // A chat in Alpha carries the memory.
    ctx.goto(&format!("/project/{alpha}"))?;
    let question_alpha = format!("how do we deploy? alpha {stamp}");
    send_in_current_page(ctx, &question_alpha)?;
    let prompt = system_prompt_for(ctx, &question_alpha)?;
    if !prompt.contains(marker) {
        // Separate "the backend has nothing for this collection" from "the
        // chat did not ask for it", and show what the request looked like.
        let data = data_folder()?.to_string_lossy().to_string();
        let direct = invoke(
            ctx,
            "plugin:agent-tools|memory_retrieve",
            &serde_json::json!({ "location": { "dataFolder": data, "janProjectId": alpha } }),
        );
        println!("      direct retrieval for the collection: {direct:?}");
        let thread = ctx.eval_string("return window.location.pathname;").unwrap_or_default();
        println!("      chat route: {thread}");
        let requests = model_requests(ctx)?;
        for r in requests.iter().rev().take(3) {
            let roles: Vec<String> = r
                .get("messages")
                .and_then(Value::as_array)
                .map(|m| {
                    m.iter()
                        .map(|m| {
                            let role = m.get("role").and_then(Value::as_str).unwrap_or("?");
                            let text = m.get("content").map(|c| c.to_string()).unwrap_or_default();
                            format!("{role}: {}", text.chars().take(160).collect::<String>())
                        })
                        .collect()
                })
                .unwrap_or_default();
            println!("      request: {roles:?}");
        }
    }
    ensure!(
        prompt.contains(marker),
        "the collection's memory was not sent with its chat. system prompt: {prompt}"
    );

    // The panel verifies it from the sanitized request, not from intent.
    ctx.wait_until(
        "the chat route",
        "return window.location.pathname.startsWith('/threads/');",
        Duration::from_secs(30),
    )?;
    ctx.eval("document.querySelector('[data-testid=\"what-jan-is-using\"]').click(); return true;")?;
    ctx.wait_until(
        "the memory section",
        "return !!document.querySelector('[data-testid=\"context-section-memory\"]');",
        Duration::from_secs(20),
    )?;
    ctx.wait_until(
        "the memory to be verified in the request",
        &format!(
            "const s = document.querySelector('[data-testid=\"context-section-memory\"]');
             const t = (s && s.innerText) || '';
             return t.includes({marker:?}) && t.includes('Verified in the last request');"
        ),
        Duration::from_secs(30),
    )?;
    ctx.eval(
        "document.activeElement && document.activeElement.dispatchEvent(
           new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         return true;",
    )?;

    // Another collection's chat, and an ordinary chat, do not.
    let beta = create_collection(ctx, &format!("Smoke Beta {stamp}"))?;
    ctx.goto(&format!("/project/{beta}"))?;
    let question_beta = format!("how do we deploy? beta {stamp}");
    send_in_current_page(ctx, &question_beta)?;
    let prompt = system_prompt_for(ctx, &question_beta)?;
    ensure!(
        !prompt.contains(marker),
        "another collection's memory leaked into this chat: {prompt:.600}"
    );
    new_chat(ctx)?;
    let question_plain = format!("how do we deploy? plain {stamp}");
    send_in_current_page(ctx, &question_plain)?;
    let prompt = system_prompt_for(ctx, &question_plain)?;
    ensure!(
        !prompt.contains(marker),
        "a collection memory leaked into an ordinary chat: {prompt:.600}"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Real-provider lane
// ---------------------------------------------------------------------------
