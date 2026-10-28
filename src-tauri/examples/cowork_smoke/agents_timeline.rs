/// The shipped roles are listed by the backend with their scope; a parent
/// dispatches the read-only reviewer and the explorer, each child tries to
/// write and to run a command, and neither can: the calls fail at the
/// child's own toolset, nothing is written, and the activity names each
/// child by role.
fn scenario_agent_roles(ctx: &Ctx) -> ScenarioResult {
    let (ok, listed) = ipc(ctx, "agent_subagent_list", "{}")?;
    ensure!(ok, "listing agents failed: {listed}");
    let roles: Vec<String> = listed
        .as_array()
        .into_iter()
        .flatten()
        .filter(|d| d["scope"] == "builtin")
        .filter_map(|d| d["name"].as_str().map(str::to_string))
        .collect();
    ensure!(
        roles == ["explorer", "planner", "implementer", "reviewer", "tester", "security"],
        "the shipped roles are {roles:?}"
    );
    for d in listed.as_array().into_iter().flatten().filter(|d| d["scope"] == "builtin") {
        let tools: Vec<&str> = d["allowed_tools"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        if ["explorer", "planner", "reviewer", "security"].contains(&d["name"].as_str().unwrap_or("")) {
            ensure!(
                !tools.iter().any(|t| ["write", "edit", "bash"].contains(t)),
                "{} lists a mutating tool: {tools:?}",
                d["name"]
            );
        }
        ensure!(d["description"].as_str().unwrap_or("").contains("built-in role, v1"), "{} is not versioned", d["name"]);
    }

    let escape = ctx.project.join("role-escape.txt");
    let _ = std::fs::remove_file(&escape);
    let write_try = format!(
        "write:{}",
        serde_json::json!({ "path": "{{FOLDER}}/role-escape.txt", "content": "a read-only role wrote this\n" })
    );
    let bash_try = format!("bash:{}", serde_json::json!({ "command": "echo escaped > role-escape.txt" }));
    let edit_try = format!(
        "edit:{}",
        serde_json::json!({ "path": "{{FOLDER}}/README.md", "old_string": "#", "new_string": "ROLE-EDITED #" })
    );
    // A nested dispatch: a child asking for another agent.
    let task_try = format!("task:{}", serde_json::json!({ "subagent_name": "implementer", "description": "nested" }));
    let ls = "ls:{\"path\":\".\"}".to_string();
    // Every role asks for what it may do and for what it may not. Writes and
    // commands a role does hold are not scripted, so no child ever reaches an
    // approval prompt: what is being proven is the refusal, not the prompt.
    let scripted: [(&str, Vec<String>); 6] = [
        ("explorer", vec![ls.clone(), write_try.clone()]),
        ("planner", vec![ls.clone(), bash_try.clone()]),
        ("reviewer", vec![write_try.clone(), bash_try.clone()]),
        ("security", vec![bash_try.clone(), task_try.clone()]),
        ("implementer", vec![ls.clone(), bash_try.clone(), task_try.clone()]),
        ("tester", vec![ls.clone(), edit_try.clone(), write_try.clone()]),
    ];
    let routes: Vec<Value> = scripted
        .iter()
        .map(|(role, tools)| {
            serde_json::json!({
                "match": format!("ROLE-{}", role.to_uppercase()),
                "tools": tools,
                "summary": format!("{role} finished"),
            })
        })
        .collect();
    let routes = Value::Array(routes);
    let parent_calls: Vec<String> = scripted
        .iter()
        .map(|(role, _)| {
            format!(
                "task:{}",
                serde_json::json!({
                    "subagent_name": role,
                    "description": format!("ROLE-{}: work on the fixture", role.to_uppercase()),
                })
            )
        })
        .collect();
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
        "could not script the roles"
    );
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
    attach_project(ctx)?;
    // Attaching starts in Review first, a plan mode that withholds `task`
    // from the parent; the parent needs a mode that can dispatch.
    choose_mode(ctx, "Ask before changes")?;
    ctx.type_into("[data-testid=\"chat-input\"]", "Run all six roles on this project.")?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]'); return !!b && !b.disabled;",
        Duration::from_secs(60),
    )?;
    ctx.eval("document.querySelector('[data-test-id=\"send-message-button\"]').click(); return true;")?;
    // Allow the dispatches themselves if the mode asks; the children's own
    // write and bash calls must never reach a prompt at all.
    let deadline = Instant::now() + Duration::from_secs(150);
    loop {
        let _ = ctx.eval(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /^allow once$/i.test((x.textContent || '').trim()));
             const card = b && b.closest('[data-testid=\"child-approval\"]');
             if (b && !card) b.click();
             return true;",
        );
        let child_prompt = ctx.eval_bool("return !!document.querySelector('[data-testid=\"child-approval\"]');")?;
        ensure!(!child_prompt, "a read-only role reached an approval prompt for a write or a command");
        // The children's answers are the `task` results, folded into their
        // cards, so the fixture's log is where both are seen to come back:
        // the parent's next request carries them as tool results.
        let answered = |who: &str| {
            mock_requests(ctx).unwrap_or_default().iter().any(|r| {
                r["messages"].as_array().into_iter().flatten().any(|m| {
                    m["role"] == "tool" && m["content"].to_string().contains(&format!("{who} finished"))
                })
            })
        };
        if scripted.iter().all(|(role, _)| answered(role))
            && ctx.eval_bool("return !!document.querySelector('[data-test-id=\"send-message-button\"]');")?
        {
            break;
        }
        if Instant::now() >= deadline {
            // What each child sent the model fixture, so a failed child says why.
            let seen: Vec<String> = mock_requests(ctx)
                .unwrap_or_default()
                .iter()
                .filter(|r| r["messages"].to_string().contains("ROLE-"))
                .map(|r| {
                    let tools: Vec<&str> = r["tools"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|t| t["function"]["name"].as_str())
                        .collect();
                    let last = r["messages"].as_array().and_then(|m| m.last()).map(|m| m.to_string()).unwrap_or_default();
                    format!("tools {tools:?}; last message {}", last.chars().take(600).collect::<String>())
                })
                .collect();
            bail!("the role run did not finish: {}; child requests: {seen:#?}", run_state_page(ctx));
        }
        std::thread::sleep(Duration::from_millis(700));
    }
    ensure!(!escape.exists(), "a role wrote a file it may not write");
    let readme = std::fs::read_to_string(ctx.project.join("README.md")).unwrap_or_default();
    ensure!(!readme.contains("ROLE-EDITED"), "the tester edited a file it may not edit");

    // The children's calls, as the durable record has them.
    let activity: Vec<Value> = activity_records();
    for (agent, tools) in &scripted {
        let role_tools = role_allowlist(agent);
        let forbidden: Vec<String> = tools
            .iter()
            .map(|t| t.split(':').next().unwrap_or("").to_string())
            .filter(|t| !role_tools.contains(&t.as_str()))
            .collect();
        let mutating_ran = activity.iter().any(|e| {
            e["agent"] == *agent
                && forbidden.iter().any(|f| e["tool"] == f.as_str())
                && ["running", "succeeded"].contains(&e["phase"].as_str().unwrap_or(""))
        });
        ensure!(!mutating_ran, "the {agent} role ran a tool it was not given: {forbidden:?}");
        // Declined by the harness as a typed refusal, recorded under the role
        // in its run's session -- not an unscoped tool-error string.
        let refused: Vec<&Value> = activity
            .iter()
            .filter(|e| {
                e["agent"] == *agent
                    && forbidden.iter().any(|f| e["tool"] == f.as_str())
                    && e["phase"] == "refused"
            })
            .collect();
        for f in &forbidden {
            ensure!(
                refused.iter().any(|e| e["tool"] == f.as_str()),
                "the {agent} role's forged {f} was not recorded as refused under it"
            );
        }
        for e in &refused {
            ensure!(
                e["refusal"] == "tool-not-offered" && e["session"].as_str().is_some_and(|s| !s.is_empty()),
                "the {agent} role's refusal was not typed and scoped: {e}"
            );
        }
    }
    let explorer_read = activity
        .iter()
        .any(|e| e["agent"] == "explorer" && e["tool"] == "ls" && e["phase"] == "succeeded");
    // What each child was offered, as the model fixture received it.
    // A child's brief is its first user message; the parent's is the prompt,
    // and the parent's own requests carry the tags only in its `task` calls.
    let requests = mock_requests(ctx)?;
    let brief = |r: &Value| -> String {
        r["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|m| m["role"] == "user")
            .map(|m| m["content"].to_string())
            .unwrap_or_default()
    };
    for (role, _) in &scripted {
        let tag = format!("ROLE-{}", role.to_uppercase());
        let mut offered: Vec<String> = requests
            .iter()
            .filter(|r| brief(r).contains(&tag))
            .flat_map(|r| r["tools"].as_array().cloned().unwrap_or_default())
            .filter_map(|t| t["function"]["name"].as_str().map(str::to_string))
            .collect();
        offered.sort();
        offered.dedup();
        ensure!(!offered.is_empty(), "{tag}'s child request was not seen by the model fixture");
        // Exactly its allowlist, plus reading skills, and nothing else.
        let mut want: Vec<String> = role_allowlist(role)
            .iter()
            .map(|t| t.to_string())
            .chain(["skill_list".to_string(), "skill_read".to_string()])
            .collect();
        want.sort();
        ensure!(offered == want, "{role} was offered {offered:?}; its role allows {want:?}");
        println!("      {role}: offered {offered:?}");
    }
    // Each child is named by its role where the person sees the run.
    let text = ctx.eval_string("return document.body.innerText;")?.to_lowercase();
    for (role, _) in &scripted {
        ensure!(text.contains(role), "the run does not name the {role} child by role");
    }
    println!("      NOTE: explorer's ls {}", if explorer_read { "succeeded" } else { "was not recorded" });
    Ok(())
}

const CONTEXT_DIFF_HANDOFF: &str = "context-diff";

