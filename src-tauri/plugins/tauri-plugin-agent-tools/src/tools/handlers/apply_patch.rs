//! `apply_patch`: a multi-file change applied all or nothing.
//!
//! Every file is checked and its new text computed before the first byte is
//! written; the checks are the ones `write` and `edit` make one file at a time
//! (confinement, links, the read-first rule, a held shared folder). If a write
//! still fails part way, the files already changed are put back.

use super::*;
use crate::tools::patch_format::{self, Hunk};

/// What one hunk will do, resolved to the file the open really lands on.
enum Step {
    Write { at: PathBuf, shown: String, content: String, prior: Option<Vec<u8>> },
    Remove { at: PathBuf, shown: String, prior: Vec<u8> },
}

impl Step {
    fn at(&self) -> &Path {
        match self {
            Step::Write { at, .. } | Step::Remove { at, .. } => at,
        }
    }
}

pub(super) async fn apply_patch(args: &serde_json::Value, ctx: &ToolContext<'_>) -> String {
    let Some(text) = arg_str(args, "patch") else {
        return "ERROR: missing required argument 'patch'".to_string();
    };
    let hunks = match patch_format::parse(text) {
        Ok(h) => h,
        Err(e) => return format!("ERROR: bad patch: {e}. Nothing was changed."),
    };
    if !ctx.credential_override {
        let findings = secret_findings_in(&patch_format::render_diff(&hunks), args);
        if !findings.is_empty() {
            let where_ = findings.iter().map(describe_secret_finding).collect::<Vec<_>>().join("; ");
            return format!(
                "ERROR: this patch was not applied: it adds what looks like a real credential: {where_}.                  Nothing was changed. Use a placeholder and read the value from the environment."
            );
        }
    }
    let steps = match plan(&hunks, ctx).await {
        Ok(s) => s,
        Err(e) => return format!("ERROR: {e} Nothing was changed."),
    };
    let summary: Vec<String> = steps
        .iter()
        .map(|s| match s {
            Step::Write { shown, prior: None, .. } => format!("added {shown}"),
            Step::Write { shown, .. } => format!("updated {shown}"),
            Step::Remove { shown, .. } => format!("deleted {shown}"),
        })
        .collect();
    if let Err(e) = commit(&steps).await {
        return format!("ERROR: {e} Every file was restored; nothing was changed.");
    }
    // The model's view of each file is what is on disk now, so its next edit
    // is not refused as stale.
    for step in &steps {
        if let Step::Write { shown, .. } = step {
            let one = serde_json::json!({ "path": shown });
            record_seen(&one, ctx).await;
        }
    }
    format!("Applied patch: {}", summary.join(", "))
}

/// Check every hunk and compute every result. No file is written here.
async fn plan(hunks: &[Hunk], ctx: &ToolContext<'_>) -> Result<Vec<Step>, String> {
    let (root, scratch) = (ctx.project_root, ctx.scratch_root);
    let mut steps: Vec<Step> = Vec::new();
    for hunk in hunks {
        for (path, _) in hunk.touched() {
            if let Some((name, why)) = refuse_windows_name(path) {
                return Err(format!("refused '{name}' in {path}: the name {why}."));
            }
            let target = resolve_path(root, scratch, path);
            if ctx.confine_writes
                && escapes_write_roots(root, scratch, ctx.write_roots, path).unwrap_or(true)
            {
                return Err(format!("refused to change {path}: outside the agent workspace."));
            }
            if symlink_escapes_root(root, scratch, &target) {
                return Err(format!(
                    "refused to change {path} through a symlink out of the workspace{}.",
                    resolved_target(&target)
                ));
            }
            let one = serde_json::json!({ "path": path });
            if let Some(target) = tracked_path(&one, ctx) {
                if let Some(held) = crate::shared_folder::tools::write_gate(ctx, &target, path) {
                    return Err(held);
                }
            }
        }
        match hunk {
            Hunk::Add { path, content } => {
                let (at, shown) = open_target(path, ctx)?;
                if tokio::fs::symlink_metadata(&at).await.is_ok() {
                    return Err(format!("{shown} already exists; use `*** Update File:` to change it."));
                }
                steps.push(Step::Write { at, shown, content: content.clone(), prior: None });
            }
            Hunk::Delete { path } => {
                let (at, shown) = open_target(path, ctx)?;
                let prior = existing(&at, &shown).await?;
                stale(path, "delete", ctx).await?;
                steps.push(Step::Remove { at, shown, prior });
            }
            Hunk::Update { path, move_to, chunks } => {
                let (at, shown) = open_target(path, ctx)?;
                let prior = existing(&at, &shown).await?;
                stale(path, "edit", ctx).await?;
                let original = String::from_utf8(prior.clone())
                    .map_err(|_| format!("{shown}: stream did not contain valid UTF-8."))?;
                let content = patch_format::apply_update(&original, chunks, &shown)?;
                match move_to {
                    None => steps.push(Step::Write { at, shown, content, prior: Some(prior) }),
                    Some(to) => {
                        let (to_at, to_shown) = open_target(to, ctx)?;
                        if to_at != at && tokio::fs::symlink_metadata(&to_at).await.is_ok() {
                            return Err(format!("cannot move {shown} to {to_shown}: it already exists."));
                        }
                        if to_at == at {
                            steps.push(Step::Write { at, shown, content, prior: Some(prior) });
                        } else {
                            steps.push(Step::Write { at: to_at, shown: to_shown, content, prior: None });
                            steps.push(Step::Remove { at, shown, prior });
                        }
                    }
                }
            }
        }
    }
    // One file, one change: two hunks on the same file would each be computed
    // from text the other is about to replace.
    for (i, a) in steps.iter().enumerate() {
        if steps[..i].iter().any(|b| same_file(a.at(), b.at())) {
            return Err(format!(
                "the patch changes {} more than once; combine those into one section.",
                a.at().display()
            ));
        }
    }
    Ok(steps)
}

