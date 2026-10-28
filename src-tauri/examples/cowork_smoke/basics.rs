/// The frontend bundle is loaded, React has mounted, and IPC round-trips.
fn scenario_app_startup(ctx: &Ctx) -> ScenarioResult {
    ctx.wait_until(
        "React root to mount",
        "return !!document.querySelector('#root') && document.querySelector('#root').children.length > 0;",
        Duration::from_secs(60),
    )?;

    // Real Tauri IPC, not a browser shim: ask the backend for its configuration.
    let ipc_ok = ctx.eval_bool(
        "const c = await window.__TAURI_INTERNALS__.invoke('get_app_configurations');
         return !!c && typeof c.data_folder === 'string';",
    )?;
    ensure!(ipc_ok, "get_app_configurations did not round-trip over IPC");

    let title = ctx.eval_string("return document.title;")?;
    ensure!(!title.is_empty(), "document.title was empty");
    Ok(())
}

/// The chat composer accepts text and arms its send control.
fn scenario_chat_composer(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/")?;
    ctx.wait_until(
        "chat composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;

    let disabled_before = ctx.eval_bool(
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !b || b.disabled === true;",
    )?;

    ctx.type_into(
        "[data-testid=\"chat-input\"]",
        "cowork smoke composer probe",
    )?;

    let value = ctx.eval_string(
        "return document.querySelector('[data-testid=\"chat-input\"]').value || '';",
    )?;
    ensure!(
        value.contains("cowork smoke composer probe"),
        "composer did not accept typed text (value was {value:?})"
    );

    ctx.wait_until(
        "send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(10),
    )?;

    // Leave the composer clean for later scenarios.
    ctx.type_into("[data-testid=\"chat-input\"]", "")?;
    let _ = disabled_before;
    Ok(())
}

/// The Cowork route mounts and its panels reach the backend over real IPC.
fn scenario_cowork_navigation(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "cowork surface to render",
        "return document.body.innerText.trim().length > 0
             && document.querySelectorAll('button').length > 0;",
        Duration::from_secs(30),
    )?;
    let path = ctx.eval_string("return window.location.pathname;")?;
    ensure!(
        path.starts_with("/cowork"),
        "route was {path:?}, not /cowork"
    );
    Ok(())
}

/// An individual settings page mounts (not the router's Not Found fallback).
fn scenario_settings_navigation(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/settings/general")?;
    ctx.wait_until(
        "settings/general content",
        "return location.pathname.startsWith('/settings/general')
             && !document.body.innerText.includes('Not Found')
             && document.body.innerText.trim().length > 40;",
        Duration::from_secs(30),
    )?;

    // The bare /settings path has no route; assert the app says so rather than
    // silently rendering an empty shell, so a future regression is visible.
    ctx.goto("/settings")?;
    std::thread::sleep(Duration::from_millis(600));
    let not_found = ctx.eval_bool("return document.body.innerText.includes('Not Found');")?;
    ensure!(
        not_found,
        "/settings changed behaviour: it no longer renders Not Found"
    );
    Ok(())
}

/// The Cowork right-hand rails (Code / Preview / Changes / Activity) all mount.
fn scenario_cowork_rails(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    // The rails are icon buttons: their names live in aria-label, not innerText.
    ctx.wait_until(
        "cowork rails",
        "const names = [...document.querySelectorAll('button')]
           .map(b => (b.getAttribute('aria-label') || b.textContent || '').trim());
         return ['Code','Preview','Changes','Activity'].every(r => names.includes(r));",
        Duration::from_secs(30),
    )?;

    for rail in ["Code", "Preview", "Changes", "Activity"] {
        // Match the rail exactly: "Code" must not select "Open code folder".
        ctx.click_rail(rail)?;
        let panel = ctx.eval_string("return document.body.innerText;")?;
        ensure!(
            !panel.trim().is_empty(),
            "rail {rail} produced an empty surface"
        );
    }
    Ok(())
}

/// The temporary-chat control toggles and reports its state.
fn scenario_temporary_chat(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/")?;
    ctx.wait_until(
        "temporary chat control",
        "return [...document.querySelectorAll('button')].some(b =>
            (b.getAttribute('aria-label') || b.textContent || '').trim() === 'Temporary Chat');",
        Duration::from_secs(30),
    )?;

    let before = ctx.eval_string(
        "const b = [...document.querySelectorAll('button')].find(b =>
            (b.getAttribute('aria-label') || b.textContent || '').trim() === 'Temporary Chat');
         return JSON.stringify({ pressed: b.getAttribute('aria-pressed'), cls: b.className });",
    )?;
    ctx.click_matching("button", "Temporary Chat")?;
    std::thread::sleep(Duration::from_millis(800));
    let after = ctx.eval_string(
        "const b = [...document.querySelectorAll('button')].find(b =>
            (b.getAttribute('aria-label') || b.textContent || '').trim() === 'Temporary Chat');
         if (!b) return 'GONE';
         return JSON.stringify({ pressed: b.getAttribute('aria-pressed'), cls: b.className });",
    )?;
    println!("      temporary-chat before={before}\n      temporary-chat after={after}");
    ensure!(
        before != after,
        "Temporary Chat control did not change state when clicked (state stayed {before})"
    );
    // Restore.
    if after != "GONE" {
        let _ = ctx.click_matching("button", "Temporary Chat");
    }
    Ok(())
}

