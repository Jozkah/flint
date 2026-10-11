//! The agent's review and control plane, for a client that has no agent of its
//! own (the Android build, a browser) and is signed in to `flint serve`.
//!
//! Off unless the server was started with `--agent-root <folder>`. What it
//! answers is deliberately small and runs no command on the host:
//!
//! - campaigns: list, read, context, event log, cancel, pause and resume;
//! - proposals: list, apply, reject (the same stored, hash-approved path the
//!   desktop uses);
//! - `agent_server_info` and `agent_server_folders`, so a client can tell
//!   whether any of this is on and browse the folders it may use.
//!
//! Not here, on purpose: running a Cowork turn or a campaign task. Those need
//! the tool executor, which sits behind the agent plugin's `tauri` feature and
//! is absent from this headless build by design, and the loop itself is driven
//! by a renderer. Also not here: anything that spawns a process (verification
//! checks, the final build and test gate), merging, and discarding worktrees.
//!
//! Every path a request names must resolve inside one of the roots the
//! operator listed. The data folder is never a root, and a root may not
//! contain it.

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::core::agent::campaign;
use tauri_plugin_agent_tools::proposal;

/// A refusal: an HTTP status and a body (a string, or the object the page's
/// error handling reads).
#[derive(Debug)]
pub struct Fail {
    pub status: u16,
    pub body: Value,
}

fn fail(status: u16, message: impl Into<String>) -> Fail {
    Fail {
        status,
        body: Value::String(message.into()),
    }
}

/// The shape the desktop commands reject with: a message and the conflicts.
fn failure(message: impl Into<String>) -> Fail {
    Fail {
        status: 422,
        body: json!({ "message": message.into(), "conflicts": [] }),
    }
}

fn proposal_failure(error: proposal::ProposalError) -> Fail {
    let conflicts = match &error {
        proposal::ProposalError::Conflicts(list) => {
            serde_json::to_value(list).unwrap_or_else(|_| json!([]))
        }
        _ => json!([]),
    };
    let unacknowledged = match &error {
        proposal::ProposalError::Unacknowledged(paths) => paths.clone(),
        _ => Vec::new(),
    };
    Fail {
        status: 422,
        body: json!({
            "message": error.message(),
            "conflicts": conflicts,
            "unacknowledged": unacknowledged,
        }),
    }
}

/// The commands this module answers. Everything else is the caller's to refuse.
pub fn handles(command: &str) -> bool {
    matches!(
        command,
        "agent_server_info"
            | "agent_server_folders"
            | "agent_campaign_list"
            | "agent_campaign_get"
            | "agent_campaign_context"
            | "agent_campaign_events"
            | "agent_campaign_transition"
            | "agent_campaign_cancel"
            | "agent_proposal_list"
            | "agent_proposal_apply"
            | "agent_proposal_reject"
    )
}

#[derive(Clone)]
pub struct Agent {
    data_folder: PathBuf,
    roots: Vec<PathBuf>,
}

/// A folder worth listing: skips what a person would not pick a project from.
fn listable(name: &str) -> bool {
    !name.starts_with('.') && name != "node_modules" && name != "target"
}

impl Agent {
    /// `None` when no root was given (the feature is off). Roots are made
    /// canonical here, once; a root that is missing, is not a folder, is the
    /// filesystem root, or overlaps the data folder is an error the operator
    /// sees at start-up rather than a silently narrower server.
    pub fn open(data_folder: &Path, roots: &[PathBuf]) -> Result<Option<Agent>, String> {
        if roots.is_empty() {
            return Ok(None);
        }
        let data = data_folder
            .canonicalize()
            .map_err(|e| format!("data folder {} is unreadable: {e}", data_folder.display()))?;
        let mut canonical = Vec::new();
        for root in roots {
            let path = root
                .canonicalize()
                .map_err(|e| format!("--agent-root {} is unreadable: {e}", root.display()))?;
            if !path.is_dir() {
                return Err(format!("--agent-root {} is not a folder", path.display()));
            }
            if path.parent().is_none() {
                return Err("--agent-root cannot be the filesystem root".into());
            }
            if data.starts_with(&path) || path.starts_with(&data) {
                return Err(format!(
                    "--agent-root {} overlaps the data folder, which holds the server's credentials",
                    path.display()
                ));
            }
            if !canonical.contains(&path) {
                canonical.push(path);
            }
        }
        Ok(Some(Agent {
            data_folder: data_folder.to_path_buf(),
            roots: canonical,
        }))
    }

    /// The canonical form of `raw` when it names an existing path inside a root.
    fn confine(&self, raw: &str) -> Result<PathBuf, Fail> {
        if raw.is_empty() || raw.contains('\0') {
            return Err(fail(400, "invalid path"));
        }
        let path = Path::new(raw)
            .canonicalize()
            .map_err(|_| fail(404, "that folder does not exist on this server"))?;
        if self.roots.iter().any(|root| path.starts_with(root)) {
            Ok(path)
        } else {
            Err(fail(403, "that folder is outside the folders this server allows"))
        }
    }