fn same_file(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}

fn open_target(path: &str, ctx: &ToolContext<'_>) -> Result<(PathBuf, String), String> {
    let target = resolve_path(ctx.project_root, ctx.scratch_root, path);
    let shown = display_path(ctx.project_root, ctx.scratch_root, &target);
    let at = resolved_for_open(&target).map_err(|e| format!("refused to change {path}: {e}."))?;
    Ok((at, shown))
}

/// The bytes of an existing regular file, or why there are none.
async fn existing(at: &Path, shown: &str) -> Result<Vec<u8>, String> {
    match tokio::fs::symlink_metadata(at).await {
        Ok(m) if m.is_file() => {}
        Ok(m) if m.is_dir() => return Err(format!("{shown} is a directory, not a file.")),
        Ok(_) => return Err(format!("{shown} is not a regular file.")),
        Err(_) => return Err(format!("{shown} does not exist.")),
    }
    readable_file_with(at, true).await.map_err(|e| format!("{shown}: {e}."))?;
    read_no_follow(at).await.map_err(|e| format!("{shown}: {e}."))
}

/// The read-first rule `edit` applies, for a file this session must have seen.
async fn stale(path: &str, verb: &str, ctx: &ToolContext<'_>) -> Result<(), String> {
    let one = serde_json::json!({ "path": path });
    match stale_edit_refusal(verb, &one, ctx).await {
        Some(refusal) => Err(refusal.trim_start_matches("ERROR: ").to_string()),
        None => Ok(()),
    }
}

/// Write every step; on the first failure put back what was already done.
async fn commit(steps: &[Step]) -> Result<(), String> {
    let mut done: Vec<&Step> = Vec::new();
    for step in steps {
        let result = match step {
            Step::Write { at, content, .. } => write_no_follow(at, content)
                .await
                .map_err(|e| format!("{}: {e}.", at.display())),
            Step::Remove { at, .. } => tokio::fs::remove_file(at)
                .await
                .map_err(|e| format!("{}: {e}.", at.display())),
        };
        match result {
            Ok(()) => done.push(step),
            Err(e) => {
                // The failed step may have left a partial file.
                done.push(step);
                restore(&done).await;
                return Err(e);
            }
        }
    }
    Ok(())
}

async fn restore(done: &[&Step]) {
    for step in done.iter().rev() {
        match step {
            Step::Write { at, prior: Some(bytes), .. } | Step::Remove { at, prior: bytes, .. } => {
                let (at, bytes) = (at.to_path_buf(), bytes.clone());
                let _ = tokio::task::spawn_blocking(move || nofollow::write_atomic(&at, &bytes)).await;
            }
            Step::Write { at, prior: None, .. } => {
                let _ = tokio::fs::remove_file(at).await;
            }
        }
    }
}