/// The model picker opens and its search narrows the list.
fn scenario_model_picker(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/")?;
    // The trigger's label carries the current model, so match on the control's
    // role rather than a fixed string, and retry: a stray open popover from an
    // earlier scenario can swallow the first click.
    let open_js = "return [...document.querySelectorAll('input')].some(i =>
            /search|find|model/i.test(i.getAttribute('placeholder') || ''));";
    let mut opened = false;
    for _ in 0..3 {
        ctx.eval(
            "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
             return true;",
        )?;
        std::thread::sleep(Duration::from_millis(400));
        let clicked = ctx.eval_bool(
            "const b = [...document.querySelectorAll('button')].find(x =>
               // Once a model is selected the trigger carries its name, so
               // matching the placeholder alone stops working.
               /select a model|smoke-model|smoke-alt/i.test(
                 (x.getAttribute('aria-label') || '') + ' ' + (x.textContent || ''))
               || x.closest('[data-model-trigger]'));
             if (!b) return false; b.click(); return true;",
        )?;
        if !clicked {
            continue;
        }
        if ctx
            .wait_until("the model picker to open", open_js, Duration::from_secs(8))
            .is_ok()
        {
            opened = true;
            break;
        }
    }
    ensure!(opened, "the model picker never exposed its search input");
    ctx.describe("model-picker")?;
    // Close the dialog deliberately: a left-open modal blocks the next
    // scenario's navigation.
    ctx.eval(
        "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
         const close = document.querySelector('[role=\"dialog\"] button[aria-label*=\"lose\"]');
         if (close) close.click();
         return true;",
    )?;
    ctx.wait_until(
        "model picker to close",
        "return !document.querySelector('[role=\"dialog\"][data-state=\"open\"]');",
        Duration::from_secs(15),
    )?;
    Ok(())
}

/// The MCP settings page lists configured servers with lifecycle controls.
fn scenario_mcp_settings(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/settings/mcp-servers")?;
    ctx.wait_until(
        "MCP server list",
        "const t = document.body.innerText;
         return t.includes('MCP Servers') && t.includes('Transport:');",
        Duration::from_secs(30),
    )?;
    let switches = ctx.eval(
        "return document.querySelectorAll('[role=\"switch\"],button[role=\"switch\"]').length;",
    )?;
    println!("      mcp switches found: {switches}");
    ensure!(
        switches.as_u64().unwrap_or(0) > 0,
        "no MCP enable/disable switches rendered"
    );
    Ok(())
}

/// AH-076: the shared compaction policy, edited in Settings > Agent Tools.
///
/// The change goes through the UI control, is written by the backend, and is
/// read back from the backend -- not from React state -- so what is asserted is
/// what the CLI and the agent loop will read too.
fn scenario_compaction_policy_set(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/settings/agent-tools")?;
    ctx.wait_until(
        "the compaction settings",
        "return !!document.querySelector('select[aria-label=\"Strategy\"]');",
        Duration::from_secs(30),
    )?;
    let changed = ctx.eval_bool(
        "const s = document.querySelector('select[aria-label=\"Strategy\"]');
         const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
         setter.call(s, 'trim');
         s.dispatchEvent(new Event('change', { bubbles: true }));
         return true;",
    )?;
    ensure!(changed, "the strategy control was not present");
    let keep = ctx.eval_bool(
        "const i = document.querySelector('input[aria-label=\"Recent messages kept\"]');
         if (!i) return false;
         const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
         i.focus(); setter.call(i, '12');
         i.dispatchEvent(new Event('input', { bubbles: true }));
         i.dispatchEvent(new Event('change', { bubbles: true }));
         i.blur(); i.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
         return true;",
    )?;
    ensure!(keep, "the keep-recent control was not present");
    ctx.wait_until(
        "the backend's policy to carry both changes",
        "return window.__TAURI_INTERNALS__.invoke('get_compaction_policy', { project: null })
           .then(p => p.strategy === 'trim' && p.keepRecent === 12 && p.origins.keepRecent === 'user');",
        Duration::from_secs(20),
    )?;
    // An out-of-range value is the backend's refusal, shown, and not saved.
    ctx.eval_bool(
        "const i = document.querySelector('input[aria-label=\"Recent messages kept\"]');
         const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
         i.focus(); setter.call(i, '1');
         i.dispatchEvent(new Event('input', { bubbles: true }));
         i.blur(); i.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
         return true;",
    )?;
    ctx.wait_until(
        "the refusal to be shown",
        "return [...document.querySelectorAll('[role=\"alert\"]')].some(a => a.innerText.includes('keepRecent must be between'));",
        Duration::from_secs(20),
    )?;
    let still = ctx.eval_bool(
        "return window.__TAURI_INTERNALS__.invoke('get_compaction_policy', { project: null })
           .then(p => p.keepRecent === 12);",
    )?;
    ensure!(still, "a refused value changed the saved policy");
    Ok(())
}

