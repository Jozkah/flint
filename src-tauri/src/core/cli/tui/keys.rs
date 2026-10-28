//! Keyboard input: the key router and the per-screen key handlers (ask,
//! login, pickers, settings, MCP and provider prompts), plus the word and line
//! boundary helpers the composer keys use. Moved verbatim out of `tui.rs`.

use super::*;

pub(super) async fn resolve_front_ask(
    app: &mut App,
    registry: &crate::core::agent::interaction::AskRegistry,
    cancelled: bool,
) {
    let Some(ask) = app.ask_queue.pop_front() else {
        return;
    };
    app.publish_agent_status();
    // Reserved plan-review ask: a single question with the exact id drives the
    // mode transition. Capture the chosen label before `answers` is moved into
    // the outcome. Skipped on cancel so a cancelled review never changes mode.
    let plan_choice = (!cancelled
        && ask.request.questions.len() == 1
        && ask.request.questions[0].id == crate::core::agent::plan::PLAN_REVIEW_QUESTION_ID)
        .then(|| {
            ask.answers
                .first()
                .and_then(|a| a.selected.first().cloned())
        })
        .flatten();
    let plan_summary = ask
        .request
        .questions
        .first()
        .map(|q| q.question.clone())
        .unwrap_or_default();
    let outcome = if cancelled {
        Err(crate::core::agent::interaction::AskError::Cancelled)
    } else {
        Ok(ask.answers)
    };
    // Always respond so the model's in-flight turn completes normally.
    let _ = crate::core::agent::interaction::respond(registry, &ask.request_id, outcome).await;
    if let Some(label) = plan_choice {
        apply_plan_review(app, &label, &plan_summary);
    }
}

/// Drive the plan-mode transition from a `plan_review` answer. The model has
/// already staged todos via `todo(init)` earlier in the same turn; here we only
/// flip the mode (and, for Execute, queue the continuation turn). Persists so
/// the mode survives resume.
/// The only thing a fresh-context execution starts from: the plan summary and
/// every staged todo, phase by phase.
pub(super) fn fresh_plan_message(summary: &str, todos: &crate::core::agent::todo::TodoList) -> String {
    let mut out = String::from(
        "Implement the plan below. The earlier conversation was cleared on purpose, so work from this plan alone and read the project as needed.\n\n",
    );
    if !summary.trim().is_empty() {
        out.push_str(&format!("Plan: {}\n\n", summary.trim()));
    }
    for phase in &todos.phases {
        out.push_str(&format!("## {}\n", phase.name));
        for task in &phase.tasks {
            out.push_str(&format!("- {}\n", task.content));
        }
        out.push('\n');
    }
    out.trim_end().to_string()
}

pub(super) fn apply_plan_review(app: &mut App, label: &str, summary: &str) {
    use crate::core::agent::plan::{self, RunMode};
    match label {
        plan::EXECUTE_PLAN_LABEL => {
            // Atomic handoff: refuse to leave Plan unless the plan was actually
            // staged (spec: failed todo init keeps the agent in Plan intact).
            if app.todos.is_empty() {
                app.note("cannot execute: no plan staged (todo init first); staying in plan mode");
                return;
            }
            app.run_mode = RunMode::Normal;
            app.persist();
            app.note("▶ executing plan (normal mode)");
            // Enqueues while the ask turn is still running; on_done dequeues it,
            // starting execution only after the mode switch has committed.
            app.submit_user("Proceed with the plan.".to_string());
        }
        plan::EXECUTE_FRESH_LABEL => {
            if app.todos.is_empty() {
                app.note("cannot execute: no plan staged (todo init first); staying in plan mode");
                return;
            }
            app.run_mode = RunMode::Normal;
            app.persist();
            app.note("▶ executing plan in a fresh context (normal mode)");
            let message = fresh_plan_message(summary, &app.todos);
            // Queued like "Execute plan": the ask turn finishes first, then the
            // conversation is cleared and this is the only thing the model sees.
            app.message_queue.push_back(PendingMessage {
                text: "Implement the plan (fresh context).".to_string(),
                message: serde_json::json!({ "role": "user", "content": message }),
                images: Vec::new(),
                display: true,
                invocation: None,
                run_mode: Some(app.run_mode),
                fresh_context: true,
            });
            if app.status != Status::Running {
                app.dequeue_next();
            }
        }
        plan::KEEP_PLANNING_LABEL => app.note("continuing to plan (read only)"),
        plan::EXIT_PLAN_LABEL => {
            app.run_mode = RunMode::Normal;
            app.persist();
            app.note("exited plan mode (no execution)");
        }
        other => app.note(&format!("unknown plan review choice: {other}")),
    }
}

/// Handle keys owned by the front interactive question. Returns false only for
/// global Ctrl-C/Ctrl-D, which must continue into the normal run cancellation
/// path after every ask waiter has been released.
pub(super) async fn handle_ask_key(
    app: &mut App,
    key: KeyEvent,
    registry: &crate::core::agent::interaction::AskRegistry,
) -> bool {
    // A docked prompt owns the keyboard, and `handle_ask_key` runs before
    // `handle_key` -- without this an ask queued by the running agent would
    // swallow the secret being typed into `/login` and echo it into a custom
    // answer that is then submitted to the model.
    if app.ask_queue.is_empty() || app.blocking_dock().is_some() {
        return false;
    }
    if key.kind == KeyEventKind::Release {
        return true;
    }
    let ctrl = key_is_ctrl(&key);
    // A docked ask runs before `handle_key`, so the repaint key is honoured
    // here too -- otherwise a broadcast landing during a question stays on
    // screen until it is answered. Consumed, never typed into the answer.
    if ctrl && key.code == KeyCode::Char('l') {
        app.request_repaint();
        return true;
    }
    if ctrl && matches!(key.code, KeyCode::Char('c') | KeyCode::Char('d')) {
        crate::core::agent::interaction::cancel_all(registry).await;
        app.ask_queue.clear();
        return false;
    }
    if key.code == KeyCode::Esc {
        resolve_front_ask(app, registry, true).await;
        return true;
    }

    let mut submit = false;
    {
        let ask = app.ask_queue.front_mut().expect("checked non-empty above");
        if ask.editing_custom {
            match key.code {
                KeyCode::Enter => submit = ask.accept_custom(),
                KeyCode::Backspace => {
                    ask.custom_input.pop();
                }
                KeyCode::Char(ch) if !ctrl => ask.custom_input.push(ch),
                _ => {}
            }
        } else {
            match key.code {
                KeyCode::Up => ask.move_selection(-1),
                KeyCode::Down => ask.move_selection(1),
                KeyCode::Left => ask.move_question(-1),
                KeyCode::Right => ask.move_question(1),
                KeyCode::Char(' ') if ask.question().multi => {
                    submit = ask.choose();
                }
                KeyCode::Enter => submit = ask.choose(),
                _ => {}
            }
        }
    }
    if submit {
        resolve_front_ask(app, registry, false).await;
    }
    true
}

