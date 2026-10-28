/// A custom provider pointing at the real server, with the ephemeral key and
/// one placeholder model: discovery has to find the real one.
fn seed_lane_settings(data_folder: &Path, base_url: &str, key: &str) -> Result<(), String> {
    std::fs::create_dir_all(data_folder).map_err(|e| e.to_string())?;
    let placeholder = serde_json::json!({
        "id": "lane-placeholder", "model": "lane-placeholder", "name": "lane-placeholder",
        "capabilities": ["completion"], "version": "1.0"
    });
    let providers = serde_json::json!({
        "version": 18,
        "state": {
            "providers": [{
                "active": true,
                "persist": true,
                "provider": LANE_PROVIDER,
                "base_url": base_url,
                "api_key": key,
                "settings": [],
                "models": [placeholder]
            }],
            "selectedProvider": LANE_PROVIDER,
            "selectedModel": placeholder,
            "deletedModels": []
        }
    });
    let settings = serde_json::json!({
        "model-provider": providers.to_string(),
        "jan-model-prompt-dismissed": "true",
        "productAnalytic": "false",
        "productAnalyticPrompt": "false",
    });
    std::fs::write(
        data_folder.join("settings.json"),
        serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn lane_model() -> String {
    LANE.get().map(|(_, m)| m.clone()).unwrap_or_default()
}

/// Pick `model` in the composer's model picker.
fn select_model(ctx: &Ctx, model: &str) -> ScenarioResult {
    let already = ctx.eval_bool(&format!(
        "return [...document.querySelectorAll('button')].some(b =>
           (b.textContent || '').trim() === {model:?} || (b.textContent || '').includes({model:?}));"
    ))?;
    if already {
        return Ok(());
    }
    ctx.eval(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /select a model|lane-placeholder/i.test((x.getAttribute('aria-label') || '')
             + ' ' + (x.textContent || '')));
         if (b) b.click();
         return true;",
    )?;
    ctx.wait_until(
        "the model picker",
        "return [...document.querySelectorAll('input')].some(i =>
            /search|find|model/i.test(i.getAttribute('placeholder') || ''));",
        Duration::from_secs(20),
    )?;
    ctx.type_into(
        "input[placeholder*='model' i], input[placeholder*='search' i]",
        model,
    )?;
    // A model discovered moments ago reaches the picker's list asynchronously;
    // wait for the option itself rather than a fixed pause (the first lane run
    // searched 800 ms after discovery and found "No models found").
    let find = format!(
        "const el = [...document.querySelectorAll('[role=\"option\"],button,li,div')]
           .filter(e => e.children.length <= 2 && (e.textContent || '').trim() === {model:?})
           .pop();
         return !!el;"
    );
    let _ = ctx.wait_until("the model in the picker", &find, Duration::from_secs(20));
    let picked = ctx.eval_bool(&format!(
        "const el = [...document.querySelectorAll('[role=\"option\"],button,li,div')]
           .filter(e => e.children.length <= 2 && (e.textContent || '').trim() === {model:?})
           .pop();
         if (!el) return false;
         (el.closest('[role=\"option\"],button,li') || el).click();
         return true;"
    ))?;
    if !picked {
        ctx.describe("lane-model-picker")?;
        bail!("the picker never offered {model}");
    }
    std::thread::sleep(Duration::from_millis(900));
    Ok(())
}

fn lane_provider_page(ctx: &Ctx) -> ScenarioResult {
    ctx.goto(&format!("/settings/providers/{LANE_PROVIDER}"))?;
    ctx.wait_until(
        "the provider page",
        "return !!document.querySelector('button[title=\"Refresh\"]');",
        Duration::from_secs(30),
    )
}

/// Discovery through the app: the provider page's Refresh asks the server's
/// `/v1/models`, and the real model appears beside the seeded placeholder.
fn lane_discovers_models(ctx: &Ctx) -> ScenarioResult {
    let model = lane_model();
    lane_provider_page(ctx)?;
    ensure!(
        !ctx.eval_bool(&format!("return !!document.querySelector('h1[title={model:?}]');"))?,
        "{model} was listed before discovery"
    );
    ctx.eval("document.querySelector('button[title=\"Refresh\"]').click(); return true;")?;
    let found = ctx.wait_until(
        "the discovered model",
        &format!("return !!document.querySelector('h1[title={model:?}]');"),
        Duration::from_secs(60),
    );
    if found.is_err() {
        println!(
            "      page: {}",
            ctx.eval_string("return (document.body.innerText || '').slice(0, 900);")
                .unwrap_or_default()
        );
    }
    found
}