/// AH-076, second half: the policy the first half saved is what a fresh
/// process reads and shows.
fn scenario_compaction_policy_after_restart(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/settings/agent-tools")?;
    ctx.wait_until(
        "the saved policy shown after a restart",
        "const s = document.querySelector('select[aria-label=\"Strategy\"]');
         const i = document.querySelector('input[aria-label=\"Recent messages kept\"]');
         return !!s && !!i && s.value === 'trim' && i.value === '12';",
        Duration::from_secs(30),
    )?;
    Ok(())
}

/// AH-140: a server's own log, opened from its row in MCP settings.
///
/// The active web-search fixture prints one stderr line with a
/// credential-shaped value when it starts. The dialog must show that line,
/// with the value redacted, for that server -- read from the server's own log
/// file, not the application log.
fn scenario_mcp_server_log(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/settings/mcp-servers")?;
    ctx.wait_until(
        "MCP server list",
        "return document.body.innerText.includes('MCP Servers');",
        Duration::from_secs(30),
    )?;
    let label = format!("Log for MCP server {SMOKE_MCP_WEB_SEARCH}");
    // The server starts asynchronously; its line may take a moment to land.
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        ctx.click_matching("button", &label)?;
        let shown = ctx.eval_string(
            "const d = document.querySelector('[role=\"dialog\"]');
             return d ? d.innerText : '';",
        )?;
        if shown.contains("smoke web search ready") {
            println!("      dialog: {}", shown.replace('\n', " | "));
            ensure!(
                !shown.contains("AAAABBBB"),
                "the credential was shown verbatim: {shown}"
            );
            ensure!(
                shown.to_lowercase().contains("[redacted]"),
                "the credential was not marked redacted: {shown}"
            );
            ensure!(
                shown.contains(&label),
                "the dialog is not titled for that server: {shown}"
            );
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "the server's line never appeared in its log dialog; last dialog text: {shown}"
        );
        ctx.eval_detached(
            "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));",
        )?;
        std::thread::sleep(Duration::from_millis(1500));
    }
    // A server that has printed nothing says so, rather than showing an empty box.
    ctx.eval_detached(
        "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));",
    )?;
    std::thread::sleep(Duration::from_millis(500));
    let quiet = format!("Log for MCP server {SMOKE_MCP_USER_SERVER}");
    ctx.click_matching("button", &quiet)?;
    ctx.wait_until(
        "the empty-log message for a server that never ran",
        "const d = document.querySelector('[role=\"dialog\"]');
         return !!d && d.innerText.includes('has not printed anything');",
        Duration::from_secs(15),
    )?;
    Ok(())
}

/// Every control in the title-bar band must actually receive a click.
///
/// A full-width `data-tauri-drag-region` sheet used to cover the top 48px of
/// the window, so pressing the model selector or the temporary-chat button
/// dragged the window instead. Scripted `.click()` bypasses hit-testing, so
/// only a hit test finds this: ask the document what is at each control's
/// centre.
fn scenario_header_hit_test(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/")?;
    ctx.wait_until(
        "the header",
        "return document.querySelectorAll('button').length > 2;",
        Duration::from_secs(30),
    )?;
    std::thread::sleep(Duration::from_millis(600));

    let report = ctx.eval_string(
        r#"const blocked = [];
           for (const b of document.querySelectorAll('button')) {
             const r = b.getBoundingClientRect();
             // Only the title-bar band, and only what is actually on screen.
             if (r.width === 0 || r.height === 0 || r.top > 60) continue;
             const x = Math.round(r.left + r.width / 2);
             const y = Math.round(r.top + r.height / 2);
             const hit = document.elementFromPoint(x, y);
             if (!hit || (hit !== b && !b.contains(hit))) {
               blocked.push({
                 control: (b.getAttribute('aria-label') || b.textContent || '?')
                   .trim().slice(0, 40),
                 covered_by: hit ? (hit.getAttribute('aria-label')
                   || hit.className || hit.tagName).toString().slice(0, 80) : 'nothing',
               });
             }
           }
           return JSON.stringify({ blocked });"#,
    )?;
    println!("      header hit test: {report}");
    let v: Value = serde_json::from_str(&report).unwrap_or(Value::Null);
    let blocked = v
        .get("blocked")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    ensure!(
        blocked.is_empty(),
        "controls in the title-bar band cannot be clicked: {report}"
    );
    Ok(())
}

