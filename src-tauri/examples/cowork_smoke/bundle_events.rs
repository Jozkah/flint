const BUNDLE_MARKER: &str = "bundle-import-phase-1.json";
const BF: &str = "bundle-fixture";

fn bf(p: &str) -> String {
    format!("{BF}/{p}")
}

fn lines12(edits: &[(usize, &str)]) -> String {
    (1..=12)
        .map(|i| match edits.iter().find(|(n, _)| *n == i) {
            Some((_, t)) => format!("{t}\n"),
            None => format!("{i}\n"),
        })
        .collect()
}

const PKG_BASE: &str = "{\n  \"dependencies\": {\n    \"react\": \"^18.0.0\"\n  }\n}\n";
const PKG_NEW: &str = "{\n  \"dependencies\": {\n    \"react\": \"^18.0.0\",\n    \"left-pad\": \"1.3.0\"\n  }\n}\n";

fn copy_bundle(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)?.flatten() {
        let target = to.join(e.file_name());
        if e.path().is_dir() {
            copy_bundle(&e.path(), &target)?;
        } else {
            std::fs::copy(e.path(), &target)?;
        }
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// Open the Changes rail and wait for the bundle import section.
fn open_bundle_imports(ctx: &Ctx) -> ScenarioResult {
    ctx.wait_until(
        "the Changes rail with the bundle imports",
        r#"const b = [...document.querySelectorAll('button')].find(x =>
             /^Changes$|changed/i.test(x.getAttribute('aria-label') || ''));
           if (b && b.getAttribute('aria-pressed') !== 'true') b.click();
           return !!document.querySelector('[data-testid="bundle-imports"]');"#,
        Duration::from_secs(45),
    )
}

/// Pick `bundle` in the import button's folder picker and wait for the
/// outcome: `Err(kind)` for a refusal, `Ok(rows)` for a new pending row.
fn import_through_ui(ctx: &Ctx, bundle: &Path) -> Result<Result<usize, String>, Failure> {
    let before = ctx.eval_string(
        "return String(document.querySelectorAll('[data-testid=\"bundle-import-row\"]').length);",
    )?;
    let before: usize = before.parse().unwrap_or(0);
    ctx.script_dialog(Some(bundle));
    ctx.eval("document.querySelector('[data-testid=\"bundle-import\"]').click(); return true;")?;
    ctx.settle();
    let settled = ctx.wait_until(
        "the import to finish",
        &format!(
            r#"const e = document.querySelector('[data-testid="bundle-import-error"]');
               const rows = document.querySelectorAll('[data-testid="bundle-import-row"]').length;
               return !document.querySelector('[data-testid="bundle-import-running"]') && (!!e || rows > {before});"#
        ),
        Duration::from_secs(60),
    );
    ctx.clear_dialog_script();
    settled?;
    let kind = ctx.eval_string(
        "const e = document.querySelector('[data-testid=\"bundle-import-error\"]');
         return e ? e.getAttribute('data-kind') : '';",
    )?;
    if !kind.is_empty() {
        return Ok(Err(kind));
    }
    Ok(Ok(before + 1))
}

/// Evaluate in an import's row: `row` is bound to it.
fn in_import(ctx: &Ctx, id: &str, js: &str) -> Result<Value, Failure> {
    ctx.eval(&format!(
        "const row = document.querySelector('[data-testid=\"bundle-import-row\"][data-id={id:?}]');
         if (!row) throw new Error('no row for {id}');
         {js}"
    ))
}

fn toggle_import_review(ctx: &Ctx, id: &str) -> ScenarioResult {
    in_import(ctx, id, "row.querySelector('[data-testid=\"bundle-import-review\"]').click(); return true;")?;
    ctx.settle();
    Ok(())
}

fn wait_import_files(ctx: &Ctx, id: &str) -> ScenarioResult {
    ctx.wait_until(
        "the imported bundle's files in the review",
        &format!(
            r#"const row = document.querySelector('[data-testid="bundle-import-row"][data-id={id:?}]');
               return !!row && row.querySelectorAll('[data-testid="proposal-file"]').length >= 5;"#
        ),
        Duration::from_secs(30),
    )
}

fn imports_list(ctx: &Ctx) -> Result<Vec<Value>, Failure> {
    let project = ctx.project.to_string_lossy().to_string();
    let (ok, listed) = ipc(ctx, "agent_bundle_imports_list", &format!("{{ destination: {project:?} }}"))?;
    ensure!(ok, "listing imports failed: {listed}");
    Ok(listed.as_array().cloned().unwrap_or_default())
}

fn partial_imports() -> Vec<String> {
    std::env::var("JAN_DATA_FOLDER")
        .ok()
        .and_then(|d| std::fs::read_dir(Path::new(&d).join("imports")).ok())
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.ends_with(".partial"))
                .collect()
        })
        .unwrap_or_default()
}