/// Keys for the `/login` prompt. Enter hands the key to the loop for
/// verification (`login_submit`); Esc or Ctrl-C abandons sign-in. While a
/// verification is in flight the field is read-only, so a stray keystroke cannot
/// edit the key being checked -- but Esc still cancels, so the prompt can never
/// wedge the TUI.
pub(super) fn handle_login_key(app: &mut App, key: KeyEvent, ctrl: bool) {
    let cancel = key.code == KeyCode::Esc
        || (ctrl && matches!(key.code, KeyCode::Char('c') | KeyCode::Char('d')));
    if cancel {
        app.login = None;
        app.login_submit = None;
        return;
    }
    // The browser question owns the keyboard until it is answered, so a
    // keystroke meant for it can never fall through into the key field.
    if app
        .login
        .as_ref()
        .is_some_and(|p| p.unconfirmed_url().is_some())
    {
        if ctrl {
            return;
        }
        match key.code {
            KeyCode::Enter | KeyCode::Char('y') | KeyCode::Char('Y') => {
                resolve_login_browser(app, true)
            }
            KeyCode::Char('n') | KeyCode::Char('N') => resolve_login_browser(app, false),
            _ => {}
        }
        return;
    }

    // Ctrl-V: terminals deliver a normal paste as `Event::Paste`, but some send
    // Ctrl-V through as a key, so read the clipboard directly for those.
    if ctrl && key.code == KeyCode::Char('v') {
        if !app.login.as_ref().is_some_and(LoginPrompt::editable) {
            return;
        }
        match super::super::secret_input::clipboard_text() {
            Ok(text) => {
                if let Some(prompt) = app.login.as_mut() {
                    prompt.paste(&text);
                }
            }
            Err(e) => {
                if let Some(prompt) = app.login.as_mut() {
                    prompt.error = Some(format!("could not read the clipboard: {e}"));
                }
            }
        }
        return;
    }

    let Some(prompt) = app.login.as_mut() else {
        return;
    };
    // The browser stages have no field to edit -- only Esc, handled above, does
    // anything. Same for a paste being verified.
    if !prompt.editable() {
        return;
    }
    match key.code {
        KeyCode::Enter => match crate::core::cli::auth::providers::sanitize_key(&prompt.input) {
            Ok(key) => {
                prompt.verifying = true;
                prompt.error = None;
                app.login_submit = Some((prompt.provider.clone(), key));
            }
            Err(e) => {
                prompt.input.clear();
                prompt.error = Some(e);
            }
        },
        KeyCode::Backspace => {
            prompt.input.pop();
        }
        KeyCode::Char(ch) if !ctrl => prompt.input.push(ch),
        _ => {}
    }
}

pub(super) fn handle_model_picker_key(app: &mut App, key: KeyEvent, ctrl: bool) {
    if key.code == KeyCode::Esc
        || (ctrl && matches!(key.code, KeyCode::Char('c') | KeyCode::Char('d')))
    {
        app.model_picker = None;
        return;
    }

    let mut chosen = None;
    if let Some(picker) = app.model_picker.as_mut() {
        match key.code {
            KeyCode::Left => picker.focus = ModelPickerFocus::Scopes,
            KeyCode::Right => {
                picker.focus = ModelPickerFocus::Models;
                picker.move_selection(0);
            }
            KeyCode::Up => match picker.focus {
                ModelPickerFocus::Scopes => {
                    picker.select_scope(picker.active_scope.saturating_sub(1))
                }
                ModelPickerFocus::Models => picker.move_selection(-1),
            },
            KeyCode::Down => match picker.focus {
                ModelPickerFocus::Scopes => {
                    let max = picker.scopes.len().saturating_sub(1);
                    picker.select_scope((picker.active_scope + 1).min(max));
                }
                ModelPickerFocus::Models => picker.move_selection(1),
            },
            KeyCode::Char('k') if picker.focus == ModelPickerFocus::Models && !ctrl => {
                picker.move_selection(-1);
            }
            KeyCode::Char('j') if picker.focus == ModelPickerFocus::Models && !ctrl => {
                picker.move_selection(1);
            }
            KeyCode::Backspace if picker.focus == ModelPickerFocus::Models => {
                picker.query.pop();
                picker.refresh_items();
            }
            KeyCode::Char(ch) if picker.focus == ModelPickerFocus::Models && !ctrl => {
                picker.query.push(ch);
                picker.refresh_items();
            }
            KeyCode::Enter if picker.focus == ModelPickerFocus::Scopes => {
                picker.select_scope(picker.active_scope);
                picker.focus = ModelPickerFocus::Models;
            }
            KeyCode::Enter if picker.focus == ModelPickerFocus::Models => {
                chosen = picker
                    .items
                    .get(picker.selected)
                    .map(|item| item.value.clone());
            }
            _ => {}
        }
    }
    if let Some(value) = chosen {
        app.set_model(value);
        app.model_picker = None;
    }
}

/// The copyable continuation command shown when a session closes, mirroring
/// the non-interactive resume line in `cli`/`mod.rs`. The id is the same
/// short thread id `--resume` accepts, taken from the thread the session
/// persists to rather than a separately minted one.
pub(super) fn resume_hint(thread_id: &str) -> String {
    let id: String = thread_id.chars().take(8).collect();
    format!("\x1b[2m[session {id} - resume with `flint --resume={id}`]\x1b[0m")
}

/// True when the key is a Ctrl chord. On Windows, AltGr arrives as Ctrl+Alt, so
/// Ctrl+Alt with a character that is not an ASCII letter or digit is text
/// (`@`, `{`, a non-ASCII letter), not a chord.
pub(super) fn key_is_ctrl(key: &KeyEvent) -> bool {
    let mods = key.modifiers;
    if !mods.contains(KeyModifiers::CONTROL) {
        return false;
    }
    let altgr_text = cfg!(windows)
        && mods.contains(KeyModifiers::ALT)
        && matches!(key.code, KeyCode::Char(c) if !c.is_ascii_alphanumeric() && !c.is_ascii_control());
    !altgr_text
}

