fn scenario_managed_worktree_review(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let file = "proposal-target.txt";
    let base: String = (1..=12).map(|i| format!("line {i}\n")).collect();
    let with = |lines: &[(usize, &str)]| -> String {
        (1..=12)
            .map(|i| match lines.iter().find(|(n, _)| *n == i) {
                Some((_, text)) => format!("{text}\n"),
                None => format!("line {i}\n"),
            })
            .collect()
    };
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();
    if git(&ctx.project, &["ls-files", "--error-unmatch", file]).is_err() {
        std::fs::write(ctx.project.join(file), &base).map_err(|e| fail(e.to_string()))?;
        git(&ctx.project, &["add", file]).map_err(fail)?;
        git(&ctx.project, &["commit", "-qm", "proposal base"]).map_err(fail)?;
    }
    std::fs::write(ctx.project.join(file), &base).map_err(|e| fail(e.to_string()))?;
    let _ = std::fs::remove_file(ctx.project.join("shell-made.txt"));

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
    choose_access(ctx, "Managed worktree")?;
    choose_mode(ctx, "Ask before changes")?;
    // The tool list a Cowork run is built from asks readiness with no project
    // root, so this is the answer that decides whether the run gets `bash`.
    if let Ok((true, advertised)) = ipc(
        ctx,
        "plugin:agent-tools|advertised_tool_schemas",
        "{ projectRoot: null, reported: null }",
    ) {
        let bash: Vec<String> = advertised["omitted"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|o| o["name"] == "bash")
            .map(|o| o["message"].as_str().unwrap_or("").to_string())
            .collect();
        println!(
            "      NOTE: for a run with no project root, bash {}",
            if bash.is_empty() { "is advertised".to_string() } else { format!("is withheld: {}", bash.join("; ")) }
        );
    }

    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let project = ctx.project.to_string_lossy().to_string();
    let (ok, listed) = ipc(
        ctx,
        "agent_worktree_list",
        &format!("{{ dataFolder: {data:?}, project: {project:?} }}"),
    )?;
    ensure!(ok, "could not list worktrees: {listed}");
    let worktree = listed
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r.get("path").and_then(Value::as_str))
        .map(PathBuf::from)
        .max_by_key(|p| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        })
        .ok_or_else(|| fail(format!("choosing Managed worktree made no worktree: {listed}")))?;
    let _ = git(&worktree, &["checkout", "--", "."]);
    let _ = std::fs::remove_file(worktree.join("shell-made.txt"));
    // Explicitly, not only through git: a retry must find the file as it was
    // before the write, or the write changes nothing and there is no diff to
    // show in its prompt.
    std::fs::write(worktree.join(file), &base).map_err(|e| fail(e.to_string()))?;

    // The run: one file write and one shell command, both relative to the
    // run's root, which in this mode is the worktree.
    let proposed = with(&[(1, "LINE 1 (agent)"), (10, "LINE 10 (agent)")]);
    // Absolute paths into the worktree, as the run is told: its tool root is
    // its own sandbox, and the folder it may change is named by path.
    let target_path = worktree.join(file).to_string_lossy().to_string();
    let shell_target = worktree.join("shell-made.txt").to_string_lossy().to_string();
    let write_call = format!(
        "write:{}",
        serde_json::json!({ "path": target_path, "content": proposed })
    );
    let bash_call = format!(
        "bash:{}",
        // Spaced, so it redirects in every shell this host can select: without
        // the space PowerShell reads `from-the-shell>` as one word and echoes it.
        serde_json::json!({ "command": format!("echo from-the-shell > \"{shell_target}\"") })
    );
    ctx.script_model("tools", &[write_call.as_str(), bash_call.as_str()])?;
    ctx.ensure_model_selected()?;
    ctx.type_into("[data-testid=\"chat-input\"]", "update the target file")?;
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
    // Approve each change as a person would, until the run is over. Generous:
    // choosing a shell probes each candidate for up to ten seconds.
    let deadline = std::time::Instant::now() + Duration::from_secs(240);
    // AH-146: the write's prompt shows the change before it is allowed.
    let mut saw_preview = false;
    loop {
        if !saw_preview {
            saw_preview = ctx
                .eval_bool(
                    "const p = document.querySelector('[data-testid=\"approval-preview\"]');
                     return !!p && p.textContent.includes('LINE 1 (agent)');",
                )
                .unwrap_or(false);
        }
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
            "the run did not finish (tool item shown: {started}, composer idle: {idle}, \
             prompt preview seen: {saw_preview}); {}",
            run_state(ctx)
        );
        std::thread::sleep(Duration::from_millis(700));
    }

    ensure!(
        saw_preview,
        "the write's approval prompt did not show the change it would make"
    );
    ensure!(
        read(&worktree.join(file)) == proposed,
        "the write did not land in the worktree: {:?}",
        read(&worktree.join(file))
    );
    ensure!(read(&ctx.project.join(file)) == base, "the run wrote the attached folder");
    // The shell half is proven only where a shell can be confined at all. A
    // host where every sandboxed shell fails its start-up probe withholds
    // `bash`; that is reported as a limitation of this host, never as a pass.
    let transcript = ctx
        .eval_string("return (document.body.innerText || '');")
        .unwrap_or_default();
    if transcript.contains("bash is unavailable") || transcript.contains("unavailable tool 'bash'") {
        println!(
            "      NOTE: no shell could be started inside the sandbox on this host; \
             the shell's write to the worktree was not exercised"
        );
    } else {
        ensure!(
            shell_text(&worktree.join("shell-made.txt")).contains("from-the-shell"),
            "the confined shell could not write the worktree; transcript: {}",
            {
                // Enough to reach the helper's own diagnostic, which the shell
                // result carries above its exit code.
                let tail: String = transcript.chars().rev().take(3000).collect();
                tail.chars().rev().collect::<String>()
            }
        );
    }
    ensure!(
        !ctx.project.join("shell-made.txt").exists(),
        "the shell wrote the attached folder"
    );

    // Review through the Changes panel, and land one hunk of two.
    ctx.eval_bool(
        r#"const b = [...document.querySelectorAll('button')].find(x =>
             /^Changes$|changed/i.test(x.getAttribute('aria-label') || ''));
           if (!b) return false;
           if (b.getAttribute('aria-pressed') !== 'true') b.click();
           return true;"#,
    )?;
    ctx.wait_until(
        "the Review changes button",
        "return !!document.querySelector('[data-testid=\"proposal-create\"]');",
        Duration::from_secs(30),
    )?;
    ctx.eval("document.querySelector('[data-testid=\"proposal-create\"]').click(); return true;")?;
    ctx.wait_until(
        "the proposed file",
        &format!(
            "return !!document.querySelector('[data-testid=\"proposal-file\"][data-path={file:?}]');"
        ),
        Duration::from_secs(30),
    )?;
    ctx.eval(&format!(
        "const f = document.querySelector('[data-testid=\"proposal-file\"][data-path={file:?}]');
         f.querySelectorAll('[data-testid=\"proposal-hunk-toggle\"]')[1].click();
         const other = document.querySelector('[data-testid=\"proposal-file\"][data-path=\"shell-made.txt\"]');
         if (other) other.querySelector('[data-testid=\"proposal-file-toggle\"]').click();
         return true;"
    ))?;
    ctx.settle();
    ctx.eval("document.querySelector('[data-testid=\"proposal-apply\"]').click(); return true;")?;
    ctx.wait_until(
        "the apply to finish",
        "return !!(document.querySelector('[data-testid=\"proposal-message\"]')
           || document.querySelector('[data-testid=\"proposal-error\"]'));",
        Duration::from_secs(30),
    )?;
    let refused = ctx.eval_string(
        "const e = document.querySelector('[data-testid=\"proposal-error\"]');
         return e ? e.textContent : '';",
    )?;
    ensure!(refused.is_empty(), "applying the selection was refused: {refused}");
    ensure!(
        read(&ctx.project.join(file)) == with(&[(1, "LINE 1 (agent)")]),
        "the folder does not hold exactly the ticked hunk: {:?}",
        read(&ctx.project.join(file))
    );
    ensure!(
        !ctx.project.join("shell-made.txt").exists(),
        "an unticked file was applied"
    );

    let _ = choose_access(ctx, "Review only");
    std::fs::write(ctx.project.join(file), &base).map_err(|e| fail(e.to_string()))?;
    Ok(())
}