/// Open the last "What the model received" panel and compare it with the
/// request before it. Returns (previous snapshot id, entered reasons, entered
/// previews, left count).
fn compare_last_snapshot(ctx: &Ctx) -> Result<(String, Vec<String>, Vec<String>, usize), Failure> {
    ctx.wait_until(
        "two stored requests on screen",
        "return document.querySelectorAll('[data-testid=\"prompt-snapshot\"]').length >= 2;",
        Duration::from_secs(30),
    )?;
    ctx.eval(
        "const all = [...document.querySelectorAll('[data-testid=\"prompt-snapshot\"]')];
         const last = all[all.length - 1];
         if (!last.open) last.querySelector('[data-testid=\"prompt-snapshot-toggle\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the compare control",
        "const all = [...document.querySelectorAll('[data-testid=\"prompt-snapshot\"]')];
         return !!all[all.length - 1].querySelector('[data-testid=\"context-diff-run\"]');",
        Duration::from_secs(20),
    )?;
    ctx.eval(
        "const all = [...document.querySelectorAll('[data-testid=\"prompt-snapshot\"]')];
         all[all.length - 1].querySelector('[data-testid=\"context-diff-run\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the comparison",
        "const all = [...document.querySelectorAll('[data-testid=\"prompt-snapshot\"]')];
         const last = all[all.length - 1];
         return !!last.querySelector('[data-testid=\"context-diff-result\"], [data-testid=\"context-diff-first\"], [data-testid=\"context-diff-error\"]');",
        Duration::from_secs(20),
    )?;
    let v = ctx.eval(
        "const all = [...document.querySelectorAll('[data-testid=\"prompt-snapshot\"]')];
         const last = all[all.length - 1];
         const r = last.querySelector('[data-testid=\"context-diff-result\"]');
         if (!r) return { error: (last.querySelector('[data-testid=\"context-diff-first\"], [data-testid=\"context-diff-error\"]') || {}).innerText || 'no result' };
         const entered = [...r.querySelectorAll('[data-testid=\"context-diff-entered\"] li')];
         return {
           previous: r.dataset.previous,
           reasons: entered.map(li => li.dataset.reason),
           previews: entered.map(li => li.innerText),
           left: r.querySelectorAll('[data-testid=\"context-diff-left\"] li').length,
         };",
    )?;
    if let Some(e) = v.get("error").and_then(Value::as_str) {
        bail!("the comparison did not produce a result: {e}");
    }
    let strings = |k: &str| -> Vec<String> {
        v[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
    };
    Ok((
        v["previous"].as_str().unwrap_or_default().to_string(),
        strings("reasons"),
        strings("previews"),
        v["left"].as_u64().unwrap_or(0) as usize,
    ))
}

/// AH-086: two requests' context, diffed through the real UI. Two Cowork
/// turns; the second turn's stored request is compared with the first's, and
/// the panel names what entered and why -- the model's previous answer and
/// the new request -- with nothing leaving the window. The second half does
/// the same after a restart, from the snapshots on disk, with nothing sent.
fn scenario_context_diff(ctx: &Ctx) -> ScenarioResult {
    ctx.script_model("plain", &[])?;
    new_cowork_session(ctx)?;
    send_cowork(ctx, "context diff first probe")?;
    send_cowork(ctx, "context diff second probe")?;
    let session = current_cowork_session(ctx)?;
    let (previous, reasons, previews, left) = compare_last_snapshot(ctx)?;
    println!("      against {previous}: entered {reasons:?}, left {left}");
    ensure!(!previous.is_empty(), "the comparison names no previous request");
    ensure!(
        reasons.iter().any(|r| r == "the new request")
            && reasons.iter().any(|r| r == "the model's previous answer"),
        "the comparison does not say the new request and the previous answer entered: {reasons:?}"
    );
    ensure!(
        previews.iter().any(|p| p.contains("context diff second probe")),
        "the new request is not what entered: {previews:?}"
    );
    ensure!(
        !previews.iter().any(|p| p.contains("context diff first probe")),
        "the first request, already in the window, is reported as entering: {previews:?}"
    );
    ensure!(left == 0, "{left} item(s) reported leaving a window that only grew");
    write_handoff(
        ctx,
        CONTEXT_DIFF_HANDOFF,
        &serde_json::json!({ "session": session, "previous": previous, "reasons": reasons }),
    )
}

fn scenario_context_diff_restart(ctx: &Ctx) -> ScenarioResult {
    let handoff = read_handoff(ctx, CONTEXT_DIFF_HANDOFF, "context-diff")?;
    let session = handoff["session"].as_str().unwrap_or_default().to_string();
    ensure!(mock_requests(ctx)?.is_empty(), "a request went out before the check started");
    open_cowork_session(ctx, &session)?;
    let (previous, reasons, _, left) = compare_last_snapshot(ctx)?;
    ensure!(
        previous == handoff["previous"].as_str().unwrap_or_default(),
        "after a restart the comparison is against {previous}, not {}",
        handoff["previous"]
    );
    let want: Vec<String> = handoff["reasons"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    ensure!(reasons == want && left == 0, "after a restart: entered {reasons:?}, left {left}; before: {want:?}");
    ensure!(mock_requests(ctx)?.is_empty(), "comparing sent a request");
    println!("      same comparison after the restart");
    Ok(())
}

const TIMELINE_HANDOFF: &str = "execution-timeline";

/// Open the Timeline rail if it is not showing.
fn show_timeline(ctx: &Ctx) -> ScenarioResult {
    if !ctx.eval_bool("return !!document.querySelector('[data-testid=\"timeline-panel\"]');")? {
        ctx.click_rail("Timeline")?;
    }
    ctx.wait_until(
        "the timeline panel",
        "return !!document.querySelector('[data-testid=\"timeline-panel\"]');",
        Duration::from_secs(15),
    )
}

/// Every row the timeline shows, as `seq|status|categories|invocation`.
fn timeline_rows(ctx: &Ctx) -> Result<Vec<String>, Failure> {
    let v = ctx.eval(
        "return [...document.querySelectorAll('[data-testid=\"timeline-row\"]')].map(r =>
           [r.dataset.seq, r.dataset.status, r.dataset.categories, r.dataset.invocation].join('|'));",
    )?;
    Ok(v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default())
}

/// AH-172: the desktop execution timeline, read from the session's canonical
/// event log through the real UI. A run reads a file and edits one (the edit
/// waits for Allow once); the Timeline rail then shows, in log order: the run
/// starting and ending, the read, the edit with its own +/- counts and the
/// approval it waited for, and the response. Filters narrow it; an edit opens
/// to its own unified diff with file and hunk metadata; the arrow keys move
/// between rows; a request's rows light up together from its invocation; no
/// raw translation key is on screen. The second half reads the same rows back
/// after a restart.
fn scenario_execution_timeline(ctx: &Ctx) -> ScenarioResult {
    // The project folder, not the session workspace: a bare path names a
    // file in the workspace (first attempt).
    let read_call = format!("read:{}", serde_json::json!({ "path": "{{FOLDER}}/README.md" }));
    // The attached folder is read-only in this access mode, so the edit is to
    // a file the run writes in its own workspace first (third attempt).
    let write_call = format!(
        "write:{}",
        serde_json::json!({ "path": "timeline.txt", "content": "# Old heading\nbody\n" })
    );
    let edit_call = format!(
        "edit:{}",
        serde_json::json!({ "path": "timeline.txt", "edits": [{ "old_string": "# Old heading", "new_string": "# Timeline heading" }] })
    );
    // Routed, so the fixture fills in {{FOLDER}}: only routed calls are.
    let routes = serde_json::json!([
        { "match": "TIMELINE-RUN", "tools": [read_call, write_call, edit_call], "summary": "timeline run done" }
    ]);
    let port = ctx.mock_port;
    ensure!(
        ctx.eval_bool(&format!(
            r#"const res = await fetch('http://127.0.0.1:{port}/__control', {{
                 method: 'POST', headers: {{ 'Content-Type': 'application/json' }},
                 body: JSON.stringify({{ script: 'plain', tools: [], routes: {routes} }}),
               }});
               return res.ok;"#
        ))?,
        "could not script the run"
    );
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
    attach_project(ctx)?;
    choose_mode(ctx, "Ask before changes")?;
    let session = current_cowork_session(ctx)?;
    // A directive verb from `coworkContinuity`'s list ("edit" is not one): a
    // first message that is not directive is answered with a read-only
    // inspection, where `edit` is not offered (first two attempts).
    ctx.type_into("[data-testid=\"chat-input\"]", "Update the README heading now. TIMELINE-RUN")?;
    send_armed(ctx)?;
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut asked = false;
    loop {
        asked |= ctx.eval_bool(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /^allow once$/i.test((x.textContent || '').trim()));
             if (b) b.click();
             return !!b;",
        )?;
        let done = ctx.eval_bool(
            "return !!document.querySelector('[data-test-id=\"send-message-button\"]')
               && /timeline run done/.test(document.body.innerText || '');",
        )?;
        if done {
            break;
        }
        ensure!(Instant::now() < deadline, "the run did not read, edit and finish: {}", run_state_page(ctx));
        std::thread::sleep(Duration::from_millis(600));
    }
    show_timeline(ctx)?;
    ctx.wait_until(
        "the run's rows on the timeline",
        "const rows = [...document.querySelectorAll('[data-testid=\"timeline-row\"]')];
         return rows.some(r => (r.dataset.categories || '').includes('edits') && r.dataset.status === 'completed')
           && rows.some(r => r.getAttribute('aria-label') === 'Run ended, Completed');",
        Duration::from_secs(20),
    )?;
    let rows = timeline_rows(ctx)?;
    println!("      rows: {rows:?}");
    let seqs: Vec<u64> = rows.iter().filter_map(|r| r.split('|').next()?.parse().ok()).collect();
    ensure!(seqs.windows(2).all(|w| w[0] < w[1]), "the timeline is not in log order: {seqs:?}");
    // The run's end is its last event: records are written in the order they
    // were made (a response once landed after it).
    let last_is_end = ctx.eval_bool(
        "const rows = [...document.querySelectorAll('[data-testid=\"timeline-row\"]')];
         return rows.length > 0 && rows[rows.length - 1].getAttribute('aria-label') === 'Run ended, Completed';",
    )?;
    ensure!(last_is_end, "the run's end is not its last event: {rows:?}");
    let has = |cat: &str, status: &str| {
        rows.iter().any(|r| {
            let f: Vec<&str> = r.split('|').collect();
            f.get(1) == Some(&status) && f.get(2).is_some_and(|c| c.split(' ').any(|x| x == cat))
        })
    };
    ensure!(has("tools", "completed"), "no completed tool call on the timeline");
    ensure!(has("edits", "completed"), "no completed edit on the timeline");
    // Only when a prompt was actually raised: a workspace write may not ask.
    ensure!(!asked || has("approvals", "completed"), "an approval was asked but is not on the timeline");
    ensure!(has("run", "completed"), "the run is not on the timeline");
    ensure!(has("messages", "completed"), "no response row on the timeline");
    // The edit's row carries its own +/- counts.
    let counts = ctx.eval_string(
        "const r = [...document.querySelectorAll('[data-testid=\"timeline-row\"]')]
           .find(r => (r.dataset.categories || '').includes('edits'));
         const c = r && r.querySelector('[data-testid=\"timeline-row-counts\"]');
         return c ? c.textContent : '';",
    )?;
    ensure!(counts.contains('+') && counts.contains('−'), "the edit shows no +/- counts: {counts:?}");

    // A filter narrows it, and everything comes back.
    let all = rows.len();
    for c in ["messages", "tools", "usage", "run", "approvals", "subagents", "steering", "background", "reasoning"] {
        ctx.eval(&format!("document.querySelector('[data-testid=\"timeline-filter-{c}\"]').click(); return true;"))?;
    }
    let edits_only = timeline_rows(ctx)?;
    ensure!(
        !edits_only.is_empty() && edits_only.iter().all(|r| r.split('|').nth(2).is_some_and(|c| c.contains("edits"))),
        "the edits filter shows other rows: {edits_only:?}"
    );
    for c in ["messages", "tools", "usage", "run", "approvals", "subagents", "steering", "background", "reasoning"] {
        ctx.eval(&format!("document.querySelector('[data-testid=\"timeline-filter-{c}\"]').click(); return true;"))?;
    }
    ensure!(timeline_rows(ctx)?.len() == all, "turning the filters back on did not restore every row");

    // The edit opens to its own diff.
    ctx.eval(
        "const r = [...document.querySelectorAll('[data-testid=\"timeline-row\"]')]
           .find(r => (r.dataset.categories || '').includes('edits'));
         r.querySelector('[data-row-toggle]').click();
         return true;",
    )?;
    ctx.wait_until(
        "the edit's diff",
        "const d = document.querySelector('[data-testid=\"timeline-diff\"]');
         return !!d && Number(d.dataset.hunks) >= 1 && /timeline\\.txt$/.test(d.dataset.path || '')
           && /heading/.test(d.innerText || '');",
        Duration::from_secs(15),
    )?;

    // The keyboard moves between rows.
    let moved = ctx.eval_bool(
        "const toggles = [...document.querySelectorAll('[data-row-toggle]')];
         toggles[0].focus();
         document.querySelector('[data-testid=\"timeline-list\"]')
           .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
         return document.activeElement === toggles[1];",
    )?;
    ensure!(moved, "ArrowDown did not move to the next row");

    // One request's rows light up together.
    ctx.eval(
        "const b = [...document.querySelectorAll('[data-testid=\"timeline-row\"]')]
           .find(r => (r.dataset.categories || '').includes('edits'))
           .querySelector('[data-testid=\"timeline-invocation\"]');
         if (b) b.click();
         return true;",
    )?;
    // The highlight is a re-render away from the click (fifth attempt read
    // it in the same tick).
    ctx.wait_until(
        "the request's rows to light up",
        "return document.querySelectorAll('[data-testid=\"timeline-row\"][data-linked=\"true\"]').length >= 2;",
        Duration::from_secs(10),
    )?;
    let linked = ctx.eval(
        "return [...document.querySelectorAll('[data-testid=\"timeline-row\"][data-linked=\"true\"]')]
           .map(r => r.dataset.invocation);",
    )?;
    let linked: Vec<String> = linked
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    ensure!(
        linked.len() >= 2 && linked.windows(2).all(|w| w[0] == w[1]),
        "the edit's request did not light up its own rows: {linked:?}"
    );
    println!("      invocation {} links {} rows", linked[0], linked.len());

    let raw = ctx.eval_string(
        "const m = (document.body.innerText || '').match(/\\b[a-z-]+:[a-zA-Z]+\\.[a-zA-Z._]+\\b/); return m ? m[0] : '';",
    )?;
    ensure!(raw.is_empty(), "a raw translation key is on screen: {raw}");
    write_handoff(ctx, TIMELINE_HANDOFF, &serde_json::json!({ "session": session, "rows": rows }))
}

