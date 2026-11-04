//! Scenario replays: whole agent runs against real tools, with the model's
//! side scripted from a fixture.
//!
//! A unit test pins one function. A scenario pins what the model is actually
//! shown and what a run leaves behind, which is where a change to the loop, the
//! gate or a tool shows up for a user: each fixture in `scenarios/` is an initial
//! workspace, the model's replies turn by turn, and what must be true after.
//! Only the model is faked; the loop, the permission gate, the tools and the
//! workspace are the real ones.
//!
//! A fixture (JSON):
//! ```text
//! {
//!   "name": "…", "description": "…",
//!   "files": { "a.txt": "old\n" },            // the workspace before the run
//!   "task": "the user's first message",
//!   "model": [                                // one entry per model reply
//!     { "calls": [ { "id": "c1", "name": "read", "args": { "path": "a.txt" } } ] },
//!     { "say": "done" }
//!   ],
//!   "expect": {
//!     "final_text_contains": ["done"],
//!     "requests": 2,                          // how many times the model was asked
//!     "tool_results": [ { "call": "c1", "contains": "old" } ],
//!     "last_request_contains": ["…"],         // anywhere in what the model saw last
//!     "files": { "a.txt": "new\n" },          // the workspace after
//!     "unchanged": ["b.txt"]                  // byte-identical to before
//!   }
//! }
//! ```
//! Add a scenario for any model-visible change to the loop, the gate or a tool;
//! to prove it earns its place, break the change and watch it go red.

use super::tests::{build_invoker_for, unique_project_root};
use super::*;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::Mutex as StdMutex;

/// Every fixture, by file name, compiled in so the test needs no working
/// directory.
const FIXTURES: &[(&str, &str)] = &[
    ("batch_order.json", include_str!("scenarios/batch_order.json")),
    ("repeat_reminder.json", include_str!("scenarios/repeat_reminder.json")),
    ("empty_glob.json", include_str!("scenarios/empty_glob.json")),
    ("apply_patch_multi_file.json", include_str!("scenarios/apply_patch_multi_file.json")),
    ("apply_patch_refused_whole.json", include_str!("scenarios/apply_patch_refused_whole.json")),
];

/// A model that answers from the script and records what it was shown.
struct Scripted {
    replies: StdMutex<VecDeque<Value>>,
    requests: StdMutex<Vec<Value>>,
}

#[async_trait]
impl ModelInvoker for Scripted {
    async fn invoke(
        &self,
        request: &Value,
        _events: &mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<Value, HarnessError> {
        self.requests.lock().unwrap().push(request.clone());
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| HarnessError::from("the scenario's model script ran out of replies".to_string()))
    }
}

