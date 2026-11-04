//! Persistent `bash` sessions: state survives between calls.

use super::*;
use super::bash_session::split_at_marker;
use serde_json::json;

fn unconfined<'a>(root: &'a Path, owner: &'a str) -> ToolContext<'a> {
    let mut ctx = ToolContext::new(root, root, &[]).with_job_owner(owner);
    ctx.sandbox = false;
    ctx
}

#[tokio::test]
async fn variables_and_directory_persist_across_calls() {
    let dir = tempfile::tempdir().unwrap();
    let sub = dir.path().join("inner");
    std::fs::create_dir(&sub).unwrap();
    let ctx = unconfined(dir.path(), "sess-a");
    let first = bash(&json!({"session": "s", "command": "FOO=kiwi; cd inner; echo set"}), &ctx).await;
    assert!(first.contains("started shell session") && first.contains("set") && first.contains("[exit 0]"), "{first}");
    let second = bash(&json!({"session": "s", "command": "echo $FOO; basename \"$PWD\""}), &ctx).await;
    assert!(second.contains("kiwi") && second.contains("inner"), "{second}");
    assert!(!second.contains("started shell session"), "{second}");
    let _ = bash(&json!({"session": "s", "action": "close"}), &ctx).await;
}

#[tokio::test]
async fn exit_status_and_stderr_are_reported() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = unconfined(dir.path(), "sess-b");
    let out = bash(&json!({"session": "s", "command": "echo oops >&2; false"}), &ctx).await;
    assert!(out.contains("oops") && out.contains("[exit 1]"), "{out}");
    let _ = bash(&json!({"session": "s", "action": "close"}), &ctx).await;
}

#[tokio::test]
async fn a_command_that_exits_the_shell_starts_a_fresh_one_next_time() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = unconfined(dir.path(), "sess-c");
    let out = bash(&json!({"session": "s", "command": "exit 3"}), &ctx).await;
    assert!(out.contains("shell exited"), "{out}");
    let next = bash(&json!({"session": "s", "command": "echo again"}), &ctx).await;
    assert!(next.contains("started shell session") && next.contains("again"), "{next}");
    let _ = bash(&json!({"session": "s", "action": "close"}), &ctx).await;
}

#[tokio::test]
async fn timeout_stops_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = unconfined(dir.path(), "sess-d");
    let out = bash(&json!({"session": "s", "command": "sleep 30", "timeout": 1}), &ctx).await;
    assert!(out.contains("did not finish within 1s"), "{out}");
    let next = bash(&json!({"session": "s", "command": "echo back"}), &ctx).await;
    assert!(next.contains("started shell session") && next.contains("back"), "{next}");
    let _ = bash(&json!({"session": "s", "action": "close"}), &ctx).await;
}

#[tokio::test]
async fn sessions_are_per_conversation_and_per_name() {
    let dir = tempfile::tempdir().unwrap();
    let a = unconfined(dir.path(), "sess-e1");
    let b = unconfined(dir.path(), "sess-e2");
    let _ = bash(&json!({"session": "s", "command": "X=mine"}), &a).await;
    let other = bash(&json!({"session": "s", "command": "echo \"[$X]\""}), &b).await;
    assert!(other.contains("[]"), "{other}");
    let named = bash(&json!({"session": "t", "command": "echo \"[$X]\""}), &a).await;
    assert!(named.contains("[]"), "{named}");
    for (c, n) in [(&a, "s"), (&a, "t"), (&b, "s")] {
        let _ = bash(&json!({"session": n, "action": "close"}), c).await;
    }
}

#[tokio::test]
async fn bad_arguments_and_the_session_cap_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = unconfined(dir.path(), "sess-f");
    let bad = bash(&json!({"session": "no spaces", "command": "ls"}), &ctx).await;
    assert!(bad.starts_with("ERROR:"), "{bad}");
    let fg = bash(&json!({"session": "s", "command": "ls", "background": true}), &ctx).await;
    assert!(fg.starts_with("ERROR:") && fg.contains("foreground"), "{fg}");
    for n in ["a", "b", "c", "d"] {
        let _ = bash(&json!({"session": n, "command": "true"}), &ctx).await;
    }
    let fifth = bash(&json!({"session": "e", "command": "true"}), &ctx).await;
    assert!(fifth.contains("already has 4 shell sessions"), "{fifth}");
    for n in ["a", "b", "c", "d"] {
        let _ = bash(&json!({"session": n, "action": "close"}), &ctx).await;
    }
}

#[test]
fn marker_must_be_followed_by_a_status() {
    let m = "__FLINT_x__";
    assert_eq!(split_at_marker(&format!("hi\n\n{m}0\n"), m), Some(("hi\n".into(), 0)));
    assert_eq!(split_at_marker(&format!("{m}oops\n"), m), None);
    assert_eq!(split_at_marker(&format!("{m}oops\n\n{m}7\n"), m).map(|r| r.1), Some(7));
}
