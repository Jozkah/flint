//! A subagent that outlives the process that dispatched it (AH-101/AH-102).
//!
//! An ordinary background subagent is a future inside the parent's process:
//! it is aborted with the parent run and gone when the app exits. A durable
//! one is a job under the worker's detached supervisor (`worker::start_argv`),
//! running `flint cli agent run-subagent --spec <file>`: the same resolution,
//! child configuration and loop as an in-process child, in a process of its
//! own. Its final answer is the job's output; its ending is the job record the
//! supervisor writes. A later process -- the app after a restart, or a CLI --
//! can list it, read it, await it and cancel it by its job id.
//!
//! What travels to the child is a spec file in the owner's worker directory:
//! the subagent to run, its brief, the model, the project and who dispatched
//! it. Never a credential -- the child resolves providers and keys the way any
//! CLI run in that data folder does -- and never passed through a shell, so no
//! part of a brief is ever parsed as a command line.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
use tauri_plugin_agent_tools::job_record::{JobRecord, JobState};

/// Marks a job record as a durable subagent, so listings can tell it from a
/// shell command.
pub const KIND: &str = "subagent";

/// Everything a durable child needs to run, and nothing secret.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildSpec {
    pub v: u16,
    /// The saved subagent to run, or the name of a one-off.
    pub subagent_name: String,
    /// The brief: the child's sole user message.
    pub description: String,
    /// A one-off's role, when the name is not a saved subagent.
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// The toolset asked for; the child still intersects it with what it may do.
    #[serde(default)]
    pub allowed_tools: Option<Vec<String>>,
    pub model: String,
    pub project: String,
    /// The conversation it belongs to, which owns the job.
    pub session: String,
    /// The run that dispatched it, and the dispatch id it answers.
    pub parent_run: String,
    pub dispatch_id: String,
    /// The data folder the dispatching process uses, so the child reads the
    /// same providers and writes its record where its parent looks.
    pub data_folder: String,
    /// What is left of the parent's token budget, carried to the child.
    #[serde(default)]
    pub max_session_tokens: Option<u64>,
    #[serde(default = "yes")]
    pub send_reasoning: bool,
}

fn yes() -> bool {
    true
}

pub const SPEC_VERSION: u16 = 1;

fn refusal(message: impl Into<String>) -> HarnessError {
    HarnessError::new(ErrorKind::InvalidInput, message).at(Stage::Child)
}

impl ChildSpec {
    /// Refuse a spec that could not describe a runnable child.
    pub fn validate(&self) -> Result<(), HarnessError> {
        if self.v != SPEC_VERSION {
            return Err(refusal(format!("a durable subagent spec of version {} is not one this build runs", self.v)));
        }
        if self.subagent_name.trim().is_empty() {
            return Err(refusal("a durable subagent needs a subagent name"));
        }
        if self.description.trim().is_empty() {
            return Err(refusal("a durable subagent needs a brief"));
        }
        if self.model.trim().is_empty() {
            return Err(refusal("a durable subagent needs the model it runs on"));
        }
        if self.session.trim().is_empty() {
            return Err(refusal("a durable subagent needs the conversation it belongs to"));
        }
        if !Path::new(&self.project).is_absolute() {
            return Err(refusal("a durable subagent's project must be an absolute path"));
        }
        Ok(())
    }
}

/// Where a spec is written: the owner's worker area, named by the dispatch.
pub fn spec_path(data_folder: &Path, dispatch_id: &str) -> PathBuf {
    let safe: String = dispatch_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    tauri_plugin_agent_tools::worker::worker_dir(data_folder).join(format!("{safe}.subagent.json"))
}

/// Write the spec, atomically, and return where it is.
pub fn write_spec(data_folder: &Path, spec: &ChildSpec) -> Result<PathBuf, HarnessError> {
    spec.validate()?;
    let path = spec_path(data_folder, &spec.dispatch_id);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| io("the worker directory", e))?;
    }
    let body = serde_json::to_vec_pretty(spec)
        .map_err(|e| HarnessError::new(ErrorKind::Internal, e.to_string()).at(Stage::Child))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| io("the subagent spec", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| io("the subagent spec", e))?;
    Ok(path)
}