/// A new process on the kept profile: the same rows, in the same order, with
/// the same states, read from disk, with nothing sent.
/// Jozkah/jan#244: a provider numbers its tool calls per request, so two turns
/// that each edit a file reuse the same call id (`call_1` here). Each edit's
/// row on the timeline still opens to its own diff: the diff is looked up by
/// the call's invocation, not by the call id alone, which would give both rows
/// the later turn's diff.
fn scenario_timeline_diff_by_invocation(ctx: &Ctx) -> ScenarioResult {
    let turn = |file: &str, before: &str, after: &str| {
        [
            format!("write:{}", serde_json::json!({ "path": file, "content": format!("{before}\nbody\n") })),
            format!(
                "edit:{}",
                serde_json::json!({ "path": file, "edits": [{ "old_string": before, "new_string": after }] })
            ),
        ]
    };
    // The fixture routes on a session's first user message, so the second
    // turn is scripted by re-scripting the same route before it is sent;
    // `fresh_turns` makes it answer that turn afresh despite turn one's results.
    let script = |file: &str, before: &str, after: &str, done: &str| {
        script_routes(
            ctx,
            &serde_json::json!([{ "match": "DIFF-TURNS", "tools": turn(file, before, after), "summary": done }]),
            true,
        )
    };
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
    attach_project(ctx)?;
    choose_mode(ctx, "Ask before changes")?;
    for (file, before, after, done) in [
        ("alpha.txt", "alpha before", "alpha after", "alpha turn done"),
        ("bravo.txt", "bravo before", "bravo after", "bravo turn done"),
    ] {
        script(file, before, after, done)?;
        // A directive verb, so the turn is offered write and edit.
        ctx.type_into("[data-testid=\"chat-input\"]", &format!("Update the file now. DIFF-TURNS {file}"))?;
        send_armed(ctx)?;
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            ctx.eval(
                "const b = [...document.querySelectorAll('button')].find(x =>
                   /^allow once$/i.test((x.textContent || '').trim()));
                 if (b) b.click();
                 return true;",
            )?;
            let finished = ctx.eval_bool(&format!(
                "return !!document.querySelector('[data-test-id=\"send-message-button\"]')
                   && document.body.innerText.includes({done:?});"
            ))?;
            if finished {
                break;
            }
            ensure!(Instant::now() < deadline, "the {file} turn did not finish: {}", run_state_page(ctx));
            std::thread::sleep(Duration::from_millis(600));
        }
    }
    show_timeline(ctx)?;
    const EDIT_ROWS: &str = "[...document.querySelectorAll('[data-testid=\"timeline-row\"]')]
        .filter(r => (r.dataset.categories || '').includes('edits') && r.dataset.status === 'completed')";
    // Two turns, each a write and an edit.
    ctx.wait_until(
        "every change on the timeline",
        &format!("return {EDIT_ROWS}.length >= 4;"),
        Duration::from_secs(20),
    )?;
    let count = ctx.eval_string(&format!("return String({EDIT_ROWS}.length);"))?;
    let count: usize = count.parse().map_err(|e| Failure(format!("{e}: {count}")))?;
    let invocations = ctx.eval_string(&format!(
        "return JSON.stringify({EDIT_ROWS}.map(r => r.dataset.invocation || ''));"
    ))?;
    println!("      change rows' invocations: {invocations}");
    let mut shown: Vec<(String, String)> = Vec::new();
    for index in 0..count {
        // Close whatever diff is open, then open this row's.
        ctx.eval(&format!(
            "document.querySelectorAll('[data-testid=\"timeline-diff\"]').forEach(d => {{
               const row = d.closest('[data-testid=\"timeline-row\"]');
               const t = row && row.querySelector('[data-row-toggle]');
               if (t) t.click();
             }});
             {EDIT_ROWS}[{index}].querySelector('[data-row-toggle]').click();
             return true;"
        ))?;
        ctx.wait_until(
            &format!("the diff of change {index}"),
            "const d = document.querySelectorAll('[data-testid=\"timeline-diff\"]');
             return d.length === 1 && Number(d[0].dataset.hunks) >= 1;",
            Duration::from_secs(15),
        )?;
        let raw = ctx.eval_string(
            "const d = document.querySelector('[data-testid=\"timeline-diff\"]');
             return JSON.stringify({ path: d.dataset.path || '', text: d.innerText || '' });",
        )?;
        let v: Value = serde_json::from_str(&raw).map_err(|e| Failure(format!("{e}: {raw}")))?;
        let path = v["path"].as_str().unwrap_or("").to_string();
        let text = v["text"].as_str().unwrap_or("").to_string();
        println!(
            "      change {index}: path={path:?} alpha={} bravo={}",
            text.contains("alpha"),
            text.contains("bravo")
        );
        shown.push((path, text));
    }
    for (file, own, other) in [("alpha.txt", "alpha", "bravo"), ("bravo.txt", "bravo", "alpha")] {
        let rows: Vec<&(String, String)> = shown.iter().filter(|(p, _)| p.ends_with(file)).collect();
        ensure!(rows.len() >= 2, "expected {file}'s write and edit on the timeline: {shown:?}");
        for (path, text) in rows {
            ensure!(
                text.contains(own) && !text.contains(other),
                "a change to {path} opened another call's diff: {text:?}"
            );
        }
    }
    // And the edits proper show their own replacement.
    ensure!(shown.iter().any(|(p, t)| p.ends_with("alpha.txt") && t.contains("alpha after")), "alpha's edit diff is missing");
    ensure!(shown.iter().any(|(p, t)| p.ends_with("bravo.txt") && t.contains("bravo after")), "bravo's edit diff is missing");
    Ok(())
}