/// A private or tailnet endpoint is listed under Local in the settings
/// sidebar once the resolver has classified it.
fn lane_grouped_local(ctx: &Ctx) -> ScenarioResult {
    lane_provider_page(ctx)?;
    ctx.wait_until(
        "the endpoint under the Local heading",
        &format!(
            r#"const spans = [...document.querySelectorAll('span')];
               const local = spans.find(s => (s.textContent || '').trim() === 'Local');
               const remote = spans.find(s => (s.textContent || '').trim() === 'Remote');
               const item = [...document.querySelectorAll('a,button,div,span')]
                 .filter(e => e.children.length === 0 && (e.textContent || '').trim().toLowerCase() === {LANE_PROVIDER:?})
                 .shift();
               if (!local || !item) return false;
               const after = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
               if (!after(local, item)) return false;
               // Under Local means not also past the Remote heading that
               // follows it.
               if (remote && after(local, remote) && after(remote, item)) return false;
               return true;"#
        ),
        Duration::from_secs(45),
    )
}

/// The model streams a reply the prompt did not contain, and the reply shows
/// its token speed.
fn lane_streams_a_reply(ctx: &Ctx) -> ScenarioResult {
    let model = lane_model();
    new_chat_lane(ctx, &model)?;
    let a: u32 = 100 + rand::random::<u32>() % 800;
    let b: u32 = 100 + rand::random::<u32>() % 800;
    let expect = format!("LANE-{}", a + b);
    ctx.type_into(
        "[data-testid=\"chat-input\"]",
        &format!("Compute {a}+{b}. Reply with only LANE- followed by the sum, for example LANE-7, and nothing else."),
    )?;
    send_armed(ctx)?;
    ctx.wait_until(
        "the streamed answer",
        &format!("return (document.body.innerText || '').includes({expect:?});"),
        Duration::from_secs(240),
    )?;
    ctx.wait_until(
        "the run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(240),
    )?;
    ctx.wait_until(
        "the token speed",
        "return /\\d+ tokens\\/sec/.test(document.body.innerText || '');",
        Duration::from_secs(20),
    )?;
    let speed = ctx.eval_string(
        "const m = (document.body.innerText || '').match(/\\d+ tokens\\/sec[^\\n]*/); return m ? m[0] : '';",
    )?;
    println!("      reply {expect} at {speed}");
    Ok(())
}