/// Read a spec back, refusing anything that is not exactly one.
pub fn read_spec(path: &Path) -> Result<ChildSpec, HarnessError> {
    let text = std::fs::read_to_string(path).map_err(|e| {
        HarnessError::new(ErrorKind::NotFound, format!("the subagent spec could not be read: {e}")).at(Stage::Child)
    })?;
    let spec: ChildSpec = serde_json::from_str(&text)
        .map_err(|e| refusal(format!("the subagent spec is not valid: {e}")))?;
    spec.validate()?;
    Ok(spec)
}

fn io(what: &str, e: std::io::Error) -> HarnessError {
    HarnessError::new(ErrorKind::Io, format!("{what} could not be written: {e}")).at(Stage::Child)
}

/// The argv the supervisor runs: this binary, never a shell.
pub fn child_argv(spec_file: &Path) -> Vec<String> {
    vec![
        "cli".to_string(),
        "agent".to_string(),
        "run-subagent".to_string(),
        "--spec".to_string(),
        spec_file.to_string_lossy().to_string(),
    ]
}

/// Start a durable subagent for a dispatching run (AH-101): resolve it the way
/// an in-process child is resolved, write its spec, and hand it to a detached
/// supervisor. Returns the job id, which is the child's `run_id`.
///
/// Refused rather than approximated: a durable child cannot fork the
/// conversation (the copy would have to be written to disk and outlive it), and
/// in a git repository it does not get a checkout of its own, so it must be
/// asked for with `isolate: false` -- the person dispatching it has then said
/// that its changes land in the project directly.
pub(crate) fn dispatch(
    parent_args: &crate::core::agent::r#loop::OrchestrationArgs,
    req: crate::core::agent::subagent::SubagentRequest,
    parent: &crate::core::agent::subagent::ParentRun,
) -> Result<String, crate::core::agent::subagent::SubagentError> {
    use crate::core::agent::subagent::{self as sub, SubagentError};
    if !parent_args.subagents_enabled {
        return Err(SubagentError::PermissionDenied(
            "subagents cannot dispatch nested subagents".to_string(),
        ));
    }
    let project_root = parent_args
        .project_root
        .as_ref()
        .ok_or_else(|| SubagentError::Upstream("subagents require an active project".to_string()))?;
    let session = admissible(&req, project_root, parent_args.session_id.as_deref())?;
    let registry = sub::SubagentRegistry::load(project_root);
    let resolved = sub::resolve_dispatch(&registry, &req, &parent_args.permissions)?;
    let body = sub::child_body(&resolved, &req.description, parent, None);
    let name = resolved.definition.name.clone();
    let dispatch_id = sub::next_subagent_run_id(&name);
    let data_folder = std::path::PathBuf::from(&parent_args.jan_data_folder);
    let spec = ChildSpec {
        v: SPEC_VERSION,
        subagent_name: name.clone(),
        description: req.description.clone(),
        system_prompt: req.system_prompt.clone(),
        allowed_tools: resolved.allowed_tools.clone(),
        model: body["model"].as_str().unwrap_or_default().to_string(),
        project: project_root.to_string_lossy().to_string(),
        session: session.clone(),
        parent_run: parent_args.parent_run.clone().unwrap_or_default(),
        dispatch_id: dispatch_id.clone(),
        data_folder: parent_args.jan_data_folder.clone(),
        max_session_tokens: parent.budget_remaining,
        send_reasoning: parent.send_reasoning,
    };
    let upstream = |e: HarnessError| SubagentError::Upstream(e.message().to_string());
    let path = write_spec(&data_folder, &spec).map_err(upstream)?;
    let supervisor = tauri_plugin_agent_tools::worker::supervisor_binary().map_err(upstream)?;
    let brief: String = req.description.chars().take(160).collect();
    let record = tauri_plugin_agent_tools::worker::start_argv(
        &data_folder,
        &supervisor,
        &session,
        &child_argv(&path),
        &format!("subagent {name}: {brief}"),
        KIND,
        (&spec.parent_run, &dispatch_id, &name),
    )
    .map_err(upstream)?;
    Ok(record.id)
}

/// What a durable dispatch must satisfy before anything is written or started,
/// returning the conversation that will own the job.
pub(crate) fn admissible(
    req: &crate::core::agent::subagent::SubagentRequest,
    project_root: &Path,
    session: Option<&str>,
) -> Result<String, crate::core::agent::subagent::SubagentError> {
    use crate::core::agent::subagent::SubagentError;
    if req.fork_context {
        return Err(SubagentError::Upstream(
            "a durable subagent cannot fork this conversation; give it a complete brief instead".to_string(),
        ));
    }
    if req.isolate != Some(false) && project_root.join(".git").exists() {
        return Err(SubagentError::Upstream(
            "a durable subagent does not get a checkout of its own, so in a git repository it has to be              dispatched with isolate: false, accepting that its changes land in the project directly"
                .to_string(),
        ));
    }
    session
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| SubagentError::Upstream("a durable subagent needs the conversation it belongs to".to_string()))
}