/// A bundle folder with a manifest naming `paths`; for the path refusals.
fn hostile_bundle(dir: &Path, base: &str, paths: &[&str]) -> Result<PathBuf, Failure> {
    let fail = |e: std::io::Error| Failure(e.to_string());
    std::fs::create_dir_all(dir).map_err(fail)?;
    std::fs::write(dir.join("changes.patch"), "").map_err(fail)?;
    let files: Vec<Value> = paths
        .iter()
        .map(|p| serde_json::json!({ "path": p, "change": "added", "additions": 1, "deletions": 0, "whole": true, "sha256": "b".repeat(64) }))
        .collect();
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "createdAt": "t", "repository": "r", "branch": "b",
            "baseSha": base, "headSha": "", "patchSha256": sha256_hex(b""),
            "files": files, "applyWith": ""
        }))
        .unwrap(),
    )
    .map_err(fail)?;
    Ok(dir.to_path_buf())
}

/// Phase one (AH-169 and the AH-154/155/156 review UI). A managed worktree's
/// bundle, exported through AH-168, is imported into the attached project
/// through the UI:
/// every hostile variant is refused with its typed kind and leaves nothing;
/// the review shows every flag, keeps Apply shut until each is acknowledged,
/// refuses a destination changed after review as a whole, and refuses stored
/// flags that were removed on disk; one hunk of two and a subset of files are
/// applied, once, with unrelated work untouched; the same bundle again is
/// refused; a stopped import leaves nothing; and a second import is left
/// pending for phase two.
fn scenario_bundle_import_first(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let ioe = |e: std::io::Error| Failure(e.to_string());
    let read = |p: &Path| std::fs::read(p).unwrap_or_default();
    let data = std::env::var("JAN_DATA_FOLDER").unwrap_or_default();
    let project = ctx.project.clone();
    let project_arg = project.to_string_lossy().to_string();
    ctx.script_model("plain", &[])?;

    // The project at its base, with one unrelated file of the person's own.
    std::fs::create_dir_all(project.join(BF).join("db").join("migrations")).map_err(ioe)?;
    if git(&project, &["ls-files", "--error-unmatch", &bf("target.txt")]).is_err() {
        std::fs::write(project.join(bf("target.txt")), lines12(&[])).map_err(ioe)?;
        std::fs::write(project.join(bf("drop.txt")), "bye\n").map_err(ioe)?;
        std::fs::write(project.join(bf("package.json")), PKG_BASE).map_err(ioe)?;
        std::fs::write(project.join(bf("db/migrations/0001.sql")), "CREATE TABLE a(x int);\n").map_err(ioe)?;
        git(&project, &["add", BF]).map_err(fail)?;
        git(&project, &["commit", "-qm", "bundle base"]).map_err(fail)?;
    }
    let base = git(&project, &["rev-parse", "HEAD"]).map_err(fail)?.trim().to_string();
    let branch = git(&project, &["rev-parse", "--abbrev-ref", "HEAD"]).map_err(fail)?.trim().to_string();
    let unrelated = project.join("bundle-unrelated.txt");
    std::fs::write(&unrelated, b"the person's own work \x01\x02\n").map_err(ioe)?;
    let unrelated_before = read(&unrelated);
    ensure!(imports_list(ctx)?.is_empty(), "this profile already holds imports; phase one needs a fresh one");

    // 1. A managed worktree with every kind of change, exported (AH-168).
    let (ok, record) = ipc(
        ctx,
        "agent_worktree_ensure",
        &format!("{{ dataFolder: {data:?}, sessionId: \"smoke-bundle\", project: {project_arg:?} }}"),
    )?;
    ensure!(ok, "could not make the worktree: {record}");
    let wt = PathBuf::from(record["path"].as_str().unwrap_or_default());
    std::fs::write(wt.join(bf("target.txt")), lines12(&[(1, "ONE"), (11, "ELEVEN")])).map_err(ioe)?;
    let _ = std::fs::remove_file(wt.join(bf("drop.txt")));
    std::fs::write(wt.join(bf("new.txt")), "fresh\n").map_err(ioe)?;
    std::fs::write(wt.join(bf("logo.bin")), [0u8, 1, 2, 255]).map_err(ioe)?;
    std::fs::write(wt.join(bf("package.json")), PKG_NEW).map_err(ioe)?;
    std::fs::write(wt.join(bf("yarn.lock")), "left-pad@1.3.0\n").map_err(ioe)?;
    std::fs::write(wt.join(bf("db/migrations/0002.sql")), "DROP TABLE a;\n").map_err(ioe)?;
    let (ok, exported) = ipc(ctx, "agent_worktree_export", &format!("{{ record: {record} }}"))?;
    ensure!(ok, "the export failed: {exported}");
    let bundle = PathBuf::from(exported["path"].as_str().unwrap_or_default());

    // The UI.
    attach_project(ctx)?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    ctx.ensure_model_selected()?;
    // A session, so the Changes rail has somewhere to hang the imports.
    ctx.type_into("[data-testid=\"chat-input\"]", "bundle import probe")?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]'); return !!b && !b.disabled;",
        Duration::from_secs(60),
    )?;
    ctx.eval("document.querySelector('[data-test-id=\"send-message-button\"]').click(); return true;")?;
    ctx.wait_until(
        "the probe's reply",
        "return document.body.innerText.includes('Hello from the smoke model')
           && !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(90),
    )?;
    open_bundle_imports(ctx)?;

    // 7-9. Hostile bundles, through the same button.
    let scratch = ctx.workspace.join("bundle-variants");
    let _ = std::fs::remove_dir_all(&scratch);
    let variant = |tag: &str| -> Result<PathBuf, Failure> {
        let dir = scratch.join(tag);
        copy_bundle(&bundle, &dir).map_err(|e| Failure(e.to_string()))?;
        Ok(dir)
    };
    let mut cases: Vec<(String, PathBuf, &str)> = Vec::new();
    {
        let d = variant("manifest")?;
        let p = d.join("manifest.json");
        let mut m: Value = serde_json::from_slice(&read(&p)).map_err(|e| fail(e.to_string()))?;
        if let Some(files) = m["files"].as_array_mut() {
            for f in files.iter_mut() {
                if f["whole"] == true {
                    f["sha256"] = Value::String("c".repeat(64));
                }
            }
        }
        std::fs::write(&p, serde_json::to_vec_pretty(&m).unwrap()).map_err(ioe)?;
        cases.push(("tampered manifest".into(), d, "hash-mismatch"));
    }
    {
        let d = variant("binary")?;
        std::fs::write(d.join("files").join(BF).join("logo.bin"), [7u8, 7, 7]).map_err(ioe)?;
        cases.push(("tampered binary".into(), d, "hash-mismatch"));
    }
    {
        let d = variant("junction")?;
        let outside = scratch.join("outside");
        std::fs::create_dir_all(&outside).map_err(ioe)?;
        // mklink reads a forward slash as a switch, so native separators.
        let native = |p: &Path| p.to_string_lossy().replace('/', "\\");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(native(&d.join("files").join("escape")))
            .arg(native(&outside))
            .output()
            .map_err(ioe)?;
        ensure!(
            made.status.success(),
            "could not make a junction: {}{}",
            String::from_utf8_lossy(&made.stdout),
            String::from_utf8_lossy(&made.stderr)
        );
        cases.push(("junction in the bundle".into(), d, "entry-link"));
    }
    for (tag, paths, kind) in [
        ("dotdot", vec!["../outside.txt"], "path-refused"),
        ("absolute", vec!["/etc/passwd"], "path-refused"),
        ("drive", vec!["C:/Windows/evil.txt"], "path-refused"),
        ("unc", vec!["\\\\server\\share\\evil.txt"], "path-refused"),
        ("git", vec![".git/hooks/pre-commit"], "path-refused"),
        ("short-name", vec!["GIT~1/hooks/pre-commit"], "path-refused"),
        ("case", vec!["Readme.txt", "README.txt"], "path-collision"),
        ("unicode", vec!["\u{e9}t\u{e9}.txt", "\u{c9}T\u{c9}.txt"], "path-collision"),
    ] {
        let d = hostile_bundle(&scratch.join(format!("hostile-{tag}")), &base, &paths)?;
        cases.push((format!("path {tag}"), d, kind));
    }
    for (tag, dir, want) in &cases {
        let got = import_through_ui(ctx, dir)?;
        ensure!(got == Err(want.to_string()), "{tag}: expected a {want} refusal, got {got:?}");
        ensure!(partial_imports().is_empty(), "{tag} left a private copy");
    }
    ensure!(imports_list(ctx)?.is_empty(), "a refused import left a record");
    println!("      NOTE: {} hostile bundles refused through the UI", cases.len());

    // 12. Stopped part-way: nothing kept.
    std::env::set_var("JAN_SMOKE_IMPORT_DELAY_MS", "700");
    ctx.script_dialog(Some(&bundle));
    ctx.eval("document.querySelector('[data-testid=\"bundle-import\"]').click(); return true;")?;
    let stopped = ctx
        .wait_until(
            "the import to be running",
            "return !!document.querySelector('[data-testid=\"bundle-import-cancel\"]');",
            Duration::from_secs(20),
        )
        .and_then(|()| {
            ctx.eval("document.querySelector('[data-testid=\"bundle-import-cancel\"]').click(); return true;")
                .map(|_| ())
        })
        .and_then(|()| {
            ctx.wait_until(
                "the stopped import's refusal",
                r#"const e = document.querySelector('[data-testid="bundle-import-error"]');
                   return !!e && e.getAttribute('data-kind') === 'cancelled';"#,
                Duration::from_secs(30),
            )
        });
    std::env::remove_var("JAN_SMOKE_IMPORT_DELAY_MS");
    ctx.clear_dialog_script();
    stopped?;
    ensure!(partial_imports().is_empty(), "a stopped import left a private copy");
    ensure!(imports_list(ctx)?.is_empty(), "a stopped import left a record");

    // 3-4. The real bundle.
    let got = import_through_ui(ctx, &bundle)?;
    ensure!(got.is_ok(), "the exported bundle was refused: {got:?}");
    let imports = imports_list(ctx)?;
    ensure!(imports.len() == 1, "expected one import, found {}", imports.len());
    let id = imports[0]["id"].as_str().unwrap_or_default().to_string();
    let proposal_id = imports[0]["proposalId"].as_str().unwrap_or_default().to_string();
    let origin = in_import(ctx, &id, "return row.querySelector('[data-testid=\"bundle-import-origin\"]').textContent;")?;
    let origin = origin.as_str().unwrap_or_default().to_string();
    ensure!(origin.contains(&base[..10]) && origin.contains("schema 1"), "the origin does not show the base and schema: {origin}");
    toggle_import_review(ctx, &id)?;
    wait_import_files(ctx, &id)?;

    // AH-154/155/156 in the review itself.
    let kinds = in_import(
        ctx,
        &id,
        "return JSON.stringify([...row.querySelectorAll('[data-testid=\"proposal-flag\"]')].map(f => f.getAttribute('data-kind')).sort());",
    )?;
    ensure!(
        kinds.as_str() == Some("[\"binary\",\"deletion\",\"dependency\",\"lockfile\",\"migration\"]"),
        "the review does not show every flag: {kinds}"
    );
    let dep_text = in_import(ctx, &id, "return row.querySelector('[data-testid=\"proposal-flag\"][data-kind=\"dependency\"]').textContent;")?;
    ensure!(dep_text.as_str().unwrap_or_default().contains("left-pad (dependencies) added at 1.3.0"), "the dependency flag does not name the change: {dep_text}");
    let mig_text = in_import(ctx, &id, "return row.querySelector('[data-testid=\"proposal-flag\"][data-kind=\"migration\"]').textContent;")?;
    ensure!(mig_text.as_str().unwrap_or_default().contains("Irreversible migration"), "the migration is not labelled irreversible: {mig_text}");
    let lock_apart = in_import(
        ctx,
        &id,
        &format!("const l = row.querySelector('[data-testid=\"proposal-lockfiles\"]');
                  return !!l && !!l.querySelector('[data-path={:?}]') && !l.querySelector('[data-path={:?}]');", bf("yarn.lock"), bf("package.json")),
    )?;
    ensure!(lock_apart == true, "the lock file is not listed apart from the source changes");
    let held = in_import(
        ctx,
        &id,
        "return row.querySelector('[data-testid=\"proposal-apply\"]').disabled
           && /reviewed/.test(row.querySelector('[data-testid=\"proposal-needs-ack\"]').textContent);",
    )?;
    ensure!(held == true, "Apply was not held until the flags were acknowledged");
    // Reachable by keyboard: each acknowledgement is a focusable, labelled control.
    let keyboard = in_import(
        ctx,
        &id,
        "const boxes = [...row.querySelectorAll('[data-testid=\"proposal-flag-ack\"]')];
         return boxes.length === 5 && boxes.every(b => { b.focus(); return document.activeElement === b && b.tabIndex >= 0 && b.labels.length > 0; });",
    )?;
    ensure!(keyboard == true, "an acknowledgement is not reachable by keyboard");
    let ack_all = "row.querySelectorAll('[data-testid=\"proposal-flag-ack\"]').forEach(b => { if (!b.checked) b.click(); }); return true;";

    // 11. The destination changed after review: refused whole, by hunk.
    let target = project.join(bf("target.txt"));
    std::fs::write(&target, lines12(&[(1, "mine")])).map_err(ioe)?;
    in_import(ctx, &id, ack_all)?;
    ctx.settle();
    in_import(ctx, &id, "row.querySelector('[data-testid=\"proposal-apply\"]').click(); return true;")?;
    ctx.wait_until(
        "the conflict against its hunk",
        &format!(
            r#"const row = document.querySelector('[data-testid="bundle-import-row"][data-id={id:?}]');
               const c = row && row.querySelector('[data-testid="proposal-conflict"]');
               return !!c && !!c.closest('[data-hunk]');"#
        ),
        Duration::from_secs(30),
    )?;
    ensure!(!project.join(bf("logo.bin")).exists(), "a refused apply wrote the binary");
    ensure!(project.join(bf("drop.txt")).exists(), "a refused apply deleted a file");
    ensure!(!project.join(bf("yarn.lock")).exists(), "a refused apply wrote the lock file");
    std::fs::write(&target, lines12(&[])).map_err(ioe)?;

    // Stored flags removed on disk (and re-hashed so the record verifies):
    // the review shows none, and the backend still refuses, typed.
    let record_path = Path::new(&data).join("proposals").join(format!("{proposal_id}.json"));
    let original = read(&record_path);
    let mut stored: tauri_plugin_agent_tools::proposal::ProposalRecord =
        serde_json::from_slice(&original).map_err(|e| fail(e.to_string()))?;
    for f in &mut stored.files {
        f.flags.clear();
    }
    stored.patch_hash = sha256_hex(&serde_json::to_vec(&stored.files).unwrap());
    std::fs::write(&record_path, serde_json::to_vec_pretty(&stored).unwrap()).map_err(ioe)?;
    toggle_import_review(ctx, &id)?;
    toggle_import_review(ctx, &id)?;
    wait_import_files(ctx, &id)?;
    let shown = in_import(ctx, &id, "return row.querySelectorAll('[data-testid=\"proposal-flag\"]').length;")?;
    ensure!(shown == 0, "the tampered record still showed flags ({shown})");
    in_import(ctx, &id, "row.querySelector('[data-testid=\"proposal-apply\"]').click(); return true;")?;
    ctx.wait_until(
        "the typed refusal of the tampered flags",
        &format!(
            r#"const row = document.querySelector('[data-testid="bundle-import-row"][data-id={id:?}]');
               const e = row && row.querySelector('[data-testid="proposal-error"]');
               return !!e && /not acknowledged/.test(e.textContent);"#
        ),
        Duration::from_secs(30),
    )?;
    ensure!(!project.join(bf("logo.bin")).exists(), "the tampered record's apply wrote something");
    std::fs::write(&record_path, &original).map_err(ioe)?;
    toggle_import_review(ctx, &id)?;
    toggle_import_review(ctx, &id)?;
    wait_import_files(ctx, &id)?;

    // 5-7. One hunk of two, new.txt left out, everything else acknowledged,
    // and Apply clicked twice at once.
    in_import(
        ctx,
        &id,
        &format!(
            "const t = row.querySelector('[data-testid=\"proposal-file\"][data-path={:?}]');
             t.querySelectorAll('[data-testid=\"proposal-hunk-toggle\"]')[1].click();
             row.querySelector('[data-testid=\"proposal-file\"][data-path={:?}] [data-testid=\"proposal-file-toggle\"]').click();
             return true;",
            bf("target.txt"),
            bf("new.txt")
        ),
    )?;
    ctx.settle();
    in_import(ctx, &id, ack_all)?;
    ctx.settle();
    in_import(ctx, &id, "const b = row.querySelector('[data-testid=\"proposal-apply\"]'); b.click(); b.click(); return true;")?;
    ctx.wait_until(
        "the import to be applied",
        &format!(
            r#"const row = document.querySelector('[data-testid="bundle-import-row"][data-id={id:?}]');
               return !!row && row.getAttribute('data-state') === 'partially-applied';"#
        ),
        Duration::from_secs(45),
    )?;
    let read_s = |p: &str| std::fs::read_to_string(project.join(bf(p))).unwrap_or_default();
    ensure!(read_s("target.txt") == lines12(&[(1, "ONE")]), "the folder does not hold exactly the chosen hunk: {:?}", read_s("target.txt"));
    ensure!(!project.join(bf("new.txt")).exists(), "an unselected file was applied");
    ensure!(read(&project.join(bf("logo.bin"))) == [0u8, 1, 2, 255], "the binary did not land byte for byte");
    ensure!(read_s("package.json") == PKG_NEW, "the dependency change did not land");
    ensure!(project.join(bf("yarn.lock")).exists() && project.join(bf("db/migrations/0002.sql")).exists(), "the lock file or migration did not land");
    ensure!(!project.join(bf("drop.txt")).exists(), "the reviewed deletion did not happen");
    ensure!(read(&unrelated) == unrelated_before, "the person's unrelated file changed");
    ensure!(git(&project, &["rev-parse", "HEAD"]).map_err(fail)?.trim() == base, "the import moved HEAD");
    ensure!(git(&project, &["rev-parse", "--abbrev-ref", "HEAD"]).map_err(fail)?.trim() == branch, "the import switched branch");
    ensure!(git(&project, &["diff", "--cached", "--name-only"]).map_err(fail)?.trim().is_empty(), "the import staged something");
    // The double click was one apply.
    let audit = std::fs::read_to_string(Path::new(&data).join("audit").join("proposals.jsonl")).unwrap_or_default();
    let applied = audit
        .lines()
        .filter(|l| l.contains(&proposal_id) && l.contains("\"event\":\"applied\""))
        .count();
    ensure!(applied == 1, "the proposal was applied {applied} times");

    // The same bundle again.
    let again = import_through_ui(ctx, &bundle)?;
    ensure!(again == Err("already-applied".into()), "the same bundle imported twice: {again:?}");

    // 13, set up: a second bundle, imported and left pending.
    std::fs::write(wt.join(bf("second.txt")), "second round\n").map_err(ioe)?;
    let (ok, exported2) = ipc(ctx, "agent_worktree_export", &format!("{{ record: {record} }}"))?;
    ensure!(ok, "the second export failed: {exported2}");
    let bundle2 = PathBuf::from(exported2["path"].as_str().unwrap_or_default());
    let got = import_through_ui(ctx, &bundle2)?;
    ensure!(got.is_ok(), "the second bundle was refused: {got:?}");
    let pending: Vec<Value> = imports_list(ctx)?.into_iter().filter(|v| v["state"] == "pending").collect();
    ensure!(pending.len() == 1, "expected one pending import, found {}", pending.len());
    ensure!(partial_imports().is_empty(), "an import left a private copy");
    std::fs::write(
        ctx.workspace.join(BUNDLE_MARKER),
        serde_json::json!({
            "applied": id,
            "pending": pending[0]["id"],
            "unrelated": sha256_hex(&unrelated_before),
            "base": base,
        })
        .to_string(),
    )
    .map_err(ioe)?;
    let _ = std::fs::remove_dir_all(&scratch);
    Ok(())
}