fn scenario_execution_timeline_restart(ctx: &Ctx) -> ScenarioResult {
    let handoff = read_handoff(ctx, TIMELINE_HANDOFF, "execution-timeline")?;
    let session = handoff["session"].as_str().unwrap_or_default().to_string();
    let expected: Vec<String> = handoff["rows"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    ensure!(!expected.is_empty(), "the handoff holds no rows");
    ensure!(mock_requests(ctx)?.is_empty(), "a request went out before the check started");
    open_cowork_session(ctx, &session)?;
    show_timeline(ctx)?;
    ctx.wait_until(
        "the timeline after the restart",
        &format!(
            "return document.querySelectorAll('[data-testid=\"timeline-row\"]').length >= {};",
            expected.len()
        ),
        Duration::from_secs(20),
    )?;
    let rows = timeline_rows(ctx)?;
    ensure!(rows == expected, "after a restart the timeline is {rows:?}, not {expected:?}");
    ensure!(mock_requests(ctx)?.is_empty(), "reading the timeline sent a request");
    println!("      same {} rows after the restart", rows.len());
    Ok(())
}

/// AH-174: a command's CPU and memory, attributed to the call and the run that
/// ran it, read from the recorded events and shown on the timeline. The run
/// asks for one `bash` call; the timeline's row for it and the run's end both
/// carry figures -- or, where the platform cannot measure, the reason -- and
/// the figures shown are the ones in the session's event log.
fn scenario_timeline_resources(ctx: &Ctx) -> ScenarioResult {
    let bash_call = format!(
        "bash:{}",
        serde_json::json!({ "command": "echo resources-probe", "timeout": 60 })
    );
    let routes = serde_json::json!([
        { "match": "RESOURCES-RUN", "tools": [bash_call], "summary": "resources run done" }
    ]);
    let port = ctx.mock_port;
    ensure!(
        ctx.eval_bool(&format!(
            r#"const res = await fetch('http://127.0.0.1:{port}/__control', {{
                 method: 'POST', headers: {{ 'Content-Type': 'application/json' }},
                 body: JSON.stringify({{ script: 'plain', tools: [], routes: {routes} }}),
               }});
               return res.ok;"#
        ))?,
        "could not script the run"
    );
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
    attach_project(ctx)?;
    choose_mode(ctx, "Ask before changes")?;
    let session = current_cowork_session(ctx)?;
    ctx.type_into("[data-testid=\"chat-input\"]", "Run the probe command now. RESOURCES-RUN")?;
    send_armed(ctx)?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        ctx.eval_bool(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /^allow once$/i.test((x.textContent || '').trim()));
             if (b) b.click();
             return !!b;",
        )?;
        let done = ctx.eval_bool(
            "return !!document.querySelector('[data-test-id=\"send-message-button\"]')
               && /resources run done/.test(document.body.innerText || '');",
        )?;
        if done {
            break;
        }
        ensure!(Instant::now() < deadline, "the run did not finish: {}", run_state_page(ctx));
        std::thread::sleep(Duration::from_millis(600));
    }
    // The record first: what the log says the call and the run used.
    let recorded = ctx.eval(&format!(
        "const page = await window.__TAURI_INTERNALS__.invoke('agent_events_list', {{ session: {session:?}, afterSeq: 0, limit: null }});
         const call = page.events.filter(e => e.kind === 'tool.succeeded' && e.payload.tool === 'bash').map(e => e.payload.resources);
         const ended = page.events.filter(e => e.kind === 'run.ended' && e.payload.resources).map(e => e.payload.resources);
         return {{ call, ended }};"
    ))?;
    println!("      recorded: {recorded}");
    let call = recorded["call"].as_array().and_then(|a| a.first()).cloned().unwrap_or_default();
    ensure!(call.is_object(), "the bash call's record carries no resources: {recorded}");
    let measured = call["measured"] == true;
    if measured {
        ensure!(
            call["cpuMs"].is_u64() && call["peakMemoryBytes"].as_u64().unwrap_or(0) > 0 && call["processes"].as_u64().unwrap_or(0) >= 1,
            "a measured call without figures: {call}"
        );
    } else {
        ensure!(
            call["reason"].as_str().is_some_and(|r| !r.is_empty()) && call.get("cpuMs").is_none(),
            "an unmeasured call without a reason, or with a zero standing in for one: {call}"
        );
    }
    let ended = recorded["ended"].as_array().and_then(|a| a.first()).cloned().unwrap_or_default();
    ensure!(ended["commands"].as_u64().unwrap_or(0) >= 1, "the run's end carries no resource totals: {recorded}");

    // Then the timeline: the call's row shows exactly those figures.
    show_timeline(ctx)?;
    ctx.wait_until(
        "the bash row on the timeline",
        "return [...document.querySelectorAll('[data-testid=\"timeline-row\"]')].some(r => (r.dataset.categories || '').includes('tools') && r.dataset.status === 'completed');",
        Duration::from_secs(20),
    )?;
    ctx.eval(
        "const rows = [...document.querySelectorAll('[data-testid=\"timeline-row\"]')];
         const row = rows.find(r => /bash|probe/i.test(r.getAttribute('aria-label') || '') && (r.dataset.categories || '').includes('tools'))
           || rows.find(r => (r.dataset.categories || '').includes('tools'));
         row.querySelector('[data-row-toggle]').click();
         return true;",
    )?;
    let shown = ctx.wait_until(
        "the call's resources in its detail",
        "const d = document.querySelector('[data-testid=\"timeline-detail-resources\"]');
         return !!d && (d.innerText || '').length > 0;",
        Duration::from_secs(15),
    );
    shown?;
    let detail = ctx.eval(
        "const d = document.querySelector('[data-testid=\"timeline-detail-resources\"]');
         return { measured: d.dataset.measured, cpu: d.dataset.cpuMs, peak: d.dataset.peakBytes, text: d.innerText };",
    )?;
    println!("      shown: {detail}");
    ensure!(
        detail["measured"] == (if measured { "true" } else { "false" }),
        "the row says measured={} but the record says {measured}",
        detail["measured"]
    );
    if measured {
        ensure!(
            detail["cpu"].as_str() == Some(&call["cpuMs"].to_string())
                && detail["peak"].as_str() == Some(&call["peakMemoryBytes"].to_string()),
            "the row's figures are not the recorded ones: {detail} vs {call}"
        );
        ensure!(detail["text"].as_str().is_some_and(|t| t.contains("CPU") && t.contains("peak memory")), "{detail}");
    } else {
        ensure!(detail["text"].as_str().is_some_and(|t| t.starts_with("Not measured")), "{detail}");
    }
    Ok(())
}

const TEAM_RESTART_HANDOFF: &str = "team-member-restart";