fn new_chat_lane(ctx: &Ctx, model: &str) -> ScenarioResult {
    ctx.goto("/")?;
    ctx.wait_until(
        "the chat composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    select_model(ctx, model)
}

fn send_armed(ctx: &Ctx) -> ScenarioResult {
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
    Ok(())
}

/// The last prompt snapshot written for `thread`, as text.
fn last_snapshot_for(thread: &str) -> Result<String, Failure> {
    let text = std::fs::read_to_string(data_folder()?.join("audit/prompts.jsonl"))
        .map_err(|e| Failure(format!("audit/prompts.jsonl: {e}")))?;
    Ok(text
        .lines()
        .rev()
        .find(|l| l.contains(thread))
        .unwrap_or_default()
        .to_string())
}

/// A remembered fact is injected into the request the model receives, and
/// the model answers from it.
fn lane_memory_reaches_the_model(ctx: &Ctx) -> ScenarioResult {
    let model = lane_model();
    new_chat_lane(ctx, &model)?;
    ctx.type_into("[data-testid=\"chat-input\"]", "Reply with only the word READY.")?;
    send_armed(ctx)?;
    ctx.wait_until(
        "the first reply",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]')
           && (document.body.innerText || '').includes('READY');",
        Duration::from_secs(240),
    )?;
    let (route, _) = open_thread_dir(ctx)?;
    let thread = route.trim_start_matches("/threads/").trim_end_matches('/').to_string();

    let pass = format!("amber-{}", rand::random::<u32>() % 90000 + 10000);
    let proposed = ctx.eval_string(&format!(
        r#"const c = await window.__TAURI_INTERNALS__.invoke('get_app_configurations');
           const out = await window.__TAURI_INTERNALS__.invoke(
             'plugin:agent-tools|memory_record_propose_inferred',
             {{ location: {{ dataFolder: c.data_folder, sessionId: {thread:?} }},
                scope: 'chat',
                content: 'The lane passphrase is {pass}.',
                sourceSessionId: {thread:?},
                sourceMessageId: 'lane-1' }});
           return JSON.stringify(out);"#
    ))?;
    println!("      memory proposal: {proposed:.160}");
    ctx.goto("/")?;
    ctx.goto(&route)?;
    let card = ctx.wait_until(
        "the memory proposal",
        "return !!document.querySelector('[data-testid=\"memory-proposal-approve\"]');",
        Duration::from_secs(30),
    );
    if card.is_ok() {
        ctx.eval(
            "document.querySelector('[data-testid=\"memory-proposal-approve\"]').click(); return true;",
        )?;
        std::thread::sleep(Duration::from_secs(2));
    }

    ctx.type_into(
        "[data-testid=\"chat-input\"]",
        "What is the lane passphrase? Reply with only the passphrase.",
    )?;
    send_armed(ctx)?;
    ctx.wait_until(
        "the answer",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]')
           && (document.body.innerText || '').split('What is the lane passphrase').length > 1;",
        Duration::from_secs(240),
    )?;
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut snapshot = String::new();
    while Instant::now() < deadline {
        snapshot = last_snapshot_for(&thread)?;
        if snapshot.contains("What is the lane passphrase") {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    ensure!(
        snapshot.contains("Remembered") && snapshot.contains(&pass),
        "the request the model received did not carry the memory (card shown: {}): {:.300}",
        card.is_ok(),
        snapshot
    );
    ctx.wait_until(
        "the model to answer from memory",
        &format!("return (document.body.innerText || '').includes({pass:?});"),
        Duration::from_secs(60),
    )
}

/// Turn tool calling on for the lane model through its edit dialog.
fn enable_tools(ctx: &Ctx, model: &str) -> ScenarioResult {
    lane_provider_page(ctx)?;
    let opened = ctx.eval_bool(&format!(
        r#"const h = document.querySelector('h1[title={model:?}]');
           if (!h) return false;
           let row = h;
           for (let i = 0; i < 8 && row; i++) {{
             const pencil = row.querySelector('svg.lucide-pencil, svg.tabler-icon-pencil');
             if (pencil) {{ (pencil.closest('.cursor-pointer') || pencil).click(); return true; }}
             row = row.parentElement;
           }}
           return false;"#
    ))?;
    ensure!(opened, "no edit control for {model}");
    ctx.wait_until(
        "the tools switch",
        "return !!document.querySelector('#tools-capability');",
        Duration::from_secs(15),
    )?;
    let on = ctx.eval_bool(
        "return document.querySelector('#tools-capability').getAttribute('aria-checked') === 'true';",
    )?;
    if !on {
        ctx.eval("document.querySelector('#tools-capability').click(); return true;")?;
        std::thread::sleep(Duration::from_millis(300));
        let saved = ctx.eval_bool(
            "const b = [...document.querySelectorAll('[role=\"dialog\"] button')]
               .find(x => /^save/i.test((x.textContent || '').trim()));
             if (!b || b.disabled) return false; b.click(); return true;",
        )?;
        ensure!(saved, "no enabled Save in the model dialog");
    }
    std::thread::sleep(Duration::from_secs(1));
    let _ = ctx.eval(
        "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;",
    );
    Ok(())
}

const BRANCHCRAFT_HANDOFF: &str = "branchcraft-desktop";

/// The BranchCraft repository the real-AI exercise builds (COWORK_SMOKE_BRANCHCRAFT).
fn branchcraft_folder() -> Result<PathBuf, Failure> {
    let raw = std::env::var("COWORK_SMOKE_BRANCHCRAFT")
        .map_err(|_| Failure("COWORK_SMOKE_BRANCHCRAFT is not set".into()))?;
    let path = PathBuf::from(raw);
    ensure!(path.join(".git").exists(), "{} is not the BranchCraft repository", path.display());
    Ok(path)
}

/// Wait until the session in view has no running turn, answering nothing on
/// the model's behalf. Returns how long it took.
fn wait_turn_done(ctx: &Ctx, what: &str, limit: Duration) -> Result<Duration, Failure> {
    let started = Instant::now();
    loop {
        let running = ctx
            .eval_bool("return document.querySelectorAll('[data-testid^=\"cowork-session-running-\"]').length > 0;")
            .unwrap_or(true);
        let idle = ctx
            .eval_bool("return !!document.querySelector('[data-test-id=\"send-message-button\"]');")
            .unwrap_or(false);
        if !running && idle {
            return Ok(started.elapsed());
        }
        ensure!(started.elapsed() < limit, "{what} did not finish within {limit:?}: {}", run_state_page(ctx));
        std::thread::sleep(Duration::from_millis(1000));
    }
}

fn event_kinds(events: &[Value]) -> std::collections::BTreeMap<String, usize> {
    let mut kinds = std::collections::BTreeMap::new();
    for e in events {
        *kinds.entry(e["kind"].as_str().unwrap_or("").to_string()).or_insert(0) += 1;
    }
    kinds
}

/// BranchCraft, desktop half one (real 8555 model): steer an active turn,
/// read it back through Timeline, context diff and the prompt snapshot, replay
/// the run from its record, undo and redo the model's change, then leave
/// background work running as this process -- the app -- ends.
fn scenario_branchcraft_desktop(ctx: &Ctx) -> ScenarioResult {
    let folder = branchcraft_folder()?;
    let model = lane_model();
    ensure!(!model.is_empty(), "no real-provider lane is configured");
    println!("      model {model}, folder {}", folder.display());
    // The model comes from the server's own list, discovered through the
    // provider page as a user would, not typed in.
    lane_provider_page(ctx)?;
    if !ctx.eval_bool(&format!("return !!document.querySelector('h1[title={model:?}]');"))? {
        ctx.eval("document.querySelector('button[title=\"Refresh\"]').click(); return true;")?;
        ctx.wait_until(
            "the server's models to be discovered",
            &format!("return !!document.querySelector('h1[title={model:?}]');"),
            Duration::from_secs(90),
        )?;
    }
    enable_tools(ctx, &model)?;
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.eval(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /new session/i.test((x.textContent || '').trim()));
         if (b) b.click();
         return true;",
    )?;
    ctx.settle();
    select_model(ctx, &model)?;
    attach_folder(ctx, &folder)?;
    choose_mode(ctx, "Autonomous")?;
    let session = current_cowork_session(ctx)?;
    println!("      session {session}");

    // 1. A real turn, steered while it runs.
    ctx.type_into(
        "[data-testid=\"chat-input\"]",
        "The attached folder is the BranchCraft project. Read branchcraft/cli.py from it with the read tool. Then, in your own workspace (not the attached folder), write notes/cli-review.md with exactly three concrete suggestions for improving that CLI, each one line. Then run `echo branchcraft-review-done` with bash and finish with one short sentence.",
    )?;
    send_armed(ctx)?;
    ctx.wait_until(
        "the turn to be running",
        "return document.querySelectorAll('[data-testid^=\"cowork-session-running-\"]').length > 0;",
        Duration::from_secs(60),
    )?;
    // Steer once the first tool call is under way, so it lands at a boundary
    // inside this turn rather than before it starts.
    ctx.wait_until(
        "the first tool call of the turn",
        "return !!document.querySelector('[data-testid=\"tool-activity-item\"]');",
        Duration::from_secs(300),
    )?;
    type_and_enter(ctx, "Steering: make it four suggestions, and the fourth must be about the --help text.")?;
    let took = wait_turn_done(ctx, "the steered turn", Duration::from_secs(900))?;
    println!("      steered turn finished in {took:?}");
    let events = session_events(ctx, &session)?;
    println!("      event kinds: {:?}", event_kinds(&events));
    // The desktop runner records steering as a lifecycle of the run it entered.
    let steering = events
        .iter()
        .find(|e| e["kind"] == "lifecycle.succeeded" && e["payload"]["lifecycle"] == "steering")
        .cloned()
        .ok_or_else(|| Failure(format!("the steering was not recorded on the run: {:?}", event_kinds(&events))))?;
    let steered_run = steering["run"].as_str().unwrap_or_default().to_string();
    println!("      steering recorded on run {steered_run} at seq {}", steering["seq"]);
    ensure!(
        events.iter().filter(|e| e["run"] == steered_run.as_str() && e["kind"] == "tool.requested").count() >= 2,
        "the steering did not land inside a run that went on working"
    );
    let review = find_file(Path::new(&std::env::var("JAN_DATA_FOLDER").unwrap_or_default()), "cli-review.md")
        .ok_or_else(|| Failure("the model did not write notes/cli-review.md in its workspace".into()))?;
    let text = std::fs::read_to_string(&review).unwrap_or_default();
    println!("      cli-review.md ({} lines): {:?}", text.lines().count(), text.chars().take(300).collect::<String>());
    ensure!(text.to_lowercase().contains("help"), "the steered suggestion about --help is not in the file");
    ensure!(
        !folder.join("notes").join("cli-review.md").exists(),
        "the attached folder was written although it is read-only on this platform"
    );

    // 2. The prompt the model was sent after the steering carries it.
    let (ok, snaps) = ipc(ctx, "agent_prompt_snapshots", &serde_json::json!({ "session": session }).to_string())?;
    ensure!(ok, "agent_prompt_snapshots failed: {snaps}");
    let snaps = snaps.as_array().cloned().unwrap_or_default();
    println!("      prompt snapshots: {}", snaps.len());
    ensure!(snaps.len() >= 2, "fewer than two requests were recorded for the turn");
    ensure!(
        snaps.iter().any(|s| s.to_string().contains("the fourth must be about the --help text")),
        "no recorded request carried the steering message"
    );
    let hashes: Vec<String> = snaps.iter().filter_map(|s| s["hash"].as_str().map(str::to_string)).collect();
    println!("      snapshot hashes: {hashes:?}");

    // 3. Timeline: the turn in log order, with the steering on it.
    show_timeline(ctx)?;
    ctx.wait_until(
        "the turn's rows on the timeline",
        "return document.querySelectorAll('[data-testid=\"timeline-row\"]').length > 3;",
        Duration::from_secs(30),
    )?;
    let rows = timeline_rows(ctx)?;
    println!("      timeline rows: {}", rows.len());
    let seqs: Vec<u64> = rows.iter().filter_map(|r| r.split('|').next()?.parse().ok()).collect();
    ensure!(seqs.windows(2).all(|w| w[0] < w[1]), "the timeline is not in log order: {seqs:?}");
    let has = |cat: &str| rows.iter().any(|r| r.split('|').nth(2).is_some_and(|c| c.split(' ').any(|x| x == cat)));
    ensure!(has("tools") && has("run") && has("messages"), "the timeline lacks tools/run/messages rows: {rows:?}");
    ensure!(has("steering"), "the steering is not on the timeline: {rows:?}");

    // 4. Context diff between the last two requests.
    let (previous, reasons, _previews, left) = compare_last_snapshot(ctx)?;
    println!("      context diff against {previous}: entered {reasons:?}, left {left}");
    ensure!(!previous.is_empty() && !reasons.is_empty(), "the context diff names nothing");

    // 5. Replay the run from its record: nothing is sent, the record is read back.
    let run = events
        .iter()
        .find(|e| e["kind"] == "message.completed" && e["payload"]["phase"] == "dispatched")
        .and_then(|e| e["run"].as_str())
        .map(str::to_string)
        .ok_or_else(|| Failure("no dispatched run in the session record".into()))?;
    let (ok, plan) = ipc(ctx, "agent_replay_plan", &serde_json::json!({ "session": session, "run": run }).to_string())?;
    ensure!(ok, "agent_replay_plan failed: {plan}");
    let steps = plan["steps"].as_array().map(|a| a.len()).unwrap_or(0);
    println!("      replay plan: {steps} step(s), tools {}", plan["toolCalls"]);
    ensure!(steps > 0, "the replay plan has no steps: {plan}");
    let (ok, recorded) = ipc(ctx, "agent_replay_recorded", &serde_json::json!({ "session": session, "run": run }).to_string())?;
    ensure!(ok, "agent_replay_recorded failed: {recorded}");
    let recorded = recorded.as_array().cloned().unwrap_or_default();
    ensure!(!recorded.is_empty() && recorded.iter().all(|e| e["run"] == run.as_str()), "the replayed record is empty or mixed");
    println!("      replayed {} recorded events of {run}", recorded.len());

    // 6. Undo, then redo, the model's change.
    open_turn_undo(ctx)?;
    ctx.eval(
        "document.querySelector('[data-testid=\"turn-undo-row\"][data-state=\"applied\"] [data-testid=\"turn-undo-button\"]').click(); return true;",
    )?;
    ctx.wait_until(
        "the undo",
        "return !!document.querySelector('[data-testid=\"turn-undo-row\"][data-state=\"undone\"]');",
        Duration::from_secs(60),
    )?;
    ensure!(!review.exists(), "undo left the model's file in place");
    ctx.eval(
        "const row = document.querySelector('[data-testid=\"turn-undo-row\"][data-state=\"undone\"]');
         const b = (row && row.querySelector('[data-testid=\"turn-redo\"]')) || document.querySelector('[data-testid=\"turn-redo\"]');
         if (b) b.click(); return !!b;",
    )?;
    ctx.wait_until(
        "the redo",
        "return !!document.querySelector('[data-testid=\"turn-undo-row\"][data-state=\"applied\"]');",
        Duration::from_secs(60),
    )?;
    ensure!(std::fs::read_to_string(&review).unwrap_or_default() == text, "redo did not restore the model's file exactly");
    println!("      undo removed the file, redo restored it byte for byte");

    // 7. Background work that is still running when the app goes away.
    ctx.type_into(
        "[data-testid=\"chat-input\"]",
        "Use the bash tool with background set to true to run exactly this command, then report the job id it returns and stop: powershell -NoProfile -Command Start-Sleep -Seconds 300",
    )?;
    send_armed(ctx)?;
    let _ = wait_turn_done(ctx, "the background-job turn", Duration::from_secs(600))?;
    let (ok, jobs) = ipc(ctx, "agent_background_jobs", &serde_json::json!({ "session": session }).to_string())?;
    ensure!(ok, "agent_background_jobs failed: {jobs}");
    let jobs = jobs.as_array().cloned().unwrap_or_default();
    println!("      background jobs before closing: {}", serde_json::to_string(&jobs).unwrap_or_default());
    let running = jobs
        .iter()
        .find(|j| j["state"] == "running")
        .ok_or_else(|| Failure(format!("the model left no running background job: {jobs:?}")))?;
    write_handoff(
        ctx,
        BRANCHCRAFT_HANDOFF,
        &serde_json::json!({
            "session": session,
            "job": running["id"],
            "review": review.to_string_lossy(),
            "reviewText": text,
            "rows": rows.len(),
            "run": run,
        }),
    )
}

