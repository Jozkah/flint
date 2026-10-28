/// An edit made outside Jan shows up as a structured diff, with the added and
/// removed lines distinguished rather than a blob of text.
fn scenario_external_edit_diff(ctx: &Ctx) -> ScenarioResult {
    let notes = ctx.project.join("notes.txt");
    std::fs::write(
        &notes,
        "line one\nline two CHANGED\nline three\nline four added\n",
    )
    .map_err(|e| Failure(format!("could not edit the fixture: {e}")))?;

    ctx.goto("/cowork")?;
    // The rail button is a toggle and an earlier scenario may have left the
    // panel open, so make sure it is open rather than clicking it blindly.
    ctx.ensure_rail_open("Changes", "[data-testid=\"cowork-diff-panel\"]")?;
    std::thread::sleep(Duration::from_secs(1));

    // The panel holds the last scan; an edit made outside Jan only appears once
    // it rescans, so ask it to.
    ctx.eval(
        "const panel = document.querySelector('[data-testid=\"cowork-diff-panel\"]') || document;
         const b = [...panel.querySelectorAll('button')].find(x =>
           /refresh|rescan|reload/i.test((x.getAttribute('aria-label') || '')
             + ' ' + (x.getAttribute('title') || '')));
         if (b) b.click();
         return !!b;",
    )?;

    ctx.wait_until(
        "notes.txt to appear in Changes",
        "return document.body.textContent.includes('notes.txt');",
        Duration::from_secs(60),
    )?;

    // Open the file's diff and check it is structured: additions and deletions
    // are separate rows, not one lump of text.
    // The row is collapsed: expand it so the hunk is rendered.
    ctx.eval_bool(
        "const row = [...document.querySelectorAll('*')]
           .filter(e => (e.textContent || '').trim().endsWith('notes.txt')
                        && e.children.length <= 3)
           .pop();
         if (!row) return false;
         const clickable = row.closest('button,[role=\"button\"],[aria-expanded]')
           || row.parentElement?.querySelector('button,[aria-expanded]')
           || row;
         clickable.click();
         return true;",
    )?;
    std::thread::sleep(Duration::from_secs(2));
    // If it is still collapsed, click whatever advertises itself as expandable.
    if !ctx.eval_bool("return document.body.textContent.includes('line four added');")? {
        ctx.eval(
            "for (const e of document.querySelectorAll('[aria-expanded=\"false\"]')) {
               e.click();
             }
             return true;",
        )?;
        std::thread::sleep(Duration::from_secs(2));
    }

    let diff = ctx.eval_string(
        "const t = document.body.textContent || '';
         return JSON.stringify({
           added: t.includes('line four added'),
           changed: t.includes('line two CHANGED'),
           original: t.includes('line two') ,
         });",
    )?;
    println!("      diff content: {diff}");
    let v: Value = serde_json::from_str(&diff).unwrap_or(Value::Null);
    ensure!(
        v.get("added") == Some(&Value::Bool(true)) && v.get("changed") == Some(&Value::Bool(true)),
        "the diff did not show the edited and added lines: {diff}"
    );

    // Structured, not a blob: additions and deletions are marked apart from
    // each other rather than printed as one run of text.
    let structured = ctx.eval_bool(
        "const marked = [...document.querySelectorAll('*')].filter(e =>
           e.children.length === 0 && /^[+-]/.test((e.textContent || '').trim()));
         const cls = new Set([...document.querySelectorAll('[class*=\"add\"],[class*=\"insert\"],[class*=\"delete\"],[class*=\"remove\"]')]
           .map(e => e.className.toString()));
         return marked.length > 0 || cls.size > 0;",
    )?;
    ensure!(
        structured,
        "the diff rendered as plain text with no added/removed distinction"
    );
    Ok(())
}

/// A new session starts with no project of its own.
/// Make sure the Cowork session in view has this fixture's project attached,
/// attaching it through the real pill picker when it is not already. This is
/// what makes a scenario self-contained instead of depending on
/// `project-attachment` having attached a folder earlier in the run. Mirrors
/// the attach flow in `scenario_attach`.
fn ensure_project_attached(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    let name = ctx
        .project
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    // Already attached (e.g. project-attachment ran earlier in this run):
    // the project name shows and there is no "attach a folder" pill.
    let already = ctx.eval_bool(&format!(
        "return document.body.textContent.includes({name:?}) && !{PILL_JS};"
    ))?;
    if already {
        return Ok(());
    }
    ctx.script_dialog(Some(&ctx.project));
    let opened = open_picker_through_the_pill(ctx);
    let landed = opened.and_then(|()| {
        ctx.wait_until(
            "the project to attach",
            &format!(
                "return document.body.innerText.includes({name:?})
                     && !{PILL_JS};"
            ),
            Duration::from_secs(45),
        )
    });
    ctx.clear_dialog_script();
    landed
}

fn scenario_session_isolation(ctx: &Ctx) -> ScenarioResult {
    // Self-contained: attach our own project rather than relying on a folder a
    // prior scenario left attached, so `--only session-isolation` passes from a
    // fresh profile.
    ensure_project_attached(ctx)?;
    let name = ctx
        .project
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    ctx.wait_until(
        "the attached session",
        &format!("return document.body.textContent.includes({name:?});"),
        Duration::from_secs(30),
    )?;

    ctx.click_matching("button", "New session")?;
    ctx.wait_until(
        "a fresh session with no folder",
        &format!("return !!({PILL_JS});"),
        Duration::from_secs(30),
    )?;
    let leaked = ctx.eval_bool(&format!(
        "return document.body.textContent.includes({name:?});"
    ))?;
    ensure!(
        !leaked,
        "a new session inherited the previous session's attached project"
    );
    Ok(())
}

/// Session ids of the sidebar rows showing a run in progress.
fn running_sessions(ctx: &Ctx) -> Result<Vec<String>, Failure> {
    let raw = ctx.eval_string(
        "return JSON.stringify([...document.querySelectorAll('[data-testid^=\"cowork-session-running-\"]')]
           .map(e => e.getAttribute('data-testid').slice('cowork-session-running-'.length)));",
    )?;
    serde_json::from_str(&raw).map_err(|e| Failure(e.to_string()))
}

/// Type a request into the composer and send it without waiting for a reply.
fn send_without_waiting(ctx: &Ctx, text: &str) -> ScenarioResult {
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
}

/// Stop the run of the session in view through the composer's stop menu.
fn stop_current(ctx: &Ctx) -> ScenarioResult {
    ctx.wait_until(
        "the stop control",
        "return !!document.querySelector('[data-testid=\"cowork-stop\"]');",
        Duration::from_secs(20),
    )?;
    ctx.eval("document.querySelector('[data-testid=\"cowork-stop\"]').click(); return true;")?;
    ctx.wait_until(
        "the stop menu",
        "return !!document.querySelector('[data-testid=\"stop-current\"]');",
        Duration::from_secs(10),
    )?;
    ctx.eval("document.querySelector('[data-testid=\"stop-current\"]').click(); return true;")?;
    Ok(())
}

/// Set a React-controlled field and leave it, so its `onBlur` commits.
fn fill_and_leave(ctx: &Ctx, selector: &str, text: &str) -> ScenarioResult {
    ctx.type_into(selector, text)?;
    ctx.eval(&format!(
        "document.querySelector({selector:?})?.blur(); return true;"
    ))?;
    std::thread::sleep(Duration::from_millis(300));
    Ok(())
}

/// The headers of the chat requests the fixture received, names lower-cased.
fn captured_headers(ctx: &Ctx) -> Result<Vec<serde_json::Map<String, Value>>, Failure> {
    let raw = ctx.eval_string(&format!(
        "const r = await fetch('http://127.0.0.1:{}/__headers');
         return JSON.stringify(await r.json());",
        ctx.mock_port
    ))?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| Failure(e.to_string()))?;
    Ok(v["headers"]
        .as_array()
        .map(|a| a.iter().filter_map(|h| h.as_object().cloned()).collect())
        .unwrap_or_default())
}

/// Every file under `dir` whose bytes contain `needle`, by path. Never the
/// needle itself: the caller's message must not print a secret.
fn files_containing(dir: &Path, needle: &str) -> Vec<PathBuf> {
    let mut hits = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
            } else if meta.len() <= 64 * 1024 * 1024 {
                if let Ok(bytes) = std::fs::read(&path) {
                    if bytes.windows(needle.len()).any(|w| w == needle.as_bytes()) {
                        hits.push(path);
                    }
                }
            }
        }
    }
    hits
}

/// The provider's custom-header editor, open.
fn open_custom_headers(ctx: &Ctx) -> ScenarioResult {
    ctx.goto(&format!("/settings/providers/{SMOKE_PROVIDER}"))?;
    ctx.wait_until(
        "the custom headers editor",
        "return !!document.querySelector('[data-testid=\"custom-headers\"]');",
        Duration::from_secs(30),
    )
}