/// macOS runs an overlay title bar with an inset traffic light, so the frontend
/// must supply its own drag region. Asserted only where the platform applies.
fn scenario_macos_title_bar(ctx: &Ctx) -> ScenarioResult {
    if !cfg!(target_os = "macos") {
        println!("      skipped: not macOS");
        return Ok(());
    }
    ctx.goto("/")?;
    let drag_regions =
        ctx.eval("return document.querySelectorAll('[data-tauri-drag-region]').length;")?;
    ensure!(
        drag_regions.as_u64().unwrap_or(0) > 0,
        "macOS overlay title bar has no [data-tauri-drag-region] element to drag by"
    );

    // The traffic light is inset by 20x32 in tauri.macos.conf.json; the sidebar
    // header must leave room for it rather than starting flush at the corner.
    let top_left_clear = ctx.eval_bool(
        "const el = document.elementFromPoint(24, 20);
         if (!el) return true;
         // Anything clickable here would sit under the traffic light.
         return !el.closest('button, a[href], input, select, textarea, [role=\"button\"]');",
    )?;
    ensure!(
        top_left_clear,
        "an interactive element sits under the macOS traffic-light inset"
    );
    Ok(())
}

/// The scripted picker answers the real `open_dialog` command over real IPC.
///
/// Runs before the UI attach scenarios so a failure says whether the seam or
/// the attach handler is at fault.
fn scenario_dialog_seam(ctx: &Ctx) -> ScenarioResult {
    let path = ctx.project.to_string_lossy().to_string();

    ctx.script_dialog(Some(&ctx.project));
    let picked = ctx.eval(
        "return await window.__TAURI_INTERNALS__.invoke('open_dialog',
            { options: { directory: true } });",
    );
    ctx.clear_dialog_script();
    let picked = picked?;
    ensure!(
        picked.as_str() == Some(path.as_str()),
        "scripted picker returned {picked:?}, expected {path:?}"
    );

    ctx.script_dialog(None);
    let cancelled = ctx.eval(
        "return await window.__TAURI_INTERNALS__.invoke('open_dialog',
            { options: { directory: true } });",
    );
    ctx.clear_dialog_script();
    ensure!(
        cancelled?.is_null(),
        "a scripted cancellation must return null"
    );
    Ok(())
}

/// The workspace pill. It is a popover *trigger*, not the attach action --
/// clicking it alone does nothing, which is what made the first version of the
/// attach scenario fail while reporting no error at all.
const PILL_JS: &str = r#"[...document.querySelectorAll('button')].find(b =>
    /no project folder attached/i.test(b.getAttribute('aria-label') || ''))"#;

/// The attach action, which lives inside the pill's popover.
const ATTACH_ITEM_JS: &str = r#"[...document.querySelectorAll('button,[role="menuitem"]')].find(b => {
    const t = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim();
    return /^(attach a folder|attach project)$/i.test(t);
  })"#;

/// Open the pill popover and click its attach action.
fn open_picker_through_the_pill(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;

    // A retry, or a scenario that ran earlier, may have left a folder attached.
    // Detach through the pill rather than assuming a clean session, or the
    // "attach one" control is simply not there to click.
    if !ctx.eval_bool(&format!("return !!({PILL_JS});"))? {
        let _ = ctx.eval(
            "const pill = [...document.querySelectorAll('button')].find(b =>
               /attached read-only|project folder/i.test(b.getAttribute('aria-label') || ''));
             // The popover stays open after attaching; clicking its trigger
             // again would close it, so only open it when it is closed.
             if (pill && pill.getAttribute('aria-expanded') !== 'true') pill.click();
             return true;",
        );
        std::thread::sleep(Duration::from_millis(700));
        let _ = ctx.eval(
            "const item = [...document.querySelectorAll('button,[role=\"menuitem\"]')]
               .find(e => /^detach folder$/i.test((e.textContent || '').trim()));
             if (item) item.click();
             return true;",
        );
        std::thread::sleep(Duration::from_millis(900));
    }

    let pill = ctx.wait_until(
        "the workspace pill",
        &format!("return !!({PILL_JS});"),
        Duration::from_secs(30),
    );
    if pill.is_err() {
        let _ = ctx.describe("workspace-pill");
    }
    pill?;
    ctx.eval(&format!("({PILL_JS}).click(); return true;"))?;
    ctx.wait_until(
        "the pill popover's attach action",
        &format!("return !!({ATTACH_ITEM_JS});"),
        Duration::from_secs(15),
    )?;
    ctx.eval(&format!("({ATTACH_ITEM_JS}).click(); return true;"))?;
    Ok(())
}

/// A dismissed picker must leave the session unattached.
fn scenario_attach_cancelled(ctx: &Ctx) -> ScenarioResult {
    ctx.script_dialog(None);
    let opened = open_picker_through_the_pill(ctx);
    std::thread::sleep(Duration::from_secs(3));
    ctx.clear_dialog_script();
    opened?;

    let still_unattached = ctx.eval_bool(&format!("return !!({PILL_JS});"))?;
    ensure!(
        still_unattached,
        "cancelling the picker still attached a project"
    );
    Ok(())
}