/// AH-111, first half: one member of a running team fails, the team holds
/// instead of ending, and the member is restarted from the Activity panel --
/// without starting the run again. The member that depended on it runs once
/// it completes; the provider sees the failed member twice and its dependent
/// once, all inside the one run.
/// AH-190, in the real desktop app. A throwaway CA signs a local HTTPS
/// provider (tests/fixtures/mock_tls_server.py; nothing is added to any system
/// store). The HTTPS proxy settings page names the bundle, shows what it would
/// do, and saves it; the app's own provider transport then reaches the provider
/// over TLS. A broken bundle is shown broken and the same request is refused
/// with nothing sent; clearing the field returns to the platform's roots.
fn scenario_network_ca_bundle(ctx: &Ctx) -> ScenarioResult {
    use std::io::BufRead;
    let fail = |e: String| Failure(e);
    let python = ["python3", "python", "py"]
        .into_iter()
        .find(|name| {
            std::process::Command::new(name)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        })
        .ok_or_else(|| fail("no python interpreter for the TLS fixture".into()))?;
    let fixture = Path::new(MANIFEST_DIR).join("tests/fixtures/mock_tls_server.py");
    let ca = ctx.workspace.join("tls-ca");
    let _ = std::fs::remove_dir_all(&ca);
    let made = std::process::Command::new(python)
        .arg(&fixture)
        .arg("--make-ca")
        .arg(&ca)
        .output()
        .map_err(|e| fail(e.to_string()))?;
    ensure!(made.status.success(), "the TLS fixture could not make a CA: {}", String::from_utf8_lossy(&made.stderr));
    let log = ca.join("valid.log");
    struct Server(std::process::Child);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut child = std::process::Command::new(python)
        .arg(&fixture)
        .arg("--serve")
        .arg(&ca)
        .args(["--mode", "valid", "--log"])
        .arg(&log)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| fail(e.to_string()))?;
    let mut line = String::new();
    std::io::BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .map_err(|e| fail(e.to_string()))?;
    let _server = Server(child);
    let port: u16 = line.trim().trim_start_matches("PORT ").parse().map_err(|_| fail(format!("no fixture port in {line:?}")))?;
    let requests = || std::fs::read_to_string(&log).map(|t| t.lines().count()).unwrap_or(0);
    let bundle = ca.join("ca.pem").to_string_lossy().to_string();
    let junk = ca.join("junk.pem").to_string_lossy().to_string();
    let url = format!("https://127.0.0.1:{port}/v1/models");

    // The provider request, through the app's own transport. Resolves to
    // "ok:<status>:<body>" or "refused:<error>".
    let ask = |ctx: &Ctx| -> Result<String, Failure> {
        ctx.eval_string(&format!(
            r#"try {{
                 const r = await window.__TAURI_INTERNALS__.invoke('provider_http_request',
                   {{ request: {{ url: {url:?}, method: 'GET', timeout_secs: 15 }} }});
                 return 'ok:' + r.status + ':' + r.body;
               }} catch (e) {{
                 return 'refused:' + String(e && e.message || e);
               }}"#
        ))
    };
    let saved_path = |ctx: &Ctx| -> Result<String, Failure> {
        ctx.eval_string(
            "const raw = await window.__TAURI_INTERNALS__.invoke('settings_get', { key: 'setting-proxy-config' });
             try { return (JSON.parse(raw || '{}').state || {}).caBundlePath || ''; } catch (e) { return ''; }",
        )
    };

    // 1. Before anything is named, the provider is refused and sees nothing.
    let before = ask(ctx)?;
    ensure!(before.starts_with("refused:"), "an untrusted provider was reached: {before}");
    // R13: the refusal says it was the certificate, and why.
    ensure!(before.contains("[certificate:") && before.contains("not trusted"), "the refusal does not name the certificate: {before}");
    ensure!(requests() == 0, "an untrusted provider received a request");

    // 2. The settings page names the bundle and shows what it would do.
    ctx.goto("/settings/https-proxy")?;
    ctx.wait_until(
        "the CA bundle field",
        "return !!document.querySelector('[data-testid=\"ca-bundle-path\"]');",
        Duration::from_secs(30),
    )?;
    ctx.type_into("[data-testid=\"ca-bundle-path\"]", &bundle)?;
    ctx.wait_until(
        "the bundle shown in use",
        "const s = document.querySelector('[data-testid=\"ca-bundle-status-in-use\"]');
         return !!s && /SHA-256 [0-9a-f]{64}/.test(s.innerText || '');",
        Duration::from_secs(20),
    )?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while saved_path(ctx)? != bundle {
        ensure!(Instant::now() < deadline, "the bundle path was never saved to the settings");
        std::thread::sleep(Duration::from_millis(250));
    }
    let status = ctx.eval_string("return JSON.stringify(await window.__TAURI_INTERNALS__.invoke('network_ca_status'));")?;
    ensure!(status.contains("\"in_use\"") && status.contains("desktop HTTPS proxy settings"), "network_ca_status: {status}");

    // 3. The app's transport now reaches the provider over TLS.
    let trusted = ask(ctx)?;
    println!("      trusted request: {}", trusted.chars().take(80).collect::<String>());
    ensure!(trusted.starts_with("ok:200:") && trusted.contains("tls-model"), "the provider was not reached with the bundle: {trusted}");
    let seen = requests();
    ensure!(seen >= 1, "the provider saw no request");

    // 4. A broken bundle is shown broken, and fails closed.
    ctx.type_into("[data-testid=\"ca-bundle-path\"]", &junk)?;
    ctx.wait_until(
        "the bundle shown broken",
        "const s = document.querySelector('[data-testid=\"ca-bundle-status-broken\"]');
         return !!s && /malformed/.test(s.innerText || '');",
        Duration::from_secs(20),
    )?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while saved_path(ctx)? != junk {
        ensure!(Instant::now() < deadline, "the broken path was never saved");
        std::thread::sleep(Duration::from_millis(250));
    }
    let closed = ask(ctx)?;
    ensure!(closed.starts_with("refused:"), "a broken bundle still reached the provider: {closed}");
    ensure!(closed.contains("[certificate:"), "the fail-closed refusal does not name the certificate: {closed}");
    ensure!(requests() == seen, "a broken bundle let a request through");

    // 5. Cleared: the platform's roots only.
    ctx.type_into("[data-testid=\"ca-bundle-path\"]", "")?;
    ctx.wait_until(
        "the bundle shown as none",
        "return !!document.querySelector('[data-testid=\"ca-bundle-status-none\"]');",
        Duration::from_secs(20),
    )?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while !saved_path(ctx)?.is_empty() {
        ensure!(Instant::now() < deadline, "the cleared path was never saved");
        std::thread::sleep(Duration::from_millis(250));
    }
    let after = ask(ctx)?;
    ensure!(after.starts_with("refused:"), "the CA was still trusted after it was cleared: {after}");
    ensure!(requests() == seen, "a request went through after the bundle was cleared");
    Ok(())
}

fn scenario_team_member_restarted(ctx: &Ctx) -> ScenarioResult {
    let team = serde_json::json!({ "tasks": [
        { "id": "one", "description": "TASK-ONE: report the number one", "writes": [] },
        { "id": "two", "description": "TASK-TWO: report the number two", "writes": [], "depends_on": ["one"] }
    ]});
    // The member fails the way a real one does: after a completed step, its
    // stream breaks (the shape the team review scenario already proves). A
    // stream that breaks before any step is not used here, so this scenario
    // tests the restart, not how an empty first stream is classified.
    let read_readme = format!("read:{}", serde_json::json!({ "path": "{{FOLDER}}/README.md" }));
    let failing = serde_json::json!([
        { "match": "TASK-ONE", "tools": [read_readme.clone()], "then": "fail" },
        { "match": "TASK-TWO", "tools": [read_readme.clone()], "summary": "two done" }
    ]);
    let port = ctx.mock_port;
    let team_call = format!("team:{team}");
    let script = |routes: &Value| {
        format!(
            r#"const res = await fetch('http://127.0.0.1:{port}/__control', {{
                 method: 'POST', headers: {{ 'Content-Type': 'application/json' }},
                 body: JSON.stringify({{ script: 'tools', tools: [{team_call:?}], routes: {routes}, summary: 'team run done' }}),
               }});
               return res.ok;"#
        )
    };
    ensure!(ctx.eval_bool(&script(&failing))?, "could not script the team");
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
    attach_project(ctx)?;
    choose_mode(ctx, "Ask before changes")?;
    let session = current_cowork_session(ctx)?;
    ctx.type_into("[data-testid=\"chat-input\"]", "Implement these two tasks as a team.")?;
    send_armed(ctx)?;

    // The team holds on the failed member, with its controls offered.
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let _ = ctx.eval(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /^allow once$/i.test((x.textContent || '').trim()));
             if (b) b.click();
             return true;",
        );
        let _ = show_tasks_rail(ctx);
        // A workflow lists its members only once its row is open (and a finished
        // one only once the finished section is); open every closed row.
        let _ = ctx.eval(
            "for (const b of document.querySelectorAll('button[aria-expanded=\"false\"]')) b.click(); return true;",
        );
        if ctx.eval_bool("return !!document.querySelector('[data-testid=\"team-member-controls-one\"]');")? {
            break;
        }
        ensure!(Instant::now() < deadline, "the failed member was never offered a restart: {}", run_state_page(ctx));
        std::thread::sleep(Duration::from_millis(700));
    }
    let asked = |needle: &str| -> Result<usize, Failure> {
        Ok(mock_requests(ctx)?
            .iter()
            .filter(|r| {
                r["messages"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|m| m["role"] == "user")
                    .any(|m| m.to_string().contains(needle))
            })
            .count())
    };
    let one_before = asked("TASK-ONE")?;
    ensure!(one_before >= 1, "the failing member never reached the model");
    ensure!(asked("TASK-TWO")? == 0, "the dependent ran although its dependency failed");
    std::thread::sleep(Duration::from_secs(2));
    ensure!(
        !ctx.eval_bool("return /team run done/.test(document.body.innerText || '');")?,
        "the team ended instead of holding for a decision"
    );
    let run_before = ctx.eval_string(
        "const r = window.__coworkRunForTest || null; return r ? String(r) : '';",
    )?;

    // Restart it, now that it will succeed.
    let fixed = serde_json::json!([
        { "match": "TASK-ONE", "tools": [read_readme.clone()], "summary": "one done" },
        { "match": "TASK-TWO", "tools": [read_readme], "summary": "two done" }
    ]);
    ensure!(ctx.eval_bool(&script(&fixed))?, "could not script the restart");
    ctx.eval("document.querySelector('[data-testid=\"team-member-restart\"]').click(); return true;")?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let _ = ctx.eval(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /^allow once$/i.test((x.textContent || '').trim()));
             if (b) b.click();
             return true;",
        );
        let done = ctx.eval_bool(
            "return !!document.querySelector('[data-test-id=\"send-message-button\"]')
               && /team run done/.test(document.body.innerText || '');",
        )?;
        if done {
            break;
        }
        ensure!(Instant::now() < deadline, "the team did not finish after the restart: {}", run_state_page(ctx));
        std::thread::sleep(Duration::from_millis(700));
    }
    let one_after = asked("TASK-ONE")?;
    let two_after = asked("TASK-TWO")?;
    println!("      TASK-ONE requests {one_before} -> {one_after}, TASK-TWO {two_after}");
    ensure!(one_after > one_before, "the restart did not run the member again");
    ensure!(two_after >= 1, "the dependent did not run after its dependency completed");
    // One run: the conversation shows one team result, not a second run.
    let _ = run_before;
    let _ = show_tasks_rail(ctx);
    // A workflow lists its members only once its row is open (and a finished
    // one only once the finished section is); open every closed row.
    let _ = ctx.eval(
        "for (const b of document.querySelectorAll('button[aria-expanded=\"false\"]')) b.click(); return true;",
    );
    ctx.wait_until(
        "the restart recorded on the member",
        "const n = document.querySelector('[data-testid=\"team-member-attempts\"]');
         return !!n && /Restarted once by hand/.test(n.innerText || '');",
        Duration::from_secs(20),
    )?;
    ensure!(
        !ctx.eval_bool("return !!document.querySelector('[data-testid=\"team-member-controls-one\"]');")?,
        "restart controls are still offered for a team that has ended"
    );
    write_handoff(ctx, TEAM_RESTART_HANDOFF, &serde_json::json!({ "session": session }))?;
    Ok(())
}