/// Phase two (a new process on the same profile): the applied import and the
/// pending one are listed from disk with their states; the pending one still
/// reviews, and abandoning it rejects its proposal with nothing written.
fn scenario_bundle_import_second(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let marker: Value = serde_json::from_str(
        &std::fs::read_to_string(ctx.workspace.join(BUNDLE_MARKER))
            .map_err(|_| fail("phase one did not run against this workspace".into()))?,
    )
    .map_err(|e| fail(e.to_string()))?;
    let applied = marker["applied"].as_str().unwrap_or_default().to_string();
    let pending = marker["pending"].as_str().unwrap_or_default().to_string();
    let listed = imports_list(ctx)?;
    let state = |id: &str| {
        listed
            .iter()
            .find(|v| v["id"] == id)
            .and_then(|v| v["state"].as_str())
            .unwrap_or("-")
            .to_string()
    };
    ensure!(state(&applied) == "partially-applied", "after a restart the applied import is {}", state(&applied));
    ensure!(state(&pending) == "pending", "after a restart the pending import is {}", state(&pending));

    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    open_bundle_imports(ctx)?;
    ctx.wait_until(
        "both imports listed",
        "return document.querySelectorAll('[data-testid=\"bundle-import-row\"]').length === 2;",
        Duration::from_secs(30),
    )?;
    toggle_import_review(ctx, &pending)?;
    ctx.wait_until(
        "the pending import's review after a restart",
        &format!(
            r#"const row = document.querySelector('[data-testid="bundle-import-row"][data-id={pending:?}]');
               return !!row && !!row.querySelector('[data-testid="proposal-file"][data-path="{BF}/second.txt"]');"#
        ),
        Duration::from_secs(30),
    )?;
    in_import(ctx, &pending, "row.querySelector('[data-testid=\"bundle-import-abandon\"]').click(); return true;")?;
    ctx.wait_until(
        "the abandoned import to leave the list",
        &format!(r#"return !document.querySelector('[data-testid="bundle-import-row"][data-id={pending:?}]');"#),
        Duration::from_secs(30),
    )?;
    ensure!(
        imports_list(ctx)?.iter().any(|v| v["id"] == pending.as_str() && v["state"] == "abandoned"),
        "abandoning did not record it"
    );
    ensure!(!ctx.project.join(bf("second.txt")).exists(), "the abandoned import wrote its file");
    let unrelated = std::fs::read(ctx.project.join("bundle-unrelated.txt")).unwrap_or_default();
    ensure!(
        marker["unrelated"].as_str() == Some(sha256_hex(&unrelated).as_str()),
        "the person's unrelated file changed across the restart"
    );
    ensure!(partial_imports().is_empty(), "a private import copy was left");
    Ok(())
}

// ---------------------------------------------------------------------------
// AH-005 / AH-177: the canonical event log, exported through the UI
// ---------------------------------------------------------------------------

const EVENTS_MARKER: &str = "event-export-phase-1.json";

/// The newest session that sent `needle`, from the transport's own record.
fn session_of_message(needle: &str) -> Option<String> {
    recorded_dispatch(needle).and_then(|s| s["session"].as_str().map(str::to_string))
}

fn open_session_details(ctx: &Ctx) -> ScenarioResult {
    ctx.wait_until(
        "the session details with the event export",
        r#"const t = document.querySelector('[data-testid="session-details-trigger"]');
           if (t && !document.querySelector('[data-testid="event-export"]')) t.click();
           return !!document.querySelector('[data-testid="event-export"]');"#,
        Duration::from_secs(30),
    )
}

/// Export through the UI; the folder written.
fn export_events_ui(ctx: &Ctx, content: bool) -> Result<PathBuf, Failure> {
    ctx.eval(&format!(
        r#"const box = document.querySelector('[data-testid="event-export-content"]');
           if (box.checked !== {content}) box.click();
           return true;"#
    ))?;
    ctx.settle();
    ctx.eval(r#"document.querySelector('[data-testid="event-export-run"]').click(); return true;"#)?;
    ctx.wait_until(
        "the export to be written",
        r#"return !!document.querySelector('[data-testid="event-export-path"]')
             || !!document.querySelector('[data-testid="event-export-error"]');"#,
        Duration::from_secs(30),
    )?;
    let text = ctx.eval_string(
        r#"const p = document.querySelector('[data-testid="event-export-path"]');
           const e = document.querySelector('[data-testid="event-export-error"]');
           return p ? p.textContent : 'ERROR ' + (e ? e.textContent : '');"#,
    )?;
    let path = text
        .split("written to ")
        .nth(1)
        .map(str::trim)
        .ok_or_else(|| Failure(format!("the export did not say where it went: {text}")))?;
    Ok(PathBuf::from(path))
}

/// A reader written here, not the app's: every line an envelope of version 1
/// for `session`, sequence strictly increasing; returns the lines as JSON.
fn read_export_independently(dir: &Path, session: &str) -> Result<Vec<Value>, Failure> {
    let fail = |m: String| Failure(m);
    let manifest: Value = serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).map_err(|e| fail(e.to_string()))?)
        .map_err(|e| fail(format!("manifest: {e}")))?;
    let body = std::fs::read(dir.join("events.jsonl")).map_err(|e| fail(e.to_string()))?;
    ensure!(manifest["eventsSha256"] == sha256_hex(&body), "the manifest hash does not match the events");
    let mut out = Vec::new();
    let mut last = 0u64;
    for line in String::from_utf8_lossy(&body).lines().filter(|l| !l.trim().is_empty()) {
        let e: Value = serde_json::from_str(line).map_err(|e| fail(format!("a line is not JSON: {e}")))?;
        ensure!(e["v"] == 1, "an event is not envelope version 1: {line}");
        ensure!(e["session"] == session, "an event of another session: {line}");
        let seq = e["seq"].as_u64().unwrap_or(0);
        ensure!(seq > last, "the events are not in log order at seq {seq}");
        last = seq;
        out.push(e);
    }
    ensure!(manifest["count"] == out.len(), "the manifest count disagrees with the file");
    Ok(out)
}