/// BranchCraft, desktop half two: a new app process on the same profile. The
/// session, its Timeline, the redone change and the background job the earlier
/// process left are all accounted for.
fn scenario_branchcraft_desktop_restart(ctx: &Ctx) -> ScenarioResult {
    let handoff = read_handoff(ctx, BRANCHCRAFT_HANDOFF, "branchcraft-desktop")?;
    let session = handoff["session"].as_str().unwrap_or_default().to_string();
    let job = handoff["job"].as_str().unwrap_or_default().to_string();
    open_cowork_session(ctx, &session)?;
    println!("      reopened session {session}");

    let (ok, jobs) = ipc(ctx, "agent_background_jobs", &serde_json::json!({ "session": session }).to_string())?;
    ensure!(ok, "agent_background_jobs failed after the restart: {jobs}");
    let jobs = jobs.as_array().cloned().unwrap_or_default();
    println!("      background jobs after restart: {}", serde_json::to_string(&jobs).unwrap_or_default());
    let record = jobs
        .iter()
        .find(|j| j["id"] == job.as_str())
        .ok_or_else(|| Failure(format!("the job {job} the earlier process started was not kept: {jobs:?}")))?;
    let state = record["state"].as_str().unwrap_or_default();
    ensure!(state != "completed", "an ending nobody saw was reported as completion: {record}");
    if state == "running" {
        ensure!(
            record["identity"]["pid"].as_u64().unwrap_or(0) > 0 && record["identity"]["created"].as_u64().unwrap_or(0) > 0,
            "a job reads as running with nothing to identify it by: {record}"
        );
        println!("      the job outlived the app and was re-identified by pid and creation time");
    }

    let review = PathBuf::from(handoff["review"].as_str().unwrap_or_default());
    ensure!(
        std::fs::read_to_string(&review).unwrap_or_default() == handoff["reviewText"].as_str().unwrap_or_default(),
        "the redone change did not survive the restart"
    );

    show_timeline(ctx)?;
    ctx.wait_until(
        "the earlier rows on the timeline",
        "return document.querySelectorAll('[data-testid=\"timeline-row\"]').length > 3;",
        Duration::from_secs(30),
    )?;
    let rows = timeline_rows(ctx)?;
    let before = handoff["rows"].as_u64().unwrap_or(0) as usize;
    println!("      timeline rows after restart: {} (before closing: {before})", rows.len());
    ensure!(rows.len() >= before, "the timeline lost rows across the restart");

    let (previous, reasons, _, _) = compare_last_snapshot(ctx)?;
    ensure!(!previous.is_empty() && !reasons.is_empty(), "the context diff did not come back after the restart");
    Ok(())
}

