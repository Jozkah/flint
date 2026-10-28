/// Where the app's window is and what state it is in, for a page that has
/// stopped answering: a window that is minimised, hidden or off every screen
/// is throttled by WebView2 whatever the flags say.
///
/// Deliberately no picture. An earlier version captured the whole desktop,
/// which recorded everything else the person had open.
fn window_state(window: &tauri::WebviewWindow) -> String {
    format!(
        "visible={:?} minimized={:?} focused={:?} position={:?} size={:?} monitor={:?}",
        window.is_visible().ok(),
        window.is_minimized().ok(),
        window.is_focused().ok(),
        window.outer_position().ok().map(|p| (p.x, p.y)),
        window.outer_size().ok().map(|s| (s.width, s.height)),
        window.current_monitor().ok().flatten().map(|m| m.name().cloned()),
    )
}

/// Every process this app started that is still running, with its command
/// line: what a stalled app is waiting on, when it waits on a child.
///
/// Asked from outside the app's own event loop (a separate PowerShell), so it
/// answers even while the main thread is blocked.
fn app_children() -> String {
    let me = std::process::id();
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
        ])
        .output();
    let Ok(out) = out else {
        return "(could not list processes)".into();
    };
    let all: Vec<Value> = match serde_json::from_slice(&out.stdout) {
        Ok(Value::Array(a)) => a,
        _ => return "(unreadable process list)".into(),
    };
    let mut ours = vec![u64::from(me)];
    let mut found = Vec::new();
    let mut webviews: Vec<u64> = Vec::new();
    let mut changed = true;
    while changed {
        changed = false;
        for p in &all {
            let (Some(pid), Some(parent)) = (p["ProcessId"].as_u64(), p["ParentProcessId"].as_u64()) else {
                continue;
            };
            if ours.contains(&parent) && !ours.contains(&pid) {
                ours.push(pid);
                let name = p["Name"].as_str().unwrap_or("?");
                // WebView2 is always there and always many; the interesting
                // children are everything else.
                if name.eq_ignore_ascii_case("msedgewebview2.exe") {
                    webviews.push(pid);
                } else {
                    let cmd: String = p["CommandLine"].as_str().unwrap_or("").chars().take(200).collect();
                    found.push(format!("{pid} {name}: {cmd}"));
                }
                changed = true;
            }
        }
    }
    // Whether the page is busy or waiting: CPU each WebView2 process used over
    // two seconds. A renderer running script at 100% of a core and one parked
    // on a wait look the same from the page, and not from here.
    let busy = if webviews.is_empty() {
        String::new()
    } else {
        let ids = webviews.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
        let script = format!(
            "$ids=@({ids}); $a=@{{}}; foreach($i in $ids){{ $p=Get-Process -Id $i -ErrorAction SilentlyContinue; if($p){{$a[$i]=$p.CPU}} }}; \
             Start-Sleep -Seconds 2; \
             foreach($i in $ids){{ $p=Get-Process -Id $i -ErrorAction SilentlyContinue; if($p -and $a.ContainsKey($i)){{ '{{0}}:{{1:N2}}s' -f $i, ($p.CPU - $a[$i]) }} }}"
        );
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().collect::<Vec<_>>().join(" "))
            .unwrap_or_default()
    };
    let busy = format!("; WebView2 CPU over 2s: {}", if busy.is_empty() { "(none)" } else { &busy });
    if found.is_empty() {
        format!("(none but WebView2){busy}")
    } else {
        format!("{}{busy}", found.join(" | "))
    }
}

/// What a run that will not finish is waiting on: an approval nobody can see,
/// a button that is not there, or the conversation's own last words.
fn run_state(ctx: &Ctx) -> String {
    format!("{}; app children: {}", run_state_page(ctx), app_children())
}

fn run_state_page(ctx: &Ctx) -> String {
    ctx.eval_string(
        r#"const t = document.body.innerText || '';
           const allow = [...document.querySelectorAll('button')]
             .filter(x => /^allow once$/i.test((x.textContent || '').trim())).length;
           const input = document.querySelector('[data-testid="chat-input"]');
           let pane = input;
           for (let i = 0; pane && i < 12; i++) pane = pane.parentElement;
           const tail = ((pane && pane.innerText) || t).slice(-900);
           return JSON.stringify({
             visibility: document.visibilityState,
             focused: document.hasFocus(),
             approvalAsked: t.includes('needs your approval') || !!document.querySelector('[data-testid="inline-approval-card"]'),
             allowOnceButtons: allow,
             stopShown: !!document.querySelector('[data-test-id="stop-button"], [aria-label*="Stop" i]'),
             composer: !!input,
             testIds: [...document.querySelectorAll('[data-test-id]')].map(e => e.getAttribute('data-test-id')).slice(0, 40),
             footerButtons: input
               ? [...(input.closest('form') || input.parentElement.parentElement.parentElement).querySelectorAll('button')]
                   .map(b => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 30)).slice(0, 25)
               : [],
             tail,
           });"#,
    )
    .unwrap_or_else(|e| format!("(state unavailable: {})", e.0))
}

/// Every toast on screen, joined, for asserting what a handler reported.
fn toasts(ctx: &Ctx) -> String {
    ctx.eval_string(
        "return [...document.querySelectorAll('[data-sonner-toast]')]
           .map(t => t.textContent).join(' | ');",
    )
    .unwrap_or_default()
}