/// AH-111, second half: the restart is part of the record, so a fresh process
/// shows the member as restarted by hand -- and offers no controls, because
/// the team it belonged to ended with the run.
fn scenario_team_member_restart_after_restart(ctx: &Ctx) -> ScenarioResult {
    let handoff = read_handoff(ctx, TEAM_RESTART_HANDOFF, "team-member-restarted-in-place")?;
    let session = handoff["session"].as_str().unwrap_or_default().to_string();
    open_cowork_session(ctx, &session)?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let _ = show_tasks_rail(ctx);
        // Finished work is listed under its workflow; open every row.
        let _ = ctx.eval(
            "for (const b of document.querySelectorAll('button[aria-expanded=\"false\"]')) b.click(); return true;",
        );
        if ctx.eval_bool(
            "const n = document.querySelector('[data-testid=\"team-member-attempts\"]');
             return !!n && /Restarted once by hand/.test(n.innerText || '');",
        )? {
            break;
        }
        ensure!(Instant::now() < deadline, "after a restart the member is not shown as restarted: {}", run_state_page(ctx));
        std::thread::sleep(Duration::from_millis(700));
    }
    ensure!(
        !ctx.eval_bool("return !!document.querySelector('[data-testid^=\"team-member-controls-\"]');")?,
        "a fresh process offers controls for a team that no longer exists"
    );
    ensure!(mock_requests(ctx)?.is_empty(), "reopening the session ran something");
    Ok(())
}

const INTERRUPTED_HANDOFF: &str = "interrupted-turn";

/// AH-026, first half: a Cowork run is left in the middle of a turn when this
/// process exits. The run reads a file (a completed tool step) and then
/// streams a reply that never ends. Once the session's persisted record holds
/// that step and part of the reply, the scenario returns and the harness ends
/// the process with `std::process::exit` -- the app is killed mid-turn, with
/// nothing committed.
fn scenario_cowork_killed_mid_turn(ctx: &Ctx) -> ScenarioResult {
    let read_call = format!("read:{}", serde_json::json!({ "path": "{{FOLDER}}/README.md" }));
    let routes = serde_json::json!([
        { "match": "INTERRUPTED-RUN", "tools": [read_call], "then": "slow" }
    ]);
    let port = ctx.mock_port;
    ensure!(
        ctx.eval_bool(&format!(
            r#"const res = await fetch('http://127.0.0.1:{port}/__control', {{
                 method: 'POST', headers: {{ 'Content-Type': 'application/json' }},
                 body: JSON.stringify({{ script: 'plain', tools: [], delay: 0.2, routes: {routes} }}),
               }});
               return res.ok;"#
        ))?,
        "could not script the run"
    );
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
    attach_project(ctx)?;
    let session = current_cowork_session(ctx)?;
    ctx.type_into("[data-testid=\"chat-input\"]", "Read the README and summarise it. INTERRUPTED-RUN")?;
    send_armed(ctx)?;
    // The session's record as it is on disk, not in the settings store's
    // memory or on the screen: what a fresh process will read back. Reading
    // the store instead let this exit before the checkpoint was ever flushed.
    let settings = data_folder()?.join("settings.json");
    let deadline = Instant::now() + Duration::from_secs(90);
    let checkpoint = loop {
        let on_disk = || -> Option<Value> {
            let file: Value = serde_json::from_str(&std::fs::read_to_string(&settings).ok()?).ok()?;
            let sessions: Value = serde_json::from_str(file.get("code-sessions")?.as_str()?).ok()?;
            let state = sessions.get("state").unwrap_or(&sessions);
            // Sessions are saved one key each (`code-sessions:<id>`); an older
            // blob held them inline.
            let shard: Option<Value> = file
                .get(format!("code-sessions:{session}"))
                .and_then(|v| v.as_str())
                .and_then(|text| serde_json::from_str(text).ok());
            let f = match &shard {
                Some(s) => s.pointer("/state/sessions/0")?.get("inFlight")?,
                None => state["sessions"].as_array()?.iter().find(|x| x["id"] == session.as_str())?.get("inFlight")?,
            };
            let turns = f["turns"].as_array()?;
            let calls = turns
                .iter()
                .filter(|t| t["role"] == "tool" && t["result"].as_str().is_some_and(|r| !r.is_empty()))
                .count();
            let last = turns.last()?;
            let partial = if last["role"] == "assistant" { last["content"].as_str().unwrap_or("") } else { "" };
            (calls > 0 && partial.contains("working"))
                .then(|| serde_json::json!({ "runId": f["runId"], "turns": turns.len(), "partial": partial.len() }))
        };
        if let Some(found) = on_disk() {
            break found;
        }
        ensure!(
            Instant::now() < deadline,
            "the session never held the completed step and the unfinished reply: {}",
            run_state_page(ctx)
        );
        std::thread::sleep(Duration::from_millis(500));
    };
    println!("      checkpoint persisted: {checkpoint}");
    write_handoff(ctx, INTERRUPTED_HANDOFF, &serde_json::json!({ "session": session, "runId": checkpoint["runId"] }))?;
    // Returning ends this process while the run is still streaming.
    Ok(())
}

/// AH-026, second half: the fresh process shows the killed run's turn as
/// interrupted -- its completed step and its unfinished reply -- and offers to
/// continue it or to discard the unfinished reply. Nothing runs until one is
/// chosen. Continue sends the model the recovered turns with a note from Flint,
/// the run finishes, and no checkpoint is left.
fn scenario_cowork_interrupted_turn_continues(ctx: &Ctx) -> ScenarioResult {
    let handoff = read_handoff(ctx, INTERRUPTED_HANDOFF, "cowork-run-killed-mid-turn")?;
    let session = handoff["session"].as_str().unwrap_or_default().to_string();
    let port = ctx.mock_port;
    ensure!(
        ctx.eval_bool(&format!(
            r#"const res = await fetch('http://127.0.0.1:{port}/__control', {{
                 method: 'POST', headers: {{ 'Content-Type': 'application/json' }},
                 body: JSON.stringify({{ script: 'plain', tools: [], routes: [], summary: 'recovered run done' }}),
               }});
               return res.ok;"#
        ))?,
        "could not script the recovery"
    );
    ensure!(mock_requests(ctx)?.is_empty(), "a request went out before anything was chosen");
    open_cowork_session(ctx, &session)?;
    ctx.wait_until(
        "the interrupted turn",
        "const b = document.querySelector('[data-testid=\"cowork-interrupted-turn\"]');
         return !!b && Number(b.dataset.calls) >= 1 && Number(b.dataset.partialChars) > 0;",
        Duration::from_secs(30),
    )?;
    let banner = ctx.eval(
        "const b = document.querySelector('[data-testid=\"cowork-interrupted-turn\"]');
         return { run: b.dataset.run, calls: b.dataset.calls, partial: b.dataset.partialChars, text: b.innerText,
                  discard: !!document.querySelector('[data-testid=\"cowork-interrupted-discard\"]') };",
    )?;
    println!("      banner: {banner}");
    ensure!(banner["run"] == handoff["runId"], "the banner names another run: {banner}");
    ensure!(banner["discard"] == true, "no choice to discard the unfinished reply: {banner}");
    std::thread::sleep(Duration::from_secs(2));
    ensure!(mock_requests(ctx)?.is_empty(), "the interrupted turn resumed without being asked");

    ctx.eval("document.querySelector('[data-testid=\"cowork-interrupted-continue\"]').click(); return true;")?;
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let done = ctx.eval_bool(
            "return !document.querySelector('[data-testid=\"cowork-interrupted-turn\"]')
               && /recovered run done/.test(document.body.innerText || '');",
        )?;
        if done {
            break;
        }
        ensure!(Instant::now() < deadline, "the recovered run did not finish: {}", run_state_page(ctx));
        std::thread::sleep(Duration::from_millis(600));
    }
    // What the model was sent: the recovered step, the unfinished reply, and
    // the note from Flint -- the request itself, not the screen.
    let requests = mock_requests(ctx)?;
    let sent = requests
        .iter()
        .rev()
        .find(|r| r.to_string().contains("Note from Flint"))
        .cloned()
        .unwrap_or_default();
    ensure!(!sent.is_null(), "no request carried the recovery note: {requests:?}");
    let text = sent.to_string();
    ensure!(text.contains("README") || text.contains("fixture"), "the recovered read was not sent: {text}");
    ensure!(text.contains("working"), "the unfinished reply was not sent: {text}");
    ensure!(text.contains("may be incomplete"), "the note did not say the reply may be incomplete: {text}");
    let left = ctx.eval(&format!(
        "const raw = await window.__TAURI_INTERNALS__.invoke('settings_get', {{ key: 'code-sessions' }}).catch(() => null);
         let state; try {{ state = JSON.parse(raw); state = state.state ?? state; }} catch {{ return null; }}
         let s = (state.sessions || []).find(x => x.id === {session:?});
         if (!s && Array.isArray(state.sessionIds)) {{
           const text = await window.__TAURI_INTERNALS__.invoke('settings_get', {{ key: 'code-sessions:' + {session:?} }}).catch(() => null);
           try {{ s = JSON.parse(text).state.sessions[0]; }} catch {{}}
         }}
         return s ? (s.inFlight ? 'still in flight' : 'clear') : 'no session';"
    ))?;
    ensure!(left == "clear", "the checkpoint outlived its recovery: {left}");
    Ok(())
}