/// One real model -> tool -> model loop in Cowork, with the provider's usage
/// recorded against the dispatch and the context window reported.
fn lane_cowork_tool_loop(ctx: &Ctx) -> ScenarioResult {
    let model = lane_model();
    enable_tools(ctx, &model)?;
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.eval(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /new session/i.test((x.textContent || '').trim()));
         if (b) b.click();
         return true;",
    )?;
    ctx.settle();
    select_model(ctx, &model)?;
    let before = activity_events(ctx).len();
    ctx.type_into(
        "[data-testid=\"chat-input\"]",
        "Call the ls tool exactly once to list the workspace root. After it returns, reply with the single word FINISHED.",
    )?;
    send_armed(ctx)?;
    ctx.wait_until(
        "the tool call to finish",
        "return !!document.querySelector('[data-testid=\"tool-activity-item\"][data-tool-state=\"output-available\"]');",
        Duration::from_secs(300),
    )?;
    ctx.wait_until(
        "the model's answer after the tool",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]')
           && /FINISHED/.test(document.body.innerText || '');",
        Duration::from_secs(300),
    )?;
    let fresh: Vec<String> = activity_events(ctx).into_iter().skip(before).collect();
    ensure!(
        fresh.iter().any(|e| e.contains("\"tool\":\"ls\"") && e.contains("\"phase\":\"succeeded\"")),
        "no succeeded ls call was recorded: {:?}",
        fresh.iter().take(3).collect::<Vec<_>>()
    );
    let usage = std::fs::read_to_string(data_folder()?.join("audit/payload-usage.jsonl"))
        .unwrap_or_default();
    ensure!(
        usage
            .lines()
            .any(|l| l.contains(&format!("\"model\":\"{model}\"")) && l.contains("\"source\":\"provider\"")),
        "the provider's usage for {model} was not recorded"
    );
    // The breakdown lives in the session details dialog, mounted only while
    // it is open.
    ctx.eval(
        "const t = document.querySelector('[data-testid=\"session-details-trigger\"]');
         if (t) t.click();
         return true;",
    )?;
    ctx.wait_until(
        "the session details",
        "return !!document.querySelector('[data-testid=\"session-details-body\"]');",
        Duration::from_secs(15),
    )?;
    let window = ctx.eval_string(
        r#"const d = document.querySelector('details[aria-label="What the model received"]');
           if (!d) return 'no breakdown';
           d.open = true;
           // The innermost element whose text starts with the label is the
           // label itself; its row is the first ancestor carrying more text.
           const label = [...d.querySelectorAll('*')]
             .filter(e => (e.textContent || '').trim().startsWith('Context window')).pop();
           if (!label) return 'no context row';
           let row = label;
           while (row.parentElement && row.parentElement !== d
                  && (row.textContent || '').trim() === 'Context window') row = row.parentElement;
           return row.textContent.replace(/\s+/g, ' ').trim().slice(0, 160);"#,
    )?;
    println!("      context window: {window}");
    let _ = ctx.eval(
        "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;",
    );
    ensure!(
        window.starts_with("Context window"),
        "the run did not report its context window: {window}"
    );
    Ok(())
}

