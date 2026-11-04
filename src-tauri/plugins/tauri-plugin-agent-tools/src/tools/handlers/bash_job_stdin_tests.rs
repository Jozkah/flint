//! `bash` jobs that keep stdin open: `interactive` + `action: "write"`.

use super::*;
use serde_json::json;

fn job_id_of(out: &str) -> String {
    out.split("job_id=")
        .nth(1)
        .and_then(|s| s.split(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_')).next())
        .unwrap_or_else(|| panic!("no job id in: {out}"))
        .to_string()
}

fn unconfined(root: &Path) -> ToolContext<'_> {
    let mut ctx = ToolContext::new(root, root, &[]);
    ctx.sandbox = false;
    ctx
}

#[tokio::test]
async fn interactive_needs_background() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = unconfined(dir.path());
    let out = bash(&json!({"command": "cat", "interactive": true}), &ctx).await;
    assert!(out.starts_with("ERROR:") && out.contains("background"), "{out}");
}

#[tokio::test]
async fn write_reaches_the_command_and_close_ends_it() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = unconfined(dir.path()).with_job_owner("stdin-a");
    let started = bash(
        &json!({"command": "cat", "background": true, "interactive": true}),
        &ctx,
    )
    .await;
    let id = job_id_of(&started);
    let wrote = bash(
        &json!({"job_id": id, "action": "write", "input": "hello stdin\n"}),
        &ctx,
    )
    .await;
    assert!(wrote.starts_with("Wrote 12 bytes"), "{wrote}");
    let closed = bash(&json!({"job_id": id, "action": "write", "close": true}), &ctx).await;
    assert!(closed.contains("closed its stdin"), "{closed}");
    let done = bash(&json!({"job_id": id}), &ctx).await;
    assert!(done.contains("hello stdin"), "{done}");
    let again = bash(&json!({"job_id": id, "action": "write", "input": "x"}), &ctx).await;
    assert!(again.starts_with("ERROR:"), "{again}");
}

#[tokio::test]
async fn a_plain_background_job_has_no_stdin_to_write() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = unconfined(dir.path()).with_job_owner("stdin-b");
    let started = bash(&json!({"command": "sleep 30", "background": true}), &ctx).await;
    let id = job_id_of(&started);
    let out = bash(&json!({"job_id": id, "action": "write", "input": "x\n"}), &ctx).await;
    assert!(out.contains("not started with"), "{out}");
    let _ = bash(&json!({"job_id": id, "action": "cancel"}), &ctx).await;
}

#[tokio::test]
async fn another_conversation_cannot_write() {
    let dir = tempfile::tempdir().unwrap();
    let mine = unconfined(dir.path()).with_job_owner("stdin-c");
    let theirs = unconfined(dir.path()).with_job_owner("stdin-other");
    let started = bash(
        &json!({"command": "cat", "background": true, "interactive": true}),
        &mine,
    )
    .await;
    let id = job_id_of(&started);
    let out = bash(&json!({"job_id": id, "action": "write", "input": "x\n"}), &theirs).await;
    assert!(out.contains("unknown or already-collected"), "{out}");
    let _ = bash(&json!({"job_id": id, "action": "cancel"}), &mine).await;
}

#[tokio::test]
async fn write_rejects_empty_and_oversized_input() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = unconfined(dir.path()).with_job_owner("stdin-d");
    let empty = bash(&json!({"job_id": "bash-x-1", "action": "write"}), &ctx).await;
    assert!(empty.contains("non-empty"), "{empty}");
    let big = "a".repeat(MAX_JOB_WRITE_BYTES + 1);
    let out = bash(&json!({"job_id": "bash-x-1", "action": "write", "input": big}), &ctx).await;
    assert!(out.contains("at most"), "{out}");
}

#[test]
fn written_lines_are_gated_like_commands() {
    use crate::resource::Resource;
    let res = Resource::for_builtin(
        "bash",
        &[],
        false,
        &json!({"job_id": "bash-0", "action": "write", "input": "ls\nrm -rf /\n"}),
        None,
    );
    let commands = res.iter().filter(|r| matches!(r, Resource::Command { .. })).count();
    assert_eq!(commands, 2, "{res:?}");
}