/// Attaching through the real handler, the real service hub and the real
/// `open_dialog` command -- only the OS modal is scripted.
fn scenario_attach(ctx: &Ctx) -> ScenarioResult {
    ctx.script_dialog(Some(&ctx.project));
    let opened = open_picker_through_the_pill(ctx);

    // Assert on the fixture's own directory name. "project" alone would also
    // match the unattached prompt, which is how the first version of this
    // scenario passed without ever attaching anything.
    let name = ctx
        .project
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
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
    landed?;

    // The Code rail must stop offering to attach and start browsing.
    ctx.click_rail("Code")?;
    ctx.wait_until(
        "the Code rail to leave its empty state",
        "return !document.body.innerText.includes('Attach a project folder to browse');",
        Duration::from_secs(20),
    )?;
    Ok(())
}
/// Open the Code rail and make sure the file tree -- not an open file -- is
/// showing.
///
/// Opening a file replaces the tree with the viewer, and the rail button is a
/// toggle, so clicking it again would close the panel outright. The panel's own
/// "Project explorer" control is the way back.
fn open_code_explorer(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    let explorer = "return !!document.querySelector('[data-testid=\"code-explorer\"]');";
    if !ctx.eval_bool(explorer)? {
        let went_back = ctx.eval_bool(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /project explorer/i.test((x.getAttribute('aria-label') || '')
                 + ' ' + (x.getAttribute('title') || '')));
             if (!b) return false; b.click(); return true;",
        )?;
        if !went_back {
            ctx.click_rail("Code")?;
        }
        std::thread::sleep(Duration::from_millis(700));
    }
    ctx.wait_until("the code explorer", explorer, Duration::from_secs(20))
}

fn click_tree_entry(ctx: &Ctx, name: &str) -> Result<bool, Failure> {
    ctx.eval_bool(&format!(
        r#"const root = document.querySelector('[data-testid="code-explorer"]');
           if (!root) return false;
           // The name may sit on a leaf span rather than the row element, so
           // find the deepest node carrying exactly that text and climb to the
           // nearest thing that can actually be clicked.
           const leaf = [...root.querySelectorAll('*')]
             .filter(e => e.children.length === 0 && (e.textContent || '').trim() === {name:?})
             .pop()
             || [...root.querySelectorAll('*')]
               .filter(e => (e.textContent || '').trim() === {name:?})
               .pop();
           if (!leaf) return false;
           const target = leaf.closest('button,[role="treeitem"],[role="button"],a,li') || leaf;
           target.scrollIntoView({{ block: 'center' }});
           target.click();
           return true;"#
    ))
}

fn explorer_text(ctx: &Ctx) -> Result<String, Failure> {
    ctx.eval_string(
        "const r = document.querySelector('[data-testid=\"code-explorer\"]');
         return r ? r.textContent : '';",
    )
}

/// A folder's children appear only once it is expanded -- the tree is not
/// enumerated eagerly.
fn scenario_lazy_browsing(ctx: &Ctx) -> ScenarioResult {
    open_code_explorer(ctx)?;

    // An earlier scenario may have left src expanded, so collapse it first
    // rather than assuming the tree starts closed.
    if explorer_text(ctx)?.contains("index.ts") {
        click_tree_entry(ctx, "src")?;
        std::thread::sleep(Duration::from_millis(800));
    }

    let before = explorer_text(ctx)?;
    ensure!(
        before.contains("src"),
        "the explorer never listed the src folder (saw {before:?})"
    );
    ensure!(
        !before.contains("index.ts"),
        "src/index.ts was listed while src was collapsed; the tree is eager"
    );

    ensure!(
        click_tree_entry(ctx, "src")?,
        "could not click the src folder"
    );
    ctx.wait_until(
        "src to expand",
        "const r = document.querySelector('[data-testid=\"code-explorer\"]');
         return !!r && r.textContent.includes('index.ts');",
        Duration::from_secs(15),
    )?;

    // A nested folder is still not expanded.
    let after = explorer_text(ctx)?;
    ensure!(
        after.contains("lib"),
        "the nested lib folder did not appear after expanding src"
    );
    ensure!(
        !after.contains("util.ts"),
        "src/lib/util.ts was listed before lib was expanded; expansion is not lazy"
    );
    Ok(())
}

/// Opening files puts them in the Code panel, one tab each.
fn scenario_code_tabs(ctx: &Ctx) -> ScenarioResult {
    open_code_explorer(ctx)?;
    if !explorer_text(ctx)?.contains("index.ts") {
        click_tree_entry(ctx, "src")?;
        std::thread::sleep(Duration::from_millis(900));
    }
    ensure!(
        click_tree_entry(ctx, "index.ts")?,
        "could not open src/index.ts"
    );
    ctx.wait_until(
        "the code viewer",
        "return !!document.querySelector('[data-testid=\"code-viewer-body\"]')
             || !!document.querySelector('[data-testid=\"code-editor\"]');",
        Duration::from_secs(20),
    )?;

    // Opening a file replaces the tree, so go back to it before the second one.
    open_code_explorer(ctx)?;
    if !click_tree_entry(ctx, "README.md")? {
        let names = ctx.eval_string(
            "const r = document.querySelector('[data-testid=\"code-explorer\"]');
             if (!r) return 'no explorer';
             return [...r.querySelectorAll('*')]
               .filter(e => e.children.length === 0)
               .map(e => (e.textContent || '').trim())
               .filter(Boolean).slice(0, 40).join(' | ');",
        )?;
        bail!("could not open README.md; explorer leaves were: {names}");
    }
    ctx.wait_until(
        "a second open file",
        "const t = document.body.innerText;
         return t.includes('README.md') && t.includes('index.ts');",
        Duration::from_secs(20),
    )?;
    ctx.describe("code-tabs")?;
    Ok(())
}