pub(super) async fn handle_key(
    app: &mut App,
    key: KeyEvent,
    registry: &PermissionRegistry,
    current: &mut Option<CurrentRun>,
    mcp_servers: &crate::core::state::SharedMcpServers,
) {
    if key.kind != KeyEventKind::Press {
        return;
    }

    let ctrl = key_is_ctrl(&key);
    // Ctrl-L is the readline/less spelling of "redraw". It sits ahead of every
    // mode guard below because the screen can be damaged at any moment,
    // including while a prompt or picker owns the keyboard. It changes only
    // the display.
    if ctrl && key.code == KeyCode::Char('l') {
        app.request_repaint();
        return;
    }
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let sup = key.modifiers.contains(KeyModifiers::SUPER);
    // A modified Enter is a newline, never a submit or a completion, so the
    // hint popups below have to let it through to the editing keys.
    let newline =
        key.code == KeyCode::Enter && (alt || key.modifiers.contains(KeyModifiers::SHIFT));
    let ctrl_c = ctrl && key.code == KeyCode::Char('c');
    let ctrl_d = ctrl && key.code == KeyCode::Char('d');

    // The `/login` prompt owns the keyboard while open: every keystroke is part
    // of a secret being typed, so none of it may reach the input box or the
    // transcript shortcuts.
    if app.login.is_some() {
        handle_login_key(app, key, ctrl);
        return;
    }

    // A pending browser question owns the keyboard the same way, so a `y`/`n`
    // meant for it can never reach the input box or a transcript shortcut.
    if app.browser_confirm.is_some() {
        if !ctrl {
            match key.code {
                KeyCode::Enter | KeyCode::Char('y') | KeyCode::Char('Y') => {
                    resolve_mcp_browser(app, true)
                }
                KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                    resolve_mcp_browser(app, false)
                }
                _ => {}
            }
        }
        return;
    }
    // The `/context` overlay owns the keyboard while open, matching the
    // pickers: Esc (and `q` when not ctrl) closes it, and Ctrl-C closes it
    // without cancelling the running turn. Nothing else reaches the input box
    // or the transcript shortcuts (e.g. a bare `q` must not quit) while it is
    // up.
    if app.context_view.is_some() {
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') if !ctrl => {
                app.context_view = None;
            }
            _ if ctrl_c => {
                app.context_view = None;
            }
            _ => {}
        }
        return;
    }

    // The `/settings` edit dock owns the keyboard while open, same as `/login`.
    if app.settings_prompt.is_some() {
        handle_settings_key(app, key, ctrl);
        return;
    }

    // The MCP add/edit wizard owns the keyboard while open.
    if app.mcp_prompt.is_some() {
        handle_mcp_prompt_key(app, key, ctrl, mcp_servers).await;
        return;
    }

    // The provider add/edit wizard owns the keyboard while open.
    if app.provider_prompt.is_some() {
        handle_provider_prompt_key(app, key, ctrl);
        return;
    }

    // A pending permission prompt captures y/a/n; Ctrl-C or Ctrl-D cancels the
    // run and denies everything queued, so it can't be wedged waiting on an
    // unanswered prompt. Several subagents can have requests queued at once
    // (see `pending_queue`), so cancelling denies all of them, not just the
    // one on screen. Quitting itself stays with the two-press exit below.
    if !app.pending_queue.is_empty() {
        if ctrl_c || ctrl_d {
            for pending in app.pending_queue.drain(..) {
                deny(registry, &pending.request_id).await;
            }
            abort_run(current);
            app.cancel_run();
            return;
        }
        let pending = app
            .pending_queue
            .front_mut()
            .expect("checked non-empty above");
        // Decision keys are plain keystrokes (Ctrl-A / Alt-N / Ctrl-Y are not
        // answers) and wait out the settle window; arrows and Esc stay live.
        let plain = !ctrl && !alt && !sup;
        let settled = pending.settled();
        let decision = match key.code {
            KeyCode::Up => {
                pending.move_selection(-1);
                None
            }
            KeyCode::Down => {
                pending.move_selection(1);
                None
            }
            KeyCode::Enter if !newline && settled => Some(pending.options()[pending.selected].0),
            KeyCode::Char('y') | KeyCode::Char('Y') if plain && settled => {
                Some(PermissionDecision::AllowOnce)
            }
            KeyCode::Char('a') | KeyCode::Char('A')
                if plain && settled && pending.offers_always =>
            {
                Some(PermissionDecision::AllowAlways)
            }
            KeyCode::Char('n') | KeyCode::Char('N') if plain && settled => {
                Some(PermissionDecision::Deny)
            }
            KeyCode::Esc => Some(PermissionDecision::Deny),
            _ => None,
        };
        if let Some(d) = decision {
            // Only the front request resolves here; any others stay queued and
            // surface on the next draw once this one is popped.
            let pending = app
                .pending_queue
                .pop_front()
                .expect("checked non-empty above");
            // Only record denials: the tool row that follows an allow
            // already shows the call proceeded, so an "allowed" line is
            // pure noise once granted.
            if matches!(d, PermissionDecision::Deny) {
                app.system(Level::Error, &format!("denied: {}", pending.summary()));
            }
            if let Some(sender) = registry.lock().await.remove(&pending.request_id) {
                let _ = sender.send(d);
            }
            // The run resumes now that a prompt was answered (unless more are
            // queued) — publish the recomputed status either way.
            app.publish_agent_status();
        }
        return;
    }

    if app.model_picker.is_some() {
        handle_model_picker_key(app, key, ctrl);
        return;
    }

    // Ctrl-C and Ctrl-D both cancel a run, clear a draft, or (on a blank idle
    // composer, and only on a second press) quit.

    // An open picker owns navigation/Enter/Esc. One-shot pickers (thread/model)
    // act and close; the `/mcp` picker toggles the selected row in place.
    if let Some(picker) = app.picker.as_mut() {
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => {
                picker.armed_delete = None;
                picker.selected = picker.selected.saturating_sub(1);
            }
            KeyCode::Down | KeyCode::Char('j') if !picker.items.is_empty() => {
                picker.armed_delete = None;
                picker.selected = (picker.selected + 1).min(picker.items.len() - 1);
            }
            // Space toggles the row in place; Enter opens its detail screen.
            // Enter used to be the toggle, but with a detail screen to reach it
            // is the row's primary action, and Space is already the toggle in
            // the one other checkbox picker (`PluginSelect`).
            KeyCode::Char(' ') if picker.kind == PickerKind::ToggleMcp => {
                let item = &mut picker.items[picker.selected];
                if item.value.is_empty() {
                    return;
                }
                let name = item.value.clone();
                let enable = !item.checkbox.unwrap_or(false);
                // The row flips only once mcp_config.json has been written: a
                // failed write leaves it showing the state that is on disk.
                let Some(connect) = set_mcp_active(app, mcp_servers, &name, enable).await else {
                    return;
                };
                if let Some(item) = app
                    .picker
                    .as_mut()
                    .and_then(|p| p.items.iter_mut().find(|i| i.value == name))
                {
                    item.checkbox = Some(enable);
                }
                if connect {
                    // Nothing on this screen is waiting on the answer, so it is
                    // detached rather than taking the single job slot.
                    reconnect_mcp_server(mcp_servers, name);
                }
            }
            KeyCode::Enter if picker.kind == PickerKind::ToggleMcp => {
                let name = picker.items[picker.selected].value.clone();
                // The watermark row of an empty config: nothing to open.
                if name.is_empty() {
                    return;
                }
                open_mcp_detail(app, &name, mcp_servers).await;
            }
            // The detail screen's rows are actions on one server.
            KeyCode::Enter if picker.kind == PickerKind::McpServer => {
                let action = picker.items[picker.selected].value.clone();
                run_mcp_action(app, &action, mcp_servers).await;
            }
            // `/agents`: Enter drills into the selected subagent's detail.
            KeyCode::Enter if picker.kind == PickerKind::Agents => {
                let run_id = picker
                    .items
                    .get(picker.selected)
                    .map(|i| i.value.clone())
                    .unwrap_or_default();
                // The watermark row (no subagents running) has no id to open.
                if run_id.is_empty() {
                    return;
                }
                picker.kind = PickerKind::AgentDetail;
                app.agent_detail = Some(run_id);
            }
            // `/mcp` picker: `a` opens the add wizard, `e` opens the edit
            // wizard prefilled from the selected row, `d` removes the selected
            // server. All act through the shared config layer.
            KeyCode::Char('a') if picker.kind == PickerKind::ToggleMcp => {
                app.picker = None;
                app.mcp_prompt = Some(McpPrompt {
                    editing: None,
                    field: McpField::Name,
                    name: String::new(),
                    transport: "stdio".to_string(),
                    command: String::new(),
                    args: String::new(),
                    env: String::new(),
                    url: String::new(),
                    headers: String::new(),
                    active: false,
                    error: None,
                });
            }
            KeyCode::Char('e') if picker.kind == PickerKind::ToggleMcp => {
                let name = picker.items[picker.selected].value.clone();
                if name.is_empty() {
                    return;
                }
                edit_mcp_server(app, &name);
            }
            KeyCode::Char('d') if picker.kind == PickerKind::ToggleMcp => {
                let name = picker.items[picker.selected].value.clone();
                if name.is_empty() {
                    return;
                }
                app.picker = None;
                remove_mcp_server(app, &name, mcp_servers).await;
            }
            // `/settings > providers` picker: `a` opens the add wizard, `d`
            // deletes the selected provider only after a confirmation `d` on
            // the same row (an API key is unrecoverable). The leading
            // watermark row (an empty list) is inert. All writes go through
            // the shared headless `~/.jan/config.toml` path.
            KeyCode::Char('a') if picker.kind == PickerKind::ProviderSettings => {
                app.picker = None;
                app.provider_prompt = Some(ProviderPrompt::new());
            }
            KeyCode::Char('d') if picker.kind == PickerKind::ProviderSettings => {
                let Some(item) = picker.items.get(picker.selected) else {
                    return;
                };
                let name = item.value.clone();
                if name.is_empty() {
                    // The watermark row: nothing to delete.
                    return;
                }
                let sel = picker.selected;
                if picker.armed_delete == Some(sel) {
                    // Second `d` on the same row confirms the delete.
                    app.picker = None;
                    if crate::core::agent::global_config::remove_provider(&name).unwrap_or(false) {
                        app.note(&format!("removed provider '{name}'"));
                    } else {
                        app.note(&format!("provider '{name}' was not configured"));
                    }
                } else {
                    // First `d` arms; a second `d` on this row confirms.
                    picker.armed_delete = Some(sel);
                    app.note(&format!("press d again to delete provider '{name}'"));
                }
            }
            // `/settings > providers`: `x` signs out the selected provider.
            // Distinct from `d` delete: logout clears the stored credential
            // (and its OAuth token) but keeps the provider entry and its
            // model list, so a re-login is one Enter away.
            KeyCode::Char('x') if picker.kind == PickerKind::ProviderSettings => {
                let name = picker.items[picker.selected].value.clone();
                if name.is_empty() {
                    return;
                }
                sign_out_provider(app, &name);
            }
            // `/todo` editor: d/Enter = done, x = abandon (drop), r = remove.
            // Each mutates the canonical list and rebuilds the overlay in place;
            // opening/closing the view itself never mutates state.
            KeyCode::Char('d') | KeyCode::Char('x') | KeyCode::Char('r') | KeyCode::Enter
                if picker.kind == PickerKind::Todo =>
            {
                let code = key.code;
                let content = picker.items.get(picker.selected).map(|i| i.value.clone());
                // (picker borrow ends here; nothing below reads it before rebuild)
                if let Some(content) = content {
                    use crate::core::agent::todo::Target;
                    let result = match code {
                        KeyCode::Char('x') => {
                            apply_todo_mutation(app, |l| l.drop_target(Target::Task(&content)))
                                .await
                        }
                        KeyCode::Char('r') => {
                            apply_todo_mutation(app, |l| l.rm(Target::Task(&content))).await
                        }
                        _ => apply_todo_mutation(app, |l| l.done(Target::Task(&content))).await,
                    };
                    if let Err(e) = result {
                        app.note(&format!("todo update failed: {e}"));
                    }
                    // Rebuild from the mutated list; close once nothing remains.
                    if app.todos.is_empty() {
                        app.picker = None;
                    } else if let Some(picker) = app.picker.as_mut() {
                        picker.items = build_todo_items(&app.todos);
                        picker.selected = picker.selected.min(picker.items.len().saturating_sub(1));
                    }
                }
            }
            // `/settings` picker: `x` restores the selected key to its default
            // by removing it from the file its scope names - same write as
            // clearing the field in the edit dock, one keypress instead of two.
            KeyCode::Char('x') if picker.kind == PickerKind::AgentSettings => {
                let key = picker.items[picker.selected].value.clone();
                // (picker borrow ends here; nothing below reads it before rebuild)
                let toml_path = app.agent_dir.join("agent.toml");
                let Some(def) = AGENT_SETTINGS.iter().find(|d| d.key == key) else {
                    // The leading "providers" row has no key to unset.
                    return;
                };
                match write_setting(def, &toml_path, None) {
                    Ok(()) => {
                        // `None`, not `""`: this removed the key, so a `Glyph`
                        // goes back to its default rather than to off, which
                        // is what a cleared edit field means.
                        let when = if apply_live_unset(def) {
                            "in effect now"
                        } else {
                            "takes effect on the next run"
                        };
                        app.note(&format!("{key} unset (default applies); {when}"));
                        if let Some(picker) = app.picker.as_mut() {
                            picker.items = build_agent_settings_items(&toml_path);
                            picker.selected =
                                picker.selected.min(picker.items.len().saturating_sub(1));
                        }
                    }
                    Err(e) => app.note(&format!(
                        "failed to write {}: {e}",
                        setting_path(def, &toml_path)
                    )),
                }
            }
            // `/login`: `x` signs out the selected provider without leaving
            // the picker, so it doubles as a sign-out list. Only meaningful
            // for a provider that is currently signed in.
            KeyCode::Char('x') if picker.kind == PickerKind::LoginProvider => {
                let name = picker.items[picker.selected].value.clone();
                if !crate::core::cli::providers::provider_is_signed_in(
                    Some(&app.project_root),
                    &name,
                ) {
                    app.note(&format!("{name} is not signed in"));
                    return;
                }
                sign_out_provider(app, &name);
                // Refresh the status labels so the row flips to
                // "not signed in" without reopening the picker.
                if let Some(p) = app.picker.as_mut() {
                    for item in &mut p.items {
                        if item.value == name {
                            item.hint = Some("not signed in".to_string());
                        }
                    }
                }
            }
            // Collection picker: Space toggles the selected plugin, Enter hands
            // the checked set to the loop (see `plugin_select_request`). Rows
            // already installed stay displayed but are not toggleable -- checking
            // one and pressing Enter would make the batch install skip everything
            // and error with "nothing installed". A Space on such a row is a
            // no-op note so the confusion stays out.
            KeyCode::Char(' ') if picker.kind == PickerKind::PluginSelect => {
                let already_installed =
                    picker.items[picker.selected].hint.as_deref() == Some(INSTALLED_HINT);
                if already_installed {
                    app.note("already installed - nothing to install");
                } else {
                    let item = &mut picker.items[picker.selected];
                    item.checkbox = Some(!item.checkbox.unwrap_or(false));
                }
            }
            KeyCode::Enter if picker.kind == PickerKind::PluginSelect => {
                let paths: Vec<String> = picker
                    .items
                    .iter()
                    .filter(|i| i.checkbox.unwrap_or(false))
                    .map(|i| i.value.clone())
                    .collect();
                app.picker = None;
                if paths.is_empty() {
                    app.note("no plugin selected - install aborted");
                } else if let Some(url) = app.plugin_collection_url.take() {
                    app.note(&format!("installing {} plugin(s)...", paths.len()));
                    app.plugin_select_request = Some((url, paths));
                }
            }
            KeyCode::Enter => {
                let kind = picker.kind;
                let value = picker.items[picker.selected].value.clone();
                app.picker = None;
                match kind {
                    PickerKind::ResumeThread | PickerKind::ThreadTree => {
                        resume_thread(app, &value).await
                    }
                    PickerKind::LoginProvider => {
                        if value == "tokamak" {
                            open_login(app);
                        } else {
                            open_login_prompt(app, &value);
                        }
                    }
                    PickerKind::ToggleMcp => {}
                    PickerKind::RewindMessage => {
                        if let Ok(idx) = value.parse::<usize>() {
                            open_rewind_scope(app, idx);
                        }
                    }
                    PickerKind::ForkMessage => {
                        if let Ok(idx) = value.parse::<usize>() {
                            fork_at(app, idx).await;
                        }
                    }
                    PickerKind::RewindScope => {
                        if let Some(idx) = app.rewind_target.take() {
                            rewind_to(app, idx, value == "workspace");
                        }
                    }
                    PickerKind::ViewConfig => {}
                    // `/settings`: open the edit dock for the selected row,
                    // or the provider screen for the leading "providers" row.
                    PickerKind::AgentSettings => {
                        if value == PROVIDERS_SETTINGS_ROW {
                            open_provider_settings(app);
                        } else if let Some(def) =
                            AGENT_SETTINGS.iter().find(|d| d.key == value)
                        {
                            let toml_path = app.agent_dir.join("agent.toml");
                            let current = current_setting_value(def, &toml_path);
                            app.settings_prompt =
                                Some(SettingsPrompt::new(def, current.as_deref()));
                        }
                    }
                    // `/settings > providers`: open the wizard for the row.
                    PickerKind::ProviderSettings => {
                        let entry = crate::core::agent::global_config::load_global_config()
                            .ok()
                            .and_then(|c| c.get(&value).cloned());
                        if let Some(entry) = entry {
                            app.provider_prompt = Some(ProviderPrompt::from_entry(&entry));
                        }
                    }
                    // Todo Enter is handled by the guarded action arm above.
                    PickerKind::Todo => {}
                    // PluginSelect Enter is handled by the guarded arm above.
                    PickerKind::PluginSelect => {}
                    // McpServer Enter is handled by the guarded arm above.
                    PickerKind::McpServer => {}
                    // Agents Enter is handled by the guarded arm above; the
                    // detail has no Enter action of its own.
                    PickerKind::Agents | PickerKind::AgentDetail | PickerKind::BackgroundShells => {}
                }
            }
            // Esc on the detail screen steps back to the server list rather
            // than closing outright: the detail is one level *inside* `/mcp`,
            // and dropping the user to the prompt loses the place they were at.
            // When a sign-in is in flight for this server, Esc cancels it first
            // (the loop owns the job handle, so it does the actual abort) and
            // keeps the screen open.
            KeyCode::Esc | KeyCode::Char('q') if !ctrl && picker.kind == PickerKind::McpServer => {
                let signing_in = app
                    .mcp_detail
                    .as_ref()
                    .zip(app.mcp_auth.as_ref())
                    .is_some_and(|(d, f)| d.server.name == f.server);
                if signing_in {
                    app.mcp_auth_cancel = true;
                } else {
                    open_mcp_picker(app, mcp_servers).await;
                }
            }
            // Esc on a subagent's detail steps back to the `/agents` list, one
            // level up, rather than closing the inspector outright.
            KeyCode::Esc | KeyCode::Char('q') if !ctrl && picker.kind == PickerKind::AgentDetail => {
                picker.kind = PickerKind::Agents;
                app.agent_detail = None;
            }
            KeyCode::Esc | KeyCode::Char('q') if !ctrl => {
                app.plugin_collection_url = None;
                app.picker = None;
                app.mcp_detail = None;
                app.agent_detail = None;
            }
            _ if ctrl_c || ctrl_d => {
                app.plugin_collection_url = None;
                app.picker = None;
                app.mcp_detail = None;
                app.agent_detail = None;
            }
            _ => {}
        }
        return;
    }
    if ctrl_c || ctrl_d {
        if app.status == Status::Running {
            // Cancel-first: an in-flight task is what Ctrl-C interrupts, and
            // the session stays open with the partial turn intact.
            abort_run(current);
            app.cancel_run();
            app.exit_armed = false;
        } else if !app.input.trim().is_empty() {
            // Idle with something typed: clear the draft rather than quit, and
            // keep it in recall history so Up brings it back.
            app.record_draft();
            app.input_clear();
            app.exit_armed = false;
        } else if app.exit_armed {
            app.should_quit = true;
        } else {
            // Blank and idle: leaving takes a deliberate second Ctrl-C/Ctrl-D.
            app.exit_armed = true;
            app.system(Level::Warn, "press Ctrl-C or Ctrl-D again to quit");
        }
        return;
    }

    // Slash-command hint popup: while typing a `/command` name (idle, no space
    // yet) with at least one match, it owns Up/Down/Tab/Esc and Enter-to-accept.
    // Enter on a fully-typed command falls through to run it; typed chars fall
    // through to normal editing (which re-filters the popup live).
    if !app.slash_matches().is_empty() {
        match key.code {
            KeyCode::Up => {
                app.slash_move(-1);
                return;
            }
            KeyCode::Down => {
                app.slash_move(1);
                return;
            }
            KeyCode::Tab => {
                app.accept_slash();
                return;
            }
            KeyCode::Esc => {
                app.slash_dismissed = true;
                return;
            }
            KeyCode::Enter if !newline => {
                let matches = app.slash_matches();
                let sel = app.slash_selected.min(matches.len() - 1);
                if app.input.trim() != matches[sel].name() {
                    app.accept_slash();
                    return;
                }
                // Exact match: fall through to the normal Enter path to run it.
            }
            _ => {}
        }
    }

    // Path-hint popup: while `@query` is active with at least one match,
    // it owns Up/Down/Tab/Esc/Enter in the same pattern as slash hints.
    if app.has_path_hints() {
        match key.code {
            KeyCode::Up => {
                app.path_hint_move(-1);
                return;
            }
            KeyCode::Down => {
                app.path_hint_move(1);
                return;
            }
            KeyCode::Tab | KeyCode::Enter if !newline => {
                app.accept_path_hint();
                return;
            }
            KeyCode::Esc => {
                app.path_hint_dismissed = true;
                app.path_hints.clear();
                return;
            }
            _ => {}
        }
    }

    // Any composer key that isn't the blank-idle Ctrl-C means composing has
    // resumed, so it disarms a pending second-Ctrl-C exit.
    app.exit_armed = false;

    match key.code {
        KeyCode::Esc => {
            // Esc cancels a run or clears typed input; it never quits (that's
            // Ctrl-D / Ctrl-C when idle), so a stray Esc can't close the app.
            if app.status == Status::Running {
                abort_run(current);
                app.cancel_run();
                app.last_esc = None;
            } else if app.goal_evaluating {
                // The chat loop aborts the evaluation call.
                app.goal_eval_cancel = true;
                app.last_esc = None;
            } else {
                // A second idle Esc within the window opens the rewind picker;
                // a lone Esc clears the input as before.
                let double = app
                    .last_esc
                    .is_some_and(|t| t.elapsed() < Duration::from_millis(600));
                if double {
                    app.last_esc = None;
                    open_rewind_picker(app);
                } else {
                    app.last_esc = Some(Instant::now());
                    // Keep what was typed so Up brings it back.
                    app.record_draft();
                    app.input_clear();
                }
            }
        }
        // Alt+Enter, Shift+Enter or Ctrl+J insert a newline for multi-line
        // input; plain Enter submits. Shift+Enter only reaches us from a
        // terminal that disambiguates it (kitty keyboard protocol / CSI-u);
        // the other two work everywhere.
        KeyCode::Enter if newline => {
            app.input_insert('\n');
        }
        KeyCode::Char('j') if ctrl => {
            app.input_insert('\n');
        }
        // Ctrl-O expands/collapses all folded regions (tool groups and reasoning
        // blocks), scrolling the latest into view.
        KeyCode::Char('o') if ctrl => {
            app.toggle_regions();
        }
        // Alt+T toggles reasoning effort between "low" and the last non-low
        // level (default medium). A quick way to quiet or deepen a model run
        // without typing the full `/effort` command.
        KeyCode::Char('t') if alt => {
            app.toggle_reasoning_effort();
        }
        // Ctrl-V stages an image from the OS clipboard (terminal paste is
        // text-only, so we read the clipboard directly) for the next message.
        KeyCode::Char('v') if ctrl => {
            app.attach_clipboard_image();
        }
        // Readline editing keys, so the composer behaves like the shell the
        // user just came from. Motion and word-kills are line-wise because the
        // buffer is multi-line.
        KeyCode::Char('a') if ctrl => app.cursor_line_start(),
        KeyCode::Char('e') if ctrl => app.cursor_line_end(),
        KeyCode::Char('b') if ctrl => app.cursor_left(),
        KeyCode::Char('f') if ctrl => app.cursor_right(),
        KeyCode::Char('h') if ctrl => app.input_backspace(),
        KeyCode::Char('w') if ctrl => app.delete_unix_word_left(),
        KeyCode::Char('u') if ctrl => app.delete_to_line_start(),
        KeyCode::Char('k') if ctrl => app.delete_to_line_end(),
        KeyCode::Char('t') if ctrl => app.transpose_chars(),
        // Ctrl-P/Ctrl-N are Up/Down's shell spelling; recall declines when
        // there is nothing to recall, and unlike the arrows they never fall
        // through to scrolling.
        KeyCode::Char('p') if ctrl => {
            app.recall_prev();
        }
        KeyCode::Char('n') if ctrl => {
            app.recall_next();
        }
        KeyCode::Char('b') if alt => app.cursor_word_left(),
        KeyCode::Char('f') if alt => app.cursor_word_right(),
        KeyCode::Char('d') if alt => app.delete_word_right(),
        KeyCode::Enter => {
            let text = app.input.trim().to_string();
            app.input_clear();
            if !text.is_empty() {
                app.record_submitted(&text);
                if let Some(cmd) = text.strip_prefix('/') {
                    run_command(app, cmd, mcp_servers).await;
                } else if let Some(cmd) = text.strip_prefix('!') {
                    app.submit_shell(cmd.trim());
                } else {
                    app.submit_user(text);
                }
            }
        }
        // Cmd (SUPER) is line-wise, Alt/Ctrl word-wise, bare char-wise. SUPER
        // only arrives from a terminal with the keyboard enhancement flags on,
        // so the macOS Cmd bindings degrade to nothing rather than misfiring.
        KeyCode::Backspace if sup => {
            app.delete_to_line_start();
        }
        KeyCode::Backspace if alt || ctrl => {
            app.delete_word_left();
        }
        KeyCode::Backspace => {
            app.input_backspace();
        }
        KeyCode::Delete if alt || ctrl => {
            app.delete_word_right();
        }
        KeyCode::Delete => {
            app.input_delete();
        }
        KeyCode::Left if sup => {
            app.cursor_line_start();
        }
        KeyCode::Left if alt || ctrl => {
            app.cursor_word_left();
        }
        KeyCode::Left => {
            app.cursor_left();
        }
        KeyCode::Right if sup => {
            app.cursor_line_end();
        }
        KeyCode::Right if alt || ctrl => {
            app.cursor_word_right();
        }
        KeyCode::Right => {
            app.cursor_right();
        }
        KeyCode::Home => {
            app.cursor_line_start();
        }
        // Shift+Tab (crossterm sends it as BackTab, not Tab+SHIFT) cycles
        // reasoning effort low -> medium -> high -> low, matching Claude Code.
        KeyCode::BackTab => {
            app.cycle_reasoning_effort();
        }
        KeyCode::End => {
            app.cursor_line_end();
        }
        // Tab is a no-op in normal input mode; slash-command and path-hint
        // popups intercept it before reaching this arm.
        KeyCode::Tab => {}
        KeyCode::Char(c) if !ctrl => {
            app.input_insert(c);
        }
        // Up/Down recall submitted messages into the composer when there is
        // something to recall; otherwise they scroll the transcript as before.
        // PageUp/PageDown always scroll, so scrollback is never unreachable.
        KeyCode::Up | KeyCode::PageUp => {
            if key.code == KeyCode::Up && app.recall_prev() {
                return;
            }
            let step = if key.code == KeyCode::PageUp { 10 } else { 1 };
            app.scrollback = app.scrollback.saturating_add(step);
        }
        KeyCode::Down | KeyCode::PageDown => {
            if key.code == KeyCode::Down && app.recall_next() {
                return;
            }
            let step = if key.code == KeyCode::PageDown { 10 } else { 1 };
            app.scrollback = app.scrollback.saturating_sub(step);
        }
        _ => {}
    }
}