const TEAM_FILE: &str = "team-target.txt";
const TEAM_MARKER: &str = "team-review-phase-1.json";

fn team_lines(changes: &[(usize, &str)]) -> String {
    (1..=12)
        .map(|i| match changes.iter().find(|(n, _)| *n == i) {
            Some((_, text)) => format!("{text}\n"),
            None => format!("line {i}\n"),
        })
        .collect()
}

/// Every team child the backend recorded for the fixture project.
fn team_children(ctx: &Ctx) -> Result<Vec<Value>, Failure> {
    let project = ctx.project.to_string_lossy().to_string();
    let (ok, listed) = ipc(
        ctx,
        "agent_team_children_list",
        &format!("{{ project: {project:?}, session: null }}"),
    )?;
    ensure!(ok, "could not list team children: {listed}");
    Ok(listed.as_array().cloned().unwrap_or_default())
}

fn child<'a>(all: &'a [Value], task: &str) -> Option<&'a Value> {
    all.iter().find(|c| c["taskId"] == task)
}

/// The chat requests the model fixture has seen, newest last.
fn mock_requests(ctx: &Ctx) -> Result<Vec<Value>, Failure> {
    let port = ctx.mock_port;
    let raw = ctx.eval_string(&format!(
        "const r = await fetch('http://127.0.0.1:{port}/__requests');
         return JSON.stringify((await r.json()).requests || []);"
    ))?;
    serde_json::from_str(&raw).map_err(|e| Failure(format!("mock requests: {e}")))
}

/// Open the Changes rail and wait for the team review list with `rows` rows.
fn open_team_reviews(ctx: &Ctx, rows: usize) -> ScenarioResult {
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
        &format!("{rows} team children in the review list"),
        &format!(
            "return document.querySelectorAll('[data-testid=\"team-child\"]').length === {rows};"
        ),
        Duration::from_secs(40),
    )
}

/// One attribute of a child's row in the review list.
fn row_attr(ctx: &Ctx, task: &str, attr: &str) -> Result<String, Failure> {
    ctx.eval_string(&format!(
        "const r = document.querySelector('[data-testid=\"team-child\"][data-task={task:?}]');
         return r ? (r.getAttribute({attr:?}) || '') : '(no row)';"
    ))
}

/// Evaluate inside one child's row: `row` is bound to it.
fn in_row(ctx: &Ctx, task: &str, js: &str) -> Result<Value, Failure> {
    ctx.eval(&format!(
        "const row = document.querySelector('[data-testid=\"team-child\"][data-task={task:?}]');
         if (!row) throw new Error('no row for {task}');
         {js}"
    ))
}

/// Open a child's review, make (or load) its proposal, and wait for its files.
fn open_child_review(ctx: &Ctx, task: &str, file: &str) -> ScenarioResult {
    in_row(
        ctx,
        task,
        "const b = row.querySelector('[data-testid=\"team-child-review\"]');
         if (b.disabled) throw new Error('the review is disabled');
         if (b.getAttribute('aria-expanded') !== 'true') b.click();
         return true;",
    )?;
    let has_file = format!(
        "const row = document.querySelector('[data-testid=\"team-child\"][data-task={task:?}]');
         return !!row && !!row.querySelector('[data-testid=\"proposal-file\"][data-path={file:?}]');"
    );
    // A proposal already stored (after a restart, say) loads by itself; one
    // not yet made is made by asking for it.
    if ctx
        .wait_until("a stored proposal", &has_file, Duration::from_secs(4))
        .is_err()
    {
        in_row(
            ctx,
            task,
            "const b = row.querySelector('[data-testid=\"proposal-create\"]');
             if (!b) throw new Error('no Review changes button');
             b.click(); return true;",
        )?;
    }
    ctx.wait_until(&format!("{task}'s proposed {file}"), &has_file, Duration::from_secs(40))
}

/// Click Apply in a child's review and return the error it shows, if any.
fn apply_child(ctx: &Ctx, task: &str) -> Result<String, Failure> {
    in_row(
        ctx,
        task,
        "row.querySelector('[data-testid=\"proposal-apply\"]').click(); return true;",
    )?;
    ctx.wait_until(
        &format!("{task}'s apply to finish"),
        &format!(
            "const row = document.querySelector('[data-testid=\"team-child\"][data-task={task:?}]');
             return !!row && !!(row.querySelector('[data-testid=\"proposal-message\"]')
               || row.querySelector('[data-testid=\"proposal-error\"]'));"
        ),
        Duration::from_secs(40),
    )?;
    Ok(in_row(
        ctx,
        task,
        "const e = row.querySelector('[data-testid=\"proposal-error\"]');
         return e ? e.textContent : '';",
    )?
    .as_str()
    .unwrap_or_default()
    .to_string())
}