/// Line numbers, highlighting, wrapping and scrolling in the Code viewer.
fn scenario_code_viewer(ctx: &Ctx) -> ScenarioResult {
    open_file(ctx, &["src", "lib", "util.ts"])?;
    ctx.wait_until(
        "util.ts to render",
        "const b = document.querySelector('[data-testid=\"code-viewer-body\"]');
         return !!b && b.textContent.includes('value120');",
        Duration::from_secs(45),
    )?;

    // Deliberately several small evals: one script that measured everything at
    // once kept exceeding the eval budget while the viewer was still
    // highlighting, and reported a timeout instead of a verdict.
    const BODY: &str = "document.querySelector('[data-testid=\"code-viewer-body\"]')";

    // Detect the gutter structurally. `textContent` concatenates without
    // separators, so "1" runs straight into the first line of code and no
    // text-shaped check can find it.
    let gutter = ctx.eval(&format!(
        "const b = {BODY}; if (!b) return 0;
         const nums = [...b.querySelectorAll('*')]
           .filter(e => e.children.length === 0 && /^[0-9]+$/.test((e.textContent || '').trim()))
           .map(e => parseInt(e.textContent.trim(), 10));
         return nums.includes(1) && nums.includes(120) ? nums.length : 0;"
    ))?;
    println!("      gutter entries: {gutter}");
    ensure!(
        gutter.as_u64().unwrap_or(0) >= 100,
        "the viewer showed no line-number gutter running from 1 to 120"
    );

    let colours = ctx.eval(&format!(
        "const b = {BODY}; if (!b) return 0;
         const spans = b.querySelectorAll('span');
         const seen = new Set();
         for (let i = 0; i < spans.length && i < 40; i++) seen.add(getComputedStyle(spans[i]).color);
         return seen.size;"
    ))?;
    println!("      distinct token colours: {colours}");
    ensure!(
        colours.as_u64().unwrap_or(0) > 1,
        "every token rendered in one colour, so nothing is highlighted"
    );

    let scrollable = ctx.eval_bool(&format!(
        "const b = {BODY}; return !!b && b.scrollHeight > b.clientHeight + 4;"
    ))?;
    ensure!(
        scrollable,
        "a 120-line file did not overflow its viewport, so scrolling is untested"
    );

    // Scrolling actually moves the viewport.
    let scrolled = ctx.eval_bool(
        "const b = document.querySelector('[data-testid=\"code-viewer-body\"]');
         if (!b) return false;
         const before = b.scrollTop;
         b.scrollTop = b.scrollHeight;
         return b.scrollTop > before;",
    )?;
    ensure!(scrolled, "the code viewer would not scroll");

    // Word wrap is a real toggle. The wrapping is applied to the element that
    // holds the lines rather than the panel body, so assert the observable
    // consequence instead of a computed style: a 400-character line stops
    // overflowing horizontally once wrapping is on.
    open_file(ctx, &["src", "lib", "wide.ts"])?;
    ctx.wait_until(
        "wide.ts to render",
        &format!("const b = {BODY}; return !!b && b.textContent.includes('xxxxxxxxxx');"),
        Duration::from_secs(45),
    )?;

    let overflow_before = ctx.eval_bool(&format!(
        "const b = {BODY}; return !!b && b.scrollWidth > b.clientWidth + 4;"
    ))?;
    let toggled = ctx.eval_bool(
        "const b = [...document.querySelectorAll('button')].find(x =>
           /word wrap/i.test((x.getAttribute('aria-label') || '')
             + ' ' + (x.getAttribute('title') || '')));
         if (!b) return false; b.click(); return true;",
    )?;
    ensure!(toggled, "the viewer exposed no word-wrap control");
    std::thread::sleep(Duration::from_millis(800));
    let overflow_after = ctx.eval_bool(&format!(
        "const b = {BODY}; return !!b && b.scrollWidth > b.clientWidth + 4;"
    ))?;
    println!("      horizontal overflow: {overflow_before} -> {overflow_after}");
    ensure!(
        overflow_before != overflow_after,
        "toggling word wrap did not change whether a 400-character line overflows"
    );
    Ok(())
}

/// Open a file by walking the tree from the explorer each time.
///
/// Opening a file replaces the tree, so every scenario that opens one has to
/// start from the explorer rather than assume the previous scenario's state.
fn open_file(ctx: &Ctx, path: &[&str]) -> ScenarioResult {
    open_code_explorer(ctx)?;
    for (i, part) in path.iter().enumerate() {
        let last = i + 1 == path.len();
        if !last && explorer_text(ctx)?.contains(path[i + 1]) {
            continue; // already expanded
        }
        ensure!(
            click_tree_entry(ctx, part)?,
            "could not click {part:?} while opening {path:?}"
        );
        std::thread::sleep(Duration::from_millis(900));
    }
    Ok(())
}