pub(super) async fn deny(registry: &PermissionRegistry, request_id: &str) {
    if let Some(sender) = registry.lock().await.remove(request_id) {
        let _ = sender.send(PermissionDecision::Deny);
    }
}

pub(super) fn abort_run(current: &mut Option<CurrentRun>) {
    if let Some(c) = current.take() {
        c.handle.abort();
    }
}

/// Every keybinding worth advertising, as `(keys, description)`. Single source
/// of truth for the `/help` listing and the first-run footer hint, so the two
/// can't drift. Deliberately not rendered on every frame -- the footer is for
/// transient state (running, prompts, pickers), not a permanent cheat sheet.
/// A word character for the emacs-style motions (Alt+B/F/D, Alt+Backspace,
/// Ctrl/Alt+arrows), matching readline: alphanumerics plus `_`.
pub(super) fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Byte offset of the emacs word boundary before `at`: skip any run of
/// non-word chars, then the word itself, so `"foo bar"` with the caret at the
/// end lands on `b` and `"foo   "` lands on 0.
pub(super) fn prev_word_start(s: &str, at: usize) -> usize {
    let mut i = at;
    let mut in_word = false;
    while let Some(c) = s[..i].chars().next_back() {
        if is_word_char(c) {
            in_word = true;
        } else if in_word {
            break;
        }
        i -= c.len_utf8();
    }
    i
}