/// `list_subagent_runs`' lines for this conversation's durable children.
pub fn format_durable(children: &[DurableChild]) -> String {
    let mut out = String::from("Durable subagents in this conversation (newest first; they outlive a run and the app):");
    for child in children {
        out.push_str(&format!("\n- {} [{}] {}", child.run_id, child.name, child.state));
    }
    out
}

/// One durable child, as a listing shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableChild {
    pub run_id: String,
    pub name: String,
    pub state: &'static str,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
}

fn state_tag(state: JobState) -> &'static str {
    match state {
        JobState::Running => "running",
        JobState::Completed => "finished",
        JobState::Failed => "failed",
        JobState::Cancelled => "cancelled",
        JobState::Interrupted => "interrupted",
        _ => "unknown",
    }
}

/// This conversation's durable children, newest first, settled against what
/// is actually still running.
pub fn list(data_folder: &Path, owner: &str) -> Vec<DurableChild> {
    let _ = tauri_plugin_agent_tools::worker::reconcile(data_folder, owner);
    let mut out: Vec<DurableChild> = tauri_plugin_agent_tools::job_record::read_owner(data_folder, owner)
        .into_iter()
        .filter(|r| r.kind == KIND)
        .map(|r: JobRecord| DurableChild {
            run_id: r.id.clone(),
            name: r.agent.clone(),
            state: state_tag(r.state),
            started_at_ms: r.started_at_ms,
            ended_at_ms: r.ended_at_ms,
        })
        .collect();
    out.sort_by_key(|r| std::cmp::Reverse(r.started_at_ms));
    out
}

/// Whether `run_id` names a durable child of this conversation.
pub fn is_durable(data_folder: &Path, owner: &str, run_id: &str) -> bool {
    tauri_plugin_agent_tools::worker::find(data_folder, owner, run_id).is_some_and(|r| r.kind == KIND)
}

