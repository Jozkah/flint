//! The loop's handling of scoped, deferred and void approvals, end to end
//! through the real dispatcher: what a saved rule answers and what it never
//! can, what "Always" with a scope keeps, and the whole defer / answer / resume
//! cycle -- including every way a deferred answer must be refused.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri_plugin_agent_tools::deferred_approvals as deferred;
use tauri_plugin_agent_tools::scoped_rules::{self as rules, ApprovalScope};
use tauri_plugin_agent_tools::tools::lookup;

use std::sync::Mutex as StdMutex;
use tauri_plugin_agent_tools::permissions::{PermissionDefault, ToolPermissions};

use super::tests::{build_invoker_for, build_prompting_invoker, respond_once, unique_project_root};
use super::*;
use crate::core::agent::approval_flow as flow;

fn write_to(id: &str, path: &str, content: &str) -> Value {
    json!({
        "id": id,
        "type": "function",
        "function": {
            "name": "write",
            "arguments": json!({ "path": path, "content": content }).to_string(),
        }
    })
}

fn fresh_data() -> std::path::PathBuf {
    let dir = unique_project_root().with_extension("data");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn folder(root: &std::path::Path, rel: &str) -> ApprovalScope {
    ApprovalScope::Folder { dir: root.join(rel).to_string_lossy().into_owned() }
}

/// Never wait forever on a prompt that a regression would leave unanswered.
async fn invoke_within(
    invoker: &CompositeToolInvoker,
    calls: &[Value],
) -> Vec<ToolOutcome> {
    tokio::time::timeout(std::time::Duration::from_secs(10), invoker.invoke(calls))
        .await
        .expect("the call hung on a prompt nobody answers")
        .unwrap()
}

fn prompts(rx: &mut mpsc::UnboundedReceiver<StreamEvent>) -> usize {
    let mut n = 0;
    while let Ok(event) = rx.try_recv() {
        if matches!(event, StreamEvent::PermissionRequest { .. }) {
            n += 1;
        }
    }
    n
}

/// Answer the next prompt with `decision`, after recording the form's `scope`.
async fn answer_next(
    rx: &mut mpsc::UnboundedReceiver<StreamEvent>,
    registry: &PermissionRegistry,
    decision: PermissionDecision,
    scope: Option<ApprovalScope>,
) {
    loop {
        match rx.recv().await {
            Some(StreamEvent::PermissionRequest { request_id, .. }) => {
                if let Some(scope) = scope {
                    flow::record_scope_choice(&request_id, scope);
                }
                if let Some(tx) = registry.lock().await.remove(&request_id) {
                    let _ = tx.send(decision);
                }
                return;
            }
            Some(_) => continue,
            None => return,
        }
    }
}

fn setup() -> (
    std::path::PathBuf,
    std::path::PathBuf,
    CompositeToolInvoker,
    mpsc::UnboundedReceiver<StreamEvent>,
    PermissionRegistry,
) {
    let root = unique_project_root();
    let data = fresh_data();
    std::fs::create_dir_all(root.join("src")).unwrap();
    let (tx, rx) = mpsc::unbounded_channel();
    let registry: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
    let mut invoker = build_prompting_invoker(root.clone(), tx, registry.clone());
    invoker.record_to = Some(data.clone());
    (root, data, invoker, rx, registry)
}

fn save_folder_rule(data: &std::path::Path, root: &std::path::Path, rel: &str, sample: &str) {
    rules::add(
        data,
        root,
        lookup("write").unwrap(),
        tauri_plugin_agent_tools::tools::gate::PromptKind::Write,
        &json!({ "path": sample, "content": "x" }),
        &folder(root, rel),
    )
    .unwrap();
}

// -- scoped rules ---------------------------------------------------------------

#[tokio::test]
async fn a_saved_folder_rule_answers_the_prompt_for_a_call_inside_it() {
    let (root, data, invoker, mut rx, registry) = setup();
    save_folder_rule(&data, &root, "src", "src/a.txt");

    let out = invoke_within(&invoker, &[write_to("c1", "src/a.txt", "hi")]).await;
    assert!(!out[0].content.starts_with("ERROR"), "{}", out[0].content);
    assert_eq!(std::fs::read_to_string(root.join("src/a.txt")).unwrap(), "hi");
    assert_eq!(prompts(&mut rx), 0, "a covered call raises no prompt");

    // The neighbour that shares a name prefix is still asked about.
    std::fs::create_dir_all(root.join("src-backup")).unwrap();
    let asked = tokio::spawn({
        let registry = registry.clone();
        async move {
            answer_next(&mut rx, &registry, PermissionDecision::Deny, None).await;
            rx
        }
    });
    let out = invoke_within(&invoker, &[write_to("c2", "src-backup/a.txt", "no")]).await;
    assert!(out[0].content.contains("denied by user"), "{}", out[0].content);
    assert!(!root.join("src-backup/a.txt").exists());
    let _ = asked.await;
}

#[tokio::test]
async fn a_saved_rule_never_overrides_a_policy_deny() {
    let root = unique_project_root();
    let data = fresh_data();
    std::fs::create_dir_all(root.join("src/locked")).unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let registry: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
    let mut invoker = build_invoker_for(
        root.clone(),
        tx,
        registry,
        ToolPermissions::new(PermissionDefault::ReadOnly, &[], &["write(src/locked/**)".to_string()], &[]),
        tauri_plugin_agent_tools::subject::Subject::MainAgent,
    );
    invoker.record_to = Some(data.clone());
    save_folder_rule(&data, &root, "src", "src/a.txt");

    let out = invoke_within(&invoker, &[write_to("c1", "src/locked/a.txt", "x")]).await;
    assert!(out[0].content.starts_with("ERROR"), "{}", out[0].content);
    assert!(out[0].content.contains("denied"), "{}", out[0].content);
    assert!(!root.join("src/locked/a.txt").exists());
    assert_eq!(prompts(&mut rx), 0);
}

#[tokio::test]
async fn a_saved_rule_never_overrides_a_tool_rule() {
    let (root, data, mut invoker, mut rx, _registry) = setup();
    save_folder_rule(&data, &root, "src", "src/a.txt");
    invoker.tool_rules = vec![crate::core::agent::tool_rules::ToolRuleSpec {
        tool: "write".into(),
        after: Some("read".into()),
        reason: Some("Read the file before writing it.".into()),
        ..Default::default()
    }];
    let out = invoke_within(&invoker, &[write_to("c1", "src/a.txt", "x")]).await;
    assert!(out[0].content.contains("Read the file before writing it."), "{}", out[0].content);
    assert!(!root.join("src/a.txt").exists());
    assert_eq!(prompts(&mut rx), 0);
}

#[tokio::test]
async fn a_saved_prefix_rule_covers_that_command_and_not_a_chained_one() {
    let (root, data, invoker, mut rx, registry) = setup();
    rules::add(
        &data,
        &root,
        lookup("bash").unwrap(),
        tauri_plugin_agent_tools::tools::gate::PromptKind::Exec,
        &json!({ "command": "echo hello" }),
        &ApprovalScope::CommandPrefix { prefix: "echo".into() },
    )
    .unwrap();
    let bash = |id: &str, command: &str| {
        json!({ "id": id, "type": "function", "function": { "name": "bash", "arguments": json!({ "command": command }).to_string() } })
    };
    // The sandbox may or may not run it on this machine; what matters is that
    // it was not put to anyone.
    let out = invoke_within(&invoker, &[bash("b1", "echo hello")]).await;
    assert!(!out[0].content.contains("denied by user"), "{}", out[0].content);
    assert_eq!(prompts(&mut rx), 0);

    let asked = tokio::spawn({
        let registry = registry.clone();
        async move {
            answer_next(&mut rx, &registry, PermissionDecision::Deny, None).await;
            rx
        }
    });
    let out = invoke_within(&invoker, &[bash("b2", "echo hello && echo again")]).await;
    assert!(out[0].content.contains("denied by user"), "{}", out[0].content);
    let _ = asked.await;
}

#[tokio::test]
async fn always_with_a_folder_saves_a_rule_and_grants_nothing_broader() {
    let (root, data, invoker, mut rx, registry) = setup();
    let first = tokio::spawn({
        let registry = registry.clone();
        let scope = folder(&root, "src");
        async move {
            answer_next(&mut rx, &registry, PermissionDecision::AllowAlways, Some(scope)).await;
            rx
        }
    });
    let out = invoke_within(&invoker, &[write_to("c1", "src/a.txt", "one")]).await;
    assert!(!out[0].content.starts_with("ERROR"), "{}", out[0].content);
    let mut rx = first.await.unwrap();

    let saved = rules::list(&data, Some(&root));
    assert_eq!(saved.len(), 1, "{saved:?}");
    assert_eq!(saved[0].tool, "write");

    // Inside the folder: no prompt.
    let out = invoke_within(&invoker, &[write_to("c2", "src/b.txt", "two")]).await;
    assert!(!out[0].content.starts_with("ERROR"), "{}", out[0].content);
    assert_eq!(prompts(&mut rx), 0);

    // Outside it: asked again -- the answer did not become a run-long grant.
    let second = tokio::spawn({
        let registry = registry.clone();
        async move {
            answer_next(&mut rx, &registry, PermissionDecision::Deny, None).await;
            rx
        }
    });
    let out = invoke_within(&invoker, &[write_to("c3", "other.txt", "three")]).await;
    assert!(out[0].content.contains("denied by user"), "{}", out[0].content);
    assert!(!root.join("other.txt").exists());
    let _ = second.await;
}

#[tokio::test]
async fn always_with_a_folder_that_does_not_cover_the_call_saves_nothing() {
    let (root, data, invoker, mut rx, registry) = setup();
    std::fs::create_dir_all(root.join("elsewhere")).unwrap();
    let first = tokio::spawn({
        let registry = registry.clone();
        let wrong = folder(&root, "elsewhere");
        async move {
            answer_next(&mut rx, &registry, PermissionDecision::AllowAlways, Some(wrong)).await;
            rx
        }
    });
    let out = invoke_within(&invoker, &[write_to("c1", "src/a.txt", "one")]).await;
    // This call was allowed -- the person said yes to it -- but only this one.
    assert!(!out[0].content.starts_with("ERROR"), "{}", out[0].content);
    let mut rx = first.await.unwrap();
    assert!(rules::list(&data, None).is_empty(), "a folder that does not hold the call is not a rule");

    let second = tokio::spawn({
        let registry = registry.clone();
        async move {
            answer_next(&mut rx, &registry, PermissionDecision::Deny, None).await;
            rx
        }
    });
    let out = invoke_within(&invoker, &[write_to("c2", "src/b.txt", "two")]).await;
    assert!(out[0].content.contains("denied by user"), "the first answer must not have become a grant: {}", out[0].content);
    let _ = second.await;
}

#[tokio::test]
async fn always_with_once_picked_grants_nothing() {
    let (root, data, invoker, mut rx, registry) = setup();
    let first = tokio::spawn({
        let registry = registry.clone();
        async move {
            answer_next(&mut rx, &registry, PermissionDecision::AllowAlways, Some(ApprovalScope::Once)).await;
            rx
        }
    });
    invoke_within(&invoker, &[write_to("c1", "src/a.txt", "one")]).await;
    let mut rx = first.await.unwrap();
    assert!(rules::list(&data, None).is_empty());
    let second = tokio::spawn({
        let registry = registry.clone();
        async move {
            answer_next(&mut rx, &registry, PermissionDecision::Deny, None).await;
            rx
        }
    });
    let out = invoke_within(&invoker, &[write_to("c2", "src/b.txt", "two")]).await;
    assert!(out[0].content.contains("denied by user"), "{}", out[0].content);
    let _ = second.await;
    let _ = root;
}

#[tokio::test]
async fn always_without_a_form_keeps_its_run_long_meaning() {
    let (root, data, invoker, mut rx, registry) = setup();
    let first = tokio::spawn({
        let registry = registry.clone();
        async move {
            answer_next(&mut rx, &registry, PermissionDecision::AllowAlways, None).await;
            rx
        }
    });
    invoke_within(&invoker, &[write_to("c1", "src/a.txt", "one")]).await;
    let mut rx = first.await.unwrap();
    assert!(rules::list(&data, None).is_empty(), "nothing is persisted without a scope");
    let out = invoke_within(&invoker, &[write_to("c2", "other.txt", "two")]).await;
    assert!(!out[0].content.starts_with("ERROR"), "{}", out[0].content);
    assert_eq!(prompts(&mut rx), 0);
    let _ = root;
}

// -- deferred approvals -----------------------------------------------------------

fn deferring() -> (
    std::path::PathBuf,
    std::path::PathBuf,
    CompositeToolInvoker,
    mpsc::UnboundedReceiver<StreamEvent>,
    PermissionRegistry,
) {
    let (root, data, mut invoker, rx, registry) = setup();
    invoker.approvals = flow::Runtime::from_section(&flow::ApprovalsSection {
        defer: true,
        defer_ttl_hours: Some(1),
    });
    invoker.cancel_scope = tauri_plugin_agent_tools::lifecycle::Scope::new("sess-1", "run-1", "");
    (root, data, invoker, rx, registry)
}

/// A run with a terminal can prompt, which these tests are not about.
fn has_a_terminal() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal()
}