/// The mirror of [`prev_word_start`], scanning forward from `at`.
pub(super) fn next_word_end(s: &str, at: usize) -> usize {
    let mut i = at;
    let mut in_word = false;
    while let Some(c) = s[i..].chars().next() {
        if is_word_char(c) {
            in_word = true;
        } else if in_word {
            break;
        }
        i += c.len_utf8();
    }
    i
}

/// `Ctrl-W`'s boundary: whitespace-delimited, like the shell's
/// unix-word-rubout, so it takes a whole `src/core/cli/tui.rs` token rather
/// than stopping at every `/`.
pub(super) fn prev_unix_word_start(s: &str, at: usize) -> usize {
    let mut i = at;
    for stop_on_space in [false, true] {
        while let Some(c) = s[..i].chars().next_back() {
            if c.is_whitespace() == stop_on_space {
                break;
            }
            i -= c.len_utf8();
        }
    }
    i
}

/// Byte offsets bounding the line `at` sits on, newlines excluded. The
/// composer is multi-line (Alt/Shift+Enter), so "line" is not the whole buffer.
pub(super) fn line_bounds(s: &str, at: usize) -> (usize, usize) {
    let start = s[..at].rfind('\n').map_or(0, |i| i + 1);
    let end = s[at..].find('\n').map_or(s.len(), |i| at + i);
    (start, end)
}