/// Where the key is, and whom the app talked to.
fn lane_contained(ctx: &Ctx) -> ScenarioResult {
    let key = LANE_KEY.get().cloned().unwrap_or_default();
    ensure!(key.len() == 64, "the lane key was not made");
    // Never in this process's arguments or environment.
    ensure!(
        !std::env::args().any(|a| a.contains(&key)),
        "the key is in the process arguments"
    );
    ensure!(
        !std::env::vars().any(|(_, v)| v.contains(&key)),
        "the key is in the process environment"
    );

    // Every file of the run's profile, data folder and WebView profile both.
    let root = ctx.workspace.clone();
    let mut hits: Vec<String> = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(bytes) = std::fs::read(&p) {
                if bytes.windows(key.len()).any(|w| w == key.as_bytes()) {
                    hits.push(
                        p.strip_prefix(&root)
                            .unwrap_or(&p)
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
            }
        }
    }
    println!("      key found in: {hits:?}");
    let allowed = |rel: &str| {
        rel == "data/settings.json" || (rel.starts_with("webview/") && rel.contains("Local Storage"))
    };
    let stray: Vec<&String> = hits.iter().filter(|h| !allowed(h)).collect();
    ensure!(
        stray.is_empty(),
        "the key is stored outside credential handling: {stray:?}"
    );

    // Every connection the app opened, from its own log, plus what the
    // transport resolved and what the page fetched.
    let base = LANE.get().map(|(b, _)| b.clone()).unwrap_or_default();
    let lane_host = base
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .split('/')
        .next()
        .unwrap_or_default()
        .to_string();
    let logs = std::fs::read_dir(data_folder()?.join("logs"))
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| std::fs::read_to_string(e.path()).ok())
                .collect::<String>()
        })
        .unwrap_or_default();
    let mut peers: Vec<String> = logs
        .lines()
        .filter_map(|l| l.split("starting new connection: ").nth(1))
        .map(|u| {
            u.trim()
                .trim_start_matches("http://")
                .trim_start_matches("https://")
                .trim_end_matches('/')
                .to_string()
        })
        .collect();
    peers.sort();
    peers.dedup();
    let resolved: Vec<String> = LOOKED_UP.lock().map(|v| v.clone()).unwrap_or_default();
    let page = ctx.eval_string(
        "return JSON.stringify([...new Set(performance.getEntriesByType('resource').map(e => e.name))]);",
    )?;
    println!("      connections: {peers:?}; resolved: {:?}", {
        let mut r = resolved.clone();
        r.sort();
        r.dedup();
        r
    });
    let local = |p: &str| {
        p.starts_with("127.0.0.1") || p.starts_with("localhost") || p.starts_with("[::1]")
    };
    let foreign: Vec<&String> = peers
        .iter()
        .filter(|p| **p != lane_host && !local(p))
        .collect();
    ensure!(foreign.is_empty(), "the app connected elsewhere: {foreign:?}");
    ensure!(
        !peers.iter().any(|p| p.ends_with(":8080")) && !resolved.iter().any(|p| p.ends_with(":8080")),
        "something reached port 8080"
    );
    let page_urls: Vec<String> = serde_json::from_str(&page).unwrap_or_default();
    let page_foreign: Vec<&String> = page_urls
        .iter()
        .filter(|u| {
            !(u.starts_with("tauri://")
                || u.starts_with("asset://")
                || u.starts_with("ipc://")
                || u.starts_with("data:")
                || u.starts_with("blob:")
                || u.contains("://localhost")
                || u.contains("://tauri.localhost")
                || u.contains("://asset.localhost")
                || u.contains("://ipc.localhost"))
        })
        .collect();
    ensure!(
        page_foreign.is_empty(),
        "the page fetched from elsewhere: {page_foreign:?}"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Rooms lane (`COWORK_SMOKE_ROOMS=1` with `COWORK_SMOKE_REAL_BASE_URL`)
// ---------------------------------------------------------------------------
//
// Multi-model discussion rooms against the real server, through the real app:
// the Rust rooms persistence, the provider store, ModelFactory and streamText.
// Setup goes through `window.__janRoomsE2E`, which exists only in a frontend
// built with `VITE_JAN_E2E_HOOKS=1`. Verdicts are read from the room files on
// disk. Requests are strictly sequential and small.

const ROOMS_LANE_SCENARIOS: &[Scenario] = &[
    Scenario { name: "rooms-discovery", run: rooms_discovery },
    Scenario { name: "rooms-capability-probe", run: rooms_capability_probe },
    Scenario { name: "rooms-single-room-all-models", run: rooms_single_room },
    Scenario { name: "rooms-round-robin-all-models", run: rooms_round_robin },
    Scenario { name: "rooms-addressing-user-selected", run: rooms_addressing },
    Scenario { name: "rooms-streaming", run: rooms_streaming },
    Scenario { name: "rooms-cancellation", run: rooms_cancellation },
    Scenario { name: "rooms-permission-isolation", run: rooms_permission_isolation },
    Scenario { name: "rooms-error-handling", run: rooms_error_handling },
    Scenario { name: "rooms-moderator-vote-synthesis", run: rooms_moderator },
    Scenario { name: "rooms-limits", run: rooms_limits },
];

/// Appended to the rooms lane when the profile is kept: leaves a room running.
const ROOMS_KEEP_SCENARIOS: &[Scenario] = &[Scenario {
    name: "rooms-leave-running-for-restart",
    run: rooms_leave_running,
}];

/// The second process on a kept rooms profile.
const ROOMS_RESTART_SCENARIOS: &[Scenario] = &[Scenario {
    name: "rooms-paused-after-restart",
    run: rooms_after_restart,
}];

const ROOMS_RESTART_HANDOFF: &str = "rooms-running";
const ROOMS_NAMES: [&str; 8] = ["Alder", "Birch", "Cedar", "Dahlia", "Elm", "Fern", "Gorse", "Hazel"];
const ROOMS_ROLES: [&str; 8] = [
    "pragmatic engineer",
    "cautious skeptic",
    "user advocate",
    "cost analyst",
    "security reviewer",
    "historian",
    "optimist",
    "maintainer",
];

static ROOMS_IDS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
static ROOMS_COMPATIBLE: std::sync::Mutex<Option<Vec<String>>> = std::sync::Mutex::new(None);