fn pending_id(data: &std::path::Path) -> String {
    let all = deferred::list(data, None, false);
    assert_eq!(all.len(), 1, "{all:?}");
    all[0].id.clone()
}

#[tokio::test]
async fn an_unattended_prompt_is_deferred_not_denied_and_the_call_does_not_run() {
    if has_a_terminal() {
        return;
    }
    let (root, data, invoker, mut rx, _registry) = deferring();
    let out = invoke_within(&invoker, &[write_to("c1", "other.txt", "hello")]).await;
    assert!(out[0].content.contains(flow::DEFERRED_MARK), "{}", out[0].content);
    assert!(!root.join("other.txt").exists());
    assert_eq!(prompts(&mut rx), 0, "nobody was asked");
    let id = pending_id(&data);
    assert_eq!(invoker.approval_deferred(), vec![id.clone()]);
    let record = &deferred::list(&data, None, false)[0];
    assert_eq!(record.session, "sess-1");
    assert_eq!(record.tool, "write");
    assert_eq!(record.status, deferred::DeferStatus::Pending);
    assert!(record.summary.contains("other.txt"), "{}", record.summary);
}

#[tokio::test]
async fn proposing_the_call_again_before_an_answer_is_still_refused_and_adds_no_second_record() {
    if has_a_terminal() {
        return;
    }
    let (root, data, invoker, _rx, _registry) = deferring();
    invoke_within(&invoker, &[write_to("c1", "other.txt", "hello")]).await;
    let out = invoke_within(&invoker, &[write_to("c2", "other.txt", "hello")]).await;
    assert!(out[0].content.contains("has not been answered yet"), "{}", out[0].content);
    assert!(!root.join("other.txt").exists());
    assert_eq!(deferred::list(&data, None, true).len(), 1);
}