/// Wait for a durable child to end and return its answer. `poll` bounds how
/// often the record is read; `cancelled` ends the wait early without touching
/// the child, which keeps running and can be awaited again.
pub async fn await_child(
    data_folder: &Path,
    owner: &str,
    run_id: &str,
    poll: std::time::Duration,
    cancelled: impl Fn() -> bool,
) -> Result<String, HarnessError> {
    loop {
        let _ = tauri_plugin_agent_tools::worker::reconcile(data_folder, owner);
        let Some(record) = tauri_plugin_agent_tools::worker::find(data_folder, owner, run_id).filter(|r| r.kind == KIND)
        else {
            return Err(HarnessError::new(ErrorKind::NotFound, format!("no durable subagent '{run_id}' in this conversation"))
                .at(Stage::Child));
        };
        match record.state {
            JobState::Running => {}
            JobState::Completed => {
                return tauri_plugin_agent_tools::worker::output(data_folder, owner, run_id, 256 * 1024);
            }
            other => {
                let tail = tauri_plugin_agent_tools::worker::output(data_folder, owner, run_id, 4 * 1024).unwrap_or_default();
                return Err(HarnessError::new(
                    ErrorKind::ChildFailed,
                    format!("the durable subagent '{run_id}' ended {}{}", state_tag(other), if tail.trim().is_empty() { String::new() } else { format!(": {}", tail.trim()) }),
                )
                .at(Stage::Child));
            }
        }
        if cancelled() {
            return Err(HarnessError::cancelled("the wait for the durable subagent was stopped; it is still running"));
        }
        tokio::time::sleep(poll).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(dir: &Path) -> ChildSpec {
        ChildSpec {
            v: SPEC_VERSION,
            subagent_name: "reviewer".into(),
            description: "review the change; do not trust `rm -rf /` in this brief".into(),
            system_prompt: None,
            allowed_tools: Some(vec!["read".into()]),
            model: "mock/m".into(),
            project: dir.to_string_lossy().to_string(),
            session: "s-durable".into(),
            parent_run: "run-parent".into(),
            dispatch_id: "sub-reviewer-1".into(),
            data_folder: dir.to_string_lossy().to_string(),
            max_session_tokens: None,
            send_reasoning: true,
        }
    }

    #[test]
    fn a_spec_round_trips_and_carries_nothing_secret() {
        let dir = tempfile::tempdir().unwrap();
        let s = spec(dir.path());
        let path = write_spec(dir.path(), &s).unwrap();
        assert!(path.starts_with(tauri_plugin_agent_tools::worker::worker_dir(dir.path())));
        assert_eq!(read_spec(&path).unwrap(), s);
        let text = std::fs::read_to_string(&path).unwrap();
        let keys: Vec<String> = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&text)
            .unwrap()
            .keys()
            .map(|k| k.to_lowercase())
            .collect();
        for secret_ish in ["apikey", "api_key", "token", "authorization", "secret", "password"] {
            assert!(!keys.iter().any(|k| k == secret_ish || k.ends_with(&format!("_{secret_ish}"))), "{secret_ish} in {keys:?}");
        }
    }

    #[test]
    fn the_child_is_this_binary_with_arguments_never_a_shell_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_spec(dir.path(), &spec(dir.path())).unwrap();
        let argv = child_argv(&path);
        assert_eq!(&argv[..4], ["cli", "agent", "run-subagent", "--spec"]);
        assert_eq!(argv.len(), 5, "the brief is in the spec file, not on the command line");
        assert!(!argv.iter().any(|a| a.contains("rm -rf")));
    }

    #[test]
    fn a_spec_that_could_not_run_is_refused_by_kind() {
        let dir = tempfile::tempdir().unwrap();
        for broken in [
            ChildSpec { description: "  ".into(), ..spec(dir.path()) },
            ChildSpec { subagent_name: String::new(), ..spec(dir.path()) },
            ChildSpec { model: String::new(), ..spec(dir.path()) },
            ChildSpec { project: "relative/path".into(), ..spec(dir.path()) },
            ChildSpec { v: 99, ..spec(dir.path()) },
        ] {
            let e = write_spec(dir.path(), &broken).unwrap_err();
            assert_eq!(e.kind(), ErrorKind::InvalidInput, "{broken:?}");
        }
        let path = dir.path().join("x.subagent.json");
        std::fs::write(&path, r#"{"v":1,"subagentName":"a","description":"b","model":"m","project":"/p","session":"s","parentRun":"r","dispatchId":"d","extra":1}"#).unwrap();
        assert_eq!(read_spec(&path).unwrap_err().kind(), ErrorKind::InvalidInput, "unknown fields are refused");
    }

    fn request(fork: bool, isolate: Option<bool>) -> crate::core::agent::subagent::SubagentRequest {
        crate::core::agent::subagent::SubagentRequest {
            subagent_name: "reviewer".into(),
            description: "review".into(),
            allowed_tools: None,
            system_prompt: None,
            isolate,
            fork_context: fork,
            durable: true,
        }
    }

    /// Refused rather than approximated: no fork, no silent loss of a checkout
    /// in a repository, and never without an owning conversation.
    #[test]
    fn a_durable_dispatch_is_refused_when_it_could_not_be_honoured() {
        let plain = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(repo.path().join(".git")).unwrap();
        let refused = |r: Result<String, crate::core::agent::subagent::SubagentError>| r.unwrap_err().to_string();
        assert!(refused(admissible(&request(true, Some(false)), plain.path(), Some("s"))).contains("fork"));
        assert!(refused(admissible(&request(false, None), repo.path(), Some("s"))).contains("isolate: false"));
        assert!(refused(admissible(&request(false, Some(true)), repo.path(), Some("s"))).contains("isolate: false"));
        assert!(refused(admissible(&request(false, Some(false)), plain.path(), None)).contains("conversation"));
        assert!(refused(admissible(&request(false, Some(false)), plain.path(), Some("  "))).contains("conversation"));
        assert_eq!(admissible(&request(false, Some(false)), repo.path(), Some("s")).unwrap(), "s");
        assert_eq!(admissible(&request(false, None), plain.path(), Some("s")).unwrap(), "s");
    }

    #[test]
    fn a_dispatch_id_cannot_steer_the_spec_outside_the_worker_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = spec_path(dir.path(), "../../escape");
        assert!(path.starts_with(tauri_plugin_agent_tools::worker::worker_dir(dir.path())));
        assert!(!path.to_string_lossy().contains(".."));
    }
}