/// Reading a file shows its real contents.
fn scenario_file_read(ctx: &Ctx) -> ScenarioResult {
    open_file(ctx, &["src", "index.ts"])?;
    ctx.wait_until(
        "index.ts contents",
        "return document.body.innerText.includes('export const greet');",
        Duration::from_secs(25),
    )?;
    Ok(())
}

/// Opening a file named like a secret must be refused, not previewed.
fn scenario_sensitive_rejection(ctx: &Ctx) -> ScenarioResult {
    open_file(ctx, &[".env"])?;
    std::thread::sleep(Duration::from_secs(2));
    let text = ctx.eval_string("return document.body.innerText;")?;
    ensure!(
        !text.contains("SMOKE_TOKEN"),
        "the contents of .env were rendered into the UI"
    );
    println!("      after clicking .env, secret not shown");
    Ok(())
}

/// A binary file behind a text extension must be refused, not rendered.
fn scenario_binary_rejection(ctx: &Ctx) -> ScenarioResult {
    open_file(ctx, &["data.txt"])?;
    std::thread::sleep(Duration::from_secs(2));
    let text = ctx.eval_string("return document.body.innerText;")?;
    ensure!(
        !text.contains("binary payload behind"),
        "binary bytes were rendered as text despite the .txt extension"
    );
    println!("      after clicking data.txt, binary not rendered");
    Ok(())
}

/// A 2 MiB file must not be inlined whole.
fn scenario_oversized(ctx: &Ctx) -> ScenarioResult {
    open_code_explorer(ctx)?;
    ensure!(
        explorer_text(ctx)?.contains("huge.txt"),
        "the explorer did not list huge.txt"
    );
    open_file(ctx, &["huge.txt"])?;
    std::thread::sleep(Duration::from_secs(3));
    let len = ctx.eval("return document.body.innerText.length;")?;
    let len = len.as_u64().unwrap_or(0);
    println!("      body text length after opening a 2 MiB file: {len}");
    ensure!(
        len < 2_000_000,
        "a 2 MiB file was inlined into the DOM ({len} chars of text)"
    );
    Ok(())
}

/// Uncommitted working-tree changes are surfaced, and are attributed to the
/// working tree rather than to a Cowork run that never happened.
fn scenario_git_vs_sandbox(ctx: &Ctx) -> ScenarioResult {
    ctx.goto("/cowork")?;
    ctx.ensure_rail_open("Changes", "[data-testid=\"cowork-diff-panel\"]")?;
    ctx.wait_until(
        "the Changes rail",
        "return !!document.querySelector('[data-testid=\"cowork-diff-panel\"]');",
        Duration::from_secs(20),
    )?;
    std::thread::sleep(Duration::from_secs(2));
    let text = ctx.eval_string("return document.body.innerText;")?;
    println!(
        "      changes rail tail: {:?}",
        &text[text.len().saturating_sub(400)..]
    );

    // No Cowork run has happened in this session, so anything listed here comes
    // from the working tree the harness dirtied before attaching.
    ensure!(
        text.contains("README.md") || text.contains("untracked.md"),
        "the working-tree changes made before attaching are not listed"
    );
    ensure!(
        !text.contains("No changes yet"),
        "the Changes rail still claims there is nothing to show"
    );
    Ok(())
}

/// Open the access menu and choose a mode by its visible label.
///
/// Radix opens a dropdown on `pointerdown`, not on `click`. A blocked option
/// says why in its own text, and that is reported instead of a timeout.
fn choose_access(ctx: &Ctx, label: &str) -> ScenarioResult {
    choose_from_menu(ctx, "Where changes go", label)
}

/// The run mode, chosen the same way: attaching a repository starts a session
/// in Review first, which withholds every tool that could change anything.
fn choose_mode(ctx: &Ctx, label: &str) -> ScenarioResult {
    choose_from_menu(ctx, "What Flint may do", label)
}

