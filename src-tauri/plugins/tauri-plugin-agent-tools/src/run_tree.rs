//! What a run started, as a tree. AH-173.
//!
//! A run is not one thing: it dispatches children, children dispatch tools,
//! tools start processes that outlive the call that started them. Each of those
//! is recorded -- the canonical log holds runs, dispatches and tool calls, and
//! `job_record` holds background jobs -- but nothing put them together, so
//! "what is this run actually running?" could only be answered by reading three
//! things and joining them by eye.
//!
//! This joins them. The tree is built from what was recorded, never from the
//! operating system's process list: a process table cannot say which run asked
//! for something, and adopting one by pid is exactly the mistake `job_record`
//! exists to avoid. What is shown is therefore what this harness started and
//! can account for, and nothing else on the machine.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::harness_error::{ErrorKind, HarnessError, Stage};

/// What a node is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NodeKind {
    /// A run: a turn, or a child run a run dispatched.
    Run,
    /// A tool call the run made.
    Tool,
    /// A background job a tool started.
    Job,
}

/// One thing a run started.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub kind: NodeKind,
    /// The run id, tool call id or job id.
    pub id: String,
    /// What to call it: the model, the tool's name, the job's command.
    pub label: String,
    /// `running`, `done`, `error`, `cancelled`, `interrupted`, `refused`...
    /// Taken from the record rather than decided here.
    pub state: String,
    /// The request that asked for it, when one did.
    #[serde(default)]
    pub invocation: String,
    #[serde(default)]
    pub children: Vec<Node>,
}

impl Node {
    /// Everything under this node, including itself.
    pub fn count(&self) -> usize {
        1 + self.children.iter().map(Node::count).sum::<usize>()
    }

    /// How deep this goes.
    pub fn depth(&self) -> usize {
        1 + self.children.iter().map(Node::depth).max().unwrap_or(0)
    }
}