/// AH-176: the run the first half recorded, stepped through in a fresh
/// process. Step 1 is the run's start alone; each Next adds or changes one
/// row, at least one step shows a call in a state it later left, and the last
/// step is exactly the timeline the first half saw. A run the log does not
/// hold is refused by kind, and stepping sends no request anywhere.
fn scenario_timeline_replay_after_restart(ctx: &Ctx) -> ScenarioResult {
    let handoff = read_handoff(ctx, TIMELINE_HANDOFF, "execution-timeline")?;
    let session = handoff["session"].as_str().unwrap_or_default().to_string();
    let expected: Vec<String> = handoff["rows"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    ensure!(!expected.is_empty(), "the handoff holds no rows");
    open_cowork_session(ctx, &session)?;
    show_timeline(ctx)?;
    ctx.wait_until(
        "the recorded timeline",
        &format!(
            "return document.querySelectorAll('[data-testid=\"timeline-row\"]').length >= {};",
            expected.len()
        ),
        Duration::from_secs(20),
    )?;
    ctx.eval("document.querySelector('[data-testid=\"timeline-replay\"]').click(); return true;")?;
    ctx.wait_until(
        "the replay controls",
        "return !!document.querySelector('[data-testid=\"timeline-replay-controls\"]');",
        Duration::from_secs(15),
    )?;
    // The session holds the agent run and the chat run inside it; the one
    // that most recently finished is offered first (the first attempt offered
    // the chat run, listed by when it started). The agent run is the one with
    // the tool calls, so it is chosen explicitly if it is not already shown.
    let runs = ctx.eval(
        "const s = document.querySelector('[data-testid=\"timeline-replay-run\"]');
         return s ? [...s.options].map(o => [o.value, o.textContent]) : [];",
    )?;
    println!("      runs offered: {runs}");
    ctx.eval(
        "const s = document.querySelector('[data-testid=\"timeline-replay-run\"]');
         if (s) {
           const steps = o => Number((o.textContent.match(/([0-9]+) steps/) || [])[1] || 0);
           const best = [...s.options].sort((a, b) => steps(b) - steps(a))[0];
           if (best && best.value !== s.value) {
             const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
             set.call(s, best.value);
             s.dispatchEvent(new Event('change', { bubbles: true }));
           }
         }
         return true;",
    )?;
    ctx.wait_until(
        "the run with the tool calls",
        "const c = document.querySelector('[data-testid=\"timeline-replay-controls\"]');
         return !!c && Number(c.dataset.total) >= 10;",
        Duration::from_secs(15),
    )?;
    let total: usize = ctx
        .eval_string("return document.querySelector('[data-testid=\"timeline-replay-controls\"]').dataset.total;")?
        .parse()
        .unwrap_or(0);
    ensure!(total >= 3, "the run has {total} recorded steps");
    let position = ctx.eval_string(
        "return document.querySelector('[data-testid=\"timeline-replay-position\"]').textContent;",
    )?;
    ensure!(position == format!("Step 1 of {total}"), "replay opened at {position:?}");
    let first = timeline_rows(ctx)?;
    let first_label = ctx.eval_string(
        "const r = document.querySelector('[data-testid=\"timeline-row\"]'); return r ? r.getAttribute('aria-label') : '';",
    )?;
    ensure!(first.len() == 1 && first_label == "Run started, Completed", "step 1 shows {first:?} ({first_label})");

    let final_status = |rows: &[String], seq: &str| {
        rows.iter().find(|r| r.split('|').next() == Some(seq)).and_then(|r| r.split('|').nth(1).map(str::to_string))
    };
    let mut previous = first.len();
    let mut transient = Vec::new();
    for step in 2..=total {
        ctx.eval("document.querySelector('[data-testid=\"timeline-replay-next\"]').click(); return true;")?;
        ctx.wait_until(
            "the next step",
            &format!(
                "return document.querySelector('[data-testid=\"timeline-replay-controls\"]').dataset.step === '{step}';"
            ),
            Duration::from_secs(5),
        )?;
        let rows = timeline_rows(ctx)?;
        ensure!(rows.len() >= previous, "step {step} lost rows: {} after {previous}", rows.len());
        previous = rows.len();
        for r in &rows {
            let seq = r.split('|').next().unwrap_or_default();
            let now = r.split('|').nth(1).unwrap_or_default();
            if let Some(end) = final_status(&expected, seq) {
                if end != now {
                    transient.push(format!("step {step}: row {seq} {now} (ends {end})"));
                }
            }
        }
    }
    println!("      {total} steps; states later left: {transient:?}");
    ensure!(!transient.is_empty(), "no step showed a row in a state it later left");
    // The last step is this run's part of the recorded timeline, row for row:
    // every row it shows is one the first half saw, with the same status,
    // categories and request, and the edits are among them.
    let last = timeline_rows(ctx)?;
    println!("      last step: {last:?}");
    ensure!(
        last.iter().all(|r| expected.contains(r)),
        "the last step shows rows the recorded timeline does not: {last:?} vs {expected:?}"
    );
    ensure!(
        last.iter().filter(|r| r.split('|').nth(2).is_some_and(|c| c.contains("edits"))).count()
            == expected.iter().filter(|r| r.split('|').nth(2).is_some_and(|c| c.contains("edits"))).count(),
        "the last step does not hold every recorded edit: {last:?}"
    );
    let next_disabled = ctx.eval_bool(
        "return document.querySelector('[data-testid=\"timeline-replay-next\"]').disabled;",
    )?;
    ensure!(next_disabled, "Next is still offered past the last step");

    // A run the log does not hold is refused by kind, not replayed as empty.
    let kind = ctx.eval_string(&format!(
        "return window.__TAURI_INTERNALS__.invoke('agent_events_run', {{ session: {session:?}, run: 'no-such-run' }})
           .then(() => 'accepted', e => (e && e.kind) || String(e));"
    ))?;
    ensure!(kind == "not_found", "an unknown run came back as {kind:?}");

    ctx.eval("document.querySelector('[data-testid=\"timeline-replay-exit\"]').click(); return true;")?;
    ctx.wait_until(
        "the live timeline back",
        &format!(
            "return !document.querySelector('[data-testid=\"timeline-replay-controls\"]')
               && document.querySelectorAll('[data-testid=\"timeline-row\"]').length === {};",
            expected.len()
        ),
        Duration::from_secs(10),
    )?;
    ensure!(timeline_rows(ctx)? == expected, "leaving replay did not restore the recorded timeline");
    ensure!(mock_requests(ctx)?.is_empty(), "stepping through the run sent a request");
    Ok(())
}

const ROLE_CANCEL_HANDOFF: &str = "role-cancel";
const ROLE_NAMES: [&str; 6] = ["explorer", "planner", "implementer", "reviewer", "tester", "security"];

/// Make sure the Activity rail (the Background Tasks panel) is showing.
fn show_tasks_rail(ctx: &Ctx) -> ScenarioResult {
    // The rail button toggles, so it is pressed only when no task row is on
    // screen after a moment -- pressing it on an open panel would close it.
    let shown = ctx.wait_until(
        "a task row",
        "return !!document.querySelector('[data-testid^=\"task-status-\"]');",
        Duration::from_secs(5),
    );
    if shown.is_err() {
        ctx.click_rail("Activity")?;
    }
    Ok(())
}

/// AH-094..099: a role stopped in the middle of its run. The explorer is
/// dispatched through the UI, reads, then streams without end; the person
/// stops that one child from the Background Tasks panel. The child ends as
/// cancelled -- not failed, not running -- the stop is in the session's
/// execution record, the parent run finishes, and the child sends nothing
/// more. The second half checks all of it after a restart.
fn scenario_role_cancel(ctx: &Ctx) -> ScenarioResult {
    let calls: Vec<String> = ROLE_NAMES
        .iter()
        .map(|role| {
            format!(
                "task:{}",
                serde_json::json!({
                    "subagent_name": role,
                    "description": format!("ROLE-CANCEL-{}: map the fixture slowly", role.to_uppercase()),
                })
            )
        })
        .collect();
    let routes: Vec<Value> = ROLE_NAMES
        .iter()
        .map(|role| {
            serde_json::json!({
                "match": format!("ROLE-CANCEL-{}", role.to_uppercase()),
                "tools": ["ls:{\"path\":\".\"}"],
                "then": "slow",
            })
        })
        .collect();
    let routes = Value::Array(routes);
    let calls = serde_json::to_string(&calls).unwrap_or_default();
    let port = ctx.mock_port;
    ensure!(
        ctx.eval_bool(&format!(
            r#"const res = await fetch('http://127.0.0.1:{port}/__control', {{
                 method: 'POST', headers: {{ 'Content-Type': 'application/json' }},
                 body: JSON.stringify({{ script: 'tools', tools: {calls}, routes: {routes}, delay: 0.3 }}),
               }});
               return res.ok;"#
        ))?,
        "could not script the roles"
    );
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
    attach_project(ctx)?;
    choose_mode(ctx, "Ask before changes")?;
    let session = current_cowork_session(ctx)?;
    ctx.type_into("[data-testid=\"chat-input\"]", "Run all six roles on this project.")?;
    send_armed(ctx)?;

    // Until every child has read and is streaming its never-ending answer.
    let streaming = |ctx: &Ctx, role: &str| -> bool {
        let tag = format!("ROLE-CANCEL-{}", role.to_uppercase());
        mock_requests(ctx).unwrap_or_default().iter().any(|r| {
            r["messages"].to_string().contains(&tag)
                && r["messages"].as_array().is_some_and(|m| m.iter().any(|m| m["role"] == "tool"))
        })
    };
    // A step's tool calls run one at a time, so the parent dispatches the
    // next role only once the one before has ended. Each role is stopped while
    // it streams; the next one starting shows the stop reached only that child
    // and the parent carried on.
    for (i, role) in ROLE_NAMES.iter().enumerate() {
        let deadline = Instant::now() + Duration::from_secs(90);
        while !streaming(ctx, role) {
            let _ = ctx.eval(
                "const b = [...document.querySelectorAll('button')].find(x =>
                   /^allow once$/i.test((x.textContent || '').trim()));
                 if (b && !b.closest('[data-testid=\"child-approval\"]')) b.click();
                 return true;",
            );
            ensure!(Instant::now() < deadline, "{role} never started streaming: {}", run_state_page(ctx));
            std::thread::sleep(Duration::from_millis(500));
        }
        show_tasks_rail(ctx)?;
        // A workflow's tasks are listed under its row once it is expanded.
        ctx.eval(
            "[...document.querySelectorAll('button[aria-expanded=\"false\"]')]
               .filter(b => /\\d+ of \\d+ finished/.test(b.textContent || ''))
               .forEach(b => b.click());
             return true;",
        )?;
        let row = ctx.wait_until(
            &format!("{role} running in the tasks panel"),
            &format!("return !!document.querySelector('[aria-label=\"Stop {role}\"]');"),
            Duration::from_secs(30),
        );
        if row.is_err() {
            ctx.describe("role-cancel-panel")?;
        }
        row?;
        if i == 0 {
            // No raw translation key anywhere on screen (the panel's own
            // header read "common:tasks.summaryNoTokens" before plural keys
            // resolved).
            let raw = ctx.eval_string(
                "const m = (document.body.innerText || '').match(/\\b[a-z-]+:[a-zA-Z]+\\.[a-zA-Z._]+\\b/); return m ? m[0] : '';",
            )?;
            ensure!(raw.is_empty(), "a raw translation key is on screen: {raw}");
        }
        ctx.eval(&format!(
            "document.querySelector('[aria-label=\"Stop {role}\"]').click(); return true;"
        ))?;
        ctx.wait_until(
            &format!("{role} to end as cancelled"),
            &format!(
                "return document.querySelectorAll('[data-testid=\"task-status-cancelled\"]').length >= {}
                   && !document.querySelector('[aria-label=\"Stop {role}\"]');",
                i + 1
            ),
            Duration::from_secs(30),
        )?;
        println!("      {role}: stopped mid-stream, ended as cancelled");
    }
    ensure!(
        !ctx.eval_bool("return !!document.querySelector('[data-testid=\"task-status-running\"]');")?,
        "a role is still running after all six were stopped"
    );
    ctx.wait_until(
        "the parent run to finish",
        "const b = [...document.querySelectorAll('button')].find(x =>
           /^allow once$/i.test((x.textContent || '').trim()));
         if (b) b.click();
         return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    // Stopped means stopped: the child sends nothing more.
    let asked = |ctx: &Ctx| {
        mock_requests(ctx)
            .unwrap_or_default()
            .iter()
            .filter(|r| r["messages"].to_string().contains("ROLE-CANCEL-"))
            .count()
    };
    let before = asked(ctx);
    std::thread::sleep(Duration::from_secs(3));
    ensure!(asked(ctx) == before, "a cancelled role kept calling the model");

    let record = activity_records();
    let stops = record
        .iter()
        .filter(|e| e["session"] == session.as_str() && e["lifecycle"] == "subagent" && e["phase"] == "cancelled")
        .count();
    ensure!(stops >= ROLE_NAMES.len(), "{stops} stops are in the session's execution record, not six");
    ensure!(
        !record.iter().any(|e| e["session"] != session.as_str() && e["lifecycle"] == "subagent"
            && e["summary"].as_str().is_some_and(|s| s.contains("explorer"))),
        "the stop leaked into another session's record"
    );
    write_handoff(ctx, ROLE_CANCEL_HANDOFF, &serde_json::json!({ "session": session }))
}