/// One scripted reply as the completion the loop reads.
fn completion(turn: &Value) -> Value {
    let calls: Vec<Value> = turn["calls"]
        .as_array()
        .map(|calls| {
            calls
                .iter()
                .map(|c| {
                    json!({
                        "id": c["id"],
                        "type": "function",
                        "function": { "name": c["name"], "arguments": c["args"].to_string() },
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let finish = if calls.is_empty() { "stop" } else { "tool_calls" };
    let mut message = json!({ "content": turn["say"].as_str().unwrap_or("") });
    if !calls.is_empty() {
        message["tool_calls"] = Value::Array(calls);
    }
    json!({ "choices": [{ "message": message, "finish_reason": finish }] })
}

/// Everything the model was shown in a request, as text, for a substring check.
fn shown(request: &Value) -> String {
    request["messages"]
        .as_array()
        .map(|m| m.iter().map(|m| m["content"].to_string()).collect::<Vec<_>>().join("\n"))
        .unwrap_or_default()
}

/// Run one fixture and return what went wrong, empty when it held.
async fn replay(name: &str, fixture: &str) -> Vec<String> {
    let f: Value = serde_json::from_str(fixture).unwrap_or_else(|e| panic!("{name}: not JSON: {e}"));
    let root = unique_project_root();
    let before: std::collections::BTreeMap<String, String> = f["files"]
        .as_object()
        .map(|files| files.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect())
        .unwrap_or_default();
    for (path, text) in &before {
        let full = root.join(path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(full, text).unwrap();
    }

    let (tx, _rx) = mpsc::unbounded_channel();
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let mut invoker = build_invoker_for(
        root.clone(),
        tx.clone(),
        Arc::new(Mutex::new(HashMap::new())),
        tauri_plugin_agent_tools::permissions::ToolPermissions::allow_all(),
        tauri_plugin_agent_tools::subject::Subject::MainAgent,
    );
    invoker.record_to = Some(data);
    invoker.auto_approve = true;
    invoker.sandbox = false;
    invoker.cancel_scope = tauri_plugin_agent_tools::lifecycle::Scope::new("scn", "scn#run-1", "");

    let model = Scripted {
        replies: StdMutex::new(f["model"].as_array().expect("model").iter().map(completion).collect()),
        requests: StdMutex::new(Vec::new()),
    };
    let mut budget = SessionBudget::new(None);
    let result = run_turn_cycle(
        &tx,
        &json!({}),
        "m",
        &[],
        vec![json!({ "role": "user", "content": f["task"] })],
        0,
        &mut budget,
        &model,
        &invoker,
        crate::core::agent::plan::RunMode::Normal,
        None,
        None,
        None,
        None,
    )
    .await;

    let mut problems = Vec::new();
    let expect = &f["expect"];
    let requests = model.requests.lock().unwrap().clone();
    let last = requests.last().cloned().unwrap_or(Value::Null);
    let last_text = shown(&last);
    match &result {
        Ok(done) => {
            let text = done["choices"][0]["message"]["content"].as_str().unwrap_or("");
            for want in expect["final_text_contains"].as_array().into_iter().flatten() {
                let want = want.as_str().unwrap_or("");
                if !text.contains(want) {
                    problems.push(format!("final text {text:?} lacks {want:?}"));
                }
            }
        }
        Err(e) => problems.push(format!("the run failed: {e}")),
    }
    if let Some(n) = expect["requests"].as_u64() {
        if requests.len() as u64 != n {
            problems.push(format!("the model was asked {} times, expected {n}", requests.len()));
        }
    }
    for want in expect["tool_results"].as_array().into_iter().flatten() {
        let (call, contains) = (want["call"].as_str().unwrap_or(""), want["contains"].as_str().unwrap_or(""));
        let result_text = last["messages"]
            .as_array()
            .and_then(|m| m.iter().find(|m| m["role"] == "tool" && m["tool_call_id"] == call))
            .map(|m| m["content"].to_string())
            .unwrap_or_default();
        if !result_text.contains(contains) {
            problems.push(format!("the result of {call} was {result_text:?}, expected it to contain {contains:?}"));
        }
    }
    for want in expect["last_request_contains"].as_array().into_iter().flatten() {
        let want = want.as_str().unwrap_or("");
        if !last_text.contains(want) {
            problems.push(format!("the model's last request lacks {want:?}"));
        }
    }
    for (path, want) in expect["files"].as_object().into_iter().flatten() {
        let got = std::fs::read_to_string(root.join(path)).unwrap_or_else(|_| "<missing>".into());
        let want = want.as_str().unwrap_or("");
        if got.replace("\r\n", "\n") != want {
            problems.push(format!("{path} is {got:?}, expected {want:?}"));
        }
    }
    for path in expect["unchanged"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        let got = std::fs::read_to_string(root.join(path)).ok();
        if got.as_deref() != before.get(path).map(String::as_str) {
            problems.push(format!("{path} changed, and the scenario says it must not"));
        }
    }
    let _ = std::fs::remove_dir_all(&root);
    problems.into_iter().map(|p| format!("{name}: {p}")).collect()
}

#[tokio::test]
async fn every_scenario_holds() {
    let mut problems = Vec::new();
    for (name, fixture) in FIXTURES {
        problems.extend(replay(name, fixture).await);
    }
    assert!(problems.is_empty(), "\n{}", problems.join("\n"));
}