/// Open the dropdown whose trigger is labelled `trigger` and pick `label`.
fn choose_from_menu(ctx: &Ctx, trigger: &str, label: &str) -> ScenarioResult {
    let opened = ctx.eval_bool(
        &format!(r#"const b = [...document.querySelectorAll('button')].find(x =>
             x.getAttribute('aria-label') === {trigger:?});
           if (!b) return false;
           b.dispatchEvent(new PointerEvent('pointerdown',
             {{ bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }}));
           return true;"#
        ),
    )?;
    ensure!(opened, "the {trigger} menu trigger is not on the page");
    // Toasts fade in seconds, so a refusal reported by one is collected as it
    // appears rather than looked for after the wait has already timed out.
    ctx.eval(
        "window.__smokeToasts = [];
         if (!window.__smokeToastObserver) {
           window.__smokeToastObserver = new MutationObserver(() => {
             document.querySelectorAll('[data-sonner-toast]').forEach(t => {
               const x = t.textContent || '';
               if (x && !window.__smokeToasts.includes(x)) window.__smokeToasts.push(x);
             });
           });
           window.__smokeToastObserver.observe(document.body, { childList: true, subtree: true });
         }
         return true;",
    )?;
    ctx.wait_until(
        &format!("the {label} option"),
        &format!(
            "return [...document.querySelectorAll('[role=\"menuitemradio\"],[role=\"menuitem\"]')]
               .some(e => (e.textContent || '').includes({label:?}));"
        ),
        Duration::from_secs(15),
    )?;
    let option = ctx.eval_string(&format!(
        "const o = [...document.querySelectorAll('[role=\"menuitemradio\"],[role=\"menuitem\"]')]
           .find(e => (e.textContent || '').includes({label:?}));
         const blocked = o.getAttribute('aria-disabled') === 'true';
         if (!blocked) o.click();
         return (blocked ? 'BLOCKED: ' : '') + (o.textContent || '');"
    ))?;
    ensure!(!option.starts_with("BLOCKED"), "{label} is not available here: {option}");
    let changed = ctx.wait_until(
        &format!("access to become {label}"),
        &format!(
            "const b = [...document.querySelectorAll('button')].find(x =>
               x.getAttribute('aria-label') === {trigger:?});
             return !!b && (b.textContent || '').includes({label:?});"
        ),
        Duration::from_secs(45),
    );
    if changed.is_err() {
        let seen = ctx
            .eval_string("return (window.__smokeToasts || []).join(' | ');")
            .unwrap_or_default();
        bail!("choosing {label} did not take effect; toasts seen: {seen:?}");
    }
    Ok(())
}

/// Managed worktree mode, end to end through the real UI on this platform.
/// Windows confinement for a Jan-owned worktree; AH-146/147/148/109.
///
/// Proves: the access menu offers Managed worktree (on Windows, where editing
/// the folder directly is not offered); a run's `write` and `bash` land in the
/// worktree and not in the attached folder -- the shell under the sandbox
/// writing there is the confinement grant in action; the Changes panel's
/// review lists the run's work; unticking a hunk and applying lands exactly
/// what was ticked in the attached folder.
/// Stopping a run that is waiting for approval withdraws the prompt: it leaves
/// the screen with nothing left to click, the call is recorded as cancelled
/// with the reason, and nothing is written -- neither then nor by a late
/// answer.
fn scenario_stop_withdraws_approval(ctx: &Ctx) -> ScenarioResult {
    let file = "withdrawn-by-stop.txt";
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
        choose_mode(ctx, "Ask before changes")?;
        let call = format!(
            "write:{}",
            serde_json::json!({ "path": file, "content": "must not land\n" })
        );
        ctx.script_model("tools", &[call.as_str()])?;
        send_without_waiting(ctx, "write the file, then wait")?;
        ctx.wait_until(
            "the approval prompt",
            "return [...document.querySelectorAll('button')].some(x => /^allow once$/i.test((x.textContent || '').trim()));",
            Duration::from_secs(90),
        )?;
        stop_current(ctx)?;
        ctx.wait_until(
            "the prompt to be withdrawn",
            "return ![...document.querySelectorAll('button')].some(x => /^allow once$/i.test((x.textContent || '').trim()));",
            Duration::from_secs(20),
        )?;
        ctx.wait_until(
            "the run to end",
            "return !document.querySelector('[data-testid=\"cowork-stop\"]');",
            Duration::from_secs(60),
        )?;
        // Recorded as the stop it was, not as the person's no.
        let deadline = Instant::now() + Duration::from_secs(20);
        let events = loop {
            let events: Vec<String> = activity_events(ctx)
                .into_iter()
                .filter(|l| l.contains(file) || l.contains("approval withdrawn"))
                .collect();
            if events.iter().any(|l| l.contains("approval withdrawn")) {
                break events;
            }
            ensure!(
                Instant::now() < deadline,
                "the withdrawn prompt was never recorded: {events:?}"
            );
            std::thread::sleep(Duration::from_millis(250));
        };
        let withdrawn = events.iter().find(|l| l.contains("approval withdrawn")).unwrap();
        ensure!(
            withdrawn.contains("\"phase\":\"cancelled\""),
            "the withdrawal was recorded as {withdrawn}"
        );
        ensure!(
            !events.iter().any(|l| l.contains("\"phase\":\"allowed\"") || l.contains("\"phase\":\"refused\"")),
            "a withdrawn prompt was recorded as answered: {events:?}"
        );
        // Nothing landed anywhere Jan keeps a session's files.
        let sessions = data_folder()?.join("agent-workspace").join("sessions");
        let landed = std::fs::read_dir(&sessions)
            .into_iter()
            .flatten()
            .flatten()
            .any(|e| e.path().join(file).exists());
        ensure!(!landed, "the withdrawn call wrote {file}");
        Ok(())
    })();
    let _ = ctx.script_model("plain", &[]);
    result
}