pub(super) fn handle_settings_key(app: &mut App, key: KeyEvent, ctrl: bool) {
    if (key.code == KeyCode::Esc || (ctrl && key.code == KeyCode::Char('c')))
        && app.settings_prompt.is_some()
    {
        app.settings_prompt = None;
        return;
    }
    let Some(prompt) = app.settings_prompt.as_mut() else {
        return;
    };
    match key.code {
        KeyCode::Enter => {
            let toml_path = app.agent_dir.join("agent.toml");
            let value: Option<toml_edit::Item> = match prompt.def().kind {
                AgentSettingKind::Int { default, min } => {
                    match parse_int_setting(&prompt.input, default, min) {
                        Ok(v) => v.map(toml_edit::value),
                        Err(err) => {
                            prompt.error = Some(err);
                            return;
                        }
                    }
                }
                AgentSettingKind::Glyph { .. } => {
                    // Not trimmed to empty-means-unset like `Text`: a cleared
                    // field writes `""`, which is the off switch. `x` on the
                    // row is how you get back to the default.
                    let input = prompt.input.trim();
                    if let Some(err) = crate::core::agent::global_config::wave_error(input) {
                        prompt.error = Some(err);
                        return;
                    }
                    Some(toml_edit::value(input.to_string()))
                }
                AgentSettingKind::Text { .. } => (!prompt.input.trim().is_empty())
                    .then(|| toml_edit::value(prompt.input.trim().to_string())),
                AgentSettingKind::Enum { options, default } => {
                    let input = prompt.input.trim();
                    if input.is_empty() {
                        None
                    } else if options.contains(&input) {
                        Some(toml_edit::value(input.to_string()))
                    } else {
                        prompt.error = Some(format!(
                            "must be one of: {} (default: {default})",
                            options.join(" | ")
                        ));
                        return;
                    }
                }
                AgentSettingKind::Bool { default } => {
                    let input = prompt.input.trim();
                    if input.is_empty() {
                        None
                    } else if let Ok(b) = input.parse::<bool>() {
                        Some(toml_edit::value(b))
                    } else {
                        prompt.error = Some(format!("must be true or false (default: {default})"));
                        return;
                    }
                }
            };
            match write_setting(prompt.def(), &toml_path, value) {
                Ok(()) => {
                    let entered = prompt.input.trim().to_string();
                    let glyph_kind = matches!(prompt.def().kind, AgentSettingKind::Glyph { .. });
                    let what = match (entered.is_empty(), glyph_kind) {
                        // A cleared glyph is a written value, not an unset, so
                        // saying "default applies" would be a lie.
                        (true, true) => format!("{} off (throbber)", prompt.key),
                        (true, false) => format!("{} unset (default applies)", prompt.key),
                        (false, _) => format!("{} = {entered} written", prompt.key),
                    };
                    let when = if apply_live_setting(prompt.def(), &entered) {
                        "in effect now"
                    } else {
                        "takes effect on the next run"
                    };
                    app.note(&format!("{what}; {when}"));
                    app.settings_prompt = None;
                }
                Err(e) => {
                    let path = setting_path(prompt.def(), &toml_path);
                    prompt.error = Some(format!("failed to write {path}: {e}"));
                }
            }
        }
        KeyCode::Backspace => {
            // Whole cluster for a glyph field: popping one `char` off `👁️`
            // leaves `👁`, so the row looks unchanged and the key reads as
            // broken. Other kinds keep the plain char pop.
            if matches!(prompt.def().kind, AgentSettingKind::Glyph { .. }) {
                let keep =
                    crate::core::agent::global_config::wave_len(&prompt.input).saturating_sub(1);
                prompt.input = grapheme_prefix(&prompt.input, keep);
            } else {
                prompt.input.pop();
            }
        }
        KeyCode::Char(ch) if !ctrl => {
            prompt.input.push(ch);
            // Checked on the result rather than by counting up: a skin-tone
            // modifier or ZWJ joins the cluster before it, so the string can
            // grow by a `char` without growing by a grapheme, and that must
            // still be allowed at the cap.
            if let AgentSettingKind::Glyph { max, .. } = prompt.def().kind {
                if crate::core::agent::global_config::wave_len(&prompt.input) > max {
                    prompt.input.pop();
                }
            }
        }
        _ => {}
    }
}