#[tokio::test]
async fn an_allow_given_later_runs_the_same_call_once() {
    if has_a_terminal() {
        return;
    }
    let (root, data, invoker, mut rx, _registry) = deferring();
    invoke_within(&invoker, &[write_to("c1", "other.txt", "hello")]).await;
    let id = pending_id(&data);
    deferred::answer(&data, &id, true).unwrap();

    // The resumed run proposes the same call: the answer is applied.
    let out = invoke_within(&invoker, &[write_to("c2", "other.txt", "hello")]).await;
    assert!(!out[0].content.starts_with("ERROR"), "{}", out[0].content);
    assert_eq!(std::fs::read_to_string(root.join("other.txt")).unwrap(), "hello");
    assert_eq!(prompts(&mut rx), 0);

    // ... once: the same call a third time is put off again.
    std::fs::remove_file(root.join("other.txt")).unwrap();
    let out = invoke_within(&invoker, &[write_to("c3", "other.txt", "hello")]).await;
    assert!(out[0].content.contains(flow::DEFERRED_MARK), "{}", out[0].content);
    assert!(!root.join("other.txt").exists());
}

#[tokio::test]
async fn an_allow_does_not_cover_different_arguments() {
    if has_a_terminal() {
        return;
    }
    let (root, data, invoker, _rx, _registry) = deferring();
    invoke_within(&invoker, &[write_to("c1", "other.txt", "what was asked")]).await;
    deferred::answer(&data, &pending_id(&data), true).unwrap();

    // The resumed run changes the content: that is not what was approved.
    let out = invoke_within(&invoker, &[write_to("c2", "other.txt", "something else")]).await;
    assert!(out[0].content.contains(flow::DEFERRED_MARK), "{}", out[0].content);
    assert!(!root.join("other.txt").exists());
    // Nor another path.
    let out = invoke_within(&invoker, &[write_to("c3", "third.txt", "what was asked")]).await;
    assert!(out[0].content.contains(flow::DEFERRED_MARK), "{}", out[0].content);
    assert!(!root.join("third.txt").exists());
}

