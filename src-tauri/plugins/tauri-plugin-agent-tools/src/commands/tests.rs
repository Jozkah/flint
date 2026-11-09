#[test]
fn hidden_state_refusal_says_why_and_how_to_carry_on() {
    let msg = super::hidden_state_msg("bash");
    assert!(msg.contains("tool 'bash' is denied: .jan is the agent's own state directory and is hidden"));
    assert!(msg.contains("not run"));
    assert!(msg.contains("Leave .jan out of the command"));
}

use super::*;
use serde_json::json;

#[test]
fn post_tool_batch_respects_project_network_off() {
    let root = std::env::temp_dir().join(format!("flint-batch-net-{}", std::process::id()));
    let toml = crate::policy::agent_toml_path(&root);
    std::fs::create_dir_all(toml.parent().unwrap()).unwrap();
    std::fs::write(&toml, "[tools]\nallow_network = false\n").unwrap();
    assert!(!batch_hook_network(Some(&root), Some(true)));
    assert!(!batch_hook_network(None, Some(false)));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn preview_relative_write_with_direct_edit_grant_diffs_granted_folder() {
    let dir = std::env::temp_dir().join(format!("flint-rebase-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let base = rebase_base_for(Path::new("C:/data"), &[], Some(dir.clone()));
    assert_eq!(base.as_deref(), Some(dir.as_path()));
    let mut args = json!({ "path": "note.txt", "content": "x" });
    handlers::rebase_relative_paths("write", &mut args, &dir);
    let rebased = args["path"].as_str().unwrap().replace('\\', "/");
    assert!(rebased.ends_with("note.txt") && Path::new(&rebased).is_absolute(), "{rebased}");
    assert_eq!(rebase_base_for(Path::new("C:/data"), &[], None), None);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_read_escape_names_the_path_tried_and_the_allowed_folders() {
    let msg = read_escape_message(
        "read",
        &json!({ "path": "C:/ws/abc6/src/app.js" }),
        Path::new("C:/scratch"),
        &[PathBuf::from("C:/ws/abc96")],
    );
    assert!(msg.contains("(C:/ws/abc6/src/app.js)"), "{msg}");
    assert!(msg.contains("Allowed folders: C:/ws/abc96, C:/scratch"), "{msg}");
}
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[test]
fn tool_result_serializes_images_camel_case_and_omits_when_empty() {
    let mut r = ToolResult {
        content: "Read image a.png (image/png, 3 bytes)".into(),
        diff: None,
        is_error: false,
        error: None,
        resources: None,
        unsandboxed_retry: None,
        images: vec![crate::tools::ImageContentPart {
            data_url: "data:image/png;base64,QUJD".into(),
            name: "a.png".into(),
        }],
    };
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["images"][0]["dataUrl"], "data:image/png;base64,QUJD");
    assert_eq!(v["images"][0]["name"], "a.png");
    r.images.clear();
    let v = serde_json::to_value(&r).unwrap();
    assert!(v.get("images").is_none());
}

#[test]
fn note_non_posix_shell_amends_only_the_description() {
    let bash = json!({
        "type": "function",
        "function": { "name": "bash", "description": "Run a shell command." }
    });
    let noted = note_non_posix_shell(bash);
    let desc = noted["function"]["description"].as_str().unwrap();
    assert!(desc.starts_with("Run a shell command."));
    assert!(desc.contains("Windows PowerShell"));
    assert!(desc.contains("does not accept `&&`"));
    assert!(desc.contains("`2>$null`"));
    // The name is untouched; only the description grows.
    assert_eq!(noted["function"]["name"], "bash");
}

/// Session 8411d403's audit: a push the user had allowed was written as
/// an open "prompt", with empty run and call ids, under the tool name
/// "git" -- the same text as the `git remote get-url` asked before it.
#[test]
fn a_decision_record_carries_its_run_call_project_and_answer() {
    let data = unique_data_folder();
    std::fs::create_dir_all(&data).unwrap();
    let tool = lookup("git").unwrap();
    let args = json!({"args": ["push", "-u", "origin", "fix/x"]});
    let root = data.join("ws");
    record_permission_decision(
        &data,
        "s1",
        tool,
        &args,
        &root,
        &Decision::Prompt(PromptKind::Ask),
        &DecisionContext {
            run: Some("run-1"),
            call: Some("call-1"),
            project: Some(r"C:\repo"),
            renderer_approved_git: true,
            ..Default::default()
        },
    );
    let bash = lookup("bash").unwrap();
    record_permission_decision(
        &data,
        "s1",
        bash,
        &json!({"command": "go build ./..."}),
        &root,
        &Decision::Prompt(PromptKind::Exec),
        &DecisionContext { unsandboxed: true, ..Default::default() },
    );
    let all = crate::audit::read_all(&data);
    assert_eq!(all.len(), 2, "{all:?}");
    let push = &all[0];
    assert_eq!(push.run, "run-1");
    assert_eq!(push.call, "call-1");
    assert_eq!(push.project, r"C:\repo");
    assert_eq!(push.agent, "main");
    assert_eq!(push.capability, "write");
    assert_eq!(push.decision, crate::audit::Outcome::Granted);
    assert!(push.resource.contains("git push -u origin fix/x"), "{}", push.resource);
    let retry = &all[1];
    assert_eq!(retry.decision, crate::audit::Outcome::Granted);
    assert!(retry.reason.contains("outside the sandbox"), "{}", retry.reason);
    assert_eq!(retry.project, root.to_string_lossy(), "no attached folder: the workspace");
    let _ = std::fs::remove_dir_all(&data);
}

/// An edit the renderer already allowed was logged as "prompt:Write". The
/// record now says whether the user was asked or a mode allowed it; with
/// no source given it stays an open prompt.
#[test]
fn a_renderer_allowed_write_records_whether_the_user_was_asked() {
    let data = unique_data_folder();
    std::fs::create_dir_all(&data).unwrap();
    let root = data.join("ws");
    let write = lookup("write").unwrap();
    let args = json!({"path": "a.txt", "content": "x"});
    for approval in [Some(ApprovalSource::Prompted), Some(ApprovalSource::Auto), Some(ApprovalSource::Bypass), None] {
        record_permission_decision(
            &data,
            "s1",
            write,
            &args,
            &root,
            &Decision::Prompt(PromptKind::Write),
            &DecisionContext { approval, ..Default::default() },
        );
    }
    let all = crate::audit::read_all(&data);
    assert_eq!(all.len(), 4, "{all:?}");
    assert_eq!(all[0].decision, crate::audit::Outcome::Granted);
    assert_eq!(all[0].reason, "approved in the prompt");
    assert_eq!(all[1].decision, crate::audit::Outcome::Allow);
    assert!(all[1].reason.contains("without asking"), "{}", all[1].reason);
    assert_eq!(all[2].decision, crate::audit::Outcome::Allow);
    assert!(all[2].reason.contains("bypass permissions"), "{}", all[2].reason);
    assert_eq!(all[3].decision, crate::audit::Outcome::Prompt);
    assert_eq!(all[3].reason, "prompt:Write");
    let _ = std::fs::remove_dir_all(&data);
}

/// "Write anyway" is recorded as a person's answer to this one write, not
/// as a mode letting it through unasked.
#[test]
fn a_write_anyway_answer_is_recorded_as_granted_in_the_prompt() {
    let data = unique_data_folder();
    std::fs::create_dir_all(&data).unwrap();
    let root = data.join("ws");
    record_permission_decision(
        &data,
        "s1",
        lookup("write").unwrap(),
        &json!({"path": "a.txt", "content": "x"}),
        &root,
        &Decision::Prompt(PromptKind::Write),
        &DecisionContext { approval: Some(ApprovalSource::Secret), ..Default::default() },
    );
    let all = crate::audit::read_all(&data);
    assert_eq!(all.len(), 1, "{all:?}");
    assert_eq!(all[0].decision, crate::audit::Outcome::Granted);
    assert!(all[0].reason.contains("write anyway"), "{}", all[0].reason);
    let _ = std::fs::remove_dir_all(&data);
}

/// F03-005: a prompt the backend refuses anyway (an escape) is logged as
/// a deny even when the renderer says the user approved it.
#[test]
fn audit_records_deny_for_refused_prompt() {
    let data = unique_data_folder();
    std::fs::create_dir_all(&data).unwrap();
    let root = data.join("ws");
    for kind in [PromptKind::WriteEscape, PromptKind::ReadEscape] {
        let refusal = (!prompt_is_honoured(kind, "write", Some(ApprovalSource::Prompted), true, true))
            .then_some(Refusal::Prompt);
        assert!(refusal.is_some(), "{kind:?} is never honoured");
        record_permission_decision(
            &data,
            "s1",
            lookup("write").unwrap(),
            &json!({"path": "a.txt", "content": "x"}),
            &root,
            &Decision::Prompt(kind),
            &DecisionContext {
                approval: Some(ApprovalSource::Prompted),
                refusal,
                ..Default::default()
            },
        );
    }
    // A browser action with no approval at all is refused too.
    assert!(!prompt_is_honoured(PromptKind::Write, "browser", None, true, true));
    // ... while an approved ordinary write still is honoured.
    assert!(prompt_is_honoured(PromptKind::Write, "write", Some(ApprovalSource::Prompted), true, true));
    let all = crate::audit::read_all(&data);
    assert_eq!(all.len(), 2, "{all:?}");
    for r in &all {
        assert_eq!(r.decision, crate::audit::Outcome::Deny, "{r:?}");
        assert!(r.reason.starts_with("refused"), "{}", r.reason);
    }
    let _ = std::fs::remove_dir_all(&data);
}

/// F5a-005: a shell run in a direct edit folder with no approval is
/// audited as a refusal; with approval, as running outside the sandbox.
#[test]
fn direct_edit_bash_without_approval_refused_and_audited_unsandboxed() {
    let data = unique_data_folder();
    std::fs::create_dir_all(&data).unwrap();
    let root = data.join("ws");
    let bash = lookup("bash").unwrap();
    let args = json!({"command": "echo hi"});
    record_permission_decision(
        &data, "s1", bash, &args, &root,
        &Decision::Prompt(PromptKind::Exec),
        &DecisionContext { direct_edit: true, refusal: Some(Refusal::DirectEdit), ..Default::default() },
    );
    record_permission_decision(
        &data, "s1", bash, &args, &root,
        &Decision::Prompt(PromptKind::Exec),
        &DecisionContext {
            direct_edit: true,
            approval: Some(ApprovalSource::Prompted),
            ..Default::default()
        },
    );
    let all = crate::audit::read_all(&data);
    assert_eq!(all.len(), 2, "{all:?}");
    assert_eq!(all[0].decision, crate::audit::Outcome::Deny);
    assert_eq!(all[1].decision, crate::audit::Outcome::Granted);
    assert!(all[1].reason.contains("outside the sandbox"), "{}", all[1].reason);
    let _ = std::fs::remove_dir_all(&data);
}

/// The output sink test's shared ledger: what was sent, tagged with call id.
type Seen = Arc<Mutex<Vec<(u64, Option<String>, String)>>>;

static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// A temp dir standing in for the Jan data folder.
fn unique_data_folder() -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    crate::test_temp_root().join(format!("jan_cmd_test_{}_{}", std::process::id(), n))
}

/// A folder that is *not* under the host temp dir. On Linux an absolute
/// `/tmp/...` path is remapped into the session scratch, which would route
/// an attached-folder test through the wrong branch entirely.
fn repo_outside_tmp(tag: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("attach-tests")
        .join(format!("{tag}_{}_{}", std::process::id(), n));
    std::fs::create_dir_all(&dir).expect("create test repo");
    dir
}

const T1: &str = "thread-one";

/// A thread id no other test uses. The session scratch is keyed by thread
/// id, so tests sharing one share a scratch -- and a test that deletes its
/// thread deletes the scratch another test is about to run bash in. The
/// scratch goes when the returned session is dropped at the end of the test.
fn unique_thread(tag: &str) -> workspace::TestSession {
    workspace::TestSession::new(format!(
        "{tag}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ))
}

#[test]
fn default_store_is_permanent_and_outside_any_sandbox() {
    let store = resolve_store("/data", None);
    assert_eq!(store, Path::new("/data/agent-workspace"));
    // The sandbox lives under threads/, so no relative path from inside one
    // reaches the store without escaping it.
    let sandbox = workspace::thread_workspace(Path::new("/data"), T1).unwrap();
    assert!(!workspace::store_dir(&store, "memory").starts_with(&sandbox));
}

#[test]
fn explicit_project_uses_its_co_located_store() {
    assert_eq!(
        resolve_store("/data", Some("/repo")),
        Path::new("/repo/.jan/agent")
    );
    // Blank is treated as absent, not as the filesystem root.
    assert_eq!(
        resolve_store("/data", Some("   ")),
        Path::new("/data/agent-workspace")
    );
}

#[test]
fn error_strips_the_tool_protocol_prefix() {
    let e = AgentToolsError::from("ERROR: invalid name '..'".to_string());
    assert_eq!(e.message, "invalid name '..'");
    let e = AgentToolsError::from("plain message".to_string());
    assert_eq!(e.message, "plain message");
}

/// Writes land in the thread's ephemeral sandbox and are allowed there. This
/// pins the containment that makes that safe: the file appears where it was
/// asked for, and nowhere else.
/// AH-110: a call that names who it is acting for has its changes
/// journaled under that agent; one that names something that is not an
/// agent is refused before the tool runs, so no change is left to be
/// attributed later.
#[tokio::test]
async fn a_tool_call_journals_its_agent_and_refuses_an_identity_that_is_not_one() {
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    let t1 = "s-actor";
    let actor = |id: &str, label: &str| {
        Some(ActorInput {
            id: id.into(),
            label: Some(label.into()),
            parent: None,
            invocation: Some("inv-1".into()),
            task: None,
        })
    };

    let out = execute_tool(
        df.clone(),
        t1.into(),
        None,
        "write".into(),
        json!({"path": "by-main.txt", "content": "hello"}),
        None,
        None,
        None,
        None,
        None,
        None,
        Some("run-1".into()),
        actor("agent", ""),
        None,
        None,
        None,
    )
    .await
    .expect("the write runs");
    assert!(!out.is_error, "{}", out.content);

    let out = execute_tool(
        df.clone(),
        t1.into(),
        None,
        "write".into(),
        json!({"path": "by-child.txt", "content": "hello"}),
        None,
        None,
        None,
        None,
        None,
        None,
        Some("run-1".into()),
        actor("agent:explorer", "Explorer"),
        None,
        None,
        None,
    )
    .await
    .expect("the write runs");
    assert!(!out.is_error, "{}", out.content);

    let turns = undo_journal(df.clone(), t1.into());
    let turn = turns.iter().find(|t| t.run == "run-1").expect("the turn");
    assert_eq!(turn.actors.len(), 2, "{:?}", turn.actors);
    let of = |name: &str| {
        turn.changes
            .iter()
            .find(|c| c.path.ends_with(name))
            .and_then(|c| c.actor.clone())
            .unwrap_or_else(|| panic!("no actor for {name}"))
    };
    assert_eq!(of("by-main.txt").kind, crate::undo::ActorKind::Primary);
    assert_eq!(of("by-main.txt").label, "the primary agent");
    let child = of("by-child.txt");
    assert_eq!((child.id.as_str(), child.label.as_str()), ("agent:explorer", "Explorer"));
    assert_eq!(child.invocation.as_deref(), Some("inv-1"));

    // Not an agent: refused, and nothing written.
    let err = execute_tool(
        df.clone(),
        t1.into(),
        None,
        "write".into(),
        json!({"path": "forged.txt", "content": "hello"}),
        None,
        None,
        None,
        None,
        None,
        None,
        Some("run-1".into()),
        actor("session:s-actor", "The user"),
        None,
        None,
        None,
    )
    .await
    .expect_err("an identity that is not an agent is refused");
    assert!(format!("{err:?}").contains("does not name an agent"), "{err:?}");
    let sandbox = workspace::thread_workspace(&data, t1).unwrap();
    assert!(!sandbox.join("forged.txt").exists(), "a refused call wrote a file");
    let turns = undo_journal(df, t1.into());
    assert!(
        turns.iter().all(|t| t.changes.iter().all(|c| !c.path.ends_with("forged.txt"))),
        "a refused call reached the journal"
    );
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test]
async fn writes_are_allowed_inside_the_ephemeral_sandbox() {
    let t1: &str = &unique_thread("writes_are_allowed_inside_the_ephemeral_sandbox");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();

    let out = execute_tool(
        df.clone(),
        t1.into(),
        None,
        "write".into(),
        json!({"path": "a.txt", "content": "hello"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("a write inside the sandbox is allowed");
    assert!(!out.is_error, "got: {}", out.content);

    let sandbox = workspace::thread_workspace(&data, t1).unwrap();
    assert_eq!(
        std::fs::read_to_string(sandbox.join("a.txt")).ok(),
        Some("hello".to_string())
    );
    let _ = std::fs::remove_dir_all(&data);
}

/// AH-146: an approval prompt sees the change before it is allowed. The
/// preview is the diff the call would make, nothing is written, and a path
/// outside where the call could write has no preview at all -- so the
/// preview cannot be used to read a file no tool may read.
#[tokio::test]
async fn a_change_is_previewed_before_it_is_allowed_and_only_where_it_could_land() {
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    let sandbox = workspace::thread_workspace(&data, T1).unwrap();
    std::fs::create_dir_all(&sandbox).unwrap();
    std::fs::write(sandbox.join("a.txt"), "old line\n").unwrap();

    let shown = preview_change(
        df.clone(),
        T1.into(),
        "write".into(),
        json!({"path": "a.txt", "content": "new line\n"}),
        None,
        None,
    )
    .await
    .expect("answered")
    .expect("a diff for a change inside the workspace");
    assert!(shown.contains("overwrote") && shown.contains("new line"), "{shown}");
    assert_eq!(
        std::fs::read_to_string(sandbox.join("a.txt")).unwrap(),
        "old line\n",
        "a preview must not write"
    );

    let edit = preview_change(
        df.clone(),
        T1.into(),
        "edit".into(),
        json!({"path": "a.txt", "edits": [{"old_string": "old line", "new_string": "edited"}]}),
        None,
        None,
    )
    .await
    .expect("answered")
    .expect("a diff for an edit");
    assert!(edit.contains("-") && edit.contains("edited"), "{edit}");

    // Outside every root this session may write: no preview.
    let outside = repo_outside_tmp("preview").join("outside-secret.txt");
    std::fs::write(&outside, "SECRET\n").unwrap();
    for path in [outside.to_string_lossy().to_string(), "../../../outside-secret.txt".into()] {
        let none = preview_change(
            df.clone(),
            T1.into(),
            "edit".into(),
            json!({"path": path, "edits": [{"old_string": "SECRET", "new_string": "x"}]}),
            None,
            None,
        )
        .await
        .expect("answered");
        assert!(none.is_none(), "previewed {path} outside the workspace: {none:?}");
    }
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "SECRET\n");

    // Only file-changing tools have one.
    let read = preview_change(
        df.clone(),
        T1.into(),
        "read".into(),
        json!({"path": "a.txt"}),
        None,
        None,
    )
    .await
    .expect("answered");
    assert!(read.is_none());
    let _ = std::fs::remove_dir_all(&data);
}

/// AH-202 through the real command: a write made for a run is journaled at
/// the path the handler wrote, undoing the turn removes it, and redoing it
/// brings it back. A write with no run is not journaled.
#[tokio::test]
async fn a_turns_write_can_be_undone_and_redone_through_the_commands() {
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    let sandbox = workspace::thread_workspace(&data, T1).unwrap();

    let out = execute_tool(
        df.clone(),
        T1.into(),
        None,
        "write".into(),
        json!({"path": "a.txt", "content": "from the turn"}),
        None,
        None,
        None,
        None,
        None,
        None,
        Some("run-1".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .expect("allowed");
    assert!(!out.is_error, "got: {}", out.content);
    let journal = undo_journal(df.clone(), T1.into());
    assert_eq!(journal.len(), 1);
    assert_eq!(journal[0].run, "run-1");

    undo_turn(df.clone(), T1.into(), "run-1".into(), None, None)
        .await
        .expect("a clean undo");
    assert!(!sandbox.join("a.txt").exists(), "undo removed the created file");
    redo_turn(df.clone(), T1.into(), "run-1".into(), None, None)
        .await
        .expect("a clean redo");
    assert_eq!(
        std::fs::read_to_string(sandbox.join("a.txt")).ok(),
        Some("from the turn".to_string())
    );

    // The user edits it; undoing now is refused and names the file.
    std::fs::write(sandbox.join("a.txt"), "the user's").unwrap();
    let err = undo_turn(df.clone(), T1.into(), "run-1".into(), None, None)
        .await
        .expect_err("a changed file refuses the undo");
    assert!(err.message.contains("a.txt"), "{}", err.message);
    assert_eq!(
        std::fs::read_to_string(sandbox.join("a.txt")).ok(),
        Some("the user's".to_string())
    );

    // Without a run there is nothing to undo from.
    execute_tool(
        df.clone(),
        T1.into(),
        None,
        "write".into(),
        json!({"path": "b.txt", "content": "unowned"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("allowed");
    assert_eq!(undo_journal(df.clone(), T1.into()).len(), 1);
    let _ = std::fs::remove_dir_all(&data);
}

/// `edit` returns a display-only diff. It must reach the caller (the UI needs
/// it) while staying out of `content`, which is what the model sees.
#[tokio::test]
async fn edit_returns_a_diff_for_display_only() {
    let t1: &str = &unique_thread("edit_returns_a_diff_for_display_only");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    let sandbox = workspace::ensure_thread_workspace(&data, t1).await.unwrap();
    std::fs::write(sandbox.join("a.txt"), b"before").unwrap();

    let out = execute_tool(
        df.clone(),
        t1.into(),
        None,
        "edit".into(),
        json!({"path": "a.txt", "edits": [{"old_string": "before", "new_string": "after"}]}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert!(!out.is_error, "got: {}", out.content);
    let diff = out.diff.expect("edit must report a diff");
    assert!(
        diff.contains("after"),
        "diff should show the change: {diff}"
    );
    assert!(
        !out.content.contains(&diff),
        "the diff must not be duplicated into model-facing content"
    );
    let _ = std::fs::remove_dir_all(&data);
}

/// The gate still decides: a read that escapes the sandbox is a `Prompt` and
/// stays refused, so allowing writes did not open the door generally.
#[tokio::test]
async fn escaping_reads_are_still_refused() {
    let t1: &str = &unique_thread("escaping_reads_are_still_refused");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();

    let err = execute_tool(
        df.clone(),
        t1.into(),
        None,
        "read".into(),
        json!({"path": "../../../etc/hostname"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("an escaping read must be refused");
    assert!(
        err.message.contains("is outside the workspace and every folder the user has granted"),
        "unexpected error {}",
        err.message
    );
    let _ = std::fs::remove_dir_all(&data);
}

/// A write that escapes the sandbox (absolute or `..`) must be refused on
/// the desktop surface, just like an escaping read -- it could reach host
/// files. The session scratch is the exception: it is the agent's own area,
/// spelled `/tmp/...` where it is bound over the sandbox's `/tmp` and by its
/// real path where nothing is mounted there.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn escaping_writes_are_refused() {
    let t_scratch: &str = &unique_thread("escaping_writes_are_refused");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();

    for path in ["../escape.txt", "/etc/hosts", "/home/akarshan/.bashrc"] {
        let err = execute_tool(
            df.clone(),
            t_scratch.into(),
            None,
            "write".into(),
            json!({"path": path, "content": "x"}),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        None,
        None,
        )
        .await
        .expect_err("an escaping write must be refused");
        assert!(
            err.message.contains("outside the agent workspace"),
            "unexpected error {}",
            err.message
        );
    }

    // A scratch write is not a host escape and succeeds, under whichever
    // spelling reaches the scratch on this platform. The scratch outlives the
    // test process, so the name is per-run: a leftover file would answer
    // "No change" instead of "Created".
    // The sweep test collects every scratch in the shared temp dir; without
    // this it can delete ours between the write and the assertion.
    let scratch = crate::workspace::ensure_scratch_dir(t_scratch)
        .await
        .unwrap();
    let name = format!("jan_cmd_scratch_{}.txt", std::process::id());
    let p = scratch.join(&name).to_string_lossy().into_owned();
    let (requested, expected) = (p.clone(), p);
    let res = execute_tool(
        df.clone(),
        t_scratch.into(),
        None,
        "write".into(),
        json!({"path": requested, "content": "x"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("a scratch write is the session scratch and must succeed");
    assert!(
        res.content.starts_with(&format!("Created {expected}")),
        "got: {}",
        res.content
    );
    let _ = std::fs::remove_file(scratch.join(&name));

    // An in-sandbox write still succeeds, so we didn't over-tighten.
    let res = execute_tool(
        df.clone(),
        t_scratch.into(),
        None,
        "write".into(),
        json!({"path": "ok.txt", "content": "x"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("an in-workspace write must succeed");
    assert_eq!(res.content, "Created ok.txt (1 bytes)");
    let _ = std::fs::remove_dir_all(&data);
}

/// The status the frontend gates on must agree with what execution actually
/// does, or the tool list and the executor disagree about whether bash works.
#[tokio::test]
async fn sandbox_status_matches_the_backend_execution_uses() {
    let status = sandbox_status().await.unwrap();
    assert_eq!(status.enforces, jail::backend().enforces());
    assert_eq!(status.backend, jail::backend().as_str());
    assert_ne!(status.backend, "", "a backend always has a name");
    assert_eq!(status.enforces, status.backend != "none");
}

/// `bash` availability tracks the sandbox, in both directions: it runs when
/// the OS can confine it and is refused when it cannot. Asserting both arms
/// keeps the fallback honest on hosts (and CI images) with no backend.
#[tokio::test]
async fn bash_runs_only_when_the_sandbox_can_enforce() {
    let t1: &str = &unique_thread("bash_runs_only_when_the_sandbox_can_enforce");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();

    let result = execute_tool(
        df.clone(),
        t1.into(),
        None,
        "bash".into(),
        json!({"command": "echo hi"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await;

    if jail::backend().enforces() {
        let out = result.expect("sandboxed bash should run");
        assert!(!out.is_error, "got: {}", out.content);
        assert!(out.content.contains("hi"), "got: {}", out.content);
    } else {
        let out = result.expect("the refusal is a tool result, not an IPC error");
        assert!(out.is_error);
        assert!(
            out.content.contains("no OS sandbox"),
            "the model must be told why, got: {}",
            out.content
        );
    }
    let _ = std::fs::remove_dir_all(&data);
}

/// Windows, end to end: under "Edit this folder" the sandboxed shell writes
/// the authorized folder and its extra folders and not the one beside
/// them; under Review only it reads an attached folder and cannot write
/// it; once the grant is revoked the shell cannot write the folder again.
#[cfg(windows)]
#[tokio::test]
async fn the_windows_shell_edits_only_authorized_folders() {
    if jail::backend() != jail::Backend::AppContainer {
        eprintln!("skipping: AppContainer is not available here");
        return;
    }
    let sid: &str = &unique_thread("windows_edit_folder");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    let repo = repo_outside_tmp("ac-edit");
    let extra = repo_outside_tmp("ac-extra");
    let sibling = repo_outside_tmp("ac-sibling");
    std::fs::write(sibling.join("notes.txt"), b"sibling notes").unwrap();
    let fwd = |p: &Path| p.to_string_lossy().replace('\\', "/");
    let bash = |command: String, project: Option<String>, grant: Option<String>| {
        execute_tool(
            df.clone(),
            sid.into(),
            None,
            "bash".into(),
            json!({ "command": command }),
            None,
            None,
            project,
            grant,
            Some(WorkspaceScope::Session),
            None,
            None,
            None,
            None,
        None,
        None,
        )
    };

    let grant = direct_edit_authorize(
        df.clone(),
        sid.into(),
        repo.to_string_lossy().into(),
        Some(vec![extra.to_string_lossy().into()]),
        None,
    )
    .await
    .expect("the folder is authorized");
    for (dir, name) in [(&repo, "in-repo.txt"), (&extra, "in-extra.txt"), (&sibling, "in-sibling.txt")] {
        let _ = bash(
            format!("echo edited > \"{}/{name}\"", fwd(dir)),
            Some(repo.to_string_lossy().into()),
            Some(grant.clone()),
        )
        .await;
    }
    assert!(repo.join("in-repo.txt").exists(), "the authorized folder was not writable");
    assert!(extra.join("in-extra.txt").exists(), "the extra folder was not writable");
    assert!(!sibling.join("in-sibling.txt").exists(), "a folder beside them was written");

    // Review only: the sibling attached, no grant.
    direct_edit_revoke(grant).await;
    let out = bash(
        format!("cat \"{}/notes.txt\"", fwd(&sibling)),
        Some(sibling.to_string_lossy().into()),
        None,
    )
    .await
    .expect("runs");
    assert!(out.content.contains("sibling notes"), "the attached folder was not readable: {}", out.content);
    let _ = bash(
        format!("echo x > \"{}/review.txt\"", fwd(&sibling)),
        Some(sibling.to_string_lossy().into()),
        None,
    )
    .await;
    assert!(!sibling.join("review.txt").exists(), "Review only wrote the attached folder");
    let _ = bash(
        format!("echo x > \"{}/after-revoke.txt\"", fwd(&repo)),
        Some(repo.to_string_lossy().into()),
        None,
    )
    .await;
    assert!(!repo.join("after-revoke.txt").exists(), "the revoked folder stayed writable");

    for dir in [&repo, &extra, &sibling] {
        let _ = std::fs::remove_dir_all(dir);
    }
    let _ = std::fs::remove_dir_all(&data);
}

/// The network flag has to survive the whole IPC -> ToolContext -> jail path.
/// Only the closed direction is asserted: opening it would make the test
/// depend on the host actually having connectivity.
#[tokio::test]
async fn bash_has_no_network_unless_the_caller_asks() {
    let t1: &str = &unique_thread("bash_has_no_network_unless_the_caller_asks");
    if !jail::backend().enforces() {
        eprintln!("skipping: no sandbox backend on this host");
        return;
    }
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    // The probe has to be written for the shell `execute_tool` will pick,
    // so the flavour is asked of the same policy that call builds: this
    // thread's own workspace and scratch. It used to ask about the shared
    // host temp dir, a different policy whose answer need not match.
    let workspace = crate::workspace::ensure_thread_workspace(&data, t1)
        .await
        .unwrap();
    let scratch = crate::workspace::ensure_scratch_dir(t1).await.unwrap();
    let command = network_probe(&workspace, &scratch);

    let out = execute_tool(
        df.clone(),
        t1.into(),
        None,
        "bash".into(),
        // A connection attempt written for whichever shell will actually
        // run it. `/dev/tcp` is a bash builtin, and on a host whose
        // sandboxed shell is PowerShell -- which on Windows is every host,
        // because the MSYS2 runtime Git Bash needs cannot start inside an
        // AppContainer -- it is a parse error, so the test failed on
        // syntax rather than on whether the network was reachable.
        json!({ "command": command }),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert!(!out.content.contains("connected"), "got: {}", out.content);
    assert!(
        out.content.contains("Network access is disabled"),
        "a network refusal must explain itself, got: {}",
        out.content
    );
    let _ = std::fs::remove_dir_all(&data);
    let _ = crate::workspace::remove_scratch_dir(t1).await;
}

/// Try to open a TCP connection, in the language the sandboxed shell speaks.
///
/// Success prints `connected`; the assertion is that it never does.
fn network_probe(workspace: &Path, scratch: &Path) -> String {
    use crate::tools::{jail, proc::ShellFlavor};
    let policy = jail::Policy::new(workspace, false).with_scratch_root(scratch);
    match jail::select_shell(&policy)
        .ok()
        .map(|s| s.report.cfg.flavor)
    {
        Some(ShellFlavor::PowerShell) => {
            // No `catch`: the refusal has to reach stderr for Jan to
            // recognise it and explain itself. Swallowing it leaves a bare
            // `[exit 1]`, which is exactly the unexplained failure the
            // hint exists to prevent.
            "$c = New-Object Net.Sockets.TcpClient('1.1.1.1', 53); if ($c.Connected) { 'connected' }"
                .to_string()
        }
        Some(ShellFlavor::Cmd) => {
            // `cmd` has no socket primitive; the closest stock probe.
            "ping -n 1 -w 1000 1.1.1.1 && echo connected".to_string()
        }
        _ => "exec 3<>/dev/tcp/1.1.1.1/53 && echo connected".to_string(),
    }
}

/// The sandbox is created by `execute_tool` itself. Without that, the very
/// first tool call of a thread would be refused: `escapes_project`
/// canonicalizes the root and a missing root reads as an escape.
#[tokio::test]
async fn first_tool_call_creates_the_sandbox() {
    let t1: &str = &unique_thread("first_tool_call_creates_the_sandbox");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();

    let out = execute_tool(
        df.clone(),
        t1.into(),
        None,
        "ls".into(),
        json!({}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert!(!out.is_error, "got: {}", out.content);
    assert!(workspace::thread_workspace(&data, t1).unwrap().is_dir());
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test]
async fn allowed_read_runs_in_the_thread_sandbox() {
    let t1: &str = &unique_thread("allowed_read_runs_in_the_thread_sandbox");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    let sandbox = PathBuf::from(thread_workspace_path(df.clone(), t1.into()).await.unwrap());
    std::fs::write(sandbox.join("a.txt"), b"hello").unwrap();

    let out = execute_tool(
        df.clone(),
        t1.into(),
        None,
        "read".to_string(),
        json!({"path": "a.txt"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert!(out.content.contains("hello"), "got: {}", out.content);
    assert!(!out.is_error);
    let _ = std::fs::remove_dir_all(&data);
}

/// Thread isolation: each conversation gets its own sandbox, and neither a
/// relative climb-out nor a sibling-thread absolute path reaches the other's
/// scratch files. `/tmp` is the agent's own (per-thread) scratch, so a read
/// of `/tmp` from a different thread resolves to that thread's empty scratch.
#[tokio::test]
async fn one_thread_cannot_read_another_threads_files() {
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    // Thread ids unique to this test rather than the ids shared across the
    // module: a scratch is keyed on the session id alone and lives in the
    // host temp dir, so it is global state even though each test gets its
    // own data folder, and any test deleting that thread's workspace also
    // removes its scratch (see `remove_thread_workspace`).
    let (t1, t2) = ("isolation-thread-one", "isolation-thread-two");
    let one = PathBuf::from(thread_workspace_path(df.clone(), t1.into()).await.unwrap());
    thread_workspace_path(df.clone(), t2.into()).await.unwrap();
    std::fs::write(one.join("secret.txt"), b"classified").unwrap();

    // A relative climb-out reaches the sibling thread's workspace and is an
    // escape, so it must prompt (and is refused on this surface).
    let err = execute_tool(
        df.clone(),
        t2.into(),
        None,
        "read".into(),
        json!({"path": "../isolation-thread-one/secret.txt"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("a relative climb-out to a sibling thread must be refused");
    assert!(
        err.message.contains("is outside the workspace and every folder the user has granted"),
        "unexpected: {}",
        err.message
    );

    // `/tmp` is the per-thread scratch on Linux, where the bash sandbox binds
    // it. Elsewhere it stays an ordinary host path outside every root this
    // session may reach. Both are the same property from t2's side — it
    // cannot read what t1 wrote — but they refuse differently: Linux serves
    // an empty scratch and reports a missing file, while macOS and Windows
    // refuse the path outright as a read escape. The assertion is therefore
    // on the secret never arriving, not on which refusal was used.
    let one_scratch = crate::workspace::ensure_scratch_dir(t1).await.unwrap();
    std::fs::write(one_scratch.join("secret.txt"), b"classified").unwrap();
    // The test names t1's real scratch (the one name a scratch has on every
    // platform): correct code refuses it as an escape, and code that let
    // sessions share a scratch would hand it over.
    let target = one_scratch
        .join("secret.txt")
        .to_string_lossy()
        .into_owned();

    let refusal = match execute_tool(
        df.clone(),
        t2.into(),
        None,
        "read".into(),
        json!({"path": target}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    {
        Ok(out) => {
            assert!(
                out.is_error,
                "t2 must not read t1's scratch, got: {}",
                out.content
            );
            out.content
        }
        Err(e) => e.message,
    };
    assert!(
        !refusal.contains("classified"),
        "t1's scratch leaked to t2: {refusal}"
    );
    let _ = std::fs::remove_dir_all(&data);
    let _ = crate::workspace::remove_scratch_dir(t1).await;
    let _ = crate::workspace::remove_scratch_dir(t2).await;
}

/// O02-024: a widening approval sent as a bare string, with a forged
/// token, a token for other arguments, or a replayed token is refused at
/// the command layer; only a fresh token for this exact call runs it.
#[tokio::test]
async fn approval_needs_a_token_bound_to_this_call() {
    let t: &str = &unique_thread("approval_needs_a_token_bound_to_this_call");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    let run = |token: Option<String>| {
        let df = df.clone();
        async move {
            execute_tool(
                df, t.into(), None, "memory_write".into(),
                json!({"name": "a", "content": "x"}),
                None, None, None, None, None, None, None, None, None,
                Some(ApprovalSource::Prompted), token,
            )
            .await
        }
    };
    let refused = |r: Result<ToolResult, AgentToolsError>| match r {
        Err(e) => assert!(e.message.contains("approval token"), "{}", e.message),
        Ok(_) => panic!("ran without a valid token"),
    };
    refused(run(None).await);
    refused(run(Some("appr-forged".into())).await);
    let other = approval_mint(
        t.into(), None, "memory_write".into(),
        json!({"name": "a", "content": "DIFFERENT"}), ApprovalSource::Prompted,
    );
    refused(run(Some(other)).await);
    let good = approval_mint(
        t.into(), None, "memory_write".into(),
        json!({"name": "a", "content": "x"}), ApprovalSource::Prompted,
    );
    assert!(run(Some(good.clone())).await.is_ok());
    refused(run(Some(good)).await);
    let _ = std::fs::remove_dir_all(&data);
    let _ = crate::workspace::remove_scratch_dir(t).await;
}

/// Memory is permanent: wiping a thread's sandbox leaves it untouched, and a
/// note written under one thread is readable from the next.
#[tokio::test]
async fn memory_outlives_the_thread_that_wrote_it() {
    let t2: &str = &unique_thread("memory_outlives_the_thread_that_wrote_it-two");
    let t1: &str = &unique_thread("memory_outlives_the_thread_that_wrote_it");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();

    let out = execute_tool(
        df.clone(),
        t1.into(),
        None,
        "memory_write".into(),
        json!({"name": "prefs", "content": "user likes tabs"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(ApprovalSource::Prompted),
        Some(approval_mint(t1.into(), None, "memory_write".into(), json!({"name": "prefs", "content": "user likes tabs"}), ApprovalSource::Prompted)),
    )
    .await
    .unwrap();
    assert!(!out.is_error, "got: {}", out.content);

    thread_workspace_delete(df.clone(), t1.into())
        .await
        .unwrap();
    assert!(!workspace::thread_workspace(&data, t1).unwrap().exists());

    let out = execute_tool(
        df.clone(),
        t2.into(),
        None,
        "memory_read".into(),
        json!({"name": "prefs"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(out.content, "user likes tabs");
    let _ = std::fs::remove_dir_all(&data);
}

/// Memory lives outside the sandbox, so the general filesystem tools cannot
/// reach it even by climbing out -- no extra rule, just `escapes_project`.
#[tokio::test]
async fn filesystem_tools_cannot_reach_memory() {
    let t1: &str = &unique_thread("filesystem_tools_cannot_reach_memory");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    memory_write(df.clone(), None, "prefs".into(), "secret".into())
        .await
        .unwrap();
    thread_workspace_path(df.clone(), t1.into()).await.unwrap();

    // A relative climb out of the thread sandbox toward the store is an
    // escape and must be refused.
    let err = execute_tool(
        df.clone(),
        t1.into(),
        None,
        "read".into(),
        json!({"path": "../../memory/prefs.md"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("memory must be unreachable from the sandbox");
    assert!(
        err.message.contains("is outside the workspace and every folder the user has granted"),
        "unexpected: {}",
        err.message
    );
    let _ = std::fs::remove_dir_all(&data);
}

/// A sweep clears leftover sandboxes without touching the store.
#[tokio::test]
async fn sweep_keeps_live_threads_and_the_store() {
    let t2: &str = &unique_thread("sweep_keeps_live_threads_and_the_store-two");
    let t1: &str = &unique_thread("sweep_keeps_live_threads_and_the_store");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    memory_write(df.clone(), None, "prefs".into(), "keep me".into())
        .await
        .unwrap();
    thread_workspace_path(df.clone(), t1.into()).await.unwrap();
    thread_workspace_path(df.clone(), t2.into()).await.unwrap();

    let removed = thread_workspace_sweep(df.clone(), vec![t1.to_string()])
        .await
        .unwrap();
    assert_eq!(removed, 1);
    assert!(workspace::thread_workspace(&data, t1).unwrap().is_dir());
    assert!(!workspace::thread_workspace(&data, t2).unwrap().exists());
    assert_eq!(
        memory_read(df.clone(), None, "prefs".into()).await.unwrap(),
        "keep me"
    );
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test]
async fn a_traversing_thread_id_is_rejected() {
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    for bad in ["../../..", "a/b", ""] {
        assert!(
            thread_workspace_path(df.clone(), bad.into()).await.is_err(),
            "expected {bad:?} to be rejected"
        );
        assert!(
            execute_tool(
                df.clone(),
                bad.into(),
                None,
                "ls".into(),
                json!({}),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
        None,
        None,
            )
            .await
            .is_err(),
            "expected {bad:?} to be rejected by execute_tool"
        );
    }
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test]
async fn agent_config_surface_is_hard_denied() {
    let t1: &str = &unique_thread("agent_config_surface_is_hard_denied");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    thread_workspace_path(df.clone(), t1.into()).await.unwrap();

    let err = execute_tool(
        df.clone(),
        t1.into(),
        None,
        "read".to_string(),
        json!({"path": ".jan/agent/agent.toml"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("agent config must be hard-denied");
    assert!(
        err.message.contains("is hidden"),
        "unexpected: {}",
        err.message
    );
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test]
async fn unknown_tool_is_rejected() {
    let t1: &str = &unique_thread("unknown_tool_is_rejected");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    let err = execute_tool(
        df,
        t1.into(),
        None,
        "rm_rf".to_string(),
        json!({}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("unknown tool");
    assert!(err.message.contains("unknown built-in tool"));
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test]
async fn memory_crud_roundtrip_in_the_permanent_store() {
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    workspace_path(df.clone()).await.unwrap();

    assert!(memory_list(df.clone(), None).await.unwrap().is_empty());
    memory_write(df.clone(), None, "prefs".into(), "body".into())
        .await
        .unwrap();
    assert_eq!(memory_list(df.clone(), None).await.unwrap(), vec!["prefs"]);
    assert_eq!(
        memory_read(df.clone(), None, "prefs".into()).await.unwrap(),
        "body"
    );
    memory_delete(df.clone(), None, "prefs".into())
        .await
        .unwrap();
    assert!(memory_list(df.clone(), None).await.unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test]
async fn skill_crud_roundtrip_in_the_permanent_store() {
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    workspace_path(df.clone()).await.unwrap();

    skill_write(
        df.clone(),
        None,
        "deploy".into(),
        "---\ndescription: d\n---\nbody".into(),
    )
    .await
    .unwrap();
    let listed = skill_list(df.clone(), None).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "deploy");
    assert_eq!(listed[0].description, "d");
    assert!(skill_read(df.clone(), None, "deploy".into())
        .await
        .unwrap()
        .contains("body"));
    skill_delete(df.clone(), None, "deploy".into())
        .await
        .unwrap();
    assert!(skill_list(df.clone(), None).await.unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&data);
}

/// A skill written by the model under one thread is loadable from the next,
/// same as memory.
#[tokio::test]
async fn skills_written_by_a_tool_outlive_the_thread() {
    let t2: &str = &unique_thread("skills_written_by_a_tool_outlive_the_thread-two");
    let t1: &str = &unique_thread("skills_written_by_a_tool_outlive_the_thread");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();

    execute_tool(
        df.clone(),
        t1.into(),
        None,
        "skill_write".into(),
        json!({"name": "deploy", "content": "---\ndescription: d\n---\nrun it"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(ApprovalSource::Prompted),
        Some(approval_mint(t1.into(), None, "skill_write".into(), json!({"name": "deploy", "content": "---\ndescription: d\n---\nrun it"}), ApprovalSource::Prompted)),
    )
    .await
    .unwrap();
    thread_workspace_delete(df.clone(), t1.into())
        .await
        .unwrap();

    let out = execute_tool(
        df.clone(),
        t2.into(),
        None,
        "skill_read".into(),
        json!({"name": "deploy"}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(out.content, "run it");
    let _ = std::fs::remove_dir_all(&data);
}
// ---- read-only attached folder, end to end ------------------------------

/// The contract the workspace UI promises: the agent reads your folder and
/// writes only into its own sandbox.
#[tokio::test]
async fn an_attached_folder_is_readable_and_unwritable() {
    let thread: &str = &unique_thread("an_attached_folder_is_readable_and_unwritable");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    let repo = repo_outside_tmp("rw");
    std::fs::write(repo.join("main.rs"), b"fn main() {}").unwrap();
    let attached = Some(repo.to_string_lossy().to_string());

    let read = execute_tool(
        df.clone(),
        thread.into(),
        None,
        "read".into(),
        json!({"path": repo.join("main.rs").to_string_lossy()}),
        None,
        None,
        attached.clone(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert!(!read.is_error, "{}", read.content);
    assert!(read.content.contains("fn main"), "{}", read.content);

    let write = execute_tool(
        df.clone(),
        thread.into(),
        None,
        "write".into(),
        json!({"path": repo.join("evil.txt").to_string_lossy(), "content": "x"}),
        None,
        None,
        attached,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await;
    let err = write.expect_err("a write into the attached folder must be refused");
    // The wording matters: told only "refused", a model retries until the
    // step budget runs out.
    let msg = format!("{err:?}");
    assert!(msg.contains("read-only"), "{msg}");
    assert!(msg.contains("copy the file into the workspace"), "{msg}");
    assert!(!repo.join("evil.txt").exists(), "nothing was written");

    let _ = std::fs::remove_dir_all(&data);
    let _ = std::fs::remove_dir_all(&repo);
}

/// A session's extra attached folders are readable exactly like the
/// primary: without them a read there is refused, with them it succeeds.
#[tokio::test]
async fn an_extra_attached_folder_is_readable_like_the_primary() {
    let thread: &str = &unique_thread("an_extra_attached_folder");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    let primary = repo_outside_tmp("extra-primary");
    let extra = repo_outside_tmp("extra-second");
    std::fs::write(extra.join("notes.md"), b"second folder").unwrap();
    let call = |extras: Option<Vec<String>>| {
        execute_tool(
            df.clone(),
            thread.into(),
            None,
            "read".into(),
            json!({"path": extra.join("notes.md").to_string_lossy()}),
            None,
            None,
            Some(primary.to_string_lossy().to_string()),
            None,
            None,
            None,
            None,
            None,
            extras,
        None,
        None,
        )
    };

    assert!(call(None).await.is_err(), "outside every attached folder");
    let out = call(Some(vec![extra.to_string_lossy().to_string()]))
        .await
        .expect("the extra folder is attached");
    assert!(out.content.contains("second folder"), "{}", out.content);

    let _ = std::fs::remove_dir_all(&primary);
    let _ = std::fs::remove_dir_all(&extra);
}

/// The whole `request_access` round trip at the tool boundary: a read
/// outside the workspace is refused with advice to ask, the user grants
/// the folder, the very same call then succeeds -- and a write there is
/// still refused, because the grant was read-only. Revoking ends it.
#[tokio::test]
async fn a_granted_folder_becomes_readable_for_the_retried_call_only() {
    let thread: &str = &unique_thread("a_granted_folder_becomes_readable");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    let repo = repo_outside_tmp("access");
    std::fs::write(repo.join("notes.md"), b"remember the milk").unwrap();
    let call = |name: &str, args: serde_json::Value| {
        execute_tool(
            df.clone(),
            thread.into(),
            None,
            name.into(),
            args,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        None,
        None,
        )
    };
    let read_args = json!({"path": repo.join("notes.md").to_string_lossy()});

    let refused = call("read", read_args.clone()).await.expect_err("outside the workspace");
    let msg = format!("{refused:?}");
    assert!(msg.contains("Call request_access"), "{msg}");

    let prepared = access_prepare(
        df.clone(),
        thread.into(),
        repo.to_string_lossy().to_string(),
        Some("read".into()),
        Some("read the notes".into()),
        None,
        None,
    )
    .await
    .unwrap();
    let display = match prepared {
        AccessPrepareResult::Ok { prepared } => prepared.display,
        AccessPrepareResult::Refused { message, .. } => panic!("refused: {message}"),
    };
    let grant = access_grant(
        df.clone(),
        thread.into(),
        display,
        Some("read".into()),
        Some("read the notes".into()),
        None,
        None,
        None,
        Some(crate::access::AuditIds {
            run: Some("run-7".into()),
            call: Some("call-7".into()),
            agent: Some("main".into()),
            project: Some(repo.to_string_lossy().to_string()),
        }),
    )
    .await
    .unwrap();
    // The grant's audit record says who asked, like every other decision.
    let granted = crate::audit::read_all(&data)
        .into_iter()
        .find(|r| r.tool == "request_access" && r.decision == crate::audit::Outcome::Granted)
        .expect("the grant was recorded");
    assert_eq!(
        (granted.run.as_str(), granted.call.as_str(), granted.agent.as_str()),
        ("run-7", "call-7", "main")
    );
    assert_eq!(granted.project, repo.to_string_lossy());

    let ok = call("read", read_args.clone()).await.unwrap();
    assert!(!ok.is_error, "{}", ok.content);
    assert!(ok.content.contains("remember the milk"), "{}", ok.content);

    let write = call(
        "write",
        json!({"path": repo.join("evil.txt").to_string_lossy(), "content": "x"}),
    )
    .await;
    assert!(write.is_err(), "a read grant must not allow writes");
    assert!(!repo.join("evil.txt").exists());

    // Another conversation does not inherit a session grant.
    let other_thread: &str = &unique_thread("other-thread");
    let other = execute_tool(
        df.clone(),
        other_thread.into(),
        None,
        "read".into(),
        read_args.clone(),
        None, None, None, None, None, None, None, None,
        None,
        None,
        None,
    )
    .await;
    assert!(other.is_err(), "grant leaked to another session");

    assert!(access_revoke(df.clone(), grant.id));
    assert!(call("read", read_args).await.is_err(), "revoked grant still applied");

    let _ = std::fs::remove_dir_all(&data);
    let _ = std::fs::remove_dir_all(&repo);
}

#[tokio::test]
async fn access_prepare_refuses_the_home_directory_without_prompting() {
    let thread: &str = &unique_thread("access_prepare_refuses_home");
    let data = unique_data_folder();
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap();
    let out = access_prepare(
        data.to_string_lossy().to_string(),
        thread.into(),
        home,
        None,
        Some("look around".into()),
        None,
        None,
    )
    .await
    .unwrap();
    match out {
        AccessPrepareResult::Refused { code, model_result, .. } => {
            assert_eq!(code, "home_directory");
            assert!(model_result.contains("Do not repeat"));
        }
        AccessPrepareResult::Ok { .. } => panic!("the home directory was offered"),
    }
    let _ = std::fs::remove_dir_all(&data);
}

/// Without an attached folder nothing outside the sandbox is readable, so
/// the mount is genuinely opt-in.
#[tokio::test]
async fn without_an_attachment_the_same_read_is_refused() {
    let thread: &str = &unique_thread("without_an_attachment_the_same_read_is_refused");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    let repo = repo_outside_tmp("noattach");
    std::fs::write(repo.join("main.rs"), b"fn main() {}").unwrap();

    let out = execute_tool(
        df.clone(),
        thread.into(),
        None,
        "read".into(),
        json!({"path": repo.join("main.rs").to_string_lossy()}),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await;
    assert!(out.is_err() || out.unwrap().is_error);

    let _ = std::fs::remove_dir_all(&data);
    let _ = std::fs::remove_dir_all(&repo);
}

/// An unusable attachment is an error, never a silent drop: otherwise the
/// agent works against a folder it believes is attached and is not.
#[tokio::test]
async fn an_overlapping_attachment_is_rejected_not_ignored() {
    let thread: &str = &unique_thread("an_overlapping_attachment_is_rejected_not_ignored");
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    let inside = workspace::ensure_thread_workspace(&data, thread)
        .await
        .unwrap()
        .join("nested");
    std::fs::create_dir_all(&inside).unwrap();

    let out = execute_tool(
        df.clone(),
        thread.into(),
        None,
        "ls".into(),
        json!({}),
        None,
        None,
        Some(inside.to_string_lossy().to_string()),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await;
    let err = out.expect_err("a root inside the workspace must be refused");
    assert!(format!("{err:?}").contains("overlaps"), "{err:?}");

    let _ = std::fs::remove_dir_all(&data);
}
// ---- live output streaming ---------------------------------------------

/// The sink builder is exercised directly: a real `Channel` needs a webview,
/// and what matters here is the ordering, correlation and the byte budget.
#[test]
fn the_output_sink_numbers_chunks_and_tags_them_with_the_call() {
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let sink = test_sink(seen.clone(), Some("call-7".into()));

    sink("one".into());
    sink("two".into());

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].0, 0);
    assert_eq!(seen[1].0, 1, "seq is monotonic so a gap is detectable");
    assert_eq!(seen[0].1.as_deref(), Some("call-7"));
    assert_eq!(seen[1].2, "two");
}

/// A `yes`-style command would otherwise flood the webview. The stream stops
/// with one honest marker; the full text still reaches the caller in the
/// tool result.
#[test]
fn the_output_sink_stops_at_the_byte_cap_and_says_so() {
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let sink = test_sink(seen.clone(), None);

    sink("x".repeat(MAX_STREAMED_BYTES + 1));
    sink("more".into());
    sink("even more".into());

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1, "nothing is sent after the cap");
    assert!(seen[0].2.contains("truncated"), "{}", seen[0].2);
}

/// The production `budgeted_sink`, sending into a list instead of a
/// `Channel`, which cannot be constructed outside a webview.
fn test_sink(seen: Seen, call_id: Option<String>) -> crate::tools::OutputSink {
    super::budgeted_sink(call_id, move |chunk| {
        seen.lock().unwrap().push((chunk.seq, chunk.call_id, chunk.text));
        true
    })
}

/// Many threads over the cap at once still send one marker.
#[test]
fn the_truncation_marker_is_sent_once_under_contention() {
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let sink = test_sink(seen.clone(), None);
    sink("x".repeat(MAX_STREAMED_BYTES - 10));
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let sink = sink.clone();
            std::thread::spawn(move || sink("y".repeat(100)))
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    let seen = seen.lock().unwrap();
    let markers = seen.iter().filter(|c| c.2.contains("truncated")).count();
    assert_eq!(markers, 1, "{seen:?}");
}
/// A plain chat (thread scope, no Cowork session, no write grant) reads
/// the folders it attached: the first as `read_only_project`, the rest as
/// `extra_projects`. It cannot write to them, and without them the same
/// read is refused.
#[tokio::test]
async fn a_chat_thread_reads_its_attached_folders_read_only() {
    let data = unique_data_folder();
    let df = data.to_string_lossy().to_string();
    let outside = repo_outside_tmp("attached");
    let a = outside.join("a");
    let b = outside.join("b");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    std::fs::write(a.join("one.txt"), "from a").unwrap();
    std::fs::write(b.join("two.txt"), "from b").unwrap();
    let a_str = a.to_string_lossy().to_string();
    let b_str = b.to_string_lossy().to_string();
    let call = |name: &str, args: serde_json::Value, attached: bool| {
        execute_tool(
            df.clone(),
            "chat-thread".into(),
            None,
            name.into(),
            args,
            None,
            None,
            attached.then(|| a_str.clone()),
            None,
            Some(WorkspaceScope::Thread),
            None,
            None,
            None,
            attached.then(|| vec![b_str.clone()]),
        None,
        None,
        )
    };

    let read_a = json!({"path": a.join("one.txt").to_string_lossy()});
    let out = call("read", read_a.clone(), true).await.expect("read a");
    assert!(!out.is_error, "{}", out.content);
    assert!(out.content.contains("from a"), "{}", out.content);

    let read_b = json!({"path": b.join("two.txt").to_string_lossy()});
    let out = call("read", read_b, true).await.expect("read b");
    assert!(!out.is_error, "{}", out.content);
    assert!(out.content.contains("from b"), "{}", out.content);

    // Read-only: no write grant, so a write there is refused.
    let write = json!({"path": a.join("new.txt").to_string_lossy(), "content": "x"});
    let out = call("write", write, true).await;
    assert!(out.map(|r| r.is_error).unwrap_or(true));
    assert!(!a.join("new.txt").exists());

    // Without the attachment, the same read is refused.
    let out = call("read", read_a, false).await;
    assert!(out.map(|r| r.is_error).unwrap_or(true));

    let _ = std::fs::remove_dir_all(&data);
    let _ = std::fs::remove_dir_all(&outside);
}

/// One request type carries a call from the execute commands into
/// `execute_tool_inner` and into an unsandboxed-retry offer, so the retried
/// call is exactly the one that failed. Only a sandboxed `bash` call keeps one.
#[test]
fn only_a_sandboxed_bash_call_keeps_a_retry_copy() {
    let request = ToolCallRequest {
        data_folder: "data".into(),
        thread_id: "t1".into(),
        project: Some("proj".into()),
        name: "bash".into(),
        args: json!({ "command": "ls" }),
        enabled_skills: None,
        allow_network: Some(false),
        read_only_project: None,
        write_grant: Some("grant-1".into()),
        scope: None,
        call_id: Some("c1".into()),
        undo_run: Some("run-1".into()),
        actor: None,
        extra_projects: Some(vec!["other".into()]),
    };
    let copy = request.retry_copy(false).expect("a sandboxed bash call keeps a copy");
    assert_eq!(copy.thread_id, "t1");
    assert_eq!(copy.args, json!({ "command": "ls" }));
    assert_eq!(copy.write_grant.as_deref(), Some("grant-1"));
    assert_eq!(copy.call_id.as_deref(), Some("c1"));
    assert_eq!(copy.undo_run.as_deref(), Some("run-1"));
    assert_eq!(copy.extra_projects, Some(vec!["other".to_string()]));
    assert!(request.retry_copy(true).is_none(), "an unsandboxed run is not offered again");
    let read = ToolCallRequest { name: "read".into(), ..request };
    assert!(read.retry_copy(false).is_none());
}