    pub fn call(&self, command: &str, args: &Value) -> Result<Value, Fail> {
        match command {
            "agent_server_info" => Ok(json!({
                "agent": true,
                "folders": self.roots.iter().map(|r| r.to_string_lossy()).collect::<Vec<_>>(),
                // What this server will not do, so a client can say so rather
                // than offer a button that fails.
                "runsSessions": false,
                "runsChecks": false,
            })),
            "agent_server_folders" => self.folders(args),
            "agent_campaign_list" => to_json(campaign::list(&self.data_folder)),
            "agent_campaign_get" => {
                let id = text(args, "id")?;
                to_json(campaign::get(&self.data_folder, id).map_err(|e| failure(e.message))?)
            }
            "agent_campaign_context" => {
                let id = text(args, "id")?;
                let tasks: Vec<String> = field(args, "taskIds")?;
                to_json(
                    campaign::context(&self.data_folder, id, &tasks)
                        .map_err(|e| failure(e.message))?,
                )
            }
            "agent_campaign_events" => {
                let id = text(args, "id")?;
                to_json(campaign::events(&self.data_folder, id).map_err(|e| failure(e.message))?)
            }
            "agent_campaign_transition" => {
                let id = text(args, "id")?;
                let input: campaign::TransitionInput = field(args, "input")?;
                // Pause, resume and cancel only. A task move would skip the
                // verification step, a plan approval would start work, and an
                // integration record names a branch and worktree on this
                // machine; none of those are a remote client's to set.
                if input.task.is_some() || input.integration.is_some() {
                    return Err(fail(403, "this server only pauses, resumes and cancels a campaign"));
                }
                match input.campaign {
                    Some(campaign::CampaignStatus::Paused | campaign::CampaignStatus::Cancelled) => {}
                    Some(campaign::CampaignStatus::Running) => {
                        let current = campaign::get(&self.data_folder, id)
                            .map_err(|e| failure(e.message))?;
                        if current.status != campaign::CampaignStatus::Paused {
                            return Err(fail(403, "only a paused campaign can be resumed from here"));
                        }
                    }
                    _ => {
                        return Err(fail(403, "this server only pauses, resumes and cancels a campaign"));
                    }
                }
                to_json(
                    campaign::transition(&self.data_folder, id, input)
                        .map_err(|e| failure(e.message))?,
                )
            }
            "agent_campaign_cancel" => {
                let id = text(args, "id")?;
                let detail = args.get("detail").and_then(Value::as_str).unwrap_or_default();
                to_json(
                    campaign::cancel(&self.data_folder, id, detail)
                        .map_err(|e| failure(e.message))?,
                )
            }
            "agent_proposal_list" => {
                let project = self.confine(text(args, "project")?)?;
                to_json(proposal::list(&self.data_folder, &project.to_string_lossy()))
            }
            "agent_proposal_apply" => {
                let approval: proposal::Approval = field(args, "approval")?;
                let stored = proposal::load(&self.data_folder, &approval.proposal_id)
                    .map_err(proposal_failure)?;
                // The destination is the stored proposal's project, never a
                // path from the request; it must still be a folder this
                // server allows.
                let destination = self.confine(&stored.scope.project)?;
                let report = proposal::apply(&self.data_folder, &destination, &approval)
                    .map_err(proposal_failure)?;
                to_json(report)
            }
            "agent_proposal_reject" => {
                let id = text(args, "id")?;
                let scope: proposal::ProposalScope = field(args, "scope")?;
                let stored = proposal::load(&self.data_folder, id).map_err(proposal_failure)?;
                self.confine(&stored.scope.project)?;
                to_json(
                    proposal::reject(&self.data_folder, id, &scope).map_err(proposal_failure)?,
                )
            }
            _ => Err(fail(404, "Unknown agent command")),
        }
    }

    fn folders(&self, args: &Value) -> Result<Value, Fail> {
        let wanted = args.get("path").and_then(Value::as_str).filter(|p| !p.is_empty());
        let Some(wanted) = wanted else {
            let entries: Vec<Value> = self.roots.iter().map(entry).collect();
            return Ok(json!({ "path": null, "parent": null, "entries": entries }));
        };
        let dir = self.confine(wanted)?;
        if !dir.is_dir() {
            return Err(fail(400, "that is not a folder"));
        }
        let parent = dir
            .parent()
            .filter(|p| self.roots.iter().any(|r| p.starts_with(r)))
            .map(|p| p.to_string_lossy().into_owned());
        let mut entries: Vec<Value> = std::fs::read_dir(&dir)
            .map_err(|_| fail(403, "that folder cannot be read"))?
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter(|e| e.file_name().to_str().is_some_and(listable))
            // A link is listed only when it stays inside the roots.
            .filter_map(|e| e.path().canonicalize().ok())
            .filter(|p| self.roots.iter().any(|r| p.starts_with(r)))
            .map(|p| entry(&p))
            .collect();
        entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        entries.truncate(500);
        Ok(json!({
            "path": dir.to_string_lossy(),
            "parent": parent,
            "entries": entries,
        }))
    }
}