#[tokio::test]
async fn a_denial_given_later_is_told_to_the_model_and_nothing_runs() {
    if has_a_terminal() {
        return;
    }
    let (root, data, invoker, _rx, _registry) = deferring();
    invoke_within(&invoker, &[write_to("c1", "other.txt", "hello")]).await;
    deferred::answer(&data, &pending_id(&data), false).unwrap();
    let out = invoke_within(&invoker, &[write_to("c2", "other.txt", "hello")]).await;
    assert!(out[0].content.contains("denied by user"), "{}", out[0].content);
    assert!(!root.join("other.txt").exists());
}

#[tokio::test]
async fn an_expired_answer_refuses_and_never_approves() {
    if has_a_terminal() {
        return;
    }
    let (root, data, invoker, _rx, _registry) = deferring();
    // A question asked and allowed long ago, with a short window.
    let args = json!({ "path": "other.txt", "content": "hello" });
    let digest = approval_digest("write", &args);
    let old = deferred::defer_at(
        &data,
        deferred::NewDeferred {
            project_root: &root,
            session: "sess-1",
            tool: "write",
            kind: "write",
            summary: "write: other.txt",
            args_digest: &digest,
        },
        60,
        1_000,
    )
    .unwrap();
    deferred::answer_at(&data, &old.id, true, 1_010).unwrap();

    let out = invoke_within(&invoker, &[write_to("c1", "other.txt", "hello")]).await;
    assert!(out[0].content.contains("answer window"), "{}", out[0].content);
    assert!(!root.join("other.txt").exists(), "an expired allow must not run");
    // The expiry was told once; the call can now be asked about afresh.
    let out = invoke_within(&invoker, &[write_to("c2", "other.txt", "hello")]).await;
    assert!(out[0].content.contains(flow::DEFERRED_MARK), "{}", out[0].content);
    assert!(!root.join("other.txt").exists());
}