/// A session exports to one file and comes back as a new session. AH-203.
///
/// Proves, in the real WebView with the real dialogs scripted: a run with a
/// tool call and a credential typed into the prompt exports through the
/// session menu; the file is versioned, carries the turns, and holds neither
/// the credential nor the provider key nor the attached folder; importing it
/// creates a session showing the conversation; importing it again is refused;
/// a file with a schema version this build does not know is refused by name.
fn scenario_session_export_import(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let secret = "abcdefghijklmnopqrstuvwxyz0123456789";
    ctx.script_model("tools", &["ls:{\"path\":\".\"}"])?;
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
    ctx.type_into(
        "[data-testid=\"chat-input\"]",
        &format!("list the folder, and use Authorization: Bearer {secret}"),
    )?;
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
        "the tool call in the transcript",
        "return !!document.querySelector('[data-testid=\"tool-activity-item\"]');",
        Duration::from_secs(90),
    )?;
    ctx.wait_until(
        "the run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.settle();

    // Export through the current session's own menu. The scripted picker has
    // to name a file that exists, so the target is created empty first.
    let dir = std::env::temp_dir().join(format!("jan-smoke-export-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| fail(e.to_string()))?;
    let target = dir.join("exported.jan-session.json");
    std::fs::write(&target, "").map_err(|e| fail(e.to_string()))?;
    ctx.script_dialog(Some(&target));
    let opened = ctx.eval_bool(
        r#"const row = document.querySelector('[data-sidebar="menu-button"][data-active="true"]')
             ?.closest('li');
           const more = row && row.querySelector('[data-sidebar="menu-action"]');
           if (!more) return false;
           more.dispatchEvent(new PointerEvent('pointerdown',
             { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
           return true;"#,
    );
    let exported = opened.and_then(|ok| {
        ensure!(ok, "the current session's menu is not on the page");
        ctx.wait_until(
            "the export item",
            "return !!document.querySelector('[data-testid=\"export-session\"]');",
            Duration::from_secs(10),
        )?;
        ctx.eval("document.querySelector('[data-testid=\"export-session\"]').click(); return true;")?;
        let mut body = String::new();
        for _ in 0..40 {
            body = std::fs::read_to_string(&target).unwrap_or_default();
            if body.contains("jan.cowork-session") {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        Ok(body)
    });
    ctx.clear_dialog_script();
    let body = exported?;
    ensure!(
        body.contains("\"schemaVersion\": 1"),
        "the export was not written or is not versioned; toasts: {}",
        toasts(ctx)
    );
    ensure!(body.contains("list the folder"), "the export does not carry the turns");
    ensure!(!body.contains(secret), "the export holds the credential typed into the prompt");
    ensure!(!body.contains("smoke-not-a-real-key"), "the export holds the provider key");
    let folder = ctx.project.to_string_lossy().replace('\\', "\\\\");
    ensure!(!body.contains(&folder), "the export holds the attached folder's path");

    // Import it: a new session showing the conversation.
    let import = |ctx: &Ctx, file: &Path| -> ScenarioResult {
        ctx.script_dialog(Some(file));
        let clicked = ctx.eval_bool(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /import session/i.test((x.textContent || '').trim()));
             if (!b) return false; b.click(); return true;",
        );
        std::thread::sleep(Duration::from_millis(1500));
        ctx.clear_dialog_script();
        ensure!(clicked?, "the Import session action is not on the page");
        Ok(())
    };
    import(ctx, &target)?;
    ctx.wait_until(
        "the import to be reported",
        "return [...document.querySelectorAll('[data-sonner-toast]')]
           .some(t => /Session imported/.test(t.textContent || ''));",
        Duration::from_secs(20),
    )?;
    ctx.wait_until(
        "the imported conversation to show",
        "return (document.body.innerText || '').includes('list the folder');",
        Duration::from_secs(20),
    )?;

    // Again: refused, not duplicated.
    import(ctx, &target)?;
    ctx.wait_until(
        "a second import to be refused",
        "return [...document.querySelectorAll('[data-sonner-toast]')]
           .some(t => /already imported/.test(t.textContent || ''));",
        Duration::from_secs(20),
    )?;

    // A schema version this build does not know: refused by name.
    let future = dir.join("future.jan-session.json");
    let newer = body.replacen("\"schemaVersion\": 1", "\"schemaVersion\": 9", 1);
    std::fs::write(&future, newer).map_err(|e| fail(e.to_string()))?;
    import(ctx, &future)?;
    ctx.wait_until(
        "an unknown schema version to be refused",
        "return [...document.querySelectorAll('[data-sonner-toast]')]
           .some(t => /schema version 9/.test(t.textContent || ''));",
        Duration::from_secs(20),
    )?;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

/// Hand a session to another computer, and continue it there. AH-210.
///
/// In the real WebView: a run in a session with the fixture attached is
/// handed off through the session menu; the file names the folder by name,
/// branch and commit and carries no path from this machine; importing it says
/// plainly what could not be restored, checks the folder once it is attached,
/// and names a model this machine does not have.
fn scenario_session_handoff(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let readme = ctx.project.join("README.md").to_string_lossy().to_string();
    ctx.script_model(
        "tools",
        &[&format!("read:{}", serde_json::json!({ "path": readme }))],
    )?;
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
    attach_project(ctx)?;
    ctx.ensure_model_selected()?;
    ctx.type_into("[data-testid=\"chat-input\"]", "read the readme for the handoff")?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval("document.querySelector('[data-test-id=\"send-message-button\"]').click(); return true;")?;
    ctx.wait_until(
        "the tool call in the transcript",
        "return !!document.querySelector('[data-testid=\"tool-activity-item\"]');",
        Duration::from_secs(90),
    )?;
    ctx.wait_until(
        "the run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.settle();

    let dir = std::env::temp_dir().join(format!("jan-smoke-handoff-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| fail(e.to_string()))?;
    let target = dir.join("handoff.jan-session.json");
    std::fs::write(&target, "").map_err(|e| fail(e.to_string()))?;
    ctx.script_dialog(Some(&target));
    let saved = ctx
        .eval_bool(
            r#"const row = document.querySelector('[data-sidebar="menu-button"][data-active="true"]')
                 ?.closest('li');
               const more = row && row.querySelector('[data-sidebar="menu-action"]');
               if (!more) return false;
               more.dispatchEvent(new PointerEvent('pointerdown',
                 { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
               return true;"#,
        )
        .and_then(|ok| {
            ensure!(ok, "the current session's menu is not on the page");
            ctx.wait_until(
                "the handoff item",
                "return !!document.querySelector('[data-testid=\"handoff-session\"]');",
                Duration::from_secs(10),
            )?;
            ctx.eval("document.querySelector('[data-testid=\"handoff-session\"]').click(); return true;")?;
            let mut body = String::new();
            for _ in 0..40 {
                body = std::fs::read_to_string(&target).unwrap_or_default();
                if body.contains("\"handoff\"") {
                    break;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            Ok(body)
        });
    ctx.clear_dialog_script();
    let body = saved?;
    ensure!(
        body.contains("\"handoff\""),
        "the handoff was not written; toasts: {}",
        toasts(ctx)
    );
    ensure!(
        body.contains("read the readme for the handoff"),
        "the handoff does not carry the conversation"
    );
    // No path from this machine: the fixture, its workspace, either separator.
    let workspace = ctx.workspace.to_string_lossy().to_string();
    for spelled in [
        workspace.replace('\\', "\\\\"),
        workspace.replace('\\', "/"),
    ] {
        ensure!(
            !body.to_lowercase().contains(&spelled.to_lowercase()),
            "the handoff holds a path from this machine: {spelled}"
        );
    }
    ensure!(
        body.contains("<folder>"),
        "the folder's path was not replaced by what it means"
    );
    ensure!(!body.contains("smoke-not-a-real-key"), "the handoff holds the provider key");
    let parsed: Value = serde_json::from_str(&body).map_err(|e| fail(e.to_string()))?;
    let identity = &parsed["handoff"]["folder"];
    ensure!(
        identity["name"] == "cowork-smoke-fixture",
        "the folder is not named: {identity}"
    );
    ensure!(
        identity["head"].as_str().is_some_and(|h| h.len() == 40),
        "the folder's commit is not recorded: {identity}"
    );
    ensure!(
        parsed["handoff"]["model"]["provider"] == SMOKE_PROVIDER,
        "the model is not named: {}",
        parsed["handoff"]["model"]
    );

    // Import it: what could not be restored is said plainly.
    let import = |ctx: &Ctx, file: &Path| -> ScenarioResult {
        ctx.script_dialog(Some(file));
        let clicked = ctx.eval_bool(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /import session/i.test((x.textContent || '').trim()));
             if (!b) return false; b.click(); return true;",
        );
        std::thread::sleep(Duration::from_millis(1500));
        ctx.clear_dialog_script();
        ensure!(clicked?, "the Import session action is not on the page");
        Ok(())
    };
    import(ctx, &target)?;
    ctx.wait_until(
        "the notice of what to restore",
        "const n = document.querySelector('[data-testid=\"handoff-item-folder\"]');
         return !!n && n.textContent.includes('cowork-smoke-fixture');",
        Duration::from_secs(20),
    )?;
    ensure!(
        !ctx.eval_bool("return !!document.querySelector('[data-testid=\"handoff-item-model\"]');")?,
        "the session's model was reported missing, though this machine has it"
    );

    // Attach the folder: it is checked against the one the session was on.
    attach_project(ctx)?;
    ctx.wait_until(
        "the attached folder to be checked",
        "const c = document.querySelector('[data-testid=\"handoff-folder-check\"]');
         return !!c && c.textContent.includes('matches');",
        Duration::from_secs(20),
    )?;

    // A model this machine does not have is named, not silently swapped.
    let other = dir.join("other-model.jan-session.json");
    let mut changed = parsed.clone();
    changed["exportId"] = Value::from("handoff-other-model");
    changed["handoff"]["model"]["id"] = Value::from("not-a-model");
    std::fs::write(&other, serde_json::to_vec_pretty(&changed).unwrap())
        .map_err(|e| fail(e.to_string()))?;
    import(ctx, &other)?;
    ctx.wait_until(
        "the missing model to be named",
        "const n = document.querySelector('[data-testid=\"handoff-item-model\"]');
         return !!n && n.textContent.includes('not-a-model');",
        Duration::from_secs(20),
    )?;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

const HANDOFF_MARKER: &str = "handoff-phase-1.txt";
const HANDOFF_EXPORT_ID: &str = "handoff-persist-check";

/// Phase one: import a handoff whose folder and model this machine does not
/// have, see the notice, and exit once the session is on disk.
fn scenario_handoff_persist_first(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let file = ctx.workspace.join("persist.jan-session.json");
    let bundle = serde_json::json!({
        "format": "jan.cowork-session",
        "schemaVersion": 1,
        "exportId": HANDOFF_EXPORT_ID,
        "exportedAt": "2026-09-10T00:00:00Z",
        "session": { "id": "remote-1", "title": "Handed over", "turns": [], "updated": 1 },
        "toolActivity": [],
        "fileActivity": [],
        "changeSummary": [],
        "handoff": {
            "folder": { "name": "far-away-repo", "branch": "main", "head": "0123456789abcdef0123456789abcdef01234567" },
            "model": { "provider": "provider-not-here", "id": "model-x" }
        }
    });
    std::fs::write(&file, serde_json::to_vec_pretty(&bundle).unwrap()).map_err(|e| fail(e.to_string()))?;
    ctx.goto("/cowork")?;
    ctx.script_dialog(Some(&file));
    let clicked = ctx.eval_bool(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /import session/i.test((x.textContent || '').trim()));
         if (!b) return false; b.click(); return true;",
    );
    std::thread::sleep(Duration::from_millis(1500));
    ctx.clear_dialog_script();
    ensure!(clicked?, "the Import session action is not on the page");
    ctx.wait_until(
        "the notice naming the provider",
        "const n = document.querySelector('[data-testid=\"handoff-item-provider\"]');
         return !!n && n.textContent.includes('provider-not-here');",
        Duration::from_secs(20),
    )?;
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let settings = Path::new(&data).join("settings.json");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let raw = std::fs::read_to_string(&settings).unwrap_or_default();
        if raw.contains(HANDOFF_EXPORT_ID) && raw.contains("far-away-repo") {
            break;
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "the imported session never reached settings.json"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    std::fs::write(ctx.workspace.join(HANDOFF_MARKER), "imported").map_err(|e| fail(e.to_string()))
}

/// Phase two, a new process: the notice is still there, and dismissing it
/// is remembered.
fn scenario_handoff_persist_second(ctx: &Ctx) -> ScenarioResult {
    ensure!(
        ctx.workspace.join(HANDOFF_MARKER).exists(),
        "phase one did not run against this workspace"
    );
    ctx.goto("/cowork")?;
    // The imported session, by its title in the sidebar.
    ctx.wait_until(
        "the imported session in the sidebar",
        "const b = [...document.querySelectorAll('[data-sidebar=\"menu-button\"]')]
           .find(x => (x.textContent || '').includes('Handed over'));
         if (b) b.click();
         return !!b;",
        Duration::from_secs(20),
    )?;
    ctx.wait_until(
        "the notice to come back after the restart",
        "const f = document.querySelector('[data-testid=\"handoff-item-folder\"]');
         const p = document.querySelector('[data-testid=\"handoff-item-provider\"]');
         return !!f && f.textContent.includes('far-away-repo') && !!p;",
        Duration::from_secs(20),
    )?;
    ctx.eval("document.querySelector('[data-testid=\"handoff-dismiss\"]').click(); return true;")?;
    ctx.wait_until(
        "the notice to be dismissed",
        "return !document.querySelector('[data-testid=\"handoff-notice\"]');",
        Duration::from_secs(10),
    )?;
    Ok(())
}

/// Titling a conversation is a hidden utility agent. AH-208.
///
/// After a real round trip on the chat route, the automatic title call runs
/// through `runUtilityAgent`, and this proves it is accountable without being
/// a leak: a `title` record lands in `audit/utility-agents.jsonl` for this
/// conversation, it says no tools were offered, and it holds neither the
/// user's message, nor the model's reply, nor the provider key.
fn scenario_utility_agent_title(ctx: &Ctx) -> ScenarioResult {
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let log = Path::new(&data).join("audit").join("utility-agents.jsonl");
    let before = std::fs::read_to_string(&log).unwrap_or_default().lines().count();

    scenario_model_round_trip(ctx)?;

    let mut fresh: Vec<String> = Vec::new();
    for _ in 0..60 {
        fresh = std::fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .skip(before)
            .map(str::to_string)
            .collect();
        if fresh.iter().any(|l| l.contains("\"kind\":\"title\"")) {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let title = fresh
        .iter()
        .find(|l| l.contains("\"kind\":\"title\""))
        .ok_or_else(|| Failure("the automatic title call was never recorded".into()))?;
    ensure!(
        title.contains("\"outcome\":\"succeeded\""),
        "the title call did not succeed: {title}"
    );
    ensure!(
        title.contains("\"toolsOffered\":false"),
        "the title call is not recorded as tool-free: {title}"
    );
    let all = fresh.join("\n");
    for leaked in ["hello smoke", "Hello from the smoke model", "smoke-not-a-real-key"] {
        ensure!(!all.contains(leaked), "the utility-agent record holds {leaked:?}");
    }
    Ok(())
}

/// A message reaches the model and its reply comes back.
///
/// Everything downstream of a run -- the activity timeline, tool rows,
/// cancellation -- depends on this working, so it is asserted on its own.
/// A configured app, left open for manual or scripted exploration.
///
/// Scripts the model fixture to plain replies, opens a chat with the smoke
/// model selected, and then holds for `COWORK_SMOKE_HOLD_SECS` (default 0) so
/// a person, or a browser automation tool attached through
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` with
/// `COWORK_SMOKE_THROTTLE=1`, can walk the redesigned surfaces against real
/// app state and the local model fixture. Asserts only that the app reached a
/// usable chat.
fn scenario_atelier_explore(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    ctx.goto("/")?;
    ctx.wait_until(
        "the chat composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.ensure_model_selected()?;
    println!(
        "      model fixture on http://127.0.0.1:{}/v1; app ready for exploration",
        ctx.mock_port
    );
    ctx.hold_for_capture("atelier exploration");
    Ok(())
}

fn scenario_model_round_trip(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    ctx.goto("/")?;
    ctx.wait_until(
        "the chat composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;

    // Pick the model through the picker rather than relying on the seeded
    // selection: the persisted store normalises what it is given, and a chat
    // with no model selected silently does nothing when you press send.
    let already = ctx.eval_bool(&format!(
        "return [...document.querySelectorAll('button')].some(b =>
           (b.textContent || '').includes({SMOKE_MODEL:?}));"
    ))?;
    if !already {
        ctx.eval(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /select a model/i.test((x.getAttribute('aria-label') || '')
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
            "smoke",
        )?;
        std::thread::sleep(Duration::from_millis(800));
        let picked = ctx.eval_bool(&format!(
            "const el = [...document.querySelectorAll('[role=\"option\"],button,li,div')]
               .filter(e => e.children.length <= 2
                 && (e.textContent || '').trim().includes({SMOKE_MODEL:?}))
               .pop();
             if (!el) return false;
             (el.closest('[role=\"option\"],button,li') || el).click();
             return true;"
        ))?;
        if !picked {
            ctx.describe("model-picker-open")?;
            bail!("the picker never offered {SMOKE_MODEL}");
        }
        std::thread::sleep(Duration::from_millis(900));
    }

    ctx.type_into("[data-testid=\"chat-input\"]", "hello smoke")?;
    // Sixty seconds, not fifteen: the previous scenario's run may still be
    // streaming when this one starts, and while it is the control is a stop
    // button rather than a send one.
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

    let replied = ctx.wait_until(
        "the model's reply",
        "return document.body.textContent.includes('Hello from the smoke model');",
        Duration::from_secs(60),
    );
    if replied.is_err() {
        let tail = ctx.eval_string(
            "const t = document.body.textContent || '';
             return t.slice(Math.max(0, t.length - 900));",
        )?;
        println!("      round-trip page tail: {tail}");
    }
    replied?;
    Ok(())
}

/// Startup reaches nothing the user did not configure.
///
/// The llama.cpp extension used to fetch an embedding model from
/// huggingface.co during provisioning, and again on the first RAG call if that
/// failed. The extension runs in the WebView, so the browser's own resource
/// timeline is the right instrument: every request the page made is in it.
fn scenario_no_unconfigured_egress(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/")?;
    // Give provisioning time to do whatever it is going to do.
    std::thread::sleep(Duration::from_secs(5));

    let port = ctx.mock_port;
    let report = ctx.eval_string(&format!(
        r#"const allowed = (url) =>
             url.startsWith('tauri://')
             || url.startsWith('asset://')
             || url.startsWith('ipc://')
             || url.startsWith('data:')
             || url.startsWith('blob:')
             || url.includes('://localhost')
             || url.includes('://tauri.localhost')
             || url.includes('://asset.localhost')
             || url.includes('://ipc.localhost')
             // The one endpoint this run configured.
             || url.includes('127.0.0.1:{port}');
           const foreign = performance
             .getEntriesByType('resource')
             .map((e) => e.name)
             .filter((name) => !allowed(name));
           return JSON.stringify({{ foreign: [...new Set(foreign)].slice(0, 20) }});"#
    ))?;
    println!("      unconfigured requests at startup: {report}");
    let v: Value = serde_json::from_str(&report).unwrap_or(Value::Null);
    let foreign = v
        .get("foreign")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    ensure!(
        foreign.is_empty(),
        "startup reached endpoints nobody configured: {report}"
    );
    Ok(())
}

/// AH-078. A real model request, then "What the model received" opened from
/// that request's own activity.
fn scenario_prompt_snapshot(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;

    // While a run streams the send control is replaced by a stop control, so
    // this selector finds nothing until the previous scenario's run is over.
    ctx.wait_until(
        "the previous run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.ensure_model_selected()?;
    // A fresh session first. The reply text is asserted on below, and a
    // previous attempt's reply is still on screen -- matching that made the
    // scenario continue before this attempt's dispatch had even happened, and
    // then blame the panel for not showing a snapshot that did not exist yet.
    ctx.eval(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /new session/i.test((x.textContent || '').trim()));
         if (b) b.click();
         return true;",
    )?;
    ctx.settle();
    ctx.wait_until(
        "an empty transcript",
        "return !document.body.innerText.includes('Hello from the smoke model');",
        Duration::from_secs(20),
    )?;

    ctx.type_into("[data-testid=\"chat-input\"]", "snapshot probe")?;
    // Sixty seconds, not fifteen: the previous scenario's run may still be
    // streaming when this one starts, and while it is the control is a stop
    // button rather than a send one.
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

    // Was one recorded at all? This separates "the transport never captured
    // it" from "it was captured and the timeline did not show it", which look
    // identical from the DOM.
    // The dispatch is recorded before anything is rendered, so a missing panel
    // and a missing record are different defects and must not read alike.
    // Polled: the click only starts the dispatch, and reading the log once,
    // straight after it, raced the transport writing the record.
    let count = || {
        std::env::var("JAN_DATA_FOLDER")
            .map(|d| Path::new(&d).join("audit/prompts.jsonl"))
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count()
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut records = count();
    while records == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        records = count();
    }
    ensure!(
        records >= 1,
        "the dispatch was never recorded ({records} records on disk)"
    );

    // The reply first. Without this a chat that never happened is reported as
    // "the panel did not appear", which is the wrong defect entirely.
    ctx.wait_until(
        "the model's reply",
        "return document.body.innerText.includes('Hello from the smoke model');",
        Duration::from_secs(90),
    )?;

    // The panel appears on the assistant message the snapshot produced.
    ctx.wait_until(
        "the prompt snapshot panel",
        "return !!document.querySelector('[data-testid=\"prompt-snapshot\"]');",
        Duration::from_secs(90),
    )?;

    // Collapsed until asked for.
    let open_before = ctx.eval_bool(
        "return document.querySelector('[data-testid=\"prompt-snapshot\"]').open === true;",
    )?;
    ensure!(!open_before, "the panel must be collapsed by default");

    ctx.eval(
        "document.querySelector('[data-testid=\"prompt-snapshot-toggle\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the snapshot to load",
        "return !!document.querySelector('[data-testid=\"prompt-snapshot-meta\"]');",
        Duration::from_secs(45),
    )?;

    let meta = ctx.eval_string(
        "return document.querySelector('[data-testid=\"prompt-snapshot-meta\"]').textContent;",
    )?;
    println!("      snapshot meta: {meta}");
    ensure!(
        meta.contains(SMOKE_PROVIDER) || meta.contains(SMOKE_MODEL),
        "the panel did not name the provider or model: {meta}"
    );
    ensure!(meta.contains("fnv1a64:"), "no payload hash shown: {meta}");
    ensure!(
        ctx.eval_bool(
            "return !!document.querySelector('[data-testid=\"prompt-snapshot-redactions\"]');"
        )?,
        "no redaction summary shown"
    );

    // Both views render the same payload.
    ctx.wait_until(
        "the tree view",
        "return !!document.querySelector('[data-testid=\"prompt-snapshot-tree\"]');",
        Duration::from_secs(15),
    )?;
    ctx.eval(
        "document.querySelector('[data-testid=\"prompt-snapshot-view-json\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the JSON view",
        "return !!document.querySelector('[data-testid=\"prompt-snapshot-json\"]');",
        Duration::from_secs(15),
    )?;

    // Nothing that looks like a credential reaches the panel. The seeded
    // provider carries an api key, so this is a real check and not a tautology.
    let panel = ctx.eval_string(
        "return document.querySelector('[data-testid=\"prompt-snapshot\"]').textContent;",
    )?;
    for secret in ["smoke-not-a-real-key", "Bearer ", "sk-"] {
        ensure!(!panel.contains(secret), "the panel exposed {secret:?}");
    }
    Ok(())
}

const REPLAY_MARKER: &str = "context-replay-phase-1.json";
const REPLAY_PROBE: &str = "replay probe one";

/// The newest snapshot the transport recorded of a turn whose user message
/// contains `needle`, leaving out replays' own dispatches.
fn recorded_dispatch(needle: &str) -> Option<Value> {
    let data = std::env::var("JAN_DATA_FOLDER").ok()?;
    let text = std::fs::read_to_string(Path::new(&data).join("audit/prompts.jsonl")).ok()?;
    text.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|s| s["agent"] != "replay")
        .rfind(|s| {
            s["payload"]["messages"].as_array().is_some_and(|m| {
                m.iter()
                    .any(|x| x["role"] == "user" && x["content"].to_string().contains(needle))
            })
        })
}

/// JS for the `i`th prompt snapshot panel, opened.
fn replay_panel(i: usize) -> String {
    format!(
        r#"{{ const p = document.querySelectorAll('[data-testid="prompt-snapshot"]')[{i}];
           if (p && !p.open) p.querySelector('[data-testid="prompt-snapshot-toggle"]').click(); }}"#
    )
}

/// The replay rows of panel `i`, newest first, as `state/matched/kind`.
fn replay_rows(ctx: &Ctx, i: usize) -> Result<Vec<String>, Failure> {
    let raw = ctx.eval_string(&format!(
        r#"const p = document.querySelectorAll('[data-testid="prompt-snapshot"]')[{i}];
           if (!p) return '[]';
           return JSON.stringify([...p.querySelectorAll('[data-testid="prompt-replay"]')].map(r =>
             [r.getAttribute('data-state'), r.getAttribute('data-matched'), r.getAttribute('data-kind')].join('/')));"#
    ))?;
    serde_json::from_str(&raw).map_err(|e| Failure(format!("replay rows: {e}")))
}

fn click_replay(ctx: &Ctx, i: usize) -> ScenarioResult {
    ctx.wait_until(
        "the replay control to be ready",
        &format!(
            r#"{}
               const b = document.querySelectorAll('[data-testid="prompt-snapshot"]')[{i}]
                 ?.querySelector('[data-testid="prompt-snapshot-replay"]');
               return !!b && !b.disabled;"#,
            replay_panel(i)
        ),
        Duration::from_secs(45),
    )?;
    ctx.eval(&format!(
        r#"document.querySelectorAll('[data-testid="prompt-snapshot"]')[{i}]
             .querySelector('[data-testid="prompt-snapshot-replay"]').click();
           return true;"#
    ))?;
    Ok(())
}

fn wait_top_replay(ctx: &Ctx, i: usize, rows: usize, state: &str) -> ScenarioResult {
    ctx.wait_until(
        &format!("replay {rows} of panel {i} to be {state}"),
        &format!(
            r#"const p = document.querySelectorAll('[data-testid="prompt-snapshot"]')[{i}];
               const rows = p ? [...p.querySelectorAll('[data-testid="prompt-replay"]')] : [];
               return rows.length === {rows} && rows[0].getAttribute('data-state') === {state:?};"#
        ),
        Duration::from_secs(60),
    )
}

/// AH-079, phase one: a past turn's exact context is sent again from the
/// panel that shows it, and the backend confirms the replay dispatch carried
/// the same payload. A replay is stopped part-way; a turn whose snapshot had a
/// field redacted is refused, in the panel and by the backend; and a replay is
/// left running when the app exits, for phase two to find.
fn scenario_context_replay_first(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    ctx.script_model("plain", &[])?;
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
    ctx.wait_until(
        "an empty transcript",
        "return !document.body.innerText.includes('Hello from the smoke model');",
        Duration::from_secs(20),
    )?;

    let send = |text: &str| -> ScenarioResult {
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
        Ok(())
    };
    let replies = |n: usize| -> ScenarioResult {
        ctx.wait_until(
            &format!("{n} model repl(ies) and an idle composer"),
            &format!(
                "return (document.body.innerText.split('Hello from the smoke model').length - 1) >= {n}
                   && !!document.querySelector('[data-test-id=\"send-message-button\"]')
                   && document.querySelectorAll('[data-testid=\"prompt-snapshot\"]').length >= {n};"
            ),
            Duration::from_secs(90),
        )
    };

    // 1. A turn to replay.
    send(REPLAY_PROBE)?;
    replies(1)?;
    let original = recorded_dispatch(REPLAY_PROBE)
        .ok_or_else(|| fail("the turn's dispatch was not recorded".into()))?;
    let session = original["session"].as_str().unwrap_or_default().to_string();
    let snapshot = original["id"].as_str().unwrap_or_default().to_string();
    ensure!(
        original["redactions"].as_array().is_some_and(|r| r.is_empty()),
        "the probe turn's snapshot has redactions: {}",
        original["redactions"]
    );

    // 2. Replayed from its panel: completed, and the same payload again.
    let before = mock_requests(ctx)?.len();
    click_replay(ctx, 0)?;
    wait_top_replay(ctx, 0, 1, "completed")?;
    let rows = replay_rows(ctx, 0)?;
    ensure!(
        rows[0].starts_with("completed/true"),
        "the replay did not confirm the same context: {rows:?}"
    );
    let requests = mock_requests(ctx)?;
    ensure!(requests.len() > before, "the replay never reached the model");
    let probes: Vec<&Value> = requests
        .iter()
        .filter(|r| r.to_string().contains(REPLAY_PROBE))
        .collect();
    ensure!(probes.len() >= 2, "the model saw {} probe request(s)", probes.len());
    let (turn, replay) = (probes[probes.len() - 2], probes[probes.len() - 1]);
    ensure!(
        turn == replay,
        "the replay sent a different request:\n turn   {turn}\n replay {replay}"
    );

    // 3. Stopped part-way.
    ctx.script_model("slow", &[])?;
    click_replay(ctx, 0)?;
    wait_top_replay(ctx, 0, 2, "running")?;
    ctx.wait_until(
        "the Stop control",
        "return !!document.querySelector('[data-testid=\"prompt-replay-cancel\"]');",
        Duration::from_secs(20),
    )?;
    ctx.eval(
        "document.querySelector('[data-testid=\"prompt-replay-cancel\"]').click(); return true;",
    )?;
    wait_top_replay(ctx, 0, 2, "cancelled")?;
    let rows = replay_rows(ctx, 0)?;
    ensure!(
        !rows.iter().any(|r| r.starts_with("running")),
        "a stopped replay still reads as running: {rows:?}"
    );

    // 4. A turn whose snapshot had a field redacted is refused.
    ctx.script_model("plain", &[])?;
    send("replay probe two uses sk-abcdefghijklmnopqrstuvwxyz0123 please")?;
    replies(2)?;
    let secret = recorded_dispatch("replay probe two")
        .ok_or_else(|| fail("the second turn's dispatch was not recorded".into()))?;
    let secret_id = secret["id"].as_str().unwrap_or_default().to_string();
    ensure!(
        secret["redactions"].as_array().is_some_and(|r| !r.is_empty()),
        "the fixture secret was not redacted, so there is nothing to refuse"
    );
    ctx.wait_until(
        "the redacted turn's replay control, disabled with a reason",
        &format!(
            r#"{}
               const p = document.querySelectorAll('[data-testid="prompt-snapshot"]')[1];
               const b = p && p.querySelector('[data-testid="prompt-snapshot-replay"]');
               const why = p && p.querySelector('[data-testid="prompt-snapshot-replay-blocked"]');
               return !!b && b.disabled && !!why && /redacted/.test(why.textContent);"#,
            replay_panel(1)
        ),
        Duration::from_secs(45),
    )?;
    let (ok, refused) = ipc(
        ctx,
        "agent_replay_begin",
        &format!("{{ session: {session:?}, snapshotId: {secret_id:?} }}"),
    )?;
    ensure!(
        !ok && refused["kind"] == "redacted",
        "the backend did not refuse the redacted snapshot: {refused}"
    );
    let (ok, foreign) = ipc(
        ctx,
        "agent_replay_begin",
        &format!("{{ session: 'someone-else', snapshotId: {snapshot:?} }}"),
    )?;
    ensure!(
        !ok && foreign["kind"] == "not-found",
        "another session could replay this snapshot: {foreign}"
    );

    // 5. Left running as the app exits.
    ctx.script_model("slow", &[])?;
    click_replay(ctx, 0)?;
    wait_top_replay(ctx, 0, 3, "running")?;
    std::fs::write(
        ctx.workspace.join(REPLAY_MARKER),
        serde_json::json!({ "session": session, "snapshot": snapshot, "secret": secret_id })
            .to_string(),
    )
    .map_err(|e| fail(e.to_string()))
}

/// AH-079, phase two, a new process on the same profile: every replay is
/// still listed with its ending, the one left running reads as interrupted,
/// and the refusal is kept.
fn scenario_context_replay_second(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let marker: Value = serde_json::from_str(
        &std::fs::read_to_string(ctx.workspace.join(REPLAY_MARKER))
            .map_err(|_| fail("phase one did not run against this workspace".into()))?,
    )
    .map_err(|e| fail(e.to_string()))?;
    let session = marker["session"].as_str().unwrap_or_default();
    let snapshot = marker["snapshot"].as_str().unwrap_or_default();
    let secret = marker["secret"].as_str().unwrap_or_default();
    ctx.script_model("plain", &[])?;

    let (ok, listed) = ipc(
        ctx,
        "agent_replays_list",
        &format!("{{ session: {session:?}, snapshotId: {snapshot:?} }}"),
    )?;
    ensure!(ok, "listing replays failed after a restart: {listed}");
    let states: Vec<&str> = listed
        .as_array()
        .map(|a| a.iter().filter_map(|r| r["state"].as_str()).collect())
        .unwrap_or_default();
    ensure!(
        states == ["interrupted", "cancelled", "completed"],
        "after a restart the replays are {states:?}"
    );
    ensure!(
        listed[2]["matched"] == true && !listed[2]["text"].as_str().unwrap_or_default().is_empty(),
        "the completed replay lost its result: {}",
        listed[2]
    );
    let (_, refusals) = ipc(
        ctx,
        "agent_replays_list",
        &format!("{{ session: {session:?}, snapshotId: {secret:?} }}"),
    )?;
    ensure!(
        refusals[0]["state"] == "refused" && refusals[0]["error"]["kind"] == "redacted",
        "the refusal was not kept: {refusals}"
    );

    // And in the panel.
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the turn's snapshot panel after a restart",
        "return document.querySelectorAll('[data-testid=\"prompt-snapshot\"]').length >= 1;",
        Duration::from_secs(60),
    )?;
    ctx.eval(&format!("{} return true;", replay_panel(0)))?;
    ctx.wait_until(
        "the replays listed in the panel",
        r#"const p = document.querySelectorAll('[data-testid="prompt-snapshot"]')[0];
           return p.querySelectorAll('[data-testid="prompt-replay"]').length === 3;"#,
        Duration::from_secs(45),
    )?;
    let rows = replay_rows(ctx, 0)?;
    let shown: Vec<&str> = rows.iter().map(|r| r.split('/').next().unwrap_or("")).collect();
    ensure!(
        shown == ["interrupted", "cancelled", "completed"],
        "the panel shows {rows:?} after a restart"
    );
    Ok(())
}

/// A tool call is recorded, stays in the conversation, and survives a reload.
/// AH-050/AH-172.
fn scenario_tool_activity(ctx: &Ctx) -> ScenarioResult {
    // A real tool call, not a plain reply: the model asks for `list`, the
    // dispatcher runs it, and the record has to show the whole life of it.
    ctx.script_model(
        "tools",
        &["ls:{\"path\":\".\"}", "read:{\"path\":\"no-such-file.txt\"}"],
    )?;
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

    // A fresh session, so what is asserted below belongs to this run.
    ctx.eval(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /new session/i.test((x.textContent || '').trim()));
         if (b) b.click();
         return true;",
    )?;
    ctx.settle();

    let before = activity_events(ctx);
    ctx.type_into("[data-testid=\"chat-input\"]", "list the folder")?;
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

    // The call appears in the conversation as its own item.
    let card = ctx.wait_until(
        "the tool call in the transcript",
        "return !!document.querySelector('[data-testid=\"tool-activity-item\"]');",
        Duration::from_secs(90),
    );
    if card.is_err() {
        // Which half failed matters: a model that never asked for a tool and a
        // dispatcher that never ran one look identical in the DOM.
        println!("      events on disk: {}", activity_events(ctx).len());
        println!(
            "      transcript: {}",
            ctx.eval_string("return (document.body.innerText || '').slice(0, 700);")
                .unwrap_or_default()
        );
    }
    card?;
    ctx.wait_until(
        "the run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;

    // The record, not the DOM: a card drawn from live state and a card drawn
    // from the record look identical, and only one of them survives a reload.
    let events = activity_events(ctx);
    ensure!(
        events.len() > before.len(),
        "the tool call was never recorded ({} events before, {} after)",
        before.len(),
        events.len()
    );
    let fresh = &events[before.len()..];
    for phase in ["requested", "running"] {
        ensure!(
            fresh
                .iter()
                .any(|e| e.contains(&format!("\"phase\":\"{phase}\""))),
            "no {phase} event was recorded"
        );
    }
    ensure!(
        fresh
            .iter()
            .any(|e| e.contains("\"phase\":\"succeeded\"") || e.contains("\"phase\":\"failed\"")),
        "the call never reached a terminal phase"
    );
    for secret in ["smoke-not-a-real-key", "Bearer ", "sk-"] {
        ensure!(
            !fresh.iter().any(|e| e.contains(secret)),
            "the record contains {secret:?}"
        );
    }

    // The count the provider reported is bound to the dispatch it counted, and
    // to that dispatch's snapshot. AH-073.
    let usage = std::env::var("JAN_DATA_FOLDER")
        .map(|d| Path::new(&d).join("audit/payload-usage.jsonl"))
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    let counted: Vec<&str> = usage.lines().filter(|l| !l.trim().is_empty()).collect();
    // Collected rather than returned on the spot: accounting is its own
    // feature (AH-073), and failing here used to hide whether the timeline
    // survives a reload, whether hiding completed activity hides the right
    // things, and whether any record carries the key. The scenario still fails
    // if accounting does -- at the end, after those have been checked.
    let mut accounting_failure: Option<String> = None;
    if counted.is_empty() {
        accounting_failure = Some("the dispatched payload was never accounted for".to_string());
    }
    for record in &counted {
        if accounting_failure.is_some() {
            break;
        }
        if !record.contains("\"source\":\"provider\"") {
            accounting_failure =
                Some(format!("a count was recorded that the provider did not report: {record}"));
        } else if record.contains("\"invocation\":\"\"") {
            // An unbound count is the defect this record exists to prevent.
            accounting_failure = Some(format!("a count was recorded against no dispatch: {record}"));
        } else if record.contains("\"snapshot\":\"\"") {
            accounting_failure =
                Some(format!("a count was recorded against no payload snapshot: {record}"));
        }
    }

    // Reload. The conversation is rebuilt from what was stored, so a tool call
    // that only lived in the run's memory disappears here.
    ctx.goto("/")?;
    ctx.settle();
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the tool call to survive the reload",
        "return !!document.querySelector('[data-testid=\"tool-activity-item\"]');",
        Duration::from_secs(45),
    )?;

    // Both calls are on the record, one succeeded and one failed.
    let all = activity_events(ctx);
    let fresh_all = &all[before.len()..];
    ensure!(
        fresh_all.iter().any(|e| e.contains("\"tool\":\"ls\"") && e.contains("\"phase\":\"succeeded\"")),
        "the succeeding call was not recorded as succeeded"
    );
    ensure!(
        fresh_all.iter().any(|e| e.contains("\"tool\":\"read\"") && e.contains("\"phase\":\"failed\"")),
        "the failing call was not recorded as failed"
    );
    let shown_before = ctx.eval_string(
        "return String(document.querySelectorAll('[data-testid=\"tool-activity-item\"]').length);",
    )?;
    ensure!(
        shown_before.parse::<usize>().unwrap_or(0) >= 2,
        "both calls should be visible before hiding anything (saw {shown_before})"
    );

    // "Hide completed tool activity" hides only what finished cleanly.
    let toggle_hide = |ctx: &Ctx, on: bool| -> ScenarioResult {
        ctx.goto("/settings/agent-tools")?;
        ctx.wait_until(
            "the hide-completed switch",
            "return !!document.querySelector('[data-testid=\"hide-completed-tools\"]');",
            Duration::from_secs(30),
        )?;
        ctx.eval(&format!(
            "const sw = document.querySelector('[data-testid=\"hide-completed-tools\"]');
             const on = sw.getAttribute('aria-checked') === 'true';
             if (on !== {on}) sw.click();
             return true;"
        ))?;
        ctx.settle();
        ctx.goto("/")?;
        ctx.settle();
        ctx.goto("/cowork")
    };
    toggle_hide(ctx, true)?;
    ctx.wait_until(
        "the hidden-activity notice",
        "return !!document.querySelector('[data-testid=\"hidden-tools\"]');",
        Duration::from_secs(30),
    )?;
    let shown_hidden = ctx.eval_string(
        "return String(document.querySelectorAll('[data-testid=\"tool-activity-item\"]').length);",
    )?;
    let hidden_ok = shown_hidden.parse::<usize>().unwrap_or(0);
    // Put the preference back before asserting, so a failure here does not
    // leave every later scenario looking at hidden activity.
    toggle_hide(ctx, false)?;
    ensure!(
        hidden_ok >= 1,
        "the failed call must stay visible with completed activity hidden (saw {shown_hidden})"
    );
    ensure!(
        hidden_ok < shown_before.parse::<usize>().unwrap_or(0),
        "hiding completed activity hid nothing (saw {shown_hidden} of {shown_before})"
    );

    // No credential in any record a run writes.
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    for file in [
        "audit/tool-activity.jsonl",
        "audit/prompts.jsonl",
        "audit/payload-usage.jsonl",
        "audit/permissions.jsonl",
    ] {
        let text = std::fs::read_to_string(Path::new(&data).join(file)).unwrap_or_default();
        ensure!(
            !text.contains("smoke-not-a-real-key"),
            "{file} contains the provider key"
        );
    }
    // The canonical event logs, where the execution record now lives.
    for log in std::fs::read_dir(Path::new(&data).join("events")).into_iter().flatten().flatten() {
        let text = std::fs::read_to_string(log.path()).unwrap_or_default();
        ensure!(
            !text.contains("smoke-not-a-real-key"),
            "{} contains the provider key",
            log.path().display()
        );
    }
    if let Some(failure) = accounting_failure {
        bail!("{failure}");
    }
    Ok(())
}

/// The lifecycle events on disk, one JSON line each.
fn activity_events(_ctx: &Ctx) -> Vec<String> {
    activity_records().iter().map(Value::to_string).collect()
}

/// The execution record on disk, one object per transition, read the way the
/// app reads it: the legacy `audit/tool-activity.jsonl` lines older builds
/// wrote, then every session's canonical event log (`events/*.jsonl`), each
/// tool or lifecycle envelope flattened to the activity event it carries, with
/// the envelope's session and sequence number. Oldest first, so a slice taken
/// after a count taken earlier is what was recorded since.
fn activity_records() -> Vec<Value> {
    let Ok(data) = std::env::var("JAN_DATA_FOLDER") else {
        return Vec::new();
    };
    let data = Path::new(&data);
    let mut out: Vec<Value> = std::fs::read_to_string(data.join("audit/tool-activity.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect();
    let mut logs: Vec<PathBuf> = std::fs::read_dir(data.join("events"))
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
                .collect()
        })
        .unwrap_or_default();
    logs.sort();
    let mut canonical = Vec::new();
    for log in logs {
        for line in std::fs::read_to_string(&log).unwrap_or_default().lines() {
            let Ok(envelope) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let kind = envelope["kind"].as_str().unwrap_or("");
            let Some(phase) = kind.strip_prefix("tool.").or_else(|| kind.strip_prefix("lifecycle.")) else {
                continue;
            };
            let mut event = envelope["payload"].clone();
            if let Some(map) = event.as_object_mut() {
                map.insert("session".into(), envelope["session"].clone());
                map.insert("seq".into(), envelope["seq"].clone());
                map.entry("phase").or_insert_with(|| Value::from(phase));
                canonical.push(event);
            }
        }
    }
    canonical.sort_by_key(|e| e["at_ms"].as_u64().unwrap_or(0));
    out.extend(canonical);
    out
}

/// A snapshot belonging to another session must not be retrievable.
fn scenario_prompt_snapshot_isolation(ctx: &Ctx) -> ScenarioResult {
    // Straight at the command, because this is a boundary the UI must not be
    // able to talk its way around either.
    let refused = ctx.eval(
        "try {
           const r = await window.__TAURI_INTERNALS__.invoke('agent_prompt_snapshots', {
             snapshotId: 'snap-1', session: 'a-session-that-is-not-mine'
           });
           return { ok: r };
         } catch (e) {
           return { err: String(e) };
         }",
    )?;
    println!("      cross-session lookup: {refused}");
    // Either refused outright, or empty -- never another session's payload.
    let leaked = refused
        .get("ok")
        .and_then(Value::as_array)
        .is_some_and(|rows| !rows.is_empty());
    ensure!(!leaked, "a snapshot leaked across sessions: {refused}");

    // An unscoped list must be refused rather than returning everything.
    let unscoped = ctx.eval(
        "try {
           const r = await window.__TAURI_INTERNALS__.invoke('agent_prompt_snapshots', {});
           return { ok: r };
         } catch (e) {
           return { err: String(e) };
         }",
    )?;
    ensure!(
        unscoped.get("err").is_some(),
        "an unscoped snapshot list must be refused: {unscoped}"
    );
    Ok(())
}

/// A failing provider says which endpoint failed, with what status, and who
/// answered -- not a bare status word.
fn scenario_provider_error(ctx: &Ctx) -> ScenarioResult {
    // Reproduces the reported failure: a local-looking endpoint answered 403 by
    // something on the internet.
    ctx.script_model("proxy-403", &[])?;
    // Confirm the fixture really is refusing before driving the UI: scripting
    // it and clicking in the same breath raced the switch.
    ctx.wait_until(
        "the fixture to start refusing",
        &format!(
            "const r = await fetch('http://127.0.0.1:{}/v1/models');
             return r.status === 403;",
            ctx.mock_port
        ),
        Duration::from_secs(20),
    )?;
    let restore = |ctx: &Ctx| {
        let _ = ctx.script_model("plain", &[]);
    };

    let outcome = (|| -> ScenarioResult {
        ctx.goto(&format!("/settings/providers/{SMOKE_PROVIDER}"))?;
        ctx.wait_until(
            "the provider page",
            "return document.body.textContent.length > 40;",
            Duration::from_secs(30),
        )?;

        // Refresh the model list, which is the request that fails. The button
        // is disabled while a refresh is in flight and the page mounts its
        // model section asynchronously, so one click is not reliably one
        // request -- press until the toast actually arrives.
        // Record every toast as it is inserted. Sampling the DOM races the
        // toast's own lifetime: sonner dismisses it after a few seconds, so a
        // poll that lands either side of that window sees nothing and reports
        // "no toast" for a toast that was shown.
        ctx.eval(
            "if (!globalThis.__toastLog) {
               globalThis.__toastLog = [];
               const seen = new WeakSet();
               const record = (n) => {
                 if (!(n instanceof HTMLElement)) return;
                 for (const t of n.matches?.('[data-sonner-toast]')
                        ? [n]
                        : [...n.querySelectorAll?.('[data-sonner-toast]') || []]) {
                   if (seen.has(t)) continue;
                   seen.add(t);
                   globalThis.__toastLog.push((t.textContent || '').trim());
                 }
               };
               new MutationObserver((records) => {
                 for (const r of records) r.addedNodes.forEach(record);
               }).observe(document.body, { childList: true, subtree: true });
             }
             globalThis.__toastLog.length = 0;
             return true;",
        )?;
        let toast_present = "return (globalThis.__toastLog || []).some(t => t.includes('403'));";
        let mut pressed = false;
        for _ in 0..4 {
            let clicked = ctx.eval_bool(
                "const b = [...document.querySelectorAll('button')].find(x =>
                   /^refresh/i.test(((x.getAttribute('aria-label') || '')
                     + ' ' + (x.getAttribute('title') || '')
                     + ' ' + (x.textContent || '')).trim()));
                 if (!b || b.disabled) return false; b.click(); return true;",
            )?;
            if clicked {
                pressed = true;
                if ctx
                    .wait_until("the failure toast", toast_present, Duration::from_secs(20))
                    .is_ok()
                {
                    break;
                }
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        if !pressed {
            ctx.describe("provider-page")?;
            bail!("the provider page offered no way to refresh its models");
        }

        // Observe the toast itself. Searching all of document.body raced the
        // toast's own lifetime and matched text from anywhere on the page.
        if ctx
            .wait_until("the failure toast", toast_present, Duration::from_secs(30))
            .is_err()
        {
            // Say what did appear. "No toast mentioning 403" and "a toast
            // saying the refresh succeeded" are different defects.
            let seen = ctx.eval_string("return JSON.stringify(globalThis.__toastLog || []);")?;
            bail!("no toast mentioned 403; toasts seen: {seen}");
        }

        let toast = ctx.eval_string(
            "const all = globalThis.__toastLog || [];
             const hit = all.filter(t => t.includes('403'));
             return JSON.stringify({
               count: hit.length,
               total: all.length,
               text: hit.join(' | '),
             });",
        )?;
        let v: Value = serde_json::from_str(&toast).unwrap_or(Value::Null);
        let text = v
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        println!("      failure toast: {toast}");

        ensure!(
            v.get("count").and_then(Value::as_u64) == Some(1),
            "expected exactly one failure toast: {toast}"
        );
        for needle in [
            SMOKE_PROVIDER,
            "GET",
            "403",
            "cloudflare",
            // The endpoint as configured, not the address it resolved to:
            // the message has to name what the user typed.
            &format!("{SMOKE_ENDPOINT_HOST}:{}", smoke_port()),
        ] {
            ensure!(
                text.contains(needle),
                "the toast never mentioned {needle:?}: {text}"
            );
        }
        ensure!(
            text.to_lowercase()
                .contains("resolving to a public address"),
            "the toast offered no remediation: {text}"
        );
        ensure!(
            !text.contains("[object Object]"),
            "the toast rendered a raw object: {text}"
        );
        // The seeded key must never be echoed back to the screen.
        ensure!(
            !text.contains("smoke-not-a-real-key"),
            "the toast leaked the provider's API key: {text}"
        );

        // And it must be dismissible. An error toast is deliberately sticky --
        // a message this actionable should not vanish while it is being read --
        // so the check is that dismissing it works, not that it expires.
        ctx.eval(
            "for (const t of document.querySelectorAll('[data-sonner-toast]')) {
               const b = t.querySelector('[data-close-button], button');
               if (b) b.click();
             }
             return true;",
        )?;
        ctx.wait_until(
            "the toast to be dismissed",
            "return ![...document.querySelectorAll('[data-sonner-toast]')]
               .some(t => (t.textContent || '').includes('403'));",
            Duration::from_secs(20),
        )?;

        Ok(())
    })();

    restore(ctx);
    outcome
}

/// Nothing in the composer footer may sit on top of anything else.
///
/// The send button and the Code/Preview/Changes/Activity rail icons share one
/// row. When the row runs out of width the send control is drawn over the rail
/// icons instead of the row wrapping or reserving space, which makes those
/// icons unclickable where they overlap.
/// The reported defect, end to end: a provider configured at a single-label
/// hostname must reach the machine on the private address, never the public
/// answer a search-domain collision produced.
fn scenario_local_hostname(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    ctx.settle();

    // Model discovery over the production command, at the URL exactly as
    // configured. Nothing here rewrites it to an address.
    let listed = ctx.eval_string(&format!(
        r#"const r = await window.__TAURI_INTERNALS__.invoke('provider_http_request', {{
             request: {{
               url: 'http://{host}:{port}/v1/models',
               method: 'GET',
               headers: {{ 'Content-Type': 'application/json' }},
               body: null,
               timeoutSecs: 15,
             }},
           }});
           return JSON.stringify({{ status: r.status, peer: r.peer, body: r.body.slice(0, 300) }});"#,
        host = SMOKE_ENDPOINT_HOST,
        port = smoke_port(),
    ))?;
    println!("      discovery: {listed}");
    let v: Value = serde_json::from_str(&listed).unwrap_or(Value::Null);
    ensure!(
        v.get("status").and_then(Value::as_u64) == Some(200),
        "model discovery at the configured hostname did not answer 200: {listed}"
    );
    ensure!(
        v.get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains(SMOKE_MODEL),
        "model discovery did not list {SMOKE_MODEL}: {listed}"
    );
    // The peer is the private address, not the public decoy.
    let peer = v.get("peer").and_then(Value::as_str).unwrap_or_default();
    ensure!(
        peer.starts_with("127.0.0.1:"),
        "the request reached {peer:?} instead of the private address"
    );

    let diag = ctx.eval_string(&format!(
        r#"const d = await window.__TAURI_INTERNALS__.invoke(
             'provider_endpoint_diagnostics', {{ host: {host:?}, port: {port} }});
           return JSON.stringify(d);"#,
        host = SMOKE_ENDPOINT_HOST,
        port = smoke_port(),
    ))?;
    println!("      diagnostics: {diag}");
    let d: Value = serde_json::from_str(&diag).unwrap_or(Value::Null);
    ensure!(
        d.get("selected").and_then(Value::as_str) == Some("127.0.0.1"),
        "the selected address was not the private one: {diag}"
    );
    ensure!(
        d.get("suppressedPublic").and_then(Value::as_bool) == Some(true),
        "the public candidate was not suppressed: {diag}"
    );
    ensure!(
        d.get("localName").and_then(Value::as_bool) == Some(true),
        "{SMOKE_ENDPOINT_HOST} was not treated as a local name: {diag}"
    );
    let decoy = d
        .get("candidates")
        .and_then(Value::as_array)
        .map(|c| {
            c.iter().any(|one| {
                one.get("address").and_then(Value::as_str) == Some(SMOKE_PUBLIC_DECOY)
                    && one.get("eligible").and_then(Value::as_bool) == Some(false)
            })
        })
        .unwrap_or(false);
    ensure!(
        decoy,
        "the public candidate is not reported as an ineligible candidate: {diag}"
    );
    ensure!(
        d.get("responded")
            .and_then(Value::as_str)
            .unwrap_or_default()
            == "127.0.0.1",
        "diagnostics did not record the responding peer: {diag}"
    );
    // Diagnostics never carry the credential the provider is configured with.
    ensure!(
        !diag.contains("smoke-not-a-real-key") && !diag.to_lowercase().contains("bearer"),
        "the diagnostics leaked a credential"
    );
    Ok(())
}

/// A chat streams through the same resolved endpoint as discovery.
fn scenario_stream_over_local_hostname(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    // Forget what was resolved so this scenario proves the whole path, not a
    // decision another scenario already made.
    ctx.eval(&format!(
        "await window.__TAURI_INTERNALS__.invoke('provider_endpoint_refresh',
           {{ host: {host:?}, port: {port} }});
         return true;",
        host = SMOKE_ENDPOINT_HOST,
        port = smoke_port(),
    ))?;

    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    // While a run streams the send control is replaced by a stop control, so
    // this selector finds nothing until the previous scenario's run is over.
    ctx.wait_until(
        "the previous run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.ensure_model_selected()?;
    ctx.type_into("[data-testid=\"chat-input\"]", "stream over the short name")?;
    // Sixty seconds, not fifteen: the previous scenario's run may still be
    // streaming when this one starts, and while it is the control is a stop
    // button rather than a send one.
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
        "the model's reply",
        "return document.body.innerText.includes('Hello from the smoke model');",
        Duration::from_secs(90),
    )?;

    let diag = ctx.eval_string(&format!(
        r#"const d = await window.__TAURI_INTERNALS__.invoke(
             'provider_endpoint_diagnostics', {{ host: {host:?}, port: {port} }});
           return JSON.stringify(d);"#,
        host = SMOKE_ENDPOINT_HOST,
        port = smoke_port(),
    ))?;
    println!("      streaming diagnostics: {diag}");
    let d: Value = serde_json::from_str(&diag).unwrap_or(Value::Null);
    ensure!(
        d.get("responded").and_then(Value::as_str) == Some("127.0.0.1"),
        "the streamed completion did not go to the private address: {diag}"
    );
    ensure!(
        d.get("suppressedPublic").and_then(Value::as_bool) == Some(true),
        "the public candidate was not suppressed for the streaming request: {diag}"
    );
    Ok(())
}

/// Nothing between the last thing said and the composer but the composer.
fn scenario_no_setup_wall(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    // While a run streams the send control is replaced by a stop control, so
    // this selector finds nothing until the previous scenario's run is over.
    ctx.wait_until(
        "the previous run to finish",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    ctx.ensure_model_selected()?;
    ctx.type_into("[data-testid=\"chat-input\"]", "clear the wall")?;
    // Sixty seconds, not fifteen: the previous scenario's run may still be
    // streaming when this one starts, and while it is the control is a stop
    // button rather than a send one.
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
        "the model's reply",
        "return document.body.innerText.includes('Hello from the smoke model');",
        Duration::from_secs(90),
    )?;
    ctx.settle();

    let report = ctx.eval_string(
        r#"const gone = (sel) => document.querySelectorAll(sel).length;
           const composer = document.querySelector('[data-testid="chat-input"]');
           const c = composer.getBoundingClientRect();
           // Anything diagnostic still rendered in the conversation would sit
           // above the composer and below the transcript.
           const snapshots = [...document.querySelectorAll('[data-testid="prompt-snapshot"]')];
           const orphan = snapshots.filter((s) => {
             const r = s.getBoundingClientRect();
             // A snapshot bar whose own row has no message text above it in the
             // same column is the empty bar that used to sit over the composer.
             return r.bottom <= c.top && r.bottom > c.top - 80;
           }).length;
           return JSON.stringify({
             compat: gone('[data-testid="cowork-compat"]'),
             readiness: gone('[aria-label="common:readiness.title"], section[aria-label*="readiness"]'),
             detailsBody: gone('[data-testid="session-details-body"]'),
             trigger: gone('[data-testid="session-details-trigger"]'),
             orphanSnapshotBars: orphan,
           });"#,
    )?;
    println!("      wall: {report}");
    let v: Value = serde_json::from_str(&report).unwrap_or(Value::Null);
    let count = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(u64::MAX);
    ensure!(
        count("compat") == 0,
        "the compatibility section is still in the conversation: {report}"
    );
    ensure!(
        count("readiness") == 0,
        "the readiness card is still in the conversation: {report}"
    );
    ensure!(
        count("detailsBody") == 0,
        "session details are expanded rather than closed: {report}"
    );
    ensure!(
        count("trigger") == 1,
        "there is no compact session-details control: {report}"
    );
    ensure!(
        count("orphanSnapshotBars") == 0,
        "an empty snapshot bar is sitting above the composer: {report}"
    );

    // The details are still reachable, and they carry the information that was
    // taken out of the conversation.
    ctx.eval(
        "document.querySelector('[data-testid=\"session-details-trigger\"]').click(); return true;",
    )?;
    ctx.wait_until(
        "the session details",
        "return !!document.querySelector('[data-testid=\"session-details-body\"]');",
        Duration::from_secs(10),
    )?;
    let has = ctx.eval_bool(
        "const b = document.querySelector('[data-testid=\"session-details-body\"]');
         return !!b && b.textContent.trim().length > 0;",
    )?;
    ensure!(has, "the session details opened empty");
    // Closed through its own control rather than a synthetic Escape, and the
    // overlay must actually leave the DOM -- a closed one still covering the
    // window is how a dialog silently blocks every later click.
    ctx.eval(
        "const c = [...document.querySelectorAll('[data-slot=\"dialog-content\"] button')]
           .find(b => (b.textContent || '').trim() === 'Close');
         if (c) { c.click(); return true; }
         document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
         return true;",
    )?;
    ctx.wait_until(
        "the dialog overlay to leave the DOM",
        "return !document.querySelector('[data-slot=\"dialog-overlay\"]');",
        Duration::from_secs(10),
    )?;
    Ok(())
}

/// Search and Settings are reachable from Cowork, and coming back returns to
/// the session as it was.
fn scenario_cowork_search_and_settings(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;

    // A draft and an open rail: the state a trip to Settings must not lose.
    ctx.type_into("[data-testid=\"chat-input\"]", "draft that must survive")?;
    ctx.click_matching("button", "Changes")?;
    ctx.settle();
    let rail_open = ctx.eval_bool(
        "return [...document.querySelectorAll('button')].some(b =>
           (b.getAttribute('aria-label') || b.textContent || '').trim() === 'Changes'
           && b.getAttribute('aria-pressed') === 'true')
         || !!document.querySelector('[data-testid=\"cowork-diff-panel\"]');",
    )?;

    // They live in the left nav now, so it has to be open.
    ctx.eval(
        "const t = document.querySelector('[data-sidebar=\"trigger\"]');
         if (t && !document.querySelector('[data-testid=\"cowork-search\"]')) t.click();
         return true;",
    )?;
    ctx.wait_until(
        "the cowork nav",
        "return !!document.querySelector('[data-testid=\"cowork-search\"]');",
        Duration::from_secs(15),
    )?;

    // Neither control may be covered by anything.
    let reach = ctx.eval_string(
        r#"const report = [];
           for (const id of ['cowork-search', 'cowork-settings']) {
             const el = document.querySelector(`[data-testid="${id}"]`);
             if (!el) { report.push({ id, missing: true }); continue; }
             const r = el.getBoundingClientRect();
             const cx = Math.round(r.left + r.width / 2);
             const cy = Math.round(r.top + r.height / 2);
             const hit = document.elementFromPoint(cx, cy);
             if (hit && (el.contains(hit) || hit === el)) continue;
             report.push({
               id,
               rect: { x: Math.round(r.left), y: Math.round(r.top),
                       w: Math.round(r.width), h: Math.round(r.height) },
               point: { cx, cy },
               hit: hit ? (() => {
                 const hr = hit.getBoundingClientRect();
                 return {
                   tag: hit.tagName,
                   testid: hit.getAttribute('data-testid'),
                   cls: (hit.className || '').toString().slice(0, 160),
                   z: getComputedStyle(hit).zIndex,
                   pos: getComputedStyle(hit).position,
                   pe: getComputedStyle(hit).pointerEvents,
                   rect: { x: Math.round(hr.left), y: Math.round(hr.top),
                           w: Math.round(hr.width), h: Math.round(hr.height) },
                   attrs: [...hit.attributes].map(a => a.name + '=' + a.value).join(' ').slice(0, 200),
                   parent: hit.parentElement ? {
                     tag: hit.parentElement.tagName,
                     cls: (hit.parentElement.className || '').toString().slice(0, 120),
                     attrs: [...hit.parentElement.attributes].map(a => a.name).join(',').slice(0, 120),
                   } : null,
                   kids: hit.children.length,
                 };
               })() : null,
             });
           }
           return JSON.stringify(report);"#,
    )?;
    ensure!(
        reach == "[]",
        "a quick action is covered by something else: {reach}"
    );

    // Search opens the shared dialog rather than a second implementation.
    ctx.eval("document.querySelector('[data-testid=\"cowork-search\"]').click(); return true;")?;
    ctx.wait_until(
        "the shared search dialog",
        "return !!document.querySelector('[role=\"dialog\"]');",
        Duration::from_secs(15),
    )?;
    // Closed through its own control. A synthetic Escape does not reach the
    // dismissable layer here, and a dialog that never closes leaves its
    // `fixed inset-0` overlay over everything after it.
    ctx.eval(
        "const c = [...document.querySelectorAll('[data-slot=\"dialog-content\"] button')]
           .find(b => (b.textContent || '').trim() === 'Close');
         if (c) { c.click(); return true; }
         document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
         return true;",
    )?;
    // The overlay is `fixed inset-0`, so anything hit-tested while it is still
    // leaving would report as covered by it.
    ctx.wait_until(
        "the dialog overlay to leave the DOM",
        "return !document.querySelector('[data-slot=\"dialog-overlay\"]');",
        Duration::from_secs(10),
    )?;
    ctx.settle();

    ctx.eval("document.querySelector('[data-testid=\"cowork-settings\"]').click(); return true;")?;
    ctx.wait_until(
        "the settings route",
        "return location.hash.includes('/settings') || location.pathname.includes('/settings');",
        Duration::from_secs(20),
    )?;

    // Back to Cowork: same session, same draft, same rail.
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.settle();

    let draft = ctx.eval_string(
        "const el = document.querySelector('[data-testid=\"chat-input\"]');
         return el ? (el.value || el.textContent || '') : '';",
    )?;
    ensure!(
        draft.contains("draft that must survive"),
        "the composer draft did not survive the trip to Settings: {draft:?}"
    );

    if rail_open {
        let still = ctx.eval_bool(
            "return [...document.querySelectorAll('button')].some(b =>
               (b.getAttribute('aria-label') || b.textContent || '').trim() === 'Changes'
               && b.getAttribute('aria-pressed') === 'true')
             || !!document.querySelector('[data-testid=\"cowork-diff-panel\"]');",
        )?;
        ensure!(
            still,
            "the open rail was lost on the way back from Settings"
        );
    }
    Ok(())
}

fn scenario_composer_layout(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the composer",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(30),
    )?;
    std::thread::sleep(Duration::from_millis(600));

    let report = ctx.eval_string(
        r#"const send = document.querySelector('[data-test-id="send-message-button"]');
           if (!send) return JSON.stringify({ error: 'no send button' });
           const s = send.getBoundingClientRect();
           const names = ['Code', 'Preview', 'Changes', 'Activity'];
           const clashes = [];
           for (const n of names) {
             const b = [...document.querySelectorAll('button')].find(x =>
               (x.getAttribute('aria-label') || x.textContent || '').trim() === n);
             if (!b) continue;
             const r = b.getBoundingClientRect();
             const overlapX = Math.min(s.right, r.right) - Math.max(s.left, r.left);
             const overlapY = Math.min(s.bottom, r.bottom) - Math.max(s.top, r.top);
             if (overlapX > 1 && overlapY > 1) {
               clashes.push({ rail: n, overlapX: Math.round(overlapX), overlapY: Math.round(overlapY) });
             }
             // Whatever the geometry says, the rail's own centre must belong to
             // the rail: that is what decides whether a click reaches it.
             const cx = Math.round(r.left + r.width / 2);
             const cy = Math.round(r.top + r.height / 2);
             const hit = document.elementFromPoint(cx, cy);
             if (hit && !b.contains(hit) && hit !== b && !hit.contains(b)) {
               clashes.push({
                 rail: n,
                 covered_by: hit.tagName,
                 cls: (hit.className || '').toString().slice(0, 120),
                 z: getComputedStyle(hit).zIndex,
                 pos: getComputedStyle(hit).position,
               });
             }
           }
           return JSON.stringify({ send: { left: Math.round(s.left), right: Math.round(s.right) }, clashes });"#,
    )?;
    println!("      composer layout: {report}");
    let v: Value = serde_json::from_str(&report).unwrap_or(Value::Null);
    let clashes = v
        .get("clashes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    ensure!(
        clashes.is_empty(),
        "composer controls overlap the rail icons: {report}"
    );
    Ok(())
}
// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