/// The diff the permission prompt shows for a patch: every file's change, so a
/// person approves what the whole patch does. `None` when it does not parse.
pub(super) fn preview(args: &serde_json::Value) -> Option<String> {
    let hunks = patch_format::parse(arg_str(args, "patch")?).ok()?;
    Some(patch_format::render_diff(&hunks))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "apply-patch-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    async fn run(root: &Path, patch: &str) -> String {
        let store = crate::workspace::project_store(root);
        let ctx = ToolContext::new(root, &store, &[]);
        apply_patch(&json!({ "patch": patch }), &ctx).await
    }

    fn wrap(body: &str) -> String {
        format!("*** Begin Patch\n{body}*** End Patch\n")
    }

    #[tokio::test]
    async fn adds_updates_moves_and_deletes_in_one_patch() {
        let r = root();
        std::fs::write(r.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(r.join("old.txt"), "gone\n").unwrap();
        std::fs::write(r.join("m.txt"), "x\ny\n").unwrap();
        let out = run(
            &r,
            &wrap(
                "*** Add File: sub/new.txt\n+hello\n\
                 *** Update File: a.txt\n@@\n one\n-two\n+TWO\n\
                 *** Update File: m.txt\n*** Move to: moved.txt\n@@\n-y\n+Y\n\
                 *** Delete File: old.txt\n",
            ),
        )
        .await;
        assert!(out.starts_with("Applied patch"), "{out}");
        assert_eq!(std::fs::read_to_string(r.join("sub/new.txt")).unwrap(), "hello\n");
        assert_eq!(std::fs::read_to_string(r.join("a.txt")).unwrap(), "one\nTWO\n");
        assert_eq!(std::fs::read_to_string(r.join("moved.txt")).unwrap(), "x\nY\n");
        assert!(!r.join("m.txt").exists() && !r.join("old.txt").exists());
        let _ = std::fs::remove_dir_all(&r);
    }

    #[tokio::test]
    async fn a_hunk_that_does_not_match_leaves_every_file_untouched() {
        let r = root();
        std::fs::write(r.join("a.txt"), "one\n").unwrap();
        let out = run(
            &r,
            &wrap(
                "*** Add File: new.txt\n+hello\n\
                 *** Update File: a.txt\n@@\n-nope\n+x\n",
            ),
        )
        .await;
        assert!(out.starts_with("ERROR") && out.contains("Nothing was changed"), "{out}");
        assert!(!r.join("new.txt").exists());
        assert_eq!(std::fs::read_to_string(r.join("a.txt")).unwrap(), "one\n");
        let _ = std::fs::remove_dir_all(&r);
    }

    #[tokio::test]
    async fn refuses_an_add_over_an_existing_file_and_a_repeated_file() {
        let r = root();
        std::fs::write(r.join("a.txt"), "one\n").unwrap();
        let out = run(&r, &wrap("*** Add File: a.txt\n+x\n")).await;
        assert!(out.contains("already exists"), "{out}");
        let out = run(
            &r,
            &wrap("*** Add File: n.txt\n+x\n*** Add File: n.txt\n+y\n"),
        )
        .await;
        assert!(out.contains("more than once"), "{out}");
        assert!(!r.join("n.txt").exists());
        let _ = std::fs::remove_dir_all(&r);
    }

    #[tokio::test]
    async fn a_failed_write_puts_back_the_files_already_changed() {
        let r = root();
        std::fs::write(r.join("a.txt"), "one\n").unwrap();
        std::fs::write(r.join("b.txt"), "two\n").unwrap();
        let steps = vec![
            Step::Write {
                at: r.join("a.txt"),
                shown: "a.txt".into(),
                content: "CHANGED\n".into(),
                prior: Some(b"one\n".to_vec()),
            },
            Step::Remove { at: r.join("b.txt"), shown: "b.txt".into(), prior: b"two\n".to_vec() },
            // The parent is a file, so this write cannot succeed.
            Step::Write {
                at: r.join("a.txt").join("child.txt"),
                shown: "a.txt/child.txt".into(),
                content: "x".into(),
                prior: None,
            },
        ];
        let err = commit(&steps).await.unwrap_err();
        assert!(!err.is_empty());
        assert_eq!(std::fs::read_to_string(r.join("a.txt")).unwrap(), "one\n");
        assert_eq!(std::fs::read_to_string(r.join("b.txt")).unwrap(), "two\n");
        let _ = std::fs::remove_dir_all(&r);
    }

    #[tokio::test]
    async fn a_patch_that_escapes_the_workspace_is_refused_whole() {
        let r = root();
        let store = crate::workspace::project_store(&r);
        let ctx = ToolContext::new(&r, &store, &[]).with_confined_writes(true);
        let out = apply_patch(
            &json!({ "patch": wrap("*** Add File: ok.txt\n+x\n*** Add File: ../escape.txt\n+y\n") }),
            &ctx,
        )
        .await;
        assert!(out.starts_with("ERROR") && out.contains("outside"), "{out}");
        assert!(!r.join("ok.txt").exists());
        let _ = std::fs::remove_dir_all(&r);
    }
}