#[tokio::test]
async fn an_answer_for_another_session_or_project_is_not_applied() {
    if has_a_terminal() {
        return;
    }
    let (root, data, invoker, _rx, _registry) = deferring();
    invoke_within(&invoker, &[write_to("c1", "other.txt", "hello")]).await;
    deferred::answer(&data, &pending_id(&data), true).unwrap();

    // Same data folder, another session resumes: not its answer.
    let mut other = {
        let (tx, _rx2) = mpsc::unbounded_channel();
        let registry: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
        build_prompting_invoker(root.clone(), tx, registry)
    };
    other.record_to = Some(data.clone());
    other.approvals = flow::Runtime::from_section(&flow::ApprovalsSection { defer: true, defer_ttl_hours: Some(1) });
    other.cancel_scope = tauri_plugin_agent_tools::lifecycle::Scope::new("sess-2", "run-2", "");
    let out = invoke_within(&other, &[write_to("c2", "other.txt", "hello")]).await;
    assert!(out[0].content.contains(flow::DEFERRED_MARK), "{}", out[0].content);
    assert!(!root.join("other.txt").exists());
}

#[tokio::test]
async fn a_restore_voids_an_unspent_answer() {
    if has_a_terminal() {
        return;
    }
    let (root, data, invoker, _rx, _registry) = deferring();
    invoke_within(&invoker, &[write_to("c1", "other.txt", "hello")]).await;
    deferred::answer(&data, &pending_id(&data), true).unwrap();
    deferred::record_restore(&data, "sess-1").unwrap();
    let out = invoke_within(&invoker, &[write_to("c2", "other.txt", "hello")]).await;
    assert!(out[0].content.contains(flow::DEFERRED_MARK), "asked afresh, not run: {}", out[0].content);
    assert!(!root.join("other.txt").exists());
}

#[tokio::test]
async fn without_a_session_or_data_folder_the_old_behavior_is_kept() {
    if has_a_terminal() {
        return;
    }
    // No session id to resume: the call is denied as it always was, not lost
    // into a record nobody can resume.
    let (root, data, mut invoker, mut rx, registry) = deferring();
    invoker.cancel_scope = tauri_plugin_agent_tools::lifecycle::Scope::default();
    let denier = tokio::spawn({
        let registry = registry.clone();
        async move {
            answer_next(&mut rx, &registry, PermissionDecision::Deny, None).await;
            rx
        }
    });
    let out = invoke_within(&invoker, &[write_to("c1", "other.txt", "hello")]).await;
    assert!(out[0].content.contains("denied by user"), "{}", out[0].content);
    assert!(deferred::list(&data, None, true).is_empty());
    assert!(!root.join("other.txt").exists());
    let _ = denier.await;
}