/// Remove every custom header row, through the editor.
fn clear_custom_headers(ctx: &Ctx) -> ScenarioResult {
    open_custom_headers(ctx)?;
    for _ in 0..8 {
        let removed = ctx.eval_bool(
            "const b = document.querySelector('[data-testid=\"custom-header-remove-0\"]');
             if (!b) return false; b.click(); return true;",
        )?;
        if !removed {
            break;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    Ok(())
}

/// Send one Cowork request and return the headers the provider received,
/// names lower-cased.
fn send_and_capture_headers(
    ctx: &Ctx,
    label: &str,
) -> Result<serde_json::Map<String, Value>, Failure> {
    let before = captured_headers(ctx)?.len();
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.ensure_model_selected()?;
    ctx.click_matching("button", "New session")?;
    std::thread::sleep(Duration::from_millis(500));
    send_and_wait(ctx, &format!("custom headers {label}"), "Hello from the smoke model")?;
    let all = captured_headers(ctx)?;
    ensure!(all.len() > before, "{label}: no chat request reached the provider");
    Ok(all.last().cloned().unwrap_or_default())
}

/// Send one request and check each custom header is there with its value, or
/// absent, as `tenant` and `key` say; never the refused `Authorization`.
/// Messages name headers only, never the secret.
fn check_custom_headers_sent_as(
    ctx: &Ctx,
    label: &str,
    secret: &str,
    tenant: bool,
    key: bool,
) -> ScenarioResult {
    let last = send_and_capture_headers(ctx, label)?;
    let value_of = |name: &str| last.get(name).and_then(|v| v.as_str()).unwrap_or("");
    if tenant {
        ensure!(
            value_of("x-smoke-tenant") == "tenant-8208",
            "{label}: the plain header did not reach the provider (headers sent: {:?})",
            last.keys().collect::<Vec<_>>()
        );
    } else {
        ensure!(
            !last.contains_key("x-smoke-tenant"),
            "{label}: a switched-off or removed header was still sent"
        );
    }
    if key {
        ensure!(
            value_of("x-smoke-key") == secret,
            "{label}: the secret header did not reach the provider with its value (present: {})",
            last.contains_key("x-smoke-key")
        );
    } else {
        ensure!(
            !last.contains_key("x-smoke-key"),
            "{label}: a removed secret header was still sent"
        );
    }
    ensure!(
        !value_of("authorization").contains("spoofed-8208"),
        "{label}: the refused Authorization header was sent"
    );
    Ok(())
}

fn check_custom_headers_sent(ctx: &Ctx, label: &str, secret: &str) -> ScenarioResult {
    check_custom_headers_sent_as(ctx, label, secret, true, true)
}

/// Type a value the test must never print. Carried into the page base64
/// encoded, so a timed-out script echoed into the log does not show it.
fn fill_and_leave_hidden(ctx: &Ctx, selector: &str, value: &str) -> ScenarioResult {
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(value);
    let ok = ctx.eval_bool(&format!(
        r#"const el = document.querySelector({selector:?});
           if (!el) return false;
           const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
           el.focus();
           setter.call(el, atob({encoded:?}));
           el.dispatchEvent(new Event('input', {{ bubbles: true }}));
           el.blur();
           return true;"#
    ))?;
    ensure!(ok, "input {selector:?} was not present");
    std::thread::sleep(Duration::from_millis(300));
    Ok(())
}

/// Switch custom header `index` on or off in the editor and wait until the
/// change is on disk.
fn set_custom_header_enabled(ctx: &Ctx, index: usize, on: bool) -> ScenarioResult {
    open_custom_headers(ctx)?;
    let sel = format!("[data-testid=\"custom-header-enabled-{index}\"]");
    let want = if on { "checked" } else { "unchecked" };
    let state = ctx.eval_string(&format!(
        "return document.querySelector({sel:?})?.getAttribute('data-state') || '';"
    ))?;
    if state != want {
        ctx.eval(&format!("document.querySelector({sel:?}).click(); return true;"))?;
    }
    ctx.wait_until(
        "the header switch to settle",
        &format!("return document.querySelector({sel:?})?.getAttribute('data-state') === {want:?};"),
        Duration::from_secs(10),
    )?;
    let settings = data_folder()?.join("settings.json");
    let by = Instant::now() + Duration::from_secs(20);
    loop {
        let off = std::fs::read_to_string(&settings)
            .unwrap_or_default()
            .replace('\\', "")
            .contains("\"enabled\":false");
        if off != on {
            return Ok(());
        }
        ensure!(Instant::now() < by, "switching the header {want} never reached settings.json");
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// A gateway that rejects the request and echoes its headers in the error:
/// the secret value must reach neither the page nor the disk.
fn check_echoed_secret_stays_hidden(ctx: &Ctx, secret: &str) -> ScenarioResult {
    ctx.script_model("echo-401", &[])?;
    let result = (|| -> ScenarioResult {
        let before = captured_headers(ctx)?.len();
        ctx.goto("/cowork")?;
        ctx.wait_until(
            "the cowork composer",
            "return !!document.querySelector('[data-testid=\"chat-input\"]');",
            Duration::from_secs(30),
        )?;
        ctx.click_matching("button", "New session")?;
        std::thread::sleep(Duration::from_millis(500));
        send_without_waiting(ctx, "custom headers echoed back")?;
        ctx.wait_until(
            "the rejected request",
            &format!(
                "const r = await fetch('http://127.0.0.1:{}/__headers');
                 return (await r.json()).headers.length > {before};",
                ctx.mock_port
            ),
            Duration::from_secs(60),
        )?;
        ctx.wait_until(
            "the rejected run to end",
            "return document.querySelectorAll('[data-testid^=\"cowork-session-running-\"]').length === 0;",
            Duration::from_secs(60),
        )?;
        std::thread::sleep(Duration::from_secs(2));
        let page = ctx.eval_string("return document.body.innerText || '';")?;
        ensure!(
            page.contains("rejected"),
            "the provider's error was not shown, so the check below proves nothing"
        );
        ensure!(
            !page.contains(secret),
            "the secret header's value was shown after an error echoed it"
        );
        ensure_secret_not_on_disk(secret)
    })();
    let _ = ctx.script_model("plain", &[]);
    result
}

/// The secret value is in no file of the data folder: not settings, not the
/// log, not a thread or a snapshot. The credential store's file is encrypted.
fn ensure_secret_not_on_disk(secret: &str) -> ScenarioResult {
    let leaked = files_containing(&data_folder()?, secret);
    ensure!(
        leaked.is_empty(),
        "the secret header value is on disk in the clear in: {leaked:?}"
    );
    Ok(())
}

fn credential_store_holds_headers() -> Result<bool, Failure> {
    let index = std::fs::read_to_string(data_folder()?.join("provider_secrets.index.json"))
        .unwrap_or_default();
    Ok(index.contains(&format!("provider-headers:{SMOKE_PROVIDER}")))
}

const CUSTOM_HEADERS_HANDOFF: &str = "custom-headers";

/// janhq/jan#8208, end to end in the real app.
///
/// Headers are added in the provider settings page; a plain one and a secret
/// one reach the provider on a real request; a header Jan owns is refused in
/// the page and never sent; the secret value is written to the credential
/// store and to no file in the data folder. With `COWORK_SMOKE_KEEP` the
/// headers are left in place for `custom-headers-survive-a-restart`.
fn scenario_custom_headers(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    // Unique per run, so a value left from an earlier run cannot pass this one.
    let secret = format!(
        "s8208-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let keep_for_restart = std::env::var_os("COWORK_SMOKE_KEEP").is_some();
    let row = |what: &str, i: usize| format!("[data-testid=\"custom-header-{what}-{i}\"]");

    let result = (|| -> ScenarioResult {
        clear_custom_headers(ctx)?;

        // A plain header.
        ctx.eval("document.querySelector('[data-testid=\"custom-header-add\"]').click(); return true;")?;
        fill_and_leave(ctx, &row("name", 0), "X-Smoke-Tenant")?;
        fill_and_leave(ctx, &row("value", 0), "tenant-8208")?;

        // A header Jan owns: refused where it is typed, with the reason.
        ctx.eval("document.querySelector('[data-testid=\"custom-header-add\"]').click(); return true;")?;
        fill_and_leave(ctx, &row("name", 1), "Authorization")?;
        fill_and_leave(ctx, &row("value", 1), "Bearer spoofed-8208")?;
        ctx.wait_until(
            "the reserved-name error",
            "const e = document.querySelector('[data-testid=\"custom-header-error-1\"]');
             return !!e && /sets this header itself/.test(e.textContent || '');",
            Duration::from_secs(10),
        )?;
        ctx.eval("document.querySelector('[data-testid=\"custom-header-remove-1\"]').click(); return true;")?;
        std::thread::sleep(Duration::from_millis(400));

        // A secret one: the name alone makes it secret, and its value is masked.
        ctx.eval("document.querySelector('[data-testid=\"custom-header-add\"]').click(); return true;")?;
        fill_and_leave(ctx, &row("name", 1), "X-Smoke-Key")?;
        fill_and_leave_hidden(ctx, &row("value", 1), &secret)?;
        let masked = ctx.eval_bool(&format!(
            "return document.querySelector({:?})?.getAttribute('data-state') === 'checked'
               && document.querySelector({:?})?.getAttribute('type') === 'password';",
            row("secret", 1),
            row("value", 1)
        ))?;
        ensure!(masked, "a key-like header was not treated as secret and masked");

        // Written: the name to settings, the value to the credential store only.
        let settings = data_folder()?.join("settings.json");
        let written_by = Instant::now() + Duration::from_secs(20);
        loop {
            let written = std::fs::read_to_string(&settings)
                .map(|t| t.contains("X-Smoke-Key") && t.contains("tenant-8208"))
                .unwrap_or(false);
            if written {
                break;
            }
            ensure!(
                Instant::now() < written_by,
                "the custom headers never reached settings.json"
            );
            std::thread::sleep(Duration::from_millis(250));
        }
        ensure!(
            credential_store_holds_headers()?,
            "the secret header value was not written to the credential store"
        );

        check_custom_headers_sent(ctx, "configured", &secret)?;
        // Switched off, the next request goes without it; switched back on,
        // with it. The secret one is untouched either way.
        set_custom_header_enabled(ctx, 0, false)?;
        check_custom_headers_sent_as(ctx, "tenant switched off", &secret, false, true)?;
        set_custom_header_enabled(ctx, 0, true)?;
        check_custom_headers_sent(ctx, "tenant switched back on", &secret)?;
        check_echoed_secret_stays_hidden(ctx, &secret)?;
        ensure_secret_not_on_disk(&secret)?;
        if keep_for_restart {
            // The handoff lives in the kept workspace, outside the data folder
            // the leak check scans.
            write_handoff(ctx, CUSTOM_HEADERS_HANDOFF, &serde_json::json!({ "secret": secret }))?;
        }
        Ok(())
    })();

    if keep_for_restart && result.is_ok() {
        return result;
    }
    // Leave the provider as it was, whatever happened above.
    let cleanup = clear_custom_headers(ctx);
    result?;
    cleanup?;
    std::thread::sleep(Duration::from_secs(1));
    ensure!(
        !credential_store_holds_headers()?,
        "removing the secret header left its value in the credential store"
    );
    Ok(())
}

/// The second half of `custom-headers-reach-the-provider-and-secrets-stay-secret`,
/// in a new process on the kept profile. The secret value is not in settings,
/// so a request that still carries it read it back from the credential store.
fn scenario_custom_headers_after_restart(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    let handoff = read_handoff(
        ctx,
        CUSTOM_HEADERS_HANDOFF,
        "custom-headers-reach-the-provider-and-secrets-stay-secret",
    )?;
    let secret = handoff["secret"].as_str().unwrap_or_default().to_string();
    ensure!(!secret.is_empty(), "the handoff carried no value");
    let result = (|| -> ScenarioResult {
        let settings = std::fs::read_to_string(data_folder()?.join("settings.json"))
            .unwrap_or_default();
        ensure!(settings.contains("X-Smoke-Key"), "the secret header's name did not survive");
        check_custom_headers_sent(ctx, "after a restart", &secret)?;
        ensure_secret_not_on_disk(&secret)
    })();
    let cleanup = clear_custom_headers(ctx);
    result?;
    cleanup?;
    // Removed, the headers are gone from the very next request.
    check_custom_headers_sent_as(ctx, "after removal", &secret, false, false)?;
    std::thread::sleep(Duration::from_secs(1));
    ensure!(
        !credential_store_holds_headers()?,
        "removing the secret header left its value in the credential store"
    );
    Ok(())
}

/// janhq/jan#8905. Two sessions running at once; Stop in the one in view ends
/// that run only, and the other keeps streaming. Each session records the
/// model it ran on, on disk, so it survives a restart.
fn scenario_stop_is_per_session(ctx: &Ctx) -> ScenarioResult {
    // A reply that never ends, so both runs are genuinely in flight.
    ctx.script_model("slow", &[])?;
    let result = (|| {
        ctx.goto("/cowork")?;
        ctx.wait_until(
            "the cowork composer",
            "return !!document.querySelector('[data-testid=\"chat-input\"]');",
            Duration::from_secs(30),
        )?;
        ctx.ensure_model_selected()?;
        ctx.click_matching("button", "New session")?;
        std::thread::sleep(Duration::from_millis(500));
        send_without_waiting(ctx, "long task in session A")?;
        ctx.wait_until(
            "session A to be running",
            "return document.querySelectorAll('[data-testid^=\"cowork-session-running-\"]').length === 1;",
            Duration::from_secs(60),
        )?;
        let first = running_sessions(ctx)?;
        let a = first.first().cloned().ok_or_else(|| Failure("no running session".into()))?;

        // A new session while A runs: A must not make it look busy.
        ctx.click_matching("button", "New session")?;
        ctx.wait_until(
            "a fresh, idle session in view",
            "return !document.querySelector('[data-testid=\"cowork-stop\"]');",
            Duration::from_secs(20),
        )?;
        send_without_waiting(ctx, "long task in session B")?;
        ctx.wait_until(
            "both sessions running",
            "return document.querySelectorAll('[data-testid^=\"cowork-session-running-\"]').length === 2;",
            Duration::from_secs(60),
        )?;
        let both = running_sessions(ctx)?;
        let b = both
            .iter()
            .find(|id| **id != a)
            .cloned()
            .ok_or_else(|| Failure(format!("no second running session in {both:?}")))?;

        // Stop in B, the session in view.
        stop_current(ctx)?;
        ctx.wait_until(
            "B to stop",
            &format!(
                "return !document.querySelector('[data-testid=\"cowork-session-running-{b}\"]');"
            ),
            Duration::from_secs(30),
        )?;
        // A is still going, and keeps going.
        std::thread::sleep(Duration::from_secs(3));
        let after = running_sessions(ctx)?;
        ensure!(
            after == vec![a.clone()],
            "Stop in session B changed other runs: running after stop = {after:?} (A = {a}, B = {b})"
        );

        // Each session recorded the model it ran on, and it reached disk.
        let settings = data_folder()?.join("settings.json");
        let deadline = Instant::now() + Duration::from_secs(20);
        let needle = format!(r#""model":{{"provider":"{SMOKE_PROVIDER}","id":"{SMOKE_MODEL}"}}"#);
        loop {
            let text = std::fs::read_to_string(&settings)
                .unwrap_or_default()
                .replace('\\', "");
            let count = text.matches(&needle).count();
            if count >= 2 {
                break;
            }
            ensure!(
                Instant::now() < deadline,
                "the sessions' models were not persisted ({count} of 2 found in settings.json)"
            );
            std::thread::sleep(Duration::from_millis(500));
        }
        if std::env::var_os("COWORK_SMOKE_KEEP").is_some() {
            write_handoff(ctx, SESSION_MODELS_HANDOFF, &serde_json::json!({ "a": a, "b": b }))?;
        }

        // Clean up: select A and stop it too.
        ctx.eval_bool(&format!(
            "const dot = document.querySelector('[data-testid=\"cowork-session-running-{a}\"]');
             const row = dot && dot.closest('button');
             if (row) row.click();
             return !!row;"
        ))?;
        stop_current(ctx)?;
        ctx.wait_until(
            "no session running",
            "return document.querySelectorAll('[data-testid^=\"cowork-session-running-\"]').length === 0;",
            Duration::from_secs(30),
        )
    })();
    let _ = ctx.script_model("plain", &[]);
    result
}

const SESSION_MODELS_HANDOFF: &str = "session-models";

/// Every object in `value`, depth first.
fn objects(value: &Value) -> Vec<&serde_json::Map<String, Value>> {
    let mut out = Vec::new();
    let mut stack = vec![value];
    while let Some(v) = stack.pop() {
        match v {
            Value::Object(map) => {
                out.push(map);
                stack.extend(map.values());
            }
            Value::Array(items) => stack.extend(items.iter()),
            _ => {}
        }
    }
    out
}

/// The persisted Cowork session `id`, read from settings.json the way the app
/// stores it (the store's state as a JSON string under its key).
fn persisted_session(id: &str) -> Result<Option<serde_json::Map<String, Value>>, Failure> {
    let text = std::fs::read_to_string(data_folder()?.join("settings.json"))
        .map_err(|e| Failure(format!("settings.json: {e}")))?;
    let outer: Value = serde_json::from_str(&text).map_err(|e| Failure(e.to_string()))?;
    for map in objects(&outer) {
        for value in map.values() {
            let inner = match value {
                Value::String(s) if s.contains(id) => serde_json::from_str::<Value>(s).ok(),
                _ => None,
            };
            let candidates = match &inner {
                Some(v) => objects(v),
                None => Vec::new(),
            };
            if let Some(found) = candidates
                .into_iter()
                .find(|m| m.get("id").and_then(|v| v.as_str()) == Some(id))
            {
                return Ok(Some(found.clone()));
            }
        }
        if map.get("id").and_then(|v| v.as_str()) == Some(id) {
            return Ok(Some(map.clone()));
        }
    }
    Ok(None)
}

/// janhq/jan#8905, second half of `stop-cancels-only-the-selected-session` in
/// a new process on the kept profile: each session still names the model it
/// ran on, and the app comes back on it.
fn scenario_session_models_after_restart(ctx: &Ctx) -> ScenarioResult {
    let handoff = read_handoff(
        ctx,
        SESSION_MODELS_HANDOFF,
        "stop-cancels-only-the-selected-session",
    )?;
    for key in ["a", "b"] {
        let id = handoff[key].as_str().unwrap_or_default();
        ensure!(!id.is_empty(), "the handoff has no session {key}");
        let session = persisted_session(id)?
            .ok_or_else(|| Failure(format!("session {key} did not survive the restart")))?;
        let model = session.get("model").cloned().unwrap_or(Value::Null);
        ensure!(
            model["provider"] == SMOKE_PROVIDER && model["id"] == SMOKE_MODEL,
            "session {key} came back without its model: {model}"
        );
    }
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the viewed session's model in the picker",
        &format!(
            "return [...document.querySelectorAll('button')].some(b =>
               (b.textContent || '').includes({SMOKE_MODEL:?}));"
        ),
        Duration::from_secs(30),
    )
}

/// janhq/jan#8905. Deleting a session whose run is streaming stops that run
/// and removes the session, and another session's run keeps going.
fn scenario_delete_running_session(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("slow", &[])?;
    let result = (|| -> ScenarioResult {
        ctx.goto("/cowork")?;
        ctx.wait_until(
            "the cowork composer",
            "return !!document.querySelector('[data-testid=\"chat-input\"]');",
            Duration::from_secs(30),
        )?;
        ctx.ensure_model_selected()?;
        ctx.click_matching("button", "New session")?;
        std::thread::sleep(Duration::from_millis(500));
        send_without_waiting(ctx, "keeps running in A")?;
        ctx.wait_until(
            "session A to be running",
            "return document.querySelectorAll('[data-testid^=\"cowork-session-running-\"]').length === 1;",
            Duration::from_secs(60),
        )?;
        let a = running_sessions(ctx)?
            .first()
            .cloned()
            .ok_or_else(|| Failure("no running session".into()))?;
        ctx.click_matching("button", "New session")?;
        ctx.wait_until(
            "a fresh, idle session in view",
            "return !document.querySelector('[data-testid=\"cowork-stop\"]');",
            Duration::from_secs(20),
        )?;
        send_without_waiting(ctx, "to be deleted in B")?;
        ctx.wait_until(
            "both sessions running",
            "return document.querySelectorAll('[data-testid^=\"cowork-session-running-\"]').length === 2;",
            Duration::from_secs(60),
        )?;
        let b = running_sessions(ctx)?
            .into_iter()
            .find(|id| *id != a)
            .ok_or_else(|| Failure("no second running session".into()))?;
        // The store writes to disk on a debounce, not synchronously: wait for
        // B to be there, or its disappearance later would prove nothing.
        let by = Instant::now() + Duration::from_secs(20);
        while persisted_session(&b)?.is_none() {
            ensure!(Instant::now() < by, "session B was never persisted");
            std::thread::sleep(Duration::from_millis(250));
        }

        // B's row menu, then Delete session, then confirm. Radix opens its
        // menu on pointerdown, not on click.
        let opened = ctx.eval_bool(&format!(
            "const dot = document.querySelector('[data-testid=\"cowork-session-running-{b}\"]');
             const item = dot && dot.closest('li');
             const more = item && [...item.querySelectorAll('button')]
               .find(x => (x.textContent || '').includes('More'));
             if (!more) return false;
             more.dispatchEvent(new PointerEvent('pointerdown',
               {{ bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }}));
             return true;"
        ))?;
        ensure!(opened, "session B's row has no menu");
        ctx.wait_until(
            "the session menu",
            "return [...document.querySelectorAll('[role=\"menuitem\"]')]
               .some(x => (x.textContent || '').trim() === 'Delete session');",
            Duration::from_secs(10),
        )?;
        ctx.eval(
            "[...document.querySelectorAll('[role=\"menuitem\"]')]
               .find(x => (x.textContent || '').trim() === 'Delete session').click();
             return true;",
        )?;
        ctx.wait_until(
            "the delete confirmation",
            "const d = document.querySelector('[role=\"dialog\"]');
             return !!d && (d.textContent || '').includes('Delete session?');",
            Duration::from_secs(10),
        )?;
        ctx.eval(
            "const d = document.querySelector('[role=\"dialog\"]');
             [...d.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Delete').click();
             return true;",
        )?;

        ctx.wait_until(
            "B's run to be gone",
            &format!(
                "return !document.querySelector('[data-testid=\"cowork-session-running-{b}\"]');"
            ),
            Duration::from_secs(30),
        )?;
        let by = Instant::now() + Duration::from_secs(20);
        while persisted_session(&b)?.is_some() {
            ensure!(Instant::now() < by, "the deleted session is still on disk");
            std::thread::sleep(Duration::from_millis(250));
        }
        // A was never touched.
        std::thread::sleep(Duration::from_secs(3));
        let after = running_sessions(ctx)?;
        ensure!(
            after == vec![a.clone()],
            "deleting B changed other runs: running after delete = {after:?} (A = {a})"
        );

        ctx.eval_bool(&format!(
            "const dot = document.querySelector('[data-testid=\"cowork-session-running-{a}\"]');
             const row = dot && dot.closest('button');
             if (row) row.click();
             return !!row;"
        ))?;
        stop_current(ctx)?;
        ctx.wait_until(
            "no session running",
            "return document.querySelectorAll('[data-testid^=\"cowork-session-running-\"]').length === 0;",
            Duration::from_secs(30),
        )
    })();
    let _ = ctx.script_model("plain", &[]);
    result
}

/// A monorepo for the tooling scenario: a pnpm workspace with a React/Vitest
/// app, a Tauri crate, and a junction to a folder outside it whose manifest
/// must never be read.
fn materialize_tooling_fixture(workspace: &Path) -> Result<(PathBuf, PathBuf), Failure> {
    let root = workspace.join("tooling-fixture");
    let outside = workspace.join("tooling-outside");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&outside);
    let write = |rel: &Path, body: &str| -> ScenarioResult {
        std::fs::create_dir_all(rel.parent().unwrap()).map_err(|e| Failure(e.to_string()))?;
        std::fs::write(rel, body).map_err(|e| Failure(format!("{}: {e}", rel.display())))
    };
    write(&root.join("package.json"), r#"{"private":true,"workspaces":["apps/*"]}"#)?;
    write(&root.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")?;
    write(&root.join("pnpm-workspace.yaml"), "packages:\n  - apps/*\n")?;
    write(
        &root.join("apps").join("web").join("package.json"),
        r#"{"scripts":{"build":"vite build","test":"vitest run"},
            "dependencies":{"react":"18.3.1"},"devDependencies":{"vitest":"3.2.4","vite":"6.0.0"}}"#,
    )?;
    write(
        &root.join("src-tauri").join("Cargo.toml"),
        "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n\n[dependencies]\ntauri = \"2\"\n",
    )?;
    write(&outside.join("package.json"), r#"{"dependencies":{"express":"4.21.0"}}"#)?;
    #[cfg(windows)]
    {
        // `cmd` reads a forward slash as a switch ("C:/tmp" is "/tmp"), and a
        // kept workspace can be spelled with them, so hand over backslashes as
        // the other junction fixtures do.
        let native = |p: &Path| p.to_string_lossy().replace('/', "\\");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(native(&root.join("linked")))
            .arg(native(&outside))
            .output()
            .map_err(|e| Failure(e.to_string()))?;
        ensure!(made.status.success(), "could not make the fixture junction: {made:?}");
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, root.join("linked")).map_err(|e| Failure(e.to_string()))?;
    Ok((root, outside))
}

/// AH-068 / AH-069 / AH-070, in the real app.
///
/// A monorepo is attached. The readiness card lists what was detected, each
/// with its source and certainty; the model's request carries exactly the
/// block the backend rendered for that folder -- not a re-rendering -- with
/// the right command for the right package; and a junction out of the
/// project is reported as not followed, its manifest's framework nowhere.
fn scenario_project_tooling(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    let (fixture, outside) = materialize_tooling_fixture(&ctx.workspace)?;
    let link = fixture.join("linked");
    let result = (|| -> ScenarioResult {
        ctx.script_dialog(Some(&fixture));
        let opened = open_picker_through_the_pill(ctx);
        let landed = opened.and_then(|()| {
            ctx.wait_until(
                "the tooling fixture to attach",
                &format!("return document.body.innerText.includes('tooling-fixture') && !{PILL_JS};"),
                Duration::from_secs(45),
            )
        });
        ctx.clear_dialog_script();
        landed?;

        // What the user sees.
        ctx.eval("document.querySelector('[data-testid=\"session-details-trigger\"]').click(); return true;")?;
        ctx.wait_until(
            "the detected tooling on the readiness card",
            "return document.querySelectorAll('[data-testid=\"readiness-tooling-fact\"]').length > 0;",
            Duration::from_secs(30),
        )?;
        let raw = ctx.eval_string(
            "return JSON.stringify([...document.querySelectorAll('[data-testid=\"readiness-tooling-fact\"]')]
               .map(e => ({ kind: e.dataset.kind, confidence: e.dataset.confidence,
                            text: (e.textContent || '').trim(), title: e.getAttribute('title') || '' })));",
        )?;
        let shown: Vec<Value> = serde_json::from_str(&raw).map_err(|e| Failure(e.to_string()))?;
        let has = |kind: &str, text: &str| {
            shown
                .iter()
                .any(|f| f["kind"] == kind && f["text"].as_str().is_some_and(|t| t.contains(text)))
        };
        ensure!(has("test-runner", "Vitest") && has("test-runner", "pnpm test"), "the card does not show Vitest with its command: {raw}");
        ensure!(has("framework", "React") && has("framework", "Tauri"), "the card does not show both frameworks: {raw}");
        ensure!(has("build-system", "Cargo"), "the card does not show Cargo: {raw}");
        ensure!(has("workspace", "pnpm workspace"), "the card does not show the pnpm workspace: {raw}");
        ensure!(!raw.contains("Express"), "a manifest behind the junction was read: {raw}");
        let vitest = shown
            .iter()
            .find(|f| f["text"].as_str().is_some_and(|t| t.starts_with("Vitest")))
            .unwrap();
        ensure!(
            vitest["confidence"] == "high"
                && vitest["title"].as_str().is_some_and(|t| t.contains("apps/web/package.json")),
            "the card does not name Vitest's source and certainty: {vitest}"
        );
        let _ = ctx.eval(
            "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
             return true;",
        );
        std::thread::sleep(Duration::from_millis(500));

        // What the backend rendered for this folder, straight from its command.
        let folder = fixture.to_string_lossy().to_string();
        let expected = ctx.eval_string(&format!(
            "const r = await window.__TAURI_INTERNALS__.invoke('project_tooling', {{ folder: {folder:?} }});
             return r.prompt || '';"
        ))?;
        ensure!(expected.starts_with("# Project Tooling"), "the backend rendered no block: {expected:?}");
        ensure!(
            expected.contains("- Vitest [unit] `pnpm test` in `apps/web/` -- high; apps/web/package.json"),
            "the block has no Vitest line for the web package: {expected}"
        );
        ensure!(expected.contains("- linked (a link; links are not followed)"), "the junction is not reported: {expected}");
        ensure!(!expected.contains("Express"), "the junction was followed: {expected}");

        // What the model got.
        let before = model_requests(ctx)?.len();
        send_and_wait(ctx, "what does this project build and test with", "Hello from the smoke model")?;
        let requests = model_requests(ctx)?;
        ensure!(requests.len() > before, "no request reached the model");
        let body = requests.last().unwrap();
        let system = body["messages"]
            .as_array()
            .and_then(|m| m.iter().find(|m| m["role"] == "system"))
            .map(|m| match &m["content"] {
                Value::String(s) => s.clone(),
                Value::Array(parts) => parts
                    .iter()
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => String::new(),
            })
            .unwrap_or_default();
        ensure!(
            system.contains(&expected),
            "the model's system prompt does not carry the backend's block verbatim"
        );
        Ok(())
    })();
    // Remove the junction itself, never what it points at; then the fixture.
    let _ = std::fs::remove_dir(&link);
    let _ = std::fs::remove_dir_all(&fixture);
    let _ = std::fs::remove_dir_all(&outside);
    result
}

/// Type into the composer and press Enter, the way a user adds input while
/// the agent works: with a run going, the composer queues it for the run.
fn type_and_enter(ctx: &Ctx, text: &str) -> ScenarioResult {
    ctx.type_into("[data-testid=\"chat-input\"]", text)?;
    std::thread::sleep(Duration::from_millis(200));
    ctx.eval(
        "const el = document.querySelector('[data-testid=\"chat-input\"]');
         el.focus();
         el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
         return true;",
    )?;
    std::thread::sleep(Duration::from_millis(300));
    Ok(())
}

/// The text of a request's user messages, in order.
fn user_texts(body: &Value) -> Vec<String> {
    body["messages"]
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .filter(|m| m["role"] == "user")
                .map(|m| match &m["content"] {
                    Value::String(s) => s.clone(),
                    Value::Array(parts) => parts
                        .iter()
                        .filter_map(|p| p["text"].as_str())
                        .collect::<Vec<_>>()
                        .join(""),
                    _ => String::new(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// janhq/jan#8864, in the real app.
///
/// Session A starts a run whose first step streams for a while and then asks
/// for a tool. Two messages are typed into A's composer meanwhile. The model's
/// next request -- the one after the tool result -- carries both, in order,
/// as user messages after the tool round; the first request carried neither;
/// the transcript marks them as steering; and a request from session B never
/// sees them.
fn scenario_steering(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("steer", &[])?;
    let result = (|| -> ScenarioResult {
        ctx.goto("/cowork")?;
        ctx.wait_until(
            "the cowork composer",
            "return !!document.querySelector('[data-testid=\"chat-input\"]');",
            Duration::from_secs(30),
        )?;
        ctx.ensure_model_selected()?;
        ctx.click_matching("button", "New session")?;
        std::thread::sleep(Duration::from_millis(500));
        let before = model_requests(ctx)?.len();
        send_without_waiting(ctx, "start the steered task")?;
        ctx.wait_until(
            "session A to be running",
            "return document.querySelectorAll('[data-testid^=\"cowork-session-running-\"]').length === 1;",
            Duration::from_secs(60),
        )?;
        // Typed once the first model call is under way, so the next boundary
        // is the one after the tool round. (Typed earlier, it is delivered at
        // the boundary before the first call, which is also correct.)
        ctx.wait_until(
            "the first request to reach the model",
            &format!(
                "const r = await fetch('http://127.0.0.1:{}/__requests');
                 return (await r.json()).requests.length > {before};",
                ctx.mock_port
            ),
            Duration::from_secs(60),
        )?;
        type_and_enter(ctx, "steer one: use pnpm")?;
        type_and_enter(ctx, "steer two: then run the tests")?;
        ctx.wait_until(
            "A's run to finish",
            "return document.querySelectorAll('[data-testid^=\"cowork-session-running-\"]').length === 0;",
            Duration::from_secs(120),
        )?;

        let requests = model_requests(ctx)?;
        let mine = &requests[before.min(requests.len())..];
        ensure!(mine.len() >= 2, "expected a request before and after the tool round, got {}", mine.len());
        let first = user_texts(&mine[0]);
        ensure!(
            !first.iter().any(|t| t.contains("steer one")),
            "the first request already carried the steering: {first:?}"
        );
        let carrying = mine
            .iter()
            .find(|b| user_texts(b).iter().any(|t| t.contains("steer one")))
            .ok_or_else(|| Failure("no request carried the steering".into()))?;
        // Consecutive user messages may be merged by the provider conversion,
        // in order; either way "one" precedes "two".
        let texts = user_texts(carrying).join("
");
        let one = texts.find("steer one").unwrap();
        let two = texts
            .find("steer two")
            .ok_or_else(|| Failure(format!("the second message was not delivered: {texts:?}")))?;
        ensure!(one < two, "steering arrived out of order: {texts:?}");
        // After the tool round, as user messages -- not in the model's turn.
        let roles: Vec<String> = carrying["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap_or("").to_string())
            .collect();
        let tool_at = roles.iter().position(|r| r == "tool");
        ensure!(tool_at.is_some(), "the steered request has no tool round: {roles:?}");
        let steer_at = carrying["messages"]
            .as_array()
            .unwrap()
            .iter()
            .position(|m| m["role"] == "user" && m.to_string().contains("steer one"))
            .unwrap();
        ensure!(steer_at > tool_at.unwrap(), "steering was not delivered after the tool round: {roles:?}");
        let assistant_has = carrying["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "assistant")
            .any(|m| m.to_string().contains("steer one"));
        ensure!(!assistant_has, "steering was put in the model's own turn");

        let labels = ctx.eval_string(
            "return String(document.querySelectorAll('[data-testid=\"steered-label\"]').length);",
        )?;
        ensure!(labels == "2", "the transcript marks {labels} messages as steering, not 2");
        // The words, not an i18n key: a key that does not resolve renders as
        // itself, and a count of labels cannot tell the two apart.
        let label = ctx.eval_string(
            "return document.querySelector('[data-testid=\"steered-label\"]')?.textContent?.trim() || '';",
        )?;
        ensure!(
            label == "Sent to the agent while it was working",
            "the steering label reads {label:?}"
        );

        // Session B, in the same app, never sees A's input.
        ctx.script_model("plain", &[])?;
        ctx.click_matching("button", "New session")?;
        std::thread::sleep(Duration::from_millis(500));
        let before_b = model_requests(ctx)?.len();
        send_and_wait(ctx, "a question in session B", "Hello from the smoke model")?;
        let requests = model_requests(ctx)?;
        ensure!(requests.len() > before_b, "session B sent nothing");
        let b = requests.last().unwrap().to_string();
        ensure!(!b.contains("steer one") && !b.contains("steer two"), "session B's request carried A's steering");
        Ok(())
    })();
    let _ = ctx.script_model("plain", &[]);
    result
}

// ---------------------------------------------------------------------------
// Cross-session messaging and stop_session (docs/SESSION_MESSAGING.md)
// ---------------------------------------------------------------------------

/// Re-script the fixture's per-conversation routes (default script `plain`).
fn script_routes(ctx: &Ctx, routes: &Value, fresh_turns: bool) -> ScenarioResult {
    let port = ctx.mock_port;
    let body = serde_json::json!({
        "script": "plain",
        "tools": [],
        "routes": routes,
        "fresh_turns": fresh_turns,
        "delay": 0.4,
    })
    .to_string();
    let ok = ctx.eval_bool(&format!(
        r#"const res = await fetch('http://127.0.0.1:{port}/__control', {{
             method: 'POST',
             headers: {{ 'Content-Type': 'application/json' }},
             body: {body:?},
           }});
           return res.ok;"#
    ))?;
    ensure!(ok, "could not script the fixture's routes");
    Ok(())
}

/// `mailbox_list_sessions` for `session`, straight from the backend.
fn mailbox_peers(ctx: &Ctx, session: &str) -> Result<Vec<Value>, Failure> {
    let raw = ctx.eval_string(&format!(
        r#"const c = await window.__TAURI_INTERNALS__.invoke('get_app_configurations');
           const r = await window.__TAURI_INTERNALS__.invoke('plugin:agent-tools|mailbox_list_sessions',
             {{ dataFolder: c.data_folder, sessionId: {session:?} }});
           return JSON.stringify(r);"#
    ))?;
    serde_json::from_str(&raw).map_err(|e| Failure(format!("{e}: {raw}")))
}

fn content_text(message: &Value) -> String {
    match &message["content"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn first_user_text(body: &Value) -> String {
    body["messages"]
        .as_array()
        .and_then(|m| m.iter().find(|m| m["role"] == "user"))
        .map(content_text)
        .unwrap_or_default()
}

/// A request's tool results as `(tool name, text)`, in order, quotes unescaped.
fn tool_results(body: &Value) -> Vec<(String, String)> {
    let messages = body["messages"].as_array().cloned().unwrap_or_default();
    let mut names = std::collections::HashMap::new();
    for m in &messages {
        for call in m["tool_calls"].as_array().into_iter().flatten() {
            if let (Some(id), Some(name)) = (call["id"].as_str(), call["function"]["name"].as_str()) {
                names.insert(id.to_string(), name.to_string());
            }
        }
    }
    messages
        .iter()
        .filter(|m| m["role"] == "tool")
        .map(|m| {
            let name = names
                .get(m["tool_call_id"].as_str().unwrap_or_default())
                .cloned()
                .unwrap_or_default();
            (name, content_text(m).replace("\\\"", "\""))
        })
        .collect()
}

/// The newest fixture request `pick` accepts, waiting up to `timeout`.
fn wait_for_request(
    ctx: &Ctx,
    what: &str,
    pick: impl Fn(&Value) -> bool,
    timeout: Duration,
) -> Result<Value, Failure> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(found) = model_requests(ctx)?.into_iter().rev().find(|b| pick(b)) {
            return Ok(found);
        }
        ensure!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// Stop every Cowork run still going, through each session's own Stop.
fn stop_every_run(ctx: &Ctx) {
    for _ in 0..4 {
        let Ok(running) = running_sessions(ctx) else { return };
        let Some(sid) = running.first() else { return };
        let _ = open_cowork_session(ctx, sid).and_then(|()| stop_current(ctx));
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Session messaging between two ordinary Cowork sessions, real app.
///
/// App, IPC, the Rust mailbox and the renderer are real; the *model's* turns
/// are scripted by the mock provider (routes keyed by each session's first
/// message). Sessions A and B share the fixture project; C is in another
/// folder. B streams for a while, then calls a tool; A lists sessions and
/// messages B meanwhile. B's next model request carries the fenced mail after
/// its intact tool round, B's transcript attributes it to A, and a later
/// message to an idle B is held for its user.
fn scenario_session_messaging(ctx: &Ctx) -> ScenarioResult {
    messaging_between_sessions(ctx, false)
}

/// As above, then A calls `stop_session` on C (refused: another project) and
/// on B; A's user approves the prompt in A; B's run stops, B's transcript
/// records who stopped it and why, and A's tool result says `applied`.
fn scenario_stop_session(ctx: &Ctx) -> ScenarioResult {
    messaging_between_sessions(ctx, true)
}

fn messaging_between_sessions(ctx: &Ctx, stop: bool) -> ScenarioResult {
    let other = ctx.workspace.join("messaging-other-project");
    std::fs::create_dir_all(&other).map_err(|e| Failure(e.to_string()))?;
    std::fs::write(other.join("README.md"), "# another project\n")
        .map_err(|e| Failure(e.to_string()))?;
    let tag = if stop { "stop" } else { "msg" };
    let task_a = format!("messaging task A {tag}");
    let task_b = format!("messaging task B {tag}");
    let reason = "we both own src/x.ts";
    let mail = "Please stop/pause: we both own src/x.ts";
    const WRAPPER: &str = "[Coordination message from session";

    let result = (|| -> ScenarioResult {
        ctx.script_model("plain", &[])?;
        new_cowork_session(ctx)?;
        attach_folder(ctx, &other)?;
        let c = current_cowork_session(ctx)?;
        new_cowork_session(ctx)?;
        attach_folder(ctx, &ctx.project)?;
        let b = current_cowork_session(ctx)?;
        new_cowork_session(ctx)?;
        attach_folder(ctx, &ctx.project)?;
        let a = current_cowork_session(ctx)?;
        ensure!(a != b && b != c && a != c, "sessions were not distinct: A={a} B={b} C={c}");
        // A folder starts a session in Review, which offers no stop_session.
        choose_mode(ctx, "Ask before changes")?;
        println!("messaging sessions: A={a} B={b} C={c} (C in {})", other.display());

        // Presence reached the backend: A's project holds B, not C.
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let peers = mailbox_peers(ctx, &a)?;
            if peers.iter().any(|p| p["id"] == b.as_str()) {
                ensure!(
                    !peers.iter().any(|p| p["id"] == c.as_str()),
                    "A's project lists C from another folder: {peers:?}"
                );
                break;
            }
            ensure!(Instant::now() < deadline, "A never saw B in its project: {peers:?}");
            std::thread::sleep(Duration::from_millis(500));
        }

        let mut a_tools = vec![
            "list_sessions:{}".to_string(),
            format!("send_message:{}", serde_json::json!({ "session_id": b, "text": mail })),
        ];
        if stop {
            a_tools.push(format!(
                "stop_session:{}",
                serde_json::json!({ "session_id": c, "reason": reason })
            ));
            a_tools.push(format!(
                "stop_session:{}",
                serde_json::json!({ "session_id": b, "reason": reason })
            ));
        }
        let todo = r#"todo:{"op":"init","list":[{"phase":"Work","items":["Edit src/x.ts"]}]}"#;
        script_routes(
            ctx,
            &serde_json::json!([
                { "match": task_b, "lead": 25, "tools": [todo],
                  "then": if stop { "slow" } else { "summary" },
                  "summary": "B finished after reading the message." },
                { "match": task_a, "tools": a_tools, "summary": "A coordinated with B." }
            ]),
            false,
        )?;

        // B first, and mid-stream before A says anything.
        open_cowork_session(ctx, &b)?;
        send_without_waiting(ctx, &task_b)?;
        wait_for_request(
            ctx,
            "B's first request",
            |r| first_user_text(r).contains(&task_b),
            Duration::from_secs(60),
        )?;
        open_cowork_session(ctx, &a)?;
        // The first turn of a folder-bound session runs read-only unless it is
        // an explicit instruction (`decideOpening`), and read-only runs do not
        // offer stop_session. The route still matches on `task_a`.
        let a_text = if stop {
            format!("Fix src/x.ts for {task_a}")
        } else {
            task_a.clone()
        };
        send_without_waiting(ctx, &a_text)?;

        // B's next request carries the mail, after its intact tool round.
        let carrying = wait_for_request(
            ctx,
            "B's request carrying the coordination message",
            |r| {
                first_user_text(r).contains(&task_b)
                    && user_texts(r).iter().any(|t| t.contains(WRAPPER))
            },
            Duration::from_secs(120),
        )?;
        let requests = model_requests(ctx)?;
        let b_first = requests
            .iter()
            .find(|r| {
                first_user_text(r).contains(&task_b)
                    && !r["messages"].as_array().is_some_and(|m| m.iter().any(|m| m["role"] == "tool"))
            })
            .ok_or_else(|| Failure("B's first request is no longer in the log".into()))?;
        ensure!(
            !b_first.to_string().contains(WRAPPER),
            "the mail was already in B's first (streaming) request"
        );
        let msgs = carrying["messages"].as_array().cloned().unwrap_or_default();
        let roles: Vec<String> = msgs.iter().map(|m| m["role"].as_str().unwrap_or("").to_string()).collect();
        let call_at = msgs
            .iter()
            .position(|m| m["role"] == "assistant" && m["tool_calls"].as_array().is_some_and(|c| !c.is_empty()))
            .ok_or_else(|| Failure(format!("B's request has no tool call: {roles:?}")))?;
        ensure!(
            msgs.get(call_at + 1).is_some_and(|m| m["role"] == "tool"),
            "B's tool call is not immediately followed by its result: {roles:?}"
        );
        let mail_at = msgs
            .iter()
            .position(|m| m["role"] == "user" && content_text(m).contains(WRAPPER))
            .unwrap();
        ensure!(mail_at > call_at + 1, "the mail was put inside B's tool round: {roles:?}");
        let text = content_text(&msgs[mail_at]);
        ensure!(text.contains(&format!("({a}), message msg-")), "the mail is not attributed to A ({a}): {text}");
        let mid = text
            .split("<<<MAIL-")
            .nth(1)
            .and_then(|rest| rest.split('\n').next())
            .ok_or_else(|| Failure(format!("the mail has no fence: {text}")))?
            .to_string();
        ensure!(text.contains(&format!("MAIL-{mid}>>>")), "the mail fence is not closed: {text}");
        ensure!(text.contains(mail), "the mail body did not arrive: {text}");
        println!("B request roles: {roles:?}; mail id {mid}; header: {}", text.lines().next().unwrap_or(""));

        if stop {
            // The prompt in A names B's session and the reason, and offers
            // nothing broader than this once.
            let card_js = "[...document.querySelectorAll('[data-testid=\"inline-approval-card\"]')]
                 .find(c => /stop the run in session/i.test(c.textContent || ''))";
            let prompt = ctx.wait_until(
                "the stop_session approval prompt in A",
                &format!("return !!({card_js});"),
                Duration::from_secs(60),
            );
            if prompt.is_err() {
                // Say why: what A's model got back, and what A's page shows.
                if let Ok(requests) = model_requests(ctx) {
                    for r in requests.iter().filter(|r| first_user_text(r).contains(&task_a)) {
                        let tools: Vec<&str> = r["tools"]
                            .as_array()
                            .map(|t| t.iter().filter_map(|x| x["function"]["name"].as_str()).collect())
                            .unwrap_or_default();
                        println!(
                            "A request: advertised stop_session={} results={:?}",
                            tools.contains(&"stop_session"),
                            tool_results(r)
                        );
                    }
                }
                let page = ctx.eval_string(
                    "return JSON.stringify({
                       cards: [...document.querySelectorAll('[data-testid=\"inline-approval-card\"]')].map(c => c.textContent),
                       allowOnce: [...document.querySelectorAll('button')].filter(b => /allow once/i.test(b.textContent || '')).length,
                       mode: [...document.querySelectorAll('button')].filter(b => b.getAttribute('aria-label') === 'What Flint may do').map(b => b.textContent),
                       running: [...document.querySelectorAll('[data-testid^=\"cowork-session-running-\"]')].map(e => e.getAttribute('data-testid')),
                       text: (document.body.innerText || '').slice(-1500) });",
                )
                .unwrap_or_default();
                println!("A page at timeout: {page}");
            }
            prompt?;
            let card = ctx.eval_string(&format!(
                "const c = {card_js};
                 return JSON.stringify({{ text: c.textContent,
                   buttons: [...c.querySelectorAll('button')].map(b => (b.textContent || '').trim()) }});"
            ))?;
            println!("A approval card: {card}");
            ensure!(card.contains(reason), "the prompt does not show the reason: {card}");
            ensure!(
                !card.to_lowercase().contains("always allow") && !card.contains("Allow in this conversation"),
                "the prompt offers a standing grant: {card}"
            );
            ensure!(!running_sessions(ctx)?.is_empty(), "nothing is running before approval");
            ensure!(running_sessions(ctx)?.contains(&b), "B stopped before it was approved");
            let allow = format!(
                "const c = {card_js}; const b = c && [...c.querySelectorAll('button')]
                   .find(x => /^allow once$/i.test((x.textContent || '').trim()));"
            );
            ctx.wait_until(
                "Allow once to arm",
                &format!("{allow} return !!b && !b.disabled;"),
                Duration::from_secs(20),
            )?;
            ctx.eval(&format!("{allow} b.click(); return true;"))?;

            ctx.wait_until(
                "B's run to stop",
                &format!("return !document.querySelector('[data-testid=\"cowork-session-running-{b}\"]');"),
                Duration::from_secs(40),
            )?;
        }
        ctx.wait_until(
            "A's run to finish",
            &format!("return !document.querySelector('[data-testid=\"cowork-session-running-{a}\"]');"),
            Duration::from_secs(90),
        )?;

        // A's tool results, as the model received them.
        let a_follow = wait_for_request(
            ctx,
            "A's follow-up request",
            |r| first_user_text(r).contains(&task_a) && !tool_results(r).is_empty(),
            Duration::from_secs(30),
        )?;
        let results = tool_results(&a_follow);
        println!("A tool results: {results:?}");
        let listed = results.iter().find(|(n, _)| n == "list_sessions").map(|(_, t)| t.clone()).unwrap_or_default();
        ensure!(listed.contains(&b), "list_sessions did not return B: {listed}");
        ensure!(listed.contains(&c), "list_sessions did not return C (sessions in any project are listed): {listed}");
        let sent = results.iter().find(|(n, _)| n == "send_message").map(|(_, t)| t.clone()).unwrap_or_default();
        ensure!(
            sent.contains("\"delivered_to_status\":\"running\""),
            "send_message did not report a running target: {sent}"
        );
        if stop {
            let stops: Vec<&String> = results.iter().filter(|(n, _)| n == "stop_session").map(|(_, t)| t).collect();
            ensure!(stops.len() == 2, "expected two stop_session results: {results:?}");
            ensure!(
                stops[0].contains("unknown_session") && !stops[0].contains("Gamma"),
                "stopping C in another project was not refused as unknown: {}",
                stops[0]
            );
            ensure!(stops[1].contains("\"status\":\"applied\""), "stopping B was not applied: {}", stops[1]);

            let raw = std::fs::read_to_string(data_folder()?.join("mailbox").join("stops.json"))
                .map_err(|e| Failure(format!("stops.json: {e}")))?;
            let stops_file: Value = serde_json::from_str(&raw).map_err(|e| Failure(e.to_string()))?;
            let record = stops_file
                .as_object()
                .and_then(|m| m.values().find(|r| r["to"]["sessionId"] == b.as_str()))
                .ok_or_else(|| Failure(format!("no stop record for B: {raw}")))?;
            ensure!(
                record["status"] == "applied"
                    && record["from"]["sessionId"] == a.as_str()
                    && record["reason"] == reason
                    && record["targetRunId"].as_str().is_some_and(|r| !r.is_empty()),
                "the stop record is not what happened: {record}"
            );
            ensure!(
                !stops_file.as_object().unwrap().values().any(|r| r["to"]["sessionId"] == c.as_str()),
                "a stop request for C was recorded: {raw}"
            );
            println!("stop record: {record}");
        }

        // B's transcript: the mail attributed to A, with Reply.
        open_cowork_session(ctx, &b)?;
        ctx.wait_until(
            "the attributed message in B",
            "const h = document.querySelector('[data-testid=\"agent-message-header\"]');
             return !!h && /Message from/.test(h.textContent || '')
               && !!h.querySelector('[data-testid=\"agent-message-reply\"]');",
            Duration::from_secs(40),
        )?;
        let header = ctx.eval_string(
            "return document.querySelector('[data-testid=\"agent-message-header\"]').textContent;",
        )?;
        println!("B header: {header}");
        if stop {
            ctx.wait_until(
                "the stop attribution row in B",
                "return !!document.querySelector('[data-testid=\"session-stop-notice\"]');",
                Duration::from_secs(30),
            )?;
            let notice = ctx.eval_string("const n = document.querySelector('[data-testid=\"session-stop-notice\"]');
                 return JSON.stringify({ text: n.textContent, from: n.getAttribute('data-from-session'),
                   markup: n.querySelectorAll('strong,em,a,img,code').length,
                   stop: !!document.querySelector('[data-testid=\"cowork-stop\"]'),
                   send: !!document.querySelector('[data-test-id=\"send-message-button\"]') });")?;
            println!("B stop notice: {notice}");
            let n: Value = serde_json::from_str(&notice).map_err(|e| Failure(e.to_string()))?;
            let t = n["text"].as_str().unwrap_or_default();
            ensure!(
                t.starts_with("Stopped by ") && t.contains(&format!("reason: {reason}")) && t.contains("(approved in "),
                "the attribution row reads {t:?}"
            );
            ensure!(n["from"] == a.as_str(), "the row names another session: {notice}");
            ensure!(n["markup"] == 0, "the reason was rendered as markup: {notice}");
            ensure!(n["stop"] == false && n["send"] == true, "B's composer still shows a run: {notice}");
            let by = Instant::now() + Duration::from_secs(20);
            loop {
                let persisted = persisted_session(&b)?.map(Value::Object).unwrap_or(Value::Null);
                let turns = persisted["turns"].as_array().cloned().unwrap_or_default();
                if turns.iter().any(|t| t["stopNotice"]["fromSessionId"] == a.as_str() && t["stopNotice"]["reason"] == reason) {
                    break;
                }
                ensure!(Instant::now() < by, "the attribution row never reached disk");
                std::thread::sleep(Duration::from_millis(400));
            }
        } else {
            // Idle delivery: A messages B again once B is idle; it is held.
            ctx.wait_until(
                "B to be idle",
                &format!("return !document.querySelector('[data-testid=\"cowork-session-running-{b}\"]');"),
                Duration::from_secs(60),
            )?;
            script_routes(
                ctx,
                &serde_json::json!([
                    { "match": task_a,
                      "tools": [format!("send_message:{}", serde_json::json!({ "session_id": b, "text": "idle ping from A" }))],
                      "summary": "Sent." }
                ]),
                true,
            )?;
            open_cowork_session(ctx, &a)?;
            let before = model_requests(ctx)?.len();
            send_without_waiting(ctx, &format!("second message {tag}"))?;
            ctx.wait_until(
                "A's second run to finish",
                &format!("return !document.querySelector('[data-testid=\"cowork-session-running-{a}\"]');"),
                Duration::from_secs(60),
            )?;
            let after = model_requests(ctx)?;
            ensure!(after.len() > before, "A's second run sent nothing");
            open_cowork_session(ctx, &b)?;
            ctx.wait_until(
                "the held message in idle B",
                "return [...document.querySelectorAll('[data-testid=\"agent-message-text\"]')]
                   .some(e => (e.textContent || '').includes('idle ping from A'));",
                Duration::from_secs(40),
            )?;
            let buttons = ctx.eval_string(
                "return JSON.stringify([...document.querySelectorAll('button')].map(b => (b.textContent || '').trim()));",
            )?;
            for label in ["Reply", "Let the agent respond", "Dismiss"] {
                ensure!(buttons.contains(label), "the held card has no {label}: {buttons}");
            }
            std::thread::sleep(Duration::from_secs(3));
            ensure!(!running_sessions(ctx)?.contains(&b), "idle B started a run by itself");
            let woke = model_requests(ctx)?
                .iter()
                .any(|r| first_user_text(r).contains(&task_b) && r.to_string().contains("idle ping from A"));
            ensure!(!woke, "the held message reached B's model without its user");
            println!("idle B holds the message with Reply / Let the agent respond / Dismiss");
        }

        // Messaging itself involves no discussion room: the feature must not
        // create any room data. The Rooms route ships on this branch (merged
        // from feature/discussion-rooms), so the presence of a `/rooms` link in
        // the app is expected and is no longer asserted against here; only the
        // absence of any room data written by a messaging run is checked.
        ensure!(!data_folder()?.join("rooms").exists(), "a rooms folder exists in the data folder");
        Ok(())
    })();
    stop_every_run(ctx);
    let _ = script_routes(ctx, &serde_json::json!([]), false);
    let _ = ctx.script_model("plain", &[]);
    result
}

/// Settings search narrows the list, and a result navigates to its own page.
fn scenario_settings_search(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/settings/general")?;
    ctx.wait_until(
        "the settings search box",
        "return !!document.querySelector('input[role=\"combobox\"]')
             || [...document.querySelectorAll('input')].some(i =>
                  /search settings/i.test(i.getAttribute('placeholder') || ''));",
        Duration::from_secs(30),
    )?;

    // The search is a combobox over a settings index, not a filter on the nav:
    // it opens a results listbox. Assert on that.
    let sel = "input[role=\"combobox\"]";
    ctx.type_into(sel, "hardware")?;
    ctx.wait_until(
        "search results",
        "const box = document.getElementById('settings-search-results');
         return !!box && box.querySelectorAll('[role=\"option\"]').length > 0;",
        Duration::from_secs(25),
    )?;
    let hits = ctx.eval(
        "return document.getElementById('settings-search-results')
           .querySelectorAll('[role=\"option\"]').length;",
    )?;
    println!("      results for 'hardware': {hits}");

    // A query that matches nothing must produce no options.
    ctx.type_into(sel, "zzzznotasettinganywhere")?;
    ctx.wait_until(
        "the results to empty for a query nothing matches",
        "const box = document.getElementById('settings-search-results');
         return !box || box.querySelectorAll('[role=\"option\"]').length === 0;",
        Duration::from_secs(25),
    )?;

    // Choosing a result navigates to that individual setting.
    ctx.type_into(sel, "hardware")?;
    ctx.wait_until(
        "search results again",
        "const box = document.getElementById('settings-search-results');
         return !!box && box.querySelectorAll('[role=\"option\"]').length > 0;",
        Duration::from_secs(25),
    )?;
    ctx.eval(
        "document.getElementById('settings-search-results')
           .querySelector('[role=\"option\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the setting's own page",
        "return location.pathname.startsWith('/settings/')
             && !location.pathname.endsWith('/general');",
        Duration::from_secs(25),
    )?;
    let landed = ctx.eval_string("return location.pathname + location.hash;")?;
    println!("      settings search navigated to: {landed}");
    Ok(())
}

/// The Cowork composer carries its own model and reasoning controls.
fn scenario_per_chat_controls(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the composer controls",
        "const names = [...document.querySelectorAll('button')]
           .map(b => (b.getAttribute('aria-label') || b.textContent || '').trim());
         return names.some(n => /select a model|smoke-model/i.test(n))
             && names.some(n => /sampling parameters/i.test(n));",
        Duration::from_secs(30),
    )?;

    // The reasoning/sampling control opens and offers a thinking setting.
    ctx.click_matching("button", "Sampling parameters")?;
    ctx.wait_until(
        "the sampling popover",
        "const t = document.body.textContent || '';
         return /thinking|reasoning|temperature|top[_ ]?p/i.test(t);",
        Duration::from_secs(20),
    )?;
    ctx.describe("sampling-popover")?;
    ctx.eval(
        "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
         return true;",
    )?;
    Ok(())
}

/// The composer reserves space for its control row instead of drawing it over
/// the textarea.
///
/// The row is absolutely positioned at the bottom of the composer, so the box
/// reserves its height. That reserve used to be a constant one row tall, and a
/// row that wrapped grew upward across the input.
fn scenario_composer_footer(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    std::thread::sleep(Duration::from_millis(600));

    let report = ctx.eval_string(
        r#"const ta = document.querySelector('[data-testid="chat-input"]');
           const send = document.querySelector('[data-test-id="send-message-button"]');
           if (!ta || !send) return JSON.stringify({ error: 'missing composer parts' });
           // The control row is the send button's positioned ancestor.
           let footer = send;
           while (footer && getComputedStyle(footer).position !== 'absolute') {
             footer = footer.parentElement;
           }
           if (!footer) return JSON.stringify({ error: 'no positioned control row' });
           const t = ta.getBoundingClientRect();
           const f = footer.getBoundingClientRect();
           return JSON.stringify({
             textareaBottom: Math.round(t.bottom),
             footerTop: Math.round(f.top),
             footerHeight: Math.round(f.height),
             overlap: Math.round(t.bottom - f.top),
           });"#,
    )?;
    println!("      composer footer: {report}");
    let v: Value = serde_json::from_str(&report).unwrap_or(Value::Null);
    ensure!(
        v.get("error").is_none(),
        "could not measure the composer: {report}"
    );
    let overlap = v.get("overlap").and_then(Value::as_i64).unwrap_or(0);
    ensure!(
        overlap <= 1,
        "the control row covers the bottom {overlap}px of the textarea: {report}"
    );
    Ok(())
}

/// `@` references name only what is inside the attached folder. AH-204.
///
/// In the real composer with the fixture attached: the picker offers
/// folder-relative paths and nothing outside the folder; a message naming an
/// in-folder file, a `../` file and an absolute path is sent, and the payload
/// the model received (the prompt snapshot) carries the in-folder file, says
/// the other two were not included, and holds none of the outside file.
fn scenario_at_references_confined(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let outside = ctx.workspace.join("outside-secret.txt");
    std::fs::write(&outside, "OUTSIDE-FOLDER-CONTENT\n").map_err(|e| fail(e.to_string()))?;

    ctx.script_model("plain", &[])?;
    ctx.script_dialog(Some(&ctx.project));
    let opened = open_picker_through_the_pill(ctx);
    let name = ctx
        .project
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let landed = opened.and_then(|()| {
        ctx.wait_until(
            "the project to attach",
            &format!("return document.body.innerText.includes({name:?}) && !{PILL_JS};"),
            Duration::from_secs(45),
        )
    });
    ctx.clear_dialog_script();
    landed?;
    ctx.ensure_model_selected()?;

    // The picker: folder-relative entries only.
    ctx.type_into("[data-testid=\"chat-input\"]", "@ind")?;
    let offered = ctx.wait_until(
        "the picker to offer src/index.ts",
        "return (document.body.innerText || '').includes('src/index.ts');",
        Duration::from_secs(20),
    );
    let picker_text = ctx
        .eval_string(
            "const b = [...document.querySelectorAll('button,li,div')]
               .filter(e => /index\\.ts/.test(e.textContent || '') && e.children.length < 6)
               .map(e => e.textContent).join(' | ');
             return b;",
        )
        .unwrap_or_default();
    offered.map_err(|e| Failure(format!("{} -- picker: {picker_text:?}", e.0)))?;
    ensure!(
        !picker_text.contains(":\\") && !picker_text.contains("Users"),
        "the picker offered an absolute path: {picker_text:?}"
    );

    // A message naming one path inside, one climbing out, one absolute.
    let absolute = outside.to_string_lossy().to_string();
    ctx.type_into(
        "[data-testid=\"chat-input\"]",
        &format!("compare @src/index.ts with @../outside-secret.txt and @{absolute}"),
    )?;
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let prompts = Path::new(&data).join("audit").join("prompts.jsonl");
    let before = std::fs::read_to_string(&prompts).unwrap_or_default().len();
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
        "return document.body.textContent.includes('Hello from the smoke model');",
        Duration::from_secs(90),
    )?;
    let mut sent = String::new();
    for _ in 0..40 {
        let all = std::fs::read_to_string(&prompts).unwrap_or_default();
        sent = all.get(before..).unwrap_or_default().to_string();
        if sent.contains("compare") {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    ensure!(sent.contains("compare"), "no prompt snapshot of the message was recorded");
    ensure!(
        sent.contains("hello ${who}") || sent.contains("hello $") || sent.contains("greet"),
        "the in-folder reference was not included"
    );
    ensure!(
        !sent.contains("OUTSIDE-FOLDER-CONTENT"),
        "a reference outside the attached folder reached the model"
    );
    ensure!(
        sent.matches("was not included").count() >= 2,
        "the refused references were not stated in the message"
    );
    let _ = std::fs::remove_file(&outside);
    Ok(())
}

/// Attach the fixture project through the pill, as a person would.
fn attach_project(ctx: &Ctx) -> ScenarioResult {
    ctx.script_dialog(Some(&ctx.project));
    let opened = open_picker_through_the_pill(ctx);
    let name = ctx
        .project
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let landed = opened.and_then(|()| {
        ctx.wait_until(
            "the project to attach",
            &format!("return document.body.innerText.includes({name:?}) && !{PILL_JS};"),
            Duration::from_secs(45),
        )
    });
    ctx.clear_dialog_script();
    landed
}

/// Press a key in the composer, the way the keyboard does: a keydown on the
/// focused textarea.
fn key_in_composer(ctx: &Ctx, key: &str, alt: bool) -> ScenarioResult {
    ctx.eval(&format!(
        "const el = document.querySelector('[data-testid=\"chat-input\"]');
         el.focus();
         el.dispatchEvent(new KeyboardEvent('keydown',
           {{ key: {key:?}, altKey: {alt}, bubbles: true, cancelable: true }}));
         return true;"
    ))?;
    Ok(())
}

/// The tokens the `@` menu offers, in order.
fn menu_tokens(ctx: &Ctx) -> Result<Vec<String>, Failure> {
    let raw = ctx.eval_string(
        "return JSON.stringify([...document.querySelectorAll(
           '[data-testid=\"reference-menu\"] [role=\"option\"]')].map(o => o.dataset.token));",
    )?;
    serde_json::from_str(&raw).map_err(|e| Failure(format!("menu tokens: {e}: {raw}")))
}

/// Name the file `@query` finds first as `name`, from the keyboard: Alt+A,
/// type the name, submit.
fn save_alias_from_keyboard(
    ctx: &Ctx,
    query: &str,
    target: &str,
    name: &str,
    lines: Option<&str>,
) -> ScenarioResult {
    ctx.type_into("[data-testid=\"chat-input\"]", &format!("@{query}"))?;
    ctx.wait_until(
        "the file to be offered",
        &format!(
            "return !!document.querySelector('[data-testid=\"reference-menu\"] [role=\"option\"][data-token={target:?}]');"
        ),
        Duration::from_secs(20),
    )?;
    let first = menu_tokens(ctx)?;
    ensure!(
        first.first().map(String::as_str) == Some(target),
        "{target} is not the active row: {first:?}"
    );
    key_in_composer(ctx, "a", true)?;
    ctx.wait_until(
        "the alias name field",
        "return document.activeElement && document.activeElement.dataset.testid === 'alias-name';",
        Duration::from_secs(10),
    )?;
    ctx.eval(&format!(
        "const el = document.querySelector('[data-testid=\"alias-name\"]');
         const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
         set.call(el, {name:?});
         el.dispatchEvent(new Event('input', {{ bubbles: true }}));
         return true;"
    ))?;
    if let Some(lines) = lines {
        ctx.eval(&format!(
            "const el = document.querySelector('[data-testid=\"alias-lines\"]');
             const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
             set.call(el, {lines:?});
             el.dispatchEvent(new Event('input', {{ bubbles: true }}));
             return true;"
        ))?;
    }
    ctx.eval("document.querySelector('[data-testid=\"alias-form\"]').requestSubmit(); return true;")?;
    let saved_as = match lines {
        Some(lines) if lines.contains('-') => format!("{target}:{lines}"),
        Some(lines) => format!("{target}:{lines}-{lines}"),
        None => target.to_string(),
    };
    ctx.wait_until(
        "the alias to be saved and announced",
        &format!(
            "const s = document.querySelector('[data-testid=\"reference-status\"]');
             return !!s && s.textContent.includes('Saved @alias:{name} for {saved_as}');"
        ),
        Duration::from_secs(10),
    )?;
    ctx.wait_until(
        "focus to return to the composer",
        "return document.activeElement && document.activeElement.dataset.testid === 'chat-input';",
        Duration::from_secs(5),
    )
}

/// Send `text` from the composer and return what the model was sent.
fn send_and_capture(ctx: &Ctx, text: &str, marker: &str) -> Result<String, Failure> {
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let prompts = Path::new(&data).join("audit").join("prompts.jsonl");
    let before = std::fs::read_to_string(&prompts).unwrap_or_default().len();
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
    let mut sent = String::new();
    for _ in 0..240 {
        let all = std::fs::read_to_string(&prompts).unwrap_or_default();
        sent = all.get(before..).unwrap_or_default().to_string();
        if sent.contains(marker) {
            return Ok(sent);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    bail!("no prompt snapshot containing {marker:?} was recorded; got: {}", &sent[..sent.len().min(400)])
}

/// One `@` menu for files, skills, saved agents and aliases (AH-204/AH-205),
/// driven by the keyboard alone, in the real WebView.
fn scenario_unified_at_menu(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    // One of each kind for the menu to offer: a skill in the folder, and a
    // saved agent in Jan's own store.
    let skills = ctx.project.join(".jan").join("agent").join("skills");
    std::fs::create_dir_all(&skills).map_err(|e| fail(e.to_string()))?;
    std::fs::write(
        skills.join("reviewer.md"),
        "---\nname: reviewer\ndescription: Reviews a diff\n---\nRead the diff and say what is wrong.\n",
    )
    .map_err(|e| fail(e.to_string()))?;
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let agents = Path::new(&data).join("agent-workspace").join("subagents");
    std::fs::create_dir_all(&agents).map_err(|e| fail(e.to_string()))?;
    std::fs::write(
        agents.join("review-bot.toml"),
        "name = \"review-bot\"\ndescription = \"Second opinion on a change\"\nsystem_prompt = \"Review.\"\n",
    )
    .map_err(|e| fail(e.to_string()))?;

    ctx.script_model("plain", &[])?;
    attach_project(ctx)?;
    ctx.ensure_model_selected()?;

    // One list, every kind, and no absolute path.
    ctx.type_into("[data-testid=\"chat-input\"]", "@rev")?;
    ctx.wait_until(
        "the skill to be offered",
        "return !!document.querySelector('[data-testid=\"reference-menu\"] [data-token=\"skill:reviewer\"]');",
        Duration::from_secs(20),
    )?;
    let tokens = menu_tokens(ctx)?;
    ensure!(
        tokens.iter().any(|t| t == "agent:review-bot"),
        "the saved agent is not in the menu: {tokens:?}"
    );
    ensure!(
        !tokens.iter().any(|t| t.contains(":\\") || t.starts_with('/')),
        "the menu offered an absolute path: {tokens:?}"
    );

    // Keyboard alone: the arrow moves the active row, Enter inserts it.
    let active = |ctx: &Ctx| {
        ctx.eval_string(
            "const id = document.querySelector('[data-testid=\"chat-input\"]').getAttribute('aria-activedescendant');
             const el = id && document.getElementById(id);
             return el ? el.dataset.token : '';",
        )
    };
    let first = active(ctx)?;
    key_in_composer(ctx, "ArrowDown", false)?;
    let second = active(ctx)?;
    ensure!(
        !second.is_empty() && second != first,
        "ArrowDown did not move the active row ({first:?} -> {second:?})"
    );
    key_in_composer(ctx, "Enter", false)?;
    ctx.wait_until(
        "the reference to be inserted rather than sent",
        &format!(
            "return document.querySelector('[data-testid=\"chat-input\"]').value.trim() === {:?};",
            format!("@{second}")
        ),
        Duration::from_secs(5),
    )?;

    // Name a file from the keyboard, and find it offered back.
    save_alias_from_keyboard(ctx, "ind", "src/index.ts", "entry", None)?;
    ctx.type_into("[data-testid=\"chat-input\"]", "@alias:")?;
    ctx.wait_until(
        "the alias to be offered",
        "return !!document.querySelector('[data-testid=\"reference-menu\"] [data-token=\"alias:entry\"]');",
        Duration::from_secs(10),
    )?;

    // A named selection: line 1 of the file, and nothing else of it.
    save_alias_from_keyboard(ctx, "ind", "src/index.ts", "firstline", Some("1"))?;
    let sent = send_and_capture(ctx, "quote @alias:firstline please", "quote")?;
    ensure!(
        sent.contains("src/index.ts (lines 1-1)"),
        "the selection alias was not resolved to its lines"
    );
    ensure!(
        !sent.contains("export default greet"),
        "the selection alias carried lines outside the selection"
    );
    ctx.wait_until(
        "the reply to the selection message",
        "return document.body.textContent.includes('Hello from the smoke model');",
        Duration::from_secs(90),
    )?;

    // Used: the alias is resolved to the file's content, and the agent is
    // named with how to reach it.
    let sent = send_and_capture(ctx, "summarize @alias:entry then ask @agent:review-bot", "summarize")?;
    ensure!(
        sent.contains("@alias:entry is src/index.ts"),
        "the alias was not resolved to its file"
    );
    ensure!(
        sent.contains("hello ${who}") || sent.contains("greet"),
        "the aliased file's content was not included"
    );
    ensure!(
        sent.contains("call the task tool with agent \\\"review-bot\\\"")
            || sent.contains("call the task tool with agent \"review-bot\""),
        "the agent reference did not say how to reach it"
    );
    Ok(())
}

/// Set a text field's value the way typing does, so React sees the change.
fn set_field(ctx: &Ctx, selector: &str, value: &str) -> ScenarioResult {
    let ok = ctx.eval_bool(&format!(
        "const el = document.querySelector({selector:?});
         if (!el) return false;
         const proto = el instanceof HTMLTextAreaElement
           ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
         Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, {value:?});
         el.dispatchEvent(new Event('input', {{ bubbles: true }}));
         return true;"
    ))?;
    ensure!(ok, "{selector} is not on the page");
    Ok(())
}

/// Open the project description dialog and wait for its draft.
fn open_project_init(ctx: &Ctx) -> Result<String, Failure> {
    ctx.wait_until(
        "the offer to describe the project",
        "return !!document.querySelector('[data-testid=\"project-init-open\"]');",
        Duration::from_secs(30),
    )?;
    ctx.eval("document.querySelector('[data-testid=\"project-init-open\"]').click(); return true;")?;
    ctx.wait_until(
        "the proposed FLINT.md",
        "const t = document.querySelector('[data-testid=\"project-init-text\"]');
         return !!t && t.value.length > 0;",
        Duration::from_secs(30),
    )?;
    ctx.eval_string("return document.querySelector('[data-testid=\"project-init-text\"]').value;")
}

/// AH-209 through the real UI: survey, edit, accept; nothing written before.
fn scenario_project_init(ctx: &Ctx) -> ScenarioResult {
    let flint_md = ctx.project.join("FLINT.md");
    let _ = std::fs::remove_file(&flint_md);
    // A legacy JAN.md would make accept refuse, so start from neither file.
    let _ = std::fs::remove_file(ctx.project.join("JAN.md"));
    ctx.script_model("plain", &[])?;
    attach_project(ctx)?;

    let draft = open_project_init(ctx)?;
    ensure!(
        draft.starts_with("# cowork-smoke-fixture"),
        "the draft is not named from package.json: {draft:?}"
    );
    // The README as it is on disk -- the fixture edits it in the working tree
    // after committing, and the survey reads the working tree.
    let readme = std::fs::read_to_string(ctx.project.join("README.md")).unwrap_or_default();
    let first_paragraph = readme
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .unwrap_or_default()
        .to_string();
    ensure!(
        !first_paragraph.is_empty() && draft.contains(&first_paragraph),
        "the draft does not carry the README's description ({first_paragraph:?}): {draft:?}"
    );
    ensure!(
        !draft.contains("SMOKE_TOKEN"),
        "the draft carries the content of .env"
    );
    ensure!(
        draft.contains("TypeScript"),
        "the draft does not say what the project is written in: {draft:?}"
    );
    let not_read = ctx.eval_string(
        "const l = document.querySelector('[data-testid=\"project-init-not-read\"]');
         return l ? l.textContent : '';",
    )?;
    ensure!(
        not_read.contains("skipped by design"),
        "the dialog does not say what the survey did not read: {not_read:?}"
    );
    ensure!(!flint_md.exists(), "surveying wrote FLINT.md");

    let edited = format!("{draft}- Checked by the smoke run.\n");
    set_field(ctx, "[data-testid=\"project-init-text\"]", &edited)?;
    ctx.eval("document.querySelector('[data-testid=\"project-init-accept\"]').click(); return true;")?;
    ctx.wait_until(
        "the write to be announced",
        "const s = document.querySelector('[data-testid=\"project-init-status\"]');
         return !!s && s.textContent.includes('Wrote FLINT.md');",
        Duration::from_secs(20),
    )?;
    let written = std::fs::read_to_string(&flint_md).map_err(|e| Failure(format!("FLINT.md: {e}")))?;
    ensure!(written == edited, "FLINT.md is not exactly the accepted text: {written:?}");
    ctx.wait_until(
        "the offer to go once FLINT.md exists",
        "return !document.querySelector('[data-testid=\"project-init-open\"]');",
        Duration::from_secs(20),
    )?;

    // Refusal: a second acceptance over the file is refused and changes nothing.
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let project = ctx.project.to_string_lossy().to_string();
    let (ok, refusal) = ipc(
        ctx,
        "plugin:agent-tools|project_init_accept",
        &format!("{{ dataFolder: {data:?}, root: {project:?}, content: 'OVERWRITTEN', overwrite: false }}"),
    )?;
    ensure!(!ok, "a second FLINT.md was written over the first");
    ensure!(
        refusal.to_string().contains("already has a FLINT.md"),
        "the refusal did not say why: {refusal}"
    );
    ensure!(
        std::fs::read_to_string(&flint_md).unwrap_or_default() == edited,
        "the refused write changed FLINT.md"
    );
    let _ = std::fs::remove_file(&flint_md);
    Ok(())
}

const DRAFT_MARKER: &str = "project-init-phase-1.txt";
const DRAFT_TEXT: &str = "DRAFT-KEPT-ACROSS-RESTART";

/// Phase one: edit a draft, close the dialog without accepting, and exit.
fn scenario_project_init_draft_first(ctx: &Ctx) -> ScenarioResult {
    let _ = std::fs::remove_file(ctx.project.join("FLINT.md"));
    ctx.script_model("plain", &[])?;
    attach_project(ctx)?;
    let draft = open_project_init(ctx)?;
    set_field(
        ctx,
        "[data-testid=\"project-init-text\"]",
        &format!("{draft}{DRAFT_TEXT}\n"),
    )?;
    ctx.eval(
        "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         const a = document.activeElement;
         if (a) a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         return true;",
    )?;
    ctx.wait_until(
        "the dialog to close",
        "return !document.querySelector('[data-testid=\"project-init-dialog\"]');",
        Duration::from_secs(10),
    )?;
    ensure!(!ctx.project.join("FLINT.md").exists(), "closing the dialog wrote FLINT.md");
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let settings = Path::new(&data).join("settings.json");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let raw = std::fs::read_to_string(&settings).unwrap_or_default();
        if raw.contains("project-init-drafts") && raw.contains(DRAFT_TEXT) {
            break;
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "the edited draft never reached settings.json"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    std::fs::write(ctx.workspace.join(DRAFT_MARKER), "edited").map_err(|e| Failure(e.to_string()))
}

/// Phase two, a new process: the edit is still there, and discarding it
/// writes nothing.
fn scenario_project_init_draft_second(ctx: &Ctx) -> ScenarioResult {
    ensure!(
        ctx.workspace.join(DRAFT_MARKER).exists(),
        "phase one did not run against this workspace"
    );
    ctx.script_model("plain", &[])?;
    attach_project(ctx)?;
    ctx.wait_until(
        "the offer to continue the draft",
        "const b = document.querySelector('[data-testid=\"project-init-open\"]');
         return !!b && b.textContent.includes('Continue');",
        Duration::from_secs(30),
    )?;
    let draft = open_project_init(ctx)?;
    ensure!(
        draft.contains(DRAFT_TEXT),
        "the draft edited before the restart did not come back: {draft:?}"
    );
    ctx.eval("document.querySelector('[data-testid=\"project-init-discard\"]').click(); return true;")?;
    ctx.wait_until(
        "the discard to be announced",
        "const s = document.querySelector('[data-testid=\"project-init-status\"]');
         return !!s && s.textContent.includes('Nothing was written');",
        Duration::from_secs(10),
    )?;
    ensure!(!ctx.project.join("FLINT.md").exists(), "discarding wrote FLINT.md");
    Ok(())
}

const ALIAS_MARKER: &str = "alias-phase-1.txt";

/// Phase one: save an alias from the keyboard, then let the process exit.
fn scenario_alias_persist_first(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    attach_project(ctx)?;
    ctx.ensure_model_selected()?;
    save_alias_from_keyboard(ctx, "ind", "src/index.ts", "persisted", None)?;
    // Saved means on disk: the settings write is debounced, and the first run
    // of this pair exited inside that window, before the write had left the
    // WebView. A person does not quit within half a second of saving; this
    // waits for what they would have waited for.
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let settings = Path::new(&data).join("settings.json");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let raw = std::fs::read_to_string(&settings).unwrap_or_default();
        if raw.contains("reference-aliases") && raw.contains("persisted") {
            break;
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "the alias never reached settings.json"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    std::fs::write(ctx.workspace.join(ALIAS_MARKER), "saved")
        .map_err(|e| Failure(e.to_string()))
}

/// Phase two, a new process on the same data folder: the alias is offered
/// again and resolves to the same file.
fn scenario_alias_persist_second(ctx: &Ctx) -> ScenarioResult {
    ensure!(
        ctx.workspace.join(ALIAS_MARKER).exists(),
        "phase one did not run against this workspace"
    );
    ctx.script_model("plain", &[])?;
    attach_project(ctx)?;
    ctx.ensure_model_selected()?;
    ctx.type_into("[data-testid=\"chat-input\"]", "@alias:")?;
    ctx.wait_until(
        "the alias saved before the restart to be offered",
        "return !!document.querySelector('[data-testid=\"reference-menu\"] [data-token=\"alias:persisted\"]');",
        Duration::from_secs(20),
    )?;
    let sent = send_and_capture(ctx, "after the restart use @alias:persisted", "after the restart")?;
    ensure!(
        sent.contains("@alias:persisted is src/index.ts"),
        "the alias did not resolve after the restart"
    );
    Ok(())
}

/// The first file named `name` under `dir`, depth first.
fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file(&path, name) {
                return Some(found);
            }
        } else if path.file_name().is_some_and(|n| n == name) {
            return Some(path);
        }
    }
    None
}

const RESTART_MARKER: &str = "restart-phase-1.txt";
const UNDO_FILE: &str = "persist-undo.txt";

/// Open the Changes rail and wait for the per-turn undo list.
fn open_turn_undo(ctx: &Ctx) -> ScenarioResult {
    // Waited for: right after a navigation the rail is not drawn yet.
    ctx.wait_until(
        "the Changes rail button",
        r#"const b = [...document.querySelectorAll('button')].find(x =>
             /^Changes$|changed/i.test(x.getAttribute('aria-label') || ''));
           if (!b) return false;
           if (b.getAttribute('aria-pressed') !== 'true') b.click();
           return true;"#,
        Duration::from_secs(30),
    )?;
    ctx.wait_until(
        "the per-turn undo list",
        "return !!document.querySelector('[data-testid=\"turn-undo-row\"]');",
        Duration::from_secs(30),
    )
}

/// Phase one of a real restart (AH-207, AH-202): change state the app must
/// keep, then let the process exit.
///
/// Rebinds the command palette to Ctrl+Alt+Y, and runs a Cowork turn whose
/// `write` creates a file, then undoes that turn from the Changes panel -- so
/// the second phase can check both the binding and the undo position.
fn scenario_restart_persist_first(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    // The binding.
    ctx.goto("/settings/shortcuts")?;
    ctx.wait_until(
        "the palette's shortcut row",
        "return !!document.querySelector('[data-testid=\"rebind-commandPalette\"]');",
        Duration::from_secs(30),
    )?;
    let row = "document.querySelector('[data-testid=\"rebind-commandPalette\"]')";
    ctx.eval(&format!(
        "{row}.querySelector('[data-testid=\"rebind-change\"]').click(); return true;"
    ))?;
    ctx.wait_until(
        "recording to start",
        &format!("return !!{row}.querySelector('[data-testid=\"rebind-recording\"]');"),
        Duration::from_secs(10),
    )?;
    press(ctx, "y", true, false, true)?;
    ctx.wait_until(
        "the new binding to be accepted",
        &format!("return !!{row}.querySelector('[data-testid=\"rebind-reset\"]');"),
        Duration::from_secs(10),
    )?;

    // A turn that writes a file, undone from the turn that made it.
    let write_call = format!(
        "write:{}",
        serde_json::json!({ "path": UNDO_FILE, "content": "written by the turn\n" })
    );
    ctx.script_model("tools", &[write_call.as_str()])?;
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.ensure_model_selected()?;
    ctx.eval(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /new session/i.test((x.textContent || '').trim()));
         if (b) b.click();
         return true;",
    )?;
    ctx.settle();
    ctx.type_into("[data-testid=\"chat-input\"]", "write the persistence file")?;
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
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    loop {
        let _ = ctx.eval(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /^allow once$/i.test((x.textContent || '').trim()));
             if (b) b.click();
             return true;",
        );
        let started = ctx
            .eval_bool("return !!document.querySelector('[data-testid=\"tool-activity-item\"]');")
            .unwrap_or(false);
        let idle = ctx
            .eval_bool("return !!document.querySelector('[data-test-id=\"send-message-button\"]');")
            .unwrap_or(false);
        if started && idle {
            break;
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "the run did not finish (tool item shown: {started}, composer idle: {idle}); {}",
            run_state(ctx)
        );
        std::thread::sleep(Duration::from_millis(700));
    }
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let written = find_file(Path::new(&data), UNDO_FILE)
        .ok_or_else(|| fail("the turn's write is not on disk".into()))?;
    ensure!(
        std::fs::read_to_string(&written).unwrap_or_default() == "written by the turn\n",
        "the turn wrote something else"
    );

    open_turn_undo(ctx)?;
    ctx.eval(
        "document.querySelector('[data-testid=\"turn-undo-row\"][data-state=\"applied\"] [data-testid=\"turn-undo-button\"]').click();
         return true;",
    )?;
    let undone = ctx.wait_until(
        "the undo to be reported",
        "return !!document.querySelector('[data-testid=\"turn-undo-row\"][data-state=\"undone\"]');",
        Duration::from_secs(30),
    );
    if undone.is_err() {
        let status = ctx
            .eval_string(
                "const s = document.querySelector('[data-testid=\"turn-undo-status\"]');
                 return s ? s.textContent : '(no status)';",
            )
            .unwrap_or_default();
        bail!("the undo did not take effect; the panel said: {status:?}");
    }
    ensure!(!written.exists(), "undo did not remove the file the turn created");
    std::fs::write(ctx.workspace.join(RESTART_MARKER), written.to_string_lossy().as_bytes())
        .map_err(|e| fail(e.to_string()))?;
    Ok(())
}

/// Phase two, in a new process on the same data folder and WebView profile:
/// the binding and the undo position came back, and both still work.
fn scenario_restart_persist_second(ctx: &Ctx) -> ScenarioResult {
    let marker = std::fs::read_to_string(ctx.workspace.join(RESTART_MARKER))
        .map_err(|_| Failure("phase one did not run against this workspace".into()))?;
    let written = PathBuf::from(marker.trim());
    ensure!(!written.exists(), "the undone file came back on its own");

    // The binding: the old chord does nothing, the new one opens the palette.
    let palette_open =
        "return !!document.querySelector('[data-testid=\"command-palette\"]');";
    ctx.goto("/")?;
    ctx.settle();
    press(ctx, "P", true, true, false)?;
    std::thread::sleep(Duration::from_millis(800));
    ensure!(
        !ctx.eval_bool(palette_open)?,
        "after a restart the default chord opens the palette again: the binding was lost"
    );
    press(ctx, "y", true, false, true)?;
    ctx.wait_until(
        "the restored binding to open the palette",
        palette_open,
        Duration::from_secs(10),
    )?;
    ctx.eval(
        "document.querySelector('[data-testid=\"command-palette-input\"]')
           .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         return true;",
    )?;
    ctx.settle();

    // The undo position: the turn is still undone, and redo still works.
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    open_turn_undo(ctx)?;
    ctx.wait_until(
        "the undone turn to be listed as undone",
        "return !!document.querySelector('[data-testid=\"turn-undo-row\"][data-state=\"undone\"] [data-testid=\"turn-redo\"]');",
        Duration::from_secs(20),
    )?;
    ctx.eval(
        "document.querySelector('[data-testid=\"turn-undo-row\"][data-state=\"undone\"] [data-testid=\"turn-redo\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the redo to be reported",
        "return !!document.querySelector('[data-testid=\"turn-undo-row\"][data-state=\"applied\"]');",
        Duration::from_secs(30),
    )?;
    ensure!(
        std::fs::read_to_string(&written).unwrap_or_default() == "written by the turn\n",
        "redo after the restart did not put the file back"
    );

    // Leave the binding as it was.
    ctx.goto("/settings/shortcuts")?;
    ctx.wait_until(
        "the reset button",
        "return !!document.querySelector('[data-testid=\"rebind-commandPalette\"] [data-testid=\"rebind-reset\"]');",
        Duration::from_secs(30),
    )?;
    ctx.eval(
        "document.querySelector('[data-testid=\"rebind-commandPalette\"] [data-testid=\"rebind-reset\"]').click();
         return true;",
    )?;
    Ok(())
}