fn text(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// The tree of what one session's runs started.
///
/// Built from the session's own record, so a session id that names nothing is
/// a typed refusal rather than an empty tree that looks like a quiet run.
pub fn of_session(data_folder: &Path, session: &str) -> Result<Vec<Node>, HarnessError> {
    if session.trim().is_empty() {
        return Err(HarnessError::new(
            ErrorKind::InvalidInput,
            "a run tree belongs to one session, which must be named",
        )
        .at(Stage::Context));
    }
    let events = crate::event_log::read_session(data_folder, session)
        .map_err(|e| HarnessError::new(ErrorKind::MalformedState, e.message()).at(Stage::Persistence))?;
    if events.is_empty() {
        return Err(HarnessError::new(
            ErrorKind::NotFound,
            format!("session {session:?} has no record to build a tree from"),
        )
        .at(Stage::Context));
    }

    // Runs first, in the order they started, with what each one is.
    let mut runs: Vec<(String, Node, String)> = Vec::new(); // (run, node, parent run)
    for event in &events {
        match event.kind.as_str() {
            "run.started" => {
                if runs.iter().any(|(id, _, _)| *id == event.run) {
                    continue;
                }
                let model = text(event.payload.get("model"));
                let source = text(event.payload.get("source"));
                let label = match (model.is_empty(), source.is_empty()) {
                    (false, false) => format!("{model} ({source})"),
                    (false, true) => model,
                    (true, false) => source,
                    (true, true) => "run".to_string(),
                };
                runs.push((
                    event.run.clone(),
                    Node {
                        kind: NodeKind::Run,
                        id: event.run.clone(),
                        label,
                        state: "running".to_string(),
                        invocation: String::new(),
                        children: Vec::new(),
                    },
                    text(event.payload.get("parentRun")),
                ));
            }
            "run.ended" => {
                if let Some((_, node, _)) = runs.iter_mut().find(|(id, _, _)| *id == event.run) {
                    let stopped = text(event.payload.get("stoppedBy"));
                    node.state = if stopped.is_empty() { "ended".into() } else { stopped };
                }
            }
            _ => {}
        }
    }

    // Then each run's tool calls, folded by call id so a call's phases are one
    // node whose state is its last phase.
    for event in &events {
        let Some(phase) = event.kind.strip_prefix("tool.") else {
            continue;
        };
        let call = text(event.payload.get("call"));
        let tool = text(event.payload.get("tool"));
        let Some((_, run, _)) = runs.iter_mut().find(|(id, _, _)| *id == event.run) else {
            continue;
        };
        let id = if call.is_empty() { event.id.clone() } else { call };
        match run.children.iter_mut().find(|c| c.id == id) {
            Some(existing) => existing.state = phase.to_string(),
            None => run.children.push(Node {
                kind: NodeKind::Tool,
                id,
                label: if tool.is_empty() { "tool".into() } else { tool },
                state: phase.to_string(),
                invocation: event.invocation.clone(),
                children: Vec::new(),
            }),
        }
    }

    // Then the background jobs this session started, under the tool call that
    // started them when the record says which, and under their run otherwise.
    for job in crate::job_record::read_owner(data_folder, session) {
        let node = Node {
            kind: NodeKind::Job,
            id: job.id.clone(),
            label: job.summary.clone(),
            state: job.state.tag().to_string(),
            invocation: job.invocation.clone(),
            children: Vec::new(),
        };
        match runs.iter_mut().find(|(id, _, _)| *id == job.run) {
            Some((_, run, _)) => run.children.push(node),
            // A job whose run is not in this log still belongs to the session:
            // showing it under nothing is better than not showing it.
            None => runs.push((job.id.clone(), node, String::new())),
        }
    }

    // Finally, hang each child run under the run that dispatched it.
    let mut roots: Vec<Node> = Vec::new();
    let ordered: Vec<(String, Node, String)> = runs;
    let mut by_id: std::collections::BTreeMap<String, Node> = std::collections::BTreeMap::new();
    let mut parents: Vec<(String, String)> = Vec::new();
    let mut order: Vec<String> = Vec::new();
    for (id, node, parent) in ordered {
        order.push(id.clone());
        parents.push((id.clone(), parent));
        by_id.insert(id, node);
    }
    // Deepest first, so a child is complete before it is moved into its parent.
    for (id, parent) in parents.iter().rev() {
        if parent.is_empty() || !by_id.contains_key(parent) || parent == id {
            continue;
        }
        if let Some(child) = by_id.remove(id) {
            if let Some(node) = by_id.get_mut(parent) {
                node.children.push(child);
            } else {
                by_id.insert(id.clone(), child);
            }
        }
    }
    for id in order {
        if let Some(node) = by_id.remove(&id) {
            roots.push(node);
        }
    }
    Ok(roots)
}

/// The tree as lines a person reads.
pub fn render(roots: &[Node]) -> String {
    fn walk(node: &Node, depth: usize, out: &mut String) {
        let indent = "  ".repeat(depth);
        let marker = match node.kind {
            NodeKind::Run => "run",
            NodeKind::Tool => "tool",
            NodeKind::Job => "job",
        };
        out.push_str(&format!(
            "{indent}{marker} {} [{}]{}\n",
            node.label,
            node.state,
            if node.invocation.is_empty() {
                String::new()
            } else {
                format!(" ({})", node.invocation)
            }
        ));
        for child in &node.children {
            walk(child, depth + 1, out);
        }
    }
    let mut out = String::new();
    for root in roots {
        walk(root, 0, &mut out);
    }
    if out.is_empty() {
        out.push_str("This session started nothing.\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_log::{append, NewEvent};
    use serde_json::json;

    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jan-tree-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn ev(d: &std::path::Path, session: &str, run: &str, inv: &str, kind: &str, id: &str, payload: serde_json::Value) {
        append(
            d,
            NewEvent {
                id: id.into(),
                session: session.into(),
                run: run.into(),
                invocation: inv.into(),
                kind: kind.into(),
                payload,
            },
        )
        .expect("recorded");
    }

    /// A run, the tools it called, the child it dispatched and the job it left
    /// behind, in one tree -- each under whatever started it.
    #[test]
    fn a_run_shows_what_it_started() {
        let d = dir("tree");
        let s = "tree-session";
        ev(&d, s, "run-1", "", "run.started", "r1s", json!({ "model": "m", "source": "agent-loop" }));
        ev(&d, s, "run-1", "run-1#1", "tool.requested", "t1a", json!({ "call": "call_0", "tool": "ls" }));
        ev(&d, s, "run-1", "run-1#1", "tool.succeeded", "t1b", json!({ "call": "call_0", "tool": "ls" }));
        ev(&d, s, "run-1", "run-1#1", "tool.requested", "t2a", json!({ "call": "call_1", "tool": "bash" }));
        ev(&d, s, "run-1", "run-1#1", "tool.failed", "t2b", json!({ "call": "call_1", "tool": "bash" }));
        // A child run of run-1.
        ev(&d, s, "run-2", "", "run.started", "r2s", json!({ "model": "m", "source": "agent-loop", "parentRun": "run-1" }));
        ev(&d, s, "run-2", "run-2#1", "tool.requested", "t3a", json!({ "call": "call_0", "tool": "read" }));
        ev(&d, s, "run-2", "", "run.ended", "r2e", json!({ "stoppedBy": "done" }));
        ev(&d, s, "run-1", "", "run.ended", "r1e", json!({ "stoppedBy": "done" }));
        // And a background job the session started, under its run.
        let mut job = crate::job_record::JobRecord::started("job-1", s, "Start-Sleep 60", Default::default());
        job.run = "run-1".to_string();
        job.invocation = "run-1#1".to_string();
        job.state = crate::job_record::JobState::Interrupted;
        crate::job_record::save(&d, &job).expect("job saved");

        let tree = of_session(&d, s).expect("a tree");
        assert_eq!(tree.len(), 1, "the child run is not a root: {tree:?}");
        let root = &tree[0];
        assert_eq!(root.id, "run-1");
        assert_eq!(root.state, "done");
        assert_eq!(root.depth(), 3, "run -> child run -> its tool");
        // Two tools, one job, one child run.
        let kinds: Vec<NodeKind> = root.children.iter().map(|c| c.kind).collect();
        assert_eq!(
            kinds,
            vec![NodeKind::Tool, NodeKind::Tool, NodeKind::Job, NodeKind::Run],
            "{root:?}"
        );
        // A call's phases are one node, whose state is the last phase.
        let bash = root.children.iter().find(|c| c.label == "bash").unwrap();
        assert_eq!(bash.state, "failed");
        assert_eq!(bash.invocation, "run-1#1");
        let job = root.children.iter().find(|c| c.kind == NodeKind::Job).unwrap();
        assert_eq!(job.state, "interrupted");
        assert_eq!(root.count(), 6, "{root:?}");

        let text = render(&tree);
        assert!(text.contains("run m (agent-loop) [done]"), "{text}");
        assert!(text.contains("  tool ls [succeeded]"), "{text}");
        assert!(text.contains("    tool read [requested]"), "{text}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A session that named nothing, and one with no record, are refusals --
    /// not an empty tree that reads like a quiet run.
    #[test]
    fn a_session_with_no_record_is_a_typed_refusal() {
        let d = dir("empty");
        assert_eq!(
            of_session(&d, "  ").unwrap_err().kind(),
            ErrorKind::InvalidInput
        );
        assert_eq!(
            of_session(&d, "never-ran").unwrap_err().kind(),
            ErrorKind::NotFound
        );
        // And another session's record is not this session's tree.
        ev(&d, "theirs", "run-9", "", "run.started", "r9", json!({ "model": "m" }));
        assert_eq!(
            of_session(&d, "mine").unwrap_err().kind(),
            ErrorKind::NotFound
        );
        assert_eq!(of_session(&d, "theirs").unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A run that was stopped says so, and its unfinished calls stay at the
    /// phase they reached rather than being reported as finished.
    #[test]
    fn a_cancelled_run_is_shown_as_it_ended() {
        let d = dir("cancelled");
        let s = "stopped-session";
        ev(&d, s, "run-1", "", "run.started", "r1s", json!({ "model": "m" }));
        ev(&d, s, "run-1", "run-1#1", "tool.requested", "t1", json!({ "call": "c", "tool": "bash" }));
        ev(&d, s, "run-1", "run-1#1", "tool.cancelled", "t2", json!({ "call": "c", "tool": "bash" }));
        ev(&d, s, "run-1", "", "run.ended", "r1e", json!({ "stoppedBy": "cancelled" }));
        let tree = of_session(&d, s).unwrap();
        assert_eq!(tree[0].state, "cancelled");
        assert_eq!(tree[0].children[0].state, "cancelled");
        assert!(render(&tree).contains("[cancelled]"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