#[tokio::test]
async fn answer_later_on_a_live_prompt_defers_the_call() {
    let (root, data, mut invoker, mut rx, registry) = setup();
    invoker.cancel_scope = tauri_plugin_agent_tools::lifecycle::Scope::new("sess-1", "run-1", "");
    // Someone is attached: the prompt is raised.
    invoker.ask_requests = Some(crate::core::agent::interaction::new_registry());
    let later = tokio::spawn({
        let registry = registry.clone();
        async move {
            loop {
                match rx.recv().await {
                    Some(StreamEvent::PermissionRequest { request_id, .. }) => {
                        flow::mark_defer(&request_id);
                        if let Some(tx) = registry.lock().await.remove(&request_id) {
                            let _ = tx.send(PermissionDecision::Deny);
                        }
                        return;
                    }
                    Some(_) => continue,
                    None => return,
                }
            }
        }
    });
    let out = invoke_within(&invoker, &[write_to("c1", "other.txt", "hello")]).await;
    let _ = later.await;
    assert!(out[0].content.contains(flow::DEFERRED_MARK), "{}", out[0].content);
    assert!(!root.join("other.txt").exists());
    assert_eq!(deferred::list(&data, None, false).len(), 1);
    assert_eq!(invoker.approval_deferred().len(), 1);
}

#[tokio::test]
async fn a_plain_denial_is_not_deferred() {
    let (root, data, mut invoker, mut rx, registry) = setup();
    invoker.cancel_scope = tauri_plugin_agent_tools::lifecycle::Scope::new("sess-1", "run-1", "");
    invoker.ask_requests = Some(crate::core::agent::interaction::new_registry());
    let denier = tokio::spawn({
        let registry = registry.clone();
        async move {
            respond_once(&mut rx, &registry, PermissionDecision::Deny).await;
        }
    });
    let out = invoke_within(&invoker, &[write_to("c1", "other.txt", "hello")]).await;
    let _ = denier.await;
    assert!(out[0].content.contains("denied by user"), "{}", out[0].content);
    assert!(deferred::list(&data, None, true).is_empty());
    assert!(invoker.approval_deferred().is_empty());
    assert!(!root.join("other.txt").exists());
}

// -- the run ends when a call is deferred ---------------------------------------------

struct Scripted {
    responses: StdMutex<std::collections::VecDeque<Value>>,
    requests: StdMutex<usize>,
}

#[async_trait]
impl ModelInvoker for Scripted {
    async fn invoke(
        &self,
        _request: &Value,
        _events: &mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<Value, HarnessError> {
        *self.requests.lock().unwrap() += 1;
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| "script exhausted".to_string().into())
    }
}

struct DefersOnFirstCall {
    deferred: StdMutex<Vec<String>>,
}

#[async_trait]
impl ToolInvoker for DefersOnFirstCall {
    async fn invoke(&self, calls: &[Value]) -> Result<Vec<ToolOutcome>, HarnessError> {
        self.deferred.lock().unwrap().push("defer-1".into());
        Ok(calls
            .iter()
            .map(|c| {
                ToolOutcome::plain(
                    c["id"].as_str().unwrap_or_default().to_string(),
                    flow::deferred_text("write", "defer-1", "write: a.txt"),
                )
            })
            .collect())
    }
    fn approval_deferred(&self) -> Vec<String> {
        self.deferred.lock().unwrap().clone()
    }
}

#[tokio::test]
async fn a_run_with_a_deferred_call_ends_there_and_says_what_it_waits_for() {
    let tool_turn = json!({
        "choices": [{
            "message": {
                "content": null,
                "tool_calls": [{ "id": "c1", "type": "function",
                    "function": { "name": "write", "arguments": "{\"path\":\"a.txt\",\"content\":\"x\"}" } }]
            },
            "finish_reason": "tool_calls"
        }]
    });
    let never = json!({ "choices": [{ "message": { "content": "never sent" }, "finish_reason": "stop" }] });
    let model = Scripted {
        responses: StdMutex::new(vec![tool_turn, never].into()),
        requests: StdMutex::new(0),
    };
    let (events, _rx) = mpsc::unbounded_channel();
    let mut budget = SessionBudget::new(None);
    let result = run_turn_cycle(
        &events,
        &json!({}),
        "m",
        &[],
        vec![json!({ "role": "user", "content": "go" })],
        0,
        &mut budget,
        &model,
        &DefersOnFirstCall { deferred: StdMutex::new(Vec::new()) },
        crate::core::agent::plan::RunMode::Normal,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("waiting for an answer is not a failure");
    assert_eq!(result["choices"][0]["finish_reason"], json!("awaiting_approval"));
    assert!(result["choices"][0]["message"].get("tool_calls").is_none(), "{result}");
    let said = result["choices"][0]["message"]["content"].as_str().unwrap();
    assert!(said.contains("defer-1") && said.contains("flint cli approvals"), "{said}");
    assert_eq!(*model.requests.lock().unwrap(), 1, "no request after the call was put off");
}