/// Keyboard for the MCP add/edit wizard: Up/Down move between fields, chars/
/// backspace edit the current text field, Space toggles the transport/active
/// rows, Enter saves and connects, Esc cancels. Only arrow keys steer: `k`/`j`
/// are ordinary characters in these fields (URLs, paths), so they always type.
#[allow(clippy::too_many_lines)]
pub(super) async fn handle_mcp_prompt_key(
    app: &mut App,
    key: KeyEvent,
    ctrl: bool,
    mcp_servers: &crate::core::state::SharedMcpServers,
) {
    if (key.code == KeyCode::Esc || (ctrl && key.code == KeyCode::Char('c')))
        && app.mcp_prompt.is_some()
    {
        app.mcp_prompt = None;
        return;
    }
    let Some(prompt) = app.mcp_prompt.as_mut() else {
        return;
    };
    match key.code {
        KeyCode::Up => prompt.prev_field(),
        KeyCode::Down => prompt.next_field(),
        KeyCode::Tab => prompt.next_field(),
        KeyCode::Enter => {
            // Take the prompt out so `save` can borrow `app` freely for notes
            // and put it back on error.
            let mut taken = app.mcp_prompt.take().expect("prompt is Some");
            match taken.save(mcp_servers).await {
                Ok(()) => {
                    let name = taken.name.trim().to_string();
                    app.note(&format!("saved MCP server '{name}'"));
                }
                Err(e) => {
                    taken.error = Some(e);
                    app.mcp_prompt = Some(taken);
                }
            }
        }
        KeyCode::Char(' ') | KeyCode::Left | KeyCode::Right => {
            match prompt.field {
                McpField::Transport => {
                    prompt.transport = if prompt.transport == "stdio" {
                        "http".to_string()
                    } else {
                        "stdio".to_string()
                    };
                    // Reset to a valid field for the new transport.
                    prompt.field = prompt.visible_fields()[0];
                }
                McpField::Active => prompt.active = !prompt.active,
                _ => {}
            }
        }
        KeyCode::Backspace => match prompt.field {
            // Renaming an entry on edit would leave the old one behind, so the
            // name is fixed while editing.
            McpField::Name if prompt.editing.is_none() => {
                prompt.name.pop();
            }
            McpField::Command => {
                prompt.command.pop();
            }
            McpField::Args => {
                prompt.args.pop();
            }
            McpField::Env => {
                prompt.env.pop();
            }
            McpField::Url => {
                prompt.url.pop();
            }
            McpField::Headers => {
                prompt.headers.pop();
            }
            _ => {}
        },
        KeyCode::Char(ch) if !ctrl => match prompt.field {
            McpField::Name if prompt.editing.is_none() => prompt.name.push(ch),
            McpField::Command => prompt.command.push(ch),
            McpField::Args => prompt.args.push(ch),
            McpField::Env => prompt.env.push(ch),
            McpField::Url => prompt.url.push(ch),
            McpField::Headers => prompt.headers.push(ch),
            _ => {}
        },
        _ => {}
    }
}