/// AH-005/AH-177, phase one. A run with a tool call records its canonical
/// events; the session details export them through the UI, metadata only by
/// default (no prompt, path or tool output in the file, checked by a reader
/// of its own), in the same order as the durable tool-activity record; with
/// content only when ticked, with the warning shown; and an export read back
/// through the inspector, a tampered one refused as typed.
fn scenario_event_export_first(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let ioe = |e: std::io::Error| Failure(e.to_string());
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
    let probe = "event export probe: list the folder";
    ctx.type_into("[data-testid=\"chat-input\"]", probe)?;
    ctx.wait_until(
        "the send control to arm",
        "const b = document.querySelector('[data-test-id=\"send-message-button\"]'); return !!b && !b.disabled;",
        Duration::from_secs(60),
    )?;
    ctx.eval("document.querySelector('[data-test-id=\"send-message-button\"]').click(); return true;")?;
    ctx.wait_until(
        "the tool call and the end of the run",
        "return !!document.querySelector('[data-testid=\"tool-activity-item\"]')
           && document.body.innerText.includes('Done. I used the tools')
           && !!document.querySelector('[data-test-id=\"send-message-button\"]');",
        Duration::from_secs(120),
    )?;
    let session = session_of_message("event export probe").ok_or_else(|| fail("the run's session was not recorded".into()))?;
    ctx.settle();

    // Metadata only, by default.
    open_session_details(ctx)?;
    let warned = ctx.eval_bool("return !!document.querySelector('[data-testid=\"event-export-warning\"]');")?;
    ensure!(!warned, "the content warning shows before content was asked for");
    let meta = export_events_ui(ctx, false)?;
    let events = read_export_independently(&meta, &session)?;
    let kinds: Vec<String> = events.iter().filter_map(|e| e["kind"].as_str().map(str::to_string)).collect();
    ensure!(kinds.first().map(String::as_str) == Some("run.started"), "the export does not start with the run: {kinds:?}");
    ensure!(kinds.last().map(String::as_str) == Some("run.ended"), "the export does not end with the run: {kinds:?}");
    for want in ["tool.requested", "tool.running"] {
        ensure!(kinds.iter().any(|k| k == want), "the export has no {want}: {kinds:?}");
    }
    ensure!(
        kinds.iter().any(|k| k == "tool.succeeded" || k == "tool.failed"),
        "the tool call never reached an end in the export: {kinds:?}"
    );
    let body = std::fs::read_to_string(meta.join("events.jsonl")).map_err(ioe)?;
    let project = ctx.project.to_string_lossy().replace('\\', "\\\\");
    for leaked in ["event export probe", "\"resource\"", "\"summary\"", "\"title\"", project.as_str()] {
        ensure!(!body.contains(leaked), "the metadata-only export holds {leaked:?}");
    }
    // The same order as the durable tool-activity record.
    let activity: Vec<String> = activity_records()
        .into_iter()
        .filter(|e| e["session"] == session.as_str())
        .filter(|e| e["event_type"].as_str().unwrap_or("tool") == "tool")
        .filter_map(|e| e["phase"].as_str().map(|p| format!("tool.{p}")))
        .collect();
    let exported_tools: Vec<String> = kinds.iter().filter(|k| k.starts_with("tool.")).cloned().collect();
    let mut deduped = Vec::new();
    for k in &activity {
        if !deduped.contains(k) {
            deduped.push(k.clone());
        }
    }
    ensure!(
        exported_tools == deduped,
        "the export's tool events {exported_tools:?} are not the durable record's {deduped:?}"
    );

    // With content, only when asked, with the warning.
    ctx.eval("const b = document.querySelector('[data-testid=\"event-export-content\"]'); if (!b.checked) b.click(); return true;")?;
    ctx.settle();
    ensure!(
        ctx.eval_bool("return /share it with care/i.test(document.querySelector('[data-testid=\"event-export-warning\"]')?.textContent || '');")?,
        "no warning before a content export"
    );
    let full = export_events_ui(ctx, true)?;
    let full_body = std::fs::read_to_string(full.join("events.jsonl")).map_err(ioe)?;
    ensure!(full_body.contains("event export probe"), "the content export does not hold the run's title");
    read_export_independently(&full, &session)?;

    // Read back through the inspector; a tampered copy refused, typed.
    ctx.script_dialog(Some(&meta));
    ctx.eval("document.querySelector('[data-testid=\"event-inspect\"]').click(); return true;")?;
    let inspected = ctx.wait_until(
        "the inspector's summary",
        &format!(
            r#"const s = document.querySelector('[data-testid="event-inspect-summary"]');
               return !!s && s.getAttribute('data-count') === '{}' && s.getAttribute('data-session') === {session:?};"#,
            events.len()
        ),
        Duration::from_secs(30),
    );
    ctx.clear_dialog_script();
    inspected?;
    let tampered = ctx.workspace.join("event-export-tampered");
    let _ = std::fs::remove_dir_all(&tampered);
    std::fs::create_dir_all(&tampered).map_err(ioe)?;
    std::fs::copy(meta.join("manifest.json"), tampered.join("manifest.json")).map_err(ioe)?;
    std::fs::write(tampered.join("events.jsonl"), body.replace("run.ended", "run.hacked")).map_err(ioe)?;
    ctx.script_dialog(Some(&tampered));
    ctx.eval("document.querySelector('[data-testid=\"event-inspect\"]').click(); return true;")?;
    let refused = ctx.wait_until(
        "the tampered export's refusal",
        r#"const e = document.querySelector('[data-testid="event-export-error"]');
           return !!e && e.getAttribute('data-kind') === 'hash-mismatch';"#,
        Duration::from_secs(30),
    );
    ctx.clear_dialog_script();
    refused?;
    let _ = std::fs::remove_dir_all(&tampered);

    std::fs::write(
        ctx.workspace.join(EVENTS_MARKER),
        serde_json::json!({
            "session": session,
            "export": meta.to_string_lossy(),
            "ids": events.iter().map(|e| e["id"].clone()).collect::<Vec<_>>(),
        })
        .to_string(),
    )
    .map_err(ioe)
}