/// Phase one of AH-109 on Windows, through the real app and the mock model.
///
/// A team of four isolated tasks, two of which declare the same file:
/// 1. the overlap is shown before any child runs, naming both tasks and the
///    path, and no child has reached the model or been recorded;
/// 2. it is resolved by running one after the other;
/// 3. every child works in a worktree of its own, and the user's checkout is
///    untouched by the run;
/// 4. the review list names each child's task, branch, base, worktree, files
///    and ending -- one completed, one completed after it, one failed, one
///    cancelled by stopping the run;
/// 5. (through 7) one child's diff is opened and one hunk of two is applied:
///    the folder holds that hunk and not the other;
/// 8. a second child's change is refused against an edit made in the folder
///    since, and nothing of it -- not even its new file -- is written;
/// 11. the failed and cancelled children are shown as such and cannot be
///     reviewed until the person acknowledges it, and a proposal made anyway
///     says so;
/// 10. a junction out of a child's worktree refuses its proposal.
///
/// Phase two restarts the app and checks what is still waiting.
fn scenario_team_review_first(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();
    let base = team_lines(&[]);
    if git(&ctx.project, &["ls-files", "--error-unmatch", TEAM_FILE]).is_err() {
        std::fs::write(ctx.project.join(TEAM_FILE), &base).map_err(|e| fail(e.to_string()))?;
        git(&ctx.project, &["add", TEAM_FILE]).map_err(fail)?;
        git(&ctx.project, &["commit", "-qm", "team base"]).map_err(fail)?;
    }
    std::fs::write(ctx.project.join(TEAM_FILE), &base).map_err(|e| fail(e.to_string()))?;
    for stray in ["beta-new.txt", "gamma.txt", "delta.txt"] {
        let _ = std::fs::remove_file(ctx.project.join(stray));
    }
    let head = git(&ctx.project, &["rev-parse", "HEAD"]).map_err(fail)?.trim().to_string();
    ensure!(
        team_children(ctx)?.is_empty(),
        "this profile already holds team children; phase one needs a fresh one"
    );

    attach_project(ctx)?;
    choose_access(ctx, "Managed worktree")?;
    choose_mode(ctx, "Ask before changes")?;
    // Switching to Managed worktree makes the session's own worktree; until it
    // exists the run is still being set up, and a message sent now goes out
    // with the read-only toolset.
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let project_arg = ctx.project.to_string_lossy().to_string();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let (ok, listed) = ipc(
            ctx,
            "agent_worktree_list",
            &format!("{{ dataFolder: {data:?}, project: {project_arg:?} }}"),
        )?;
        if ok && listed.as_array().is_some_and(|a| !a.is_empty()) {
            break;
        }
        ensure!(Instant::now() < deadline, "choosing Managed worktree made no worktree: {listed}");
        std::thread::sleep(Duration::from_millis(500));
    }
    ctx.settle();
    // What the tool list says about the shell here, in the app's own process.
    let (ok, advertised) = ipc(
        ctx,
        "plugin:agent-tools|advertised_tool_schemas",
        &format!("{{ projectRoot: {project_arg:?}, reported: null }}"),
    )?;
    if ok {
        let bash: Vec<String> = advertised["omitted"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|o| o["name"] == "bash")
            .map(|o| o["message"].as_str().unwrap_or("").to_string())
            .collect();
        println!(
            "      NOTE: bash {}",
            if bash.is_empty() { "is advertised".to_string() } else { format!("is withheld: {}", bash.join("; ")) }
        );
    }

    let alpha = team_lines(&[(1, "LINE 1 (alpha)"), (10, "LINE 10 (alpha)")]);
    let beta = team_lines(&[(5, "LINE 5 (beta)")]);
    let write = |file: &str, content: &str| {
        format!(
            "write:{}",
            serde_json::json!({ "path": format!("{{{{FOLDER}}}}/{file}"), "content": content })
        )
    };
    let team = serde_json::json!({ "tasks": [
        { "id": "alpha", "description": "TASK-ALPHA: rewrite lines 1 and 10 of team-target.txt",
          "writes": [TEAM_FILE], "isolate": true },
        { "id": "beta", "description": "TASK-BETA: rewrite line 5 of team-target.txt and add beta-new.txt",
          "writes": [TEAM_FILE, "beta-new.txt"], "isolate": true },
        { "id": "gamma", "description": "TASK-GAMMA: add gamma.txt",
          "writes": ["gamma.txt"], "isolate": true },
        { "id": "delta", "description": "TASK-DELTA: add delta.txt",
          "writes": ["delta.txt"], "isolate": true }
    ]});
    let routes = serde_json::json!([
        { "match": "TASK-ALPHA", "tools": [write(TEAM_FILE, &alpha)], "summary": "alpha done" },
        { "match": "TASK-BETA", "tools": [write(TEAM_FILE, &beta), write("beta-new.txt", "made by beta\n")],
          "summary": "beta done" },
        { "match": "TASK-GAMMA", "tools": [write("gamma.txt", "half of gamma\n")], "then": "fail" },
        { "match": "TASK-DELTA", "tools": [write("delta.txt", "delta so far\n")], "then": "slow" }
    ]);
    let port = ctx.mock_port;
    let team_call = format!("team:{team}");
    ensure!(
        ctx.eval_bool(&format!(
            r#"const res = await fetch('http://127.0.0.1:{port}/__control', {{
                 method: 'POST', headers: {{ 'Content-Type': 'application/json' }},
                 body: JSON.stringify({{ script: 'tools', tools: [{team_call:?}], routes: {routes} }}),
               }});
               return res.ok;"#
        ))?,
        "could not script the team"
    );
    ctx.ensure_model_selected()?;
    // An imperative: a first message that only describes work is answered
    // with a read-only proposal, by design, and could not dispatch a team.
    ctx.type_into("[data-testid=\"chat-input\"]", "Implement these four tasks as a team.")?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]');
         return !!b && b.disabled !== true;",
        Duration::from_secs(60),
    )?;
    ctx.eval("document.querySelector('[data-test-id=\"send-message-button\"]').click(); return true;")?;

    // 1. The overlap, before anything runs.
    // In Ask mode the team call itself waits for Allow once, like any call
    // that can change something; the overlap is shown after that, and before
    // any child is provisioned.
    let shown_by = Instant::now() + Duration::from_secs(90);
    let mut seen = false;
    while Instant::now() < shown_by {
        let _ = ctx.eval(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /^allow once$/i.test((x.textContent || '').trim()));
             if (b) b.click();
             return true;",
        );
        if ctx
            .eval_bool(
                "const r = document.querySelector('[data-testid=\"team-conflict\"]');
                 return !!r && r.getAttribute('data-tasks') === 'alpha,beta';",
            )
            .unwrap_or(false)
        {
            seen = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(700));
    }
    if !seen {
        let e = "the overlap between alpha and beta was not shown within 90s";
        let offered: Vec<String> = mock_requests(ctx)
            .unwrap_or_default()
            .iter()
            .map(|r| {
                r["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|t| t["function"]["name"].as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .collect();
        bail!("{e}
      tools offered per request: {offered:?}
      {}", run_state(ctx));
    }
    let shown = ctx.eval_string(
        "return document.querySelector('[data-testid=\"team-conflicts\"]').innerText;",
    )?;
    ensure!(
        shown.contains(TEAM_FILE) && shown.contains("TASK-ALPHA") && shown.contains("TASK-BETA"),
        "the overlap does not name both tasks and the path: {shown}"
    );
    ensure!(
        ctx.eval_bool("return document.querySelectorAll('[data-testid=\"team-conflict\"]').length === 1;")?,
        "only alpha and beta overlap, but more was reported"
    );
    let early = mock_requests(ctx)?;
    ensure!(
        !serde_json::to_string(&early).unwrap_or_default().contains("TASK-ALPHA: rewrite")
            || early.iter().all(|r| {
                r["messages"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|m| m["role"] == "user")
                    .all(|m| !m.to_string().contains("TASK-"))
            }),
        "a child reached the model before the overlap was decided"
    );
    ensure!(
        team_children(ctx)?.is_empty(),
        "a child was recorded as started before the overlap was decided"
    );

    // 2. Run one after the other.
    ctx.eval(
        "const r = document.querySelector('[data-testid=\"team-conflict\"]');
         r.querySelector('input[data-choice=\"serialize-ab\"]').click();
         return true;",
    )?;
    ctx.wait_until(
        "Continue to arm",
        "const b = document.querySelector('[data-testid=\"team-conflicts-continue\"]');
         return !!b && !b.disabled;",
        Duration::from_secs(10),
    )?;
    ctx.eval("document.querySelector('[data-testid=\"team-conflicts-continue\"]').click(); return true;")?;

    // 3. The children work, each write allowed as a person would; the run is
    // stopped once only delta -- scripted never to finish -- is left.
    let deadline = Instant::now() + Duration::from_secs(300);
    let mut stopped = false;
    loop {
        let _ = ctx.eval(
            "const b = [...document.querySelectorAll('button')].find(x =>
               /^allow once$/i.test((x.textContent || '').trim()));
             if (b) b.click();
             return true;",
        );
        let all = team_children(ctx)?;
        let status = |t: &str| {
            child(&all, t)
                .and_then(|c| c["status"].as_str())
                .unwrap_or("-")
                .to_string()
        };
        let delta_wrote = child(&all, "delta")
            .map(|c| Path::new(c["worktreePath"].as_str().unwrap_or("")).join("delta.txt").exists())
            .unwrap_or(false);
        if !stopped
            && status("alpha") == "completed"
            && status("beta") == "completed"
            && status("gamma") == "failed"
            && status("delta") == "running"
            && delta_wrote
        {
            // Cowork's own stop: a menu, and "Stop current task" ends this
            // response and everything under it -- here, delta.
            ctx.eval(
                "const b = document.querySelector('[data-testid=\"cowork-stop\"]');
                 if (!b) throw new Error('no stop control');
                 b.click(); return true;",
            )?;
            ctx.wait_until(
                "the stop menu",
                "return !!document.querySelector('[data-testid=\"stop-current\"]');",
                Duration::from_secs(10),
            )?;
            ctx.eval(
                "document.querySelector('[data-testid=\"stop-current\"]').click(); return true;",
            )?;
            stopped = true;
        }
        if stopped && status("delta") == "cancelled" {
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "the team did not reach the expected endings (alpha {}, beta {}, gamma {}, delta {}, delta wrote {delta_wrote}); {}",
            status("alpha"),
            status("beta"),
            status("gamma"),
            status("delta"),
            run_state(ctx)
        );
        std::thread::sleep(Duration::from_millis(700));
    }
    ctx.wait_until(
        "the composer to be idle after stopping",
        "return !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(60),
    )?;

    let all = team_children(ctx)?;
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let roots = tauri_plugin_agent_tools::workspace::worktrees_dir(Path::new(&data))
        .canonicalize()
        .map_err(|e| fail(format!("Jan's worktree folder: {e}")))?;
    let mut paths = std::collections::BTreeSet::new();
    for task in ["alpha", "beta", "gamma", "delta"] {
        let c = child(&all, task).ok_or_else(|| fail(format!("{task} was never recorded")))?;
        let wt = PathBuf::from(c["worktreePath"].as_str().unwrap_or_default());
        let resolved = wt.canonicalize().map_err(|e| fail(format!("{task}'s worktree: {e}")))?;
        ensure!(resolved.starts_with(&roots), "{task} worked outside Jan's worktrees: {}", wt.display());
        ensure!(c["baseSha"] == head.as_str(), "{task}'s base is not the project's HEAD: {}", c["baseSha"]);
        ensure!(
            c["branch"].as_str().unwrap_or("").starts_with("jan/cowork/"),
            "{task}'s branch is not Jan's: {}",
            c["branch"]
        );
        paths.insert(resolved);
    }
    ensure!(paths.len() == 4, "two children shared a worktree");
    let a = child(&all, "alpha").unwrap();
    let b = child(&all, "beta").unwrap();
    ensure!(
        a["endedAt"].as_str().unwrap_or("~") <= b["startedAt"].as_str().unwrap_or(""),
        "beta started before alpha finished: alpha ended {}, beta started {}",
        a["endedAt"],
        b["startedAt"]
    );
    let alpha_wt = PathBuf::from(a["worktreePath"].as_str().unwrap_or_default());
    ensure!(read(&alpha_wt.join(TEAM_FILE)) == alpha, "alpha's change is not in its worktree");
    ensure!(read(&ctx.project.join(TEAM_FILE)) == base, "the team wrote the attached folder");
    for stray in ["beta-new.txt", "gamma.txt", "delta.txt"] {
        ensure!(!ctx.project.join(stray).exists(), "a child wrote {stray} into the attached folder");
    }

    // 4. The review list.
    open_team_reviews(ctx, 4)?;
    for (task, state) in [("alpha", "completed"), ("beta", "completed"), ("gamma", "failed"), ("delta", "cancelled")] {
        let got = row_attr(ctx, task, "data-state")?;
        ensure!(got == state, "{task} is listed as {got}, not {state}");
    }
    let identity = in_row(
        ctx,
        "alpha",
        "return row.querySelector('[data-testid=\"team-child-identity\"]').textContent
           + '|' + [...row.querySelectorAll('[data-testid=\"team-child-file\"]')].map(f => f.textContent).join(',');",
    )?;
    let identity = identity.as_str().unwrap_or_default();
    ensure!(
        identity.contains("jan/cowork/") && identity.contains(&head[..10]) && identity.contains(TEAM_FILE)
            && identity.contains("+2") && identity.contains("-2"),
        "alpha's row does not identify its branch, base and change: {identity}"
    );

    // 11. Failed and cancelled children cannot pass as clean work.
    for task in ["gamma", "delta"] {
        ensure!(
            row_attr(ctx, task, "data-problem")? == "incomplete",
            "{task}'s ending is not reported as a problem"
        );
        let disabled = in_row(
            ctx,
            task,
            "return row.querySelector('[data-testid=\"team-child-review\"]').disabled;",
        )?;
        ensure!(disabled == Value::Bool(true), "{task} can be reviewed without acknowledging how it ended");
    }
    let project = ctx.project.to_string_lossy().to_string();
    let _ = project;
    let session = a["parentSession"].as_str().unwrap_or_default().to_string();
    let (ok, refused) = ipc(
        ctx,
        "agent_team_child_propose",
        &format!("{{ parentSession: {session:?}, taskId: 'gamma', acknowledge: false }}"),
    )?;
    ensure!(
        !ok && refused["kind"] == "incomplete",
        "a failed child's work was proposed as clean: {refused}"
    );
    in_row(
        ctx,
        "gamma",
        "row.querySelector('[data-testid=\"team-child-acknowledge\"]').click(); return true;",
    )?;
    ctx.settle();
    open_child_review(ctx, "gamma", "gamma.txt")?;
    let subject = in_row(
        ctx,
        "gamma",
        "const s = row.querySelector('[data-testid=\"proposal-subject\"]'); return s ? s.textContent : '';",
    )?;
    ensure!(
        subject.as_str().unwrap_or("").contains("failed, reviewed despite the warning"),
        "the proposal of a failed child does not say so: {subject}"
    );

    // 5-7. Alpha: the diff, one hunk of two.
    open_child_review(ctx, "alpha", TEAM_FILE)?;
    let hunks = in_row(
        ctx,
        "alpha",
        &format!(
            "const f = row.querySelector('[data-testid=\"proposal-file\"][data-path={TEAM_FILE:?}]');
             const t = f.querySelectorAll('[data-testid=\"proposal-hunk-toggle\"]');
             if (t.length !== 2) return t.length;
             t[1].click();
             return f.innerText;"
        ),
    )?;
    let hunks = hunks.as_str().unwrap_or_default().to_string();
    ensure!(
        hunks.contains("LINE 1 (alpha)") && hunks.contains("LINE 10 (alpha)"),
        "alpha's diff does not show both hunks: {hunks}"
    );
    ctx.settle();
    let refused = apply_child(ctx, "alpha")?;
    ensure!(refused.is_empty(), "applying alpha's first hunk was refused: {refused}");
    let after_alpha = team_lines(&[(1, "LINE 1 (alpha)")]);
    ensure!(
        read(&ctx.project.join(TEAM_FILE)) == after_alpha,
        "the folder does not hold exactly alpha's ticked hunk: {:?}",
        read(&ctx.project.join(TEAM_FILE))
    );

    // 8. Beta against an edit made in the folder since: refused, nothing written.
    let mine = team_lines(&[(1, "LINE 1 (alpha)"), (5, "line 5 (mine)")]);
    std::fs::write(ctx.project.join(TEAM_FILE), &mine).map_err(|e| fail(e.to_string()))?;
    open_child_review(ctx, "beta", TEAM_FILE)?;
    ensure!(
        in_row(ctx, "beta", "return !!row.querySelector('[data-testid=\"proposal-file\"][data-path=\"beta-new.txt\"]');")?
            == Value::Bool(true),
        "beta's new file is not in its review"
    );
    let refused = apply_child(ctx, "beta")?;
    ensure!(!refused.is_empty(), "beta applied over an edit made in the folder since");
    ensure!(
        in_row(ctx, "beta", "return !!row.querySelector('[data-testid=\"proposal-conflict\"]');")? == Value::Bool(true),
        "the conflict is not shown against beta's hunk"
    );
    ensure!(read(&ctx.project.join(TEAM_FILE)) == mine, "a refused apply changed the folder");
    ensure!(!ctx.project.join("beta-new.txt").exists(), "a refused apply wrote part of beta's change");

    // 10. A junction out of gamma's worktree.
    let outside = ctx.workspace.join("team-outside");
    std::fs::create_dir_all(&outside).map_err(|e| fail(e.to_string()))?;
    std::fs::write(outside.join("secret.txt"), "not the child's\n").map_err(|e| fail(e.to_string()))?;
    let gamma_wt = PathBuf::from(child(&all, "gamma").unwrap()["worktreePath"].as_str().unwrap_or_default());
    let link = gamma_wt.join("escape");
    if !link.exists() {
        // `mklink` reads a forward slash as a switch, and the kept workspace
        // path is spelled with them.
        let native = |p: &Path| p.to_string_lossy().replace('/', "\\");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(native(&link))
            .arg(native(&outside))
            .output()
            .map_err(|e| fail(e.to_string()))?;
        ensure!(made.status.success(), "could not make a junction: {}", String::from_utf8_lossy(&made.stderr));
    }
    let (ok, refused) = ipc(
        ctx,
        "agent_team_child_propose",
        &format!("{{ parentSession: {session:?}, taskId: 'gamma', acknowledge: true }}"),
    )?;
    ensure!(
        !ok && refused["kind"] == "link-escape",
        "a junction out of a child's worktree did not refuse its proposal: {refused}"
    );

    std::fs::write(
        ctx.workspace.join(TEAM_MARKER),
        serde_json::json!({ "session": session, "head": head }).to_string(),
    )
    .map_err(|e| fail(e.to_string()))
}

/// Phase two, a new process on the same profile: every child is still listed
/// with its ending, alpha as partly applied, beta's review still waiting with
/// its proposal intact, gamma refused for its junction -- and beta applies once
/// the folder no longer conflicts.
fn scenario_team_review_second(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();
    let marker: Value = serde_json::from_str(
        &std::fs::read_to_string(ctx.workspace.join(TEAM_MARKER))
            .map_err(|_| fail("phase one did not run against this workspace".into()))?,
    )
    .map_err(|e| fail(e.to_string()))?;
    let session = marker["session"].as_str().unwrap_or_default().to_string();

    let all = team_children(ctx)?;
    ensure!(all.len() == 4, "the restart lost team children: {} left", all.len());
    for (task, state) in [("alpha", "completed"), ("beta", "completed"), ("gamma", "failed"), ("delta", "cancelled")] {
        let got = child(&all, task).and_then(|c| c["state"].as_str()).unwrap_or("-");
        ensure!(got == state, "after a restart {task} is {got}, not {state}");
    }
    ensure!(
        child(&all, "gamma").and_then(|c| c["problem"]["kind"].as_str()) == Some("link-escape"),
        "after a restart gamma's junction is not reported"
    );

    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    open_team_reviews(ctx, 4)?;
    for (task, proposal) in [("alpha", "partially-applied"), ("beta", "pending"), ("gamma", "pending")] {
        let got = row_attr(ctx, task, "data-proposal")?;
        ensure!(got == proposal, "after a restart {task}'s proposal is {got:?}, not {proposal}");
    }
    ensure!(row_attr(ctx, "delta", "data-state")? == "cancelled", "delta's cancellation was lost");

    // Beta's stored review, reopened; the folder is put back so it can land.
    open_child_review(ctx, "beta", TEAM_FILE)?;
    let after_alpha = team_lines(&[(1, "LINE 1 (alpha)")]);
    std::fs::write(ctx.project.join(TEAM_FILE), &after_alpha).map_err(|e| fail(e.to_string()))?;
    let refused = apply_child(ctx, "beta")?;
    ensure!(refused.is_empty(), "beta's stored proposal was refused after the restart: {refused}");
    ensure!(
        read(&ctx.project.join(TEAM_FILE)) == team_lines(&[(1, "LINE 1 (alpha)"), (5, "LINE 5 (beta)")]),
        "the folder does not hold alpha's hunk and beta's change: {:?}",
        read(&ctx.project.join(TEAM_FILE))
    );
    ensure!(
        read(&ctx.project.join("beta-new.txt")) == "made by beta\n",
        "beta's new file did not land"
    );
    let _ = session;
    // Leave the fixture as it was.
    std::fs::write(ctx.project.join(TEAM_FILE), team_lines(&[])).map_err(|e| fail(e.to_string()))?;
    let _ = std::fs::remove_file(ctx.project.join("beta-new.txt"));
    Ok(())
}

/// A file a shell wrote, as text: Windows PowerShell's `>` writes UTF-16 with
/// a byte-order mark, cmd and bash write bytes as given.
#[allow(clippy::chunks_exact_to_as_chunks)]
fn shell_text(path: &Path) -> String {
    let Ok(bytes) = std::fs::read(path) else {
        return String::new();
    };
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Call a Tauri command over real IPC and hand back its JSON, or the refusal.
///
/// A refusal is data here, not a harness failure: several steps below exist to
/// prove that something is refused.
fn ipc(ctx: &Ctx, command: &str, args: &str) -> Result<(bool, Value), Failure> {
    let out = ctx.eval_string(&format!(
        r#"try {{
             const v = await window.__TAURI_INTERNALS__.invoke({command:?}, {args});
             return JSON.stringify({{ ok: true, v }});
           }} catch (e) {{
             return JSON.stringify({{ ok: false, v: e }});
           }}"#
    ))?;
    let parsed: Value = serde_json::from_str(&out)
        .map_err(|e| Failure(format!("{command} did not answer JSON ({e}): {out}")))?;
    Ok((
        parsed.get("ok").and_then(Value::as_bool).unwrap_or(false),
        parsed.get("v").cloned().unwrap_or(Value::Null),
    ))
}

/// A worktree's work reaches the folder only through a stored, bound proposal.
/// AH-146/147/148/109, on Windows, over real IPC into the real backend.
///
/// Driven through IPC rather than the access menu because Windows cannot
/// offer Managed worktree mode at all: AppContainer cannot yet confine a run
/// to a repository (`jail::supports_write_roots`), so the option is disabled
/// and the review that sits behind it is unreachable here. The backend, git
/// and the filesystem behaviour this proves are the Windows ones.
///
/// Proves: the proposal is stored before anything is approved and the folder is
/// untouched; approving one hunk of two lands only that hunk and an unselected
/// file stays out; a second proposal whose hunk overlaps an edit made in the
/// folder since is refused with that hunk named and nothing written; a changed
/// patch hash and a different agent are both refused; a rejected proposal
/// cannot then be applied; the audit trail holds no file content.
fn scenario_proposal_review(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let file = "proposal-target.txt";
    let added = "agent-added.txt";
    let base: String = (1..=12).map(|i| format!("line {i}\n")).collect();
    let with = |lines: &[(usize, &str)]| -> String {
        (1..=12)
            .map(|i| match lines.iter().find(|(n, _)| *n == i) {
                Some((_, text)) => format!("{text}\n"),
                None => format!("line {i}\n"),
            })
            .collect()
    };
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();

    // Committed in the source before the worktree exists, so it is the base.
    if git(&ctx.project, &["ls-files", "--error-unmatch", file]).is_err() {
        std::fs::write(ctx.project.join(file), &base).map_err(|e| fail(e.to_string()))?;
        git(&ctx.project, &["add", file]).map_err(fail)?;
        git(&ctx.project, &["commit", "-qm", "proposal base"]).map_err(fail)?;
    }
    std::fs::write(ctx.project.join(file), &base).map_err(|e| fail(e.to_string()))?;
    let _ = std::fs::remove_file(ctx.project.join(added));

    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let project = ctx.project.to_string_lossy().to_string();
    let session = "smoke-proposal";
    let (ok, record) = ipc(
        ctx,
        "agent_worktree_ensure",
        &format!("{{ dataFolder: {data:?}, sessionId: {session:?}, project: {project:?} }}"),
    )?;
    ensure!(ok, "could not make the worktree: {record}");
    let worktree = PathBuf::from(record.get("path").and_then(Value::as_str).unwrap_or_default());
    // A retry finds the worktree the last attempt left; start it from its base.
    let _ = git(&worktree, &["checkout", "--", "."]);
    let _ = std::fs::remove_file(worktree.join(added));

    std::fs::write(
        worktree.join(file),
        with(&[(1, "LINE 1 (agent)"), (10, "LINE 10 (agent)")]),
    )
    .map_err(|e| fail(e.to_string()))?;
    std::fs::write(worktree.join(added), "made by the agent\n").map_err(|e| fail(e.to_string()))?;

    let propose = |ctx: &Ctx| -> Result<Value, Failure> {
        let (ok, proposal) = ipc(
            ctx,
            "agent_proposal_from_worktree",
            &format!("{{ record: {record}, session: {session:?}, run: null, agent: null }}"),
        )?;
        ensure!(ok, "the worktree's changes were not proposed: {proposal}");
        Ok(proposal)
    };
    let proposal = propose(ctx)?;
    let id = proposal["id"].as_str().unwrap_or_default().to_string();

    // Stored before anything is approved; the folder untouched by proposing.
    let stored = read(&Path::new(&data).join("proposals").join(format!("{id}.json")));
    ensure!(
        stored.contains("\"state\": \"pending\""),
        "the proposal was not stored before approval"
    );
    ensure!(read(&ctx.project.join(file)) == base, "proposing changed the folder");

    let hunks_of = |p: &Value, path: &str| -> Vec<String> {
        p["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|f| f["path"] == path)
            .flat_map(|f| f["hunks"].as_array().cloned().unwrap_or_default())
            .filter_map(|h| h["id"].as_str().map(str::to_string))
            .collect()
    };
    let approval = |p: &Value, files: Value| -> Value {
        serde_json::json!({
            "proposalId": p["id"],
            "patchHash": p["patchHash"],
            "baseStateHash": p["baseStateHash"],
            "scope": p["scope"],
            "files": files,
        })
    };
    let hunks = hunks_of(&proposal, file);
    ensure!(hunks.len() == 2, "expected two hunks, got {hunks:?}");

    // Tampered and foreign approvals are refused before anything is written.
    let mut tampered = approval(&proposal, serde_json::json!([{ "path": file, "hunks": { "kind": "all" } }]));
    tampered["patchHash"] = Value::String("0".repeat(64));
    let (ok, refusal) = ipc(ctx, "agent_proposal_apply", &format!("{{ approval: {tampered} }}"))?;
    ensure!(!ok, "an approval for a different patch was applied");
    ensure!(
        refusal.to_string().contains("different version"),
        "the refusal did not say why: {refusal}"
    );
    let mut foreign = approval(&proposal, serde_json::json!([{ "path": file, "hunks": { "kind": "all" } }]));
    foreign["scope"]["agent"] = Value::String("reviewer".into());
    let (ok, _) = ipc(ctx, "agent_proposal_apply", &format!("{{ approval: {foreign} }}"))?;
    ensure!(!ok, "an approval naming another agent was applied");
    ensure!(read(&ctx.project.join(file)) == base, "a refused approval wrote the folder");

    // One hunk of two, and not the added file.
    let first = approval(
        &proposal,
        serde_json::json!([{ "path": file, "hunks": { "kind": "only", "ids": [hunks[0]] } }]),
    );
    let (ok, report) = ipc(ctx, "agent_proposal_apply", &format!("{{ approval: {first} }}"))?;
    ensure!(ok, "applying one hunk was refused: {report}");
    ensure!(
        report["state"] == "partially-applied",
        "one hunk of two should be a partial apply: {report}"
    );
    ensure!(
        read(&ctx.project.join(file)) == with(&[(1, "LINE 1 (agent)")]),
        "the folder does not hold exactly the approved hunk: {:?}",
        read(&ctx.project.join(file))
    );
    ensure!(!ctx.project.join(added).exists(), "an unselected file was applied");

    // Second round: the agent changes line 6, and so does the person, in the
    // folder, before approving. Refused, the hunk named, nothing written.
    std::fs::write(
        worktree.join(file),
        with(&[(1, "LINE 1 (agent)"), (6, "LINE 6 (agent)"), (10, "LINE 10 (agent)")]),
    )
    .map_err(|e| fail(e.to_string()))?;
    let second = propose(ctx)?;
    let user_edit = with(&[(1, "LINE 1 (agent)"), (6, "line 6 (edited by the person)")]);
    std::fs::write(ctx.project.join(file), &user_edit).map_err(|e| fail(e.to_string()))?;
    let everything = approval(
        &second,
        serde_json::json!([
            { "path": file, "hunks": { "kind": "all" } },
            { "path": added, "hunks": { "kind": "all" } }
        ]),
    );
    let (ok, refusal) = ipc(ctx, "agent_proposal_apply", &format!("{{ approval: {everything} }}"))?;
    ensure!(!ok, "an apply over a conflicting edit went through");
    let conflicts = refusal["conflicts"].as_array().cloned().unwrap_or_default();
    ensure!(
        conflicts.len() == 1 && conflicts[0]["path"] == file && conflicts[0]["hunk"] != "",
        "the conflict was not reported against its hunk: {refusal}"
    );
    ensure!(read(&ctx.project.join(file)) == user_edit, "a refused apply wrote the folder");
    ensure!(!ctx.project.join(added).exists(), "a refused apply created a file");

    // Rejected, and then not appliable.
    let (ok, rejected) = ipc(
        ctx,
        "agent_proposal_reject",
        &format!("{{ id: {:?}, scope: {} }}", second["id"].as_str().unwrap_or_default(), second["scope"]),
    )?;
    ensure!(ok && rejected["state"] == "rejected", "rejecting failed: {rejected}");
    let (ok, _) = ipc(ctx, "agent_proposal_apply", &format!("{{ approval: {everything} }}"))?;
    ensure!(!ok, "a rejected proposal was applied");
    ensure!(read(&ctx.project.join(file)) == user_edit, "rejecting changed the folder");

    // The audit trail links every step and holds no content.
    let audit = read(&Path::new(&data).join("audit").join("proposals.jsonl"));
    for event in ["created", "applied", "conflict", "refused", "rejected"] {
        ensure!(
            audit.contains(&format!("\"event\":\"{event}\"")),
            "the proposal audit has no {event} event"
        );
    }
    ensure!(
        !audit.contains("(agent)") && !audit.contains("made by the agent"),
        "the proposal audit holds file content"
    );

    // Leave nothing behind: the worktree is this scenario's own.
    let _ = ipc(
        ctx,
        "agent_worktree_discard",
        &format!("{{ dataFolder: {data:?}, record: {record}, force: true }}"),
    );
    std::fs::write(ctx.project.join(file), &base).map_err(|e| fail(e.to_string()))?;
    Ok(())
}

/// A dependency, a lock file and a migration in a worktree's changes are
/// flagged by the backend, and none of them is applied until the approval
/// acknowledges it -- over real IPC, into the real backend. AH-154/155/156.
fn scenario_proposal_flags(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();
    // In a folder of its own: the fixture project has a package.json of its
    // own at its root, with no dependencies.
    let manifest = "flags-fixture/package.json";
    let lock = "flags-fixture/yarn.lock";
    let migration = "db/migrations/0002_drop_users.sql";
    std::fs::create_dir_all(ctx.project.join("flags-fixture")).map_err(|e| fail(e.to_string()))?;
    let before = "{\n  \"name\": \"fixture\",\n  \"dependencies\": {\n    \"react\": \"^18.0.0\"\n  }\n}\n";
    let after = "{\n  \"name\": \"fixture\",\n  \"dependencies\": {\n    \"react\": \"^19.0.0\",\n    \"left-pad\": \"1.3.0\"\n  }\n}\n";

    if git(&ctx.project, &["ls-files", "--error-unmatch", manifest]).is_err() {
        std::fs::write(ctx.project.join(manifest), before).map_err(|e| fail(e.to_string()))?;
        git(&ctx.project, &["add", manifest]).map_err(fail)?;
        git(&ctx.project, &["commit", "-qm", "flags base"]).map_err(fail)?;
    }
    std::fs::write(ctx.project.join(manifest), before).map_err(|e| fail(e.to_string()))?;
    let _ = std::fs::remove_file(ctx.project.join(lock));
    let _ = std::fs::remove_dir_all(ctx.project.join("db"));

    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let project = ctx.project.to_string_lossy().to_string();
    let session = "smoke-proposal-flags";
    let (ok, record) = ipc(
        ctx,
        "agent_worktree_ensure",
        &format!("{{ dataFolder: {data:?}, sessionId: {session:?}, project: {project:?} }}"),
    )?;
    ensure!(ok, "could not make the worktree: {record}");
    let worktree = PathBuf::from(record.get("path").and_then(Value::as_str).unwrap_or_default());
    let _ = git(&worktree, &["checkout", "--", "."]);
    std::fs::create_dir_all(worktree.join("flags-fixture")).map_err(|e| fail(e.to_string()))?;
    std::fs::write(worktree.join(manifest), after).map_err(|e| fail(e.to_string()))?;
    std::fs::write(worktree.join(lock), "left-pad@1.3.0:\n  resolved \"https://registry.example/left-pad\"\n")
        .map_err(|e| fail(e.to_string()))?;
    std::fs::create_dir_all(worktree.join("db/migrations")).map_err(|e| fail(e.to_string()))?;
    std::fs::write(worktree.join(migration), "DROP TABLE users;\n").map_err(|e| fail(e.to_string()))?;

    let (ok, proposal) = ipc(
        ctx,
        "agent_proposal_from_worktree",
        &format!("{{ record: {record}, session: {session:?}, run: null, agent: null }}"),
    )?;
    ensure!(ok, "the worktree's changes were not proposed: {proposal}");
    let kinds = |path: &str| -> Vec<String> {
        proposal["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|f| f["path"] == path)
            .flat_map(|f| f["flags"].as_array().cloned().unwrap_or_default())
            .filter_map(|f| f["kind"].as_str().map(str::to_string))
            .collect()
    };
    ensure!(kinds(manifest) == ["dependency"], "package.json flags: {:?}", kinds(manifest));
    ensure!(kinds(lock) == ["lockfile"], "yarn.lock flags: {:?}", kinds(lock));
    ensure!(kinds(migration) == ["migration"], "migration flags: {:?}", kinds(migration));
    ensure!(
        proposal.to_string().contains("left-pad (dependencies) added at 1.3.0")
            && proposal.to_string().contains("react (dependencies) changed from ^18.0.0 to ^19.0.0"),
        "the dependency flag does not say what changed: {}",
        proposal["files"]
    );

    let approval = |acknowledged: Value| -> Value {
        serde_json::json!({
            "proposalId": proposal["id"],
            "patchHash": proposal["patchHash"],
            "baseStateHash": proposal["baseStateHash"],
            "scope": proposal["scope"],
            "files": [
                { "path": manifest, "hunks": { "kind": "all" } },
                { "path": lock, "hunks": { "kind": "all" } },
                { "path": migration, "hunks": { "kind": "all" } }
            ],
            "acknowledged": acknowledged,
        })
    };

    // Refused, typed and whole, without the acknowledgement -- and with one
    // that names only some of the flagged files.
    for acknowledged in [serde_json::json!([]), serde_json::json!([manifest])] {
        let a = approval(acknowledged);
        let (ok, refusal) = ipc(ctx, "agent_proposal_apply", &format!("{{ approval: {a} }}"))?;
        ensure!(!ok, "a flagged change was applied without being acknowledged");
        let named: Vec<&str> = refusal["unacknowledged"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        ensure!(
            named.contains(&lock) && named.contains(&migration),
            "the refusal did not name the unacknowledged files: {refusal}"
        );
        ensure!(read(&ctx.project.join(manifest)) == before, "a refused apply wrote package.json");
        ensure!(!ctx.project.join(lock).exists(), "a refused apply wrote the lock file");
        ensure!(!ctx.project.join(migration).exists(), "a refused apply wrote the migration");
    }

    // Acknowledged: everything lands.
    let a = approval(serde_json::json!([manifest, lock, migration]));
    let (ok, report) = ipc(ctx, "agent_proposal_apply", &format!("{{ approval: {a} }}"))?;
    ensure!(ok, "the acknowledged change was refused: {report}");
    ensure!(read(&ctx.project.join(manifest)) == after, "package.json did not land");
    ensure!(ctx.project.join(migration).exists(), "the migration did not land");

    let _ = ipc(
        ctx,
        "agent_worktree_discard",
        &format!("{{ dataFolder: {data:?}, record: {record}, force: true }}"),
    );
    std::fs::write(ctx.project.join(manifest), before).map_err(|e| fail(e.to_string()))?;
    let _ = std::fs::remove_file(ctx.project.join(lock));
    let _ = std::fs::remove_dir_all(ctx.project.join("db"));
    Ok(())
}

/// A managed worktree exports as a patch bundle that reproduces it, over real
/// IPC into the real backend; the user's checkout is not touched, and the
/// checkout itself cannot be exported as if it were a worktree. AH-168.
fn scenario_worktree_export(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let project = ctx.project.to_string_lossy().to_string();
    let session = "smoke-export";
    let file = "export-target.txt";
    if git(&ctx.project, &["ls-files", "--error-unmatch", file]).is_err() {
        std::fs::write(ctx.project.join(file), "a\nb\nc\n").map_err(|e| fail(e.to_string()))?;
        git(&ctx.project, &["add", file]).map_err(fail)?;
        git(&ctx.project, &["commit", "-qm", "export base"]).map_err(fail)?;
    }
    let status_before = git(&ctx.project, &["status", "--porcelain"]).unwrap_or_default();

    let (ok, record) = ipc(
        ctx,
        "agent_worktree_ensure",
        &format!("{{ dataFolder: {data:?}, sessionId: {session:?}, project: {project:?} }}"),
    )?;
    ensure!(ok, "could not make the worktree: {record}");
    let worktree = PathBuf::from(record["path"].as_str().unwrap_or_default());
    let _ = git(&worktree, &["checkout", "--", "."]);

    // Nothing changed yet: a typed refusal, and no bundle.
    let (ok, refused) = ipc(ctx, "agent_worktree_export", &format!("{{ record: {record} }}"))?;
    ensure!(!ok && refused["kind"] == "no-changes", "an unchanged worktree was exported: {refused}");

    std::fs::write(worktree.join(file), "a\nB\nc\n").map_err(|e| fail(e.to_string()))?;
    std::fs::write(worktree.join("export-new.txt"), "new\n").map_err(|e| fail(e.to_string()))?;
    let (ok, report) = ipc(ctx, "agent_worktree_export", &format!("{{ record: {record} }}"))?;
    ensure!(ok, "the export was refused: {report}");
    let bundle = PathBuf::from(report["path"].as_str().unwrap_or_default());
    ensure!(
        bundle.starts_with(Path::new(&data).join("exports")) || bundle.to_string_lossy().contains("exports"),
        "the bundle is not under Jan's exports folder: {}",
        bundle.display()
    );
    let patch = std::fs::read_to_string(bundle.join("changes.patch")).unwrap_or_default();
    ensure!(
        patch.contains("-b\n+B\n") && patch.contains("+++ b/export-new.txt"),
        "the patch does not hold the changes:\n{patch}"
    );
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(bundle.join("manifest.json")).unwrap_or_default(),
    )
    .map_err(|e| fail(format!("manifest: {e}")))?;
    ensure!(manifest["baseSha"] == record["baseSha"], "the manifest names another base: {manifest}");
    ensure!(
        git(&ctx.project, &["status", "--porcelain"]).unwrap_or_default() == status_before,
        "exporting changed the user's checkout"
    );

    // The checkout, dressed as a worktree record, is refused.
    let mut forged = record.clone();
    forged["path"] = Value::String(project.clone());
    let (ok, refused) = ipc(ctx, "agent_worktree_export", &format!("{{ record: {forged} }}"))?;
    ensure!(!ok && refused["kind"] == "not-managed", "the checkout was exported: {refused}");

    let _ = ipc(
        ctx,
        "agent_worktree_discard",
        &format!("{{ dataFolder: {data:?}, record: {record}, force: true }}"),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// AH-169 (and the AH-154/155/156 review UI): importing a bundle through the UI
// ---------------------------------------------------------------------------