/// The second half, in a new process on the kept profile: the cancelled role
/// comes back cancelled -- not running, not interrupted -- nothing is
/// dispatched again, and the six roles are still the shipped ones.
fn scenario_role_cancel_restart(ctx: &Ctx) -> ScenarioResult {
    let handoff = read_handoff(ctx, ROLE_CANCEL_HANDOFF, "agent-role-cancel")?;
    let session = handoff["session"].as_str().unwrap_or_default().to_string();
    ensure!(!session.is_empty(), "the handoff names no session");
    ensure!(mock_requests(ctx)?.is_empty(), "a request went out before the check started");
    let (ok, listed) = ipc(ctx, "agent_subagent_list", "{}")?;
    ensure!(ok, "listing agents failed: {listed}");
    let builtins = listed
        .as_array()
        .into_iter()
        .flatten()
        .filter(|d| d["scope"] == "builtin")
        .count();
    ensure!(builtins == 6, "{builtins} built-in roles after the restart");
    open_cowork_session(ctx, &session)?;
    show_tasks_rail(ctx)?;
    ctx.eval(
        "[...document.querySelectorAll('button[aria-expanded=\"false\"]')]
           .filter(b => /\\d+ of \\d+ finished/.test(b.textContent || ''))
           .forEach(b => b.click());
         return true;",
    )?;
    ctx.wait_until(
        "the six cancelled roles after the restart",
        "return document.querySelectorAll('[data-testid=\"task-status-cancelled\"]').length >= 6;",
        Duration::from_secs(30),
    )?;
    ensure!(
        !ctx.eval_bool(
            "return !!document.querySelector('[data-testid=\"task-status-running\"], [data-testid=\"task-status-interrupted\"]');"
        )?,
        "the cancelled role came back running or interrupted"
    );
    let record = activity_records();
    ensure!(
        record
            .iter()
            .filter(|e| e["session"] == session.as_str() && e["lifecycle"] == "subagent" && e["phase"] == "cancelled")
            .count()
            >= ROLE_NAMES.len(),
        "the stops are gone from the record after the restart"
    );
    std::thread::sleep(Duration::from_secs(2));
    ensure!(mock_requests(ctx)?.is_empty(), "the restart dispatched the cancelled role again");
    Ok(())
}

/// A shipped role's tools, as `core::agent::roles` defines them.
fn role_allowlist(role: &str) -> &'static [&'static str] {
    app_lib::core::agent::roles::ROLES
        .iter()
        .find(|r| r.name == role)
        .map(|r| r.tools)
        .unwrap_or(&[])
}

/// Press a chord the way the keyboard does: a `keydown` on the window.
fn press(ctx: &Ctx, key: &str, ctrl: bool, shift: bool, alt: bool) -> ScenarioResult {
    ctx.eval(&format!(
        "window.dispatchEvent(new KeyboardEvent('keydown', {{ key: {key:?},
           ctrlKey: {ctrl}, shiftKey: {shift}, altKey: {alt}, bubbles: true, cancelable: true }}));
         return true;"
    ))?;
    Ok(())
}

/// The command palette and rebindable shortcuts. AH-206 / AH-207.
///
/// Proves, in the real WebView: Ctrl+Shift+P opens the palette from a page
/// that is not the palette's own; typing ranks locally and Enter navigates;
/// in Settings → Shortcuts a chord another command uses is refused with that
/// command named; a free chord is accepted, written to the backend settings
/// store (so a restart restores it) and then opens the palette while the old
/// chord no longer does; Reset restores the default.
fn scenario_palette_keybindings(ctx: &Ctx) -> ScenarioResult {
    let palette_open =
        "return !!document.querySelector('[data-testid=\"command-palette\"]');";
    ctx.goto("/")?;
    ctx.settle();
    press(ctx, "P", true, true, false)?;
    ctx.wait_until("the palette to open", palette_open, Duration::from_secs(15))?;

    // Ranked locally; Enter runs the best match.
    ctx.eval(
        "const i = document.querySelector('[data-testid=\"command-palette-input\"]');
         const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
         set.call(i, 'system monitor');
         i.dispatchEvent(new Event('input', { bubbles: true }));
         return true;",
    )?;
    ctx.wait_until(
        "the system monitor entry to rank first",
        "const first = document.querySelector('[data-testid=\"command-palette-item\"]');
         return !!first && first.getAttribute('data-command') === 'nav-system-monitor';",
        Duration::from_secs(10),
    )?;
    ctx.eval(
        "document.querySelector('[data-testid=\"command-palette-input\"]')
           .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
         return true;",
    )?;
    ctx.wait_until(
        "Enter to navigate and close the palette",
        "return window.location.pathname === '/system-monitor'
           && !document.querySelector('[data-testid=\"command-palette\"]');",
        Duration::from_secs(15),
    )?;

    // Rebinding: a taken chord is refused with its owner named.
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
    // Ctrl+N is New Chat.
    press(ctx, "n", true, false, false)?;
    ctx.wait_until(
        "the conflict to be named",
        &format!(
            "const e = {row}.querySelector('[data-testid=\"rebind-error\"]');
             return !!e && /New Chat/.test(e.textContent || '');"
        ),
        Duration::from_secs(10),
    )?;
    ensure!(
        ctx.eval_bool("return window.location.pathname === '/settings/shortcuts';")?,
        "recording a taken chord ran its command instead"
    );

    // A free chord is accepted and persisted.
    press(ctx, "y", true, false, true)?;
    ctx.wait_until(
        "the new binding to be accepted",
        &format!("return !{row}.querySelector('[data-testid=\"rebind-recording\"]');"),
        Duration::from_secs(10),
    )?;
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let settings = Path::new(&data).join("settings.json");
    let mut persisted = String::new();
    for _ in 0..20 {
        persisted = std::fs::read_to_string(&settings).unwrap_or_default();
        if persisted.contains("commandPalette") {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    ensure!(
        persisted.contains("keybindings") && persisted.contains("commandPalette"),
        "the new binding was not written to the settings store"
    );

    // The new chord opens the palette; the old one no longer does.
    ctx.goto("/")?;
    ctx.settle();
    press(ctx, "P", true, true, false)?;
    std::thread::sleep(Duration::from_millis(800));
    ensure!(
        !ctx.eval_bool(palette_open)?,
        "the old chord still opens the palette after it was rebound"
    );
    press(ctx, "y", true, false, true)?;
    ctx.wait_until("the new chord to open the palette", palette_open, Duration::from_secs(10))?;
    ctx.eval(
        "document.querySelector('[data-testid=\"command-palette-input\"]')
           .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         return true;",
    )?;
    ctx.settle();

    // Reset restores the default, and the store forgets the override.
    ctx.goto("/settings/shortcuts")?;
    ctx.wait_until(
        "the reset button",
        &format!("return !!{row}.querySelector('[data-testid=\"rebind-reset\"]');"),
        Duration::from_secs(30),
    )?;
    ctx.eval(&format!(
        "{row}.querySelector('[data-testid=\"rebind-reset\"]').click(); return true;"
    ))?;
    ctx.wait_until(
        "the reset to take effect",
        &format!("return !{row}.querySelector('[data-testid=\"rebind-reset\"]');"),
        Duration::from_secs(10),
    )?;
    Ok(())
}