/// Phase two, a new process: the session's events export again in the same
/// order with the same ids, and phase one's export still reads back.
fn scenario_event_export_second(ctx: &Ctx) -> ScenarioResult {
    let fail = |e: String| Failure(e);
    let marker: Value = serde_json::from_str(
        &std::fs::read_to_string(ctx.workspace.join(EVENTS_MARKER))
            .map_err(|_| fail("phase one did not run against this workspace".into()))?,
    )
    .map_err(|e| fail(e.to_string()))?;
    let session = marker["session"].as_str().unwrap_or_default().to_string();
    let before: Vec<Value> = marker["ids"].as_array().cloned().unwrap_or_default();
    ctx.goto("/cowork")?;
    ctx.wait_until(
        "the cowork composer",
        "return !!document.querySelector('[data-testid=\"chat-input\"]');",
        Duration::from_secs(30),
    )?;
    // The restored session is the one that ran.
    ctx.wait_until(
        "the probe's session after a restart",
        "return document.body.innerText.includes('event export probe');",
        Duration::from_secs(45),
    )?;
    open_session_details(ctx)?;
    let again = export_events_ui(ctx, false)?;
    let events = read_export_independently(&again, &session)?;
    let ids: Vec<Value> = events.iter().map(|e| e["id"].clone()).collect();
    ensure!(ids == before, "after a restart the events are {ids:?}, not {before:?}");
    let first = PathBuf::from(marker["export"].as_str().unwrap_or_default());
    read_export_independently(&first, &session)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// AH-094..099: shipped roles, dispatched parent to child through the real app
// ---------------------------------------------------------------------------