fn entry(path: &PathBuf) -> Value {
    json!({
        "name": path.file_name().map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
        "path": path.to_string_lossy(),
        "git": path.join(".git").exists(),
    })
}

fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str, Fail> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| fail(400, format!("{key} is required")))
}

fn field<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, Fail> {
    let value = args
        .get(key)
        .cloned()
        .ok_or_else(|| fail(400, format!("{key} is required")))?;
    serde_json::from_value(value).map_err(|e| fail(400, format!("{key} is not valid: {e}")))
}

fn to_json<T: serde::Serialize>(value: T) -> Result<Value, Fail> {
    serde_json::to_value(value).map_err(|_| fail(500, "could not encode the answer"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (tempfile::TempDir, tempfile::TempDir) {
        (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap())
    }

    #[test]
    fn off_without_a_root() {
        let (data, _) = pair();
        assert!(Agent::open(data.path(), &[]).unwrap().is_none());
    }

    #[test]
    fn a_root_may_not_overlap_the_data_folder() {
        let (data, _) = pair();
        let inside = data.path().join("projects");
        std::fs::create_dir_all(&inside).unwrap();
        assert!(Agent::open(data.path(), &[inside]).is_err());
        let parent = data.path().parent().unwrap().to_path_buf();
        assert!(Agent::open(data.path(), &[parent]).is_err());
    }

    #[test]
    fn a_missing_root_is_an_error_not_a_narrower_server() {
        let (data, work) = pair();
        let gone = work.path().join("nope");
        assert!(Agent::open(data.path(), &[gone]).is_err());
    }

    #[test]
    fn paths_stay_inside_the_roots() {
        let (data, work) = pair();
        let project = work.path().join("app");
        std::fs::create_dir_all(&project).unwrap();
        let agent = Agent::open(data.path(), &[work.path().to_path_buf()])
            .unwrap()
            .unwrap();
        assert!(agent.confine(&project.to_string_lossy()).is_ok());
        let outside = agent.confine(&data.path().to_string_lossy()).unwrap_err();
        assert_eq!(outside.status, 403);
        let climbing = work.path().join("app").join("..").join("..");
        assert!(agent.confine(&climbing.to_string_lossy()).is_err());
        assert_eq!(agent.confine("").unwrap_err().status, 400);
    }

    #[test]
    fn folders_lists_roots_then_children_and_hides_the_rest() {
        let (data, work) = pair();
        std::fs::create_dir_all(work.path().join("app/.git")).unwrap();
        std::fs::create_dir_all(work.path().join("node_modules")).unwrap();
        std::fs::create_dir_all(work.path().join(".hidden")).unwrap();
        let agent = Agent::open(data.path(), &[work.path().to_path_buf()])
            .unwrap()
            .unwrap();
        let roots = agent.call("agent_server_folders", &json!({})).unwrap();
        assert_eq!(roots["entries"].as_array().unwrap().len(), 1);
        let root = roots["entries"][0]["path"].as_str().unwrap().to_owned();
        let listed = agent
            .call("agent_server_folders", &json!({ "path": root }))
            .unwrap();
        let names: Vec<&str> = listed["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["app"]);
        assert_eq!(listed["entries"][0]["git"], true);
    }

    #[test]
    fn only_the_listed_commands_are_handled() {
        assert!(handles("agent_campaign_list"));
        assert!(handles("agent_proposal_apply"));
        // The runners, the tool executor and anything that spawns stay out.
        for refused in [
            "agent_campaign_finalize",
            "agent_campaign_verify_prepare",
            "agent_campaign_merge_task",
            "agent_campaign_create",
            "agent_worktree_discard",
            "agent_worktree_merge",
            "plugin:agent-tools|execute_tool",
            "plugin:agent-tools|direct_edit_authorize",
        ] {
            assert!(!handles(refused), "{refused}");
        }
    }

    #[test]
    fn a_proposal_for_an_outside_project_is_not_listed() {
        let (data, work) = pair();
        let agent = Agent::open(data.path(), &[work.path().to_path_buf()])
            .unwrap()
            .unwrap();
        let answer = agent
            .call("agent_proposal_list", &json!({ "project": data.path().to_string_lossy() }))
            .unwrap_err();
        assert_eq!(answer.status, 403);
    }

    #[test]
    fn a_client_can_only_pause_resume_or_cancel() {
        let (data, work) = pair();
        let agent = Agent::open(data.path(), &[work.path().to_path_buf()])
            .unwrap()
            .unwrap();
        for input in [
            json!({ "campaign": "paused", "integration": { "branch": "flint/x", "worktree": "C:/elsewhere" } }),
            json!({ "task": { "taskId": "t1", "to": "verified" } }),
            json!({ "campaign": "approved" }),
        ] {
            let outcome =
                agent.call("agent_campaign_transition", &json!({ "id": "c1", "input": input }));
            // Refused by shape or by policy; it never reaches the store.
            assert!(outcome.is_err(), "{input}");
        }
    }
}