/// Keyboard for the provider add/edit wizard: Up/Down move between fields,
/// chars/backspace edit the current field, Enter saves, Esc cancels. The API
/// key field masks what is typed (see `ProviderPrompt::masked_key`). Only
/// arrow keys steer: `k`/`j` are ordinary characters in these fields (API keys
/// start with `sk-...`), so they always type.
pub(super) fn handle_provider_prompt_key(app: &mut App, key: KeyEvent, ctrl: bool) {
    if (key.code == KeyCode::Esc || (ctrl && key.code == KeyCode::Char('c')))
        && app.provider_prompt.is_some()
    {
        app.provider_prompt = None;
        return;
    }
    let Some(prompt) = app.provider_prompt.as_mut() else {
        return;
    };
    match key.code {
        KeyCode::Up => prompt.prev_field(),
        KeyCode::Down => prompt.next_field(),
        KeyCode::Tab => prompt.next_field(),
        // Left/Right toggle the wire API type while that field is selected.
        KeyCode::Left | KeyCode::Right if prompt.field == ProviderField::ApiType => {
            prompt.toggle_api_type();
        }
        KeyCode::Enter => {
            // Take the prompt out so `save` can borrow `app` freely for notes
            // and put it back on error.
            let mut taken = app.provider_prompt.take().expect("prompt is Some");
            match taken.save() {
                Ok(()) => {
                    let name = taken.name.trim().to_string();
                    if taken.editing.is_some() {
                        app.note(&format!("updated provider '{name}'"));
                    } else {
                        app.note(&format!("added provider '{name}'"));
                    }
                }
                Err(e) => {
                    taken.error = Some(e);
                    app.provider_prompt = Some(taken);
                }
            }
        }
        KeyCode::Backspace => {
            if prompt.editing.is_some() && prompt.field == ProviderField::Name {
                return;
            }
            match prompt.field {
                ProviderField::Name => {
                    prompt.name.pop();
                }
                ProviderField::BaseUrl => {
                    prompt.base_url.pop();
                }
                ProviderField::ApiType => {}
                ProviderField::ApiKey => {
                    prompt.api_key.pop();
                    prompt.key_touched = true;
                }
                ProviderField::Models => {
                    prompt.models.pop();
                }
            }
        }
        KeyCode::Char(ch) if !ctrl => match prompt.field {
            ProviderField::Name if prompt.editing.is_some() => {}
            ProviderField::Name => prompt.name.push(ch),
            ProviderField::BaseUrl => prompt.base_url.push(ch),
            ProviderField::ApiType => {}
            ProviderField::ApiKey => {
                prompt.api_key.push(ch);
                prompt.key_touched = true;
            }
            ProviderField::Models => prompt.models.push(ch),
        },
        _ => {}
    }
}
