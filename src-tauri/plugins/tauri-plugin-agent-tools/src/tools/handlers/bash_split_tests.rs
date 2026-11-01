//! Q1-010: the pieces split out of the `bash` handler, pinned to what the
//! single function did (argument defaults, policy fields, result texts).

use super::*;
use serde_json::json;

#[test]
fn foreground_timeout_defaults_and_is_clamped() {
    assert_eq!(bash_timeout(&json!({})), (false, DEFAULT_BASH_TIMEOUT_SECS));
    assert_eq!(
        bash_timeout(&json!({"timeout": 100_000})),
        (false, MAX_FOREGROUND_BASH_TIMEOUT_SECS)
    );
    assert_eq!(bash_timeout(&json!({"timeout": 0})), (false, 0));
    assert_eq!(bash_timeout(&json!({"timeout": 7})), (false, 7));
}

#[test]
fn background_timeout_defaults_to_zero_and_is_not_clamped() {
    assert_eq!(bash_timeout(&json!({"background": true})), (true, 0));
    assert_eq!(
        bash_timeout(&json!({"background": true, "timeout": 100_000})),
        (true, 100_000)
    );
}

#[test]
fn unconfined_policy_starts_in_the_workspace_with_the_roots_anchored() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let read = dir.path().join("ref");
    std::fs::create_dir_all(&read).unwrap();
    let reads = vec![read.clone()];
    let mut ctx = ToolContext::new(&root, &root, &[]);
    ctx.sandbox = false;
    ctx.read_roots = &reads;
    let roots = AnchoredRoots::from_ctx(&ctx);
    assert!(roots.root.is_absolute());
    assert_eq!(roots.read, vec![anchored(&read)]);
    let built = build_bash_policy(&ctx, &roots);
    assert_eq!(built.start, roots.root);
    assert!(!built.in_worktree);
    assert_eq!(built.policy.read_roots, vec![anchored(&read)]);
    assert!(built.policy.write_roots.is_empty());
    assert!(built.policy.unreachable_grants.is_empty());
}

#[test]
fn unconfined_policy_follows_the_direct_shell_start_folder() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("ws");
    let edit = dir.path().join("project");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&edit).unwrap();
    let mut ctx = ToolContext::new(&root, &root, &[]);
    ctx.sandbox = false;
    ctx.direct_shell_start = Some(edit.clone());
    let built = build_bash_policy(&ctx, &AnchoredRoots::from_ctx(&ctx));
    assert_eq!(built.start, anchored(&edit));
    assert!(built.in_worktree);
    // The policy only moves its start into a write root; the shell's start
    // is what follows the edit folder.
    assert_eq!(built.policy.start_dir(), anchored(&root).as_path());
}

#[test]
fn a_missing_direct_shell_start_folder_keeps_the_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let mut ctx = ToolContext::new(&root, &root, &[]);
    ctx.sandbox = false;
    ctx.direct_shell_start = Some(dir.path().join("gone"));
    let built = build_bash_policy(&ctx, &AnchoredRoots::from_ctx(&ctx));
    assert_eq!(built.start, anchored(&root));
    assert!(!built.in_worktree);
}

#[test]
fn confined_shell_ignores_the_direct_shell_start_folder() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("ws");
    let edit = dir.path().join("project");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&edit).unwrap();
    let mut ctx = ToolContext::new(&root, &root, &[]);
    ctx.sandbox = true;
    ctx.direct_shell_start = Some(edit);
    let built = build_bash_policy(&ctx, &AnchoredRoots::from_ctx(&ctx));
    assert_eq!(built.start, anchored(&root));
    assert!(!built.in_worktree);
}

#[test]
fn background_started_text_keeps_the_sentence_the_desktop_parses() {
    let now = background_job_started_text("bash-x-1", 0);
    assert!(now.starts_with("Command was started as a background job and is continuing"));
    assert!(now.contains("(job_id=bash-x-1)"));
    let later = background_job_started_text("bash-x-2", 30);
    assert!(later.starts_with("Command exceeded 30s and is continuing in the background"));
    assert!(later.contains("{\"job_id\": \"bash-x-2\", \"action\": \"cancel\"}"));
}

#[test]
fn timeout_text_lists_warning_note_and_partial_output_in_order() {
    let clean = timeout_text(5, true, None, "  ");
    assert!(clean.starts_with("ERROR: command timed out after 5s and was terminated."));
    assert!(!clean.contains("[warning"));
    assert!(!clean.contains("--- output before the timeout ---"));

    let messy = timeout_text(5, false, Some("\n[note]".into()), "partial");
    let warn = messy.find("[warning: the process tree").unwrap();
    let note = messy.find("[note]").unwrap();
    let part = messy.find("--- output before the timeout ---\npartial").unwrap();
    assert!(warn < note && note < part);
}

#[tokio::test]
async fn job_actions_without_a_command_answer_as_before() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ToolContext::new(dir.path(), dir.path(), &[]);
    let unknown = bash(&json!({"action": "bogus"}), &ctx).await;
    assert!(unknown.starts_with("ERROR: unknown action 'bogus'"), "{unknown}");
    let missing = bash(&json!({"command": "   "}), &ctx).await;
    assert!(missing.starts_with("ERROR: missing required argument 'command'"), "{missing}");
    let status = bash(&json!({"action": "status", "job_id": "nope"}), &ctx).await;
    assert!(status.contains("unknown or already-collected job_id 'nope'"), "{status}");
}
